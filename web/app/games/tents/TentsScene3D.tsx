"use client";
// テントと木の 3D 盤。マスの造形（絵文字は使わず立体で表す）:
//   木 = 茶色の幹（円柱）＋緑の葉（円錐2段）。現行 2D の SVG と同じモチーフ。
//   テント = オレンジの三角プリズム＋手前の濃色の入口（2D の SVG と同じ形）。
//   草（テントなしの印）= 濃い芝タイル＋小さな草の芽（円錐3本）。
//   未定 = 明るい芝タイルの面表現。
// ルール違反マスは赤い枠で示す（現行 2D の赤枠と同じ情報で、親が
// tentsViolations で計算した violationCells をそのまま受け取る）。
// 行・列のテント数ヒントは盤外の情報なので 3D には入れず、親が DOM で
// 併記する（nonogram と同じ分担。盤外プレートのテクスチャにすると
// 数字の位置と盤マスの対応が斜め視点でずれて読めるため DOM を選んだ）。
// 入力は現行クライアントの操作語彙どおり:
//   タップ = onCell（未定→テント→草→未定の循環は lib/tents.ts の
//     cycleTentsMark と親が決め、3D 側では再実装しない）
//   下スワイプ = onCheck（現行の盤面ジェスチャと同じ）
// 状態表示（テント数・時間・違反メッセージ）は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { TentsMark } from "@/lib/tents";

interface Props {
  size: number;
  trees: boolean[];
  marks: TentsMark[];
  violationCells: number[];
  status: "playing" | "won";
  /** タップ（現行の onCell へ接続）。 */
  onCell: (index: number) => void;
  /** 下スワイプ＝チェック（現行の onCheck へ接続）。 */
  onCheck: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;

function cellPos(index: number, size: number): [number, number] {
  const r = Math.floor(index / size);
  const c = index % size;
  return [(c - (size - 1) / 2) * PITCH, (r - (size - 1) / 2) * PITCH];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, size: number) {
  const w = container.clientWidth || 460;
  const h = container.clientHeight || 440;
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

/** 木の造形（幹＋葉の円錐2段）。 */
function createTree(): THREE.Group {
  const grp = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.09, 0.3, 10),
    new THREE.MeshStandardMaterial({ color: 0x6d4c41, roughness: 0.8 }),
  );
  trunk.position.y = 0.29;
  grp.add(trunk);
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 0.7 });
  const lower = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.52, 12), leafMat);
  lower.position.y = 0.62;
  grp.add(lower);
  const upper = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.42, 12), leafMat);
  upper.position.y = 0.94;
  grp.add(upper);
  return grp;
}

/** テントの造形（三角プリズム＋入口）。戻り値の mat は完成時の発光に使う。 */
function createTent(): { grp: THREE.Group; mat: THREE.MeshStandardMaterial } {
  const grp = new THREE.Group();
  // 三角形を押し出してプリズムにする（2D の SVG の三角屋根と同じ輪郭）。
  const shape = new THREE.Shape();
  shape.moveTo(-0.36, 0);
  shape.lineTo(0.36, 0);
  shape.lineTo(0, 0.54);
  shape.closePath();
  const mat = new THREE.MeshStandardMaterial({
    color: 0xef6c00,
    roughness: 0.6,
    emissive: 0xef6c00,
    emissiveIntensity: 0,
  });
  const prism = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.58, bevelEnabled: false }), mat);
  prism.position.set(0, 0.14, -0.29);
  grp.add(prism);
  // 入口（手前面の濃色の小さな三角）。
  const doorShape = new THREE.Shape();
  doorShape.moveTo(-0.17, 0);
  doorShape.lineTo(0.17, 0);
  doorShape.lineTo(0, 0.3);
  doorShape.closePath();
  const door = new THREE.Mesh(
    new THREE.ExtrudeGeometry(doorShape, { depth: 0.02, bevelEnabled: false }),
    new THREE.MeshStandardMaterial({ color: 0x8d3b00, roughness: 0.7 }),
  );
  door.position.set(0, 0.14, 0.29);
  grp.add(door);
  return { grp, mat };
}

