"use client";
// 15パズルの 3D 盤。タイルは立体タイルで表し、上面に数字を大きく描く
// （minesweeper の数字手法と同じく canvasTexture を上面いっぱいに使う）。
// 正しい位置にあるタイルは現行 2D と同じく緑がかった面にする。空白は
// 沈んだスロットとして表す。タイルの移動は onFrame の補間でスライド
// アニメーションさせる（ロジック側の状態遷移は即時で、見た目だけ追従する）。
// 入力は現行クライアントの操作語彙どおり:
//   タップ = onTile（空白と同じ行・列のまとめてスライドも含め、判定は
//     すべて lib/fifteen.ts の canSlide と親ハンドラが行う）
// 手数・時間・完成形の並びなどの状態は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { FifteenStatus } from "@/lib/fifteen";

interface Props {
  tiles: number[];
  size: number;
  status: FifteenStatus;
  /** タップ（現行の handleTile へ接続）。 */
  onTile: (index: number) => void;
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

/** 数字つき立体タイル（上面いっぱいの大きな数字）。 */
function createTileMesh(value: number, correct: boolean): THREE.Mesh {
  const bg = correct ? "#dcfce7" : "#ffffff";
  const topTex = canvasTexture(`fifteen-tile-${value}-${correct ? 1 : 0}`, 160, 160, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, 160, 160);
    g.fillStyle = "#1e293b";
    const text = String(value);
    g.font = `bold ${text.length >= 2 ? 84 : 104}px sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, 80, 86);
  });
  const side = new THREE.MeshStandardMaterial({ color: correct ? 0xa9d9b8 : 0x94a3b8, roughness: 0.55 });
  const top = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.5 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.34, 0.92), [side, side, top, side, side, side]);
  mesh.position.y = 0.17;
  return mesh;
}

interface TileRt {
  grp: THREE.Group;
  correct: boolean;
  tx: number;
  tz: number;
}

interface SceneRt {
  stage: Stage;
  boardGroup: THREE.Group;
  hits: THREE.Mesh[];
  hitSize: number;
  tilesRt: Map<number, TileRt>;
  blankGrp: THREE.Group | null;
  builtSize: number;
}

export default function FifteenScene3D({ tiles, size, status, onTile, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onTile });
  propsRef.current = { onTile };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x3a4550,
      camera: { position: [0, 7, 5], lookAt: [0, 0, 0.2], fov: 42 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        // タイルを目標マスへ滑らかに追従させる（スライドアニメーション）。
        const k = 1 - Math.exp(-dt * 13);
        for (const t of rt.tilesRt.values()) {
          t.grp.position.x += (t.tx - t.grp.position.x) * k;
          t.grp.position.z += (t.tz - t.grp.position.z) * k;
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    const boardGroup = new THREE.Group();
    scene.add(boardGroup);
    rtRef.current = { stage, boardGroup, hits: [], hitSize: 0, tilesRt: new Map(), blankGrp: null, builtSize: 0 };

    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (id) propsRef.current.onTile(Number(id.slice(5)));
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

  // 盤面同期: サイズが変わったら土台・当たり判定・タイルを作り直し、
  // それ以外はタイルの目標位置と正誤（面の色）だけを更新する。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, boardGroup } = rt;
    if (rt.builtSize !== size) {
      rt.builtSize = size;
      for (const child of [...boardGroup.children]) boardGroup.remove(child);
      rt.tilesRt.clear();
      rt.blankGrp = null;
      rt.hits = [];
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(size * PITCH + 0.35, 0.3, size * PITCH + 0.35),
        new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.85 }),
      );
      base.position.y = -0.16;
      boardGroup.add(base);
      // 全マスのスロット（沈んだ下地）。タイルの下に敷く。
      const slotGeo = new THREE.BoxGeometry(0.92, 0.08, 0.92);
      const slotMat = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.9 });
      for (let i = 0; i < size * size; i++) {
        const slot = new THREE.Mesh(slotGeo, slotMat);
        const [x, z] = cellPos(i, size);
        slot.position.set(x, 0.04, z);
        boardGroup.add(slot);
      }
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
      for (let i = 0; i < size * size; i++) {
        const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        const [x, z] = cellPos(i, size);
        h.position.set(x, 0.3, z);
        h.userData.pickId = `cell-${i}`;
        boardGroup.add(h);
        rt.hits.push(h);
      }
      const containerEl = containerRef.current;
      if (containerEl) fitCamera(stage, containerEl, size);
    }

    tiles.forEach((value, i) => {
      const [x, z] = cellPos(i, size);
      if (value === 0) {
        // 空白マーカー: スロットの上に薄い枠だけを置く（沈み込み表現）。
        if (!rt.blankGrp) {
          rt.blankGrp = new THREE.Group();
          const rim = new THREE.Mesh(
            new THREE.BoxGeometry(0.8, 0.05, 0.8),
            new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.9 }),
          );
          rim.position.y = 0.1;
          rt.blankGrp.add(rim);
          boardGroup.add(rt.blankGrp);
        }
        rt.blankGrp.position.set(x, 0, z);
        return;
      }
      const correct = value === i + 1;
      let t = rt.tilesRt.get(value);
      if (!t) {
        const grp = new THREE.Group();
        grp.add(createTileMesh(value, correct));
        grp.position.set(x, status === "won" ? 0.06 : 0, z);
        boardGroup.add(grp);
        t = { grp, correct, tx: x, tz: z };
        rt.tilesRt.set(value, t);
      }
      if (t.correct !== correct) {
        // 正誤が変わったら面の色（テクスチャ）を差し替える。位置は grp が保持する。
        t.correct = correct;
        for (const child of [...t.grp.children]) t.grp.remove(child);
        t.grp.add(createTileMesh(value, correct));
      }
      t.tx = x;
      t.tz = z;
      // 完成時は全タイルを少し浮かせて揃ったことを示す。
      t.grp.position.y = status === "won" ? 0.06 : 0;
    });
  }, [tiles, size, status]);

  return (
    <SceneBox
      height={420}
      label="15パズルの盤（3D）。タイルをタップすると空白へスライドします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#3a4550"
    />
  );
}
