"use client";
// マインスイーパーの 3D 盤。マスは立体タイルで表す:
//   未開 = 盛り上がった立方体 / 開済 = 沈んだ平板 / 旗 = 小さな旗の造形 /
//   地雷 = 黒い球＋棘の造形（絵文字は使わない）。
// 開いたマスの数字は上面テクスチャに大きく描く。数字の色は現行 2D と同じ
// 本文色（--text #252525、現行 2D は数字を色分けしていない）。
// 残り地雷数・経過時間などの状態は親の DOM 併記が担う。
// 入力は現行クライアントの操作語彙どおり:
//   タップ = onCell（旗モード時は旗立て、開いた数字マスはコード入力。
//     どちらも親の onCell が判定する）
//   長押し（500ms 以上）= 旗の付け外し（現行 DOM の右クリック相当。
//     タッチ代替は現行どおり旗モードで、長押しはその補助経路）
//   右クリック（contextmenu）= 旗の付け外し（現行 DOM と同じ）
// 着手可否・合法判定はすべて lib/minesweeper.ts と親ハンドラが決め、
// ここは表現と入力の橋渡しだけを行う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture, createBall } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { MsCell, MsStatus } from "@/lib/minesweeper";

interface Props {
  cells: MsCell[];
  rows: number;
  cols: number;
  exploded: number | null;
  status: MsStatus;
  /** タップ（旗モード・コード入力を含む現行ハンドラ）。 */
  onCell: (index: number) => void;
  /** 旗の付け外し（現行の toggleFlagWithSound）。長押し・右クリックから呼ぶ。 */
  onToggleFlag: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;
const LONG_PRESS_MS = 500;
/** 現行 2D の数字色（セルは本文色を継承する = --text）。 */
const NUMBER_COLOR = "#252525";

function cellPos(index: number, rows: number, cols: number): [number, number] {
  const r = Math.floor(index / cols);
  const c = index % cols;
  return [(c - (cols - 1) / 2) * PITCH, (r - (rows - 1) / 2) * PITCH];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, cols: number, rows: number) {
  const w = container.clientWidth || 640;
  const h = container.clientHeight || 420;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (cols / 2 + 0.9) / Math.tan(hFov / 2);
  const distD = ((rows / 2 + 0.9) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.4;
  stage.setCamera({
    position: [0, dist * 0.82, dist * 0.58],
    lookAt: [0, 0, 0.2],
    fov: 42,
  });
}

/** 小さな旗の造形（現行 2D の FlagIcon と同じ茶色の柱＋赤い旗）。 */
function createFlag(): THREE.Group {
  const grp = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.032, 0.032, 0.52, 8),
    new THREE.MeshStandardMaterial({ color: 0x5d4037, roughness: 0.6 }),
  );
  pole.position.set(-0.14, 0.26, 0);
  grp.add(pole);
  const cloth = new THREE.Mesh(
    new THREE.BoxGeometry(0.36, 0.24, 0.035),
    new THREE.MeshStandardMaterial({ color: 0xe53935, roughness: 0.55 }),
  );
  cloth.position.set(0.05, 0.4, 0);
  grp.add(cloth);
  return grp;
}

/** 地雷の造形（現行 2D の MineIcon と同じ黒い球＋放射状の棘）。 */
function createMine(): THREE.Group {
  const grp = new THREE.Group();
  const core = createBall(0.24, 0x212121, { roughness: 0.35 });
  core.position.y = 0.26;
  grp.add(core);
  const spikeMat = new THREE.MeshStandardMaterial({ color: 0x212121, roughness: 0.4 });
  const spikeGeo = new THREE.CylinderGeometry(0.028, 0.028, 0.64, 6);
  for (let i = 0; i < 4; i++) {
    const spike = new THREE.Mesh(spikeGeo, spikeMat);
    spike.rotation.z = Math.PI / 2;
    const holder = new THREE.Group();
    holder.rotation.y = (i * Math.PI) / 4;
    spike.position.y = 0.26;
    holder.add(spike);
    grp.add(holder);
  }
  const vertical = new THREE.Mesh(spikeGeo, spikeMat);
  vertical.position.y = 0.26;
  grp.add(vertical);
  const shine = createBall(0.07, 0xe0e0e0, { roughness: 0.2 });
  shine.position.set(-0.09, 0.36, 0.14);
  grp.add(shine);
  return grp;
}

/** 数字つき平板（上面いっぱいの大きな数字）。 */
function createNumberPlate(count: number): THREE.Mesh {
  const topTex = canvasTexture(`ms-count-${count}`, 128, 128, (g) => {
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = NUMBER_COLOR;
    g.font = "bold 88px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(count), 64, 68);
  });
  const side = new THREE.MeshStandardMaterial({ color: 0xd9dee2, roughness: 0.7 });
  const top = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.6 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.12, 0.92), [side, side, top, side, side, side]);
  mesh.position.y = 0.06;
  return mesh;
}

/** 色つき平板（地雷マス・空きマス用）。 */
function createFlatPlate(color: number): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.12, 0.92), mat);
  mesh.position.y = 0.06;
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
}

