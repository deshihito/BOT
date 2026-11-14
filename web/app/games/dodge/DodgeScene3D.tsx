"use client";
// よけゲーの 3D シーン。奥行きのあるトンネル空間に、自機と迫る障害物を
// 立体造形で表示する。生成・移動・衝突・スコアはクライアント側の既存
// ループ（ref 群）が持ち、ここは getSnapshot() を毎フレーム読んで
// 補間表示するだけ。3D 側で判定はしない。
// 入力: 床平面へのドラッグ / ホバー / タップの x をフィールド座標へ戻し、
// 既存の移動ハンドラ（targetX の設定）へそのまま渡す。
// 生存時間・よけた数は親の DOM 併記が正。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createBall, createDisc, canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

/** クライアントの障害物と同じ形（表示に必要な分だけ）。 */
export interface DodgeObstacleView {
  x: number;
  y: number;
  r: number;
  hue: number;
}

export interface DodgeSnapshot {
  playerX: number;
  obstacles: readonly DodgeObstacleView[];
}

interface Props {
  /** 親ループの最新状態を読む (React 再描画を介さない)。 */
  getSnapshot: () => DodgeSnapshot;
  /** フィールド座標 (0〜400) での移動先指定。既存ハンドラへ接続する。 */
  onMove: (fieldX: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

/** フィールドは 400 x 560 (クライアント内定義と同一)。 */
const FIELD_W = 400;
const FIELD_H = 560;
const PLAYER_FIELD_Y = FIELD_H - 52;
const S = 0.01;
const toX = (fx: number) => (fx - FIELD_W / 2) * S;
const toZ = (fy: number) => -7.5 + (fy / FIELD_H) * 10;
const toFieldX = (wx: number) => wx / S + FIELD_W / 2;
const PLAYER_Z = toZ(PLAYER_FIELD_Y);

function makePlayer(): THREE.Group {
  const grp = new THREE.Group();
  const base = createDisc(0.21, 0.05, 0x2b3038);
  base.position.y = 0.03;
  grp.add(base);
  const body = createBall(0.17, 0xffd23e, { roughness: 0.35 });
  body.position.y = 0.24;
  grp.add(body);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x1d1700, roughness: 0.5 });
  for (const sx of [-0.065, 0.065]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8), eyeMat);
    eye.position.set(sx, 0.29, 0.145);
    grp.add(eye);
  }
  return grp;
}

interface ObstacleEntry {
  group: THREE.Group;
  dispX: number;
  dispY: number;
  targetX: number;
  targetY: number;
  r: number;
}

interface SceneRt {
  player: THREE.Group;
  dispPlayerX: number;
  obstaclesGroup: THREE.Group;
  entries: ObstacleEntry[];
  floorTex: THREE.CanvasTexture;
}