/** 草の印の造形（小さな芽3本）。 */
function createGrassTuft(): THREE.Group {
  const grp = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x558b2f, roughness: 0.7 });
  for (const [dx, dz, h] of [[-0.16, 0.05, 0.3], [0.02, -0.08, 0.38], [0.18, 0.08, 0.26]] as const) {
    const blade = new THREE.Mesh(new THREE.ConeGeometry(0.06, h, 8), mat);
    blade.position.set(dx, 0.14 + h / 2, dz);
    grp.add(blade);
  }
  return grp;
}

/** 違反マスの赤い枠（タイル上面の周囲に出す）。 */
function createBadFrame(): THREE.Group {
  const holder = new THREE.Group();
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(0.99, 0.06, 0.99)),
    new THREE.LineBasicMaterial({ color: 0xe2534a }),
  );
  edges.position.y = 0.3;
  holder.add(edges);
  return holder;
}

interface CellRt {
  sig: string;
  grp: THREE.Group;
  tentMat: THREE.MeshStandardMaterial | null;
}

interface SceneRt {
  stage: Stage;
  tilesGroup: THREE.Group;
  hits: THREE.Mesh[];
  hitSize: number;
  cellsRt: Map<number, CellRt>;
}

export default function TentsScene3D({
  size, trees, marks, violationCells, status, onCell, onCheck, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onCell, onCheck, status });
  propsRef.current = { onCell, onCheck, status };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x39543a,
      camera: { position: [0, 7.5, 5.2], lookAt: [0, 0, 0.2], fov: 42 },
      onFrame: (_dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        // 完成時だけテントをゆっくり発光させる（演出のみ、判定には使わない）。
        const glow = propsRef.current.status === "won" ? 0.3 + 0.18 * Math.sin(t * 3) : 0;
        for (const c of rt.cellsRt.values()) {
          if (c.tentMat) c.tentMat.emissiveIntensity = glow;
        }
      },
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

    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (id) propsRef.current.onCell(Number(id.slice(5)));
      },
      // 下スワイプ＝チェック。マス上で始めたスワイプはドラッグ扱いになるため
      // onDragEnd のフリック方向で受け、素早いフリックは onFlick でも受ける。
      onDragEnd: (flick) => {
        if (flick.dir === "down") propsRef.current.onCheck();
      },
      onFlick: (flick) => {
        if (flick.dir === "down") propsRef.current.onCheck();
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
        new THREE.MeshStandardMaterial({ color: 0x6d8f57, roughness: 0.9 }),
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
      const isTree = trees[i] ?? false;
      const mark = marks[i] ?? 0;
      const bad = badSet.has(i);
      const sig = `${isTree ? 1 : 0}|${mark}|${bad ? 1 : 0}`;
      const cur = rt.cellsRt.get(i);
      if (cur && cur.sig === sig) continue;
      if (cur) tilesGroup.remove(cur.grp);
      const grp = new THREE.Group();
      const [x, z] = cellPos(i, size);
      grp.position.set(x, 0, z);
      let tentMat: THREE.MeshStandardMaterial | null = null;
      // 芝マスの面表現: 木・テント・草で土台の色を少し変えて状態を読み分ける。
      const tileColor = isTree ? 0xdcebd2 : mark === 1 ? 0xf3e3c2 : mark === 2 ? 0x86ab63 : 0xa9c489;
      const tile = new THREE.Mesh(
        new THREE.BoxGeometry(0.92, 0.14, 0.92),
        new THREE.MeshStandardMaterial({ color: tileColor, roughness: 0.8 }),
      );
      tile.position.y = 0.07;
      grp.add(tile);
      if (isTree) {
        grp.add(createTree());
      } else if (mark === 1) {
        const tent = createTent();
        tentMat = tent.mat;
        grp.add(tent.grp);
      } else if (mark === 2) {
        grp.add(createGrassTuft());
      }
      if (bad) grp.add(createBadFrame());
      tilesGroup.add(grp);
      rt.cellsRt.set(i, { sig, grp, tentMat });
    }
  }, [size, trees, marks, violationCells]);

  return (
    <SceneBox
      height={440}
      label="テントと木の盤（3D）。マスをタップでテント・草・未定を切り替え、下にスワイプでチェックします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#39543a"
    />
  );
}
