"use client";
// スラント（ごきげんななめ）の 3D 盤。
// 斜線は薄い直方体を45度回転させてマス内に立てる造形で表す
// （mark 1 = 右上がり「/」、mark 2 = 右下がり「\」。lib/slant.ts の定義どおり）。
// 交点の数字は盤の格子点の情報なので、マスではなく格子点の位置へ
// 小さな円盤＋上面テクスチャの数字で置く（現行 2D の SVG 円＋数字と同じ配置）。
// 違反のあるマスは赤みのある面色、違反のある格子点は赤い円盤で示す
// （現行 2D のハイライトと同じ情報）。状態表示は親の DOM 併記が担う。
// 入力は現行クライアントの操作語彙どおり:
//   タップ = onCell（未定→/→\→未定の循環は lib/slant.ts と親が決める）
// ルール検証・完成判定はすべて lib と親が決め、ここは表現と入力の
// 橋渡しだけを行う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { SlantMark } from "@/lib/slant";

interface Props {
  board: SlantMark[];
  clues: (number | null)[];
  width: number;
  height: number;
  badCells: number[];
  badPoints: number[];
  status: "playing" | "won";
  /** タップ（現行の handleCell へ接続）。 */
  onCell: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;

function cellPos(index: number, width: number, height: number): [number, number] {
  const r = Math.floor(index / width);
  const c = index % width;
  return [(c - (width - 1) / 2) * PITCH, (r - (height - 1) / 2) * PITCH];
}

/** 格子点の位置（点は (height+1) 行 × (width+1) 列）。 */
function pointPos(p: number, width: number, height: number): [number, number] {
  const pr = Math.floor(p / (width + 1));
  const pc = p % (width + 1);
  return [(pc - width / 2) * PITCH, (pr - height / 2) * PITCH];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, width: number, height: number) {
  const w = container.clientWidth || 440;
  const h = container.clientHeight || 420;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (width / 2 + 0.9) / Math.tan(hFov / 2);
  const distD = ((height / 2 + 0.9) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.4;
  stage.setCamera({
    position: [0, dist * 0.82, dist * 0.58],
    lookAt: [0, 0, 0.2],
    fov: 42,
  });
}

/** 斜線の造形（マスの対角に届く薄い直方体を45度回転）。 */
function createSlash(mark: 1 | 2): THREE.Mesh {
  const len = Math.SQRT2 * 0.94;
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(len, 0.09, 0.15),
    // 現行 2D の斜線色（--accent #427f87）。
    new THREE.MeshStandardMaterial({ color: 0x427f87, roughness: 0.45 }),
  );
  // mark 1「/」は左下—右上、mark 2「\」は左上—右下（画面手前が +z）。
  bar.rotation.y = mark === 1 ? Math.PI / 4 : -Math.PI / 4;
  bar.position.y = 0.17;
  return bar;
}

/** 格子点の数字円盤（上面テクスチャに数字を描く）。 */
function createClueDisc(value: number, bad: boolean): THREE.Mesh {
  const topTex = canvasTexture(`slant-pt-${value}-${bad ? "bad" : "ok"}`, 96, 96, (g) => {
    g.fillStyle = bad ? "#f7e3e0" : "#ffffff";
    g.beginPath();
    g.arc(48, 48, 47, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = bad ? "#d94837" : "#b9b2a6";
    g.lineWidth = 3;
    g.beginPath();
    g.arc(48, 48, 44, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = bad ? "#d94837" : "#252525";
    g.font = "bold 52px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(value), 48, 51);
  });
  const side = new THREE.MeshStandardMaterial({ color: bad ? 0xd94837 : 0xb9b2a6, roughness: 0.6 });
  const top = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.55, transparent: true });
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.07, 24), [side, top, side]);
  mesh.position.y = 0.16;
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
  hitDims: string;
  cellsRt: Map<number, CellRt>;
  pointsRt: Map<number, CellRt>;
}

