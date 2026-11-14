"use client";
// パットゴルフの 3D シーン。グリーン＋傾斜パッド＋壁＋カップ（穴＋旗）を
// 立体化し、ボールは createBall で表現する。
// 物理・到達判定は lib/puttgolf.ts が決め、ここは親が result.points の
// 軌跡再生で更新する表示位置 (ball) へ指数補間で追従して結果位置へ
// 収束させるだけ。3D 側で当たり判定・カップイン判定はしない。
// 傾斜ゾーンは lib の PgSlope (dx, dy) を、流れ方向へわずかに傾けた
// パッド＋矢印シェブロンで表現し、法線と陰影で向きが読み取れるようにする。
// 入力: グリーン上のドラッグ = 狙い（ボールからポインタへの角度＋
//       powerForDistance による強さ）をスライダー値へ接続し、
//       タップ = 打つ／次のホールへ（従来のコースタップと同一）、
//       速いドラッグ終了／フリック = その狙いで打つ。
//       スライダーも従来どおり使える。
// 数字・状態（ホール番号・打数・パー）は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createBall, canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import {
  PG_BALL_RADIUS,
  PG_CUP_RADIUS,
  PG_HEIGHT,
  PG_WIDTH,
  powerForDistance,
  type PgHole,
  type PgPoint,
} from "@/lib/puttgolf";

interface Props {
  hole: PgHole;
  /** 親が軌跡 (result.points) を再生した表示位置。 */
  ball: PgPoint;
  angle: number;
  power: number;
  /** 狙いガイドを表示するか（プレイ中・静止中）。 */
  aiming: boolean;
  /** ドラッグで狙いを変えられるか（プレイ中・静止中）。 */
  canShoot: boolean;
  /** カップイン済みか（ボールを穴へ沈める表現）。 */
  holed: boolean;
  onAim: (angle: number, power: number) => void;
  onShoot: () => void;
  /** コースのタップ（打つ／次のホールへは親が振り分ける）。 */
  onTapCourse: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

// ゲーム座標 (720x440, y 下向き) -> 3D (x: -3.6..3.6, z: -2.2..2.2)
const S = 100;
const toX = (gx: number) => (gx - PG_WIDTH / 2) / S;
const toZ = (gy: number) => (gy - PG_HEIGHT / 2) / S;
const toGx = (x: number) => x * S + PG_WIDTH / 2;
const toGy = (z: number) => z * S + PG_HEIGHT / 2;
const BALL_R = PG_BALL_RADIUS / S;
const BALL_Y = BALL_R + 0.03;
const CUP_R = PG_CUP_RADIUS / S;

interface SceneRt {
  ball: THREE.Mesh;
  target: { x: number; z: number };
  courseGroup: THREE.Group;
  guideLine: THREE.Line;
  guideArrow: THREE.Group;
  pickTargets: THREE.Object3D[];
  holeIndex: number;
}

/** 傾斜パッド＋壁＋カップ＋ティーを hole 定義から組み直す（ホール切替時）。 */
function buildCourse(group: THREE.Group, hole: PgHole) {
  // 旧ホールの造形を破棄する。
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = (mesh as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
  }

  // 傾斜ゾーン: 流れ方向へ傾けたパッド＋矢印シェブロン（2D の矢印マスに対応）。
  for (const s of hole.slopes) {
    // ゲーム角度（0=右, 90=下）。world では z がゲーム y に対応する。
    const a = Math.atan2(s.dy, s.dx);
    const padGroup = new THREE.Group();
    padGroup.position.set(toX(s.x + s.w / 2), 0.03, toZ(s.y + s.h / 2));
    padGroup.rotation.y = -a; // ローカル +x が流れ方向を向く
    const tilt = new THREE.Group();
    tilt.rotation.z = -0.055; // 流れ方向へ下る傾き（陰影で向きが読める）
    padGroup.add(tilt);
    const along = (Math.abs(s.dx) > 0 ? s.w : s.h) / S;
    const across = (Math.abs(s.dx) > 0 ? s.h : s.w) / S;
    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(along, 0.045, across),
      new THREE.MeshStandardMaterial({ color: 0x57a463, roughness: 0.9 }),
    );
    pad.position.y = 0.022;
    pad.userData.pickId = "course";
    tilt.add(pad);
    const chevMat = new THREE.MeshStandardMaterial({ color: 0xeaf5ec, roughness: 0.5 });
    for (const off of [-0.24, 0.24]) {
      const chev = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.22, 12), chevMat);
      chev.rotation.z = -Math.PI / 2; // 尖端をローカル +x（流れ方向）へ
      chev.position.set(off * along, 0.075, 0);
      tilt.add(chev);
    }
    group.add(padGroup);
  }

  // 壁（2D の茶色い矩形）。
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x8a5a33, roughness: 0.8 });
  const wallTopMat = new THREE.MeshStandardMaterial({ color: 0x6f4525, roughness: 0.8 });
  for (const w of hole.walls) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w.w / S, 0.17, w.h / S), wallMat);
    wall.position.set(toX(w.x + w.w / 2), 0.115, toZ(w.y + w.h / 2));
    wall.userData.pickId = "course";
    group.add(wall);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(w.w / S + 0.02, 0.025, w.h / S + 0.02), wallTopMat);
    cap.position.set(wall.position.x, 0.21, wall.position.z);
    group.add(cap);
  }

  // ティー（スタート位置の白マーカー）。
  const tee = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.055, 0.014, 20),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, transparent: true, opacity: 0.6 }),
  );
  tee.position.set(toX(hole.tee.x), 0.037, toZ(hole.tee.y));
  group.add(tee);

  // カップ: 穴（暗い円柱）＋白い縁＋旗ポール＋旗。
  const cupX = toX(hole.cup.x);
  const cupZ = toZ(hole.cup.y);
  const holeDisc = new THREE.Mesh(
    new THREE.CylinderGeometry(CUP_R, CUP_R, 0.03, 24),
    new THREE.MeshStandardMaterial({ color: 0x0d2412, roughness: 0.95 }),
  );
  holeDisc.position.set(cupX, 0.032, cupZ);
  holeDisc.userData.pickId = "course";
  group.add(holeDisc);
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(CUP_R + 0.008, 0.016, 8, 28),
    new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 }),
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.set(cupX, 0.045, cupZ);
  group.add(rim);
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.013, 0.013, 0.62, 10),
    new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.35, metalness: 0.4 }),
  );
  pole.position.set(cupX, 0.34, cupZ);
  group.add(pole);
  const knob = new THREE.Mesh(
    new THREE.SphereGeometry(0.026, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xf6c90e, roughness: 0.35 }),
  );
  knob.position.set(cupX, 0.67, cupZ);
  group.add(knob);
  const flagShape = new THREE.Shape();
  flagShape.moveTo(0, 0);
  flagShape.lineTo(0.36, 0.075);
  flagShape.lineTo(0, 0.15);
  flagShape.closePath();
  const flag = new THREE.Mesh(
    new THREE.ShapeGeometry(flagShape),
    new THREE.MeshStandardMaterial({ color: 0xd43a2f, roughness: 0.55, side: THREE.DoubleSide }),
  );
  flag.position.set(cupX, 0.5, cupZ);
  group.add(flag);
}

