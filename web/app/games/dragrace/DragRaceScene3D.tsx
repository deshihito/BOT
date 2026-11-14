"use client";
// ドラッグレースの 3D シーン。直線コース + 車2台（プリミティブ造形）。
// 勝敗・進行度は lib/dragrace.ts とクライアントが決め、ここは親の進行度
// （playerProg / cpuProg）へ補間追従するだけ。3D 側で判定はしない。
// 入力: コース/車へのタップ・フリック = 既存の onAction（発進/シフトと同一）。
// ライト（赤/緑）と RPM バー（自車上）も親状態に追従して表示する。
// 数字（タイム・反応・ギア）は親の DOM 併記が正。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { DragPhase } from "@/lib/dragrace";

interface Props {
  /** プレイヤー車の進行度 0〜1（lib の playerProgress）。 */
  playerProg: number;
  /** CPU 車の進行度 0〜1（lib の cpuProgress）。 */
  cpuProg: number;
  phase: DragPhase;
  green: boolean;
  /** RPM メーター位置 0〜1（lib の rpmFraction）。 */
  rpm: number;
  inZone: boolean;
  onAction: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

/** コース全長（進行度 1 で到達する z 距離）。 */
const TRACK_LEN = 90;
const PLAYER_X = -0.95;
const CPU_X = 0.95;
const WHEEL_R = 0.16;

function makeCar(color: number): { group: THREE.Group; wheels: THREE.Mesh[] } {
  const grp = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.25 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1c2330, roughness: 0.5 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.2, 1.7), bodyMat);
  body.position.y = 0.3;
  grp.add(body);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.13, 0.5), bodyMat);
  nose.position.set(0, 0.24, -0.95);
  grp.add(nose);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.2, 0.66), darkMat);
  cabin.position.set(0, 0.49, 0.12);
  grp.add(cabin);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.05, 0.2), darkMat);
  wing.position.set(0, 0.52, 0.82);
  grp.add(wing);
  for (const sx of [-0.3, 0.3]) {
    const stay = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.06), darkMat);
    stay.position.set(sx, 0.42, 0.82);
    grp.add(stay);
  }
  const wheelGeo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.1, 18);
  wheelGeo.rotateZ(Math.PI / 2);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.7 });
  const wheels: THREE.Mesh[] = [];
  for (const [wx, wz] of [[-0.42, -0.58], [0.42, -0.58], [-0.42, 0.58], [0.42, 0.58]] as const) {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.position.set(wx, WHEEL_R, wz);
    grp.add(w);
    wheels.push(w);
  }
  return { group: grp, wheels };
}

interface SceneRt {
  playerCar: THREE.Group;
  cpuCar: THREE.Group;
  playerWheels: THREE.Mesh[];
  cpuWheels: THREE.Mesh[];
  lampRedMat: THREE.MeshStandardMaterial;
  lampGreenMat: THREE.MeshStandardMaterial;
  rpmFill: THREE.Mesh;
  rpmFillMat: THREE.MeshStandardMaterial;
  dispPlayer: number;
  dispCpu: number;
  camZ: number;
  cam: THREE.PerspectiveCamera;
}

