"use client";
// ドローポーカーの 3D シーン。blackjack の「カード系の型」を土台に、
// 固有要件として個別カードピック（pickId にカード index）を追加した拡張:
//   カードタップ = 捨て札トグルの反転（既存 toggleDiscard と同一動作）
//   キープ札 = 持ち上げ＋金縁フレーム / 捨て札 = 沈ませ＋暗く＋暗色フレーム
// 初期表示はクライアント側で suggestHolds から決まった discards をそのまま
// 受け取るため、提案でキープになる札が最初からキープ表示になる。
// 交換後は cardKey の差分で新しいカードが山札からフライインする（blackjack 型）。
// テーブルへのタップ = 配る/次へ（betting・settled）、下フリック = 交換確定（draw）。
// 役・収支などの数字は親の DOM 併記が担い、3D 内に小さく置かない。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createCard, createChip } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { DpCard, DpPhase } from "@/lib/drawpoker";

interface Props {
  hand: DpCard[];
  phase: DpPhase;
  /** 交換する札の index 集合（クライアントの discards そのまま。初期値は suggestHolds 由来）。 */
  discards: number[];
  /** テーブル中央に出すベット額（betting 中は選択中の額、それ以外は state.bet）。 */
  betAmount: number;
  /** カードタップ = 捨て札トグルの反転（draw フェーズのみ意味を持つ）。 */
  onToggleCard: (index: number) => void;
  /** テーブルタップでの進行: betting/settled = 配る・次ラウンド（チップ切れ時は再支給）。 */
  onTapAction: () => void;
  /** 下スワイプ/下フリック = 交換確定（draw フェーズ）。 */
  onConfirmDraw: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const CARD_W = 0.86;
const CARD_H = 1.2;
const DECK_POS = new THREE.Vector3(2.65, 0.05, -1.5);
const FACE_UP = -Math.PI / 2;
const FACE_DOWN = Math.PI / 2;

const SUIT_GLYPH: Record<DpCard["suit"], string> = {
  spade: "♠",
  heart: "♥",
  diamond: "♦",
  club: "♣",
};

function rankLabel(rank: number): string {
  if (rank === 1) return "A";
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  return String(rank);
}

function isRed(card: DpCard): boolean {
  return card.suit === "heart" || card.suit === "diamond";
}

function makeCardMesh(card: DpCard | null, pickIndex?: number): THREE.Mesh {
  const mesh = !card
    ? createCard(CARD_W, CARD_H, {})
    : createCard(CARD_W, CARD_H, {
        label: `${rankLabel(card.rank)}${SUIT_GLYPH[card.suit]}`,
        labelColor: isRed(card) ? "#c62828" : "#1c2333",
      });
  if (pickIndex !== undefined) mesh.userData.pickId = `card-${pickIndex}`;
  return mesh;
}

/** カード下の縁フレーム。キープ=金、捨て札=暗色で視覚状態を分ける。 */
function makeFrameMesh(): THREE.Mesh {
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(CARD_W + 0.14, CARD_H + 0.14, 0.018),
    new THREE.MeshStandardMaterial({ color: 0xf2b33d, roughness: 0.4, metalness: 0.35 }),
  );
  frame.rotation.x = FACE_UP;
  frame.position.y = -0.014;
  return frame;
}

function handPos(i: number, count: number, dropping: boolean): { pos: THREE.Vector3; yaw: number } {
  const offset = i - (count - 1) / 2;
  // キープ札は持ち上げて手前に、捨て札は沈ませて奥へ倒す（DOM の translateY/減光と同義）。
  return {
    pos: new THREE.Vector3(offset * 1.0, dropping ? 0.03 : 0.2, dropping ? 1.34 : 1.14 + Math.abs(offset) * 0.05),
    yaw: offset * 0.09,
  };
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
  frame: THREE.Mesh;
  anim: CardAnim | null;
}

interface SceneRt {
  cardsGroup: THREE.Group;
  chipsGroup: THREE.Group;
  entries: Map<string, CardEntry>;
}

