"use client";
// ハゲタカの 3D シーン。カード型の流用（three-kit の createCard）で、
// 数字カードは大きな数字テクスチャで読めるようにする。配置は3段:
//   奥: 場の得点カード（プラスは緑・マイナスは赤、公開情報）
//   中: 前ラウンドで公開された全員の入札カード（lastResult 由来のみ）
//   手前: 自分の手札（タップ = 既存の入札ハンドラへ接続）
// 秘匿の扱い: 他人の未公開の入札はシーンへ渡さない。親は他人については
// submitted（出したかどうか）だけを渡し、シーンは裏向きカードの
// 傾きと色で提出状況だけを示す。自分の提出済みカードは自分の情報
// として yourCard で受け取り、手前で持ち上げて示す。
// 入札の勝敗・持ち越し判定は親＋サーバーが正で、ここは表現と入力だけ。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createCard } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

export interface HagetakaSceneSubmitted {
  seat: number;
  /** 提出済みかどうかだけ。未公開の入札カードの中身は受け取らない。 */
  submitted: boolean;
  isYou: boolean;
}

export interface HagetakaSceneLastBid {
  seat: number;
  /** 前ラウンドに公開された入札（履歴として全員に見えている情報）。 */
  card: number | null;
  taker: boolean;
  isYou: boolean;
}

interface Props {
  phase: "bidding" | "finished";
  /** 場の得点カード（公開情報）。 */
  table: number[];
  /** 自分の手札（自分の情報だけ）。 */
  hand: number[];
  canBid: boolean;
  /** 自分が提出済みのカード（自分の情報）。未提出は null。 */
  yourCard: number | null;
  submitted: HagetakaSceneSubmitted[];
  /** 前ラウンドの公開済み入札。なければ null。 */
  lastBids: HagetakaSceneLastBid[] | null;
  /** 手札カードのタップ = 既存の入札ハンドラ（親の doBid）へ渡す。 */
  onBid: (card: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const CARD_W = 0.78;
const CARD_H = 1.08;
const FACE_UP = -Math.PI / 2;
const FACE_DOWN = Math.PI / 2;

function makeFrameMesh(color: number): THREE.Mesh {
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(CARD_W + 0.12, CARD_H + 0.12, 0.018),
    new THREE.MeshStandardMaterial({ color, roughness: 0.45 }),
  );
  frame.rotation.x = FACE_UP;
  frame.position.y = -0.014;
  return frame;
}

function prizeCardMesh(value: number): THREE.Mesh {
  return createCard(CARD_W, CARD_H, {
    face: value >= 0 ? "#43a35c" : "#e2534a",
    label: value > 0 ? `+${value}` : `${value}`,
    labelColor: "#ffffff",
  });
}

function handCardMesh(card: number, pickId?: string): THREE.Mesh {
  const mesh = createCard(CARD_W, CARD_H, { label: String(card), labelColor: "#1c2333" });
  if (pickId !== undefined) mesh.userData.pickId = pickId;
  return mesh;
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
  entries: Map<string, CardEntry>;
}

export default function HagetakaScene3D({ phase, table, hand, canBid, yourCard, submitted, lastBids, onBid, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ canBid, onBid });
  propsRef.current = { canBid, onBid };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x1d2b26,
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
    scene.add(rim);
    const felt = new THREE.Mesh(
      new THREE.BoxGeometry(8.0, 0.16, 5.0),
      new THREE.MeshStandardMaterial({ color: 0x24513d, roughness: 1 }),
    );
    felt.position.y = -0.04;
    scene.add(felt);

    const cardsGroup = new THREE.Group();
    scene.add(cardsGroup);
    rtRef.current = { cardsGroup, entries: new Map() };

