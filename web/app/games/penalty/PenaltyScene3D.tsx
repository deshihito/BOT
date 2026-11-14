"use client";
// PK戦の 3D シーン。ゴール（枠＋ネット）＋ボール＋キーパーを立体造形する。
// 入力の語彙は現行 2D と同じ「6ゾーン選択」: ゴール面へのタップを
// attachPickPointer のレイキャストで受け、hit.point を正規化して
// ゾーン番号へ変換し、既存ハンドラ onChoose（playerShoot / playerDive）へ渡す。
// 判定は lib/penalty.ts のまま。ここは表現だけを持ち、シュート結果
// （直近キックの zone / keeperZone / outcome）へボール飛翔とキーパーの
// ダイブをアニメーション追従させる。守備ターンも同じシーン・同じ
// ゾーン選択で操作する（キーパーを操作する現行語彙に接続）。
// スコア・残り本数等は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createBall, canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { PenaltyState } from "@/lib/penalty";

interface Props {
  state: PenaltyState;
  onChoose: (zone: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const GOAL_W = 5.4;
const GOAL_H = 2.2;
const BALL_SPOT = new THREE.Vector3(0, 0.24, 3.1);
const KEEPER_HOME = new THREE.Vector3(0, 0, 0.35);
const FLY_MS = 560;
const HOLD_MS = 750;

/** ゾーン番号（0-5、左上から右下）→ ゴール面上の中心点。 */
function zoneCenter(zone: number): THREE.Vector3 {
  const col = zone % 3;
  const row = Math.floor(zone / 3);
  return new THREE.Vector3((col - 1) * (GOAL_W / 3), row === 0 ? GOAL_H * 0.75 : GOAL_H * 0.25, 0);
}

/** 枠外ミスの着弾点（狙いゾーンの外側へ外す）。 */
function missedPoint(zone: number): THREE.Vector3 {
  const c = zoneCenter(zone);
  const col = zone % 3;
  const row = Math.floor(zone / 3);
  const x = col === 1 ? c.x + 0.45 : c.x * 1.45;
  const y = row === 0 ? c.y + 0.55 : Math.max(0.35, c.y - 0.25);
  return new THREE.Vector3(x, y, 0);
}

/** ワールド点 → ゾーン番号（ゴール面を 3×2 に正規化、範囲外は端へクランプ）。 */
function zoneFromPoint(p: THREE.Vector3): number {
  const col = Math.min(2, Math.max(0, Math.floor(((p.x + GOAL_W / 2) / GOAL_W) * 3)));
  const row = p.y >= GOAL_H / 2 ? 0 : 1;
  return row * 3 + col;
}

function makeKeeper(): THREE.Group {
  const grp = new THREE.Group();
  const jersey = new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.55 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.6 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xe8b88a, roughness: 0.5 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.26, 0.78, 14), jersey);
  body.position.y = 0.95;
  grp.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 12), skin);
  head.position.y = 1.52;
  grp.add(head);
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.11, 0.11), jersey);
    arm.position.set(s * 0.44, 1.22, 0);
    arm.rotation.z = s * 0.25;
    grp.add(arm);
    const glove = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }));
    glove.position.set(s * 0.72, 1.36, 0);
    grp.add(glove);
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.58, 0.13), dark);
    leg.position.set(s * 0.13, 0.29, 0);
    grp.add(leg);
  }
  return grp;
}

function makeBall(): THREE.Group {
  const grp = new THREE.Group();
  const ball = createBall(0.22, 0xffffff, { roughness: 0.35 });
  grp.add(ball);
  const patchMat = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.45 });
  const patchPos: Array<[number, number, number]> = [
    [0, 0.21, 0.05], [0.19, -0.08, 0.08], [-0.19, -0.08, 0.08],
    [0.08, 0.05, -0.19], [-0.08, 0.05, -0.19], [0, -0.21, -0.05],
  ];
  for (const [x, y, z] of patchPos) {
    const patch = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 8), patchMat);
    patch.position.set(x, y, z);
    grp.add(patch);
  }
  return grp;
}

interface KickAnim {
  start: number;
  ballTarget: THREE.Vector3;
  ballEnd: THREE.Vector3;
  keeperTo: THREE.Vector3;
  keeperRotZ: number;
}

interface SceneRt {
  ball: THREE.Group;
  keeper: THREE.Group;
  anim: KickAnim | null;
  animDoneAt: number;
  lastSeenKicks: number;
}

