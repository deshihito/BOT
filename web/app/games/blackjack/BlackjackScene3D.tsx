"use client";
// ブラックジャックの 3D シーン（カード系の型・第1号）。
// 3D テーブルに createCard のカードを配り、ディーラーの伏せカードは
// ヒット/スタンド確定（phase が settled へ遷移）した瞬間にめくれる。
// カードの値・勝敗は lib/blackjack.ts の状態そのままで、ここは演出だけ。
// 操作は既存ジェスチャと同一語彙をレイキャストで受ける:
//   タップ = 進行（対局中はヒット）/ ダブルタップ = ダブル（対局中・2枚時のみ）
//   下スワイプ/下フリック = スタンド（対局中）
//   ベットチップのタップ = ダブル（即時・対局中・2枚時のみ）
// 合計点などの数字は親の DOM 併記が担い、3D 内に小さく置かない。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createCard, createChip } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { BjPhase, Card } from "@/lib/blackjack";

interface Props {
  playerHand: Card[];
  dealerHand: Card[];
  phase: BjPhase;
  /** テーブル中央に出すベット額（betting 中は選択中の額、対局中は state.bet）。 */
  betAmount: number;
  canDoubleNow: boolean;
  /** タップでの進行: betting=配る / player=ヒット / settled=次のラウンド（再支給含む）。 */
  onTapAction: () => void;
  onDouble: () => void;
  onStand: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const CARD_W = 0.86;
const CARD_H = 1.2;
const DECK_POS = new THREE.Vector3(2.65, 0.05, -1.5);
const FACE_UP = -Math.PI / 2;
const FACE_DOWN = Math.PI / 2;

const SUIT_GLYPH: Record<Card["suit"], string> = {
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

function isRed(card: Card): boolean {
  return card.suit === "heart" || card.suit === "diamond";
}

/** 表向きカード（ランク+スートの複合ラベル、赤/黒の色分け）。null は伏せカード用（裏面のみ見える）。 */
function makeCardMesh(card: Card | null): THREE.Mesh {
  if (!card) return createCard(CARD_W, CARD_H, {});
  return createCard(CARD_W, CARD_H, {
    label: `${rankLabel(card.rank)}${SUIT_GLYPH[card.suit]}`,
    labelColor: isRed(card) ? "#c62828" : "#1c2333",
  });
}

function handPos(side: "dealer" | "player", i: number, count: number): { pos: THREE.Vector3; yaw: number } {
  const offset = i - (count - 1) / 2;
  if (side === "dealer") {
    return { pos: new THREE.Vector3(offset * 0.98, 0.05, -1.35), yaw: -offset * 0.05 };
  }
  // プレイヤー手札は扇状: 中央から離れるほど奥へ逃がし、反対向きに傾ける。
  return {
    pos: new THREE.Vector3(offset * 0.98, 0.05, 1.28 + Math.abs(offset) * 0.06),
    yaw: offset * 0.1,
  };
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
  hidden: boolean;
  group: THREE.Group;
  mesh: THREE.Mesh;
  anim: CardAnim | null;
}

interface SceneRt {
  cardsGroup: THREE.Group;
  chipsGroup: THREE.Group;
  entries: Map<string, CardEntry>;
}

/** ベット額をチップの山にする（額面の大きい順に最大9枚まで積む）。 */
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
      chip.position.set(0, 0.05 + n * 0.085, 0.08);
      chip.traverse((o) => { o.userData.pickId = "chip"; });
      group.add(chip);
      rest -= d.amount;
      n++;
    }
  }
}

