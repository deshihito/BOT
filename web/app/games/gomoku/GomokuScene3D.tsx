"use client";
// 五目並べの 3D 盤。木目調の盤に碁石を置く。タップ位置から最寄りの
// 交点を割り出して着手する（盤面タップ→交点、既存のマスタップと等価）。
// 着手可否はサーバー側の view が決め、ここは表現と入力の橋渡しだけを行う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 盤に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createStone, canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

interface Props {
  cells: number[];
  winCells: number[];
  lastMove: number | null;
  myTurn: boolean;
  onPlace: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const SIZE = 15;
const PITCH = 0.6;
const BLACK = 0x17181a;
const WHITE = 0xf2f0e8;

function stonePos(index: number): [number, number] {
  return [((index % SIZE) - 7) * PITCH, (Math.floor(index / SIZE) - 7) * PITCH];
}

export default function GomokuScene3D({ cells, winCells, lastMove, myTurn, onPlace, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<{
    stones: Map<number, { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial }>;
    marker: THREE.Mesh;
    scene: THREE.Scene;
  } | null>(null);
  const propsRef = useRef({ cells, myTurn, onPlace });
  propsRef.current = { cells, myTurn, onPlace };
  const winCellsRef = useRef(winCells);
  winCellsRef.current = winCells;
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x8a6f45,
      camera: { position: [0, 8.6, 5.2], lookAt: [0, 0, 0.6], fov: 40 },
      onFrame: (_dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        const win = new Set(winCellsRef.current);
        for (const [i, s] of rt.stones) {
          if (win.has(i)) s.mat.emissive.setHSL(0.11, 0.85, 0.25 + 0.15 * Math.sin(t * 5));
          else s.mat.emissive.setRGB(0, 0, 0);
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    const topTex = canvasTexture("gomoku-board", 1024, 1024, (g) => {
      g.fillStyle = "#dcb87a";
      g.fillRect(0, 0, 1024, 1024);
      // 木目（薄い横縞）
      g.fillStyle = "rgba(160, 120, 60, 0.12)";
      for (let i = 0; i < 26; i++) g.fillRect(0, i * 40 + (i % 3) * 7, 1024, 9);
      const margin = 1024 * (0.7 / 9.8);
      const span = 1024 - margin * 2;
      const step = span / 14;
      g.strokeStyle = "rgba(60, 40, 16, 0.9)";
      g.lineWidth = 3;
      for (let i = 0; i < 15; i++) {
        g.beginPath(); g.moveTo(margin + i * step, margin); g.lineTo(margin + i * step, 1024 - margin); g.stroke();
        g.beginPath(); g.moveTo(margin, margin + i * step); g.lineTo(1024 - margin, margin + i * step); g.stroke();
      }
      g.fillStyle = "rgba(60, 40, 16, 0.95)";
      for (const r of [3, 7, 11]) {
        for (const c of [3, 7, 11]) {
          g.beginPath();
          g.arc(margin + c * step, margin + r * step, 9, 0, Math.PI * 2);
          g.fill();
        }
      }
    });
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(9.8, 0.35, 9.8),
      [
        new THREE.MeshStandardMaterial({ color: 0xa8824f, roughness: 0.8 }),
        new THREE.MeshStandardMaterial({ color: 0xa8824f, roughness: 0.8 }),
        new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.75 }),
        new THREE.MeshStandardMaterial({ color: 0x8a6f45, roughness: 0.85 }),
        new THREE.MeshStandardMaterial({ color: 0xa8824f, roughness: 0.8 }),
        new THREE.MeshStandardMaterial({ color: 0xa8824f, roughness: 0.8 }),
      ],
    );
    board.position.y = -0.18;
    board.userData.pickId = "board";
    scene.add(board);

    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xe0483e, roughness: 0.4 }),
    );
    marker.visible = false;
    scene.add(marker);

    rtRef.current = { stones: new Map(), marker, scene };
    detach = attachPickPointer(stage, () => [board], {
      onTap: (hit) => {
        if (!hit) return;
        const cur = propsRef.current;
        if (!cur.myTurn) return;
        const col = Math.round(hit.point.x / PITCH) + 7;
        const row = Math.round(hit.point.z / PITCH) + 7;
        if (col < 0 || col >= SIZE || row < 0 || row >= SIZE) return;
        const lx = (col - 7) * PITCH;
        const lz = (row - 7) * PITCH;
        if (Math.hypot(hit.point.x - lx, hit.point.z - lz) > 0.3) return;
        const idx = row * SIZE + col;
        if (cur.cells[idx] !== -1) return;
        cur.onPlace(idx);
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

  // 盤面同期: 石の生成と最終手マーカー。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    cells.forEach((seat, i) => {
      const has = rt.stones.has(i);
      if (seat === -1) {
        if (has) {
          const s = rt.stones.get(i)!;
          rt.scene.remove(s.mesh);
          rt.stones.delete(i);
        }
        return;
      }
      if (!has) {
        const mesh = createStone(0.27, seat === 0 ? BLACK : WHITE);
        const [x, z] = stonePos(i);
        mesh.position.set(x, 0.16, z);
        rt.scene.add(mesh);
        rt.stones.set(i, { mesh, mat: mesh.material as THREE.MeshStandardMaterial });
      }
    });
    if (lastMove !== null && cells[lastMove] !== -1) {
      const [x, z] = stonePos(lastMove);
      rt.marker.position.set(x, 0.36, z);
      rt.marker.visible = true;
    } else {
      rt.marker.visible = false;
    }
  }, [cells, lastMove]);

  return (
    <SceneBox
      height={420}
      label="五目並べ盤面（3D）。交点をタップして石を置きます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#8a6f45"
    />
  );
}
