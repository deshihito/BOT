"use client";
// ピンポンの 3D シーン。3D テーブル (センターライン + ネット) + 球のパック +
// 両パドル。物理・得点はクライアントの rAF ループ (PongClient 内のロジック)
// が決め、ここは親の状態を getState で毎フレーム読み、指数補間で追従する
// だけ。3D 側で衝突・ゴール判定はしない。ゴール時はスコア差分で該当側の
// ゴールラインを発光させる演出だけを行う。
// 入力 (PR #796 で確定した手書き pointerdown 判定を壊さない):
//   attachPickPointer はパドル追従 (hover / planePoint) 専用に使う。
//   タップ / ダブルタップ判定は attachPickPointer 経由 (pointerup 判定で
//   開始が遅れる) にせず、canvas の pointerdown を直接親の既存ハンドラ
//   (onPointerDown) へ渡す。親は受け取った clientY で従来どおり
//   「開始・再開は遅延なし / プレイ中の同位置ダブルタップ = ポーズ」を
//   判定し、パドルの位置は planePoint から変換した onTarget が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createBall, canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

// PongClient と同じフィールド定義 (pong は lib に専用ファイルがないため、
// クライアント内の定数をここへ写す。ロジック側は変更しない)。
const FIELD_W = 800;
const FIELD_H = 480;
const PADDLE_W = 12;
const PADDLE_H = 84;
const PLAYER_X = 18;
const CPU_X = FIELD_W - 18 - PADDLE_W;

export interface PongViewState {
  ball: { x: number; y: number };
  playerY: number;
  cpuY: number;
  playerScore: number;
  cpuScore: number;
}

