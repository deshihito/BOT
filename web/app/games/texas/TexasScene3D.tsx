"use client";
// テキサスポーカー（オンライン簡易版）の 3D シーン。カード系の型の応用:
// コミュニティカードはストリート進行で board に増えた分だけ山札からフライインし、
// 自分のホールカードは手前、他プレイヤーは裏向きの枚数表現で席に並ぶ。
// ポットは createChip の山で中央に置く。ポット額・チップ・手番は親 DOM 併記。
// 入力は既存ボタンの意味を変えない:
//   タップ = 主アクション（自分の手番なら参加/コール、ハンド終了なら次のハンドへ）
//   下フリック = フォールド（自分の手番のとき）
// 参加/フォールド/次のハンドのボタン自体は従来どおり DOM に残る。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createCard, createChip } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

export interface TexasScenePlayer {
  seat: number;
  cardCount: number;
  folded: boolean;
  inHand: boolean;
  isTurn: boolean;
}

interface Props {
  board: number[];
  yourCards: number[];
  pot: number;
  players: TexasScenePlayer[];
  mySeat: number;
  handNumber: number;
  phase: "betting" | "handEnd" | "finished";
  yourTurn: boolean;
  /** 主アクション: 参加（コール/オールイン）。既存ボタンと同じ move を送る。 */
  onCall: () => void;
  onFold: () => void;
  onNext: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const CARD_W = 0.86;
const CARD_H = 1.2;
const DECK_POS = new THREE.Vector3(2.65, 0.05, -1.5);
const FACE_UP = -Math.PI / 2;
const FACE_DOWN = Math.PI / 2;

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

function makeCardMesh(id: number | null): THREE.Mesh {
  if (id === null) return createCard(CARD_W, CARD_H, {});
  return createCard(CARD_W, CARD_H, {
    label: `${rankLabel(id)}${SUIT_GLYPH[Math.floor(id / 13)] ?? "?"}`,
    labelColor: isRed(id) ? "#c62828" : "#1c2333",
  });
}

/** 席ごとのカード置き場の中心（自分=手前、他はテーブル奥〜左右）。 */
function seatAreaPos(seat: number, mySeat: number, othersOrder: number): THREE.Vector3 {
  if (seat === mySeat) return new THREE.Vector3(0, 0.05, 1.35);
  const spots = [
    new THREE.Vector3(-2.35, 0.05, -1.35),
    new THREE.Vector3(0, 0.05, -1.62),
    new THREE.Vector3(2.35, 0.05, -1.35),
    new THREE.Vector3(-2.95, 0.05, 0.35),
    new THREE.Vector3(2.95, 0.05, 0.35),
  ];
  return spots[Math.min(othersOrder, spots.length - 1)];
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
  turnRing: THREE.Mesh;
}

const CHIP_DENOMS: { amount: number; color: number }[] = [
  { amount: 500, color: 0xd4a017 },
  { amount: 100, color: 0x23272e },
  { amount: 50, color: 0x2563eb },
  { amount: 10, color: 0x8a93a5 },
];

function buildChipStack(group: THREE.Group, amount: number) {
  while (group.children.length > 0) group.remove(group.children[0]);
  let rest = amount;
  let n = 0;
  for (const d of CHIP_DENOMS) {
    while (rest >= d.amount && n < 12) {
      const chip = createChip(0.34, d.color, String(d.amount));
      chip.position.set(0, 0.05 + n * 0.085, 0.72);
      chip.traverse((o) => { o.userData.pickId = "chip"; });
      group.add(chip);
      rest -= d.amount;
      n++;
    }
  }
  if (n === 0 && amount > 0) {
    const chip = createChip(0.34, 0x8a93a5, String(amount));
    chip.position.set(0, 0.05, 0.72);
    group.add(chip);
  }
}

export default function TexasScene3D({
  board, yourCards, pot, players, mySeat, handNumber, phase, yourTurn,
  onCall, onFold, onNext, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);

  const propsRef = useRef({ board, yourCards, pot, players, mySeat, handNumber, phase, yourTurn, onCall, onFold, onNext });
  propsRef.current = { board, yourCards, pot, players, mySeat, handNumber, phase, yourTurn, onCall, onFold, onNext };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x14231c,
      camera: { position: [0, 5.6, 5.9], lookAt: [0, 0, 0], fov: 44 },
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
      new THREE.BoxGeometry(8.4, 0.14, 5.2),
      new THREE.MeshStandardMaterial({ color: 0x5b3a22, roughness: 0.6 }),
    );
    rim.position.y = -0.1;
    rim.userData.pickId = "table";
    scene.add(rim);
    const felt = new THREE.Mesh(
      new THREE.BoxGeometry(8.0, 0.16, 4.8),
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

    // 手番プレイヤーの席を示す金リング。
    const turnRing = new THREE.Mesh(
      new THREE.RingGeometry(0.95, 1.06, 40),
      new THREE.MeshStandardMaterial({ color: 0xf2b33d, roughness: 0.4, side: THREE.DoubleSide }),
    );
    turnRing.rotation.x = -Math.PI / 2;
    turnRing.position.set(0, 0.045, 1.35);
    turnRing.visible = false;
    scene.add(turnRing);

    const cardsGroup = new THREE.Group();
    scene.add(cardsGroup);
    const chipsGroup = new THREE.Group();
    scene.add(chipsGroup);
    rtRef.current = { cardsGroup, chipsGroup, entries: new Map(), turnRing };
    buildChipStack(chipsGroup, propsRef.current.pot);

    const mainAction = () => {
      const p = propsRef.current;
      if (p.phase === "betting" && p.yourTurn) p.onCall();
      else if (p.phase === "handEnd") p.onNext();
    };
    detach = attachPickPointer(stage, () => [felt, rim, cardsGroup, chipsGroup, deckGroup], {
      onTap: mainAction,
      onFlick: (f) => {
        const p = propsRef.current;
        if (f.dir === "down" && p.phase === "betting" && p.yourTurn) p.onFold();
        else mainAction();
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

  // カードの差分同期（blackjack 型）: board はストリートで増えた分だけ新規フライイン、
  // ホールカードと相手の裏向きカードもスロット単位で管理する。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const now = performance.now();
    const desired = new Map<string, { id: number | null; pos: THREE.Vector3; yaw: number; dealOrder: number; dim: boolean }>();

    board.forEach((id, i) => {
      const offset = i - 2;
      desired.set(`b${i}`, {
        id,
        pos: new THREE.Vector3(offset * 0.98, 0.05, -0.42),
        yaw: -offset * 0.03,
        dealOrder: i,
        dim: false,
      });
    });
    yourCards.forEach((id, i) => {
      const offset = i - (yourCards.length - 1) / 2;
      desired.set(`h${i}`, {
        id,
        pos: new THREE.Vector3(offset * 0.98, 0.05, 1.35),
        yaw: offset * 0.1,
        dealOrder: i,
        dim: false,
      });
    });
    const me = players.find((p) => p.seat === mySeat);
    let othersOrder = 0;
    for (const p of players) {
      if (p.seat === mySeat) continue;
      const order = othersOrder++;
      if (!p.inHand || p.cardCount <= 0) continue;
      const center = seatAreaPos(p.seat, mySeat, order);
      for (let i = 0; i < p.cardCount; i++) {
        const offset = i - (p.cardCount - 1) / 2;
        desired.set(`o${p.seat}-${i}`, {
          id: null,
          pos: new THREE.Vector3(center.x + offset * 0.55, 0.05, center.z),
          yaw: offset * 0.12,
          dealOrder: i,
          dim: p.folded,
        });
      }
    }
    void me;

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
        group.position.copy(DECK_POS);
        const mesh = makeCardMesh(d.id);
        mesh.rotation.x = d.id === null ? FACE_DOWN : FACE_UP;
        if (d.dim) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            const std = m as THREE.MeshStandardMaterial;
            std.transparent = true;
            std.opacity = 0.45;
          }
        }
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

    // 手番リングを手番プレイヤーの席へ。
    const turnPlayer = players.find((p) => p.isTurn);
    if (turnPlayer) {
      let order = 0;
      let myOrder = 0;
      for (const p of players) {
        if (p.seat === mySeat) continue;
        if (p.seat === turnPlayer.seat) myOrder = order;
        order++;
      }
      const pos = seatAreaPos(turnPlayer.seat, mySeat, myOrder);
      rt.turnRing.position.set(pos.x, 0.045, pos.z);
      rt.turnRing.visible = true;
    } else {
      rt.turnRing.visible = false;
    }
  }, [board, yourCards, players, mySeat, handNumber]);

  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    buildChipStack(rt.chipsGroup, pot);
  }, [pot]);

  return (
    <SceneBox
      height={380}
      label={`テキサスポーカー（3D）。共通カード ${board.length}枚、あなたの手札 ${yourCards.length}枚、ポット ${pot}点。タップで主アクション、下フリックでフォールド`}
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#14231c"
    />
  );
}
