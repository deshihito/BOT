"use client";
// 大富豪（オンライン）の 3D シーン。カード系の型（hearts / texas）の応用:
// 自分の手札は手前に扇状、場札は中央、他プレイヤーは裏向きの枚数表現で
// 席に並べる。新規の場札は出した人の手札エリアから中央へフライインし、
// 場が流れたら場札スロットは除去される。
// 秘匿: 他プレイヤーについては view が見せる count（残り枚数）だけを受け取り、
// 手札の中身は view に含まれないため参照しない。他プレイヤーのカードは
// 必ず id: null（裏向き・ラベルなし）で生成する。場札・自分の手札は
// view で見えている範囲だけを描く。
// 手札カードのタップ = 既存の選択トグル（toggleCard）へ接続し、出札は
// 親 DOM の「出す」ボタンが担う（操作語彙は既存 UI のまま変えない）。
// 選択中のカードは金縁フレーム（0xf2b33d）＋持ち上げ、手番でないときは
// DOM の disabled と一致させて手札を減光する。
// 革命・8切り・縛り・残り枚数・順位などの状態表示は親 DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createCard } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

export interface DaifugoSceneOther {
  seat: number;
  count: number;
  finished: number | null;
}

interface Props {
  yourHand: number[];
  field: { cards: number[]; seat: number } | null;
  others: DaifugoSceneOther[];
  mySeat: number;
  totalPlayers: number;
  selected: number[];
  isMyTurn: boolean;
  turn: number;
  finished: boolean;
  /** 手札カードのタップ。既存の選択トグルへそのまま渡す（判定は親）。 */
  onCardTap: (cardId: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const CARD_W = 0.78;
const CARD_H = 1.08;
const FACE_UP = -Math.PI / 2;
const FACE_DOWN = Math.PI / 2;
const DECK_POS = new THREE.Vector3(2.65, 0.05, -1.5);

const SUIT_GLYPHS = ["♠", "♥", "♦", "♣"] as const;

function isRedCard(id: number): boolean {
  if (id === 52) return false;
  const suit = Math.floor(id / 13);
  return suit === 1 || suit === 2;
}

function rankLabel(id: number): string {
  const rank = (id % 13) + 3; // 3..15（15 が「2」）
  if (rank <= 10) return String(rank);
  return { 11: "J", 12: "Q", 13: "K", 14: "A", 15: "2" }[rank as 11 | 12 | 13 | 14 | 15];
}

function cardLabel(id: number): string {
  if (id === 52) return "JOKER";
  return `${rankLabel(id)}${SUIT_GLYPHS[Math.floor(id / 13)]}`;
}

function makeCardMesh(id: number | null, pickCardId?: number): THREE.Mesh {
  const mesh = id === null
    ? createCard(CARD_W, CARD_H, {})
    : createCard(CARD_W, CARD_H, {
        label: cardLabel(id),
        labelColor: isRedCard(id) ? "#c62828" : "#1c2333",
      });
  if (pickCardId !== undefined) mesh.userData.pickId = `card-${pickCardId}`;
  return mesh;
}

function makeFrameMesh(): THREE.Mesh {
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(CARD_W + 0.12, CARD_H + 0.12, 0.018),
    new THREE.MeshStandardMaterial({ color: 0x2b3442, roughness: 0.45 }),
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

/** 自分から見た相対席位置（0=手前自分、残りは時計回りに奥・左右）。 */
function seatPos(seat: number, mySeat: number, totalPlayers: number): THREE.Vector3 {
  const total = Math.max(2, totalPlayers);
  const rel = ((seat - mySeat) % total + total) % total;
  if (rel === 0) return new THREE.Vector3(0, 0.05, 1.5);
  if (total === 2) return new THREE.Vector3(0, 0.05, -1.72);
  if (total === 3) {
    return rel === 1
      ? new THREE.Vector3(-2.85, 0.05, -1.05)
      : new THREE.Vector3(2.85, 0.05, -1.05);
  }
  if (rel === 1) return new THREE.Vector3(-3.05, 0.05, -0.25);
  if (rel === 2) return new THREE.Vector3(0, 0.05, -1.72);
  return new THREE.Vector3(3.05, 0.05, -0.25);
}

function isSideSeat(pos: THREE.Vector3): boolean {
  return Math.abs(pos.x) > 2.9 && Math.abs(pos.z) < 0.6;
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
  turnRing: THREE.Mesh;
}

export default function DaifugoScene3D({
  yourHand, field, others, mySeat, totalPlayers, selected, isMyTurn, turn, finished,
  onCardTap, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);

  const propsRef = useRef({ yourHand, field, others, mySeat, totalPlayers, selected, isMyTurn, turn, finished, onCardTap });
  propsRef.current = { yourHand, field, others, mySeat, totalPlayers, selected, isMyTurn, turn, finished, onCardTap };
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

    const deckGroup = new THREE.Group();
    for (let i = 0; i < 5; i++) {
      const m = makeCardMesh(null);
      m.rotation.x = FACE_DOWN;
      m.position.set(0, i * 0.014, 0);
      deckGroup.add(m);
    }
    deckGroup.position.copy(DECK_POS);
    scene.add(deckGroup);

    // 手番プレイヤーの席を示す金リング（状態の数値表示は親 DOM が担う）。
    const turnRing = new THREE.Mesh(
      new THREE.RingGeometry(0.95, 1.06, 40),
      new THREE.MeshStandardMaterial({ color: 0xf2b33d, roughness: 0.4, side: THREE.DoubleSide }),
    );
    turnRing.rotation.x = -Math.PI / 2;
    turnRing.position.set(0, 0.045, 1.5);
    turnRing.visible = false;
    scene.add(turnRing);

    const cardsGroup = new THREE.Group();
    scene.add(cardsGroup);
    rtRef.current = { cardsGroup, entries: new Map(), turnRing };

    detach = attachPickPointer(stage, () => [felt, rim, cardsGroup], {
      onTap: (hit) => {
        const pickId = hit?.object.userData.pickId as string | undefined;
        if (!pickId?.startsWith("card-")) return;
        const id = Number(pickId.slice("card-".length));
        if (Number.isInteger(id)) propsRef.current.onCardTap(id);
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

  // 差分同期: 自分の手札・他プレイヤーの裏向き手札・場札をスロットキー＋
  // カードキーで管理する。場札の新規カードは出した人の手札エリアから飛び、
  // 場が流れると場札スロットは desired から消えて除去される。
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
      pickCardId?: number;
      frameColor?: number;
      dim: boolean;
      withFrame: boolean;
    }>();

    // 自分の手札（扇状）。最大で二十数枚（2人戦）でも収まるよう、
    // 枚数に応じて間隔を圧縮する（hearts の扇状配置の応用）。
    const handCount = finished ? 0 : yourHand.length;
    const handSpacing = handCount <= 1 ? 0 : Math.min(0.6, 6.6 / (handCount - 1));
    for (let i = 0; i < handCount; i++) {
      const id = yourHand[i];
      const offset = i - (handCount - 1) / 2;
      const isSelected = selected.includes(id);
      desired.set(`h${i}`, {
        id,
        pos: new THREE.Vector3(offset * handSpacing, isSelected ? 0.22 : 0.05, 1.5 + Math.abs(offset) * 0.045 * (handSpacing / 0.6 || 1)),
        yaw: offset * 0.07,
        fromPos: DECK_POS,
        dealOrder: i,
        pickCardId: id,
        frameColor: isSelected ? 0xf2b33d : 0x2b3442,
        dim: !isMyTurn,
        withFrame: true,
      });
    }

    // 他プレイヤーの手札は裏向きの枚数表現のみ（count だけから生成し、
    // 中身のラベルは付けない）。
    for (const other of others) {
      if (other.finished !== null || other.count <= 0) continue;
      const center = seatPos(other.seat, mySeat, totalPlayers);
      const side = isSideSeat(center);
      const spacing = other.count <= 1 ? 0 : Math.min(0.34, 2.8 / (other.count - 1));
      for (let i = 0; i < other.count; i++) {
        const offset = i - (other.count - 1) / 2;
        desired.set(`o${other.seat}-${i}`, {
          id: null,
          pos: side
            ? new THREE.Vector3(center.x, 0.05, center.z + offset * spacing)
            : new THREE.Vector3(center.x + offset * spacing, 0.05, center.z),
          yaw: side ? Math.PI / 2 + offset * 0.05 : offset * 0.05,
          fromPos: DECK_POS,
          dealOrder: i,
          dim: false,
          withFrame: false,
        });
      }
    }

    // 場札（中央）。出した人の席方向へ少し寄せ、新規分はその人の
    // 手札エリアからフライインさせる。
    if (field) {
      const ownerPos = seatPos(field.seat, mySeat, totalPlayers);
      const dir = new THREE.Vector3(ownerPos.x, 0, ownerPos.z);
      if (dir.lengthSq() > 0) dir.normalize();
      field.cards.forEach((id, i) => {
        const offset = i - (field.cards.length - 1) / 2;
        desired.set(`f${i}`, {
          id,
          pos: new THREE.Vector3(offset * 0.88 + dir.x * 0.3, 0.06, -0.25 + dir.z * 0.3),
          yaw: offset * 0.04,
          fromPos: ownerPos,
          dealOrder: i,
          dim: false,
          withFrame: false,
        });
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
      const existing = rt.entries.get(slot);
      if (existing && existing.cardKey !== cardKey) {
        rt.cardsGroup.remove(existing.group);
        rt.entries.delete(slot);
      }
      const entry = rt.entries.get(slot);
      if (!entry) {
        const group = new THREE.Group();
        group.position.copy(d.fromPos);
        const frame = d.withFrame ? makeFrameMesh() : null;
        if (frame) group.add(frame);
        const mesh = makeCardMesh(d.id, d.pickCardId);
        mesh.rotation.x = d.id === null ? FACE_DOWN : FACE_UP;
        setCardDim(mesh, d.dim);
        group.add(mesh);
        group.rotation.y = d.yaw;
        rt.cardsGroup.add(group);
        const dist = group.position.distanceTo(d.pos);
        rt.entries.set(slot, {
          cardKey,
          group,
          mesh,
          frame,
          anim: {
            start: now + d.dealOrder * 60,
            dur: 420,
            fromPos: group.position.clone(),
            toPos: d.pos.clone(),
            arc: Math.min(0.5, dist * 0.3),
          },
        });
        if (frame && d.frameColor !== undefined) {
          (frame.material as THREE.MeshStandardMaterial).color.setHex(d.frameColor);
        }
        continue;
      }
      if (entry.frame && d.frameColor !== undefined) {
        (entry.frame.material as THREE.MeshStandardMaterial).color.setHex(d.frameColor);
      }
      setCardDim(entry.mesh, d.dim);
      if (entry.group.position.distanceTo(d.pos) > 0.01 && !entry.anim) {
        entry.anim = {
          start: now,
          dur: 300,
          fromPos: entry.group.position.clone(),
          toPos: d.pos.clone(),
          arc: 0.05,
        };
      }
      entry.group.rotation.y = d.yaw;
    }

    // 手番リングを手番プレイヤーの席へ。
    if (!finished) {
      const pos = seatPos(turn, mySeat, totalPlayers);
      rt.turnRing.position.set(pos.x, 0.045, pos.z);
      rt.turnRing.visible = true;
    } else {
      rt.turnRing.visible = false;
    }
  }, [yourHand, field, others, mySeat, totalPlayers, selected, isMyTurn, turn, finished]);

  return (
    <SceneBox
      height={420}
      label={`大富豪（3D）。あなたの手札 ${finished ? 0 : yourHand.length}枚、場のカード ${field ? field.cards.length : 0}枚。手札のタップでカードを選びます`}
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#14231c"
    />
  );
}
