"use client";
// ケンケンの 3D 盤。マスは立体タイルで表す:
//   ケージ（小部屋）はタイルの淡い色分け＋境界の太い壁（溝）で表し、
//   ケージ先頭マスの上面テクスチャ左上に演算ラベル（例 "12+" "3-"）を
//   大きく描く。入力数字は同じ面の中央〜右下に大きく描き、ラベルと
//   衝突しない配置にする。選択マスは持ち上げ＋発光、違反マスは
//   現行 2D と同じ赤系の面色にする。
// 入力は現行クライアントの操作語彙どおり:
//   タップ = onCell（選択。数字入力は親の DOM パッドが担う）
//   下フリック = onCheck（現行の盤面スワイプ＝チェックを維持する）
// 判定・合法性はすべて lib/kenken.ts と親ハンドラが決め、ここは表現と
// 入力の橋渡しだけを行う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { KenkenCage } from "@/lib/kenken";

interface Props {
  values: number[];
  size: number;
  cages: KenkenCage[];
  cageOf: number[];
  selected: number;
  badCells: Set<number>;
  /** タップ（現行の選択ハンドラへ接続）。 */
  onCell: (index: number) => void;
  /** 下フリック（現行のチェックへ接続）。 */
  onCheck: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;
/** ケージごとの淡色（タイル面の色分け用）。 */
const CAGE_TINTS = [
  "#ffffff", "#fef3c7", "#dbeafe", "#dcfce7", "#fae8ff", "#ffe4e6",
  "#e0e7ff", "#fef9c3", "#cffafe", "#f1f5f9", "#ffedd5", "#ede9fe",
];

function cellPos(index: number, size: number): [number, number] {
  const r = Math.floor(index / size);
  const c = index % size;
  return [(c - (size - 1) / 2) * PITCH, (r - (size - 1) / 2) * PITCH];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, size: number) {
  const w = container.clientWidth || 440;
  const h = container.clientHeight || 400;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (size / 2 + 0.9) / Math.tan(hFov / 2);
  const distD = ((size / 2 + 0.9) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.4;
  stage.setCamera({
    position: [0, dist * 0.84, dist * 0.56],
    lookAt: [0, 0, 0.2],
    fov: 42,
  });
}

/** 上面テクスチャつきタイル。ラベルは左上、数字は中央〜右下に大きく。 */
function createTile(
  bg: string,
  value: number,
  label: string | null,
  selected: boolean,
): THREE.Mesh {
  const key = `kenken-${bg}-${value}-${label ?? ""}`;
  const topTex = canvasTexture(key, 160, 160, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, 160, 160);
    if (label) {
      g.fillStyle = "#475569";
      g.font = "bold 34px sans-serif";
      g.textAlign = "left";
      g.textBaseline = "top";
      g.fillText(label, 8, 6);
    }
    if (value !== 0) {
      g.fillStyle = "#252525";
      g.font = "bold 84px sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      // ラベルがあるマスでは数字を右下へ寄せて衝突を避ける。
      if (label) g.fillText(String(value), 98, 104);
      else g.fillText(String(value), 80, 84);
    }
  });
  const sideColor = new THREE.Color(bg).multiplyScalar(0.82);
  const side = new THREE.MeshStandardMaterial({ color: sideColor, roughness: 0.65 });
  const top = new THREE.MeshStandardMaterial({
    map: topTex,
    roughness: 0.55,
    emissive: selected ? new THREE.Color(0x2563eb) : new THREE.Color(0x000000),
    emissiveIntensity: selected ? 0.3 : 0,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.3, 0.94), [side, side, top, side, side, side]);
  mesh.position.y = 0.15;
  return mesh;
}

interface CellRt {
  sig: string;
  grp: THREE.Group;
}

interface SceneRt {
  stage: Stage;
  tilesGroup: THREE.Group;
  hits: THREE.Mesh[];
  cellsRt: Map<number, CellRt>;
  builtKey: string;
}

