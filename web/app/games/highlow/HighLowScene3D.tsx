"use client";
// ハイ＆ローの 3D シーン。カード系の型の応用:
// 現在のカード（表向き）・次のカード（裏向き）・山札の束を横一列に置く。
// 予想が確定すると pile が進み、次のカードが「current」スロットへ移る。
// その際カードキーを維持したまま差分同期するので、裏向きだったカードが
// 次スロット位置からフリップ（裏→表）しながら現在位置へ飛ぶ流れになる。
// 入力は既存語彙どおり: 上フリック = high / 下フリック = low。
// 方向判定は lib/gesture の swipeDirection を使う attachPickPointer の
// onFlick / onDragEnd（掴んだまま離したケース）両経路から既存 onGuess へ渡す。
// スコア・残り枚数などのテキストは親の DOM 併記が担い、3D 内には置かない。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createCard } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import { highLowRankLabel, highLowSuit, isHighLowRed } from "@/lib/highlow";

interface Props {
  /** 現在のカード id（0〜51）。無い場合は null。 */
  current: number | null;
  /** 次のカード id。裏向きで置き、フリップ遷移の同一性のためだけに使う。 */
  nextCard: number | null;
  /** 次のカードを除いた山札の残り枚数。 */
  deckCount: number;
  playing: boolean;
  /** 既存ハンドラ: 上スワイプ = "high" / 下スワイプ = "low"。 */
  onGuess: (dir: "high" | "low") => void;
  onFail: () => void;
  fallback: ReactNode;
}

const CARD_W = 0.95;
const CARD_H = 1.32;
const FACE_UP = -Math.PI / 2;
const FACE_DOWN = Math.PI / 2;

const CURRENT_POS = new THREE.Vector3(-1.2, 0.05, 0.25);
const NEXT_POS = new THREE.Vector3(0.45, 0.05, 0.25);
const DECK_POS = new THREE.Vector3(1.95, 0.05, 0.25);

