"use client";
// ブロック崩しの 3D シーン。奥行きのある壁 + 色つき直方体のブロック段 +
// 球のボール + パドル。物理・衝突・得点はクライアントの rAF ループ
// (lib/breakout.ts の配置・得点定義に従う) が決め、ここは親の状態を
// getState で毎フレーム読み、指数補間で追従するだけ。3D 側で物理判定はしない。
// ブロックは lib の BreakoutBrick (x/y/w/h/color/hp) をそのまま直方体へ写し、
// alive の差分で消去する (破壊時は小さくフェードする破片表現)。
// 入力 (既存ジェスチャ語彙を壊さない):
//   ポインタの平面追従 (hover / ドラッグ) = パドル移動 (airhockey 型)
//   タップ / ドラッグ開始 = 親の onPress (発射・再開・クリア時の次レベル)
//   下フリック / 下ドラッグ終了 = 親の onSwipeDown (プレイ中のみポーズ。
//     判定はクライアント側。2D の boardGesture の下スワイプと同じ語彙)
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createBall } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import {
  BREAKOUT_FIELD_H,
  BREAKOUT_FIELD_W,
  type BreakoutBrick,
} from "@/lib/breakout";

export interface BreakoutViewState {
  ball: { x: number; y: number; r: number };
  paddle: { x: number; w: number };
  bricks: BreakoutBrick[];
}