    detach = attachPickPointer(stage, () => [cardsGroup], {
      onTap: (hit) => {
        const pickId = hit?.object.userData.pickId as string | undefined;
        if (!pickId?.startsWith("bid-")) return;
        if (!propsRef.current.canBid) return;
        const card = Number(pickId.slice(4));
        if (Number.isInteger(card)) propsRef.current.onBid(card);
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

  // 差分同期（スロットキー＋カードキーの entries で管理する）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const now = performance.now();
    const desired = new Map<string, {
      cardKey: string;
      build: () => THREE.Group;
      pos: THREE.Vector3;
      yaw: number;
    }>();
    const addCard = (slot: string, cardKey: string, mesh: THREE.Mesh, faceUp: boolean, pos: THREE.Vector3, yaw: number, frameColor?: number) => {
      desired.set(slot, {
        cardKey,
        build: () => {
          const grp = new THREE.Group();
          if (frameColor !== undefined) grp.add(makeFrameMesh(frameColor));
          mesh.rotation.x = faceUp ? FACE_UP : FACE_DOWN;
          grp.add(mesh);
          return grp;
        },
        pos,
        yaw,
      });
    };

    if (phase === "bidding") {
      // 奥: 場の得点カード。
      table.forEach((v, i) => {
        const offset = i - (table.length - 1) / 2;
        addCard(`prize-${i}`, `prize-${v}`, prizeCardMesh(v), true,
          new THREE.Vector3(offset * 0.95, 0.05, -1.85), offset * 0.04);
      });

      // 中: 前ラウンドの公開済み入札（獲得者は金縁＋持ち上げ）。
      if (lastBids) {
        lastBids.forEach((b, i) => {
          if (b.card === null) return;
          const offset = i - (lastBids.length - 1) / 2;
          addCard(`last-${b.seat}`, `last-${b.card}`, handCardMesh(b.card), true,
            new THREE.Vector3(offset * 0.92, b.taker ? 0.14 : 0.05, -0.62), offset * 0.03,
            b.taker ? 0xf2b33d : undefined);
        });
      }

      // 中手前: 他人の提出状況は裏向きカードでだけ示す（中身は受け取らない）。
      const others = submitted.filter((s) => !s.isYou);
      others.forEach((s, i) => {
        const offset = i - (others.length - 1) / 2;
        const back = createCard(CARD_W * 0.8, CARD_H * 0.8, {});
        addCard(`opp-${s.seat}`, `opp-${s.submitted ? "in" : "wait"}`, back, false,
          new THREE.Vector3(offset * 0.85, s.submitted ? 0.12 : 0.05, 0.42), offset * 0.05,
          s.submitted ? 0x37b24d : undefined);
      });

      // 手前: 自分の手札。提出済みの1枚は持ち上げて金縁にする。
      const spacing = hand.length <= 1 ? 0.62 : Math.min(0.62, 6.6 / hand.length);
      hand.forEach((card, i) => {
        const offset = i - (hand.length - 1) / 2;
        const mine = yourCard === card;
        addCard(`hand-${card}`, `hand-${card}-${canBid ? "pick" : "flat"}`, handCardMesh(card, canBid ? `bid-${card}` : undefined), true,
          new THREE.Vector3(offset * spacing, mine ? 0.16 : 0.05, 1.72 + Math.abs(offset) * 0.02), offset * 0.04,
          mine ? 0xf2b33d : 0x2b3442);
      });
    }

    for (const [slot, e] of [...rt.entries]) {
      if (!desired.has(slot)) {
        rt.cardsGroup.remove(e.group);
        rt.entries.delete(slot);
      }
    }
    for (const [slot, d] of desired) {
      const existing = rt.entries.get(slot);
      if (existing && existing.cardKey !== d.cardKey) {
        rt.cardsGroup.remove(existing.group);
        rt.entries.delete(slot);
      }
      const entry = rt.entries.get(slot);
      if (!entry) {
        const group = d.build();
        group.position.copy(d.pos).add(new THREE.Vector3(0, 0.4, -0.6));
        group.rotation.y = d.yaw;
        rt.cardsGroup.add(group);
        rt.entries.set(slot, {
          cardKey: d.cardKey,
          group,
          anim: { start: now, dur: 320, fromPos: group.position.clone(), toPos: d.pos.clone(), arc: 0.12 },
        });
        continue;
      }
      if (entry.group.position.distanceTo(d.pos) > 0.01 && !entry.anim) {
        entry.anim = { start: now, dur: 260, fromPos: entry.group.position.clone(), toPos: d.pos.clone(), arc: 0.05 };
      }
      entry.group.rotation.y = d.yaw;
    }
  }, [phase, table, hand, canBid, yourCard, submitted, lastBids]);

  return (
    <SceneBox
      height={380}
      label="ハゲタカ（3D）。奥が場の得点カード、手前の自分の手札をタップで入札します"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#1d2b26"
    />
  );
}