function makeCardMesh(id: number | null, pickId?: string): THREE.Mesh {
  const mesh = id === null
    ? createCard(CARD_W, CARD_H, {})
    : createCard(CARD_W, CARD_H, {
        label: `${highLowRankLabel(id)}${highLowSuit(id)}`,
        labelColor: isHighLowRed(id) ? "#c62828" : "#1c2333",
      });
  if (pickId !== undefined) mesh.userData.pickId = pickId;
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

interface CardAnim {
  start: number;
  dur: number;
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  arc: number;
  fromRotX: number;
  toRotX: number;
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
  /** スロットを移ったカードの最終位置・向き（フリップ遷移の起点に使う）。 */
  lastPosByCard: Map<string, { pos: THREE.Vector3; rotX: number }>;
}

export default function HighLowScene3D({ current, nextCard, deckCount, playing, onGuess, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);

  const propsRef = useRef({ current, nextCard, deckCount, playing, onGuess });
  propsRef.current = { current, nextCard, deckCount, playing, onGuess };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x14231c,
      camera: { position: [0, 5.4, 5.8], lookAt: [0, 0, 0.2], fov: 44 },
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
      new THREE.BoxGeometry(7.8, 0.14, 4.6),
      new THREE.MeshStandardMaterial({ color: 0x5b3a22, roughness: 0.6 }),
    );
    rim.position.y = -0.1;
    rim.userData.pickId = "table";
    scene.add(rim);
    const felt = new THREE.Mesh(
      new THREE.BoxGeometry(7.4, 0.16, 4.2),
      new THREE.MeshStandardMaterial({ color: 0x1e5c3a, roughness: 1 }),
    );
    felt.position.y = -0.04;
    felt.userData.pickId = "table";
    scene.add(felt);

    const cardsGroup = new THREE.Group();
    scene.add(cardsGroup);
    rtRef.current = { cardsGroup, entries: new Map(), lastPosByCard: new Map() };

    // 既存語彙どおり: 上フリック = high / 下フリック = low（方向判定は
    // attachPickPointer 内の swipeDirection が担う）。カードを掴んだまま
    // 離すと onDragEnd 側に流れるため、両経路を同じハンドラへつなぐ。
    const handleSwipe = (dir: string | null) => {
      if (!propsRef.current.playing) return;
      if (dir === "up") propsRef.current.onGuess("high");
      else if (dir === "down") propsRef.current.onGuess("low");
    };
    detach = attachPickPointer(stage, () => [felt, rim, cardsGroup], {
      onFlick: (flick) => handleSwipe(flick.dir),
      onDragEnd: (flick) => handleSwipe(flick.dir),
    });
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 差分同期: スロットキー＋カードキーの Map で管理する。
  // 次のカードは cardKey を id で持ち裏向きに置くため、現在位置へ移る際に
  // 同じカードとして扱われ、裏→表フリップ＋移動のアニメになる。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const now = performance.now();
    const desired = new Map<string, {
      id: number | null;
      pos: THREE.Vector3;
      faceUp: boolean;
      fromPos: THREE.Vector3;
      dealOrder: number;
      pickId?: string;
      withFrame: boolean;
    }>();

    if (current !== null) {
      desired.set("current", {
        id: current,
        pos: CURRENT_POS.clone(),
        faceUp: true,
        fromPos: NEXT_POS.clone(),
        dealOrder: 0,
        pickId: "current",
        withFrame: true,
      });
    }
    if (nextCard !== null) {
      desired.set("next", {
        id: nextCard,
        pos: NEXT_POS.clone(),
        faceUp: false,
        fromPos: DECK_POS.clone(),
        dealOrder: 1,
        pickId: "next",
        withFrame: true,
      });
    }
    const deckLayers = Math.min(Math.max(deckCount, 0), 4);
    for (let i = 0; i < deckLayers; i++) {
      desired.set(`deck-${i}`, {
        id: null,
        pos: new THREE.Vector3(DECK_POS.x, 0.05 + i * 0.035, DECK_POS.z),
        faceUp: false,
        fromPos: DECK_POS.clone(),
        dealOrder: i,
        withFrame: i === deckLayers - 1,
      });
    }

    // 消滅・スロット移動したカードは最終位置を記録してから除去する。
    for (const [slot, e] of [...rt.entries]) {
      const d = desired.get(slot);
      if (!d || (d.id === null ? "back" : `id-${d.id}`) !== e.cardKey) {
        rt.lastPosByCard.set(e.cardKey, { pos: e.group.position.clone(), rotX: e.mesh.rotation.x });
        rt.cardsGroup.remove(e.group);
        rt.entries.delete(slot);
      }
    }

    for (const [slot, d] of desired) {
      const cardKey = d.id === null ? "back" : `id-${d.id}`;
      const entry = rt.entries.get(slot);
      if (!entry) {
        const group = new THREE.Group();
        const last = rt.lastPosByCard.get(cardKey);
        const fromPos = last ? last.pos.clone() : d.fromPos.clone();
        group.position.copy(fromPos);
        const frame = d.withFrame ? makeFrameMesh() : null;
        if (frame) group.add(frame);
        const mesh = makeCardMesh(d.faceUp ? d.id : null, d.pickId);
        const toRotX = d.faceUp ? FACE_UP : FACE_DOWN;
        const fromRotX = last ? last.rotX : toRotX;
        mesh.rotation.x = fromRotX;
        group.add(mesh);
        rt.cardsGroup.add(group);
        const dist = group.position.distanceTo(d.pos);
        const flipped = Math.abs(fromRotX - toRotX) > 0.01;
        rt.entries.set(slot, {
          cardKey,
          group,
          mesh,
          frame,
          anim: {
            start: now + d.dealOrder * 60,
            dur: flipped ? 520 : 420,
            fromPos: group.position.clone(),
            toPos: d.pos.clone(),
            arc: Math.min(0.5, dist * 0.3),
            fromRotX,
            toRotX,
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
          arc: 0.05,
          fromRotX: entry.mesh.rotation.x,
          toRotX: entry.mesh.rotation.x,
        };
      }
    }
  }, [current, nextCard, deckCount, playing]);

  return (
    <SceneBox
      height={340}
      label={`ハイ＆ロー（3D）。現在のカードと裏向きの次のカード。上へスワイプで高い、下へスワイプで低い`}
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#14231c"
    />
  );
}