interface Props {
  /** 親のゲームループが進める最新の状態を読む (React 再描画を介さない)。 */
  getState: () => BreakoutViewState;
  /** パドルの目標位置 (フィールド座標 x)。クランプはクライアント側。 */
  onTarget: (fieldX: number) => void;
  /** 発射・再開・次レベルへ (2D の盤面 pointerdown と同じハンドラ)。 */
  onPress: () => void;
  /** 下スワイプ = ポーズ (プレイ中のみ、判定はクライアント側)。 */
  onSwipeDown: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const S = 100;
const toX = (gx: number) => (gx - BREAKOUT_FIELD_W / 2) / S;
const toZ = (gy: number) => (gy - BREAKOUT_FIELD_H / 2) / S;
const toGx = (x: number) => x * S + BREAKOUT_FIELD_W / 2;
// クライアント (BreakoutClient) と同じパドル位置・高さ。
const PADDLE_Y = BREAKOUT_FIELD_H - 28;
const PADDLE_H = 12;
const TABLE_Y = 0;
const MAX_BRICKS = 64;
const BRICK_H3D = 0.32;

interface SceneRt {
  ball: THREE.Mesh;
  paddle: THREE.Mesh;
  brickMeshes: THREE.Mesh[];
  brickMats: THREE.MeshStandardMaterial[];
  prevAlive: boolean[];
  fades: Map<number, number>;
}

export default function BreakoutScene3D({ getState, onTarget, onPress, onSwipeDown, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ getState, onTarget, onPress, onSwipeDown });
  propsRef.current = { getState, onTarget, onPress, onSwipeDown };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x0a1220,
      camera: { position: [0, 8.4, 6.6], lookAt: [0, 0, 0.2], fov: 46 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        const s = propsRef.current.getState();
        // 補間追従: dt クランプ済み (0.05) の指数補間で親ループの状態へ寄せる。
        const k = Math.min(1, dt * 48);
        rt.ball.position.x += (toX(s.ball.x) - rt.ball.position.x) * k;
        rt.ball.position.z += (toZ(s.ball.y) - rt.ball.position.z) * k;
        rt.paddle.position.x += (toX(s.paddle.x) - rt.paddle.position.x) * k;
        rt.paddle.scale.x = s.paddle.w / S;

        // ブロックの差分同期。破壊 (alive: true -> false) は破片フェードで消す。
        const bricks = s.bricks;
        const aliveCount = bricks.reduce((n, b) => n + (b.alive ? 1 : 0), 0);
        const prevAliveCount = rt.prevAlive.reduce((n, a) => n + (a ? 1 : 0), 0);
        // レベル開始・リトライで alive が増えたら作り直し扱い (フェードを引き継がない)。
        if (bricks.length !== rt.prevAlive.length || aliveCount > prevAliveCount) rt.fades.clear();
        for (let i = 0; i < rt.brickMeshes.length; i++) {
          const mesh = rt.brickMeshes[i];
          const mat = rt.brickMats[i];
          const b = bricks[i] as BreakoutBrick | undefined;
          if (!b) {
            mesh.visible = false;
            continue;
          }
          const baseOpacity = b.maxHp > 1 ? 0.55 + 0.45 * (b.hp / b.maxHp) : 1;
          if (b.alive) {
            mesh.visible = true;
            mesh.position.set(toX(b.x + b.w / 2), BRICK_H3D / 2, toZ(b.y + b.h / 2));
            mesh.scale.set(b.w / S, BRICK_H3D, b.h / S);
            mat.color.set(b.color);
            mat.opacity = baseOpacity;
            continue;
          }
          // 破壊済み: 直前まで生きていたものだけフェードを始める。
          let p = rt.fades.get(i);
          if (p === undefined && rt.prevAlive[i]) {
            p = 0;
            rt.fades.set(i, p);
          }
          if (p === undefined) {
            mesh.visible = false;
            continue;
          }
          p += dt / 0.28;
          if (p >= 1) {
            rt.fades.delete(i);
            mesh.visible = false;
            continue;
          }
          rt.fades.set(i, p);
          mesh.visible = true;
          mesh.position.set(toX(b.x + b.w / 2), BRICK_H3D / 2 + p * 0.35, toZ(b.y + b.h / 2));
          const shrink = 1 - p;
          mesh.scale.set((b.w / S) * shrink, BRICK_H3D * shrink, (b.h / S) * shrink);
          mat.color.set(b.color);
          mat.opacity = baseOpacity * (1 - p);
        }
        rt.prevAlive = bricks.map((b) => b.alive);
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // テーブル土台 + 盤面
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(BREAKOUT_FIELD_W / S + 0.4, 0.24, BREAKOUT_FIELD_H / S + 0.4),
      new THREE.MeshStandardMaterial({ color: 0x1b2a44, roughness: 0.6 }),
    );
    base.position.y = -0.15;
    scene.add(base);
    const surface = new THREE.Mesh(
      new THREE.BoxGeometry(BREAKOUT_FIELD_W / S, 0.05, BREAKOUT_FIELD_H / S),
      new THREE.MeshStandardMaterial({ color: 0x101827, roughness: 0.7 }),
    );
    surface.position.y = -0.025;
    surface.userData.pickId = "table";
    scene.add(surface);
    // 奥行きのある壁 (左右 + 奥)。手前 (パドル側) はボールの落下口として開ける。
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x5b7ba6, roughness: 0.45, metalness: 0.15 });
    const mkWall = (w: number, d: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.38, d), wallMat);
      m.position.set(x, 0.16, z);
      scene.add(m);
    };
    mkWall(0.12, BREAKOUT_FIELD_H / S + 0.24, -BREAKOUT_FIELD_W / S / 2 - 0.06, 0);
    mkWall(0.12, BREAKOUT_FIELD_H / S + 0.24, BREAKOUT_FIELD_W / S / 2 + 0.06, 0);
    mkWall(BREAKOUT_FIELD_W / S + 0.24, 0.12, 0, -BREAKOUT_FIELD_H / S / 2 - 0.06);

    // ブロック段 (プール。lib の配置をそのまま直方体へ写す)
    const brickGeo = new THREE.BoxGeometry(1, 1, 1);
    const brickMeshes: THREE.Mesh[] = [];
    const brickMats: THREE.MeshStandardMaterial[] = [];
    for (let i = 0; i < MAX_BRICKS; i++) {
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.42, transparent: true });
      const mesh = new THREE.Mesh(brickGeo, mat);
      mesh.visible = false;
      scene.add(mesh);
      brickMeshes.push(mesh);
      brickMats.push(mat);
    }

    // パドル (幅はレベル定義の paddleWidth に追従して scale で変える)
    const paddle = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.24, PADDLE_H / S + 0.06),
      new THREE.MeshStandardMaterial({ color: 0xf2f5f9, roughness: 0.35 }),
    );
    paddle.position.y = 0.12;
    scene.add(paddle);
    const ball = createBall(0.09, 0xffd34d);
    ball.position.y = 0.14;
    scene.add(ball);

    const s0 = propsRef.current.getState();
    ball.position.set(toX(s0.ball.x), 0.14, toZ(s0.ball.y));
    paddle.position.set(toX(s0.paddle.x), 0.12, toZ(PADDLE_Y + PADDLE_H / 2));
    paddle.scale.x = s0.paddle.w / S;

    rtRef.current = {
      ball,
      paddle,
      brickMeshes,
      brickMats,
      prevAlive: s0.bricks.map((b) => b.alive),
      fades: new Map(),
    };

    const sendTarget = (pt: THREE.Vector3) => {
      propsRef.current.onTarget(toGx(pt.x));
    };
    detach = attachPickPointer(
      stage,
      () => [surface, base],
      {
        onTap: (hit) => {
          if (hit) sendTarget(hit.point);
          propsRef.current.onPress();
        },
        onDragStart: () => propsRef.current.onPress(),
        onDragMove: (point) => sendTarget(point),
        onDragEnd: (flick) => {
          if (flick.dir === "down") propsRef.current.onSwipeDown();
        },
        onFlick: (flick) => {
          if (flick.dir === "down") propsRef.current.onSwipeDown();
        },
        onHover: (hit) => {
          if (hit) sendTarget(hit.point);
        },
      },
      { planeY: TABLE_Y, hover: true },
    );
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
      label="ブロック崩し (3D)。ポインタでパドルを動かし、タップで発射、下スワイプでポーズ"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#0a1220"
    />
  );
}
