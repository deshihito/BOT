"use client";
// スタッカーの 3D シーン。積み上がった段と移動中ブロックを 3D ブロック列で描く。
// 移動・重なり・切り落としの判定は lib/stacker.ts が決め、ここは状態へ
// 補間追従するだけ（落下アニメーションと切り落とし片の落下は表現のみ）。
// タワーが高くなるとカメラが上がる。入力: タップ/フリック = 落とす（現行どおり）。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { StackRow } from "@/lib/stacker";

interface Props {
  rows: StackRow[];
  currentStart: number;
  currentWidth: number;
  boardWidth: number;
  status: "playing" | "gameover";
  lastPerfect: boolean;
  onDrop: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const CELL = 0.78;
const BLOCK_H = 0.4;
const DEPTH = 1.1;
const ROW_COLORS = [0xe86a5e, 0xef9234, 0xf2c230, 0x5cb85c, 0x3f9db8, 0x5e7fe8, 0x9a5ee8, 0xe85ea8];

const xFor = (start: number, width: number, boardWidth: number) =>
  (start + width / 2 - boardWidth / 2) * CELL;
const wFor = (width: number) => Math.max(0.12, width * CELL - 0.07);

function makeBlock(level: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, BLOCK_H, DEPTH),
    new THREE.MeshStandardMaterial({ color: ROW_COLORS[level % ROW_COLORS.length], roughness: 0.45 }),
  );
  mesh.userData.pickId = "block";
  return mesh;
}

interface Scrap {
  mesh: THREE.Mesh;
  vy: number;
  rot: number;
  born: number;
}

