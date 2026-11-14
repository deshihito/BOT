"use client";
// ブラフの 3D シーン。カード系の型の応用（hearts / blackjack）:
// 中央に伏せ札の山（pileCount 枚を裏面だけのカードで積み、山の高さでも
// 枚数を表す）、自分の手札は手前に扇状、相手の手札は裏向きの枚数表現のみ。
// 秘匿が本質: 場の伏せ札と相手の手札は中身を一切参照せず、createCard に
// label を渡さない裏面のみで描く。公開されるのはチャレンジ開示
// （revealCards、サーバーが全員へ公開済みの情報）だけで、その場で
// 裏→表へフリップしてめくる（blackjack の settled フリップ方式）。
// 手札のタップ = 既存の選択トグル（複数選択・上限3枚の判定は親が持つ）。
// 宣言ランク・枚数・状態は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createCard } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

export interface CheatSceneOther {
  seat: number;
  count: number;
}

interface Props {
  myHand: number[];
  selected: number[];
  others: CheatSceneOther[];
  pileCount: number;
  /** チャレンジで公開されたカード（公開情報のみ）。なければ null。 */
  revealCards: number[] | null;
  /** 開示の同一性キー。キーが変わったら新しい開示としてフリップし直す。 */
  revealKey: string | null;
  myTurn: boolean;
  finished: boolean;
  /** 手札カードのタップ。選択トグル（判定は親の既存ハンドラ）。 */
  onCardTap: (cardId: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const CARD_W = 0.78;
const CARD_H = 1.08;
const FACE_UP = -Math.PI / 2;
const FACE_DOWN = Math.PI / 2;
const PILE_POS = new THREE.Vector3(0, 0.05, -0.35);

const SUIT_GLYPH = ["♠", "♥", "♦", "♣"] as const;

function rankLabel(rank: number): string {
  if (rank === 1) return "A";
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  return String(rank);
}

function cardSuit(id: number): number {
  return Math.floor(id / 13);
}
function cardRank(id: number): number {
  return (id % 13) + 1;
}

/** id が null のときは伏せカード: label を付けず裏面のみで作る（秘匿）。 */
function makeCardMesh(id: number | null, pickCardId?: number): THREE.Mesh {
  const mesh = id === null
    ? createCard(CARD_W, CARD_H, {})
    : createCard(CARD_W, CARD_H, {
        label: `${rankLabel(cardRank(id))}${SUIT_GLYPH[cardSuit(id)]}`,
        labelColor: cardSuit(id) === 1 || cardSuit(id) === 2 ? "#c62828" : "#1c2333",
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

/** 相手の座席エリア中心（相手 index と人数で弧状に配置）。 */
function oppPos(idx: number, total: number): THREE.Vector3 {
  const presets: Record<number, [number, number][]> = {
    1: [[0, -1.7]],
    2: [[-1.8, -1.6], [1.8, -1.6]],
    3: [[-2.6, -1.0], [0, -1.75], [2.6, -1.0]],
    4: [[-3.0, -0.7], [-1.2, -1.75], [1.2, -1.75], [3.0, -0.7]],
    5: [[-3.1, -0.5], [-1.9, -1.6], [0, -1.85], [1.9, -1.6], [3.1, -0.5]],
  };
  const list = presets[Math.min(5, Math.max(1, total))] ?? presets[1];
  const [x, z] = list[Math.min(idx, list.length - 1)];
  return new THREE.Vector3(x, 0.05, z);
}

interface CardAnim {
  start: number;
  dur: number;
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromRotX: number;
  toRotX: number;
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

export default function CheatScene3D({
  myHand, selected, others, pileCount, revealCards, revealKey, myTurn, finished,
  onCardTap, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);

  const propsRef = useRef({ myHand, selected, others, pileCount, revealCards, revealKey, myTurn, finished, onCardTap });
  propsRef.current = { myHand, selected, others, pileCount, revealCards, revealKey, myTurn, finished, onCardTap };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x14231c,
      camera: { position: [0, 5.9, 6.1], lookAt: [0, 0, 0], fov: 44 },
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
          e.mesh.rotation.x = a.fromRotX + (a.toRotX - a.fromRotX) * ease;
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
      new THREE.BoxGeometry(8.6, 0.14, 5.6),
      new THREE.MeshStandardMaterial({ color: 0x5b3a22, roughness: 0.6 }),
    );
    rim.position.y = -0.1;
    rim.userData.pickId = "table";
    scene.add(rim);
    const felt = new THREE.Mesh(
      new THREE.BoxGeometry(8.2, 0.16, 5.2),
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

  // 差分同期（hearts 型）: スロットキー＋カードキー Map で管理する。
  // 新規は山の位置からフライイン、位置変化は再配置アニメ、消滅は除去。
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
      flip: boolean;
    }>();

    // 自分の手札（扇状）。選択中は金縁＋持ち上げ、手番でないときは減光。
    const spacing = myHand.length > 1 ? Math.min(0.6, 6.6 / (myHand.length - 1)) : 0.6;
    myHand.forEach((id, i) => {
      const offset = i - (myHand.length - 1) / 2;
      const isSel = selected.includes(id);
      desired.set(`h${i}`, {
        id,
        pos: new THREE.Vector3(offset * spacing, isSel ? 0.24 : 0.05, 1.55 + Math.abs(offset) * 0.03),
        yaw: offset * 0.05,
        fromPos: PILE_POS.clone(),
        dealOrder: i,
        pickCardId: id,
        frameColor: isSel ? 0xf2b33d : 0x2b3442,
        dim: !myTurn && !finished,
        withFrame: true,
        flip: false,
      });
    });

    // 場の山: 伏せ札だけを積む（id は null、中身は参照しない）。高さが枚数。
    for (let i = 0; i < pileCount; i++) {
      const pos = new THREE.Vector3(PILE_POS.x, 0.05 + i * 0.02, PILE_POS.z);
      desired.set(`p${i}`, {
        id: null,
        pos,
        yaw: (i % 5) * 0.06 - 0.12,
        fromPos: pos.clone(),
        dealOrder: 0,
        dim: false,
        withFrame: false,
        flip: false,
      });
    }

    // 相手の手札は裏向きの枚数表現のみ（count だけから作り、中身は持たない）。
    others.forEach((o, idx) => {
      const center = oppPos(idx, others.length);
      for (let i = 0; i < o.count; i++) {
        const offset = i - (o.count - 1) / 2;
        desired.set(`c${o.seat}-${i}`, {
          id: null,
          pos: new THREE.Vector3(center.x + offset * 0.26, 0.05, center.z),
          yaw: offset * 0.04,
          fromPos: PILE_POS.clone(),
          dealOrder: i,
          dim: false,
          withFrame: false,
          flip: false,
        });
      }
    });

    // チャレンジ開示: 公開済みカードを山の手前に並べ、裏→表へフリップする。
    if (revealCards && revealKey) {
      revealCards.forEach((id, i) => {
        const offset = i - (revealCards.length - 1) / 2;
        desired.set(`r${revealKey}-${i}`, {
          id,
          pos: new THREE.Vector3(offset * 0.88, 0.07, 0.72),
          yaw: offset * 0.05,
          fromPos: PILE_POS.clone(),
          dealOrder: i,
          dim: false,
          withFrame: false,
          flip: true,
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
        // 伏せ札は裏向き、開示カードは裏向きから始めてフリップで表へ。
        mesh.rotation.x = d.id === null || d.flip ? FACE_DOWN : FACE_UP;
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
            start: now + d.dealOrder * 50,
            dur: d.flip ? 560 : 420,
            fromPos: group.position.clone(),
            toPos: d.pos.clone(),
            fromRotX: mesh.rotation.x,
            toRotX: d.id === null ? FACE_DOWN : FACE_UP,
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
          fromRotX: entry.mesh.rotation.x,
          toRotX: entry.mesh.rotation.x,
          arc: 0.05,
        };
      }
      entry.group.rotation.y = d.yaw;
    }
  }, [myHand, selected, others, pileCount, revealCards, revealKey, myTurn, finished]);

  return (
    <SceneBox
      height={380}
      label={`ブラフ（3D）。あなたの手札 ${myHand.length}枚、場の山 ${pileCount}枚。手札のタップで選択`}
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#14231c"
    />
  );
}
