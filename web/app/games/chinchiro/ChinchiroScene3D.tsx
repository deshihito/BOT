"use client";
// チンチロリンの 3D シーン。丼（親用・自分用）の中でサイコロが転がる。
// 出目は lib/chinchiro.ts が決め、ここは DiceSet で転がし演出だけを行う。
// 丼へのタップ/フリックはそのまま「振る」操作（既存ジェスチャと同一）。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { DiceSet } from "@/lib/three-kit/dice";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { CcDice } from "@/lib/chinchiro";
import type { ReactNode } from "react";

interface Props {
  playerDice: CcDice | null;
  cpuDice: CcDice | null;
  playerRolls: number;
  canRoll: boolean;
  onRoll: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const DIE = 0.52;
const PLAYER_BOWL = new THREE.Vector3(0, 0, 1.7);
const CPU_BOWL = new THREE.Vector3(0, 0, -1.9);

function bowlOffsets(center: THREE.Vector3, r: number): THREE.Vector3[] {
  return [
    new THREE.Vector3(center.x - r, DIE / 2 + 0.06, center.z - r * 0.4),
    new THREE.Vector3(center.x + r, DIE / 2 + 0.06, center.z - r * 0.3),
    new THREE.Vector3(center.x, DIE / 2 + 0.06, center.z + r * 0.75),
  ];
}

function createBowl(radius: number, color: number): THREE.Group {
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(0.02, 0),
    new THREE.Vector2(radius * 0.45, 0.02),
    new THREE.Vector2(radius * 0.78, 0.1),
    new THREE.Vector2(radius * 0.97, 0.3),
    new THREE.Vector2(radius, 0.52),
  ];
  const geo = new THREE.LatheGeometry(pts, 36);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.08, side: THREE.DoubleSide });
  const grp = new THREE.Group();
  grp.add(new THREE.Mesh(geo, mat));
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(radius, 0.045, 10, 40),
    new THREE.MeshStandardMaterial({ color: 0xd9c58a, roughness: 0.35, metalness: 0.4 }),
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.52;
  grp.add(rim);
  // 丼の底（内側の受け面）
  const bottom = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 0.8, 32),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.75), roughness: 0.6 }),
  );
  bottom.rotation.x = -Math.PI / 2;
  bottom.position.y = 0.07;
  grp.add(bottom);
  return grp;
}

export default function ChinchiroScene3D({ playerDice, cpuDice, playerRolls, canRoll, onRoll, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const setsRef = useRef<{ player: DiceSet; cpu: DiceSet } | null>(null);
  const prevRef = useRef<{ rolls: number; cpuKey: string; playerKey: string } | null>(null);

  const propsRef = useRef({ playerDice, cpuDice, playerRolls, canRoll, onRoll });
  propsRef.current = { playerDice, cpuDice, playerRolls, canRoll, onRoll };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x27313d,
      camera: { position: [0, 5.0, 6.6], lookAt: [0, 0, -0.1], fov: 44 },
      onFrame: (dt) => {
        setsRef.current?.player.update(dt);
        setsRef.current?.cpu.update(dt);
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // テーブル（フェルト）
    const table = new THREE.Mesh(
      new THREE.CircleGeometry(7.5, 40),
      new THREE.MeshStandardMaterial({ color: 0x2e5d43, roughness: 1 }),
    );
    table.rotation.x = -Math.PI / 2;
    table.position.y = -0.02;
    scene.add(table);

    const playerBowl = createBowl(1.2, 0x274b73);
    playerBowl.position.copy(PLAYER_BOWL).setY(0);
    scene.add(playerBowl);
    const cpuBowl = createBowl(1.05, 0x6e2f2a);
    cpuBowl.position.copy(CPU_BOWL).setY(0);
    scene.add(cpuBowl);

    const player = new DiceSet({ size: DIE, restPositions: bowlOffsets(PLAYER_BOWL, 0.42), scatter: 0.3 });
    scene.add(player.group);
    const cpu = new DiceSet({ size: DIE * 0.92, restPositions: bowlOffsets(CPU_BOWL, 0.38), scatter: 0.26 });
    scene.add(cpu.group);
    setsRef.current = { player, cpu };

    const p = propsRef.current;
    if (p.playerDice) player.setInstant([...p.playerDice]);
    if (p.cpuDice) cpu.setInstant([...p.cpuDice]);
    prevRef.current = {
      rolls: p.playerRolls,
      cpuKey: p.cpuDice ? p.cpuDice.join(",") : "",
      playerKey: p.playerDice ? p.playerDice.join(",") : "",
    };

    detach = attachPickPointer(stage, () => [playerBowl, cpuBowl, ...player.meshes(), ...cpu.meshes()], {
      onTap: () => { if (propsRef.current.canRoll) propsRef.current.onRoll(); },
      onFlick: () => { if (propsRef.current.canRoll) propsRef.current.onRoll(); },
    });
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      setsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 出目の変化で転がしアニメーションを起動する。
  useEffect(() => {
    const sets = setsRef.current;
    const prev = prevRef.current;
    if (!sets || !prev) return;
    const cpuKey = cpuDice ? cpuDice.join(",") : "";
    if (cpuDice && cpuKey !== prev.cpuKey) sets.cpu.roll([...cpuDice]);
    if (playerDice && playerRolls !== prev.rolls) sets.player.roll([...playerDice]);
    else if (playerDice && playerDice.join(",") !== prev.playerKey && prev.rolls === playerRolls) {
      // ロール回数が同じでも出目が変わった場合（初期化直後など）は即時合わせ。
      sets.player.setInstant([...playerDice]);
    }
    prevRef.current = {
      rolls: playerRolls,
      cpuKey,
      playerKey: playerDice ? playerDice.join(",") : "",
    };
  }, [playerDice, cpuDice, playerRolls]);

  return (
    <SceneBox
      height={330}
      label="チンチロリンの丼とサイコロ（3D）。丼をタップで振ります"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#27313d"
    />
  );
}
