"use client";
// しかくの 3D 盤。確定済み長方形は数字ごとの色タイル面＋境界バーで表し、
// 数字はマス上面のプレートに大きく描く。始点（アンカー）は赤い枠で示す。
// 現行 2D の操作は「タップで始点を決め、もう一度タップした角までを
// 長方形にする」2タップ方式で、3D でもタップはそのまま現行 onCell へ渡す。
// それに加えて 3D ではドラッグでも矩形を描ける:
//   onDragStart = 開始セルを記録しプレビューを出す
//   onDragMove  = planePoint→セル変換でプレビュー矩形（半透明）を更新
//   onDragEnd   = 確定を親の onDragRect へ渡す（適用は lib/shikaku.ts の
//                 applyShikakuRect で、親ハンドラが onCell の2タップ目と
//                 同じ経路で行う）
// 長方形の合法判定・完成判定はすべて lib と親が決め、ここは表現と
// 入力の橋渡しだけを行う。なお現行 2D の「下スワイプ＝チェック」は
// ドラッグ矩形と競合するため 3D では割り当てず、2D フォールバック側に残す。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { ShikakuRect } from "@/lib/shikaku";

interface Props {
  clues: (number | null)[];
  rects: ShikakuRect[];
  size: number;
  anchor: number | null;
  violationCells: number[];
  status: "playing" | "won";
  /** タップ（現行の2タップ方式 onCell へ接続）。 */
  onCell: (index: number) => void;
  /** ドラッグ確定（親のドラッグ用ハンドラへ接続。適用は applyShikakuRect）。 */
  onDragRect: (startIndex: number, endIndex: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;
/** 現行 2D の RECT_COLORS と同じ順序の色（3D では半透明タイルで重ねる）。 */
const RECT_HEX = [0xe2534a, 0x43a35c, 0x3366cc, 0xf2b01e, 0x9333ea, 0x0891b2, 0xdb2777, 0x5a8c28, 0xe67828, 0x3c6ec8];

function cellPos(index: number, size: number): [number, number] {
  const r = Math.floor(index / size);
  const c = index % size;
  return [(c - (size - 1) / 2) * PITCH, (r - (size - 1) / 2) * PITCH];
}

/** planePoint（盤面平面 y=0）からセル index を引く。盤外は null。 */
function pointToIndex(point: THREE.Vector3, size: number): number | null {
  const c = Math.round(point.x / PITCH + (size - 1) / 2);
  const r = Math.round(point.z / PITCH + (size - 1) / 2);
  if (r < 0 || c < 0 || r >= size || c >= size) return null;
  return r * size + c;
}

function indexFromHit(hit: THREE.Intersection | null): number | null {
  const id = hit?.object.userData.pickId as string | undefined;
  return id ? Number(id.slice(5)) : null;
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, size: number) {
  const w = container.clientWidth || 460;
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

/** 数字プレート（マス上面中央に置く、数字は大きく）。 */
function createCluePlate(value: number): THREE.Mesh {
  const topTex = canvasTexture(`sk-clue-${value}`, 128, 128, (g) => {
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#252525";
    g.font = "bold 84px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(value), 64, 68);
  });
  const side = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.6 });
  const top = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.55 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.08, 0.58), [side, side, top, side, side, side]);
  mesh.position.y = 0.28;
  return mesh;
}

/** マスの縁に置く境界バー（長方形の外周だけに付ける）。 */
function createEdgeBar(horizontal: boolean): THREE.Mesh {
  const geo = horizontal
    ? new THREE.BoxGeometry(0.98, 0.3, 0.07)
    : new THREE.BoxGeometry(0.07, 0.3, 0.98);
  const bar = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.5 }));
  bar.position.y = 0.15;
  return bar;
}

interface CellRt {
  sig: string;
  grp: THREE.Group;
}

interface SceneRt {
  stage: Stage;
  tilesGroup: THREE.Group;
  hits: THREE.Mesh[];
  hitSize: number;
  cellsRt: Map<number, CellRt>;
  preview: THREE.Mesh;
}