export default function DragRaceScene3D({ playerProg, cpuProg, phase, green, rpm, inZone, onAction, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ playerProg, cpuProg, phase, green, rpm, inZone, onAction });
  propsRef.current = { playerProg, cpuProg, phase, green, rpm, inZone, onAction };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x87a8c8,
      camera: { position: [0, 3.1, 6.5], lookAt: [0, 0.3, -7], fov: 46 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        const p = propsRef.current;
        // 進行度への補間追従。リスタート等で目標が大きく戻ったら即座に合わせる。
        const follow = (disp: number, target: number) => {
          if (target < disp - 0.02) return target;
          return disp + (target - disp) * Math.min(1, dt * 9);
        };
        const prevP = rt.dispPlayer;
        const prevC = rt.dispCpu;
        rt.dispPlayer = follow(rt.dispPlayer, p.playerProg);
        rt.dispCpu = follow(rt.dispCpu, p.cpuProg);
        const pz = -rt.dispPlayer * TRACK_LEN;
        const cz = -rt.dispCpu * TRACK_LEN;
        rt.playerCar.position.z = pz;
        rt.cpuCar.position.z = cz;
        const spinP = ((rt.dispPlayer - prevP) * TRACK_LEN) / WHEEL_R;
        const spinC = ((rt.dispCpu - prevC) * TRACK_LEN) / WHEEL_R;
        for (const w of rt.playerWheels) w.rotation.x += spinP;
        for (const w of rt.cpuWheels) w.rotation.x += spinC;
        // スタートライト（親状態への追従のみ）
        const redOn = p.phase === "waiting" && !p.green;
        const greenOn = p.green || p.phase === "running" || p.phase === "finished";
        rt.lampRedMat.emissiveIntensity = redOn ? 1.8 : 0.08;
        rt.lampGreenMat.emissiveIntensity = greenOn ? 1.8 : 0.08;
        // RPM バー（自車上）。ゾーン内は緑、それ以外は琥珀。
        const r = Math.max(0.001, Math.min(1, p.rpm));
        rt.rpmFill.scale.x = r;
        rt.rpmFillMat.color.setHex(p.inZone ? 0x2ecc71 : 0xe0a32f);
        rt.rpmFillMat.emissive.setHex(p.inZone ? 0x2ecc71 : 0x000000);
        rt.rpmFillMat.emissiveIntensity = p.inZone ? 0.7 : 0;
        // カメラは自車の後方へ補間追従し、リーダーの少し先を見る。
        const targetCamZ = pz + 6.5;
        rt.camZ += (targetCamZ - rt.camZ) * Math.min(1, dt * 6);
        rt.cam.position.set(0, 3.1, rt.camZ);
        rt.cam.lookAt(0, 0.3, Math.min(pz, cz) - 7);
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    const trackGroup = new THREE.Group();
    scene.add(trackGroup);

    // 路面（アスファルト + レーンライン + スタート/フィニッシュ帯）
    const roadTex = canvasTexture("dragrace-road", 256, 1024, (g) => {
      g.fillStyle = "#33373d";
      g.fillRect(0, 0, 256, 1024);
      g.fillStyle = "rgba(255,255,255,0.06)";
      for (let i = 0; i < 260; i++) g.fillRect(Math.random() * 256, Math.random() * 1024, 2, 2);
      g.fillStyle = "#e8e8e8";
      g.fillRect(6, 0, 5, 1024);
      g.fillRect(245, 0, 5, 1024);
      for (let y = 0; y < 1024; y += 64) g.fillRect(125, y, 6, 34);
    });
    roadTex.wrapT = THREE.RepeatWrapping;
    roadTex.repeat.set(1, 6);
    const road = new THREE.Mesh(
      new THREE.BoxGeometry(4.2, 0.08, TRACK_LEN + 26),
      new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.9 }),
    );
    road.position.set(0, -0.04, -TRACK_LEN / 2 + 6);
    road.userData.pickId = "track";
    trackGroup.add(road);
    // 地面（コース外）
    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(60, 0.06, TRACK_LEN + 40),
      new THREE.MeshStandardMaterial({ color: 0x5d7d4a, roughness: 1 }),
    );
    ground.position.set(0, -0.1, -TRACK_LEN / 2 + 4);
    trackGroup.add(ground);
    // スタートライン / フィニッシュライン
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.6 });
    const startLine = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.02, 0.35), lineMat);
    startLine.position.set(0, 0.01, 0);
    trackGroup.add(startLine);
    const finishTex = canvasTexture("dragrace-finish", 128, 32, (g) => {
      for (let y = 0; y < 4; y++) for (let x = 0; x < 16; x++) {
        g.fillStyle = (x + y) % 2 === 0 ? "#111" : "#f5f5f5";
        g.fillRect(x * 8, y * 8, 8, 8);
      }
    });
    const finishLine = new THREE.Mesh(
      new THREE.BoxGeometry(4.2, 0.02, 0.7),
      new THREE.MeshStandardMaterial({ map: finishTex, roughness: 0.6 }),
    );
    finishLine.position.set(0, 0.01, -TRACK_LEN);
    trackGroup.add(finishLine);
    // ガードレール + 背景の観客席ブロック
    const railMat = new THREE.MeshStandardMaterial({ color: 0xb9c0c7, roughness: 0.4, metalness: 0.4 });
    for (const sx of [-2.45, 2.45]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.4, TRACK_LEN + 20), railMat);
      rail.position.set(sx, 0.2, -TRACK_LEN / 2 + 4);
      trackGroup.add(rail);
    }
    const standColors = [0x8fa3b8, 0xa8907c, 0x7c94a8, 0x9aa87c];
    for (let i = 0; i < 8; i++) {
      const z = -6 - i * 12;
      for (const sx of [-1, 1]) {
        const stand = new THREE.Mesh(
          new THREE.BoxGeometry(3.4, 1.6 + (i % 3) * 0.5, 5),
          new THREE.MeshStandardMaterial({ color: standColors[i % standColors.length], roughness: 0.8 }),
        );
        stand.position.set(sx * 6.4, 0.7, z);
        trackGroup.add(stand);
      }
    }
    // スタートライトのポール（赤/緑ランプは親状態で発光させる）
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.6 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 10), poleMat);
    pole.position.set(-2.9, 1.2, 1.2);
    trackGroup.add(pole);
    const lampBox = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.78, 0.18), poleMat);
    lampBox.position.set(-2.9, 2.2, 1.2);
    trackGroup.add(lampBox);
    const lampRedMat = new THREE.MeshStandardMaterial({ color: 0x551512, emissive: 0xe33333, emissiveIntensity: 0.08, roughness: 0.4 });
    const lampGreenMat = new THREE.MeshStandardMaterial({ color: 0x123d20, emissive: 0x2ecc71, emissiveIntensity: 0.08, roughness: 0.4 });
    const lampRed = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), lampRedMat);
    lampRed.position.set(-2.9, 2.4, 1.28);
    trackGroup.add(lampRed);
    const lampGreen = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), lampGreenMat);
    lampGreen.position.set(-2.9, 2.02, 1.28);
    trackGroup.add(lampGreen);

    const player = makeCar(0x2f7fe0);
    player.group.position.set(PLAYER_X, 0, 0);
    player.group.traverse((o) => { o.userData.pickId = "track"; });
    trackGroup.add(player.group);
    const cpu = makeCar(0xe05a2f);
    cpu.group.position.set(CPU_X, 0, 0);
    cpu.group.traverse((o) => { o.userData.pickId = "track"; });
    trackGroup.add(cpu.group);

    // RPM バー（自車の上。背景 + ゾーン帯 + 充填）
    const rpmGroup = new THREE.Group();
    rpmGroup.position.set(0, 1.06, 0);
    const rpmBg = new THREE.Mesh(
      new THREE.BoxGeometry(0.92, 0.1, 0.03),
      new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.6 }),
    );
    rpmGroup.add(rpmBg);
    const zone = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.1, 0.032),
      new THREE.MeshStandardMaterial({ color: 0x2ecc71, roughness: 0.6 }),
    );
    zone.position.x = 0.39;
    rpmGroup.add(zone);
    const fillGeo = new THREE.BoxGeometry(0.9, 0.07, 0.036);
    fillGeo.translate(0.45, 0, 0);
    const rpmFillMat = new THREE.MeshStandardMaterial({ color: 0xe0a32f, roughness: 0.5 });
    const rpmFill = new THREE.Mesh(fillGeo, rpmFillMat);
    rpmFill.position.x = -0.45;
    rpmFill.scale.x = 0.001;
    rpmGroup.add(rpmFill);
    player.group.add(rpmGroup);

    rtRef.current = {
      playerCar: player.group,
      cpuCar: cpu.group,
      playerWheels: player.wheels,
      cpuWheels: cpu.wheels,
      lampRedMat,
      lampGreenMat,
      rpmFill,
      rpmFillMat,
      dispPlayer: propsRef.current.playerProg,
      dispCpu: propsRef.current.cpuProg,
      camZ: 6.5,
      cam: stage.camera,
    };

    detach = attachPickPointer(
      stage,
      () => [trackGroup],
      {
        // タイミングタップ / フリック = 既存の大きなボタンと同一ハンドラ。
        onTap: () => propsRef.current.onAction(),
        onFlick: () => propsRef.current.onAction(),
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

  return (
    <SceneBox
      height={440}
      label="ドラッグレースのコース (3D)。タップで発進 / シフトします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#87a8c8"
    />
  );
}
