"use client";
// スピードの 3D シーン。カード系の型（hearts）の応用:
// 中央に台札2山（表向き）、手前に自分の場札の扇、奥に相手の場札を置く。
// 相手の場札は view の契約どおり公開情報（2D でも表向き表示）なので
// 表向きで描く。秘匿は山札だけで、そちらは枚数しか受け取らず中身は参照しない。
// 自分の山札・相手の山札は裏向きの積み重ねで表す。
// 入力は既存の DOM 操作と同じ意味だけを持つ:
//   場札タップ = 既存の場札ハンドラ（出せる山が1つなら即出し、2つなら選択）
//   台札タップ = 選択中の場札をその山へ出す（選択・合法判定は親が持つ）
// 選択中 = 金縁フレーム＋持ち上げ、出せる札 = 緑の縁、
// 出せない札 = 減光（opacity 0.5）で 2D の枠色・減光と揃える。
// 同時進行で操作が速いため、アニメーションは 200〜260ms と短めにし、
// 操作の妨げにならないようにする。残り枚数などの数字は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createCard } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

export interface SpeedSceneCenter {
  top: number | null;
  count: number;
}

export interface SpeedSceneLastPlay {
  isMine: boolean;
  center: number;
  card: number;
}

interface Props {
  myHand: number[];
  /** 場札 index ごとに出せる中央の山（親の yourPlays 由来）。 */
  handLegal: number[][];
  selected: number | null;
  centers: SpeedSceneCenter[];
  /** 相手の場札は公開情報（view で全員に見えている）。山札は枚数のみ。 */
  opponentField: number[];
  opponentStockCount: number;
  myStockCount: number;
  lastPlay: SpeedSceneLastPlay | null;
  finished: boolean;
  /** 場札タップ = 既存の場札ハンドラへ。 */
  onHandTap: (handIndex: number) => void;
  /** 台札タップ = 選択中の場札をその山へ出す（可否判定は親）。 */
  onCenterTap: (center: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const CARD_W = 0.78;
const CARD_H = 1.08;
const FACE_UP = -Math.PI / 2;
const FACE_DOWN = Math.PI / 2;
const MY_STOCK_POS = new THREE.Vector3(3.25, 0.05, 1.35);
const OPP_STOCK_POS = new THREE.Vector3(-3.25, 0.05, -1.55);
const OPP_FIELD_CENTER = new THREE.Vector3(0, 0.05, -1.55);
const MY_HAND_CENTER = new THREE.Vector3(0, 0.05, 1.5);

const SUIT_GLYPH = ["♠", "♥", "♦", "♣"] as const;

function rankLabel(id: number): string {
  const rank = (id % 13) + 1;
  if (rank === 1) return "A";
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  return String(rank);
}

function isRed(id: number): boolean {
  const suit = Math.floor(id / 13);
  return suit === 1 || suit === 2;
}

function makeCardMesh(id: number | null, pickId?: string): THREE.Mesh {
  const mesh = id === null
    ? createCard(CARD_W, CARD_H, {})
    : createCard(CARD_W, CARD_H, {
        label: `${rankLabel(id)}${SUIT_GLYPH[Math.floor(id / 13)]}`,
        labelColor: isRed(id) ? "#c62828" : "#1c2333",
      });
  if (pickId !== undefined) mesh.userData.pickId = pickId;
  return mesh;
}

function makeFrameMesh(color: number): THREE.Mesh {
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(CARD_W + 0.12, CARD_H + 0.12, 0.018),
    new THREE.MeshStandardMaterial({ color, roughness: 0.45 }),
  );
  frame.rotation.x = FACE_UP;
  frame.position.y = -0.014;
  return frame;
}

function setCardDim(mesh: THREE.Mesh, dim: boolean) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) {
    const std = m as THREE.MeshStandardMaterial;
    std.transparent = dim;
    std.opacity = dim ? 0.5 : 1;
  }
}

function centerPos(center: number): THREE.Vector3 {
  return new THREE.Vector3(center === 0 ? -0.95 : 0.95, 0.05, -0.15);
}

interface CardAnim {
  start: number;
  dur: number;
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  arc: number;
}

interface CardEntry {
  cardKey: string;
  group: THREE.Group;
  mesh: THREE.Mesh;
  frame: THREE.Mesh | null;
  anim: CardAnim | null;
}

interface SceneRt {
  cardsGroup: THREE.Group;
  entries: Map<string, CardEntry>;
}

