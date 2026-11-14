"use client";
// ババ抜きの 3D シーン。カード系の型（hearts / texas）の応用:
// 自分の手札は手前に表向きの扇、相手の手札は裏向きの扇（枚数だけ）にする。
// 相手のカードの中身は契約上そもそも見えない（others[].count のみ）ため、
// シーンは相手については seat と count しか受け取らない。
// 自分の手番では、引く相手（drawFrom）の扇を中央に大きく出し、
// その裏向きカードのタップ = 既存の draw 操作（index 指定）へ接続する。
// 引いたカードは相手エリア（中央の扇）から自分の手前へフライインし、
// ペアで消えるカードは差分同期の消滅で表す（スロット=カード id で管理するため、
// 抜けた後の手札は再配置アニメーションで詰まる）。
// 順位・ログ・手番表示などの数字と状態は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createCard } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

export interface BabanukiSceneOther {
  seat: number;
  /** 手札の枚数だけ。相手のカードの中身は受け取らない。 */
  count: number;
}

interface Props {
  mySeat: number;
  yourHand: number[];
  others: BabanukiSceneOther[];
  /** 引く相手の seat（自分の手番でない間も値は入るが、扇を中央に出すのは手番中だけ）。 */
  drawFromSeat: number | null;
  isMyTurn: boolean;
  /** 直近の引く操作（引いたカードのフライイン起点の判定に使う）。 */
  lastDraw: { seat: number; from: number } | null;
  /** 相手の裏向きカードのタップ = その位置のカードを引く（既存ハンドラへ）。 */
  onDrawTap: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const CARD_W = 0.78;
const CARD_H = 1.08;
const FACE_UP = -Math.PI / 2;
const FACE_DOWN = Math.PI / 2;
/** 引く相手の扇の中心（相手エリア寄りの中央）。 */
const DRAW_CENTER = new THREE.Vector3(0, 0.05, -0.35);
const TOP_CENTER = new THREE.Vector3(0, 0.05, -1.65);

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

/** id からカードを作る。52 はジョーカー（lib のカード表現に合わせる）。 */
function makeCardMesh(id: number | null, pickId?: string): THREE.Mesh {
  let mesh: THREE.Mesh;
  if (id === null) {
    mesh = createCard(CARD_W, CARD_H, {});
  } else if (id === 52) {
    mesh = createCard(CARD_W, CARD_H, { label: "JOKER", labelColor: "#b8860b" });
  } else {
    mesh = createCard(CARD_W, CARD_H, {
      label: `${rankLabel(id)}${SUIT_GLYPH[Math.floor(id / 13)]}`,
      labelColor: isRed(id) ? "#c62828" : "#1c2333",
    });
  }
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

/** 相手エリアの扇の中心（others の並び順で奥側に広げる）。 */
function otherCenter(index: number, total: number): THREE.Vector3 {
  if (total <= 1) return new THREE.Vector3(0, 0.05, -1.65);
  if (total === 2) return new THREE.Vector3(index === 0 ? -2.3 : 2.3, 0.05, -1.5);
  const xs = [-3.05, 0, 3.05];
  const zs = [-1.2, -1.7, -1.2];
  return new THREE.Vector3(xs[index] ?? 0, 0.05, zs[index] ?? -1.5);
}

/** 扇の間隔（枚数が多いときは幅に収まるよう詰める）。 */
function fanSpacing(count: number, max: number, budget: number): number {
  if (count <= 1) return max;
  return Math.min(max, budget / count);
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

export default function BabanukiScene3D({
  mySeat, yourHand, others, drawFromSeat, isMyTurn, lastDraw, onDrawTap, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);

  const propsRef = useRef({ mySeat, yourHand, others, drawFromSeat, isMyTurn, lastDraw, onDrawTap });
  propsRef.current = { mySeat, yourHand, others, drawFromSeat, isMyTurn, lastDraw, onDrawTap };
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
        if (!pickId?.startsWith("draw-")) return;
        const index = Number(pickId.slice("draw-".length));
        if (Number.isInteger(index) && index >= 0) propsRef.current.onDrawTap(index);
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

  // 差分同期: 自分の手札はカード id をスロットキーにする（ペア消滅・引かれた
  // 移動で残りの札は作り直されず再配置だけが起きる）。相手は seat+位置の
  // スロットに裏向きカードを枚数分だけ置く。
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
    }>();

    // 自分の手札（手前に表向きの扇）。
    const mySpacing = fanSpacing(yourHand.length, 0.6, 6.4);
    yourHand.forEach((id, i) => {
      const offset = i - (yourHand.length - 1) / 2;
      desired.set(`mine-id-${id}`, {
        id,
        pos: new THREE.Vector3(offset * mySpacing, 0.05, 1.5 + Math.abs(offset) * 0.03),
        yaw: offset * 0.05,
        // 自分が引いた直後の新規カードは相手エリア（中央の扇）から飛ぶ。
        fromPos: lastDraw && lastDraw.seat === mySeat ? DRAW_CENTER.clone() : TOP_CENTER.clone(),
        dealOrder: i,
        frameColor: 0x2b3442,
      });
    });

    // 相手の手札（裏向きの扇、枚数のみ）。引く相手は手番中だけ中央に出す。
    others.forEach((o, oi) => {
      const isTarget = isMyTurn && drawFromSeat !== null && o.seat === drawFromSeat;
      if (isTarget) {
        const spacing = fanSpacing(o.count, 0.62, 5.6);
        for (let i = 0; i < o.count; i++) {
          const offset = i - (o.count - 1) / 2;
          desired.set(`draw-${i}`, {
            id: null,
            pos: new THREE.Vector3(DRAW_CENTER.x + offset * spacing, 0.05, DRAW_CENTER.z + Math.abs(offset) * 0.03),
            yaw: offset * 0.05,
            fromPos: otherCenter(oi, others.length),
            dealOrder: i,
            pickId: `draw-${i}`,
            frameColor: 0xf2b33d,
          });
        }
        return;
      }
      const center = otherCenter(oi, others.length);
      const spacing = fanSpacing(o.count, 0.34, 2.6);
      for (let i = 0; i < o.count; i++) {
        const offset = i - (o.count - 1) / 2;
        desired.set(`opp-${o.seat}-${i}`, {
          id: null,
          pos: new THREE.Vector3(center.x + offset * spacing, 0.05, center.z + Math.abs(offset) * 0.02),
          yaw: offset * 0.05,
          fromPos: TOP_CENTER.clone(),
          dealOrder: i,
        });
      }
    });

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
        const frame = d.frameColor !== undefined ? makeFrameMesh(d.frameColor) : null;
        if (frame) group.add(frame);
        const mesh = makeCardMesh(d.id, d.pickId);
        mesh.rotation.x = d.id === null ? FACE_DOWN : FACE_UP;
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
            dur: 400,
            fromPos: group.position.clone(),
            toPos: d.pos.clone(),
            arc: Math.min(0.5, dist * 0.3),
          },
        });
        continue;
      }
      if (entry.group.position.distanceTo(d.pos) > 0.01 && !entry.anim) {
        entry.anim = {
          start: now,
          dur: 280,
          fromPos: entry.group.position.clone(),
          toPos: d.pos.clone(),
          arc: 0.05,
        };
      }
      entry.group.rotation.y = d.yaw;
    }
  }, [mySeat, yourHand, others, drawFromSeat, isMyTurn, lastDraw]);

  return (
    <SceneBox
      height={380}
      label={`ババ抜き（3D）。あなたの手札 ${yourHand.length}枚。あなたの手番では相手の裏向きカードのタップで1枚引く`}
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#14231c"
    />
  );
}
