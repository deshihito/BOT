"use client";
// ビンゴ抽選機の 3D シーン（bingo / bingobattle 共用）。
// ガラス球体容器の中に番号ボール群を入れ、抽選が進むたびに
// 「かき混ぜ → 1球がシュートから排出 → 手前のトレイに並ぶ」を再生する。
// 抽選の進行・乱数はクライアント / lib 側のまま。ここは props の drawn
// （抽選済み番号列）の差分を検出して排出アニメーションを再生するだけ。
// 入力: マシン / トレイのタップ・フリック = 既存 onDraw（次の数字を引く）。
//       onDraw が無い使い方（対戦の自動進行）ではタップは何もしない。
// 番号の可読性は親 DOM のステータス・抽選履歴併記が担う。3D のボールにも
// 大きな数字テクスチャを付けるが、それだけに依存させない。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createBall, canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

interface Props {
  /** 抽選済み番号列（引いた順）。 */
  drawn: number[];
  /** マシンのタップで次を引ける状態か。 */
  canDraw?: boolean;
  /** 次の数字を引く既存ハンドラ。無い場合は表示専用。 */
  onDraw?: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

/** 列（B/I/N/G/O）ごとのボール色。クライアントのカード色と系統を揃える。 */
const COLUMN_COLORS = [0x33509e, 0xb03a3a, 0x2e7d32, 0xb5892d, 0x6a3fb5];
const COLUMN_CSS = ["#33509e", "#b03a3a", "#2e7d32", "#b5892d", "#6a3fb5"];
const SPHERE_POS = new THREE.Vector3(0, 0.78, 0);
const SPHERE_R = 1.5;
const BALL_R = 0.29;
const TRAY_Y = -1.22;
const TRAY_Z = 2.0;
const TRAY_MAX = 10;
const EJECT_MS = 980;
/** 排出シュートの出口（球体右下 → 手前へ斜めに下る管の先）。 */
const CHUTE_MOUTH = new THREE.Vector3(1.32, -0.28, 1.05);

function columnOf(n: number): number {
  return Math.min(4, Math.max(0, Math.floor((n - 1) / 15)));
}

function ballTexture(n: number): THREE.CanvasTexture {
  return canvasTexture(`bingo-ball-${n}`, 128, 128, (g) => {
    g.fillStyle = COLUMN_CSS[columnOf(n)];
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.arc(64, 64, 34, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#1c2333";
    g.font = "bold 52px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(n), 64, 66);
  });
}

function makeNumberBall(n: number, radius: number): THREE.Mesh {
  const ball = createBall(radius, COLUMN_COLORS[columnOf(n)], { roughness: 0.2 });
  ball.material = new THREE.MeshStandardMaterial({
    map: ballTexture(n),
    roughness: 0.22,
    metalness: 0.05,
  });
  ball.userData.pickId = "machine";
  return ball;
}

/** トレイ内のスロット位置。最近 TRAY_MAX 球を中央寄せで横一列に並べる。 */
function traySlot(index: number, count: number): THREE.Vector3 {
  return new THREE.Vector3((index - (count - 1) / 2) * (BALL_R * 2 + 0.1), TRAY_Y, TRAY_Z);
}

/** 球体内部ボールの基準位置（決定的配置。半径内に収める）。 */
function innerBase(i: number): THREE.Vector3 {
  const a = i * 2.39996;
  const r = 0.42 + (i % 5) * 0.19;
  const y = -0.78 + (i % 4) * 0.5 + Math.floor(i / 7) * 0.22;
  const v = new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
  if (v.length() > 1.08) v.setLength(1.08);
  return v;
}

interface EjectAnim {
  value: number;
  startAt: number;
  from: THREE.Vector3;
  ctrl: THREE.Vector3;
  to: THREE.Vector3;
}

interface SceneRt {
  scene: THREE.Scene;
  trayGroup: THREE.Group;
  ejectBall: THREE.Mesh;
  inner: Array<{ mesh: THREE.Mesh; base: THREE.Vector3; phase: number }>;
  tray: Map<number, THREE.Mesh>;
  anim: EjectAnim | null;
  shakeUntil: number;
  prevDrawn: number[];
}

/** トレイを drawn の最近分へ同期する。except は排出中の球（まだ置かない）。 */
function syncTray(rt: SceneRt, drawn: number[], except: number | null) {
  const recent = drawn.slice(-TRAY_MAX);
  for (const [value, mesh] of [...rt.tray]) {
    if (!recent.includes(value) || value === except) {
      rt.trayGroup.remove(mesh);
      mesh.geometry.dispose();
      rt.tray.delete(value);
    }
  }
  recent.forEach((value, i) => {
    if (value === except) return;
    let mesh = rt.tray.get(value);
    if (!mesh) {
      mesh = makeNumberBall(value, BALL_R);
      rt.trayGroup.add(mesh);
      rt.tray.set(value, mesh);
    }
    mesh.position.copy(traySlot(i, recent.length));
    mesh.rotation.set(0, 0, 0);
  });
}

/** 排出アニメーション完了: トレイの所定スロットへ確定させる。 */
function finalizeEject(rt: SceneRt, drawn: number[]) {
  const anim = rt.anim;
  if (!anim) return;
  rt.anim = null;
  rt.ejectBall.visible = false;
  syncTray(rt, drawn, null);
}

/** 1球の排出を開始する。進行中なら先行分を即座に確定させてから始める。 */
function startEject(rt: SceneRt, drawn: number[], value: number) {
  if (rt.anim) finalizeEject(rt, rt.prevDrawn);
  syncTray(rt, drawn, value);
  const recent = drawn.slice(-TRAY_MAX);
  const idx = recent.indexOf(value);
  const to = idx >= 0 ? traySlot(idx, recent.length) : traySlot(recent.length - 1, recent.length);
  const texBall = makeNumberBall(value, BALL_R);
  (rt.ejectBall as THREE.Mesh).material = (texBall as THREE.Mesh).material;
  texBall.geometry.dispose();
  rt.ejectBall.visible = true;
  rt.ejectBall.position.copy(SPHERE_POS);
  rt.ejectBall.rotation.set(0, 0, 0);
  rt.anim = {
    value,
    startAt: performance.now(),
    from: SPHERE_POS.clone().add(new THREE.Vector3(0.25, -0.2, 0.25)),
    ctrl: CHUTE_MOUTH.clone(),
    to,
  };
  rt.shakeUntil = performance.now() + EJECT_MS;
}

export default function BingoScene3D({ drawn, canDraw, onDraw, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ drawn, canDraw, onDraw });
  propsRef.current = { drawn, canDraw, onDraw };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x1d2735,
      camera: { position: [0, 3.1, 7.4], lookAt: [0, -0.05, 0.35], fov: 42 },
      onFrame: (dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        const now = performance.now();
        const shaking = now < rt.shakeUntil;
        // 内部ボール群: 常時ゆるく漂い、抽選中は大きくかき混ぜる。
        const amp = shaking ? 0.17 : 0.05;
        const speed = shaking ? 6.2 : 1.6;
        for (const b of rt.inner) {
          b.mesh.position.set(
            SPHERE_POS.x + b.base.x + Math.sin(t * speed + b.phase) * amp,
            SPHERE_POS.y + b.base.y + Math.cos(t * speed * 0.83 + b.phase * 1.7) * amp,
            SPHERE_POS.z + b.base.z + Math.sin(t * speed * 0.61 + b.phase * 2.3) * amp,
          );
        }
        // 排出: 球体内 → シュート出口 → トレイのスロットへ二次ベジェで運ぶ。
        const anim = rt.anim;
        if (anim) {
          const k = Math.min(1, (now - anim.startAt) / EJECT_MS);
          const p = k;
          const q = 1 - p;
          rt.ejectBall.position.set(
            q * q * anim.from.x + 2 * q * p * anim.ctrl.x + p * p * anim.to.x,
            q * q * anim.from.y + 2 * q * p * anim.ctrl.y + p * p * anim.to.y + Math.sin(p * Math.PI) * 0.12,
            q * q * anim.from.z + 2 * q * p * anim.ctrl.z + p * p * anim.to.z,
          );
          rt.ejectBall.rotation.x += dt * 6;
          rt.ejectBall.rotation.z -= dt * 3;
          if (k >= 1) finalizeEject(rt, propsRef.current.drawn);
        }
        void dt;
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // 床と台座
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(7.5, 40),
      new THREE.MeshStandardMaterial({ color: 0x27324a, roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.62;
    scene.add(floor);
    const machine = new THREE.Group();
    machine.userData.pickId = "machine";
    scene.add(machine);
    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(0.95, 1.3, 0.85, 28),
      new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.55 }),
    );
    pedestal.position.y = -1.18;
    pedestal.userData.pickId = "machine";
    machine.add(pedestal);
    const collar = new THREE.Mesh(
      new THREE.TorusGeometry(1.06, 0.07, 10, 36),
      new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.3, metalness: 0.55 }),
    );
    collar.rotation.x = Math.PI / 2;
    collar.position.y = -0.72;
    machine.add(collar);

    // ガラス球体容器（半透明。内部ボールが見えるよう depthWrite を切る）
    const glass = new THREE.Mesh(
      new THREE.SphereGeometry(SPHERE_R, 36, 24),
      new THREE.MeshPhysicalMaterial({
        color: 0xcfe6f5,
        transparent: true,
        opacity: 0.16,
        roughness: 0.06,
        metalness: 0,
        depthWrite: false,
      }),
    );
    glass.position.copy(SPHERE_POS);
    glass.renderOrder = 3;
    glass.userData.pickId = "machine";
    machine.add(glass);
    const equator = new THREE.Mesh(
      new THREE.TorusGeometry(SPHERE_R, 0.028, 8, 48),
      new THREE.MeshStandardMaterial({ color: 0xc9ccd4, roughness: 0.3, metalness: 0.6 }),
    );
    equator.rotation.x = Math.PI / 2;
    equator.position.copy(SPHERE_POS);
    machine.add(equator);
    // 頂部の口
    const mouth = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.42, 0.3, 20),
      new THREE.MeshStandardMaterial({ color: 0x39404e, roughness: 0.4, metalness: 0.4 }),
    );
    mouth.position.set(SPHERE_POS.x, SPHERE_POS.y + SPHERE_R - 0.02, SPHERE_POS.z);
    mouth.userData.pickId = "machine";
    machine.add(mouth);

    // 排出シュート（球体右下から手前へ下る開いた管）
    const chuteDir = CHUTE_MOUTH.clone().sub(new THREE.Vector3(0.78, 0.18, 0.42));
    const chuteLen = chuteDir.length();
    const chute = new THREE.Mesh(
      new THREE.CylinderGeometry(0.31, 0.31, chuteLen, 18, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x8b93a5, roughness: 0.35, metalness: 0.55, side: THREE.DoubleSide }),
    );
    chute.position.copy(new THREE.Vector3(0.78, 0.18, 0.42).add(CHUTE_MOUTH).multiplyScalar(0.5));
    chute.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), chuteDir.clone().normalize());
    chute.userData.pickId = "machine";
    machine.add(chute);

    // 内部の番号ボール群（色は列色。数字は小さくなるため付けず色のみ）
    const inner: SceneRt["inner"] = [];
    for (let i = 0; i < 18; i++) {
      const mesh = createBall(0.23, COLUMN_COLORS[i % COLUMN_COLORS.length], { roughness: 0.22 });
      const base = innerBase(i);
      mesh.position.copy(SPHERE_POS).add(base);
      scene.add(mesh);
      inner.push({ mesh, base, phase: i * 1.37 });
    }

    // 受けトレイ（排出された球が並ぶ棚）
    const trayGroup = new THREE.Group();
    scene.add(trayGroup);
    const trayBoard = new THREE.Mesh(
      new THREE.BoxGeometry(7.0, 0.16, 0.95),
      new THREE.MeshStandardMaterial({ color: 0x22304f, roughness: 0.6 }),
    );
    trayBoard.position.set(0, TRAY_Y - 0.38, TRAY_Z);
    trayBoard.userData.pickId = "machine";
    trayGroup.add(trayBoard);
    const trayRail = new THREE.Mesh(
      new THREE.BoxGeometry(7.0, 0.3, 0.08),
      new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.35, metalness: 0.5 }),
    );
    trayRail.position.set(0, TRAY_Y - 0.18, TRAY_Z + 0.46);
    trayGroup.add(trayRail);

    // 排出中の球（1球だけ使い回す）
    const ejectBall = makeNumberBall(1, BALL_R);
    ejectBall.visible = false;
    scene.add(ejectBall);

    const rt: SceneRt = {
      scene,
      trayGroup,
      ejectBall,
      inner,
      tray: new Map(),
      anim: null,
      shakeUntil: 0,
      prevDrawn: [...propsRef.current.drawn],
    };
    rtRef.current = rt;
    // 初期表示はアニメーションなしで即座に並べる（途中入室・再表示用）。
    syncTray(rt, propsRef.current.drawn, null);

    detach = attachPickPointer(
      stage,
      () => [machine, trayGroup, ejectBall],
      {
        onTap: () => {
          if (propsRef.current.canDraw && propsRef.current.onDraw) propsRef.current.onDraw();
        },
        onFlick: () => {
          if (propsRef.current.canDraw && propsRef.current.onDraw) propsRef.current.onDraw();
        },
      },
    );
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // drawn の差分検出: 新しく引かれた球が1つなら排出アニメーション、
  // リセット・複数追加ならトレイを即座に同期する。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const prev = rt.prevDrawn;
    const added = drawn.filter((n) => !prev.includes(n));
    rt.prevDrawn = [...drawn];
    if (added.length === 1 && drawn.length > prev.length) {
      startEject(rt, drawn, added[0]);
    } else if (added.length > 0 || drawn.length !== prev.length || rt.anim) {
      if (rt.anim) finalizeEject(rt, drawn);
      syncTray(rt, drawn, null);
    }
  }, [drawn]);

  return (
    <SceneBox
      height={360}
      label="ビンゴ抽選機（3D）。タップで次の数字を引きます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#1d2735"
    />
  );
}
