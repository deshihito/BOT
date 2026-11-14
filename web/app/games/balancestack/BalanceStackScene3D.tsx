"use client";
// バランスタワーの 3D シーン。土台の上にブロックを積む空間を 3D 化する。
// 安定判定は lib/balancestack.ts が決め、ここは置かれたブロックの位置と
// 崩壊時の傾きを状態へ補間追従するだけ（独自の物理判定はしない）。
// 入力: 盤面のタップ/ドラッグ = 置く位置（現行のタップ位置決め・スライダーと同一）。
// 配置の確定は従来どおり DOM の「置く」ボタン。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import {
  BALANCE_BASE,
  BALANCE_FIELD_WIDTH,
  overallCenterOfMass,
  type BalanceBlockSpec,
  type PlacedBalanceBlock,
} from "@/lib/balancestack";

interface Props {
  blocks: PlacedBalanceBlock[];
  current: BalanceBlockSpec;
  center: number;
  stable: boolean;
  status: "playing" | "collapsed";
  collapsedLevel: number | null;
  onCenter: (center: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const FIELD_W = 6;
const BLOCK_H = 0.34;
const DEPTH = 1.0;
const BLOCK_COLORS = [0xe8a13a, 0x5b8dd9, 0x7bc47f, 0xd975a8, 0x9a7fd0, 0xd96a5b];

const xFor = (v: number) => ((v - BALANCE_FIELD_WIDTH / 2) / BALANCE_FIELD_WIDTH) * FIELD_W;
const wFor = (w: number) => (w / BALANCE_FIELD_WIDTH) * FIELD_W;
const centerForX = (x: number) => (x / FIELD_W) * BALANCE_FIELD_WIDTH + BALANCE_FIELD_WIDTH / 2;

function makeBlock(level: number, ghost = false): THREE.Mesh {
  const mat = ghost
    ? new THREE.MeshStandardMaterial({ color: 0x5b8dd9, roughness: 0.5, transparent: true, opacity: 0.45 })
    : new THREE.MeshStandardMaterial({ color: BLOCK_COLORS[level % BLOCK_COLORS.length], roughness: 0.5 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, BLOCK_H - 0.03, DEPTH), mat);
  mesh.userData.pickId = "block";
  return mesh;
}

export default function BalanceStackScene3D({ blocks, current, center, stable, status, collapsedLevel, onCenter, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<{
    stage: ReturnType<typeof createStage>;
    scene: THREE.Scene;
    blockMeshes: Map<number, THREE.Mesh>;
    spawnAt: Map<number, number>;
    ghost: THREE.Mesh;
    comMarker: THREE.Mesh;
    collapseT: number;
    camY: number;
    lookY: number;
  } | null>(null);

  const propsRef = useRef({ blocks, current, center, stable, status, collapsedLevel, onCenter });
  propsRef.current = { blocks, current, center, stable, status, collapsedLevel, onCenter };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0xeaf3fb,
      camera: { position: [0, 3.0, 7.8], lookAt: [0, 1.6, 0], fov: 42 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt || !rt.stage) return;
        const p = propsRef.current;
        const st = rt.stage as NonNullable<ReturnType<typeof createStage>>;
        // 崩壊の進行（0→1）。傾き・ずれは崩れた段以上へ強くかける（表現のみ）。
        const wantCollapse = p.status === "collapsed" ? 1 : 0;
        rt.collapseT += (wantCollapse - rt.collapseT) * Math.min(1, dt * 3.2);
        if (p.status !== "collapsed" && rt.collapseT < 0.01) rt.collapseT = 0;
        for (const [level, mesh] of rt.blockMeshes) {
          const b = p.blocks[level];
          if (!b) continue;
          const targetY = 0.22 + level * BLOCK_H + BLOCK_H / 2;
          let tx = xFor(b.center);
          let ty = targetY;
          let rz = 0;
          if (p.collapsedLevel !== null && level >= p.collapsedLevel) {
            const over = level - p.collapsedLevel;
            const dirSign = level % 2 === 0 ? 1 : -1;
            rz = dirSign * (0.22 + over * 0.13) * rt.collapseT;
            tx += dirSign * over * 0.22 * rt.collapseT;
            ty -= over * 0.05 * rt.collapseT;
          }
          // 新規ブロックは上から落ちてくる。
          const born = rt.spawnAt.get(level);
          if (born !== undefined) {
            const k = Math.min(1, (performance.now() - born) / 320);
            ty += (1 - (1 - Math.pow(1 - k, 2))) * 1.3;
            if (k >= 1) rt.spawnAt.delete(level);
          }
          const k = Math.min(1, dt * 18);
          mesh.position.x += (tx - mesh.position.x) * k;
          mesh.position.y += (ty - mesh.position.y) * Math.min(1, dt * 16);
          mesh.rotation.z += (rz - mesh.rotation.z) * Math.min(1, dt * 8);
        }
        // 予告ブロック（ゴースト）は選択位置へ追従し、安定可否で色が変わる。
        const ghostLevel = p.blocks.length;
        rt.ghost.visible = p.status === "playing";
        if (p.status === "playing") {
          const gx = xFor(p.center);
          const gy = 0.22 + ghostLevel * BLOCK_H + BLOCK_H / 2;
          rt.ghost.position.x += (gx - rt.ghost.position.x) * Math.min(1, dt * 20);
          rt.ghost.position.y = gy;
          rt.ghost.scale.x = wFor(p.current.width);
          (rt.ghost.material as THREE.MeshStandardMaterial).color.setHex(p.stable ? 0x5b8dd9 : 0xd93c3c);
        }
        // 重心マーカーはタワー最上部へ。
        const previewBlocks: PlacedBalanceBlock[] =
          p.status === "playing" ? [...p.blocks, { ...p.current, center: p.center }] : p.blocks;
        const comX = overallCenterOfMass(previewBlocks);
        rt.comMarker.position.x += (xFor(comX) - rt.comMarker.position.x) * Math.min(1, dt * 12);
        rt.comMarker.position.y = 0.22 + previewBlocks.length * BLOCK_H + 0.42;
        // タワーが高いほどカメラが少し上がる。
        const towerH = (p.blocks.length + 1) * BLOCK_H;
        const wantLook = Math.max(1.6, 1.0 + towerH * 0.55);
        rt.lookY += (wantLook - rt.lookY) * Math.min(1, dt * 5);
        rt.camY += (rt.lookY + 1.4 - rt.camY) * Math.min(1, dt * 5);
        st.camera.position.set(0, rt.camY, 7.8);
        st.camera.lookAt(0, rt.lookY, 0);
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    // 地面と土台
    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(FIELD_W + 1.6, 0.22, DEPTH + 1.2),
      new THREE.MeshStandardMaterial({ color: 0x8a6d4f, roughness: 0.9 }),
    );
    ground.position.y = -0.11;
    ground.userData.pickId = "field";
    scene.add(ground);
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(wFor(BALANCE_BASE.right - BALANCE_BASE.left), 0.22, DEPTH + 0.15),
      new THREE.MeshStandardMaterial({ color: 0x5b4632, roughness: 0.8 }),
    );
    base.position.set(xFor((BALANCE_BASE.left + BALANCE_BASE.right) / 2), 0.11, 0);
    base.userData.pickId = "field";
    scene.add(base);
    const ghost = makeBlock(0, true);
    ghost.position.y = 0.22 + BLOCK_H / 2;
    scene.add(ghost);
    const comMarker = new THREE.Mesh(
      new THREE.ConeGeometry(0.14, 0.3, 4),
      new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.4 }),
    );
    comMarker.rotation.x = Math.PI;
    scene.add(comMarker);
    rtRef.current = {
      stage,
      scene,
      blockMeshes: new Map(),
      spawnAt: new Map(),
      ghost,
      comMarker,
      collapseT: 0,
      camY: 3.0,
      lookY: 1.6,
    };
    const setFromPoint = (pt: THREE.Vector3) => {
      const v = centerForX(pt.x);
      propsRef.current.onCenter(Math.round(v * 2) / 2);
    };
    detach = attachPickPointer(
      stage,
      () => [ground, base, ghost, ...rtRef.current!.blockMeshes.values()],
      {
        onTap: (hit) => { if (hit) setFromPoint(hit.point); },
        onDragStart: (hit) => setFromPoint(hit.point),
        onDragMove: (point) => setFromPoint(point),
      },
      { planeY: 0.22 },
    );
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ブロックの差分同期。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    for (const [level, mesh] of [...rt.blockMeshes]) {
      if (level >= blocks.length) {
        rt.scene.remove(mesh);
        rt.blockMeshes.delete(level);
        rt.spawnAt.delete(level);
      }
    }
    blocks.forEach((b, level) => {
      let mesh = rt.blockMeshes.get(level);
      if (!mesh) {
        mesh = makeBlock(level);
        mesh.position.set(xFor(b.center), 0.22 + level * BLOCK_H + BLOCK_H / 2 + 1.3, 0);
        rt.scene.add(mesh);
        rt.blockMeshes.set(level, mesh);
        rt.spawnAt.set(level, performance.now());
      }
      mesh.scale.x = wFor(b.width);
      (mesh.material as THREE.MeshStandardMaterial).color.setHex(BLOCK_COLORS[level % BLOCK_COLORS.length]);
    });
    if (status !== "collapsed") rt.collapseT = 0;
  }, [blocks, status]);

  return (
    <SceneBox
      height={380}
      label="バランスタワー（3D）。タップやドラッグで置く位置を決めます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#eaf3fb"
    />
  );
}
