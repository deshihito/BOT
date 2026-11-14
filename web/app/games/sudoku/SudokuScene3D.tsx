"use client";
// 数独の 3D 盤。マスは立体タイルで表す:
//   数字は上面テクスチャに大きく描く（128px キャンバスに 84px 級）。
//   与え数字 = 濃色・太字 / 入力値 = 青 / 矛盾・ミス = 赤系の面色＋赤字で
//   現行 2D の色分けと揃える。同行列ブロック・同値ハイライトも 2D の
//   bg 色に対応する面色で表し、選択マスは持ち上げ＋発光させる。
//   メモは細字で描かず、候補数字の位置（3×3）に対応するドットで表す
//   （情報の正は親 DOM のメモ注記が担保する）。
//   3×3 ブロック境界はタイル間の溝を広げて表現する。
// 入力は現行クライアントの操作語彙どおり:
//   タップ = onCell（選択。数字入力は親の DOM パッドが担う）
//   上フリック = onHint（現行の盤面スワイプ＝ヒントを維持する）
// 判定・合法性はすべて lib/sudoku.ts と親ハンドラが決め、ここは表現と
// 入力の橋渡しだけを行う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

interface Props {
  board: number[];
  givens: boolean[];
  notes: number[][];
  selected: number | null;
  conflicts: Set<number>;
  /** 解答と食い違うマス（親が lib の isMistake で判定済み）。 */
  mistakes: Set<number>;
  lastHint: number | null;
  /** タップ（現行の選択ハンドラへ接続）。 */
  onCell: (index: number) => void;
  /** 上フリック（現行のヒントへ接続）。 */
  onHint: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const SIZE = 9;
const PITCH = 1.0;
const BLOCK_GAP = 0.14;

function cellPos(index: number): [number, number] {
  const r = Math.floor(index / SIZE);
  const c = index % SIZE;
  const bx = Math.floor(c / 3) - 1;
  const bz = Math.floor(r / 3) - 1;
  return [(c - 4) * PITCH + bx * BLOCK_GAP, (r - 4) * PITCH + bz * BLOCK_GAP];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement) {
  const w = container.clientWidth || 450;
  const h = container.clientHeight || 450;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (SIZE / 2 + 1.0) / Math.tan(hFov / 2);
  const distD = ((SIZE / 2 + 1.0) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.4;
  stage.setCamera({
    position: [0, dist * 0.86, dist * 0.52],
    lookAt: [0, 0, 0.2],
    fov: 42,
  });
}

/** セルの面色（現行 2D の bg 色分けに対応）。 */
function cellColors(
  i: number,
  board: number[],
  selected: number | null,
  conflicts: Set<number>,
  lastHint: number | null,
  isMistakeCell: boolean,
): { bg: string; fg: string } {
  const value = board[i];
  const selectedValue = selected !== null ? board[selected] : 0;
  let bg = "#ffffff";
  if (selected !== null) {
    const sr = Math.floor(selected / 9);
    const sc = selected % 9;
    const r = Math.floor(i / 9);
    const c = i % 9;
    const sameUnit =
      sr === r || sc === c ||
      (Math.floor(sr / 3) === Math.floor(r / 3) && Math.floor(sc / 3) === Math.floor(c / 3));
    if (sameUnit) bg = "#eff6ff";
    if (value !== 0 && selectedValue !== 0 && value === selectedValue) bg = "#dbeafe";
  }
  if (selected === i) bg = "#bfdbfe";
  if (lastHint === i) bg = "#d1fae5";
  const bad = conflicts.has(i) || isMistakeCell;
  if (bad) bg = selected === i ? "#fecaca" : "#fee2e2";
  return { bg, fg: bad ? "#b91c1c" : "#2563eb" };
}

/** 上面テクスチャつきタイル。数字は大きく、メモはドットで表す。 */
function createTile(
  bg: string,
  value: number,
  isGiven: boolean,
  fg: string,
  notes: number[],
  selected: boolean,
): THREE.Mesh {
  const key = `sudoku-${bg}-${value}-${isGiven ? 1 : 0}-${fg}-${notes.join(".")}`;
  const topTex = canvasTexture(key, 128, 128, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, 128, 128);
    if (value !== 0) {
      g.fillStyle = isGiven ? "#111827" : fg;
      g.font = isGiven ? "bold 86px sans-serif" : "600 84px sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(value), 64, 68);
    } else if (notes.length > 0) {
      // メモは細字にせず、数字の位置（3×3）に対応するドットで表す。
      g.fillStyle = "#64748b";
      for (const n of notes) {
        const dx = 32 + ((n - 1) % 3) * 32;
        const dy = 32 + Math.floor((n - 1) / 3) * 32;
        g.beginPath();
        g.arc(dx, dy, 9, 0, Math.PI * 2);
        g.fill();
      }
    }
  });
  const sideColor = new THREE.Color(bg).multiplyScalar(0.82);
  const side = new THREE.MeshStandardMaterial({ color: sideColor, roughness: 0.65 });
  const top = new THREE.MeshStandardMaterial({
    map: topTex,
    roughness: 0.55,
    emissive: selected ? new THREE.Color(0x3b82f6) : new THREE.Color(0x000000),
    emissiveIntensity: selected ? 0.35 : 0,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.3, 0.92), [side, side, top, side, side, side]);
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
  built: boolean;
}

