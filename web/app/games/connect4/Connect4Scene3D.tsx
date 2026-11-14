"use client";
// 四目並べの 3D 盤。青い盤の前面にディスクが並び、新しいディスクは
// 列の上から落ちてくる。操作は列のタップ（盤・列のどこを触っても列が決まる）。
// 着手可否はサーバー側の view が決め、ここは表現と入力の橋渡しだけを行う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 盤に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

interface Props {
  cells: number[];
  winCells: number[];
  lastMove: number | null;
  myTurn: boolean;
  onDrop: (col: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const COLS = 7;
const ROWS = 6;
const PITCH = 1.05;
const PANEL_W = COLS * PITCH + 0.5;
const PANEL_H = ROWS * PITCH + 0.5;
const PANEL_CY = 3.9;
const SEAT_COLORS = [0xc0392b, 0xd9a41c];

function cellX(col: number): number {
  return (col - (COLS - 1) / 2) * PITCH;
}
function cellY(row: number): number {
  return PANEL_CY + PANEL_H / 2 - 0.78 - row * PITCH;
}

interface DiscRt {
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  fallStart: number;
  fromY: number;
  toY: number;
}

export default function Connect4Scene3D({ cells, winCells, lastMove, myTurn, onDrop, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<{ discs: Map<number, DiscRt>; scene: THREE.Scene } | null>(null);
  const propsRef = useRef({ cells, myTurn, onDrop });
  propsRef.current = { cells, myTurn, onDrop };
  const winRef = useRef(winCells);
  winRef.current = winCells;
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x24425f,
      camera: { position: [0, 4.3, 9.6], lookAt: [0, 3.4, 0], fov: 40 },
      onFrame: (_dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        const now = performance.now();
        const win = new Set(winRef.current);
        for (const [i, d] of rt.discs) {
          if (d.fallStart > 0) {
            const k = Math.min(1, (now - d.fallStart) / 420);
            const e = k * k;
            d.mesh.position.y = d.fromY + (d.toY - d.fromY) * e;
            if (k >= 1) {
              // 着地の小さなバウンド
              const b = Math.sin(Math.min(1, (now - d.fallStart - 420) / 160) * Math.PI) * 0.05;
              d.mesh.position.y = d.toY + Math.max(0, b);
              if (now - d.fallStart > 600) d.fallStart = 0;
            }
          }
          if (win.has(i)) d.mat.emissive.setHSL(0.11, 0.9, 0.22 + 0.13 * Math.sin(t * 5));
          else d.mat.emissive.setRGB(0, 0, 0);
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // 地面と盤の脚
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(10, 32),
      new THREE.MeshStandardMaterial({ color: 0x2e4a66, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    scene.add(ground);
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(PANEL_W, PANEL_H, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x2f5f8f, roughness: 0.55 }),
    );
    panel.position.set(0, PANEL_CY, 0);
    panel.userData.pickId = "panel";
    scene.add(panel);
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, PANEL_CY - PANEL_H / 2 + 0.3, 0.6),
        new THREE.MeshStandardMaterial({ color: 0x234a70, roughness: 0.6 }),
      );
      leg.position.set(s * (PANEL_W / 2 - 0.5), (PANEL_CY - PANEL_H / 2) / 2, 0);
      scene.add(leg);
    }
    // 空きマスの穴
    const holeGeo = new THREE.CircleGeometry(0.42, 24);
    const holeMat = new THREE.MeshStandardMaterial({ color: 0x14273c, roughness: 0.9 });
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const hole = new THREE.Mesh(holeGeo, holeMat);
        hole.position.set(cellX(c), cellY(r), 0.26);
        scene.add(hole);
      }
    }
    // 列の当たり判定（盤の手前に透明な柱）
    const hitGeo = new THREE.BoxGeometry(PITCH * 0.96, PANEL_H + 1.4, 1.2);
    const hits: THREE.Mesh[] = [];
    for (let c = 0; c < COLS; c++) {
      const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
      h.position.set(cellX(c), PANEL_CY + 0.4, 0.3);
      h.userData.pickId = `col-${c}`;
      scene.add(h);
      hits.push(h);
    }

    rtRef.current = { discs: new Map(), scene };
    detach = attachPickPointer(stage, () => [panel, ...hits], {
      onTap: (hit) => {
        const cur = propsRef.current;
        if (!cur.myTurn || !hit) return;
        const id = hit.object.userData.pickId as string | undefined;
        let col: number | null = null;
        if (id && id.startsWith("col-")) col = Number(id.slice(4));
        else if (id === "panel") {
          col = Math.round(hit.point.x / PITCH) + (COLS - 1) / 2;
        }
        if (col === null || col < 0 || col >= COLS) return;
        if (cur.cells[col] !== -1) return; // 最上段が埋まっている列は不可
        cur.onDrop(col);
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

  // 盤面同期: ディスク生成（最終手は落下アニメーション）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    cells.forEach((seat, i) => {
      const has = rt.discs.has(i);
      if (seat === -1) {
        if (has) {
          const d = rt.discs.get(i)!;
          rt.scene.remove(d.mesh);
          rt.discs.delete(i);
        }
        return;
      }
      if (!has) {
        const row = Math.floor(i / COLS);
        const col = i % COLS;
        const mat = new THREE.MeshStandardMaterial({ color: SEAT_COLORS[seat], roughness: 0.35 });
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.18, 28), mat);
        mesh.rotation.x = Math.PI / 2;
        const toY = cellY(row);
        const isNew = i === lastMove;
        mesh.position.set(cellX(col), isNew ? PANEL_CY + PANEL_H / 2 + 0.9 : toY, 0.27);
        rt.scene.add(mesh);
        rt.discs.set(i, { mesh, mat, fallStart: isNew ? performance.now() : 0, fromY: mesh.position.y, toY });
      }
    });
  }, [cells, lastMove]);

  return (
    <SceneBox
      height={430}
      label="四目並べ盤面（3D）。列をタップしてディスクを落とします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#24425f"
    />
  );
}
