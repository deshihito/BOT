"use client";
// ナンバーリンクの 3D 盤。端点 = ペア色の円盤＋上面に数字を大きく描いた造形、
// 経路 = 端点色の盛り上がったタイル列で表す。
// 操作は現行どおりドラッグで線を引く方式:
//   onDragStart のヒットセル → 親の beginStroke（端点/既存線からのみ開始）
//   onDragMove の planePoint → セル変換して親の extendStroke へ逐次渡す
//     （直線区間の中間マス補完・巻き戻し・他線の切断は親と lib が処理する）
//   onDragEnd → 親の endStroke
//   タップ（移動なし）は beginStroke + endStroke で現行の pointerdown 相当にする。
// 線の引き直し可否・完成判定はすべて lib/numberlink.ts と親ハンドラが決め、
// ここは表現と入力の橋渡しだけを行う。状態は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import {
  isPairConnected,
  ownerOf,
  type NumberlinkState,
} from "@/lib/numberlink";

interface Props {
  state: NumberlinkState;
  /** ストローク開始（現行の beginStroke）。 */
  onStrokeStart: (cell: number) => void;
  /** ストローク延長（現行の extendStroke）。セルが変わるたびに呼ばれる。 */
  onStrokeMove: (cell: number) => void;
  /** ストローク終了（現行の endStroke）。 */
  onStrokeEnd: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;
/** 現行 2D のペア色（NumberLinkClient の PAIR_COLORS と同じ並び）。 */
const PAIR_COLORS = [
  "#e05252",
  "#3f7fbf",
  "#46a758",
  "#e09f3e",
  "#8b5cf6",
  "#ec6fa5",
  "#2aa7a0",
  "#b0722f",
  "#64748b",
  "#84cc16",
];

function pairColor(pair: number): string {
  return PAIR_COLORS[(pair - 1) % PAIR_COLORS.length];
}

function cellPos(index: number, size: number): [number, number] {
  const r = Math.floor(index / size);
  const c = index % size;
  return [(c - (size - 1) / 2) * PITCH, (r - (size - 1) / 2) * PITCH];
}

/** planePoint（y 平面上の点）→ セル index。盤外は null。 */
function cellFromPoint(point: THREE.Vector3, size: number): number | null {
  const c = Math.round(point.x / PITCH + (size - 1) / 2);
  const r = Math.round(point.z / PITCH + (size - 1) / 2);
  if (r < 0 || c < 0 || r >= size || c >= size) return null;
  return r * size + c;
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, size: number) {
  const w = container.clientWidth || 640;
  const h = container.clientHeight || 420;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (size / 2 + 0.9) / Math.tan(hFov / 2);
  const distD = ((size / 2 + 0.9) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.4;
  stage.setCamera({
    position: [0, dist * 0.82, dist * 0.58],
    lookAt: [0, 0, 0.2],
    fov: 42,
  });
}

/** 端点の円盤（上面いっぱいにペア番号を大きく描く）。 */
function createEndpoint(pair: number, connected: boolean): THREE.Group {
  const grp = new THREE.Group();
  const color = pairColor(pair);
  const topTex = canvasTexture(`numberlink-end-${pair}`, 128, 128, (g) => {
    g.fillStyle = color;
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#ffffff";
    g.font = "bold 84px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(pair), 64, 68);
  });
  const side = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color).multiplyScalar(0.75),
    roughness: 0.5,
  });
  const top = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.45 });
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.4, 0.3, 28), [side, top, side]);
  cyl.position.y = 0.2;
  grp.add(cyl);
  if (connected) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.44, 0.04, 10, 32),
      new THREE.MeshStandardMaterial({ color: 0xd4a017, roughness: 0.35, metalness: 0.4 }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.1;
    grp.add(ring);
  }
  return grp;
}

interface CellRt {
  sig: string;
  grp: THREE.Group;
}

interface SceneRt {
  stage: Stage;
  group: THREE.Group;
  hits: THREE.Mesh[];
  hitSize: number;
  cellsRt: Map<number, CellRt>;
}

