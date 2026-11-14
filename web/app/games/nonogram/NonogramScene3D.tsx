"use client";
// ノノグラムの 3D 盤。対象は盤面マスだけで、行・列のヒント数字は盤外の
// 情報として親クライアントの DOM 併記（2D フォールバックと同じ数字列）が
// 担保する（このシーンにはヒントを描かない）。
// マスの造形:
//   塗り = 盛り上がった濃色立方体（完成時は青）／間違い塗りは赤
//   ×印 = 薄い平板＋細い2本の斜めバー
//   空   = 薄い平板
// 入力は現行クライアントの操作語彙どおり:
//   押下（タップ／ドラッグ開始）= onPaintStart（現行 startPaint）
//   ドラッグ中の移動 = onPaintContinue（現行 continuePaint、planePoint→セル変換）
// 印の決定・完成判定はすべて lib/nonogram.ts と親ハンドラが決め、
// ここは表現と入力の橋渡しだけを行う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { NonoMark } from "@/lib/nonogram";

interface Props {
  marks: NonoMark[];
  solution: boolean[];
  errors: number[];
  size: number;
  won: boolean;
  /** 押下＝塗り開始（現行の startPaint）。 */
  onPaintStart: (index: number) => void;
  /** ドラッグ継続（現行の continuePaint）。 */
  onPaintContinue: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;

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

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, size: number) {
  const w = container.clientWidth || 520;
  const h = container.clientHeight || 480;
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

/** 盤の土台（上面に格子線と5マスごとの太線を描く。現行 2D の罫線と同じ考え方）。 */
function createBase(size: number): THREE.Mesh {
  const px = 512;
  const topTex = canvasTexture(`nono-base-${size}`, px, px, (g) => {
    g.fillStyle = "#f7f2e2";
    g.fillRect(0, 0, px, px);
    const step = px / size;
    for (let i = 0; i <= size; i++) {
      const major = i % 5 === 0 || i === size;
      g.strokeStyle = major ? "#8a7f6d" : "#d8d2c4";
      g.lineWidth = major ? 3 : 1.2;
      g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step, px); g.stroke();
      g.beginPath(); g.moveTo(0, i * step); g.lineTo(px, i * step); g.stroke();
    }
  });
  const side = new THREE.MeshStandardMaterial({ color: 0x9a8f78, roughness: 0.85 });
  const top = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.85 });
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(size * PITCH + 0.35, 0.3, size * PITCH + 0.35),
    [side, side, top, side, side, side],
  );
  base.position.y = -0.16;
  base.userData.isBase = true;
  return base;
}

/** ×印の造形（平板＋細い斜めバー2本）。 */
function createCrossCell(): THREE.Group {
  const grp = new THREE.Group();
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(0.92, 0.1, 0.92),
    new THREE.MeshStandardMaterial({ color: 0xfffdf6, roughness: 0.7 }),
  );
  plate.position.y = 0.05;
  grp.add(plate);
  const barMat = new THREE.MeshStandardMaterial({ color: 0x8a7f6d, roughness: 0.55 });
  const barGeo = new THREE.BoxGeometry(1.05, 0.07, 0.13);
  for (const rot of [Math.PI / 4, -Math.PI / 4]) {
    const bar = new THREE.Mesh(barGeo, barMat);
    bar.rotation.y = rot;
    bar.position.y = 0.14;
    grp.add(bar);
  }
  return grp;
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
}

export default function NonogramScene3D({
  marks, solution, errors, size, won, onPaintStart, onPaintContinue, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onPaintStart, onPaintContinue, size });
  propsRef.current = { onPaintStart, onPaintContinue, size };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x4a4238,
      camera: { position: [0, 9, 6.5], lookAt: [0, 0, 0.2], fov: 42 },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    const tilesGroup = new THREE.Group();
    scene.add(tilesGroup);
    rtRef.current = { stage, tilesGroup, hits: [], hitSize: 0, cellsRt: new Map() };

    const startFromHit = (hit: THREE.Intersection | null) => {
      const id = hit?.object.userData.pickId as string | undefined;
      if (id) propsRef.current.onPaintStart(Number(id.slice(5)));
    };
    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      // タップもドラッグ開始も「塗り始め」は同じ現行ハンドラへ渡す
      // （attachPickPointer はタップとドラッグ開始を排他的に発火する）。
      onTap: startFromHit,
      onDragStart: startFromHit,
      onDragMove: (point) => {
        const index = pointToIndex(point, propsRef.current.size);
        if (index !== null) propsRef.current.onPaintContinue(index);
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
      tilesGroup.add(createBase(size));
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

    const errorSet = new Set(errors);
    marks.forEach((mark, i) => {
      const filled = won ? solution[i] : mark === 1;
      const isError = errorSet.has(i) && !won;
      const sig = `${mark}|${filled ? 1 : 0}|${isError ? 1 : 0}|${won ? 1 : 0}`;
      const cur = rt.cellsRt.get(i);
      if (cur && cur.sig === sig) return;
      if (cur) tilesGroup.remove(cur.grp);
      const grp = new THREE.Group();
      const [x, z] = cellPos(i, size);
      grp.position.set(x, 0, z);
      if (filled) {
        // 塗り: 盛り上がった濃色立方体（間違いは赤、完成時は青）。
        const cube = new THREE.Mesh(
          new THREE.BoxGeometry(0.92, 0.5, 0.92),
          new THREE.MeshStandardMaterial({
            color: isError ? 0xe5484d : won ? 0x2f6db3 : 0x33415c,
            roughness: 0.55,
          }),
        );
        cube.position.y = 0.25;
        grp.add(cube);
      } else if (mark === 2) {
        grp.add(createCrossCell());
      } else {
        const plate = new THREE.Mesh(
          new THREE.BoxGeometry(0.92, 0.1, 0.92),
          new THREE.MeshStandardMaterial({ color: 0xfffdf6, roughness: 0.7 }),
        );
        plate.position.y = 0.05;
        grp.add(plate);
      }
      tilesGroup.add(grp);
      rt.cellsRt.set(i, { sig, grp });
    });
  }, [marks, solution, errors, size, won]);

  const height = size === 15 ? 520 : 460;
  return (
    <SceneBox
      height={height}
      label="ノノグラムの盤（3D）。マスを押して塗り、なぞると連続で塗れます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#4a4238"
    />
  );
}
