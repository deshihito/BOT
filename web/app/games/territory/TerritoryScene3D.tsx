"use client";
// テリトリオの 3D 盤。陣地タイルを立体タイルで表す:
//   所有マス = 席色の盛り上がったタイル（直近の着手は金の台座で強調）
//   空きマス = 平たい下地（開始角は席色の淡いタイル）
//   配置プレビュー = 半透明のゴーストタイル（合法=緑 / 非合法=赤）
// 入力は現行クライアントの操作語彙どおり:
//   盤タップ = onCell（アンカー決定／同じマスの再タップで配置。判定は
//     すべて親ハンドラと lib/online/games/territory.ts が行う）
//   盤スワイプ（回転/反転/パス）は親が盤ラッパーに付けた useGesture が
//     担う（canvas のポインタイベントはラッパーへ伝播する。タップとの
//     二重発火は attachPickPointer の移動量判定で起きない）
// スコア・残りピース・ピース選択は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

interface Props {
  /** 盤面（0=空, 1=seat0, 2=seat1）。 */
  board: number[];
  size: number;
  /** 配置プレビューが覆うセル集合（親が placementCells で計算）。 */
  preview: Set<number>;
  previewLegal: boolean;
  /** 直近の着手セル（金の台座で強調）。 */
  lastMove: Set<number>;
  /** マスタップ（現行の onCell へ接続）。 */
  onCell: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;
/** 現行 2D と同じ席色・開始角色。 */
const SEAT_COLORS_3D: readonly number[] = [0xc2504a, 0x2f5da8];
const SEAT_BG_3D: readonly number[] = [0xfbeae8, 0xe8eefb];

function cellPos(index: number, size: number): [number, number] {
  const r = Math.floor(index / size);
  const c = index % size;
  return [(c - (size - 1) / 2) * PITCH, (r - (size - 1) / 2) * PITCH];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, size: number) {
  const w = container.clientWidth || 420;
  const h = container.clientHeight || 380;
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

interface SceneRt {
  stage: Stage;
  boardGroup: THREE.Group;
  hits: THREE.Mesh[];
  built: boolean;
}

export default function TerritoryScene3D({
  board, size, preview, previewLegal, lastMove, onCell, onFail, fallback,
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
      background: 0x8a7a5c,
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
    rtRef.current = { stage, boardGroup, hits: [], built: false };

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

  // 盤面同期: 土台と当たり判定は初回だけ作り、タイル類は毎回作り直す（最大100マス）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, boardGroup } = rt;
    if (!rt.built) {
      rt.built = true;
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(size * PITCH + 0.35, 0.3, size * PITCH + 0.35),
        new THREE.MeshStandardMaterial({ color: 0xddd3bd, roughness: 0.9 }),
      );
      base.position.y = -0.16;
      base.userData.isBase = true;
      boardGroup.add(base);
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

    for (const child of [...boardGroup.children]) {
      if (!child.userData.pickId && !child.userData.isBase) boardGroup.remove(child);
    }

    const plateGeo = new THREE.BoxGeometry(0.92, 0.1, 0.92);
    const tileGeo = new THREE.BoxGeometry(0.94, 0.44, 0.94);
    const plateMat = new THREE.MeshStandardMaterial({ color: 0xfffdf6, roughness: 0.9 });
    const cornerMats = SEAT_BG_3D.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }));
    const seatMats = SEAT_COLORS_3D.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5 }));
    const goldMat = new THREE.MeshStandardMaterial({ color: 0xd9a41c, roughness: 0.35, metalness: 0.35 });
    const ghostMat = new THREE.MeshStandardMaterial({
      color: previewLegal ? 0x8fce6e : 0xe79a8f,
      roughness: 0.5,
      transparent: true,
      opacity: 0.55,
    });

    board.forEach((value, i) => {
      const [x, z] = cellPos(i, size);
      const owner = value === 1 ? 0 : value === 2 ? 1 : -1;
      const isCorner = i === 0 || i === size * size - 1;
      if (owner >= 0) {
        if (lastMove.has(i)) {
          // 直近の着手: 金の台座の上にタイルを載せて強調する。
          const pedestal = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.12, 1.0), goldMat);
          pedestal.position.set(x, 0.06, z);
          boardGroup.add(pedestal);
        }
        const tile = new THREE.Mesh(tileGeo, seatMats[owner]);
        tile.position.set(x, 0.22, z);
        boardGroup.add(tile);
        return;
      }
      const plate = new THREE.Mesh(plateGeo, isCorner ? cornerMats[i === 0 ? 0 : 1] : plateMat);
      plate.position.set(x, 0.05, z);
      boardGroup.add(plate);
      if (preview.has(i)) {
        const ghost = new THREE.Mesh(tileGeo, ghostMat);
        ghost.position.set(x, 0.22, z);
        boardGroup.add(ghost);
      }
    });
  }, [board, size, preview, previewLegal, lastMove]);

  return (
    <SceneBox
      height={380}
      label="テリトリオの盤（3D）。マスをタップして配置プレビューを出し、同じマスの再タップで置きます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#8a7a5c"
    />
  );
}