export default function ShikakuScene3D({
  clues, rects, size, anchor, violationCells, status, onCell, onDragRect, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onCell, onDragRect, size });
  propsRef.current = { onCell, onDragRect, size };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x3a4149,
      camera: { position: [0, 7.5, 5.2], lookAt: [0, 0, 0.2], fov: 42 },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    const tilesGroup = new THREE.Group();
    scene.add(tilesGroup);
    // ドラッグ中のプレビュー矩形（半透明）。単位立方体を拡縮して使う。
    const preview = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xe2534a, roughness: 0.5, transparent: true, opacity: 0.38 }),
    );
    preview.visible = false;
    scene.add(preview);
    rtRef.current = { stage, tilesGroup, hits: [], hitSize: 0, cellsRt: new Map(), preview };

    const showPreview = (startIndex: number, endIndex: number) => {
      const rt = rtRef.current;
      if (!rt) return;
      const n = propsRef.current.size;
      const r1 = Math.min(Math.floor(startIndex / n), Math.floor(endIndex / n));
      const r2 = Math.max(Math.floor(startIndex / n), Math.floor(endIndex / n));
      const c1 = Math.min(startIndex % n, endIndex % n);
      const c2 = Math.max(startIndex % n, endIndex % n);
      const [x1, z1] = cellPos(r1 * n + c1, n);
      const [x2, z2] = cellPos(r2 * n + c2, n);
      rt.preview.scale.set((c2 - c1 + 1) * PITCH - 0.05, 0.34, (r2 - r1 + 1) * PITCH - 0.05);
      rt.preview.position.set((x1 + x2) / 2, 0.17, (z1 + z2) / 2);
      rt.preview.visible = true;
    };
    const hidePreview = () => {
      if (rtRef.current) rtRef.current.preview.visible = false;
    };

    let dragStart: number | null = null;
    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        const index = indexFromHit(hit);
        if (index !== null) propsRef.current.onCell(index);
      },
      onDragStart: (hit) => {
        dragStart = indexFromHit(hit);
        if (dragStart !== null) showPreview(dragStart, dragStart);
      },
      onDragMove: (point) => {
        if (dragStart === null) return;
        const index = pointToIndex(point, propsRef.current.size);
        if (index !== null) showPreview(dragStart, index);
      },
      onDragEnd: (_flick, hit) => {
        if (dragStart === null) return;
        const end = indexFromHit(hit);
        hidePreview();
        if (end !== null) propsRef.current.onDragRect(dragStart, end);
        dragStart = null;
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

  // 盤面同期: サイズが変わったら土台と当たり判定を作り直し、マスは差分だけ作り直す。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, tilesGroup } = rt;
    if (rt.hitSize !== size) {
      rt.hitSize = size;
      for (const child of [...tilesGroup.children]) {
        if (child.userData.isBase) tilesGroup.remove(child);
      }
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(size * PITCH + 0.35, 0.3, size * PITCH + 0.35),
        new THREE.MeshStandardMaterial({ color: 0x8b95a1, roughness: 0.85 }),
      );
      base.position.y = -0.16;
      base.userData.isBase = true;
      tilesGroup.add(base);
      for (const [, c] of rt.cellsRt) tilesGroup.remove(c.grp);
      rt.cellsRt.clear();
      for (const h of rt.hits) tilesGroup.remove(h);
      rt.hits = [];
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
      for (let i = 0; i < size * size; i++) {
        const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        const [x, z] = cellPos(i, size);
        h.position.set(x, 0.3, z);
        h.userData.pickId = `cell-${i}`;
        tilesGroup.add(h);
        rt.hits.push(h);
      }
      const container = containerRef.current;
      if (container) fitCamera(stage, container, size);
    }

    const badSet = new Set(violationCells);
    for (let i = 0; i < size * size; i++) {
      const r = Math.floor(i / size);
      const c = i % size;
      const ri = rects.findIndex((rect) => r >= rect.r1 && r <= rect.r2 && c >= rect.c1 && c <= rect.c2);
      const rect = ri >= 0 ? rects[ri] : null;
      const clue = clues[i];
      const isAnchor = anchor === i;
      const bad = badSet.has(i);
      const sig = `${ri}|${clue ?? "-"}|${isAnchor ? 1 : 0}|${bad ? 1 : 0}|${status}`;
      const cur = rt.cellsRt.get(i);
      if (cur && cur.sig === sig) continue;
      if (cur) tilesGroup.remove(cur.grp);
      const grp = new THREE.Group();
      const [x, z] = cellPos(i, size);
      grp.position.set(x, 0, z);
      const tileMat = bad
        ? new THREE.MeshStandardMaterial({ color: 0xe2534a, roughness: 0.6, transparent: true, opacity: 0.75 })
        : rect
          ? new THREE.MeshStandardMaterial({ color: RECT_HEX[ri % RECT_HEX.length], roughness: 0.6, transparent: true, opacity: 0.55 })
          : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
      const tile = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.22, 0.92), tileMat);
      tile.position.y = 0.11;
      grp.add(tile);
      if (rect) {
        // 長方形の外周にだけ境界バーを付ける（現行 2D の太枠と同じ情報）。
        if (r === rect.r1) { const b = createEdgeBar(true); b.position.z = -0.46; grp.add(b); }
        if (r === rect.r2) { const b = createEdgeBar(true); b.position.z = 0.46; grp.add(b); }
        if (c === rect.c1) { const b = createEdgeBar(false); b.position.x = -0.46; grp.add(b); }
        if (c === rect.c2) { const b = createEdgeBar(false); b.position.x = 0.46; grp.add(b); }
      }
      if (clue !== null) grp.add(createCluePlate(clue));
      if (isAnchor) {
        const frame = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(0.99, 0.34, 0.99)),
          new THREE.LineBasicMaterial({ color: 0xe2534a }),
        );
        frame.position.y = 0.17;
        grp.add(frame);
      }
      tilesGroup.add(grp);
      rt.cellsRt.set(i, { sig, grp });
    }
  }, [clues, rects, size, anchor, violationCells, status]);

  return (
    <SceneBox
      height={size === 5 ? 400 : 440}
      label="しかくの盤（3D）。タップ2回、またはドラッグで長方形を描きます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#3a4149"
    />
  );
}
