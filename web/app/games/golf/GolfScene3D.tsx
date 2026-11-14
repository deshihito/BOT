"use client";
// ゴルフソリティアの 3D シーン（カード系の型）。
// 場札7列＋台札＋山札を createCard で立体化する。状態・合法判定は
// lib/golf.ts とクライアントの既存ハンドラが持ち、ここは表現と入力の
// 橋渡しだけを行う:
//   取れる列の一番下のカードのタップ = 既存 handleTake（2D でボタンが
//     有効な場合と全く同じ条件でのみ呼ぶ）
//   山札のタップ = 既存 handleFlip
// 取れるカードは金色の縁＋持ち上げで示す（2D の juice-pulse 相当）。
// 数字（手数・残り枚数・山札枚数）は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createCard } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import {
  golfIsRed,
  golfRankLabel,
  golfSuitSymbol,
  type GolfCard,
  type GolfState,
} from "@/lib/golf";

interface Props {
  state: GolfState;
  playable: number[];
  onTake: (col: number) => void;
  onFlip: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const CARD_W = 0.84;
const CARD_H = 1.17;
const PITCH = 0.95;
const TOP_Z = -2.15;
const TAB_Z0 = -0.95;
const ROW_STEP = 0.32;
const FACE_UP = -Math.PI / 2;
const STOCK_POS = new THREE.Vector3(0.55, 0.05, TOP_Z);
const WASTE_POS = new THREE.Vector3(-0.55, 0.05, TOP_Z);

function colX(col: number): number {
  return (col - 3) * PITCH;
}

function makeCardMesh(card: GolfCard): THREE.Mesh {
  return createCard(CARD_W, CARD_H, {
    label: `${golfRankLabel(card.rank)}${golfSuitSymbol(card.suit)}`,
    labelColor: golfIsRed(card.suit) ? "#c62828" : "#1c2333",
  });
}

function findPickId(obj: THREE.Object3D | null): string | null {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    const id = cur.userData.pickId as string | undefined;
    if (id) return id;
    cur = cur.parent;
  }
  return null;
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
  highlight: THREE.Mesh;
  anim: CardAnim | null;
}

interface SceneRt {
  cardsGroup: THREE.Group;
  entries: Map<string, CardEntry>;
  stockLayers: THREE.Mesh[];
  stockGroup: THREE.Group;
}

