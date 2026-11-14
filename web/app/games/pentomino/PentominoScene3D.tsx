"use client";
// ペントミノの 3D 盤。ピースは単位立方体の集合として立体化し、配置済みの
// マスは盤上で盛り上がって見える。パレット（ピース選択）と選択中ピースの
// 回転・反転は現行どおり親の DOM が担い、ここは盤面だけを持つ。
// 入力は現行クライアントの操作語彙どおり:
//   盤タップ = onCell（ピース選択中は配置、未選択で配置済みマスは取り外し。
//     判定はすべて親ハンドラと lib/pentomino.ts が行う）
//   ホバー = 配置プレビュー（現行 DOM の onMouseEnter と同じ hover 状態）
// ドラッグ配置は現行に無いため追加しない（タップ式が正）。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import { pentPieceDef, type PentId, type PentState } from "@/lib/pentomino";

interface Props {
  state: PentState;
  /** セル index -> 配置済みピース（pentOccupancy の結果）。 */
  occupancy: (PentId | null)[];
  /** ホバー中の配置プレビューが覆うセル集合（親が canPlacePent で計算）。 */
  previewCells: Set<number>;
  selected: PentId | null;
  onCell: (index: number) => void;
  onHover: (index: number | null) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;

function cellPos(index: number, rows: number, cols: number): [number, number] {
  const r = Math.floor(index / cols);
  const c = index % cols;
  return [(c - (cols - 1) / 2) * PITCH, (r - (rows - 1) / 2) * PITCH];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, cols: number, rows: number) {
  const w = container.clientWidth || 640;
  const h = container.clientHeight || 340;
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

interface SceneRt {
  stage: Stage;
  boardGroup: THREE.Group;
  hits: THREE.Mesh[];
  hitDims: string;
}

export default function PentominoScene3D({
  state, occupancy, previewCells, selected, onCell, onHover, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onCell, onHover });
  propsRef.current = { onCell, onHover };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x37424e,
      camera: { position: [0, 9, 6.5], lookAt: [0, 0, 0.2], fov: 42 },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    const boardGroup = new THREE.Group();
    scene.add(boardGroup);
    rtRef.current = { stage, boardGroup, hits: [], hitDims: "" };

    const pickIndex = (hit: THREE.Intersection | null): number | null => {
      const id = hit?.object.userData.pickId as string | undefined;
      return id ? Number(id.slice(5)) : null;
    };
    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        const index = pickIndex(hit);
        if (index !== null) propsRef.current.onCell(index);
      },
      onHover: (hit) => {
        propsRef.current.onHover(pickIndex(hit));
      },
    }, { hover: true });
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 盤面同期: 土台・空きマス・配置済み立方体・プレビューを再構築する（最大60マス）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, boardGroup } = rt;
    const { rows, cols } = state;
    const dims = `${rows}x${cols}`;
    if (rt.hitDims !== dims) {
      rt.hitDims = dims;
      for (const child of [...boardGroup.children]) {
        if (child.userData.isBase) boardGroup.remove(child);
      }
      for (const h of rt.hits) boardGroup.remove(h);
      rt.hits = [];
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
      for (let i = 0; i < rows * cols; i++) {
        const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        const [x, z] = cellPos(i, rows, cols);
        h.position.set(x, 0.3, z);
        h.userData.pickId = `cell-${i}`;
        boardGroup.add(h);
        rt.hits.push(h);
      }
      const container = containerRef.current;
      if (container) fitCamera(stage, container, cols, rows);
    }

    // 動的部分（土台と当たり判定以外）を入れ替える。
    for (const child of [...boardGroup.children]) {
      if (!child.userData.pickId && !child.userData.isBase) boardGroup.remove(child);
    }
    if (!boardGroup.children.some((c) => c.userData.isBase)) {
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(cols * PITCH + 0.35, 0.3, rows * PITCH + 0.35),
        new THREE.MeshStandardMaterial({ color: 0x6d7c88, roughness: 0.85 }),
      );
      base.position.y = -0.16;
      base.userData.isBase = true;
      boardGroup.add(base);
    }

    const emptyGeo = new THREE.BoxGeometry(0.92, 0.1, 0.92);
    const emptyMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.85 });
    const cubeGeo = new THREE.BoxGeometry(0.94, 0.46, 0.94);
    occupancy.forEach((occupant, i) => {
      const [x, z] = cellPos(i, rows, cols);
      if (occupant) {
        // 配置済みピース: ピース色の立方体が盛り上がる。
        const cube = new THREE.Mesh(
          cubeGeo,
          new THREE.MeshStandardMaterial({ color: new THREE.Color(pentPieceDef(occupant).color), roughness: 0.5 }),
        );
        cube.position.set(x, 0.23, z);
        boardGroup.add(cube);
        return;
      }
      const plate = new THREE.Mesh(emptyGeo, emptyMat);
      plate.position.set(x, 0.05, z);
      boardGroup.add(plate);
      if (previewCells.has(i) && selected) {
        // 配置プレビュー: 選択中ピースの色で半透明に浮かせる（現行 2D の 0.45 表示相当）。
        const ghost = new THREE.Mesh(
          cubeGeo,
          new THREE.MeshStandardMaterial({
            color: new THREE.Color(pentPieceDef(selected).color),
            roughness: 0.5,
            transparent: true,
            opacity: 0.45,
          }),
        );
        ghost.position.set(x, 0.23, z);
        boardGroup.add(ghost);
      }
    });
  }, [state, occupancy, previewCells, selected]);

  const height = Math.max(240, Math.min(400, Math.round(620 * (state.rows / state.cols))));
  return (
    <SceneBox
      height={height}
      label="ペントミノの盤（3D）。マスをタップしてピースを置きます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#37424e"
    />
  );
}