export default function DodgeScene3D({ getSnapshot, onMove, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ getSnapshot, onMove });
  propsRef.current = { getSnapshot, onMove };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x0d1526,
      camera: { position: [0, 2.7, 6.9], lookAt: [0, 0.1, -1.4], fov: 46 },
      onFrame: (dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        const snap = propsRef.current.getSnapshot();
        // スピード感のための床テクスチャスクロール（表示のみ）。
        rt.floorTex.offset.y = -((t * 0.55) % 1);
        // 自機は親のプレイヤー位置へ補間追従。
        const k = Math.min(1, dt * 16);
        rt.dispPlayerX += (snap.playerX - rt.dispPlayerX) * k;
        rt.player.position.x = toX(rt.dispPlayerX);
        rt.player.position.y = Math.sin(t * 3.2) * 0.02;
        // 障害物は「前フレームの目標に最も近いエントリ」を引き継ぐ最近傍マッチで
        // 差分同期する（親は毎フレーム新しいオブジェクトを作るため参照では追えない）。
        const used = new Set<ObstacleEntry>();
        for (const o of snap.obstacles) {
          let best: ObstacleEntry | null = null;
          let bestDist = 90 * 90;
          for (const e of rt.entries) {
            if (used.has(e)) continue;
            const dx = e.targetX - o.x;
            const dy = e.targetY - o.y;
            const d = dx * dx + dy * dy;
            if (d < bestDist) { bestDist = d; best = e; }
          }
          if (!best) {
            const color = new THREE.Color().setHSL(((o.hue % 360) + 360) % 360 / 360, 0.75, 0.58);
            const group = new THREE.Group();
            const ball = createBall(1, color.getHex(), { roughness: 0.4 });
            group.add(ball);
            const shade = createBall(0.38, 0x14181f, { roughness: 0.6 });
            shade.position.set(-0.3, 0.3, 0.55);
            group.add(shade);
            group.scale.setScalar(o.r * S);
            rt.obstaclesGroup.add(group);
            best = { group, dispX: o.x, dispY: o.y, targetX: o.x, targetY: o.y, r: o.r };
            rt.entries.push(best);
          }
          best.targetX = o.x;
          best.targetY = o.y;
          best.r = o.r;
          used.add(best);
        }
        for (const e of [...rt.entries]) {
          if (!used.has(e)) {
            rt.obstaclesGroup.remove(e.group);
            rt.entries.splice(rt.entries.indexOf(e), 1);
          }
        }
        const ko = Math.min(1, dt * 30);
        for (const e of rt.entries) {
          e.dispX += (e.targetX - e.dispX) * ko;
          e.dispY += (e.targetY - e.dispY) * ko;
          e.group.position.set(toX(e.dispX), 0.36, toZ(e.dispY));
          e.group.scale.setScalar(Math.max(0.01, e.r * S));
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // トンネル: 床（スクロールするライン）+ 側壁 + 天井ライト帯
    const floorTex = canvasTexture("dodge-floor", 256, 256, (g) => {
      g.fillStyle = "#141f33";
      g.fillRect(0, 0, 256, 256);
      g.fillStyle = "rgba(120,180,255,0.20)";
      g.fillRect(0, 0, 5, 256);
      g.fillRect(251, 0, 5, 256);
      g.fillRect(125, 0, 4, 256);
      g.fillStyle = "rgba(255,255,255,0.10)";
      g.fillRect(0, 0, 256, 3);
    });
    floorTex.wrapS = THREE.RepeatWrapping;
    floorTex.wrapT = THREE.RepeatWrapping;
    floorTex.repeat.set(1, 7);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(4.6, 22),
      new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.85 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, -6);
    floor.userData.pickId = "floor";
    scene.add(floor);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x1a2740, roughness: 0.9 });
    for (const sx of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.6, 22), wallMat);
      wall.position.set(sx * 2.4, 1.3, -6);
      scene.add(wall);
      // 壁の発光ストリップ（奥行きの目安）
      for (let i = 0; i < 6; i++) {
        const strip = new THREE.Mesh(
          new THREE.BoxGeometry(0.06, 0.1, 0.9),
          new THREE.MeshStandardMaterial({ color: 0x0e1626, emissive: 0x4d9fff, emissiveIntensity: 0.9, roughness: 0.5 }),
        );
        strip.position.set(sx * 2.28, 1.9, 1.5 - i * 3.1);
        scene.add(strip);
      }
    }
    const ceil = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.14, 22), wallMat);
    ceil.position.set(0, 2.62, -6);
    scene.add(ceil);
    // 遠端の明かり
    const endGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(4.6, 2.6),
      new THREE.MeshBasicMaterial({ color: 0x274a75 }),
    );
    endGlow.position.set(0, 1.3, -16.8);
    scene.add(endGlow);

    const player = makePlayer();
    player.position.set(0, 0, PLAYER_Z);
    scene.add(player);
    const obstaclesGroup = new THREE.Group();
    scene.add(obstaclesGroup);

    rtRef.current = {
      player,
      dispPlayerX: propsRef.current.getSnapshot().playerX,
      obstaclesGroup,
      entries: [],
      floorTex,
    };

    const sendMove = (pt: THREE.Vector3) => {
      propsRef.current.onMove(toFieldX(pt.x));
    };
    detach = attachPickPointer(
      stage,
      () => [floor],
      {
        onTap: (hit) => { if (hit) sendMove(hit.point); },
        onDragStart: (hit) => sendMove(hit.point),
        onDragMove: (point) => sendMove(point),
        onHover: (hit) => { if (hit) sendMove(hit.point); },
      },
      { planeY: 0, hover: true },
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
      height={520}
      label="よけゲーのフィールド (3D)。ドラッグ / 移動で左右に動きます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#0d1526"
    />
  );
}
