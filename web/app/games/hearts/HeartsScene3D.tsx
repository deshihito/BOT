"use client";
// ハーツの 3D シーン。カード系の型の応用:
// テーブル中央に4人の出したカード（トリック）を座席方向に置き、自分の手札は
// 手前に扇状（blackjack の handPos 流用）、CPU の手札は裏向きの枚数表現にする。
// 手札カードのタップ = そのカードへの操作。合法判定・パス選択の可否は
// クライアント側の既存ハンドラが持ち、シーンは onCardTap を呼ぶだけ。
// パス選択中のカードは持ち上げ＋金縁、プレイ中に合法でない札は減光して DOM と揃える。
// トリックの勝敗・スコアは親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createCard } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import { cardRank, cardSuit, type HeartsPhase, type HeartsTrickPlay } from "@/lib/hearts";

export interface HeartsScenePlayer {
  seat: number;
  handCount: number;
}

interface Props {
  myHand: number[];
  trick: HeartsTrickPlay[];
  players: HeartsScenePlayer[];
  legal: number[];
  selectedPass: number[];
  phase: HeartsPhase;
  isPassPhase: boolean;
  isMyTurn: boolean;
  /** 手札カードのタップ。パス中は選択トグル、プレイ中は合法手のときだけ出す（判定は親）。 */
  onCardTap: (cardId: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const CARD_W = 0.78;
const CARD_H = 1.08;
const FACE_UP = -Math.PI / 2;
const FACE_DOWN = Math.PI / 2;

const SUIT_GLYPH = { spade: "♠", heart: "♥", diamond: "♦", club: "♣" } as const;

function rankLabel(rank: number): string {
  if (rank === 1) return "A";
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  return String(rank);
}

function makeCardMesh(id: number | null, pickCardId?: number): THREE.Mesh {
  const mesh = id === null
    ? createCard(CARD_W, CARD_H, {})
    : createCard(CARD_W, CARD_H, {
        label: `${rankLabel(cardRank(id))}${SUIT_GLYPH[cardSuit(id)]}`,
        labelColor: cardSuit(id) === "heart" || cardSuit(id) === "diamond" ? "#c62828" : "#1c2333",
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

/** 座席ごとの手札エリア中心（0=手前自分、1=左、2=奥、3=右）。 */
function seatPos(seat: number): THREE.Vector3 {
  if (seat === 1) return new THREE.Vector3(-3.05, 0.05, -0.25);
  if (seat === 2) return new THREE.Vector3(0, 0.05, -1.72);
  if (seat === 3) return new THREE.Vector3(3.05, 0.05, -0.25);
  return new THREE.Vector3(0, 0.05, 1.5);
}

/** トリックの出札位置（出した人の方向へ寄せた中央の4点）。 */
function trickPos(seat: number): THREE.Vector3 {
  if (seat === 1) return new THREE.Vector3(-0.92, 0.06, -0.15);
  if (seat === 2) return new THREE.Vector3(0, 0.06, -0.88);
  if (seat === 3) return new THREE.Vector3(0.92, 0.06, -0.15);
  return new THREE.Vector3(0, 0.06, 0.62);
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

export default function HeartsScene3D({
  myHand, trick, players, legal, selectedPass, phase, isPassPhase, isMyTurn,
  onCardTap, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);

  const propsRef = useRef({ myHand, trick, players, legal, selectedPass, phase, isPassPhase, isMyTurn, onCardTap });
  propsRef.current = { myHand, trick, players, legal, selectedPass, phase, isPassPhase, isMyTurn, onCardTap };
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

  // 差分同期（blackjack 型）: 自分の手札・CPU の裏向き手札・トリックを
  // スロット単位で管理する。トリックの新規カードは出した人の手札エリアから飛ぶ。
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

    // 自分の手札（扇状）。パス選択中は持ち上げ、プレイ中の非合法手は減光。
    myHand.forEach((id, i) => {
      const offset = i - (myHand.length - 1) / 2;
      const selected = selectedPass.includes(id);
      const playable = isPassPhase || legal.includes(id);
      desired.set(`h${i}`, {
        id,
        pos: new THREE.Vector3(offset * 0.6, selected ? 0.22 : 0.05, 1.5 + Math.abs(offset) * 0.045),
        yaw: offset * 0.07,
        fromPos: seatPos(2),
        dealOrder: i,
        pickCardId: id,
        frameColor: selected ? 0xf2b33d : 0x2b3442,
        dim: !isPassPhase && phase === "play" && !playable,
        withFrame: true,
      });
    });

    // CPU の手札は裏向きの枚数表現。
    for (const p of players) {
      if (p.seat === 0) continue;
      const center = seatPos(p.seat);
      for (let i = 0; i < p.handCount; i++) {
        const offset = i - (p.handCount - 1) / 2;
        const horizontal = p.seat === 2;
        desired.set(`c${p.seat}-${i}`, {
          id: null,
          pos: horizontal
            ? new THREE.Vector3(center.x + offset * 0.34, 0.05, center.z)
            : new THREE.Vector3(center.x, 0.05, center.z + offset * 0.34),
          yaw: horizontal ? offset * 0.05 : Math.PI / 2 + offset * 0.05,
          fromPos: seatPos(2),
          dealOrder: i,
          dim: false,
          withFrame: false,
        });
      }
    }

    // トリック（中央）。出した人の席方向から飛んでくる。
    trick.forEach((play, i) => {
      desired.set(`t${play.seat}`, {
        id: play.card,
        pos: trickPos(play.seat),
        yaw: (play.seat - 1.5) * 0.06,
        fromPos: seatPos(play.seat),
        dealOrder: i,
        dim: false,
        withFrame: false,
      });
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
  }, [myHand, trick, players, legal, selectedPass, phase, isPassPhase, isMyTurn]);

  return (
    <SceneBox
      height={380}
      label={`ハーツ（3D）。あなたの手札 ${myHand.length}枚、場のカード ${trick.length}枚。手札のタップでカードを出す`}
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#14231c"
    />
  );
}