export default function BlackjackScene3D({
  playerHand, dealerHand, phase, betAmount, canDoubleNow,
  onTapAction, onDouble, onStand, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const propsRef = useRef({ playerHand, dealerHand, phase, betAmount, canDoubleNow, onTapAction, onDouble, onStand });
  propsRef.current = { playerHand, dealerHand, phase, betAmount, canDoubleNow, onTapAction, onDouble, onStand };
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

    // テーブル（木枠＋フェルト）
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
    // ベットサークル（チップ置き場の目印）
    const circle = new THREE.Mesh(
      new THREE.RingGeometry(0.52, 0.6, 36),
      new THREE.MeshStandardMaterial({ color: 0xd9c58a, roughness: 0.5, side: THREE.DoubleSide }),
    );
    circle.rotation.x = -Math.PI / 2;
    circle.position.set(0, 0.045, 0.08);
    scene.add(circle);

    // 山札（裏向きカードの積み重ね）。配布アニメーションの起点。
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

    const clearPendingTap = () => {
      if (tapTimerRef.current) {
        clearTimeout(tapTimerRef.current);
        tapTimerRef.current = null;
      }
    };
    const handleTap = (hit: THREE.Intersection | null) => {
      const p = propsRef.current;
      const isChip = hit?.object.userData.pickId === "chip";
      // チップのタップはダブルの即時経路（遅延なし）。
      if (p.phase === "player" && p.canDoubleNow && isChip) {
        clearPendingTap();
        p.onDouble();
        return;
      }
      // ダブル可能な局面だけ、ダブルタップ判定のためにタップを 280ms 保留する。
      if (p.phase === "player" && p.canDoubleNow) {
        if (tapTimerRef.current) {
          clearPendingTap();
          p.onDouble();
        } else {
          tapTimerRef.current = setTimeout(() => {
            tapTimerRef.current = null;
            propsRef.current.onTapAction();
          }, 280);
        }
        return;
      }
      clearPendingTap();
      p.onTapAction();
    };
    const handleStandGesture = (dir: string | null) => {
      if (dir !== "down") return;
      const p = propsRef.current;
      clearPendingTap();
      if (p.phase === "player") p.onStand();
      else p.onTapAction();
    };

    detach = attachPickPointer(stage, () => [felt, rim, cardsGroup, chipsGroup, deckGroup], {
      onTap: handleTap,
      onFlick: (f) => handleStandGesture(f.dir),
      onDragEnd: (f) => handleStandGesture(f.dir),
    });
    setReady(true);
    return () => {
      clearPendingTap();
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 手札の差分同期: 新しいカードだけが山札から飛び、既存カードは再配置され、
  // ディーラーの伏せカードは hidden が外れた瞬間にその場でめくれる。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const now = performance.now();
    const desired = new Map<string, { card: Card; hidden: boolean; pos: THREE.Vector3; yaw: number; dealOrder: number }>();
    dealerHand.forEach((card, i) => {
      const { pos, yaw } = handPos("dealer", i, dealerHand.length);
      desired.set(`d${i}`, { card, hidden: phase === "player" && i === 1, pos, yaw, dealOrder: i * 2 + 1 });
    });
    playerHand.forEach((card, i) => {
      const { pos, yaw } = handPos("player", i, playerHand.length);
      desired.set(`p${i}`, { card, hidden: false, pos, yaw, dealOrder: i * 2 });
    });

    // ラウンド終了などで消えたスロットを片付ける。
    for (const [slot, e] of [...rt.entries]) {
      if (!desired.has(slot)) {
        rt.cardsGroup.remove(e.group);
        rt.entries.delete(slot);
      }
    }

    for (const [slot, d] of desired) {
      const cardKey = `${d.card.suit}-${d.card.rank}`;
      const existing = rt.entries.get(slot);
      if (existing && existing.cardKey !== cardKey) {
        // 同じスロットに別のカードが来た（ラウンド跨ぎ）: 作り直して飛ばす。
        rt.cardsGroup.remove(existing.group);
        rt.entries.delete(slot);
      }
      const entry = rt.entries.get(slot);
      if (!entry) {
        const group = new THREE.Group();
        group.position.copy(DECK_POS);
        const mesh = makeCardMesh(d.hidden ? null : d.card);
        mesh.rotation.x = d.hidden ? FACE_DOWN : FACE_UP;
        group.add(mesh);
        group.rotation.y = d.yaw;
        rt.cardsGroup.add(group);
        const dist = group.position.distanceTo(d.pos);
        rt.entries.set(slot, {
          cardKey,
          hidden: d.hidden,
          group,
          mesh,
          anim: {
            start: now + d.dealOrder * 130,
            dur: 480,
            fromPos: group.position.clone(),
            toPos: d.pos.clone(),
            fromRotX: mesh.rotation.x,
            toRotX: mesh.rotation.x,
            arc: Math.min(0.55, dist * 0.35),
          },
        });
        continue;
      }
      if (entry.hidden && !d.hidden) {
        // 伏せカードのめくれ: メッシュを表向きに差し替え、その場で回転させる。
        entry.group.remove(entry.mesh);
        const mesh = makeCardMesh(d.card);
        mesh.rotation.x = FACE_DOWN;
        entry.group.add(mesh);
        entry.mesh = mesh;
        entry.hidden = false;
        entry.anim = {
          start: now,
          dur: 520,
          fromPos: entry.group.position.clone(),
          toPos: d.pos.clone(),
          fromRotX: FACE_DOWN,
          toRotX: FACE_UP,
          arc: 0,
        };
        continue;
      }
      entry.hidden = d.hidden;
      // 枚数変化による再配置（扇の中心がずれる分だけ滑らかに寄せる）。
      if (entry.group.position.distanceTo(d.pos) > 0.01 && !entry.anim) {
        entry.anim = {
          start: now,
          dur: 300,
          fromPos: entry.group.position.clone(),
          toPos: d.pos.clone(),
          fromRotX: entry.mesh.rotation.x,
          toRotX: entry.mesh.rotation.x,
          arc: 0.06,
        };
      }
      entry.group.rotation.y = d.yaw;
    }
  }, [playerHand, dealerHand, phase]);

  // ベットチップの山をベット額に追従させる（ダブルで山が増える）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    buildChipStack(rt.chipsGroup, betAmount);
  }, [betAmount]);

  return (
    <SceneBox
      height={360}
      label={`ブラックジャック（3D）。ディーラー ${dealerHand.length}枚、あなた ${playerHand.length}枚。タップで進行、下スワイプでスタンド、ダブルタップでダブル`}
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#14231c"
    />
  );
}
