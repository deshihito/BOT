"use client";
// フォーリングブロックの 3D 盤。固定ブロックと落下中ピースは色つきの
// 立方体（上面に明るいキャップを重ねた造形）で表し、色は現行 2D の
// FALLING_PIECE_COLORS と一致させる（絵文字は使わない）。ゴーストは
// 半透明の立方体で落下先を示す（現行 2D の枠線ゴーストに相当）。
// 落下・固定・ライン消去・勝敗は親のループと lib/falling.ts が決め、
// ここは親の状態を getState で毎フレーム読み、落下中ピースだけを
// 補間追従させる（snake と同じ getState 補間方式）。固定ブロックは
// 差分同期し、新しく固定されたセルはポップで着地を表す。消去は
// 差分でセルが消えることで表れる。3D 側で落下判定はしない。
// 入力は現行の盤面ジェスチャと同じ語彙:
//   スワイプ = 移動／ソフトドロップ／ハードドロップ（onSwipe）
//   タップ = 回転（onTap）
// どちらも親の既存ハンドラへそのまま渡す。HOLD・一時停止・スコアは
// 親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import {
  FALLING_COLS,
  FALLING_ROWS,
  FALLING_PIECE_COLORS,
  type FallingCell,
  type FallingPieceType,
  type FallingStatus,
} from "@/lib/falling";
import type { GestureDirection } from "@/lib/gesture";

export interface FallingViewState {
  board: FallingCell[];
  /** 落下中ピースの盤上セル（親が getActiveCells で計算済み、y>=0 のみ）。 */
  activeCells: Array<{ x: number; y: number; type: FallingPieceType }>;
  /** ゴースト（落下先）のセル。active と重なる場合は空。 */
  ghostCells: Array<{ x: number; y: number; type: FallingPieceType }>;
  status: FallingStatus;
  /** 固定したピースの総数（出現し直しの検出に使う）。 */
  placed: number;
}

