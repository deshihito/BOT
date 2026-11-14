"use client";
// ヤッツィーの 3D シーン。トレイの上で 5 個のサイコロが転がる。
// キープはサイコロ自体のタップ、振るのはトレイのタップ/フリック
// （既存ジェスチャと同一）。出目と保持判定は lib/yahtzee.ts が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { DiceSet } from "@/lib/three-kit/dice";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

interface Props {
  dice: number[];
  held: boolean[];
  rollsUsed: number;
  canRoll: boolean;
  canHold: boolean;
  onToggleHold: (index: number) => void;
  onRoll: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const DIE = 0.8;
const XS = [-2.0, -1.0, 0, 1.0, 2.0];

export default function YahtzeeScene3D({ dice, held, rollsUsed, canRoll, canHold, onToggleHold, onRoll, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const setRef = useRef<DiceSet | null>(null);
  const ringsRef = useRef<THREE.Mesh[]>([]);
  const prevRollsRef = useRef<number | null>(null);

  const propsRef = useRef({ dice, held, canRoll, canHold, onToggleHold, onRoll });
  propsRef.current = { dice, held, canRoll, canHold, onToggleHold, onRoll };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x2b3442,
      camera: { position: [0, 4.6, 5.6], lookAt: [0, 0, 0.3], fov: 42 },
      onFrame: (dt) => setRef.current?.update(dt),
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // テーブルとトレイ
    const table = new THREE.Mesh(
      new THREE.CircleGeometry(8, 36),
      new THREE.MeshStandardMaterial({ color: 0x74563a, roughness: 1 }),
    );
    table.rotation.x = -Math.PI / 2;
    table.position.y = -0.06;
    scene.add(table);
    const tray = new THREE.Mesh(
      new THREE.BoxGeometry(5.9, 0.22, 2.6),
      new THREE.MeshStandardMaterial({ color: 0x38604a, roughness: 0.85 }),
    );
    tray.position.y = 0.05;
    tray.userData.pickId = "tray";
    scene.add(tray);
    const trayRim = new THREE.Mesh(
      new THREE.BoxGeometry(6.15, 0.1, 2.85),
      new THREE.MeshStandardMaterial({ color: 0x8a6f45, roughness: 0.6 }),
    );
    trayRim.position.y = -0.03;
    scene.add(trayRim);

    // カップ（飾りではなく「振る」対象の目印として右端に置く）
    const cup = new THREE.Group();
    const cupBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.62, 0.48, 1.05, 24, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x8e3b32, roughness: 0.5, side: THREE.DoubleSide }),
    );
    cup.add(cupBody);
    const cupBottom = new THREE.Mesh(
      new THREE.CircleGeometry(0.48, 24),
      new THREE.MeshStandardMaterial({ color: 0x74302a, roughness: 0.6 }),
    );
    cupBottom.rotation.x = Math.PI / 2;
    cupBottom.position.y = -0.52;
    cup.add(cupBottom);
    cup.position.set(3.6, 0.55, 0.6);
    cup.rotation.z = 0.5;
    cupBody.userData.pickId = "tray";
    scene.add(cup);

    const rest = XS.map((x) => new THREE.Vector3(x, DIE / 2 + 0.16, -0.35));
    const heldPos = XS.map((x) => new THREE.Vector3(x, DIE / 2 + 0.16, 0.85));
    const set = new DiceSet({ size: DIE, restPositions: rest, heldPositions: heldPos, scatter: 0.22 });
    set.meshes().forEach((m, i) => { m.userData.pickId = `die-${i}`; });
    scene.add(set.group);
    setRef.current = set;

    // 保持ダイスの下に敷く金のリング
    const rings: THREE.Mesh[] = [];
    for (let i = 0; i < 5; i++) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.55, 0.05, 8, 28),
        new THREE.MeshStandardMaterial({ color: 0xd9a41c, roughness: 0.35, metalness: 0.4 }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.set(XS[i], 0.19, 0.85);
      ring.visible = false;
      scene.add(ring);
      rings.push(ring);
    }
    ringsRef.current = rings;

    const p = propsRef.current;
    set.setInstant(p.dice);
    p.held.forEach((h, i) => set.setHeld(i, h));
    rings.forEach((r, i) => { r.visible = !!p.held[i]; });
    prevRollsRef.current = null;

    detach = attachPickPointer(stage, () => [...set.meshes(), tray, cupBody], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        const cur = propsRef.current;
        if (id && id.startsWith("die-")) {
          const i = Number(id.slice(4));
          if (cur.canHold) cur.onToggleHold(i);
          return;
        }
        if (id === "tray" && cur.canRoll) cur.onRoll();
      },
      onFlick: () => { if (propsRef.current.canRoll) propsRef.current.onRoll(); },
    });
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      setRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ロール回数の変化で転がす（保持ダイスは skip）。
  useEffect(() => {
    const set = setRef.current;
    if (!set) return;
    if (prevRollsRef.current === null) {
      prevRollsRef.current = rollsUsed;
      return;
    }
    if (rollsUsed !== prevRollsRef.current) {
      prevRollsRef.current = rollsUsed;
      if (rollsUsed > 0) set.roll(dice, { skip: held });
      else set.setInstant(dice);
    }
  }, [rollsUsed, dice, held]);

  // 保持状態の反映。
  useEffect(() => {
    const set = setRef.current;
    if (!set) return;
    held.forEach((h, i) => set.setHeld(i, h));
    ringsRef.current.forEach((r, i) => { r.visible = !!held[i]; });
  }, [held]);

  return (
    <SceneBox
      height={300}
      label="ヤッツィーのダイストレイ（3D）。ダイスをタップで保持、トレイをタップで振ります"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#2b3442"
    />
  );
}
