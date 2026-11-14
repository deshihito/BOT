"use client";
// パイプつなぎの 3D 盤。タイルは土台の上に開口方向へ腕を伸ばす立体部品
// として造形する: 直管は貫通した腕、曲管は直角に曲がる2本の腕、十字・
// 三方は腕の本数で判別できる（開口の向きは lib の純粋関数から読むだけ）。
// 水が届くマスかどうかは親が判定した結果（flow）をそのまま色と発光で
// 表し、水の伝播はここでは計算しない。水源は青い雫の造形＋青リング、
// 排水口は黒い穴の円盤で示す（現行 2D の意匠に合わせる）。
// 入力はタイルのタップだけ: 親の回転ハンドラへそのまま渡す。
// 手数・時間・状態テキストは親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import { pipeOpenings, type PipeCell, type PipeState } from "@/lib/pipe";

interface Props {
  state: PipeState;
  /** 水が届くマスの index 一覧（親が lib で判定した結果）。 */
  flow: number[];
  /** タイルタップ（現行の回転ハンドラ）。 */
  onTile: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;
const FLOW_COLOR = 0x38bdf8;
const IDLE_COLOR = 0x94a3b8;
// 方向 0=北 1=東 2=南 3=西 → 盤面ベクトル（北は奥 = -z）。
const DIR_VEC: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

function cellPos(index: number, size: number): [number, number] {
  const r = Math.floor(index / size);
  const c = index % size;
  return [(c - (size - 1) / 2) * PITCH, (r - (size - 1) / 2) * PITCH];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, size: number) {
  const w = container.clientWidth || 420;
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

/** パイプ部品1マス分。開口ごとに腕を伸ばし、中心にハブを置く。 */
function createPipePiece(cell: PipeCell, flowing: boolean): THREE.Group {
  const grp = new THREE.Group();
  const color = flowing ? FLOW_COLOR : IDLE_COLOR;
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.35,
    metalness: 0.25,
    emissive: flowing ? 0x0e6ea8 : 0x000000,
    emissiveIntensity: flowing ? 0.5 : 0,
  });
  for (const d of pipeOpenings(cell)) {
    const [dx, dz] = DIR_VEC[d];
    const alongX = dx !== 0;
    const arm = new THREE.Mesh(
      alongX ? new THREE.BoxGeometry(0.62, 0.26, 0.3) : new THREE.BoxGeometry(0.3, 0.26, 0.62),
      mat,
    );
    arm.position.set(dx * 0.26, 0.25, dz * 0.26);
    grp.add(arm);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.3, 20), mat);
  hub.position.y = 0.25;
  grp.add(hub);
  if (cell.kind === "end") {
    // 栓つき端: ハブに蓋の球を載せ、開口1つと区別できる形にする。
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10), mat);
    cap.position.y = 0.44;
    grp.add(cap);
  }
  return grp;
}

interface CellRt {
  sig: string;
  grp: THREE.Group;
}

interface SceneRt {
  stage: Stage;
  boardGroup: THREE.Group;
  hits: THREE.Mesh[];
  built: boolean;
  cellsRt: Map<number, CellRt>;
}

export default function PipeScene3D({ state, flow, onTile, onFail, fallback }: Props) {
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
      background: 0xdfeaf2,
      camera: { position: [0, 8.6, 6], lookAt: [0, 0, 0.2], fov: 42 },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const boardGroup = new THREE.Group();
    stage.scene.add(boardGroup);
    rtRef.current = { stage, boardGroup, hits: [], built: false, cellsRt: new Map() };
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

  // 盤面同期: 土台と当たり判定は初回だけ作り、タイルは差分同期する。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, boardGroup } = rt;
    const size = state.size;
    if (!rt.built) {
      rt.built = true;
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(size * PITCH + 0.4, 0.3, size * PITCH + 0.4),
        new THREE.MeshStandardMaterial({ color: 0x7d8ea0, roughness: 0.85 }),
      );
      slab.position.y = -0.15;
      boardGroup.add(slab);
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
      for (let i = 0; i < size * size; i++) {
        const [x, z] = cellPos(i, size);
        const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        h.position.set(x, 0.3, z);
        h.userData.pickId = `cell-${i}`;
        boardGroup.add(h);
        rt.hits.push(h);
      }
      const container = containerRef.current;
      if (container) fitCamera(stage, container, size);
    }

    const flowSet = new Set(flow);
    for (let i = 0; i < state.cells.length; i++) {
      const cell = state.cells[i];
      const flowing = flowSet.has(i);
      const isSource = i === state.source;
      const isDrain = i === state.drain;
      const sig = `${cell.kind}:${cell.rotation}:${flowing ? 1 : 0}:${isSource ? 1 : 0}:${isDrain ? 1 : 0}`;
      const cur = rt.cellsRt.get(i);
      if (cur && cur.sig === sig) continue;
      if (cur) boardGroup.remove(cur.grp);
      const grp = new THREE.Group();
      const [x, z] = cellPos(i, size);
      grp.position.set(x, 0, z);
      // マスの土台タイル（水源=水色 / 排水口=淡黄 / 通水=淡青 / 通常=淡灰）。
      const tileMat = new THREE.MeshStandardMaterial({
        color: isSource ? 0xe0f2fe : isDrain ? 0xfef3c7 : flowing ? 0xf0f9ff : 0xf8fafc,
        roughness: 0.8,
      });
      const tile = new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.1, 0.94), tileMat);
      tile.position.y = 0.05;
      grp.add(tile);
      grp.add(createPipePiece(cell, flowing));
      if (isSource) {
        // 水源: 青リングと雫（球＋円錐）の造形で示す。
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.4, 0.035, 8, 28),
          new THREE.MeshStandardMaterial({ color: 0x0284c7, roughness: 0.4 }),
        );
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.11;
        grp.add(ring);
        const drop = new THREE.Group();
        const dropBody = new THREE.Mesh(
          new THREE.SphereGeometry(0.11, 14, 10),
          new THREE.MeshStandardMaterial({ color: 0x2196f3, roughness: 0.2 }),
        );
        dropBody.position.set(-0.32, 0.2, -0.32);
        drop.add(dropBody);
        const dropTip = new THREE.Mesh(
          new THREE.ConeGeometry(0.07, 0.14, 12),
          new THREE.MeshStandardMaterial({ color: 0x2196f3, roughness: 0.2 }),
        );
        dropTip.position.set(-0.32, 0.34, -0.32);
        drop.add(dropTip);
        grp.add(drop);
      }
      if (isDrain) {
        // 排水口: 黒い穴の円盤で示す。
        const hole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.16, 0.16, 0.05, 20),
          new THREE.MeshStandardMaterial({ color: 0x263238, roughness: 0.9 }),
        );
        hole.position.set(0.32, 0.12, 0.32);
        grp.add(hole);
      }
      boardGroup.add(grp);
      rt.cellsRt.set(i, { sig, grp });
    }
  }, [state, flow]);

  return (
    <SceneBox
      height={440}
      label="パイプつなぎの盤（3D）。タイルをタップすると90度回転します"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#dfeaf2"
    />
  );
}