interface Props {
  /** 親のゲームループが進める最新の状態を読む (React 再描画を介さない)。 */
  getState: () => PongViewState;
  /** プレイヤーパドルの目標位置 (フィールド座標 y)。クランプはクライアント側。 */
  onTarget: (fieldY: number) => void;
  /**
   * pointerdown の clientY をそのまま受ける既存タップ判定ハンドラ。
   * 開始・再開・ダブルタップ = ポーズの判定はすべて親 (PongClient) が持つ。
   */
  onPointerDown: (clientY: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const S = 100;
const toX = (gx: number) => (gx - FIELD_W / 2) / S;
const toZ = (gy: number) => (gy - FIELD_H / 2) / S;
const toGy = (z: number) => z * S + FIELD_H / 2;
const TABLE_Y = 0;

interface SceneRt {
  ball: THREE.Mesh;
  player: THREE.Mesh;
  cpu: THREE.Mesh;
  goalLeftMat: THREE.MeshStandardMaterial;
  goalRightMat: THREE.MeshStandardMaterial;
  prevScores: { player: number; cpu: number };
  flashLeft: number;
  flashRight: number;
}

export default function PongScene3D({ getState, onTarget, onPointerDown, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ getState, onTarget, onPointerDown });
  propsRef.current = { getState, onTarget, onPointerDown };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x0a1420,
      camera: { position: [0, 8.2, 6.0], lookAt: [0, 0, 0.2], fov: 44 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        const s = propsRef.current.getState();
        // スコア差分は既存ロジックの結果。演出 (ゴールラインの発光) だけに使う。
        // プレイヤー得点 = 右 (CPU 側) ゴール、CPU 得点 = 左 (自分側) ゴール。
        if (s.playerScore > rt.prevScores.player) rt.flashRight = 1;
        if (s.cpuScore > rt.prevScores.cpu) rt.flashLeft = 1;
        rt.prevScores = { player: s.playerScore, cpu: s.cpuScore };
        rt.flashLeft = Math.max(0, rt.flashLeft - dt * 1.6);
        rt.flashRight = Math.max(0, rt.flashRight - dt * 1.6);
        rt.goalLeftMat.emissive.setRGB(rt.flashLeft * 0.9, rt.flashLeft * 0.2, rt.flashLeft * 0.15);
        rt.goalRightMat.emissive.setRGB(rt.flashRight * 0.2, rt.flashRight * 0.9, rt.flashRight * 0.3);
        // 補間追従: dt クランプ済み (0.05) の指数補間で親ループの状態へ寄せる。
        const k = Math.min(1, dt * 48);
        rt.ball.position.x += (toX(s.ball.x) - rt.ball.position.x) * k;
        rt.ball.position.z += (toZ(s.ball.y) - rt.ball.position.z) * k;
        rt.player.position.z += (toZ(s.playerY) - rt.player.position.z) * k;
        rt.cpu.position.z += (toZ(s.cpuY) - rt.cpu.position.z) * k;
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // テーブル土台 + 盤面 (センターラインはテクスチャで大きく描く)
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(FIELD_W / S + 0.4, 0.24, FIELD_H / S + 0.4),
      new THREE.MeshStandardMaterial({ color: 0x14304a, roughness: 0.6 }),
    );
    base.position.y = -0.15;
    scene.add(base);
    const surfaceTex = canvasTexture("pong-surface", 256, 160, (g) => {
      g.fillStyle = "#0e1a28";
      g.fillRect(0, 0, 256, 160);
      g.strokeStyle = "rgba(255,255,255,0.4)";
      g.lineWidth = 3;
      g.setLineDash([10, 8]);
      g.beginPath();
      g.moveTo(128, 0);
      g.lineTo(128, 160);
      g.stroke();
      g.setLineDash([]);
      g.beginPath();
      g.arc(128, 80, 26, 0, Math.PI * 2);
      g.stroke();
    });
    const surface = new THREE.Mesh(
      new THREE.BoxGeometry(FIELD_W / S, 0.05, FIELD_H / S),
      new THREE.MeshStandardMaterial({ map: surfaceTex, roughness: 0.5 }),
    );
    surface.position.y = -0.025;
    surface.userData.pickId = "table";
    scene.add(surface);
    // 上下の壁 (奥 / 手前)
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x7fa8cc, roughness: 0.45, metalness: 0.15 });
    const mkWall = (z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(FIELD_W / S + 0.24, 0.3, 0.1), wallMat);
      m.position.set(0, 0.12, z);
      scene.add(m);
    };
    mkWall(-FIELD_H / S / 2 - 0.05);
    mkWall(FIELD_H / S / 2 + 0.05);
    // ゴールライン (得点時に発光)
    const goalLeftMat = new THREE.MeshStandardMaterial({ color: 0xe85d4a, roughness: 0.4, emissive: 0x000000 });
    const goalRightMat = new THREE.MeshStandardMaterial({ color: 0x7ee787, roughness: 0.4, emissive: 0x000000 });
    const goalLeft = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, FIELD_H / S), goalLeftMat);
    goalLeft.position.set(-FIELD_W / S / 2, 0.05, 0);
    scene.add(goalLeft);
    const goalRight = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, FIELD_H / S), goalRightMat);
    goalRight.position.set(FIELD_W / S / 2, 0.05, 0);
    scene.add(goalRight);
    // ネット (中央の半透明の壁 + 上端バー)
    const net = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.55, FIELD_H / S),
      new THREE.MeshStandardMaterial({ color: 0xdfe7ef, roughness: 0.5, transparent: true, opacity: 0.32 }),
    );
    net.position.y = 0.28;
    scene.add(net);
    const netTop = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.06, FIELD_H / S),
      new THREE.MeshStandardMaterial({ color: 0xf2f5f9, roughness: 0.4 }),
    );
    netTop.position.y = 0.58;
    scene.add(netTop);

    const mkPaddle = (color: number, gx: number) => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(PADDLE_W / S + 0.04, 0.3, PADDLE_H / S),
        new THREE.MeshStandardMaterial({ color, roughness: 0.35 }),
      );
      m.position.set(toX(gx + PADDLE_W / 2), 0.15, 0);
      scene.add(m);
      return m;
    };
    const player = mkPaddle(0x7ee787, PLAYER_X);
    const cpu = mkPaddle(0xe85d4a, CPU_X);
    const ball = createBall(0.09, 0xffd34d);
    ball.position.y = 0.14;
    scene.add(ball);

    const s0 = propsRef.current.getState();
    ball.position.set(toX(s0.ball.x), 0.14, toZ(s0.ball.y));
    player.position.z = toZ(s0.playerY);
    cpu.position.z = toZ(s0.cpuY);

    rtRef.current = {
      ball,
      player,
      cpu,
      goalLeftMat,
      goalRightMat,
      prevScores: { player: s0.playerScore, cpu: s0.cpuScore },
      flashLeft: 0,
      flashRight: 0,
    };

    const sendTarget = (pt: THREE.Vector3) => {
      propsRef.current.onTarget(toGy(pt.z));
    };
    // パドル追従専用 (タップ判定は付けない。下の pointerdown 直通が担う)。
    detach = attachPickPointer(
      stage,
      () => [surface, base],
      {
        onDragMove: (point) => sendTarget(point),
        onHover: (hit) => {
          if (hit) sendTarget(hit.point);
        },
      },
      { planeY: TABLE_Y, hover: true },
    );
    // pointerdown 直通: 親の既存ハンドラへ clientY をそのまま渡し、
    // パドル位置は同じイベントの planePoint から onTarget で渡す。
    // これにより開始・再開に遅延がなく、ダブルタップ判定 (時刻 + 高さ
    // 48px ガード) も 2D と完全に同じ入力で判定される。
    const directDown = (e: PointerEvent) => {
      const pt = stage.planePoint(TABLE_Y, e.clientX, e.clientY);
      if (pt) sendTarget(pt);
      propsRef.current.onPointerDown(e.clientY);
    };
    stage.canvas.addEventListener("pointerdown", directDown);
    setReady(true);
    return () => {
      stage.canvas.removeEventListener("pointerdown", directDown);
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <SceneBox
      height={460}
      label="ピンポンのコート (3D)。ポインタで左パドルを動かし、タップで開始、プレイ中のダブルタップでポーズ"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#0a1420"
    />
  );
}
