"use client";
// ピラミッド（ソリティア）の 3D シーン。カード系の型の応用:
// 28枚を段差（奥行き z ＋ 高さ y）つきのピラミッド配置に置き、手前に
// ストック（裏向きの束）とウェイスト（捨て山の一番上）を置く。
// 露出カードは明るく、覆われているカードは減光してタップ対象から外す
// （2D の cellDisabled と同等）。選択中のカードは金縁フレーム＋持ち上げ。
// タップは pickId 経由でクライアントの既存ハンドラ（onTarget ラッパ）へ
// 接続するだけで、選択/ペア確定の判定はクライアント側が持つ。
// 残り枚数・手数などのテキストは親の DOM 併記が担い、3D 内には置かない。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createCard } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import {
  pyramidIsRed,
  pyramidRankLabel,
  pyramidSlotPos,
  pyramidSuitSymbol,
  type PyramidCard,
  type PyramidTarget,
} from "@/lib/pyramid";

interface Props {
  pyramid: (PyramidCard | null)[];
  /** 露出しているスロット index の一覧（lib の exposedSlots の結果）。 */
  exposed: number[];
  selected: PyramidTarget | null;
  stockCount: number;
  wasteTop: PyramidCard | null;
  wasteCount: number;
  /** ストックをめくれるか（2D の stockDisabled の反転）。 */
  canFlipStock: boolean;
  /** ピラミッドのカードタップ（露出判定はクライアント側ラッパが持つ）。 */
  onPyramidTap: (slot: number) => void;
  onWasteTap: () => void;
  onStockTap: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const CARD_W = 0.66;
const CARD_H = 0.92;
const FACE_UP = -Math.PI / 2;
const FACE_DOWN = Math.PI / 2;

const STOCK_POS = new THREE.Vector3(-0.85, 0.05, 2.6);
const WASTE_POS = new THREE.Vector3(0.25, 0.05, 2.6);

/** ピラミッド配置: 上段ほど奥（z 小）＋高い（y 大）段差で重ねる。 */
function pyramidPos(slot: number): THREE.Vector3 {
  const { row, col } = pyramidSlotPos(slot);
  return new THREE.Vector3(
    (col - row / 2) * 0.74,
    0.05 + (6 - row) * 0.055,
    -1.55 + row * 0.52,
  );
}

function makeCardMesh(card: PyramidCard | null, pickId?: string): THREE.Mesh {
  const mesh = card === null
    ? createCard(CARD_W, CARD_H, {})
    : createCard(CARD_W, CARD_H, {
        label: `${pyramidRankLabel(card.rank)}${pyramidSuitSymbol(card.suit)}`,
        labelColor: pyramidIsRed(card.suit) ? "#c62828" : "#1c2333",
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

function setCardDim(mesh: THREE.Mesh, dim: boolean) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) {
    const std = m as THREE.MeshStandardMaterial;
    std.transparent = dim;
    std.opacity = dim ? 0.5 : 1;
  }
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
  lastPosByCard: Map<string, THREE.Vector3>;
}

export default function PyramidScene3D({
  pyramid, exposed, selected, stockCount, wasteTop, wasteCount, canFlipStock,
  onPyramidTap, onWasteTap, onStockTap, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);

  const propsRef = useRef({ pyramid, exposed, selected, stockCount, wasteTop, wasteCount, canFlipStock, onPyramidTap, onWasteTap, onStockTap });
  propsRef.current = { pyramid, exposed, selected, stockCount, wasteTop, wasteCount, canFlipStock, onPyramidTap, onWasteTap, onStockTap };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x14231c,
      camera: { position: [0, 6.6, 6.4], lookAt: [0, 0, 0.3], fov: 44 },
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
      new THREE.BoxGeometry(8.6, 0.14, 6.6),
      new THREE.MeshStandardMaterial({ color: 0x5b3a22, roughness: 0.6 }),
    );
    rim.position.y = -0.1;
    rim.userData.pickId = "table";
    scene.add(rim);
    const felt = new THREE.Mesh(
      new THREE.BoxGeometry(8.2, 0.16, 6.2),
      new THREE.MeshStandardMaterial({ color: 0x1e5c3a, roughness: 1 }),
    );
    felt.position.y = -0.04;
    felt.userData.pickId = "table";
    scene.add(felt);

    const cardsGroup = new THREE.Group();
    scene.add(cardsGroup);
    rtRef.current = { cardsGroup, entries: new Map(), lastPosByCard: new Map() };

    detach = attachPickPointer(stage, () => [felt, rim, cardsGroup], {
      onTap: (hit) => {
        const pickId = hit?.object.userData.pickId as string | undefined;
        if (!pickId) return;
        if (pickId === "stock") propsRef.current.onStockTap();
        else if (pickId === "waste") propsRef.current.onWasteTap();
        else if (pickId.startsWith("pyramid-")) {
          const slot = Number(pickId.slice("pyramid-".length));
          if (Number.isInteger(slot)) propsRef.current.onPyramidTap(slot);
        }
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

  // 差分同期: スロットキー＋カードキーの Map で管理する。
  // 新規カードはストック位置からフライインし、消えたカードは除去する。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const now = performance.now();
    const exposedSet = new Set(exposed);
    const isSelected = (target: PyramidTarget) =>
      selected !== null &&
      selected.kind === target.kind &&
      (selected.kind === "waste" ||
        (target.kind === "pyramid" && selected.slot === target.slot));
    const desired = new Map<string, {
      card: PyramidCard | null;
      pos: THREE.Vector3;
      faceUp: boolean;
      dealOrder: number;
      pickId?: string;
      frameColor?: number;
      dim: boolean;
      withFrame: boolean;
    }>();

    pyramid.forEach((card, slot) => {
      if (!card) return;
      const isExp = exposedSet.has(slot);
      const sel = isSelected({ kind: "pyramid", slot });
      const base = pyramidPos(slot);
      desired.set(`p${slot}`, {
        card,
        pos: new THREE.Vector3(base.x, base.y + (sel ? 0.22 : 0), base.z),
        faceUp: true,
        dealOrder: slot,
        // 覆われているカードはタップ対象外（2D の cellDisabled と同等）。
        pickId: isExp ? `pyramid-${slot}` : undefined,
        frameColor: sel ? 0xf2b33d : 0x2b3442,
        dim: !isExp,
        withFrame: true,
      });
    });

    // ストック（裏向きの束）。尽きた場合は再利用可能なときだけ裏向き1枚を置く。
    if (stockCount > 0) {
      const layers = Math.min(stockCount, 3);
      for (let i = 0; i < layers; i++) {
        desired.set(`stock-${i}`, {
          card: null,
          pos: new THREE.Vector3(STOCK_POS.x, STOCK_POS.y + i * 0.035, STOCK_POS.z),
          faceUp: false,
          dealOrder: i,
          pickId: i === layers - 1 ? "stock" : undefined,
          dim: false,
          withFrame: i === layers - 1,
        });
      }
    } else if (wasteCount > 0 && canFlipStock) {
      desired.set("stock-0", {
        card: null,
        pos: STOCK_POS.clone(),
        faceUp: false,
        dealOrder: 0,
        pickId: "stock",
        dim: true,
        withFrame: true,
      });
    }

    if (wasteTop) {
      const sel = isSelected({ kind: "waste" });
      desired.set("waste", {
        card: wasteTop,
        pos: new THREE.Vector3(WASTE_POS.x, WASTE_POS.y + (sel ? 0.22 : 0), WASTE_POS.z),
        faceUp: true,
        dealOrder: 0,
        pickId: "waste",
        frameColor: sel ? 0xf2b33d : 0x2b3442,
        dim: false,
        withFrame: true,
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
        group.position.copy(last ?? STOCK_POS);
        const frame = d.withFrame ? makeFrameMesh() : null;
        if (frame) group.add(frame);
        const mesh = makeCardMesh(d.card, d.pickId);
        mesh.rotation.x = d.faceUp ? FACE_UP : FACE_DOWN;
        setCardDim(mesh, d.dim);
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
      if (d.pickId !== undefined) entry.mesh.userData.pickId = d.pickId;
      else delete entry.mesh.userData.pickId;
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
  }, [pyramid, exposed, selected, stockCount, wasteTop, wasteCount, canFlipStock]);

  return (
    <SceneBox
      height={460}
      label={`ピラミッド（3D）。露出しているカードと捨て山のタップで選び、ストックのタップでめくる`}
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#14231c"
    />
  );
}