export default function SpeedScene3D({
  myHand, handLegal, selected, centers, opponentField, opponentStockCount,
  myStockCount, lastPlay, finished, onHandTap, onCenterTap, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);

  const propsRef = useRef({
    myHand, handLegal, selected, centers, opponentField, opponentStockCount,
    myStockCount, lastPlay, finished, onHandTap, onCenterTap,
  });
  propsRef.current = {
    myHand, handLegal, selected, centers, opponentField, opponentStockCount,
    myStockCount, lastPlay, finished, onHandTap, onCenterTap,
  };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x14231c,
      camera: { position: [0, 5.8, 6.0], lookAt: [0, 0, 0], fov: 44 },
      onFrame: () => {
        const rt = rtRef.current;
        if (!rt) return;
        const now = performance.now();
        for (const e of rt.entries.values()) {
          if (!e.anim) continue;
          const a = e.anim;
          const k = Math.min(1, Math.max(0, (now - a.start) / a.dur));
          const ease = 1 - Math.pow(1 - k, 3);
          e.group.position.lerpVectors(a.fromPos, a.toPos, ease);
          e.group.position.y += Math.sin(k * Math.PI) * a.arc;
          if (k >= 1) e.anim = null;
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    const rim = new THREE.Mesh(
      new THREE.BoxGeometry(8.4, 0.14, 5.4),
      new THREE.MeshStandardMaterial({ color: 0x5b3a22, roughness: 0.6 }),
    );
    rim.position.y = -0.1;
    rim.userData.pickId = "table";
    scene.add(rim);
    const felt = new THREE.Mesh(
      new THREE.BoxGeometry(8.0, 0.16, 5.0),
      new THREE.MeshStandardMaterial({ color: 0x1e5c3a, roughness: 1 }),
    );
    felt.position.y = -0.04;
    felt.userData.pickId = "table";
    scene.add(felt);

    const cardsGroup = new THREE.Group();
    scene.add(cardsGroup);
    rtRef.current = { cardsGroup, entries: new Map() };

    detach = attachPickPointer(stage, () => [felt, rim, cardsGroup], {
      onTap: (hit) => {
        const pickId = hit?.object.userData.pickId as string | undefined;
        if (!pickId) return;
        if (pickId.startsWith("hand-")) {
          const index = Number(pickId.slice("hand-".length));
          if (Number.isInteger(index) && index >= 0) propsRef.current.onHandTap(index);
        } else if (pickId.startsWith("center-")) {
          const center = Number(pickId.slice("center-".length));
          if (Number.isInteger(center) && center >= 0) propsRef.current.onCenterTap(center);
        }
      },
    });
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 差分同期: 自分の場札・台札・相手の裏向き場札・両者の山札をスロット単位で
  // 管理する。台札の新規カードは出した側のエリアから、自分の場札の補充は
  // 自分の山札から短時間（200〜260ms）でフライインする。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const now = performance.now();
    const desired = new Map<string, {
      id: number | null;
      pos: THREE.Vector3;
      yaw: number;
      fromPos: THREE.Vector3;
      dealOrder: number;
      pickId?: string;
      frameColor?: number;
      dim: boolean;
      withFrame: boolean;
    }>();

    // 自分の場札（手前の扇）。選択中=金縁＋持ち上げ、出せる=緑縁、出せない=減光。
    myHand.forEach((id, i) => {
      const offset = i - (myHand.length - 1) / 2;
      const isSelected = selected === i;
      const playable = !finished && (handLegal[i]?.length ?? 0) > 0;
      desired.set(`h${i}`, {
        id,
        pos: new THREE.Vector3(
          MY_HAND_CENTER.x + offset * 0.82,
          isSelected ? 0.22 : 0.05,
          MY_HAND_CENTER.z + Math.abs(offset) * 0.04,
        ),
        yaw: offset * 0.06,
        fromPos: MY_STOCK_POS.clone(),
        dealOrder: i,
        pickId: `hand-${i}`,
        frameColor: isSelected ? 0xf2b33d : playable ? 0x46a758 : 0x2b3442,
        dim: !finished && !playable,
        withFrame: true,
      });
    });

    // 中央の台札2山（表向き）。選択中の場札が出せる山は金縁で示す。
    centers.forEach((pile, center) => {
      const canHere = selected !== null && (handLegal[selected]?.includes(center) ?? false);
      const justPlayed = lastPlay && lastPlay.center === center && lastPlay.card === pile.top;
      desired.set(`center-${center}`, {
        id: pile.top,
        pos: centerPos(center),
        yaw: center === 0 ? -0.06 : 0.06,
        fromPos: justPlayed
          ? (lastPlay.isMine ? MY_HAND_CENTER.clone() : OPP_FIELD_CENTER.clone())
          : new THREE.Vector3(centerPos(center).x, 0.35, centerPos(center).z),
        dealOrder: center,
        pickId: `center-${center}`,
        frameColor: canHere ? 0xf2b33d : 0x2b3442,
        dim: false,
        withFrame: true,
      });
    });

    // 相手の場札は公開情報なので表向き（2D と同一）。補充は相手の山札から飛ぶ。
    opponentField.forEach((id, i) => {
      const offset = i - (opponentField.length - 1) / 2;
      desired.set(`opp-${i}`, {
        id,
        pos: new THREE.Vector3(OPP_FIELD_CENTER.x + offset * 0.55, 0.05, OPP_FIELD_CENTER.z),
        yaw: offset * 0.05,
        fromPos: OPP_STOCK_POS.clone(),
        dealOrder: i,
        dim: false,
        withFrame: false,
      });
    });

    // 山札は裏向きの積み重ね（見た目の層は最大3枚分、枚数そのものは DOM 併記）。
    const myLayers = Math.min(3, myStockCount);
    for (let i = 0; i < myLayers; i++) {
      desired.set(`mystock-${i}`, {
        id: null,
        pos: new THREE.Vector3(MY_STOCK_POS.x, 0.05 + i * 0.035, MY_STOCK_POS.z),
        yaw: 0.12,
        fromPos: MY_STOCK_POS.clone(),
        dealOrder: 0,
        dim: false,
        withFrame: false,
      });
    }
    const oppLayers = Math.min(3, opponentStockCount);
    for (let i = 0; i < oppLayers; i++) {
      desired.set(`oppstock-${i}`, {
        id: null,
        pos: new THREE.Vector3(OPP_STOCK_POS.x, 0.05 + i * 0.035, OPP_STOCK_POS.z),
        yaw: -0.12,
        fromPos: OPP_STOCK_POS.clone(),
        dealOrder: 0,
        dim: false,
        withFrame: false,
      });
    }

    for (const [slot, e] of [...rt.entries]) {
      if (!desired.has(slot)) {
        rt.cardsGroup.remove(e.group);
        rt.entries.delete(slot);
      }
    }

    for (const [slot, d] of desired) {
      const cardKey = d.id === null ? "back" : `id-${d.id}`;
      // 台札は同じ一番上でも枚数が増えれば別カードとして飛ばす。
      const key = slot.startsWith("center-")
        ? `${cardKey}-n${centers[Number(slot.slice("center-".length))]?.count ?? 0}`
        : cardKey;
      const existing = rt.entries.get(slot);
      if (existing && existing.cardKey !== key) {
        rt.cardsGroup.remove(existing.group);
        rt.entries.delete(slot);
      }
      const entry = rt.entries.get(slot);
      if (!entry) {
        const group = new THREE.Group();
        group.position.copy(d.fromPos);
        const frame = d.withFrame ? makeFrameMesh(d.frameColor ?? 0x2b3442) : null;
        if (frame) group.add(frame);
        const mesh = makeCardMesh(d.id, d.pickId);
        mesh.rotation.x = d.id === null ? FACE_DOWN : FACE_UP;
        setCardDim(mesh, d.dim);
        group.add(mesh);
        group.rotation.y = d.yaw;
        rt.cardsGroup.add(group);
        const dist = group.position.distanceTo(d.pos);
        rt.entries.set(slot, {
          cardKey: key,
          group,
          mesh,
          frame,
          anim: {
            start: now + d.dealOrder * 30,
            dur: 260,
            fromPos: group.position.clone(),
            toPos: d.pos.clone(),
            arc: Math.min(0.4, dist * 0.3),
          },
        });
        continue;
      }
      if (entry.frame && d.frameColor !== undefined) {
        (entry.frame.material as THREE.MeshStandardMaterial).color.setHex(d.frameColor);
      }
      setCardDim(entry.mesh, d.dim);
      if (entry.group.position.distanceTo(d.pos) > 0.01 && !entry.anim) {
        entry.anim = {
          start: now,
          dur: 200,
          fromPos: entry.group.position.clone(),
          toPos: d.pos.clone(),
          arc: 0.04,
        };
      }
      entry.group.rotation.y = d.yaw;
    }
  }, [myHand, handLegal, selected, centers, opponentField, opponentStockCount, myStockCount, lastPlay, finished]);

  return (
    <SceneBox
      height={380}
      label={`スピード（3D）。中央の台札2山と、あなたの場札 ${myHand.length}枚。場札のタップで出す、両方の山に出せる札は選んでから台札をタップ`}
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#14231c"
    />
  );
}
