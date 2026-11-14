"use client";
// バイナリー（Binairo）の 3D 盤。マスは立体タイルで表す:
//   0 / 1 は上面テクスチャに大きく描く（128px キャンバスに 88px 級）。
//   与えマス = 太字の本文色＋灰色面 / 入力値 = アクセント色で現行 2D と
//   揃え、違反マスは赤系の面色にする。空きマスは一段沈んだ平板にする。
// 入力は現行クライアントの操作語彙どおり:
//   タップ = onCell（空き→0→1→空き の循環は親ハンドラが担う）
// 判定・合法性はすべて lib/binairo.ts と親ハンドラが決め、ここは表現と
// 入力の橋渡しだけを行う。与えマスは現行 2D と同じく当たり判定を
// 持たない（タップしても何も起きない）。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { BinairoValue } from "@/lib/binairo";

interface Props {
  board: BinairoValue[];
  givens: boolean[];
  size: number;
  badCells: Set<number>;
  /** タップ（現行の循環ハンドラへ接続）。 */
  onCell: (index: number) => void;
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
  const w = container.clientWidth || 420;
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

/** 上面テクスチャつきタイル。0/1 は大きく描く。 */
function createTile(bg: string, value: BinairoValue, given: boolean): THREE.Mesh {
  const key = `binairo-${bg}-${value}-${given ? 1 : 0}`;
  const topTex = canvasTexture(key, 128, 128, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, 128, 128);
    if (value !== -1) {
      // 入力値は現行 2D のアクセント色、与えマスは本文色の太字。
      g.fillStyle = given ? "#252525" : "#2563eb";
      g.font = given ? "bold 88px sans-serif" : "600 88px sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(String(value), 64, 68);
    }
  });
  const sideColor = new THREE.Color(bg).multiplyScalar(0.85);
  const side = new THREE.MeshStandardMaterial({ color: sideColor, roughness: 0.65 });
  const top = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.55 });
  const raised = value !== -1;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.92, raised ? 0.34 : 0.18, 0.92),
    [side, side, top, side, side, side],
  );
  mesh.position.y = raised ? 0.17 : 0.09;
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

export default function BinairoScene3D({ board, givens, size, badCells, onCell, onFail, fallback }: Props) {
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
    });
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 盤面同期: サイズが変わったら土台と当たり判定を作り直し（当たり判定は
  // 与えマス以外）、タイルは署名差分だけ作り直す。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, tilesGroup } = rt;
    const buildKey = `${size}|${givens.map((g) => (g ? 1 : 0)).join("")}`;
    if (rt.builtKey !== buildKey) {
      rt.builtKey = buildKey;
      for (const child of [...tilesGroup.children]) tilesGroup.remove(child);
      rt.cellsRt.clear();
      rt.hits = [];
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(size * PITCH + 0.35, 0.3, size * PITCH + 0.35),
        new THREE.MeshStandardMaterial({ color: 0x8fa3ab, roughness: 0.85 }),
      );
      base.position.y = -0.16;
      tilesGroup.add(base);
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
      for (let i = 0; i < size * size; i++) {
        if (givens[i]) continue;
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

    board.forEach((value, i) => {
      const given = givens[i];
      const bad = badCells.has(i);
      const bg = bad ? "#f7e3e0" : given ? "#e8eaed" : "#ffffff";
      const sig = `${value}|${bg}|${given ? 1 : 0}`;
      const cur = rt.cellsRt.get(i);
      if (cur && cur.sig === sig) return;
      if (cur) tilesGroup.remove(cur.grp);
      const grp = new THREE.Group();
      const [x, z] = cellPos(i, size);
      grp.position.set(x, 0, z);
      grp.add(createTile(bg, value, given));
      tilesGroup.add(grp);
      rt.cellsRt.set(i, { sig, grp });
    });
  }, [board, givens, size, badCells]);

  return (
    <SceneBox
      height={400}
      label="バイナリーの盤（3D）。マスをタップすると 0 と 1 が切り替わります"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#3d4a52"
    />
  );
}
