"use client";
// バカラの 3D シーン。blackjack で確定した「カード系の型」の再利用第1号:
// createCard のカードが山札から両手札へ飛び、第3カードは差分で追加配布され、
// ベットチップの山がテーブル中央に立つ。値・勝敗は lib/baccarat.ts の状態
// そのままで、ここは演出だけ。合計は親の DOM 併記が担う。
// 操作は既存ジェスチャと同一: テーブルへのタップ/フリック = 配る/次のラウンド/再支給。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createCard, createChip } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { BaccaratBetKind, BaccaratCard, BaccaratPhase } from "@/lib/baccarat";

interface Props {
  playerCards: BaccaratCard[];
  bankerCards: BaccaratCard[];
  phase: BaccaratPhase;
  /** テーブル中央に出すベット額と賭け先（色分け用）。betting 中は選択中の値。 */
  chipAmount: number;
  chipKind: BaccaratBetKind;
  onTapAction: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const CARD_W = 0.86;
const CARD_H = 1.2;
const DECK_POS = new THREE.Vector3(2.65, 0.05, -1.5);
const FACE_UP = -Math.PI / 2;

const SUIT_GLYPH = ["♠", "♥", "♦", "♣"] as const;
const KIND_COLOR: Record<BaccaratBetKind, number> = {
  player: 0x2563eb,
  banker: 0xdc2626,
  tie: 0x16a34a,
};

function rankLabel(rank: number): string {
  if (rank === 1) return "A";
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  return String(rank);
}

function makeCardMesh(card: BaccaratCard | null): THREE.Mesh {
  if (!card) return createCard(CARD_W, CARD_H, {});
  const red = card.suit === 1 || card.suit === 2;
  return createCard(CARD_W, CARD_H, {
    label: `${rankLabel(card.rank)}${SUIT_GLYPH[card.suit] ?? "?"}`,
    labelColor: red ? "#c62828" : "#1c2333",
  });
}

function handPos(side: "banker" | "player", i: number, count: number): { pos: THREE.Vector3; yaw: number } {
  const offset = i - (count - 1) / 2;
  const z = side === "banker" ? -1.35 : 1.3;
  return { pos: new THREE.Vector3(offset * 0.98, 0.05, z), yaw: offset * (side === "banker" ? -0.05 : 0.08) };
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
  anim: CardAnim | null;
}

interface SceneRt {
  cardsGroup: THREE.Group;
  chipsGroup: THREE.Group;
  entries: Map<string, CardEntry>;
}

const CHIP_DENOMS = [500, 100, 50, 10] as const;

function buildChipStack(group: THREE.Group, amount: number, kind: BaccaratBetKind) {
  while (group.children.length > 0) group.remove(group.children[0]);
  let rest = amount;
  let n = 0;
  for (const d of CHIP_DENOMS) {
    while (rest >= d && n < 9) {
      const chip = createChip(0.34, KIND_COLOR[kind], String(d));
      chip.position.set(0, 0.05 + n * 0.085, 0.08);
      chip.traverse((o) => { o.userData.pickId = "chip"; });
      group.add(chip);
      rest -= d;
      n++;
    }
  }
}

export default function BaccaratScene3D({
  playerCards, bankerCards, chipAmount, chipKind, onTapAction, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);

  const propsRef = useRef({ playerCards, bankerCards, chipAmount, chipKind, onTapAction });
  propsRef.current = { playerCards, bankerCards, chipAmount, chipKind, onTapAction };
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
    circle.position.set(0, 0.045, 0.08);
    scene.add(circle);

    const deckGroup = new THREE.Group();
    for (let i = 0; i < 5; i++) {
      const m = makeCardMesh(null);
      m.rotation.x = Math.PI / 2;
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
    buildChipStack(chipsGroup, propsRef.current.chipAmount, propsRef.current.chipKind);

    detach = attachPickPointer(stage, () => [felt, rim, cardsGroup, chipsGroup, deckGroup], {
      onTap: () => propsRef.current.onTapAction(),
      onFlick: () => propsRef.current.onTapAction(),
    });
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 手札の差分同期（blackjack と同じ型）: 新規カードだけが山札から飛び、
  // 既存カードは枚数変化に合わせて再配置される。第3カードもこの差分で入る。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const now = performance.now();
    const desired = new Map<string, { card: BaccaratCard; pos: THREE.Vector3; yaw: number; dealOrder: number }>();
    bankerCards.forEach((card, i) => {
      const { pos, yaw } = handPos("banker", i, bankerCards.length);
      desired.set(`b${i}`, { card, pos, yaw, dealOrder: i * 2 + 1 });
    });
    playerCards.forEach((card, i) => {
      const { pos, yaw } = handPos("player", i, playerCards.length);
      desired.set(`p${i}`, { card, pos, yaw, dealOrder: i * 2 });
    });

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
        rt.cardsGroup.remove(existing.group);
        rt.entries.delete(slot);
      }
      const entry = rt.entries.get(slot);
      if (!entry) {
        const group = new THREE.Group();
        group.position.copy(DECK_POS);
        const mesh = makeCardMesh(d.card);
        mesh.rotation.x = FACE_UP;
        group.add(mesh);
        group.rotation.y = d.yaw;
        rt.cardsGroup.add(group);
        const dist = group.position.distanceTo(d.pos);
        rt.entries.set(slot, {
          cardKey,
          group,
          anim: {
            start: now + d.dealOrder * 130,
            dur: 480,
            fromPos: group.position.clone(),
            toPos: d.pos.clone(),
            arc: Math.min(0.55, dist * 0.35),
          },
        });
        continue;
      }
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
  }, [playerCards, bankerCards]);

  // ベットチップの山を、選択中/確定した賭け（額＋賭け先の色）に追従させる。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    buildChipStack(rt.chipsGroup, chipAmount, chipKind);
  }, [chipAmount, chipKind]);

  return (
    <SceneBox
      height={360}
      label={`バカラ（3D）。プレイヤー ${playerCards.length}枚、バンカー ${bankerCards.length}枚。タップで進行`}
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#14231c"
    />
  );
}