export default function PuttGolfScene3D({
  hole,
  ball,
  angle,
  power,
  aiming,
  canShoot,
  holed,
  onAim,
  onShoot,
  onTapCourse,
  onFail,
  fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);

  const propsRef = useRef({ hole, ball, angle, power, aiming, canShoot, holed, onAim, onShoot, onTapCourse });
  propsRef.current = { hole, ball, angle, power, aiming, canShoot, holed, onAim, onShoot, onTapCourse };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x1e3a24,
      camera: { position: [0, 7.0, 4.5], lookAt: [0, 0, 0.15], fov: 42 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        // 親の軌跡再生（26ms 刻みの点列）へ指数補間で追従し、結果位置へ収束させる。
        const k = Math.min(1, dt * 30);
        rt.ball.position.x += (rt.target.x - rt.ball.position.x) * k;
        rt.ball.position.z += (rt.target.z - rt.ball.position.z) * k;
        const targetY = propsRef.current.holed ? 0.02 : BALL_Y;
        rt.ball.position.y += (targetY - rt.ball.position.y) * k;
        // 狙いガイド（破線＋矢印）は最新の角度・強さとボール位置に合わせる。
        const p = propsRef.current;
        const show = p.aiming;
        rt.guideLine.visible = show;
        rt.guideArrow.visible = show;
        if (show) {
          const rad = (p.angle * Math.PI) / 180;
          const dir = new THREE.Vector3(Math.cos(rad), 0, Math.sin(rad));
          const origin = new THREE.Vector3(rt.ball.position.x, BALL_Y + 0.03, rt.ball.position.z);
          // 2D ガイドと同じ長さ規約（30 + power * 2.2 px）。
          const len = (30 + p.power * 2.2) / S;
          const end = origin.clone().addScaledVector(dir, len);
          (rt.guideLine.geometry as THREE.BufferGeometry).setFromPoints([origin, end]);
          rt.guideLine.computeLineDistances();
          rt.guideArrow.position.copy(end);
          rt.guideArrow.rotation.y = -rad;
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // 木枠とグリーン（縞テクスチャで芝の流れを出す）。
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(PG_WIDTH / S + 0.5, 0.2, PG_HEIGHT / S + 0.5),
      new THREE.MeshStandardMaterial({ color: 0x5f4630, roughness: 0.7 }),
    );
    frame.position.y = -0.1;
    frame.userData.pickId = "course";
    scene.add(frame);
    const greenTex = canvasTexture("puttgolf-green", 288, 176, (g) => {
      g.fillStyle = "#3e8e4f";
      g.fillRect(0, 0, 288, 176);
      for (let x = 0; x < 288; x += 36) {
        g.fillStyle = "rgba(255,255,255,0.045)";
        g.fillRect(x, 0, 18, 176);
      }
      g.fillStyle = "rgba(0,0,0,0.05)";
      for (let i = 0; i < 420; i++) g.fillRect((i * 37) % 288, (i * 53) % 176, 2, 2);
    });
    const green = new THREE.Mesh(
      new THREE.BoxGeometry(PG_WIDTH / S, 0.06, PG_HEIGHT / S),
      new THREE.MeshStandardMaterial({ map: greenTex, roughness: 1 }),
    );
    green.position.y = 0;
    green.userData.pickId = "course";
    scene.add(green);

    const courseGroup = new THREE.Group();
    scene.add(courseGroup);
    buildCourse(courseGroup, propsRef.current.hole);

    const ballMesh = createBall(BALL_R, 0xffffff, { roughness: 0.3 });
    ballMesh.position.set(toX(propsRef.current.ball.x), BALL_Y, toZ(propsRef.current.ball.y));
    ballMesh.userData.pickId = "ball";
    scene.add(ballMesh);

    // 狙いガイド: 破線＋先端の矢印コーン。
    const guideLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.11, gapSize: 0.08, transparent: true, opacity: 0.9 }),
    );
    scene.add(guideLine);
    const guideArrow = new THREE.Group();
    const arrowHead = new THREE.Mesh(
      new THREE.ConeGeometry(0.055, 0.18, 12),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }),
    );
    arrowHead.rotation.z = -Math.PI / 2;
    guideArrow.add(arrowHead);
    guideArrow.position.y = BALL_Y + 0.03;
    scene.add(guideArrow);

    rtRef.current = {
      ball: ballMesh,
      target: { x: toX(propsRef.current.ball.x), z: toZ(propsRef.current.ball.y) },
      courseGroup,
      guideLine,
      guideArrow,
      pickTargets: [green, frame, courseGroup, ballMesh],
      holeIndex: propsRef.current.hole.index,
    };

    const aimFromPoint = (pt: THREE.Vector3) => {
      const p = propsRef.current;
      if (!p.canShoot) return;
      const gx = toGx(pt.x);
      const gy = toGy(pt.z);
      const dx = gx - p.ball.x;
      const dy = gy - p.ball.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 6) return;
      // 角度規約はクライアントと同じ（0=右、90=下、atan2 の画面座標）。
      const angleDeg = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
      // 強さは「その点までちょうど届く」目安（aimAtCup と同じ lib の換算）。
      const pw = Math.max(0, Math.min(100, Math.round(powerForDistance(dist))));
      p.onAim(angleDeg, pw);
    };

    detach = attachPickPointer(
      stage,
      () => rtRef.current?.pickTargets ?? [],
      {
        onTap: () => {
          // 従来のコースタップと同一（打つ／次のホールへは親が振り分ける）。
          propsRef.current.onTapCourse();
        },
        onDragMove: (point) => aimFromPoint(point),
        onDragEnd: (flick) => {
          // 速いドラッグで離したら、その狙いのまま打つ（フリックで打つ語彙）。
          const speed = Math.hypot(flick.vxPx, flick.vyPx);
          if (speed > 650 && propsRef.current.canShoot) propsRef.current.onShoot();
        },
        onFlick: () => {
          if (propsRef.current.canShoot) propsRef.current.onShoot();
        },
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

  // ホールが変わったらコース造形を組み直す。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    buildCourse(rt.courseGroup, hole);
  }, [hole]);

  // 親の表示ボールを補間ターゲットへ同期する。ホール切替時はその場へ置く。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    rt.target = { x: toX(ball.x), z: toZ(ball.y) };
    if (rt.holeIndex !== hole.index) {
      rt.holeIndex = hole.index;
      rt.ball.position.set(toX(ball.x), BALL_Y, toZ(ball.y));
    }
  }, [ball, hole]);

  return (
    <SceneBox
      height={420}
      label="パットゴルフのコース (3D)。ドラッグで狙い、タップで打ちます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#1e3a24"
    />
  );
}