export default function StackerScene3D({ rows, currentStart, currentWidth, boardWidth, status, lastPerfect, onDrop, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<{
    stage: ReturnType<typeof createStage>;
    scene: THREE.Scene;
    rowMeshes: Map<number, THREE.Mesh>;
    fallStart: Map<number, number>;
    moving: THREE.Mesh;
    scraps: Scrap[];
    camY: number;
    lookY: number;
    perfectAt: number;
  } | null>(null);
  const prevRef = useRef<{ rowsLen: number; curStart: number; curWidth: number }>({ rowsLen: 0, curStart: 0, curWidth: 0 });

  const propsRef = useRef({ rows, currentStart, currentWidth, boardWidth, status, onDrop });
  propsRef.current = { rows, currentStart, currentWidth, boardWidth, status, onDrop };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x141b2e,
      camera: { position: [0, 3.4, 7.6], lookAt: [0, 1.4, 0], fov: 42 },
      onFrame: (dt, t) => {
        const rt = rtRef.current;
        if (!rt || !rt.stage) return;
        const p = propsRef.current;
        // 移動中ブロックは状態の位置へ即追従（往復は親の interval が進める）。
        rt.moving.visible = p.status === "playing";
        if (p.status === "playing") {
          rt.moving.position.x = xFor(p.currentStart, p.currentWidth, p.boardWidth);
          rt.moving.position.y = p.rows.length * BLOCK_H + BLOCK_H / 2;
          rt.moving.scale.x = wFor(p.currentWidth);
          const mat = rt.moving.material as THREE.MeshStandardMaterial;
          mat.color.setHex(ROW_COLORS[p.rows.length % ROW_COLORS.length]);
        }
        // 落下アニメーション（新規段は上から落ちて着地）。
        for (const [level, mesh] of rt.rowMeshes) {
          const born = rt.fallStart.get(level);
          const targetY = level * BLOCK_H + BLOCK_H / 2;
          if (born !== undefined) {
            const k = Math.min(1, (performance.now() - born) / 300);
            const e = 1 - Math.pow(1 - k, 2);
            mesh.position.y = targetY + (1 - e) * 1.5;
            if (k >= 1) rt.fallStart.delete(level);
          } else {
            mesh.position.y = targetY;
          }
          // ぴったり時の発光パルス。
          const mat = mesh.material as THREE.MeshStandardMaterial;
          if (level === p.rows.length - 1 && rt.perfectAt > 0) {
            const age = (performance.now() - rt.perfectAt) / 600;
            mat.emissive.setScalar(age < 1 ? (1 - age) * 0.55 : 0);
          }
        }
        // 切り落とし片の落下。
        rt.scraps = rt.scraps.filter((s) => {
          const age = (performance.now() - s.born) / 1000;
          if (age > 0.95) {
            rt.scene.remove(s.mesh);
            s.mesh.geometry.dispose();
            (s.mesh.material as THREE.Material).dispose();
            return false;
          }
          s.vy += dt * 6;
          s.mesh.position.y -= s.vy * dt;
          s.mesh.rotation.z += s.rot * dt;
          const mat = s.mesh.material as THREE.MeshStandardMaterial;
          mat.opacity = Math.max(0, 1 - age / 0.95);
          return true;
        });
        // タワーが高いほどカメラが上がる。
        const topLevel = Math.max(p.rows.length, 1);
        const wantLookY = Math.max(1.4, (topLevel - 5) * BLOCK_H + 1.2);
        rt.lookY += (wantLookY - rt.lookY) * Math.min(1, dt * 5);
        rt.camY += (rt.lookY + 2.0 - rt.camY) * Math.min(1, dt * 5);
        const cam = (rt.stage as NonNullable<ReturnType<typeof createStage>>).camera;
        cam.position.set(0, rt.camY, 7.6);
        cam.lookAt(0, rt.lookY, 0);
        void t;
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    // 土台
    const platform = new THREE.Mesh(
      new THREE.BoxGeometry(boardWidth * CELL + 0.5, 0.3, DEPTH + 0.5),
      new THREE.MeshStandardMaterial({ color: 0x3a4560, roughness: 0.7 }),
    );
    platform.position.y = -0.18;
    platform.userData.pickId = "table";
    scene.add(platform);
    const moving = makeBlock(0);
    scene.add(moving);
    rtRef.current = {
      stage,
      scene,
      rowMeshes: new Map(),
      fallStart: new Map(),
      moving,
      scraps: [],
      camY: 3.4,
      lookY: 1.4,
      perfectAt: 0,
    };
    detach = attachPickPointer(
      stage,
      () => [platform, moving, ...rtRef.current!.rowMeshes.values()],
      {
        onTapAnywhere: () => propsRef.current.onDrop(),
        onFlick: () => propsRef.current.onDrop(),
      },
      { planeY: 0 },
    );
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 段の差分同期。新規段は落下アニメ＋はみ出し片を生成する。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const prev = prevRef.current;
    if (rows.length > prev.rowsLen && prev.rowsLen === rows.length - 1) {
      // 直前に落とした段について、切り落とし片（左/右のはみ出し）を出す。
      const placed = rows[rows.length - 1];
      const level = rows.length - 1;
      const fromStart = prev.curStart;
      const fromWidth = prev.curWidth;
      const spawnScrap = (start: number, width: number) => {
        if (width <= 0) return;
        const mesh = makeBlock(level);
        mesh.scale.x = wFor(width);
        mesh.position.set(xFor(start, width, boardWidth), level * BLOCK_H + BLOCK_H / 2, 0);
        (mesh.material as THREE.MeshStandardMaterial).transparent = true;
        rt.scene.add(mesh);
        rt.scraps.push({ mesh, vy: 0.4, rot: start < placed.start ? -2.2 : 2.2, born: performance.now() });
      };
      spawnScrap(fromStart, placed.start - fromStart);
      spawnScrap(placed.start + placed.width, fromStart + fromWidth - (placed.start + placed.width));
      rt.fallStart.set(level, performance.now());
      if (lastPerfect) rt.perfectAt = performance.now();
    }
    // 行メッシュの同期（リスタート時は作り直し）。
    for (const [level, mesh] of [...rt.rowMeshes]) {
      if (level >= rows.length) {
        rt.scene.remove(mesh);
        rt.rowMeshes.delete(level);
        rt.fallStart.delete(level);
      }
    }
    rows.forEach((row, level) => {
      let mesh = rt.rowMeshes.get(level);
      if (!mesh) {
        mesh = makeBlock(level);
        rt.scene.add(mesh);
        rt.rowMeshes.set(level, mesh);
        if (!rt.fallStart.has(level) && level === rows.length - 1 && rows.length > 0) {
          // 初期表示や復帰時は落下させない（drop 経由の新規段だけ落とす）。
        }
      }
      mesh.position.x = xFor(row.start, row.width, boardWidth);
      mesh.scale.x = wFor(row.width);
      (mesh.material as THREE.MeshStandardMaterial).color.setHex(ROW_COLORS[level % ROW_COLORS.length]);
    });
    prevRef.current = { rowsLen: rows.length, curStart: currentStart, curWidth: currentWidth };
  }, [rows, currentStart, currentWidth, boardWidth, lastPerfect]);

  return (
    <SceneBox
      height={380}
      label="スタッカー（3D）。タップでブロックを落とします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#141b2e"
    />
  );
}
