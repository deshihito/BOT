"use client";
// ビリヤードの 3D シーン。フェルト＋クッション＋ポケットのテーブルと球。
// 物理と勝敗は lib/billiards.ts が決め、ここは displayBalls（親がフレーム列を
// 再生した位置）へ補間追従するだけ。3D 側で当たり判定・勝敗判定はしない。
// 入力: テーブル上のドラッグ = 狙い（角度）と強さ（手球からの距離）、
//       速いドラッグ終了 / フリック = 打つ。スライダー＋「打つ」も従来どおり使える。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, CAMERA_PRESETS } from "@/lib/three-kit/stage";
import { createBall, canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import {
  BL_BALL_COLORS,
  BL_BALL_RADIUS,
  BL_HEIGHT,
  BL_POCKETS,
  BL_POCKET_RADIUS,
  BL_WIDTH,
  type BlBall,
} from "@/lib/billiards";

interface Props {
  balls: BlBall[];
  angle: number;
  power: number;
  aiming: boolean;
  onAim: (angle: number, power: number) => void;
  onShoot: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

// ゲーム座標 (800x450, y 下向き) -> 3D (x: -4..4, z: -2.25..2.25)
const S = 100;
const toX = (gx: number) => (gx - BL_WIDTH / 2) / S;
const toZ = (gy: number) => (gy - BL_HEIGHT / 2) / S;
const toGx = (x: number) => x * S + BL_WIDTH / 2;
const toGy = (z: number) => z * S + BL_HEIGHT / 2;
const R = BL_BALL_RADIUS / S;
const BALL_Y = R;

function ballTexture(id: number): THREE.CanvasTexture | null {
  if (id === 0) return null;
  const color = BL_BALL_COLORS[id] ?? "#888888";
  return canvasTexture(`billiards-ball-${id}`, 128, 128, (g) => {
    g.fillStyle = color;
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.arc(64, 64, 30, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = id === 1 ? "#333333" : "#222222";
    g.font = "bold 44px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(id), 64, 66);
  });
}

function makeBall(id: number): THREE.Mesh {
  const colorHex = id === 0 ? 0xffffff : parseInt((BL_BALL_COLORS[id] ?? "#888888").slice(1), 16);
  const ball = createBall(R, colorHex, { roughness: 0.18 });
  const tex = ballTexture(id);
  if (tex) {
    ball.material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.22, metalness: 0.05 });
  }
  ball.userData.pickId = `ball-${id}`;
  return ball;
}

export default function BilliardsScene3D({ balls, angle, power, aiming, onAim, onShoot, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<{
    balls: Map<number, THREE.Mesh>;
    targets: Map<number, { x: number; z: number; pocketed: boolean }>;
    cueGroup: THREE.Group;
    guide: THREE.Line;
    scene: THREE.Scene;
  } | null>(null);
  const dragRef = useRef<{ moved: number } | null>(null);

  const propsRef = useRef({ balls, angle, power, aiming, onAim, onShoot });
  propsRef.current = { balls, angle, power, aiming, onAim, onShoot };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x2a1d12,
      camera: { position: [0, 6.4, 4.6], lookAt: [0, 0, 0.2], fov: 42 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        // 親のフレーム再生 (約16ms刻み) へ指数補間で追従し、段差を滑らかにする。
        const k = Math.min(1, dt * 38);
        for (const [id, mesh] of rt.balls) {
          const t = rt.targets.get(id);
          if (!t) continue;
          mesh.visible = !t.pocketed;
          if (t.pocketed) continue;
          mesh.position.x += (t.x - mesh.position.x) * k;
          mesh.position.z += (t.z - mesh.position.z) * k;
          mesh.position.y = BALL_Y;
        }
        // キューとガイドは最新の狙いに合わせる（打撃中・終了時は隠す）。
        const p = propsRef.current;
        const cueBall = p.balls.find((b) => b.id === 0);
        const show = p.aiming && cueBall && !cueBall.pocketed;
        rt.cueGroup.visible = !!show;
        rt.guide.visible = !!show;
        if (show && cueBall) {
          const rad = (p.angle * Math.PI) / 180;
          const dir = new THREE.Vector3(Math.cos(rad), 0, Math.sin(rad));
          const cuePos = new THREE.Vector3(toX(cueBall.x), BALL_Y, toZ(cueBall.y));
          const len = 2.9;
          const pull = 0.18 + (p.power / 100) * 0.35;
          const centre = cuePos.clone().addScaledVector(dir, -(R + pull + len / 2));
          rt.cueGroup.position.copy(centre);
          rt.cueGroup.rotation.set(0, -rad, 0);
          // ガイド線: 手球から狙い方向へ。
          const guideLen = (40 + p.power * 2.4) / S;
          const end = cuePos.clone().addScaledVector(dir, guideLen);
          const geo = rt.guide.geometry as THREE.BufferGeometry;
          geo.setFromPoints([new THREE.Vector3(cuePos.x, BALL_Y + 0.02, cuePos.z), new THREE.Vector3(end.x, BALL_Y + 0.02, end.z)]);
          const mat = rt.guide.material as THREE.LineDashedMaterial;
          rt.guide.computeLineDistances();
          void mat;
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    void CAMERA_PRESETS;

    // 木枠
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(BL_WIDTH / S + 0.56, 0.22, BL_HEIGHT / S + 0.56),
      new THREE.MeshStandardMaterial({ color: 0x7a4a21, roughness: 0.65 }),
    );
    frame.position.y = -0.13;
    frame.userData.pickId = "table";
    scene.add(frame);
    // フェルト
    const feltTex = canvasTexture("billiards-felt", 256, 144, (g) => {
      g.fillStyle = "#1d7a43";
      g.fillRect(0, 0, 256, 144);
      g.fillStyle = "rgba(255,255,255,0.04)";
      for (let i = 0; i < 500; i++) g.fillRect((i * 37) % 256, (i * 53) % 144, 2, 2);
    });
    const felt = new THREE.Mesh(
      new THREE.BoxGeometry(BL_WIDTH / S, 0.06, BL_HEIGHT / S),
      new THREE.MeshStandardMaterial({ map: feltTex, roughness: 1 }),
    );
    felt.position.y = -0.03;
    felt.userData.pickId = "table";
    scene.add(felt);
    // クッション (4辺)
    const cushionMat = new THREE.MeshStandardMaterial({ color: 0x166534, roughness: 0.9 });
    const cushionH = 0.14;
    const mkCushion = (w: number, d: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, cushionH, d), cushionMat);
      m.position.set(x, cushionH / 2 - 0.02, z);
      m.userData.pickId = "table";
      scene.add(m);
    };
    mkCushion(BL_WIDTH / S + 0.1, 0.16, 0, -BL_HEIGHT / S / 2 - 0.02);
    mkCushion(BL_WIDTH / S + 0.1, 0.16, 0, BL_HEIGHT / S / 2 + 0.02);
    mkCushion(0.16, BL_HEIGHT / S + 0.1, -BL_WIDTH / S / 2 - 0.02, 0);
    mkCushion(0.16, BL_HEIGHT / S + 0.1, BL_WIDTH / S / 2 + 0.02, 0);
    // ポケット (黒い穴 + 金属縁)
    const pocketTargets: THREE.Object3D[] = [felt, frame];
    for (const p of BL_POCKETS) {
      const hole = new THREE.Mesh(
        new THREE.CylinderGeometry(BL_POCKET_RADIUS / S, BL_POCKET_RADIUS / S, 0.05, 24),
        new THREE.MeshStandardMaterial({ color: 0x101418, roughness: 0.9 }),
      );
      hole.position.set(toX(p.x), 0.012, toZ(p.y));
      scene.add(hole);
      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(BL_POCKET_RADIUS / S, 0.025, 8, 24),
        new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.35, metalness: 0.5 }),
      );
      rim.rotation.x = Math.PI / 2;
      rim.position.set(toX(p.x), 0.03, toZ(p.y));
      scene.add(rim);
    }
    // キュー (細い円柱を X 軸方向へ倒し、グループの Y 回転で狙いに合わせる)
    const cueGroup = new THREE.Group();
    const cueShaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.042, 2.9, 10),
      new THREE.MeshStandardMaterial({ color: 0xd9b380, roughness: 0.5 }),
    );
    cueShaft.rotation.z = Math.PI / 2;
    cueGroup.add(cueShaft);
    const cueTip = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.018, 0.06, 10),
      new THREE.MeshStandardMaterial({ color: 0x31517d, roughness: 0.6 }),
    );
    cueTip.rotation.z = Math.PI / 2;
    cueTip.position.x = 1.47;
    cueGroup.add(cueTip);
    cueGroup.position.y = BALL_Y;
    scene.add(cueGroup);
    // ガイド線
    const guide = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.12, gapSize: 0.09, transparent: true, opacity: 0.85 }),
    );
    scene.add(guide);

    const ballMeshes = new Map<number, THREE.Mesh>();
    const targets = new Map<number, { x: number; z: number; pocketed: boolean }>();
    for (const b of propsRef.current.balls) {
      const mesh = makeBall(b.id);
      mesh.position.set(toX(b.x), BALL_Y, toZ(b.y));
      mesh.visible = !b.pocketed;
      scene.add(mesh);
      ballMeshes.set(b.id, mesh);
      targets.set(b.id, { x: toX(b.x), z: toZ(b.y), pocketed: b.pocketed });
    }
    rtRef.current = { balls: ballMeshes, targets, cueGroup, guide, scene };

    const aimFromPoint = (pt: THREE.Vector3) => {
      const p = propsRef.current;
      if (!p.aiming) return;
      const cueBall = p.balls.find((b) => b.id === 0);
      if (!cueBall || cueBall.pocketed) return;
      const gx = toGx(pt.x);
      const gy = toGy(pt.z);
      const dx = gx - cueBall.x;
      const dy = gy - cueBall.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 4) return;
      const angleDeg = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
      // 強さは「手球から離して引く距離」で決める: 近い=弱い / 遠い=強い。
      const power = Math.max(5, Math.min(100, Math.round(((dist - 40) / 520) * 100)));
      dragRef.current = { moved: dist };
      p.onAim(angleDeg, power);
    };

    detach = attachPickPointer(
      stage,
      () => [...pocketTargets, ...ballMeshes.values()],
      {
        onTap: (hit) => {
          if (hit) aimFromPoint(hit.point);
        },
        onDragStart: () => { dragRef.current = { moved: 0 }; },
        onDragMove: (point) => aimFromPoint(point),
        onDragEnd: (flick) => {
          // 速いフリックで離したら、その狙いのまま打つ (既存の打つ操作のジェスチャ版)。
          const speed = Math.hypot(flick.vxPx, flick.vyPx);
          if (speed > 650 && propsRef.current.aiming) propsRef.current.onShoot();
          dragRef.current = null;
        },
        onFlick: () => { if (propsRef.current.aiming) propsRef.current.onShoot(); },
      },
      { planeY: BALL_Y },
    );
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 親の表示ボール (フレーム再生結果) を補間ターゲットへ同期する。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    for (const b of balls) {
      if (!rt.balls.has(b.id)) {
        const mesh = makeBall(b.id);
        mesh.position.set(toX(b.x), BALL_Y, toZ(b.y));
        rt.scene.add(mesh);
        rt.balls.set(b.id, mesh);
      }
      rt.targets.set(b.id, { x: toX(b.x), z: toZ(b.y), pocketed: b.pocketed });
    }
  }, [balls]);

  return (
    <SceneBox
      height={340}
      label="ビリヤードテーブル (3D)。ドラッグで狙い、フリックで打ちます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#2a1d12"
    />
  );
}