const CHIP_DENOMS: { amount: number; color: number }[] = [
  { amount: 500, color: 0xd4a017 },
  { amount: 100, color: 0x23272e },
  { amount: 50, color: 0x2563eb },
  { amount: 10, color: 0x8a93a5 },
];

function buildChipStack(group: THREE.Group, betAmount: number) {
  while (group.children.length > 0) group.remove(group.children[0]);
  let rest = betAmount;
  let n = 0;
  for (const d of CHIP_DENOMS) {
    while (rest >= d.amount && n < 9) {
      const chip = createChip(0.34, d.color, String(d.amount));
      chip.position.set(0, 0.05 + n * 0.085, 0.05);
      chip.traverse((o) => { o.userData.pickId = "chip"; });
      group.add(chip);
      rest -= d.amount;
      n++;
    }
  }
}

/** 捨て札は半透明に沈め、キープ札は不透明に戻す（メッシュ素材はカード個別）。 */
function setCardDim(mesh: THREE.Mesh, dim: boolean) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) {
    const std = m as THREE.MeshStandardMaterial;
    std.transparent = dim;
    std.opacity = dim ? 0.55 : 1;
  }
}

export default function DrawPokerScene3D({
  hand, phase, discards, betAmount, onToggleCard, onTapAction, onConfirmDraw, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);

  const propsRef = useRef({ hand, phase, discards, betAmount, onToggleCard, onTapAction, onConfirmDraw });
  propsRef.current = { hand, phase, discards, betAmount, onToggleCard, onTapAction, onConfirmDraw };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x14231c,
      camera: { position: [0, 5.4, 5.8], lookAt: [0, 0, 0.1], fov: 44 },
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
      new THREE.BoxGeometry(7.8, 0.14, 4.8),
      new THREE.MeshStandardMaterial({ color: 0x5b3a22, roughness: 0.6 }),
    );
    rim.position.y = -0.1;
    rim.userData.pickId = "table";
    scene.add(rim);
    const felt = new THREE.Mesh(
      new THREE.BoxGeometry(7.4, 0.16, 4.4),
      new THREE.MeshStandardMaterial({ color: 0x1e5c3a, roughness: 1 }),
    );
    felt.position.y = -0.04;
    felt.userData.pickId = "table";
    scene.add(felt);
    const circle = new THREE.Mesh(
      new THREE.RingGeometry(0.52, 0.6, 36),
      new THREE.MeshStandardMaterial({ color: 0xd9c58a, roughness: 0.5, side: THREE.DoubleSide }),
    );
    circle.rotation.x = -Math.PI / 2;
    circle.position.set(0, 0.045, 0.05);
    scene.add(circle);

    const deckGroup = new THREE.Group();
    for (let i = 0; i < 5; i++) {
      const m = makeCardMesh(null);
      m.rotation.x = FACE_DOWN;
      m.position.set(0, i * 0.014, 0);
      deckGroup.add(m);
    }
    deckGroup.position.copy(DECK_POS);
    scene.add(deckGroup);

    const cardsGroup = new THREE.Group();
    scene.add(cardsGroup);
    const chipsGroup = new THREE.Group();
    scene.add(chipsGroup);
    rtRef.current = { cardsGroup, chipsGroup, entries: new Map() };
    buildChipStack(chipsGroup, propsRef.current.betAmount);

    const handleTap = (hit: THREE.Intersection | null) => {
      const p = propsRef.current;
      const pickId = hit?.object.userData.pickId as string | undefined;
      if (pickId?.startsWith("card-")) {
        const index = Number(pickId.slice("card-".length));
        if (Number.isInteger(index) && index >= 0 && index < p.hand.length) {
          // draw 中のカードタップは捨て札トグル。それ以外はテーブルタップと同じ進行。
          if (p.phase === "draw") {
            p.onToggleCard(index);
            return;
          }
          p.onTapAction();
          return;
        }
      }
      // テーブル/チップのタップ: draw 中は何もしない（確定は下スワイプのみ、2D と同じ）。
      if (p.phase !== "draw") p.onTapAction();
    };
    const handleDownGesture = (dir: string | null) => {
      if (dir !== "down") return;
      const p = propsRef.current;
      if (p.phase === "draw") p.onConfirmDraw();
      else p.onTapAction();
    };

    detach = attachPickPointer(stage, () => [felt, rim, cardsGroup, chipsGroup, deckGroup], {
      onTap: handleTap,
      onFlick: (f) => handleDownGesture(f.dir),
      onDragEnd: (f) => handleDownGesture(f.dir),
    });
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 手札の差分同期（blackjack 型）: 新規・交換されたカードだけが山札から飛び、
  // トグルによるキープ/捨て札の切替は再配置アニメーション＋フレーム色＋減光で表す。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const now = performance.now();
    const discardSet = new Set(discards);
    const desired = new Map<string, { card: DpCard; dropping: boolean; pos: THREE.Vector3; yaw: number; dealOrder: number }>();
    hand.forEach((card, i) => {
      const dropping = discardSet.has(i);
      const { pos, yaw } = handPos(i, hand.length, dropping);
      desired.set(`p${i}`, { card, dropping, pos, yaw, dealOrder: i });
    });

    for (const [slot, e] of [...rt.entries]) {
      if (!desired.has(slot)) {
        rt.cardsGroup.remove(e.group);
        rt.entries.delete(slot);
      }
    }

    for (const [slot, d] of desired) {
      const index = Number(slot.slice(1));
      const cardKey = `${d.card.suit}-${d.card.rank}`;
      const existing = rt.entries.get(slot);
      if (existing && existing.cardKey !== cardKey) {
        // 同じスロットに別のカードが来た（交換・ラウンド跨ぎ）: 作り直して飛ばす。
        rt.cardsGroup.remove(existing.group);
        rt.entries.delete(slot);
      }
      const entry = rt.entries.get(slot);
      if (!entry) {
        const group = new THREE.Group();
        group.position.copy(DECK_POS);
        const frame = makeFrameMesh();
        const mesh = makeCardMesh(d.card, index);
        mesh.rotation.x = FACE_UP;
        group.add(frame);
        group.add(mesh);
        group.rotation.y = d.yaw;
        rt.cardsGroup.add(group);
        const dist = group.position.distanceTo(d.pos);
        const created: CardEntry = {
          cardKey,
          group,
          mesh,
          frame,
          anim: {
            start: now + d.dealOrder * 130,
            dur: 480,
            fromPos: group.position.clone(),
            toPos: d.pos.clone(),
            arc: Math.min(0.55, dist * 0.35),
          },
        };
        (frame.material as THREE.MeshStandardMaterial).color.setHex(d.dropping ? 0x2b3442 : 0xf2b33d);
        setCardDim(mesh, d.dropping);
        rt.entries.set(slot, created);
        continue;
      }
      // 視覚状態（キープ=金縁＋持ち上げ / 捨て札=暗色縁＋減光＋沈ませる）を最新に合わせる。
      (entry.frame.material as THREE.MeshStandardMaterial).color.setHex(d.dropping ? 0x2b3442 : 0xf2b33d);
      setCardDim(entry.mesh, d.dropping);
      if (entry.group.position.distanceTo(d.pos) > 0.01 && !entry.anim) {
        entry.anim = {
          start: now,
          dur: 300,
          fromPos: entry.group.position.clone(),
          toPos: d.pos.clone(),
          arc: 0.06,
        };
      }
      entry.group.rotation.y = d.yaw;
    }
  }, [hand, phase, discards]);

  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    buildChipStack(rt.chipsGroup, betAmount);
  }, [betAmount]);

  return (
    <SceneBox
      height={360}
      label={`ドローポーカー（3D）。手札 ${hand.length}枚。カードのタップで交換する札を切り替え、下スワイプで交換を確定`}
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#14231c"
    />
  );
}