interface Props {
  /** 親のゲームループが進める最新の状態を読む（React 再描画を介さない）。 */
  getState: () => FallingViewState;
  /** スワイプ（現行の盤面ジェスチャの onSwipe と同じハンドラ）。 */
  onSwipe: (dir: GestureDirection) => void;
  /** タップ = 回転（現行の盤面ジェスチャの onTap と同じハンドラ）。 */
  onTap: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;

/** 列・行（行は小数も可＝補間用）から盤面座標を返す。行0が最上段。 */
function cellPos(col: number, row: number): [number, number] {
  return [(col - (FALLING_COLS - 1) / 2) * PITCH, ((FALLING_ROWS - 1) / 2 - row) * PITCH];
}

/** 縦長の盤全体が収まるよう、正面寄りのカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement) {
  const w = container.clientWidth || 320;
  const h = container.clientHeight || 600;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distH = (FALLING_ROWS / 2 + 0.9) / Math.tan(vFov / 2);
  const distW = (FALLING_COLS / 2 + 0.9) / Math.tan(hFov / 2);
  const dist = Math.max(distH, distW) + 0.6;
  stage.setCamera({ position: [0, 0.7, dist], lookAt: [0, 0, 0], fov: 42 });
}

interface BlockRt {
  grp: THREE.Group;
  bodyMat: THREE.MeshStandardMaterial;
  capMat: THREE.MeshStandardMaterial;
  type: FallingPieceType | null;
  pop: number;
}

function createBlock(): BlockRt {
  const grp = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, metalness: 0.05 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.92, 0.8), bodyMat);
  grp.add(body);
  const capMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.05 });
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.58, 0.1), capMat);
  cap.position.z = 0.42;
  grp.add(cap);
  grp.visible = false;
  return { grp, bodyMat, capMat, type: null, pop: 0 };
}

function setBlockType(b: BlockRt, type: FallingPieceType) {
  b.type = type;
  b.bodyMat.color.set(FALLING_PIECE_COLORS[type]);
  b.capMat.color.set(FALLING_PIECE_COLORS[type]).multiplyScalar(1.35);
}

interface SceneRt {
  boardBlocks: BlockRt[];
  activeBlocks: BlockRt[];
  activeDisplay: THREE.Vector3[];
  lastPlaced: number;
  ghostMeshes: THREE.Mesh[];
  ghostMats: THREE.MeshStandardMaterial[];
}

export default function FallingScene3D({ getState, onSwipe, onTap, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ getState, onSwipe, onTap });
  propsRef.current = { getState, onSwipe, onTap };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x1d2433,
      camera: { position: [0, 0.7, 26], lookAt: [0, 0, 0], fov: 42 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        const s = propsRef.current.getState();
        // 固定ブロックの差分同期。新しく固定されたセルはポップで着地を表す。
        for (let i = 0; i < s.board.length; i++) {
          const b = rt.boardBlocks[i];
          if (!b) continue;
          const cell = s.board[i];
          if (b.type !== cell) {
            if (cell === null) {
              b.type = null;
              b.grp.visible = false;
            } else {
              setBlockType(b, cell);
              b.grp.visible = true;
              b.pop = 1;
            }
          }
          if (b.pop > 0) {
            b.pop = Math.max(0, b.pop - dt * 3.2);
            const sc = 1 + 0.22 * b.pop;
            b.grp.scale.set(sc, sc, 1);
          }
        }
        // ゴースト: 落下先に半透明で示す（補間なし、即時追従）。
        for (let i = 0; i < rt.ghostMeshes.length; i++) {
          const mesh = rt.ghostMeshes[i];
          const g = s.ghostCells[i];
          if (!g) {
            mesh.visible = false;
            continue;
          }
          mesh.visible = true;
          const [x, y] = cellPos(g.x, g.y);
          mesh.position.set(x, y, 0);
          rt.ghostMats[i].color.set(FALLING_PIECE_COLORS[g.type]);
        }
        // 落下中ピース: セルごとに目標へ指数補間で追従させる。
        // ピースが固定されて次が出た瞬間（placed の変化）と大きく
        // 離れた場合（ハードドロップ・出現）は補間せず即座に合わせる。
        const snapped = s.placed !== rt.lastPlaced;
        rt.lastPlaced = s.placed;
        const k = 1 - Math.exp(-dt * 16);
        for (let i = 0; i < rt.activeBlocks.length; i++) {
          const b = rt.activeBlocks[i];
          const cell = s.activeCells[i];
          if (!cell) {
            b.grp.visible = false;
            continue;
          }
          if (b.type !== cell.type) setBlockType(b, cell.type);
          b.grp.visible = true;
          const [tx, ty] = cellPos(cell.x, cell.y);
          const d = rt.activeDisplay[i];
          if (snapped || Math.hypot(tx - d.x, ty - d.y) > PITCH * 2.5) {
            d.set(tx, ty, 0);
          } else {
            d.x += (tx - d.x) * k;
            d.y += (ty - d.y) * k;
          }
          b.grp.position.set(d.x, d.y, 0);
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // 背板: 現行 2D と同じ濃色に格子線を描いた平板（正面が +Z 面）。
    const gridTex = canvasTexture(`falling-grid-${FALLING_COLS}x${FALLING_ROWS}`, 256, 512, (g) => {
      g.fillStyle = "#1d2433";
      g.fillRect(0, 0, 256, 512);
      g.fillStyle = "rgba(255,255,255,0.07)";
      const stepX = 256 / FALLING_COLS;
      const stepY = 512 / FALLING_ROWS;
      for (let c = 0; c < FALLING_COLS; c++) {
        for (let r = 0; r < FALLING_ROWS; r++) {
          g.fillRect(c * stepX + 1, r * stepY + 1, stepX - 2, stepY - 2);
        }
      }
    });
    const slabSide = new THREE.MeshStandardMaterial({ color: 0x11182a, roughness: 0.9 });
    const slabFront = new THREE.MeshStandardMaterial({ map: gridTex, roughness: 0.85 });
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(FALLING_COLS * PITCH + 0.25, FALLING_ROWS * PITCH + 0.25, 0.3),
      [slabSide, slabSide, slabSide, slabSide, slabFront, slabSide],
    );
    slab.position.z = -0.32;
    scene.add(slab);

    // 固定ブロックのプール（盤のセル数分）。
    const boardBlocks: BlockRt[] = [];
    for (let i = 0; i < FALLING_COLS * FALLING_ROWS; i++) {
      const b = createBlock();
      const [x, y] = cellPos(i % FALLING_COLS, Math.floor(i / FALLING_COLS));
      b.grp.position.set(x, y, 0);
      scene.add(b.grp);
      boardBlocks.push(b);
    }
    // 落下中ピース（最大4セル）とゴースト（最大4セル）。
    const activeBlocks: BlockRt[] = [];
    const activeDisplay: THREE.Vector3[] = [];
    for (let i = 0; i < 4; i++) {
      const b = createBlock();
      scene.add(b.grp);
      activeBlocks.push(b);
      activeDisplay.push(new THREE.Vector3(0, 0, 0));
    }
    const ghostGeo = new THREE.BoxGeometry(0.92, 0.92, 0.8);
    const ghostMeshes: THREE.Mesh[] = [];
    const ghostMats: THREE.MeshStandardMaterial[] = [];
    for (let i = 0; i < 4; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.4, transparent: true, opacity: 0.26, depthWrite: false,
      });
      const mesh = new THREE.Mesh(ghostGeo, mat);
      mesh.visible = false;
      scene.add(mesh);
      ghostMeshes.push(mesh);
      ghostMats.push(mat);
    }

    // 入力用の透明な当たり板（盤全体）。
    const hit = new THREE.Mesh(
      new THREE.BoxGeometry(FALLING_COLS * PITCH + 0.25, FALLING_ROWS * PITCH + 0.25, 1),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hit.position.z = 0.4;
    hit.userData.pickId = "board";
    scene.add(hit);

    rtRef.current = { boardBlocks, activeBlocks, activeDisplay, lastPlaced: -1, ghostMeshes, ghostMats };
    fitCamera(stage, container);

    detach = attachPickPointer(stage, () => [hit], {
      // スワイプは掴んだ対象の有無で onFlick / onDragEnd のどちらかに届くため、
      // 両方を親のスワイプハンドラへ橋渡しする（方向は FlickInfo.dir をそのまま使う）。
      onFlick: (flick) => {
        if (flick.dir) propsRef.current.onSwipe(flick.dir);
      },
      onDragEnd: (flick) => {
        if (flick.dir) propsRef.current.onSwipe(flick.dir);
      },
      onTapAnywhere: () => {
        propsRef.current.onTap();
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

  return (
    <SceneBox
      height={600}
      label="フォーリングブロックの盤（3D）。左右スワイプで移動、下スワイプでソフトドロップ、タップで回転、上スワイプでハードドロップ"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#1d2433"
    />
  );
}