export default function SlantScene3D({
  board, clues, width, height, badCells, badPoints, status, onCell, onFail, fallback,
}: Props) {
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
      background: 0x384048,
      camera: { position: [0, 7.5, 5.2], lookAt: [0, 0, 0.2], fov: 42 },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    const tilesGroup = new THREE.Group();
    scene.add(tilesGroup);
    rtRef.current = { stage, tilesGroup, hits: [], hitDims: "", cellsRt: new Map(), pointsRt: new Map() };

    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (id) propsRef.current.onCell(Number(id.slice(5)));
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

  // 盤面同期: 寸法が変わったら土台と当たり判定を作り直し、マスと格子点は差分だけ作り直す。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, tilesGroup } = rt;
    const dims = `${width}x${height}`;
    if (rt.hitDims !== dims) {
      rt.hitDims = dims;
      for (const child of [...tilesGroup.children]) {
        if (child.userData.isBase) tilesGroup.remove(child);
      }
      const topTex = canvasTexture(`slant-base-${dims}`, 512, 512, (g) => {
        g.fillStyle = "#fdfcf8";
        g.fillRect(0, 0, 512, 512);
        g.strokeStyle = "#cfc9bb";
        g.lineWidth = 2;
        for (let pc = 0; pc <= width; pc++) {
          const x = (pc / width) * 512;
          g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 512); g.stroke();
        }
        for (let pr = 0; pr <= height; pr++) {
          const y = (pr / height) * 512;
          g.beginPath(); g.moveTo(0, y); g.lineTo(512, y); g.stroke();
        }
      });
      const side = new THREE.MeshStandardMaterial({ color: 0x8b95a1, roughness: 0.85 });
      const top = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.85 });
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(width * PITCH + 0.35, 0.3, height * PITCH + 0.35),
        [side, side, top, side, side, side],
      );
      base.position.y = -0.16;
      base.userData.isBase = true;
      tilesGroup.add(base);
      for (const [, c] of rt.cellsRt) tilesGroup.remove(c.grp);
      rt.cellsRt.clear();
      for (const [, p] of rt.pointsRt) tilesGroup.remove(p.grp);
      rt.pointsRt.clear();
      for (const h of rt.hits) tilesGroup.remove(h);
      rt.hits = [];
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
      for (let i = 0; i < width * height; i++) {
        const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        const [x, z] = cellPos(i, width, height);
        h.position.set(x, 0.3, z);
        h.userData.pickId = `cell-${i}`;
        tilesGroup.add(h);
        rt.hits.push(h);
      }
      const container = containerRef.current;
      if (container) fitCamera(stage, container, width, height);
    }

    const badCellSet = new Set(badCells);
    board.forEach((mark, i) => {
      const bad = badCellSet.has(i);
      const sig = `${mark}|${bad ? 1 : 0}|${status}`;
      const cur = rt.cellsRt.get(i);
      if (cur && cur.sig === sig) return;
      if (cur) tilesGroup.remove(cur.grp);
      const grp = new THREE.Group();
      const [x, z] = cellPos(i, width, height);
      grp.position.set(x, 0, z);
      const plate = new THREE.Mesh(
        new THREE.BoxGeometry(0.94, 0.12, 0.94),
        new THREE.MeshStandardMaterial({ color: bad ? 0xf3c1bb : 0xfdfcf8, roughness: 0.7 }),
      );
      plate.position.y = 0.06;
      grp.add(plate);
      if (mark !== 0) grp.add(createSlash(mark));
      tilesGroup.add(grp);
      rt.cellsRt.set(i, { sig, grp });
    });

    const badPointSet = new Set(badPoints);
    clues.forEach((clue, p) => {
      const bad = badPointSet.has(p);
      const sig = `${clue ?? "-"}|${bad ? 1 : 0}`;
      const cur = rt.pointsRt.get(p);
      if (cur && cur.sig === sig) return;
      if (cur) tilesGroup.remove(cur.grp);
      const grp = new THREE.Group();
      const [x, z] = pointPos(p, width, height);
      grp.position.set(x, 0, z);
      if (clue !== null) {
        grp.add(createClueDisc(clue, bad));
      } else {
        // 数字のない格子点は小さなドットで格子を示す。
        const dot = new THREE.Mesh(
          new THREE.CylinderGeometry(0.05, 0.05, 0.05, 10),
          new THREE.MeshStandardMaterial({ color: 0x9a938a, roughness: 0.7 }),
        );
        dot.position.y = 0.14;
        grp.add(dot);
      }
      tilesGroup.add(grp);
      rt.pointsRt.set(p, { sig, grp });
    });
  }, [board, clues, width, height, badCells, badPoints, status]);

  return (
    <SceneBox
      height={420}
      label="スラントの盤（3D）。マスをタップすると斜線が切り替わります"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#384048"
    />
  );
}