export default function NumberLinkScene3D({
  state, onStrokeStart, onStrokeMove, onStrokeEnd, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onStrokeStart, onStrokeMove, onStrokeEnd, size: state.size });
  propsRef.current = { onStrokeStart, onStrokeMove, onStrokeEnd, size: state.size };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x37424e,
      camera: { position: [0, 9, 6.5], lookAt: [0, 0, 0.2], fov: 42 },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const group = new THREE.Group();
    stage.scene.add(group);
    rtRef.current = { stage, group, hits: [], hitSize: 0, cellsRt: new Map() };

    const hitCell = (hit: THREE.Intersection | null): number | null => {
      const id = hit?.object.userData.pickId as string | undefined;
      return id ? Number(id.slice(5)) : null;
    };
    detach = attachPickPointer(
      stage,
      () => rtRef.current?.hits ?? [],
      {
        onTap: (hit) => {
          const cell = hitCell(hit);
          if (cell === null) return;
          propsRef.current.onStrokeStart(cell);
          propsRef.current.onStrokeEnd();
        },
        onDragStart: (hit) => {
          const cell = hitCell(hit);
          if (cell === null) return;
          propsRef.current.onStrokeStart(cell);
        },
        onDragMove: (point) => {
          const cell = cellFromPoint(point, propsRef.current.size);
          if (cell === null) return;
          propsRef.current.onStrokeMove(cell);
        },
        onDragEnd: () => {
          propsRef.current.onStrokeEnd();
        },
      },
      { planeY: 0.15 },
    );
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 盤面同期: サイズが変わったら土台と当たり判定を作り直し、マスは差分だけ作り直す。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, group } = rt;
    const size = state.size;
    if (rt.hitSize !== size) {
      rt.hitSize = size;
      for (const child of [...group.children]) {
        if (child.userData.isBase) group.remove(child);
      }
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(size * PITCH + 0.35, 0.3, size * PITCH + 0.35),
        new THREE.MeshStandardMaterial({ color: 0x71808e, roughness: 0.85 }),
      );
      base.position.y = -0.16;
      base.userData.isBase = true;
      group.add(base);
      for (const [, c] of rt.cellsRt) group.remove(c.grp);
      rt.cellsRt.clear();
      for (const h of rt.hits) group.remove(h);
      rt.hits = [];
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
      for (let i = 0; i < size * size; i++) {
        const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        const [x, z] = cellPos(i, size);
        h.position.set(x, 0.3, z);
        h.userData.pickId = `cell-${i}`;
        group.add(h);
        rt.hits.push(h);
      }
      const container = containerRef.current;
      if (container) fitCamera(stage, container, size);
    }

    const owner = ownerOf(state);
    const connectedPairs = new Set<number>();
    for (let pair = 1; pair <= state.pairCount; pair++) {
      if (isPairConnected(state, pair)) connectedPairs.add(pair);
    }
    for (let i = 0; i < size * size; i++) {
      const endpoint = state.endpoints[i];
      const own = owner[i];
      const sig = `${endpoint ?? 0}|${own}|${endpoint !== null && connectedPairs.has(endpoint) ? 1 : 0}`;
      const cur = rt.cellsRt.get(i);
      if (cur && cur.sig === sig) continue;
      if (cur) group.remove(cur.grp);
      const grp = new THREE.Group();
      const [x, z] = cellPos(i, size);
      grp.position.set(x, 0, z);
      // 土台タイル: 線が通るマスは端点色の薄い面にする（現行 2D の薄色表現）。
      const plateColor =
        own > 0
          ? new THREE.Color(pairColor(own)).lerp(new THREE.Color(0xffffff), 0.62)
          : new THREE.Color(0xf4f6f8);
      const plate = new THREE.Mesh(
        new THREE.BoxGeometry(0.92, 0.1, 0.92),
        new THREE.MeshStandardMaterial({ color: plateColor, roughness: 0.7 }),
      );
      plate.position.y = 0.05;
      grp.add(plate);
      if (endpoint !== null) {
        grp.add(createEndpoint(endpoint, connectedPairs.has(endpoint)));
      } else if (own > 0) {
        // 経路: 端点色の盛り上がったタイル。
        const raised = new THREE.Mesh(
          new THREE.BoxGeometry(0.78, 0.22, 0.78),
          new THREE.MeshStandardMaterial({ color: pairColor(own), roughness: 0.5 }),
        );
        raised.position.y = 0.2;
        grp.add(raised);
      }
      group.add(grp);
      rt.cellsRt.set(i, { sig, grp });
    }
  }, [state]);

  return (
    <SceneBox
      height={440}
      label="ナンバーリンクの盤（3D）。数字のマスからドラッグして線を引きます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#37424e"
    />
  );
}
