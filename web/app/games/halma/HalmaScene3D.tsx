"use client";
// ハルマの 3D 盤。星形盤の各マスを小さな円盤で表し、駒は碁石型
// （createStone）。移動/ジャンプは弧を描くアニメーションで経路が
// 分かるようにする。入力は既存のタップ操作（コマ→移動先）を
// レイキャストでクライアントの onCell へそのまま渡す。
// 駒配置・座標はロジック層 lib/halma.ts の HALMA_CELLS をそのまま使う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 盤に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createStone } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import { HALMA_CELLS, HALMA_CAMPS, HALMA_TARGETS } from "@/lib/halma";

interface Props {
  /** マス index → 0:空き / 1:プレイヤー0 / 2:プレイヤー1。 */
  board: number[];
  selected: number | null;
  targets: number[];
  lastMove: { from: number; to: number } | null;
  onCell: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const MAX_R = Math.max(...HALMA_CELLS.map((c) => Math.hypot(c.x, c.y)));
const SCALE = 5.0 / MAX_R;
const PIECE_COLORS = [0x2563eb, 0xdc2626] as const;
const CAMP0 = new Set(HALMA_CAMPS[0]);
const CAMP1 = new Set(HALMA_CAMPS[1]);

function cellPos(index: number): [number, number] {
  const c = HALMA_CELLS[index];
  return [c.x * SCALE, c.y * SCALE];
}

interface PieceRt {
  mesh: THREE.Mesh;
  cell: number;
  owner: number;
  anim: { from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number; arc: number } | null;
}

export default function HalmaScene3D({ board, selected, targets, lastMove, onCell, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<{
    pieces: Map<number, PieceRt>;
    markers: THREE.Mesh[];
    selRing: THREE.Mesh;
    lastRings: THREE.Mesh[];
    scene: THREE.Scene;
    initialized: boolean;
  } | null>(null);
  const propsRef = useRef({ onCell });
  propsRef.current = { onCell };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x334155,
      camera: { position: [0, 8.8, 5.8], lookAt: [0, 0, 0.4], fov: 42 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        const now = performance.now();
        for (const p of rt.pieces.values()) {
          if (!p.anim) continue;
          p.anim.t += dt;
          const k = Math.min(1, p.anim.t / p.anim.dur);
          const ease = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
          p.mesh.position.lerpVectors(p.anim.from, p.anim.to, ease);
          p.mesh.position.y = p.anim.from.y + (p.anim.to.y - p.anim.from.y) * ease + Math.sin(ease * Math.PI) * p.anim.arc;
          if (k >= 1) {
            p.mesh.position.copy(p.anim.to);
            p.anim = null;
          }
        }
        if (rt.selRing.visible) {
          (rt.selRing.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.3 * Math.sin(now / 240);
        }
        const pulse = 0.5 + 0.25 * Math.sin(now / 280);
        for (const m of rt.markers) {
          if (m.visible) (m.material as THREE.MeshBasicMaterial).opacity = pulse;
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // 星形盤の台
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(MAX_R * SCALE + 0.55, MAX_R * SCALE + 0.7, 0.3, 48),
      new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.85 }),
    );
    base.position.y = -0.16;
    scene.add(base);

    // マス（陣地は色分け: 自陣=青み、相手陣=赤み）
    const cellGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.07, 20);
    const matPlain = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.7 });
    const matCamp0 = new THREE.MeshStandardMaterial({ color: 0xbfdbfe, roughness: 0.7 });
    const matCamp1 = new THREE.MeshStandardMaterial({ color: 0xfecaca, roughness: 0.7 });
    HALMA_CELLS.forEach((_, i) => {
      const m = new THREE.Mesh(cellGeo, CAMP0.has(i) ? matCamp0 : CAMP1.has(i) ? matCamp1 : matPlain);
      const [x, z] = cellPos(i);
      m.position.set(x, 0.02, z);
      scene.add(m);
    });

    // 移動先マーカー
    const markers: THREE.Mesh[] = [];
    const markerGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.05, 16);
    HALMA_CELLS.forEach((_, i) => {
      const m = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.6 }));
      const [x, z] = cellPos(i);
      m.position.set(x, 0.09, z);
      m.visible = false;
      scene.add(m);
      markers.push(m);
    });

    // 選択リング・最終手リング
    const ringGeo = new THREE.TorusGeometry(0.37, 0.04, 10, 28);
    const selRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.8 }));
    selRing.rotation.x = Math.PI / 2;
    selRing.position.y = 0.08;
    selRing.visible = false;
    scene.add(selRing);
    const lastRings: THREE.Mesh[] = [];
    for (let k = 0; k < 2; k++) {
      const r = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.55 }));
      r.rotation.x = Math.PI / 2;
      r.position.y = 0.08;
      r.visible = false;
      scene.add(r);
      lastRings.push(r);
    }

    // マスの当たり判定
    const hits: THREE.Mesh[] = [];
    const hitGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.6, 10);
    HALMA_CELLS.forEach((_, i) => {
      const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
      const [x, z] = cellPos(i);
      h.position.set(x, 0.2, z);
      h.userData.pickId = `cell-${i}`;
      scene.add(h);
      hits.push(h);
    });

    rtRef.current = { pieces: new Map(), markers, selRing, lastRings, scene, initialized: false };
    detach = attachPickPointer(stage, () => hits, {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (!id) return;
        propsRef.current.onCell(Number(id.slice(5)));
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

  // 盤面同期: 駒の生成・移動（弧アニメーション）・選択/移動先/最終手表示。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const desired = new Map<number, number>();
    board.forEach((v, i) => {
      if (v === 1 || v === 2) desired.set(i, v - 1);
    });
    const spares = new Map<number, PieceRt[]>([[0, []], [1, []]]);
    for (const [cell, p] of [...rt.pieces]) {
      if (desired.get(cell) === p.owner) {
        desired.delete(cell);
      } else {
        rt.pieces.delete(cell);
        spares.get(p.owner)!.push(p);
      }
    }
    for (const [cell, owner] of desired) {
      const [x, z] = cellPos(cell);
      const to = new THREE.Vector3(x, 0.24, z);
      const spare = spares.get(owner)!.pop();
      if (spare) {
        const dist = spare.mesh.position.distanceTo(to);
        spare.cell = cell;
        spare.anim = rt.initialized && dist > 0.01
          ? { from: spare.mesh.position.clone(), to, t: 0, dur: 0.38 + dist * 0.1, arc: 0.3 + dist * 0.3 }
          : null;
        if (!spare.anim) spare.mesh.position.copy(to);
        rt.pieces.set(cell, spare);
      } else {
        const mesh = createStone(0.27, PIECE_COLORS[owner]);
        mesh.position.copy(to);
        rt.scene.add(mesh);
        rt.pieces.set(cell, { mesh, cell, owner, anim: null });
      }
    }
    for (const list of spares.values()) {
      for (const p of list) rt.scene.remove(p.mesh);
    }
    rt.initialized = true;

    if (selected !== null && rt.pieces.has(selected)) {
      const [x, z] = cellPos(selected);
      rt.selRing.position.set(x, 0.08, z);
      rt.selRing.visible = true;
    } else {
      rt.selRing.visible = false;
    }
    rt.markers.forEach((m, i) => {
      m.visible = targets.includes(i) && !rt.pieces.has(i);
    });
    const lastCells = lastMove ? [lastMove.from, lastMove.to] : [];
    rt.lastRings.forEach((r, k) => {
      const cell = lastCells[k];
      if (cell === undefined) {
        r.visible = false;
        return;
      }
      const [x, z] = cellPos(cell);
      r.position.set(x, 0.08, z);
      r.visible = true;
    });
  }, [board, selected, targets, lastMove]);

  return (
    <SceneBox
      height={480}
      label="ハルマ盤面（3D）。コマをタップして選び、移動先をタップします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#334155"
    />
  );
}