export default function PenaltyScene3D({ state, onChoose, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onChoose, status: state.status });
  propsRef.current = { onChoose, status: state.status };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;
  const prevKicksRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x14532d,
      camera: { position: [0, 2.1, 6.4], lookAt: [0, 1.0, 0], fov: 42 },
      onFrame: (_dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        const now = performance.now();
        if (rt.anim) {
          const k = Math.min(1, Math.max(0, (now - rt.anim.start) / FLY_MS));
          const ease = 1 - Math.pow(1 - k, 2);
          const target = rt.anim.ballTarget;
          const end = rt.anim.ballEnd;
          if (k < 1) {
            rt.ball.position.lerpVectors(BALL_SPOT, target, ease);
            rt.ball.position.y += Math.sin(ease * Math.PI) * 0.12;
          } else {
            const hk = Math.min(1, Math.max(0, (now - rt.anim.start - FLY_MS) / 260));
            rt.ball.position.lerpVectors(target, end, hk);
            if (hk >= 1 && rt.animDoneAt === 0) rt.animDoneAt = now;
          }
          rt.keeper.position.lerpVectors(KEEPER_HOME, rt.anim.keeperTo, ease);
          rt.keeper.rotation.z = rt.anim.keeperRotZ * ease;
          rt.keeper.rotation.x = 0;
          if (rt.animDoneAt > 0 && now - rt.animDoneAt > HOLD_MS) {
            // 結果表示の保持が終わったら次のキックの構えへ戻す。
            rt.anim = null;
            rt.animDoneAt = 0;
            rt.ball.position.copy(BALL_SPOT);
            rt.keeper.position.copy(KEEPER_HOME);
            rt.keeper.rotation.z = 0;
          }
        } else {
          // 待機中は小さく揺れる（キーパーの読み合い前の構え）。
          rt.keeper.position.x = Math.sin(t * 1.6) * 0.08;
          rt.keeper.position.y = 0;
          rt.keeper.rotation.z = Math.sin(t * 1.6) * 0.04;
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // ピッチ
    const pitch = new THREE.Mesh(
      new THREE.BoxGeometry(10, 0.1, 8),
      new THREE.MeshStandardMaterial({ color: 0x1c7a3f, roughness: 0.85 }),
    );
    pitch.position.set(0, -0.05, 1.6);
    scene.add(pitch);
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 });
    const goalLine = new THREE.Mesh(new THREE.BoxGeometry(GOAL_W + 1.4, 0.012, 0.07), lineMat);
    goalLine.position.set(0, 0.012, 0.55);
    scene.add(goalLine);
    const spot = new THREE.Mesh(new THREE.CircleGeometry(0.09, 16), lineMat);
    spot.rotation.x = -Math.PI / 2;
    spot.position.set(BALL_SPOT.x, 0.012, BALL_SPOT.z);
    scene.add(spot);
    // 背景スタンド（暗い壁で奥行きを出す）
    const stand = new THREE.Mesh(
      new THREE.BoxGeometry(11, 3.6, 0.2),
      new THREE.MeshStandardMaterial({ color: 0x243447, roughness: 0.9 }),
    );
    stand.position.set(0, 1.8, -1.35);
    scene.add(stand);

    // ゴール: 枠（ポスト＋クロスバー）
    const goalGroup = new THREE.Group();
    scene.add(goalGroup);
    const postMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 });
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, GOAL_H, 12), postMat);
      post.position.set(s * (GOAL_W / 2), GOAL_H / 2, 0);
      post.userData.pickId = "goal";
      goalGroup.add(post);
    }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, GOAL_W + 0.11, 12), postMat);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, GOAL_H, 0);
    bar.userData.pickId = "goal";
    goalGroup.add(bar);
    // ネット: 格子テクスチャの背面＋側面＋天面
    const netTex = canvasTexture("penalty-net", 128, 128, (g) => {
      g.clearRect(0, 0, 128, 128);
      g.strokeStyle = "rgba(255,255,255,0.85)";
      g.lineWidth = 2;
      for (let i = 0; i <= 128; i += 16) {
        g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.stroke();
        g.beginPath(); g.moveTo(0, i); g.lineTo(128, i); g.stroke();
      }
    });
    netTex.wrapS = THREE.RepeatWrapping;
    netTex.wrapT = THREE.RepeatWrapping;
    const netMat = new THREE.MeshBasicMaterial({ map: netTex, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    const netBack = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_W, GOAL_H), netMat);
    netBack.position.set(0, GOAL_H / 2, -0.75);
    goalGroup.add(netBack);
    for (const s of [-1, 1]) {
      const netSide = new THREE.Mesh(new THREE.PlaneGeometry(0.75, GOAL_H), netMat);
      netSide.rotation.y = Math.PI / 2;
      netSide.position.set(s * (GOAL_W / 2), GOAL_H / 2, -0.375);
      goalGroup.add(netSide);
    }
    const netTop = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_W, 0.75), netMat);
    netTop.rotation.x = Math.PI / 2;
    netTop.position.set(0, GOAL_H, -0.375);
    goalGroup.add(netTop);
    // ゾーン区切り（2D の 3×2 グリッドに対応する目安線）
    const guideMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28 });
    for (const x of [-GOAL_W / 6, GOAL_W / 6]) {
      const v = new THREE.Mesh(new THREE.BoxGeometry(0.02, GOAL_H, 0.01), guideMat);
      v.position.set(x, GOAL_H / 2, 0.02);
      goalGroup.add(v);
    }
    const hGuide = new THREE.Mesh(new THREE.BoxGeometry(GOAL_W, 0.02, 0.01), guideMat);
    hGuide.position.set(0, GOAL_H / 2, 0.02);
    goalGroup.add(hGuide);
    // ピック面: ゴール面＋少し外側まで（端ゾーンへのクランプ用）
    const pickPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(GOAL_W + 1.6, GOAL_H + 1.0),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.04, depthWrite: false }),
    );
    pickPlane.position.set(0, GOAL_H / 2, 0.06);
    pickPlane.userData.pickId = "goal";
    goalGroup.add(pickPlane);

    const keeper = makeKeeper();
    keeper.position.copy(KEEPER_HOME);
    scene.add(keeper);
    const ball = makeBall();
    ball.position.copy(BALL_SPOT);
    scene.add(ball);

    rtRef.current = { ball, keeper, anim: null, animDoneAt: 0, lastSeenKicks: 0 };

    detach = attachPickPointer(
      stage,
      () => [goalGroup],
      {
        onTap: (hit) => {
          if (!hit) return;
          if (propsRef.current.status !== "playing") return;
          // レイキャスト点（ゴール面のワールド座標）をゾーンへ正規化して既存ハンドラへ。
          propsRef.current.onChoose(zoneFromPoint(hit.point));
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

  // キック結果への追従: 直近キックが増えたら飛翔＋ダイブを開始する。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    if (state.kicks.length < prevKicksRef.current) {
      // リスタート: ボールとキーパーを初期位置へ戻す。
      rt.anim = null;
      rt.animDoneAt = 0;
      rt.lastSeenKicks = state.kicks.length;
      rt.ball.position.copy(BALL_SPOT);
      rt.keeper.position.copy(KEEPER_HOME);
      rt.keeper.rotation.z = 0;
    }
    prevKicksRef.current = state.kicks.length;
    const last = state.kicks[state.kicks.length - 1];
    if (!last) return;
    if (state.kicks.length === rt.lastSeenKicks) return;
    rt.lastSeenKicks = state.kicks.length;
    const aim = zoneCenter(last.zone);
    const keeperAim = zoneCenter(last.keeperZone);
    const ballTarget = last.outcome === "missed" ? missedPoint(last.zone) : new THREE.Vector3(aim.x, aim.y, 0.02);
    const ballEnd =
      last.outcome === "goal"
        ? new THREE.Vector3(aim.x, aim.y, -0.55)
        : last.outcome === "saved"
          ? new THREE.Vector3(aim.x + (aim.x >= 0 ? 0.65 : -0.65), Math.max(0.2, aim.y - 0.3), 0.95)
          : ballTarget.clone();
    const keeperTo = new THREE.Vector3(
      keeperAim.x * 0.82,
      keeperAim.y > GOAL_H / 2 ? 0.42 : 0,
      KEEPER_HOME.z,
    );
    const keeperRotZ = keeperAim.x > 0.3 ? -0.85 : keeperAim.x < -0.3 ? 0.85 : 0;
    rt.ball.position.copy(BALL_SPOT);
    rt.keeper.position.copy(KEEPER_HOME);
    rt.anim = { start: performance.now(), ballTarget, ballEnd, keeperTo, keeperRotZ };
    rt.animDoneAt = 0;
  }, [state]);

  return (
    <SceneBox
      height={380}
      label="PK戦（3D）。ゴールをタップしたゾーンへ蹴る／飛びます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#14532d"
    />
  );
}
