"use client";
// モンテカルロ（ソリティア）の 3D シーン。カード系の型の応用:
// 5x5 グリッドにカードを並べ、横に山札の束（裏向き）を置く。
// 選択中のカードは金縁フレーム＋持ち上げ、ペアにできるカードは緑縁で
// 示す（2D の枠色と同等）。タップは pickId 経由でクライアントの既存
// ハンドラ onCell へ接続し、盤面の下フリックは既存の「詰める」
// （montecarloConsolidate を呼ぶ consolidate）へ接続する。
// 詰め直しでカードがマスを移る際は、カードキーの最終位置を引き継ぐ
// 差分同期でスライドさせる。残り枚数などのテキストは親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createCard } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import { MC_COLS, type McCard } from "@/lib/montecarlo";

interface Props {
  board: (McCard | null)[];
  selected: number | null;
  /** ペアにできるマスの index 一覧（2D の緑枠と同等）。 */
  pairCells: number[];
  stockCount: number;
  playing: boolean;
  /** 既存ハンドラ: マスのタップ = 選択/ペア確定。 */
  onCellTap: (index: number) => void;
  /** 既存ハンドラ: 盤面の下スワイプ = 詰める。 */
  onConsolidate: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const CARD_W = 0.74;
const CARD_H = 1.0;
const FACE_UP = -Math.PI / 2;
const FACE_DOWN = Math.PI / 2;

const RANK_LABELS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUIT_GLYPHS = ["♠", "♥", "♦", "♣"];
const DECK_POS = new THREE.Vector3(2.9, 0.05, 1.9);

function cellPos(index: number): THREE.Vector3 {
  const row = Math.floor(index / MC_COLS);
  const col = index % MC_COLS;
  return new THREE.Vector3((col - (MC_COLS - 1) / 2) * 0.84, 0.05, (row - 2) * 1.06);
}

function makeCardMesh(card: McCard | null, pickId?: string): THREE.Mesh {
  const mesh = card === null
    ? createCard(CARD_W, CARD_H, {})
    : createCard(CARD_W, CARD_H, {
        label: `${RANK_LABELS[card.rank - 1]}${SUIT_GLYPHS[card.suit]}`,
        labelColor: card.suit === 1 || card.suit === 2 ? "#c62828" : "#1c2333",
      });
  if (pickId !== undefined) mesh.userData.pickId = pickId;
  return mesh;
}

function makeFrameMesh(): THREE.Mesh {
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(CARD_W + 0.1, CARD_H + 0.1, 0.018),
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
  /** マスを移ったカードの最終位置（詰め直しのスライド起点に使う）。 */
  lastPosByCard: Map<string, THREE.Vector3>;
}

export default function MonteCarloScene3D({
  board, selected, pairCells, stockCount, playing, onCellTap, onConsolidate, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);

  const propsRef = useRef({ board, selected, pairCells, stockCount, playing, onCellTap, onConsolidate });
  propsRef.current = { board, selected, pairCells, stockCount, playing, onCellTap, onConsolidate };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x14231c,
      camera: { position: [0, 7.6, 5.6], lookAt: [0, 0, 0.3], fov: 42 },
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
      new THREE.BoxGeometry(7.0, 0.14, 6.4),
      new THREE.MeshStandardMaterial({ color: 0x5b3a22, roughness: 0.6 }),
    );
    rim.position.y = -0.1;
    rim.userData.pickId = "table";
    scene.add(rim);
    const felt = new THREE.Mesh(
      new THREE.BoxGeometry(6.6, 0.16, 6.0),
      new THREE.MeshStandardMaterial({ color: 0x1e5c3a, roughness: 1 }),
    );
    felt.position.y = -0.04;
    felt.userData.pickId = "table";
    scene.add(felt);

    const cardsGroup = new THREE.Group();
    scene.add(cardsGroup);
    rtRef.current = { cardsGroup, entries: new Map(), lastPosByCard: new Map() };

