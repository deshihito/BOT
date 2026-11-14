"use client";
// クイーン配置（Nクイーン）の 3D 盤。盤は現行 2D と同じチェス盤色のタイル面で、
// 利き筋のマスは現行どおり薄く色づけ、利き合うクイーンのマスは赤く示す。
// クイーンは冠の造形で表す（第4期 chess シーンのクイーン造形は基盤化されて
// いないため、ここで小さく再実装する: 土台＋軸＋冠＋6つの珠＋頂点の球）。
// 本作は現行仕様が「タップでクイーンを置く/外す」のみで、色領域や×印の
// 仕様は無いため、3D でも追加しない（利き筋表示が現行の補助表示）。
// 操作はタップ → 親の handleCell（toggleQueen）へそのまま渡す。
// 配置上限・利き判定・完成判定は lib/queens.ts と親が決め、ここは表現と
// 入力の橋渡しだけを行う。状態は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

interface Props {
  size: number;
  /** 配置済みクイーンのマス index。 */
  queens: number[];
  /** 利き合っているクイーンのマス index（親が conflictingQueens で算出）。 */
  conflicts: number[];
  /** 利き筋のマス index（親が attackedSquares で算出）。 */
  attacked: number[];
  /** マスのタップ（現行の handleCell）。 */
  onCell: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;
const GOLD = 0xd4a017;

function cellPos(index: number, size: number): [number, number] {
  const r = Math.floor(index / size);
  const c = index % size;
  return [(c - (size - 1) / 2) * PITCH, (r - (size - 1) / 2) * PITCH];
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

/**
 * クイーンの冠の造形（chess シーンの createQueen を小さく再実装したもの。
 * three-kit には触らない）。利き合うクイーンは胴体を赤くする。
 */
function createQueenPiece(conflict: boolean): THREE.Group {
  const grp = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({
    color: conflict ? 0xc0392b : 0x34495e,
    roughness: 0.4,
  });
  const gold = new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.3, metalness: 0.45 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.09, 24), body);
  base.position.y = 0.045;
  grp.add(base);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.2, 0.32, 20), body);
  stem.position.y = 0.25;
  grp.add(stem);
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.16, 0.17, 24), body);
  crown.position.y = 0.5;
  grp.add(crown);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const point = new THREE.Mesh(new THREE.SphereGeometry(0.048, 10, 8), gold);
    point.position.set(Math.cos(a) * 0.22, 0.62, Math.sin(a) * 0.22);
    grp.add(point);
  }
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 14, 10), gold);
  orb.position.y = 0.66;
  grp.add(orb);
  return grp;
}

/** 現行 2D と同じマス色（通常/利き筋/クイーン/競合）。 */
function tileColor(dark: boolean, has: boolean, bad: boolean, underAttack: boolean): number {
  if (bad) return 0xf3c1bb;
  if (has) return 0xcfe3ff;
  if (underAttack) return dark ? 0xcbb98f : 0xe3d5ac;
  return dark ? 0x8a9a7b : 0xe6e2d3;
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

export default function QueensScene3D({ size, queens, conflicts, attacked, onCell, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onCell });
  propsRef.current = { onCell };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x3a4149,
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
    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
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

  // 盤面同期: サイズが変わったら土台と当たり判定を作り直し、マスは差分だけ作り直す。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, group } = rt;
    if (rt.hitSize !== size) {
      rt.hitSize = size;
      for (const child of [...group.children]) {
        if (child.userData.isBase) group.remove(child);
      }
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(size * PITCH + 0.35, 0.3, size * PITCH + 0.35),
        new THREE.MeshStandardMaterial({ color: 0x5d6650, roughness: 0.85 }),
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

    const ownSet = new Set(queens);
    const conflictSet = new Set(conflicts);
    const attackedSet = new Set(attacked);
    for (let i = 0; i < size * size; i++) {
      const r = Math.floor(i / size);
      const c = i % size;
      const dark = (r + c) % 2 === 1;
      const has = ownSet.has(i);
      const bad = conflictSet.has(i);
      const underAttack = attackedSet.has(i);
      const sig = `${dark ? 1 : 0}|${has ? 1 : 0}|${bad ? 1 : 0}|${underAttack ? 1 : 0}`;
      const cur = rt.cellsRt.get(i);
      if (cur && cur.sig === sig) continue;
      if (cur) group.remove(cur.grp);
      const grp = new THREE.Group();
      const [x, z] = cellPos(i, size);
      grp.position.set(x, 0, z);
      const tile = new THREE.Mesh(
        new THREE.BoxGeometry(0.94, 0.12, 0.94),
        new THREE.MeshStandardMaterial({ color: tileColor(dark, has, bad, underAttack), roughness: 0.65 }),
      );
      tile.position.y = 0.06;
      grp.add(tile);
      if (has) {
        const piece = createQueenPiece(bad);
        piece.position.y = 0.12;
        grp.add(piece);
      }
      group.add(grp);
      rt.cellsRt.set(i, { sig, grp });
    }
  }, [size, queens, conflicts, attacked]);

  return (
    <SceneBox
      height={460}
      label="クイーン配置の盤（3D）。マスをタップしてクイーンを置いたり外したりします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#3a4149"
    />
  );
}
