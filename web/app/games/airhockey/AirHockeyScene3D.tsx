"use client";
// エアホッケーの 3D シーン。テーブル + パック + 両マレット。
// 物理は lib/airhockey.ts の固定ステップが決め、ここは親の stateRef を
// 毎フレーム読み、補間追従するだけ。3D 側で衝突・ゴール判定はしない。
// ゴール時は直近の得点変化 (state のスコア差分) を見てゴール口を発光させる
// 演出だけを行う (判定は既存ロジック済み)。
// 入力: planePoint / レイキャスト点 -> プレイヤーマレットの目標座標。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createDisc, canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import {
  AIR_FIELD_H,
  AIR_FIELD_W,
  AIR_GOAL_W,
  AIR_PADDLE_R,
  AIR_PUCK_R,
  type AirHockeyState,
} from "@/lib/airhockey";

interface Props {
  /** 親のゲームループが進める最新の状態を読む (React 再描画を介さない)。 */
  getState: () => AirHockeyState;
  onTarget: (x: number, y: number) => void;
  onPress: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const S = 100;
const toX = (gx: number) => (gx - AIR_FIELD_W / 2) / S;
const toZ = (gy: number) => (gy - AIR_FIELD_H / 2) / S;
const toGx = (x: number) => x * S + AIR_FIELD_W / 2;
const toGy = (z: number) => z * S + AIR_FIELD_H / 2;
const TABLE_Y = 0;

function makeMallet(color: number): THREE.Group {
  const grp = new THREE.Group();
  const base = createDisc(AIR_PADDLE_R / S, 0.09, color);
  base.position.y = 0.05;
  grp.add(base);
  const knob = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.11, 0.16, 16),
    new THREE.MeshStandardMaterial({ color, roughness: 0.35 }),
  );
  knob.position.y = 0.17;
  grp.add(knob);
  const top = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 14, 10),
    new THREE.MeshStandardMaterial({ color, roughness: 0.3 }),
  );
  top.position.y = 0.26;
  grp.add(top);
  return grp;
}

