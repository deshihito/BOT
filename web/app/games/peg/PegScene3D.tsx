"use client";
// ペグソリティアの 3D 盤。英式33穴の十字型: 穴は木盤に沈んだ円盤、
// ペグは three-kit の createStone（扁平な球）で表す（現行 2D の青い丸と
// 同じ青、絵文字は使わない）。選択中のペグは持ち上げ＋金色に発光させ、
// 移動できる空き穴は現行 2D と同じ緑に光らせる。
// 入力は現行の順序どおりタップだけ:
//   ペグタップ = 選択 / 空き穴タップ = 移動（どちらも親の onCell が判定し、
//   移動先の集合も親が pegMovesFrom で計算して destinations で渡す）。
// 跳躍で消えるペグ・現れるペグは差分同期（現れたペグは落下で着地する）。
// 残りペグ数・手数・評価は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { createStone } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import { isPegHole, PEG_SIZE, type PegCell } from "@/lib/peg";

interface Props {
  cells: PegCell[];
  selected: number | null;
  /** 選択中ペグの移動先 index 一覧（親が pegMovesFrom で計算）。 */
  destinations: number[];
  status: "playing" | "stuck" | "cleared";
  /** タップ（現行の onCell ハンドラ。選択→移動の順序は親が持つ）。 */
  onCell: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;
const PEG_COLOR = 0x7d94c4;
const PEG_SELECTED_COLOR = 0xe0a92e;

function cellPos(index: number): [number, number] {
  const r = Math.floor(index / PEG_SIZE);
  const c = index % PEG_SIZE;
  return [(c - (PEG_SIZE - 1) / 2) * PITCH, (r - (PEG_SIZE - 1) / 2) * PITCH];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement) {
  const w = container.clientWidth || 420;
  const h = container.clientHeight || 440;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (PEG_SIZE / 2 + 0.9) / Math.tan(hFov / 2);
  const distD = ((PEG_SIZE / 2 + 0.9) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.4;
  stage.setCamera({
    position: [0, dist * 0.82, dist * 0.58],
    lookAt: [0, 0, 0.2],
    fov: 42,
  });
}

interface PegRt {
  grp: THREE.Group;
  selected: boolean;
  /** 着地・持ち上げの目標高さ（補間は onFrame）。 */
  ty: number;
}

interface SceneRt {
  stage: Stage;
  boardGroup: THREE.Group;
  hits: THREE.Mesh[];
  built: boolean;
  pegsRt: Map<number, PegRt>;
  holeMats: Map<number, THREE.MeshStandardMaterial>;
}

export default function PegScene3D({ cells, selected, destinations, status, onCell, onFail, fallback }: Props) {
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
      background: 0x4a3520,
      camera: { position: [0, 8.6, 6], lookAt: [0, 0, 0.2], fov: 42 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        // ペグの着地・持ち上げを滑らかに追従させる。
        const k = 1 - Math.exp(-dt * 12);
        for (const p of rt.pegsRt.values()) {
          p.grp.position.y += (p.ty - p.grp.position.y) * k;
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
    rtRef.current = { stage, boardGroup, hits: [], built: false, pegsRt: new Map(), holeMats: new Map() };

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

  // 盤面同期: 木盤と穴は初回だけ作り、ペグは差分同期する。
  // 穴の色は状態で切り替える（通常=沈んだ暗色 / 移動先=緑）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, boardGroup } = rt;
    if (!rt.built) {
      rt.built = true;
      // 木盤（現行 2D の茶色い盤）。
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(PEG_SIZE * PITCH + 0.5, 0.34, PEG_SIZE * PITCH + 0.5),
        new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.8 }),
      );
      slab.position.y = -0.17;
      boardGroup.add(slab);
      const holeGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.07, 24);
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
      for (let r = 0; r < PEG_SIZE; r++) {
        for (let c = 0; c < PEG_SIZE; c++) {
          if (!isPegHole(r, c)) continue;
          const i = r * PEG_SIZE + c;
          const [x, z] = cellPos(i);
          const mat = new THREE.MeshStandardMaterial({ color: 0x4a2f16, roughness: 0.9 });
          const disc = new THREE.Mesh(holeGeo, mat);
          disc.position.set(x, 0.035, z);
          boardGroup.add(disc);
          rt.holeMats.set(i, mat);
          const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
          h.position.set(x, 0.3, z);
          h.userData.pickId = `cell-${i}`;
          boardGroup.add(h);
          rt.hits.push(h);
        }
      }
      const container = containerRef.current;
      if (container) fitCamera(stage, container);
    }

    const destSet = new Set(destinations);
    for (const [i, mat] of rt.holeMats) {
      const isDest = destSet.has(i) && status === "playing";
      mat.color.setHex(isDest ? 0x7ce38b : 0x4a2f16);
      mat.emissive.setHex(isDest ? 0x2c7a3a : 0x000000);
      mat.emissiveIntensity = isDest ? 0.55 : 0;
    }

    // ペグの差分同期。
    for (let i = 0; i < cells.length; i++) {
      const hasPeg = cells[i] === 1;
      const cur = rt.pegsRt.get(i);
      if (!hasPeg) {
        if (cur) {
          boardGroup.remove(cur.grp);
          rt.pegsRt.delete(i);
        }
        continue;
      }
      const isSel = selected === i;
      if (!cur) {
        const grp = new THREE.Group();
        const stone = createStone(0.31, PEG_COLOR);
        stone.position.y = 0.16;
        grp.add(stone);
        const [x, z] = cellPos(i);
        grp.position.set(x, 0.7, z); // 現れたペグは上から落として着地させる
        boardGroup.add(grp);
        rt.pegsRt.set(i, { grp, selected: isSel, ty: isSel ? 0.3 : 0 });
        continue;
      }
      if (cur.selected !== isSel) {
        cur.selected = isSel;
        // 選択中は金色＋発光に差し替える（位置は grp が保持する）。
        for (const child of [...cur.grp.children]) cur.grp.remove(child);
        const stone = createStone(0.31, isSel ? PEG_SELECTED_COLOR : PEG_COLOR);
        stone.position.y = 0.16;
        if (isSel) {
          const mat = stone.material as THREE.MeshStandardMaterial;
          mat.emissive = new THREE.Color(0xe0a92e);
          mat.emissiveIntensity = 0.45;
        }
        cur.grp.add(stone);
      }
      cur.ty = isSel ? 0.3 : 0;
    }
  }, [cells, selected, destinations, status]);

  return (
    <SceneBox
      height={440}
      label="ペグソリティアの盤（3D）。ペグをタップで選び、光る穴をタップで移動します"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#4a3520"
    />
  );
}