export default function MinesweeperScene3D({
  cells, rows, cols, exploded, status, onCell, onToggleFlag, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onCell, onToggleFlag });
  propsRef.current = { onCell, onToggleFlag };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x3d4a52,
      camera: { position: [0, 9, 6.5], lookAt: [0, 0, 0.2], fov: 42 },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    const tilesGroup = new THREE.Group();
    scene.add(tilesGroup);
    rtRef.current = { stage, tilesGroup, hits: [], hitDims: "", cellsRt: new Map() };

    // 長押し判定用に pointerdown の時刻を控える（タップ自体は attachPickPointer が担う）。
    let downAt = 0;
    const stampDown = () => { downAt = performance.now(); };
    stage.canvas.addEventListener("pointerdown", stampDown);
    // 右クリックは現行 DOM と同じく旗の付け外し。
    const onContextMenu = (e: Event) => {
      e.preventDefault();
      const rt = rtRef.current;
      if (!rt) return;
      const ev = e as PointerEvent;
      const hit = stage.pick(rt.hits, ev.clientX, ev.clientY);
      const id = hit?.object.userData.pickId as string | undefined;
      if (id) propsRef.current.onToggleFlag(Number(id.slice(5)));
    };
    stage.canvas.addEventListener("contextmenu", onContextMenu);

    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (!id) return;
        const index = Number(id.slice(5));
        // 長押しは旗（現行の右クリック／旗モードと同じ toggleFlag 経路）。
        if (downAt > 0 && performance.now() - downAt >= LONG_PRESS_MS) {
          propsRef.current.onToggleFlag(index);
        } else {
          propsRef.current.onCell(index);
        }
      },
    });
    setReady(true);
    return () => {
      stage.canvas.removeEventListener("pointerdown", stampDown);
      stage.canvas.removeEventListener("contextmenu", onContextMenu);
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 盤面同期: 寸法が変わったら土台と当たり判定を作り直し、マスは差分だけ作り直す。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, tilesGroup } = rt;
    const dims = `${rows}x${cols}`;
    if (rt.hitDims !== dims) {
      rt.hitDims = dims;
      // 土台を作り直す（tilesGroup の先頭要素として保持する）。
      for (const child of [...tilesGroup.children]) {
        if (child.userData.isBase) tilesGroup.remove(child);
      }
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(cols * PITCH + 0.35, 0.3, rows * PITCH + 0.35),
        new THREE.MeshStandardMaterial({ color: 0x8fa3ab, roughness: 0.85 }),
      );
      base.position.y = -0.16;
      base.userData.isBase = true;
      tilesGroup.add(base);
      for (const [, c] of rt.cellsRt) tilesGroup.remove(c.grp);
      rt.cellsRt.clear();
      for (const h of rt.hits) tilesGroup.remove(h);
      rt.hits = [];
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
      for (let i = 0; i < rows * cols; i++) {
        const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        const [x, z] = cellPos(i, rows, cols);
        h.position.set(x, 0.3, z);
        h.userData.pickId = `cell-${i}`;
        tilesGroup.add(h);
        rt.hits.push(h);
      }
      const container = containerRef.current;
      if (container) fitCamera(stage, container, cols, rows);
    }

    cells.forEach((cell, i) => {
      const isExploded = exploded === i;
      const sig = `${cell.open ? 1 : 0}|${cell.flagged ? 1 : 0}|${cell.mine ? 1 : 0}|${cell.count}|${isExploded ? 1 : 0}|${status}`;
      const cur = rt.cellsRt.get(i);
      if (cur && cur.sig === sig) return;
      if (cur) tilesGroup.remove(cur.grp);
      const grp = new THREE.Group();
      const [x, z] = cellPos(i, rows, cols);
      grp.position.set(x, 0, z);
      if (!cell.open) {
        // 未開: 盛り上がった立方体。
        const cube = new THREE.Mesh(
          new THREE.BoxGeometry(0.92, 0.5, 0.92),
          new THREE.MeshStandardMaterial({ color: 0x9fc4c0, roughness: 0.55 }),
        );
        cube.position.y = 0.25;
        grp.add(cube);
        if (cell.flagged) {
          const flag = createFlag();
          flag.position.y = 0.5;
          grp.add(flag);
        }
      } else if (cell.mine) {
        grp.add(createFlatPlate(isExploded ? 0xe36a61 : 0xf7e3e0));
        grp.add(createMine());
      } else if (cell.count > 0) {
        grp.add(createNumberPlate(cell.count));
      } else {
        grp.add(createFlatPlate(0xffffff));
      }
      tilesGroup.add(grp);
      rt.cellsRt.set(i, { sig, grp });
    });
  }, [cells, rows, cols, exploded, status]);

  const height = Math.max(300, Math.min(500, Math.round(560 * (rows / cols))));
  return (
    <SceneBox
      height={height}
      label="マインスイーパーの盤（3D）。マスをタップで開き、長押しで旗を立てます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#3d4a52"
    />
  );
}