export default function GolfScene3D({ state, playable, onTake, onFlip, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ state, playable, onTake, onFlip });
  propsRef.current = { state, playable, onTake, onFlip };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x14231c,
      camera: { position: [0, 9.6, 8.2], lookAt: [0, 0, -0.2], fov: 42 },
      onFrame: (_dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        const now = performance.now();
        for (const e of rt.entries.values()) {
          if (e.highlight.visible) {
            const m = e.highlight.material as THREE.MeshBasicMaterial;
            m.opacity = 0.55 + 0.35 * Math.sin(t * 5);
          }
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
      new THREE.BoxGeometry(8.0, 0.14, 8.2),
      new THREE.MeshStandardMaterial({ color: 0x5b3a22, roughness: 0.6 }),
    );
    rim.position.set(0, -0.1, -0.2);
    scene.add(rim);
    const felt = new THREE.Mesh(
      new THREE.BoxGeometry(7.6, 0.16, 7.8),
      new THREE.MeshStandardMaterial({ color: 0x1e5c3a, roughness: 1 }),
    );
    felt.position.set(0, -0.04, -0.2);
    scene.add(felt);

    // 台札・山札の枠
    const slotGeo = new THREE.BoxGeometry(CARD_W + 0.05, 0.02, CARD_H + 0.05);
    for (const [x, color] of [[WASTE_POS.x, 0x7db4ff], [STOCK_POS.x, 0xffffff]] as const) {
      const slot = new THREE.Mesh(slotGeo, new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.2, roughness: 0.9 }));
      slot.position.set(x, 0.02, TOP_Z);
      scene.add(slot);
    }

    // 山札（裏向きカードの積み重ね。枚数は層の数で粗く表す）
    const stockGroup = new THREE.Group();
    stockGroup.position.copy(STOCK_POS);
    scene.add(stockGroup);
    const stockLayers: THREE.Mesh[] = [];
    for (let i = 0; i < 6; i++) {
      const m = createCard(CARD_W, CARD_H, {});
      m.rotation.x = Math.PI / 2; // 裏面を上へ
      m.position.y = 0.02 + i * 0.012;
      m.userData.pickId = "stock";
      stockGroup.add(m);
      stockLayers.push(m);
    }

    const cardsGroup = new THREE.Group();
    scene.add(cardsGroup);
    rtRef.current = { cardsGroup, entries: new Map(), stockLayers, stockGroup };

    detach = attachPickPointer(
      stage,
      () => [cardsGroup, stockGroup],
      {
        onTap: (hit) => {
          const id = findPickId(hit?.object ?? null);
          const p = propsRef.current;
          if (!id) return;
          if (id === "stock") {
            if (p.state.stock.length > 0 && p.state.status === "playing") p.onFlip();
            return;
          }
          const m = /^card-(\d+)-(\d+)$/.exec(id);
          if (!m) return;
          const col = Number(m[1]);
          const index = Number(m[2]);
          const pile = p.state.columns[col];
          // 2D でボタンが有効なのは「列の一番下 かつ 取れる」場合だけ。同じ条件でのみ呼ぶ。
          if (pile && index === pile.length - 1 && p.playable.includes(col)) p.onTake(col);
        },
      },
    );
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 盤面の差分同期（スロット=列×位置・台札）。カードが移るときは移動元の
  // 最終位置から滑らかに飛ぶ（山札→台札、列→台札）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const now = performance.now();

    rt.stockLayers.forEach((m, i) => {
      m.visible = state.stock.length > 0 && i < Math.max(1, Math.ceil(state.stock.length / 3));
    });
    rt.stockGroup.userData.pickId = "stock";

    const desired = new Map<string, { card: GolfCard; pos: THREE.Vector3; pickId: string; playableTop: boolean }>();
    const wasteTop = state.waste[state.waste.length - 1];
    if (wasteTop) {
      desired.set("waste", { card: wasteTop, pos: WASTE_POS.clone(), pickId: "waste", playableTop: false });
    }
    state.columns.forEach((pile, col) => {
      pile.forEach((card, index) => {
        const isTop = index === pile.length - 1;
        desired.set(`c${col}-${index}`, {
          card,
          pos: new THREE.Vector3(colX(col), isTop && playable.includes(col) ? 0.2 : 0.05, TAB_Z0 + index * ROW_STEP),
          pickId: `card-${col}-${index}`,
          playableTop: isTop && playable.includes(col),
        });
      });
    });

    const lastPosByCard = new Map<string, THREE.Vector3>();
    for (const [slot, e] of [...rt.entries]) {
      const d = desired.get(slot);
      if (!d || d.card.id !== e.cardKey) {
        lastPosByCard.set(e.cardKey, e.group.position.clone());
        rt.cardsGroup.remove(e.group);
        rt.entries.delete(slot);
      }
    }

    for (const [slot, d] of desired) {
      const entry = rt.entries.get(slot);
      if (!entry) {
        const group = new THREE.Group();
        const from = lastPosByCard.get(d.card.id) ?? STOCK_POS;
        group.position.copy(from);
        const mesh = makeCardMesh(d.card);
        mesh.rotation.x = FACE_UP;
        mesh.userData.pickId = d.pickId;
        group.add(mesh);
        const highlight = new THREE.Mesh(
          new THREE.BoxGeometry(CARD_W + 0.1, 0.02, CARD_H + 0.1),
          new THREE.MeshBasicMaterial({ color: 0xf2b33d, transparent: true, opacity: 0.7 }),
        );
        highlight.position.y = -0.02;
        highlight.visible = d.playableTop;
        highlight.userData.pickId = d.pickId;
        group.add(highlight);
        group.userData.pickId = d.pickId;
        rt.cardsGroup.add(group);
        const dist = group.position.distanceTo(d.pos);
        rt.entries.set(slot, {
          cardKey: d.card.id,
          group,
          highlight,
          anim: { start: now, dur: 340, fromPos: group.position.clone(), toPos: d.pos.clone(), arc: Math.min(0.45, dist * 0.3) },
        });
        continue;
      }
      entry.highlight.visible = d.playableTop;
      if (entry.group.position.distanceTo(d.pos) > 0.01 && !entry.anim) {
        entry.anim = { start: now, dur: 280, fromPos: entry.group.position.clone(), toPos: d.pos.clone(), arc: 0.05 };
      }
    }
  }, [state, playable]);

  return (
    <SceneBox
      height={520}
      label="ゴルフソリティア（3D）。光っているカードをタップで台札へ取り、山札をタップでめくります"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#14231c"
    />
  );
}
