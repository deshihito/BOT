"use client";
// スネークの 3D シーン。グリッド床＋蛇体は頭（目つきの箱）と体の
// 立方体列で表し、餌は赤い球で表す。進行・食事・衝突・得点は親の
// ゲームループ（lib/snake.ts の進行関数）が決め、ここは親の状態を
// getState で毎フレーム読み、補間追従するだけ（第5期 breakout / pong
// の getState 補間方式）。3D 側で進行判定はしない。
// 入力は現行語彙どおり: 盤面スワイプ = 方向転換（onSwipe）、
// タップ = 開始／ポーズ／再開（onTap）。どちらも親の既存ハンドラへ
// そのまま渡す。状態・スコアは親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { canvasTexture, createBall } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { SnakeDir, SnakePoint, SnakeStatus } from "@/lib/snake";

export interface SnakeViewState {
  cols: number;
  rows: number;
  snake: SnakePoint[];
  food: SnakePoint | null;
  dir: SnakeDir;
  status: SnakeStatus;
}

interface Props {
  /** 親のゲームループが進める最新の状態を読む（React 再描画を介さない）。 */
  getState: () => SnakeViewState;
  /** スワイプ = 方向転換（既存の move ハンドラ）。 */
  onSwipe: (dir: SnakeDir) => void;
  /** タップ = 開始／ポーズ／再開（既存のタップハンドラ）。 */
  onTap: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;
const MAX_SEGMENTS = 420;

function cellPos(p: SnakePoint, cols: number, rows: number): [number, number] {
  return [(p.x - (cols - 1) / 2) * PITCH, (p.y - (rows - 1) / 2) * PITCH];
}

interface SceneRt {
  floor: THREE.Mesh;
  head: THREE.Group;
  eyeL: THREE.Mesh;
  eyeR: THREE.Mesh;
  bodyMeshes: THREE.Mesh[];
  foodBall: THREE.Mesh;
  display: THREE.Vector3[];
  builtDims: string;
}

export default function SnakeScene3D({ getState, onSwipe, onTap, onFail, fallback }: Props) {
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
      background: 0x14231a,
      camera: { position: [0, 15.5, 8.5], lookAt: [0, 0, 0.8], fov: 42 },
      onFrame: (dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        const s = propsRef.current.getState();
        // 補間追従: 各節を目標セルへ指数補間で寄せる。大きく離れたら
        // （再開・リスタート）即座に合わせる。
        const k = Math.min(1, dt * 20);
        while (rt.display.length < s.snake.length) {
          const p = s.snake[Math.min(rt.display.length, s.snake.length - 1)] ?? { x: 0, y: 0 };
          const [x, z] = cellPos(p, s.cols, s.rows);
          rt.display.push(new THREE.Vector3(x, 0.3, z));
        }
        rt.display.length = s.snake.length;
        s.snake.forEach((p, i) => {
          const [tx, tz] = cellPos(p, s.cols, s.rows);
          const d = rt.display[i];
          if (Math.hypot(tx - d.x, tz - d.z) > PITCH * 2.5) {
            d.set(tx, 0.3, tz);
          } else {
            d.x += (tx - d.x) * k;
            d.z += (tz - d.z) * k;
          }
        });
        // 頭: 目つきの箱。進行方向へ目を向ける。
        if (rt.display.length > 0) {
          const headPos = rt.display[0];
          rt.head.position.set(headPos.x, 0.32, headPos.z);
          // 目はローカル +Z 側。ワールドでは down=+Z / up=-Z / right=+X / left=-X。
          const yaw = s.dir === "right" ? Math.PI / 2 : s.dir === "left" ? -Math.PI / 2 : s.dir === "up" ? Math.PI : 0;
          rt.head.rotation.y = yaw;
        }
        rt.head.visible = rt.display.length > 0;
        // 体: 立方体の列（頭の次の節から）。
        rt.bodyMeshes.forEach((mesh, i) => {
          const d = rt.display[i + 1];
          if (!d) {
            mesh.visible = false;
            return;
          }
          mesh.visible = true;
          mesh.position.set(d.x, 0.3, d.z);
        });
        // 餌: 赤い球（ゆっくり脈動）。
        if (s.food) {
          const [fx, fz] = cellPos(s.food, s.cols, s.rows);
          rt.foodBall.visible = true;
          rt.foodBall.position.set(fx, 0.32, fz);
          const pulse = 1 + 0.12 * Math.sin(t * 4);
          rt.foodBall.scale.setScalar(pulse);
        } else {
          rt.foodBall.visible = false;
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    const s0 = propsRef.current.getState();
    // グリッド床: 現行 2D と同じ濃緑に格子線を描いた平板。
    const gridTex = canvasTexture(`snake-grid-${s0.cols}x${s0.rows}`, 512, 512, (g) => {
      g.fillStyle = "#14231a";
      g.fillRect(0, 0, 512, 512);
      g.strokeStyle = "rgba(255,255,255,0.07)";
      g.lineWidth = 1;
      const stepX = 512 / s0.cols;
      const stepY = 512 / s0.rows;
      for (let i = 1; i < s0.cols; i++) {
        g.beginPath();
        g.moveTo(i * stepX, 0);
        g.lineTo(i * stepX, 512);
        g.stroke();
      }
      for (let i = 1; i < s0.rows; i++) {
        g.beginPath();
        g.moveTo(0, i * stepY);
        g.lineTo(512, i * stepY);
        g.stroke();
      }
    });
    const floorSide = new THREE.MeshStandardMaterial({ color: 0x0e1a12, roughness: 0.9 });
    const floorTop = new THREE.MeshStandardMaterial({ map: gridTex, roughness: 0.85 });
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(s0.cols * PITCH + 0.3, 0.24, s0.rows * PITCH + 0.3),
      [floorSide, floorSide, floorTop, floorSide, floorSide, floorSide],
    );
    floor.position.y = -0.13;
    floor.userData.pickId = "floor";
    scene.add(floor);

    // 頭: 明るい緑の箱＋2つの目（進行方向 = +Z ローカルとして置く）。
    const head = new THREE.Group();
    const headBox = new THREE.Mesh(
      new THREE.BoxGeometry(0.86, 0.56, 0.86),
      new THREE.MeshStandardMaterial({ color: 0x7ee787, roughness: 0.4 }),
    );
    head.add(headBox);
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x14231a, roughness: 0.35 });
    const eyeGeo = new THREE.SphereGeometry(0.075, 12, 10);
    const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
    eyeL.position.set(-0.2, 0.1, 0.44);
    head.add(eyeL);
    const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
    eyeR.position.set(0.2, 0.1, 0.44);
    head.add(eyeR);
    // 目はローカル +Z 側に置き、yaw は onFrame で dir から決める。
    scene.add(head);

