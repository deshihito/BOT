"use client";
// ルーレットの 3D シーン。ホイールとボールが回り、ボールは結果ポケットへ
// 落ちる。結果は lib/roulette.ts が先に決め、ここでは spinNonce の変化で
// 「そのポケットに止まる」アニメーションを再生するだけ。
// フリックで回す・チップ切れ時はタップで再支給（既存ジェスチャと同一）。
// 数字の読み取りは親の DOM ステータス併記が担い、3D 内に小さく置かない。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createBall } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import { ROULETTE_WHEEL, pocketColor } from "@/lib/roulette";

interface Props {
  /** 確定済みの結果ポケット（未スピンなら null）。 */
  resultPocket: number | null;
  spinning: boolean;
  /** スピン開始ごとに +1 される。 */
  spinNonce: number;
  canSpin: boolean;
  onFlickSpin: () => void;
  onTapWheel: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const POCKET_R = 2.02;
const SPIN_MS = 2500;

function pocketAngle(index: number): number {
  return (index / ROULETTE_WHEEL.length) * Math.PI * 2;
}

export default function RouletteScene3D({ resultPocket, spinning, spinNonce, canSpin, onFlickSpin, onTapWheel, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const animRef = useRef<{
    wheel: THREE.Group;
    ball: THREE.Mesh;
    ballAngle: number;
    ballRadius: number;
    spin: { startAt: number; fromAngle: number; targetAngle: number; active: boolean };
    lastNonce: number;
  } | null>(null);

  const propsRef = useRef({ resultPocket, canSpin, onFlickSpin, onTapWheel });
  propsRef.current = { resultPocket, canSpin, onFlickSpin, onTapWheel };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    let startAt = 0;
    const stage = createStage(container, {
      background: 0x1f2a24,
      camera: { position: [0, 5.4, 5.2], lookAt: [0, 0, 0], fov: 42 },
      onFrame: (dt, t) => {
        const a = animRef.current;
        if (!a) return;
        if (a.spin.active) {
          const k = Math.min(1, (performance.now() - a.spin.startAt) / SPIN_MS);
          const ease = 1 - Math.pow(1 - k, 3);
          a.ballAngle = a.spin.fromAngle + (a.spin.targetAngle - a.spin.fromAngle) * ease;
          a.ballRadius = 2.62 + (POCKET_R - 2.62) * Math.pow(ease, 1.6);
          // スピン中はホイールを止め、ボールの角度だけで結果ポケットへ合わせる
          // （ホイールが動くと最終ポケットの対応がずれるため）。
          if (k >= 1) a.spin.active = false;
        } else {
          a.wheel.rotation.y -= dt * 0.25;
          a.ballAngle -= dt * 0.25;
        }
        a.ball.position.set(
          Math.cos(a.ballAngle) * a.ballRadius,
          0.52 - (a.ballRadius - POCKET_R) * 0.35,
          Math.sin(a.ballAngle) * a.ballRadius,
        );
        void t;
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    void startAt;

    // テーブル
    const table = new THREE.Mesh(
      new THREE.CircleGeometry(8, 40),
      new THREE.MeshStandardMaterial({ color: 0x1e4d33, roughness: 1 }),
    );
    table.rotation.x = -Math.PI / 2;
    table.position.y = -0.32;
    scene.add(table);

    const wheel = new THREE.Group();
    scene.add(wheel);
    // 土台（木枠）と内盆
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(2.62, 2.78, 0.42, 44),
      new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.55 }),
    );
    base.position.y = -0.1;
    wheel.add(base);
    const basin = new THREE.Mesh(
      new THREE.CylinderGeometry(2.3, 1.5, 0.3, 44),
      new THREE.MeshStandardMaterial({ color: 0x8c2f28, roughness: 0.5 }),
    );
    basin.position.y = 0.12;
    wheel.add(basin);
    // ポケット（37 分割の小箱。色は lib の pocketColor に従う）
    for (let i = 0; i < ROULETTE_WHEEL.length; i++) {
      const pocket = ROULETTE_WHEEL[i];
      const c = pocketColor(pocket);
      const color = c === "green" ? 0x1e8449 : c === "red" ? 0xb03a2e : 0x22252a;
      const seg = new THREE.Mesh(
        new THREE.BoxGeometry(0.34, 0.16, 0.3),
        new THREE.MeshStandardMaterial({ color, roughness: 0.45 }),
      );
      const ang = pocketAngle(i);
      seg.position.set(Math.cos(ang) * POCKET_R, 0.3, Math.sin(ang) * POCKET_R);
      seg.rotation.y = -ang + Math.PI / 2;
      wheel.add(seg);
      // 仕切り
      const sep = new THREE.Mesh(
        new THREE.BoxGeometry(0.035, 0.22, 0.34),
        new THREE.MeshStandardMaterial({ color: 0xc9ccd4, roughness: 0.3, metalness: 0.6 }),
      );
      const a2 = ang + Math.PI / ROULETTE_WHEEL.length;
      sep.position.set(Math.cos(a2) * POCKET_R, 0.3, Math.sin(a2) * POCKET_R);
      sep.rotation.y = -a2 + Math.PI / 2;
      wheel.add(sep);
    }
    // 中央の塔と十字ハンドル
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.55, 0.85, 28),
      new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.3, metalness: 0.55 }),
    );
    cone.position.y = 0.55;
    wheel.add(cone);
    for (const rot of [0, Math.PI / 2]) {
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 0.09, 0.16),
        new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.3, metalness: 0.55 }),
      );
      bar.position.y = 1.0;
      bar.rotation.y = rot;
      wheel.add(bar);
    }
    const ball = createBall(0.13, 0xf5f6f8, { roughness: 0.15 });
    scene.add(ball);

    const idx = propsRef.current.resultPocket !== null
      ? ROULETTE_WHEEL.indexOf(propsRef.current.resultPocket as (typeof ROULETTE_WHEEL)[number])
      : 0;
    animRef.current = {
      wheel,
      ball,
      ballAngle: pocketAngle(Math.max(0, idx)),
      ballRadius: POCKET_R,
      spin: { startAt: 0, fromAngle: 0, targetAngle: 0, active: false },
      lastNonce: 0,
    };

    detach = attachPickPointer(stage, () => [base, basin], {
      onFlick: () => { if (propsRef.current.canSpin) propsRef.current.onFlickSpin(); },
      onTap: () => propsRef.current.onTapWheel(),
    });
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      animRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // スピン開始: 結果ポケットへボールが落ちる軌道を予約する。
  useEffect(() => {
    const a = animRef.current;
    if (!a) return;
    if (spinNonce === a.lastNonce) return;
    a.lastNonce = spinNonce;
    if (resultPocket === null) return;
    const idx = ROULETTE_WHEEL.indexOf(resultPocket as (typeof ROULETTE_WHEEL)[number]);
    if (idx < 0) return;
    const target = pocketAngle(idx) + a.wheel.rotation.y;
    const from = a.ballAngle;
    // 目標角度より手前で一周以上余分に回してから収束させる（回転方向は減少側）。
    let delta = ((from - target) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    delta += Math.PI * 2 * 5;
    a.spin = { startAt: performance.now(), fromAngle: from, targetAngle: from - delta, active: true };
    a.ballRadius = 2.62;
  }, [spinNonce, resultPocket]);

  // 回転が終わったらボール位置をポケットに固定する（spinning が false になった時）。
  useEffect(() => {
    const a = animRef.current;
    if (!a || spinning) return;
    if (resultPocket === null) return;
    const idx = ROULETTE_WHEEL.indexOf(resultPocket as (typeof ROULETTE_WHEEL)[number]);
    if (idx >= 0 && !a.spin.active) {
      a.ballAngle = pocketAngle(idx) + a.wheel.rotation.y;
      a.ballRadius = POCKET_R;
    }
  }, [spinning, resultPocket]);

  return (
    <SceneBox
      height={330}
      label="ルーレットのホイール（3D）。フリックで回します"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#1f2a24"
    />
  );
}
