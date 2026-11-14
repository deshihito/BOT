"use client";
// コラムスの 3D 盤。宝石は種別ごとに造形を変えて表す（色は現行 2D の
// GEM_FILL と一致、絵文字は使わない）:
//   0 赤 = 球 / 1 黄 = 八面体（ダイヤ） / 2 緑 = 立方体 /
//   3 青 = 六角柱 / 4 紫 = トーラス（リング）
// 色だけでなく形でも判別できるようにするのが造形分けの狙い。
// 落下・回転・消去・連鎖・勝敗は親のループと lib/columns.ts が決め、
// ここは親の状態を getState で毎フレーム読み、落下中ブロックだけを
// 補間追従させる（snake と同じ getState 補間方式）。固定済みの宝石は
// 差分同期し、新しく現れたセルはポップで着地を表す。消去・連鎖の
// 落下も差分で表れる。3D 側で落下判定・マッチ判定はしない。
// 入力は現行の盤面ジェスチャと同じ語彙:
//   スワイプ = 移動／ソフトドロップ／ハードドロップ（onSwipe）
//   タップ = 回転、未開始・ゲームオーバー時は開始（onTap）
// どちらも親の既存ハンドラへそのまま渡す。次ブロック・スコアは
// 親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import { COLUMNS_COLS, COLUMNS_ROWS, GEM_FILL, type ColumnsPiece } from "@/lib/columns";
import type { GestureDirection } from "@/lib/gesture";

export interface ColumnsViewState {
  board: (number | null)[];
  active: ColumnsPiece | null;
  /** 固定したブロックの総数（出現し直しの検出に使う）。 */
  placed: number;
  status: "playing" | "gameover";
}