    // 体: 立方体のプール。
    const bodyGeo = new THREE.BoxGeometry(0.8, 0.5, 0.8);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x3fb56a, roughness: 0.45 });
    const bodyMeshes: THREE.Mesh[] = [];
    for (let i = 0; i < MAX_SEGMENTS; i++) {
      const mesh = new THREE.Mesh(bodyGeo, bodyMat);
      mesh.visible = false;
      scene.add(mesh);
      bodyMeshes.push(mesh);
    }

    // 餌: 赤い球。
    const foodBall = createBall(0.32, 0xe85d4a, { roughness: 0.3 });
    foodBall.position.y = 0.32;
    scene.add(foodBall);

    rtRef.current = {
      floor,
      head,
      eyeL,
      eyeR,
      bodyMeshes,
      foodBall,
      display: [],
      builtDims: `${s0.cols}x${s0.rows}`,
    };

    detach = attachPickPointer(stage, () => [floor, head, foodBall, ...bodyMeshes], {
      onFlick: (flick) => {
        // 盤面スワイプ = 方向転換（現行の boardGesture と同じ語彙）。
        if (flick.dir) propsRef.current.onSwipe(flick.dir);
      },
      onTapAnywhere: () => {
        // タップ = 開始／ポーズ／再開（現行のタップと同じハンドラ）。
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
      height={480}
      label="スネークの盤（3D）。スワイプで方向転換、タップで開始・ポーズ"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#14231a"
    />
  );
}