    // 既存語彙どおり: 盤面の下フリック = 詰める。カードを掴んだまま離すと
    // onDragEnd 側に流れるため、両経路を同じハンドラへつなぐ。
    const handleSwipe = (dir: string | null) => {
      if (dir === "down") propsRef.current.onConsolidate();
    };
    detach = attachPickPointer(stage, () => [felt, rim, cardsGroup], {
      onTap: (hit) => {
        const pickId = hit?.object.userData.pickId as string | undefined;
        if (!pickId?.startsWith("cell-")) return;
        const index = Number(pickId.slice("cell-".length));
        if (Number.isInteger(index)) propsRef.current.onCellTap(index);
      },
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
  // 詰め直しでカードが別のマスへ移る場合は最終位置を引き継いでスライドし、
  // 山札から補充されたカードは山札位置からフライインする。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const now = performance.now();
    const pairSet = new Set(pairCells);
    const desired = new Map<string, {
      card: McCard | null;
      pos: THREE.Vector3;
      faceUp: boolean;
      dealOrder: number;
      pickId?: string;
      frameColor?: number;
      withFrame: boolean;
    }>();

    board.forEach((card, i) => {
      if (!card) return;
      const sel = selected === i;
      const base = cellPos(i);
      desired.set(`cell-${i}`, {
        card,
        pos: new THREE.Vector3(base.x, base.y + (sel ? 0.22 : 0), base.z),
        faceUp: true,
        dealOrder: i,
        pickId: `cell-${i}`,
        frameColor: sel ? 0xf2b33d : pairSet.has(i) ? 0x22c55e : 0x2b3442,
        withFrame: true,
      });
    });

    const deckLayers = Math.min(Math.max(stockCount, 0), 3);
    for (let i = 0; i < deckLayers; i++) {
      desired.set(`deck-${i}`, {
        card: null,
        pos: new THREE.Vector3(DECK_POS.x, DECK_POS.y + i * 0.035, DECK_POS.z),
        faceUp: false,
        dealOrder: i,
        withFrame: i === deckLayers - 1,
      });
    }

    for (const [slot, e] of [...rt.entries]) {
      const d = desired.get(slot);
      const key = !d ? null : d.card === null ? "back" : `id-${d.card.id}`;
      if (!d || key !== e.cardKey) {
        rt.lastPosByCard.set(e.cardKey, e.group.position.clone());
        rt.cardsGroup.remove(e.group);
        rt.entries.delete(slot);
      }
    }

    for (const [slot, d] of desired) {
      const cardKey = d.card === null ? "back" : `id-${d.card.id}`;
      const entry = rt.entries.get(slot);
      if (!entry) {
        const group = new THREE.Group();
        const last = rt.lastPosByCard.get(cardKey);
        group.position.copy(last ?? DECK_POS);
        const frame = d.withFrame ? makeFrameMesh() : null;
        if (frame) group.add(frame);
        const mesh = makeCardMesh(d.card, d.pickId);
        mesh.rotation.x = d.faceUp ? FACE_UP : FACE_DOWN;
        group.add(mesh);
        rt.cardsGroup.add(group);
        const dist = group.position.distanceTo(d.pos);
        rt.entries.set(slot, {
          cardKey,
          group,
          mesh,
          frame,
          anim: {
            start: now + Math.min(d.dealOrder, 12) * 40,
            dur: 380,
            fromPos: group.position.clone(),
            toPos: d.pos.clone(),
            arc: Math.min(0.4, dist * 0.25),
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
      if (entry.group.position.distanceTo(d.pos) > 0.01 && !entry.anim) {
        entry.anim = {
          start: now,
          dur: 300,
          fromPos: entry.group.position.clone(),
          toPos: d.pos.clone(),
          arc: 0.05,
        };
      }
    }
  }, [board, selected, pairCells, stockCount, playing]);

  return (
    <SceneBox
      height={460}
      label={`モンテカルロ（3D）。カードのタップで選び、盤面を下へスワイプすると詰める`}
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#14231c"
    />
  );
}
