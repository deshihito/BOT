"use client";
// 2048 の 3D シーン。タイルは上面に数字を大きく描いた立方体で、
// クライアントの visual 状態（id / value / index / pop）をそのまま受ける。
// スライドは位置の補間、合体はスケールのポップで表現する。
// 操作（スワイプ/ダブルタップ）は親の DOM ジェスチャが担い、ここは表示専用。
// 数字は DOM のスコア併記に加え、上面テクスチャでも正面から読める大きさ。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createTileCube } from "@/lib/three-kit/primitives";
import SceneBox from "@/lib/three-kit/SceneBox";

export interface SliderTile3D {
  id: number;
  value: number;
  index: number;
  pop: boolean;
}

interface Props {
  tiles: SliderTile3D[];
  size: number;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.12;
const CUBE = 0.96;

interface TileRt {
  mesh: THREE.Mesh;
  value: number;
  popAt: number;
}

export default function SliderScene3D({ tiles, size, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<{ tiles: Map<number, TileRt>; scene: THREE.Scene } | null>(null);
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const stage = createStage(container, {
      background: 0xe9e4da,
      camera: { position: [0, 5.9, 5.0], lookAt: [0, -0.1, 0.35], fov: 40 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        const now = performance.now();
        for (const t of rt.tiles.values()) {
          const m = t.mesh;
          const target = m.userData.target as THREE.Vector3;
          m.position.x += (target.x - m.position.x) * Math.min(1, dt * 16);
          m.position.z += (target.z - m.position.z) * Math.min(1, dt * 16);
          const age = (now - t.popAt) / 190;
          const s = age < 1 ? 1 + 0.16 * Math.sin(age * Math.PI) : 1;
          m.scale.setScalar(s);
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    // 盤の土台とマス目
    const span = PITCH * size;
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(span + 0.35, 0.3, span + 0.35),
      new THREE.MeshStandardMaterial({ color: 0xbbada0, roughness: 0.8 }),
    );
    base.position.y = -0.16;
    scene.add(base);
    const cellMat = new THREE.MeshStandardMaterial({ color: 0xcdc1b4, roughness: 0.9 });
    const cellGeo = new THREE.BoxGeometry(CUBE, 0.06, CUBE);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const cell = new THREE.Mesh(cellGeo, cellMat);
        cell.position.set((c - (size - 1) / 2) * PITCH, 0.02, (r - (size - 1) / 2) * PITCH);
        scene.add(cell);
      }
    }
    rtRef.current = { tiles: new Map(), scene };
    setReady(true);
    return () => {
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // visual 状態の同期（生成/移動/合体ポップ/除去）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const seen = new Set<number>();
    for (const t of tiles) {
      seen.add(t.id);
      const row = Math.floor(t.index / size);
      const col = t.index % size;
      const target = new THREE.Vector3((col - (size - 1) / 2) * PITCH, CUBE * 0.31 + 0.05, (row - (size - 1) / 2) * PITCH);
      let cur = rt.tiles.get(t.id);
      if (!cur || cur.value !== t.value) {
        if (cur) {
          rt.scene.remove(cur.mesh);
          cur.mesh.geometry.dispose();
        }
        const mesh = createTileCube(CUBE, t.value);
        mesh.position.copy(cur ? cur.mesh.position : target);
        mesh.userData.target = target;
        rt.scene.add(mesh);
        cur = { mesh, value: t.value, popAt: t.pop ? performance.now() : 0 };
        rt.tiles.set(t.id, cur);
      } else {
        cur.mesh.userData.target = target;
        if (t.pop && cur.popAt === 0) cur.popAt = performance.now();
        if (!t.pop) cur.popAt = 0;
      }
    }
    for (const [id, cur] of [...rt.tiles.entries()]) {
      if (!seen.has(id)) {
        rt.scene.remove(cur.mesh);
        cur.mesh.geometry.dispose();
        rt.tiles.delete(id);
      }
    }
  }, [tiles, size]);

  return (
    <SceneBox
      height="100%"
      label="2048 の盤面（3D）"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#e9e4da"
    />
  );
}