export default function KenkenScene3D({
  values, size, cages, cageOf, selected, badCells, onCell, onCheck, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onCell, onCheck });
  propsRef.current = { onCell, onCheck };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x3d4a52,
      camera: { position: [0, 7, 5], lookAt: [0, 0, 0.2], fov: 42 },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    const tilesGroup = new THREE.Group();
    scene.add(tilesGroup);
    rtRef.current = { stage, tilesGroup, hits: [], cellsRt: new Map(), builtKey: "" };

    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (id) propsRef.current.onCell(Number(id.slice(5)));
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

  // 盤面同期: サイズ／ケージ構成が変わったら土台・壁・当たり判定を作り直し、
  // マスは署名差分だけ作り直す。ケージ境界の壁は cageOf の隣接比較で立てる。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, tilesGroup } = rt;
    const buildKey = `${size}|${cageOf.join(",")}`;
    if (rt.builtKey !== buildKey) {
      rt.builtKey = buildKey;
      for (const child of [...tilesGroup.children]) tilesGroup.remove(child);
      rt.cellsRt.clear();
      rt.hits = [];
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(size * PITCH + 0.35, 0.3, size * PITCH + 0.35),
        new THREE.MeshStandardMaterial({ color: 0x2f3a42, roughness: 0.9 }),
      );
      base.position.y = -0.16;
      tilesGroup.add(base);
      // ケージ境界の太い壁（高さで溝を表現する）。
      const wallMat = new THREE.MeshStandardMaterial({ color: 0x252525, roughness: 0.7 });
      const addWall = (x: number, z: number, horizontal: boolean) => {
        const wall = new THREE.Mesh(
          horizontal
            ? new THREE.BoxGeometry(PITCH + 0.06, 0.52, 0.09)
            : new THREE.BoxGeometry(0.09, 0.52, PITCH + 0.06),
          wallMat,
        );
        wall.position.set(x, 0.26, z);
        tilesGroup.add(wall);
      };
      for (let i = 0; i < size * size; i++) {
        const r = Math.floor(i / size);
        const c = i % size;
        const [x, z] = cellPos(i, size);
        if (r === 0 || cageOf[i - size] !== cageOf[i]) addWall(x, z - PITCH / 2, true);
        if (r === size - 1) addWall(x, z + PITCH / 2, true);
        if (c === 0 || cageOf[i - 1] !== cageOf[i]) addWall(x - PITCH / 2, z, false);
        if (c === size - 1) addWall(x + PITCH / 2, z, false);
      }
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

    // ケージのラベルは最小 index のマスに表示する（現行 2D と同じ）。
    const labelOf = new Map<number, string>();
    for (const cage of cages) {
      labelOf.set(Math.min(...cage.cells), `${cage.target}${cage.op}`);
    }

    values.forEach((value, i) => {
      const isSelected = selected === i;
      const bad = badCells.has(i);
      const bg = bad ? "#f7e3e0" : isSelected ? "#dbeafe" : CAGE_TINTS[cageOf[i] % CAGE_TINTS.length];
      const label = labelOf.get(i) ?? null;
      const sig = `${value}|${bg}|${label ?? ""}|${isSelected ? 1 : 0}`;
      const cur = rt.cellsRt.get(i);
      if (cur && cur.sig === sig) return;
      if (cur) tilesGroup.remove(cur.grp);
      const grp = new THREE.Group();
      const [x, z] = cellPos(i, size);
      grp.position.set(x, isSelected ? 0.16 : 0, z);
      grp.add(createTile(bg, value, label, isSelected));
      tilesGroup.add(grp);
      rt.cellsRt.set(i, { sig, grp });
    });
  }, [values, size, cages, cageOf, selected, badCells]);

  const height = size === 4 ? 380 : 430;
  return (
    <SceneBox
      height={height}
      label="ケンケンの盤（3D）。マスをタップで選び、下にフリックするとチェックします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#3d4a52"
    />
  );
}