export default function SudokuScene3D({
  board, givens, notes, selected, conflicts, mistakes, lastHint, onCell, onHint, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onCell, onHint });
  propsRef.current = { onCell, onHint };
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
    rtRef.current = { stage, tilesGroup, hits: [], cellsRt: new Map(), built: false };

    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (id) propsRef.current.onCell(Number(id.slice(5)));
      },
      onFlick: (flick) => {
        if (flick.dir === "up") propsRef.current.onHint();
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

  // 盤面同期: 初回に土台と当たり判定を作り、マスは署名差分だけ作り直す。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, tilesGroup } = rt;
    if (!rt.built) {
      rt.built = true;
      const extent = SIZE * PITCH + BLOCK_GAP * 2 + 0.35;
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(extent, 0.3, extent),
        new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.9 }),
      );
      base.position.y = -0.16;
      tilesGroup.add(base);
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
      for (let i = 0; i < SIZE * SIZE; i++) {
        const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        const [x, z] = cellPos(i);
        h.position.set(x, 0.3, z);
        h.userData.pickId = `cell-${i}`;
        tilesGroup.add(h);
        rt.hits.push(h);
      }
      const container = containerRef.current;
      if (container) fitCamera(stage, container);
    }

    board.forEach((value, i) => {
      const isGiven = givens[i];
      const { bg, fg } = cellColors(i, board, selected, conflicts, lastHint, mistakes.has(i));
      const cellNotes = value === 0 ? notes[i] ?? [] : [];
      const isSelected = selected === i;
      const sig = `${value}|${isGiven ? 1 : 0}|${bg}|${fg}|${cellNotes.join(",")}|${isSelected ? 1 : 0}`;
      const cur = rt.cellsRt.get(i);
      if (cur && cur.sig === sig) return;
      if (cur) tilesGroup.remove(cur.grp);
      const grp = new THREE.Group();
      const [x, z] = cellPos(i);
      grp.position.set(x, isSelected ? 0.16 : 0, z);
      grp.add(createTile(bg, value, isGiven, fg, cellNotes, isSelected));
      tilesGroup.add(grp);
      rt.cellsRt.set(i, { sig, grp });
    });
  }, [board, givens, notes, selected, conflicts, mistakes, lastHint]);

  return (
    <SceneBox
      height={440}
      label="数独の盤（3D）。マスをタップで選び、上にフリックするとヒントを使います"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#334155"
    />
  );
}