export default function AirHockeyScene3D({ getState, onTarget, onPress, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<{
    puck: THREE.Group;
    player: THREE.Group;
    cpu: THREE.Group;
    goalTopMat: THREE.MeshStandardMaterial;
    goalBottomMat: THREE.MeshStandardMaterial;
    prevScores: { player: number; cpu: number };
    flashTop: number;
    flashBottom: number;
  } | null>(null);

  const propsRef = useRef({ getState, onTarget, onPress });
  propsRef.current = { getState, onTarget, onPress };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x0b2036,
      camera: { position: [0, 7.6, 5.4], lookAt: [0, 0, 0.4], fov: 42 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        const s = propsRef.current.getState();
        // スコア差分は既存ロジックの結果。演出 (ゴール口の発光) だけに使う。
        if (s.playerScore > rt.prevScores.player) rt.flashTop = 1;
        if (s.cpuScore > rt.prevScores.cpu) rt.flashBottom = 1;
        rt.prevScores = { player: s.playerScore, cpu: s.cpuScore };
        rt.flashTop = Math.max(0, rt.flashTop - dt * 1.6);
        rt.flashBottom = Math.max(0, rt.flashBottom - dt * 1.6);
        rt.goalTopMat.emissive.setRGB(rt.flashTop * 0.9, rt.flashTop * 0.2, rt.flashTop * 0.15);
        rt.goalBottomMat.emissive.setRGB(rt.flashBottom * 0.15, rt.flashBottom * 0.9, rt.flashBottom * 0.3);
        // 補間追従: dt クランプ済み (0.05) の指数補間で 60Hz 状態へ滑らかに寄せる。
        // 重い処理はしない (位置コピーと行列更新のみ)。
        const k = Math.min(1, dt * 48);
        const follow = (obj: THREE.Group, gx: number, gy: number) => {
          obj.position.x += (toX(gx) - obj.position.x) * k;
          obj.position.z += (toZ(gy) - obj.position.z) * k;
        };
        follow(rt.puck, s.puck.x, s.puck.y);
        follow(rt.player, s.player.x, s.player.y);
        follow(rt.cpu, s.cpu.x, s.cpu.y);
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
      new THREE.BoxGeometry(AIR_FIELD_W / S + 0.36, 0.24, AIR_FIELD_H / S + 0.36),
      new THREE.MeshStandardMaterial({ color: 0x123a5c, roughness: 0.6 }),
    );
    base.position.y = -0.15;
    scene.add(base);
    const surfaceTex = canvasTexture("airhockey-surface", 200, 320, (g) => {
      g.fillStyle = "#eef6fb";
      g.fillRect(0, 0, 200, 320);
      g.strokeStyle = "rgba(56,120,180,0.55)";
      g.lineWidth = 3;
      g.beginPath(); g.moveTo(0, 160); g.lineTo(200, 160); g.stroke();
      g.beginPath(); g.arc(100, 160, 28, 0, Math.PI * 2); g.stroke();
    });
    const surface = new THREE.Mesh(
      new THREE.BoxGeometry(AIR_FIELD_W / S, 0.05, AIR_FIELD_H / S),
      new THREE.MeshStandardMaterial({ map: surfaceTex, roughness: 0.35 }),
    );
    surface.position.y = -0.025;
    surface.userData.pickId = "table";
    scene.add(surface);
    // 壁 (左右 + 上下のゴール外)
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x9fc6e8, roughness: 0.4, metalness: 0.15 });
    const mkWall = (w: number, d: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.16, d), wallMat);
      m.position.set(x, 0.06, z);
      m.userData.pickId = "table";
      scene.add(m);
    };
    mkWall(0.1, AIR_FIELD_H / S, -AIR_FIELD_W / S / 2 - 0.05, 0);
    mkWall(0.1, AIR_FIELD_H / S, AIR_FIELD_W / S / 2 + 0.05, 0);
    const sideW = (AIR_FIELD_W - AIR_GOAL_W) / S / 2;
    const sideOffset = AIR_GOAL_W / S / 2 + sideW / 2;
    mkWall(sideW, 0.1, -sideOffset, -AIR_FIELD_H / S / 2 - 0.05);
    mkWall(sideW, 0.1, sideOffset, -AIR_FIELD_H / S / 2 - 0.05);
    mkWall(sideW, 0.1, -sideOffset, AIR_FIELD_H / S / 2 + 0.05);
    mkWall(sideW, 0.1, sideOffset, AIR_FIELD_H / S / 2 + 0.05);
    // ゴール口 (発光マテリアルはスコア変化時の演出用)
    const goalTopMat = new THREE.MeshStandardMaterial({ color: 0xf87171, roughness: 0.4, emissive: 0x000000 });
    const goalBottomMat = new THREE.MeshStandardMaterial({ color: 0x4ade80, roughness: 0.4, emissive: 0x000000 });
    const goalTop = new THREE.Mesh(new THREE.BoxGeometry(AIR_GOAL_W / S, 0.1, 0.12), goalTopMat);
    goalTop.position.set(0, 0.03, -AIR_FIELD_H / S / 2 - 0.05);
    scene.add(goalTop);
    const goalBottom = new THREE.Mesh(new THREE.BoxGeometry(AIR_GOAL_W / S, 0.1, 0.12), goalBottomMat);
    goalBottom.position.set(0, 0.03, AIR_FIELD_H / S / 2 + 0.05);
    scene.add(goalBottom);

    const puck = createDisc(AIR_PUCK_R / S, 0.07, 0xffd34d);
    puck.position.y = 0.04;
    scene.add(puck);
    const player = makeMallet(0x38bdf8);
    scene.add(player);
    const cpu = makeMallet(0xe85d4a);
    scene.add(cpu);
    const s0 = propsRef.current.getState();
    puck.position.set(toX(s0.puck.x), 0.04, toZ(s0.puck.y));
    player.position.set(toX(s0.player.x), TABLE_Y, toZ(s0.player.y));
    cpu.position.set(toX(s0.cpu.x), TABLE_Y, toZ(s0.cpu.y));

    rtRef.current = {
      puck, player, cpu, goalTopMat, goalBottomMat,
      prevScores: { player: s0.playerScore, cpu: s0.cpuScore },
      flashTop: 0, flashBottom: 0,
    };

    const sendTarget = (pt: THREE.Vector3) => {
      propsRef.current.onTarget(toGx(pt.x), toGy(pt.z));
    };
    detach = attachPickPointer(
      stage,
      () => [surface, base],
      {
        onTap: (hit) => {
          propsRef.current.onPress();
          if (hit) sendTarget(hit.point);
        },
        onDragStart: () => propsRef.current.onPress(),
        onDragMove: (point) => sendTarget(point),
        onHover: (hit) => { if (hit) sendTarget(hit.point); },
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
      height={520}
      label="エアホッケーのフィールド (3D)。マレットをドラッグ / 移動で動かします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#0b2036"
    />
  );
}
