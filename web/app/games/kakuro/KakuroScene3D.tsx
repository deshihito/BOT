"use client";
// カックロの 3D 盤。マスは立体タイルで表す:
//   黒マス（ヒントマス）は上面テクスチャ（192px）に斜めの仕切り線と
//   2 つの合計を大きく描く: 右向き合計は右上、 下向き合計は左下で
//   現行 2D の配置と揃える。
//   白マスの数字も上面に大きく描き、与え数字 = 濃い太字＋灰色面、
//   入力値 = 本文色、選択 = 青系の面色、違反 = 赤系の面色で 2D と揃える。
// 入力は現行クライアントの操作語彙どおり:
//   タップ = onCell（白マスの選択。数字入力は親の DOM パッドが担う）
//   下フリック = onCheck（現行の盤面スワイプ＝チェックを維持する）
// 判定・合法性はすべて lib/kakuro.ts と親ハンドラが決め、ここは表現と
// 入力の橋渡しだけを行う。黒マスと与え数字の白マスは選択対象にしない
// （現行 2D と同じく、当たり判定を持たない）。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { KakuroCell } from "@/lib/kakuro";

interface Props {
  cells: KakuroCell[];
  values: number[];
  size: number;
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

function cellPos(index: number, size: number): [number, number] {
  const r = Math.floor(index / size);
  const c = index % size;
  return [(c - (size - 1) / 2) * PITCH, (r - (size - 1) / 2) * PITCH];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, size: number) {
  const w = container.clientWidth || 460;
  const h = container.clientHeight || 460;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (size / 2 + 1.0) / Math.tan(hFov / 2);
  const distD = ((size / 2 + 1.0) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.4;
  stage.setCamera({
    position: [0, dist * 0.86, dist * 0.52],
    lookAt: [0, 0, 0.2],
    fov: 42,
  });
}

/** 黒マス: 斜め仕切り＋2 合計を 192px キャンバスに大きく描く。 */
function createBlackTile(across: number | null, down: number | null): THREE.Mesh {
  const key = `kakuro-black-${across ?? "x"}-${down ?? "x"}`;
  const topTex = canvasTexture(key, 192, 192, (g) => {
    g.fillStyle = "#2b2f36";
    g.fillRect(0, 0, 192, 192);
    // 斜めの仕切り（左上→右下ではなく現行 2D と同じ左下→右上）。
    g.strokeStyle = "#9aa0a8";
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(0, 192);
    g.lineTo(192, 0);
    g.stroke();
    g.fillStyle = "#ffffff";
    g.font = "bold 58px sans-serif";
    if (across !== null) {
      g.textAlign = "right";
      g.textBaseline = "top";
      g.fillText(String(across), 184, 10);
    }
    if (down !== null) {
      g.textAlign = "left";
      g.textBaseline = "bottom";
      g.fillText(String(down), 8, 184);
    }
  });
  const side = new THREE.MeshStandardMaterial({ color: 0x22252a, roughness: 0.8 });
  const top = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.7 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.22, 0.94), [side, side, top, side, side, side]);
  mesh.position.y = 0.11;
  return mesh;
}

/** 白マス: 数字を上面に大きく描く。 */
function createWhiteTile(bg: string, value: number, given: boolean, selected: boolean): THREE.Mesh {
  const key = `kakuro-white-${bg}-${value}-${given ? 1 : 0}`;
  const topTex = canvasTexture(key, 128, 128, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, 128, 128);
    if (value !== 0) {
      g.fillStyle = given ? "#64748b" : "#252525";
      g.font = given ? "bold 86px sans-serif" : "600 84px sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(value), 64, 68);
    }
  });
  const sideColor = new THREE.Color(bg).multiplyScalar(0.85);
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

export default function KakuroScene3D({
  cells, values, size, selected, badCells, onCell, onCheck, onFail, fallback,
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
      background: 0x334155,
      camera: { position: [0, 9, 6], lookAt: [0, 0, 0.2], fov: 42 },
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

  // 盤面同期: 盤構成が変わったら土台と当たり判定を作り直し（当たり判定は
  // 入力可能な白マスだけ）、タイルは署名差分だけ作り直す。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, tilesGroup } = rt;
    const buildKey = `${size}|${cells.map((c) => (c.kind === "black" ? "b" : c.given ? "g" : "w")).join("")}`;
    if (rt.builtKey !== buildKey) {
      rt.builtKey = buildKey;
      for (const child of [...tilesGroup.children]) tilesGroup.remove(child);
      rt.cellsRt.clear();
      rt.hits = [];
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(size * PITCH + 0.35, 0.3, size * PITCH + 0.35),
        new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.9 }),
      );
      base.position.y = -0.16;
      tilesGroup.add(base);
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
      cells.forEach((cell, i) => {
        if (cell.kind !== "white" || cell.given) return;
        const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        const [x, z] = cellPos(i, size);
        h.position.set(x, 0.3, z);
        h.userData.pickId = `cell-${i}`;
        tilesGroup.add(h);
        rt.hits.push(h);
      });
      const container = containerRef.current;
      if (container) fitCamera(stage, container, size);
    }

    cells.forEach((cell, i) => {
      const isSelected = selected === i;
      let sig: string;
      let tile: THREE.Mesh;
      if (cell.kind === "black") {
        sig = `b|${cell.across}|${cell.down}`;
        const cur = rt.cellsRt.get(i);
        if (cur && cur.sig === sig) return;
        if (cur) tilesGroup.remove(cur.grp);
        tile = createBlackTile(cell.across, cell.down);
      } else {
        const value = values[i];
        const bad = badCells.has(i);
        const bg = bad ? "#f7e3e0" : cell.given ? "#f1f5f9" : isSelected ? "#dbeafe" : "#ffffff";
        sig = `w|${value}|${bg}|${isSelected ? 1 : 0}`;
        const cur = rt.cellsRt.get(i);
        if (cur && cur.sig === sig) return;
        if (cur) tilesGroup.remove(cur.grp);
        tile = createWhiteTile(bg, value, cell.given, isSelected);
      }
      const grp = new THREE.Group();
      const [x, z] = cellPos(i, size);
      grp.position.set(x, isSelected && cell.kind === "white" ? 0.16 : 0, z);
      grp.add(tile);
      tilesGroup.add(grp);
      rt.cellsRt.set(i, { sig, grp });
    });
  }, [cells, values, size, selected, badCells]);

  return (
    <SceneBox
      height={440}
      label="カックロの盤（3D）。白マスをタップで選び、下にフリックするとチェックします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#334155"
    />
  );
}