interface Props {
  /** 親のゲームループが進める最新の状態を読む（React 再描画を介さない）。 */
  getState: () => ColumnsViewState;
  /** スワイプ（現行の盤面ジェスチャの onSwipe と同じハンドラ）。 */
  onSwipe: (dir: GestureDirection) => void;
  /** タップ（現行の盤面ジェスチャの onTap と同じハンドラ）。 */
  onTap: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;

/** 列・行（小数も可＝補間用）から盤面座標を返す。行0が最上段。 */
function cellPos(col: number, row: number): [number, number] {
  return [(col - (COLUMNS_COLS - 1) / 2) * PITCH, ((COLUMNS_ROWS - 1) / 2 - row) * PITCH];
}

/** 縦長の盤全体が収まるよう、正面寄りのカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement) {
  const w = container.clientWidth || 300;
  const h = container.clientHeight || 560;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distH = (COLUMNS_ROWS / 2 + 0.9) / Math.tan(vFov / 2);
  const distW = (COLUMNS_COLS / 2 + 0.9) / Math.tan(hFov / 2);
  const dist = Math.max(distH, distW) + 0.6;
  stage.setCamera({ position: [0, 0.7, dist], lookAt: [0, 0, 0], fov: 42 });
}

/** 宝石の種別ごとの造形（色と形の両方で判別できるようにする）。 */
function createGemGeometry(type: number): THREE.BufferGeometry {
  switch (type) {
    case 0: return new THREE.SphereGeometry(0.37, 20, 14);
    case 1: return new THREE.OctahedronGeometry(0.44);
    case 2: return new THREE.BoxGeometry(0.68, 0.68, 0.68);
    case 3: return new THREE.CylinderGeometry(0.38, 0.38, 0.64, 6);
    default: return new THREE.TorusGeometry(0.3, 0.14, 10, 22);
  }
}

interface GemRt {
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  type: number | null;
  pop: number;
}

interface SceneRt {
  geoByType: THREE.BufferGeometry[];
  boardGems: GemRt[];
  activeGems: GemRt[];
  activeDisplayX: number;
  activeDisplayY: number;
  lastPlaced: number;
}

export default function ColumnsScene3D({ getState, onSwipe, onTap, onFail, fallback }: Props) {
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
      background: 0x1f2937,
      camera: { position: [0, 0.7, 16], lookAt: [0, 0, 0], fov: 42 },
      onFrame: (dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        const s = propsRef.current.getState();
        const setGem = (g: GemRt, type: number) => {
          g.type = type;
          g.mesh.geometry = rt.geoByType[type];
          g.mat.color.set(GEM_FILL[type]);
          g.mat.emissive.set(GEM_FILL[type]);
          // 青の六角柱は軸が縦だと円盤に見えるため、正面へ倒して六角形を見せる。
          g.mesh.rotation.set(type === 3 ? Math.PI / 2 : 0, 0, 0);
        };
        // 固定済み宝石の差分同期。新しく現れたセルはポップで着地を表す。
        for (let i = 0; i < s.board.length; i++) {
          const g = rt.boardGems[i];
          if (!g) continue;
          const cell = s.board[i];
          if (g.type !== cell) {
            if (cell === null) {
              g.type = null;
              g.mesh.visible = false;
            } else {
              setGem(g, cell);
              g.mesh.visible = true;
              g.pop = 1;
            }
          }
          if (g.pop > 0) {
            g.pop = Math.max(0, g.pop - dt * 3.2);
            const sc = 1 + 0.22 * g.pop;
            g.mesh.scale.set(sc, sc, sc);
          }
        }
        // 落下中ブロック: 列と行を補間追従させる。固定されて次が出た
        // 瞬間（placed の変化）と大きく離れた場合は即座に合わせる。
        // 回転（宝石の並び替え）は 2D と同じく即時に反映する。
        const a = s.active;
        if (!a) {
          for (const g of rt.activeGems) g.mesh.visible = false;
          rt.lastPlaced = s.placed;
          return;
        }
        const snapped = s.placed !== rt.lastPlaced;
        rt.lastPlaced = s.placed;
        const k = 1 - Math.exp(-dt * 14);
        if (snapped || Math.hypot(a.col - rt.activeDisplayX, a.y - rt.activeDisplayY) > 2.5) {
          rt.activeDisplayX = a.col;
          rt.activeDisplayY = a.y;
        } else {
          rt.activeDisplayX += (a.col - rt.activeDisplayX) * k;
          rt.activeDisplayY += (a.y - rt.activeDisplayY) * k;
        }
        for (let j = 0; j < 3; j++) {
          const g = rt.activeGems[j];
          const type = a.gems[j];
          if (g.type !== type) setGem(g, type);
          g.mesh.visible = true;
          const [x, y] = cellPos(rt.activeDisplayX, rt.activeDisplayY + j);
          g.mesh.position.set(x, y, 0);
          // 落下中はごく小さく脈動させ、固定済みと見分けやすくする。
          const pulse = 1 + 0.03 * Math.sin(t * 5 + j);
          g.mesh.scale.set(pulse, pulse, pulse);
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // 背板: 現行 2D と同じ濃色に格子の丸セルを描いた平板（正面が +Z 面）。
    const gridTex = canvasTexture(`columns-grid-${COLUMNS_COLS}x${COLUMNS_ROWS}`, 192, 384, (g) => {
      g.fillStyle = "#1f2937";
      g.fillRect(0, 0, 192, 384);
      g.fillStyle = "rgba(255,255,255,0.07)";
      const stepX = 192 / COLUMNS_COLS;
      const stepY = 384 / COLUMNS_ROWS;
      for (let c = 0; c < COLUMNS_COLS; c++) {
        for (let r = 0; r < COLUMNS_ROWS; r++) {
          g.beginPath();
          g.arc(c * stepX + stepX / 2, r * stepY + stepY / 2, stepX * 0.42, 0, Math.PI * 2);
          g.fill();
        }
      }
    });
    const slabSide = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.9 });
    const slabFront = new THREE.MeshStandardMaterial({ map: gridTex, roughness: 0.85 });
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(COLUMNS_COLS * PITCH + 0.25, COLUMNS_ROWS * PITCH + 0.25, 0.3),
      [slabSide, slabSide, slabSide, slabSide, slabFront, slabSide],
    );
    slab.position.z = -0.32;
    scene.add(slab);

    const geoByType = [0, 1, 2, 3, 4].map((type) => createGemGeometry(type));
    const makeGem = (): GemRt => {
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.24, metalness: 0.08, emissiveIntensity: 0.16 });
      const mesh = new THREE.Mesh(geoByType[0], mat);
      mesh.visible = false;
      scene.add(mesh);
      return { mesh, mat, type: null, pop: 0 };
    };
    // 固定済み宝石のプール（盤のセル数分）。
    const boardGems: GemRt[] = [];
    for (let i = 0; i < COLUMNS_COLS * COLUMNS_ROWS; i++) {
      const g = makeGem();
      const [x, y] = cellPos(i % COLUMNS_COLS, Math.floor(i / COLUMNS_COLS));
      g.mesh.position.set(x, y, 0);
      boardGems.push(g);
    }
    // 落下中ブロック（3個）。
    const activeGems: GemRt[] = [makeGem(), makeGem(), makeGem()];

    // 入力用の透明な当たり板（盤全体）。
    const hit = new THREE.Mesh(
      new THREE.BoxGeometry(COLUMNS_COLS * PITCH + 0.25, COLUMNS_ROWS * PITCH + 0.25, 1),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hit.position.z = 0.4;
    hit.userData.pickId = "board";
    scene.add(hit);

    rtRef.current = { geoByType, boardGems, activeGems, activeDisplayX: 0, activeDisplayY: 0, lastPlaced: -1 };
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
      height={560}
      label="コラムスの盤（3D）。スワイプで移動・落とす、タップで回転"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#1f2937"
    />
  );
}
