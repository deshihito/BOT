"use client";
// ブロックスパズルの 3D 盤。盤上のセルとドラッグ中のピースを立体ブロックで表す。
// 現行の主操作は「下のブロックを選んで盤をタップして配置」（回転なし）で、
// 3D でもそれを正とする:
//   盤タップ = そのマスへ配置（親の onCellClick、合法判定は lib/blockpuzzle.ts）
//   ホバー = 配置ゴーストの表示位置（親が canPlacePiece で計算）
//   ドラッグ = ゴーストを planePoint で追従させ、離したマスへ配置する。
//     ドラッグ中はゴーストのブロック集合が浮き上がり、置ける位置では
//     ピース色、置けない位置では赤で示す（現行 2D のゴースト色分けと同じ）。
// スコア等の状態は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import { BP_SIZE } from "@/lib/blockpuzzle";

interface Props {
  /** 81 マス（null は空、数値は色 index）。 */
  board: (number | null)[];
  /** 選択中ピースが hover 位置で覆うマス集合（親が計算）。 */
  ghost: Set<number>;
  /** ゴースト位置に置けるか（canPlacePiece の結果）。 */
  ghostOk: boolean;
  /** 選択中ピースの色 index。未選択なら null。 */
  ghostColor: number | null;
  onCell: (r: number, c: number) => void;
  onHover: (cell: { r: number; c: number } | null) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;
/** 現行 2D の CELL_COLORS と同じ色表。 */
const CELL_COLORS = [0xe2534a, 0x3f8f4f, 0x3366cc, 0xe8a13a, 0x8a55c7];

function cellPos(index: number): [number, number] {
  const r = Math.floor(index / BP_SIZE);
  const c = index % BP_SIZE;
  return [(c - (BP_SIZE - 1) / 2) * PITCH, (r - (BP_SIZE - 1) / 2) * PITCH];
}

function pointToCell(point: THREE.Vector3): { r: number; c: number } | null {
  const c = Math.round(point.x / PITCH) + (BP_SIZE - 1) / 2;
  const r = Math.round(point.z / PITCH) + (BP_SIZE - 1) / 2;
  if (r < 0 || c < 0 || r >= BP_SIZE || c >= BP_SIZE) return null;
  return { r, c };
}

interface SceneRt {
  boardGroup: THREE.Group;
  ghostGroup: THREE.Group;
  hits: THREE.Mesh[];
  dragging: boolean;
}

export default function BlockPuzzleScene3D({
  board, ghost, ghostOk, ghostColor, onCell, onHover, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onCell, onHover });
  propsRef.current = { onCell, onHover };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x39434e,
      camera: { position: [0, 8.8, 5.8], lookAt: [0, 0, 0.5], fov: 40 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        // ドラッグ中はゴーストが浮き上がる（離すと元の高さへ戻る）。
        const targetY = rt.dragging ? 0.38 : 0;
        rt.ghostGroup.position.y += (targetY - rt.ghostGroup.position.y) * Math.min(1, dt * 14);
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // 土台（3x3 の区切りを上面テクスチャに描く。現行 2D の太い境界相当）。
    const topTex = canvasTexture("bp-board", 512, 512, (g) => {
      g.fillStyle = "#eef1f4";
      g.fillRect(0, 0, 512, 512);
      const step = 512 / BP_SIZE;
      g.strokeStyle = "#d4d9de";
      g.lineWidth = 1.5;
      for (let i = 0; i <= BP_SIZE; i++) {
        g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step, 512); g.stroke();
        g.beginPath(); g.moveTo(0, i * step); g.lineTo(512, i * step); g.stroke();
      }
      g.strokeStyle = "#9aa3ad";
      g.lineWidth = 4;
      for (let i = 0; i <= 3; i++) {
        g.beginPath(); g.moveTo(i * step * 3, 0); g.lineTo(i * step * 3, 512); g.stroke();
        g.beginPath(); g.moveTo(0, i * step * 3); g.lineTo(512, i * step * 3); g.stroke();
      }
    });
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(BP_SIZE * PITCH + 0.35, 0.3, BP_SIZE * PITCH + 0.35),
      [
        new THREE.MeshStandardMaterial({ color: 0x707c88, roughness: 0.85 }),
        new THREE.MeshStandardMaterial({ color: 0x707c88, roughness: 0.85 }),
        new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.8 }),
        new THREE.MeshStandardMaterial({ color: 0x59636e, roughness: 0.85 }),
        new THREE.MeshStandardMaterial({ color: 0x707c88, roughness: 0.85 }),
        new THREE.MeshStandardMaterial({ color: 0x707c88, roughness: 0.85 }),
      ],
    );
    base.position.y = -0.16;
    scene.add(base);

    const boardGroup = new THREE.Group();
    scene.add(boardGroup);
    const ghostGroup = new THREE.Group();
    scene.add(ghostGroup);

    const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
    const hits: THREE.Mesh[] = [];
    for (let i = 0; i < BP_SIZE * BP_SIZE; i++) {
      const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
      const [x, z] = cellPos(i);
      h.position.set(x, 0.3, z);
      h.userData.pickId = `cell-${i}`;
      scene.add(h);
      hits.push(h);
    }

    rtRef.current = { boardGroup, ghostGroup, hits, dragging: false };

    const pickCell = (hit: THREE.Intersection | null): { r: number; c: number } | null => {
      const id = hit?.object.userData.pickId as string | undefined;
      if (!id) return null;
      const index = Number(id.slice(5));
      return { r: Math.floor(index / BP_SIZE), c: index % BP_SIZE };
    };
    detach = attachPickPointer(stage, () => hits, {
      onTap: (hit) => {
        const cell = pickCell(hit);
        if (cell) propsRef.current.onCell(cell.r, cell.c);
      },
      onHover: (hit) => {
        propsRef.current.onHover(pickCell(hit));
      },
      onDragStart: () => {
        const rt = rtRef.current;
        if (rt) rt.dragging = true;
      },
      // ドラッグ中は平面上の点からマスを割り出し、ゴーストを追従させる。
      onDragMove: (point) => {
        const cell = pointToCell(point);
        if (cell) propsRef.current.onHover(cell);
      },
      onDragEnd: (_flick, hit) => {
        const rt = rtRef.current;
        if (rt) rt.dragging = false;
        const cell = pickCell(hit);
        if (cell) propsRef.current.onCell(cell.r, cell.c);
      },
    }, { planeY: 0.3, hover: true });
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 盤面同期: 埋まったマスは色つき立方体、空きマスは平板。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    for (const child of [...rt.boardGroup.children]) rt.boardGroup.remove(child);
    const cubeGeo = new THREE.BoxGeometry(0.92, 0.44, 0.92);
    const plateGeo = new THREE.BoxGeometry(0.92, 0.08, 0.92);
    const plateMat = new THREE.MeshStandardMaterial({ color: 0xeef1f4, roughness: 0.9 });
    board.forEach((cell, i) => {
      const [x, z] = cellPos(i);
      if (cell === null) {
        const plate = new THREE.Mesh(plateGeo, plateMat);
        plate.position.set(x, 0.04, z);
        rt.boardGroup.add(plate);
      } else {
        const cube = new THREE.Mesh(
          cubeGeo,
          new THREE.MeshStandardMaterial({ color: CELL_COLORS[cell] ?? 0xcccccc, roughness: 0.5 }),
        );
        cube.position.set(x, 0.22, z);
        rt.boardGroup.add(cube);
      }
    });
  }, [board]);

  // ゴースト同期: 置ける位置はピース色、置けない位置は赤（現行 2D と同じ）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    for (const child of [...rt.ghostGroup.children]) rt.ghostGroup.remove(child);
    if (ghost.size === 0) return;
    const color = ghostOk && ghostColor !== null ? CELL_COLORS[ghostColor] : 0xe2534a;
    const geo = new THREE.BoxGeometry(0.92, 0.44, 0.92);
    const mat = new THREE.MeshStandardMaterial({
      color, roughness: 0.5, transparent: true, opacity: 0.55,
    });
    for (const i of ghost) {
      const [x, z] = cellPos(i);
      const cube = new THREE.Mesh(geo, mat);
      cube.position.set(x, 0.22, z);
      rt.ghostGroup.add(cube);
    }
  }, [ghost, ghostOk, ghostColor]);

  return (
    <SceneBox
      height={440}
      label="ブロックスパズルの盤（3D）。マスをタップまたはドラッグしてブロックを置きます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#39434e"
    />
  );
}
