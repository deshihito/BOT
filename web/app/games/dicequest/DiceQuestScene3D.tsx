"use client";
// ダイスクエストの 3D シーン。白ダイス2個＋色ダイス4個を DiceSet で振る。
// 白ダイスは1セット、色ダイスは色ごとに1個セット（DiceSet は色が一律の
// ため）とし、色はダイス下の円盤と淡いボディ色で示す（目は DOM 併記）。
// 出目とフェーズは lib/dicequest.ts が決め、ここは転がし演出だけを行う。
// ダイス置き場へのタップ/フリックは既存ジェスチャと同一（振る/次へ）。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { DiceSet } from "@/lib/three-kit/dice";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import { createDisc } from "@/lib/three-kit/primitives";
import SceneBox from "@/lib/three-kit/SceneBox";
import { DQ_COLORS, type DqDice } from "@/lib/dicequest";

interface Props {
  dice: DqDice | null;
  rolls: number;
  canAct: boolean;
  onAction: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const DIE = 0.82;
// 白2個＋色4個（赤・黄・緑・青）の並び。
const XS = [-2.65, -1.6, -0.4, 0.65, 1.7, 2.75];
const COLOR_HEX: Record<string, number> = { red: 0xd64545, yellow: 0xd9a404, green: 0x2e8b57, blue: 0x3b6fd4 };
const COLOR_BODY: Record<string, string> = { red: "#f6d9d5", yellow: "#f7ecd0", green: "#d8eee0", blue: "#d9e6fa" };

export default function DiceQuestScene3D({ dice, rolls, canAct, onAction, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const setsRef = useRef<{ white: DiceSet; colored: DiceSet[] } | null>(null);
  const prevRollsRef = useRef<number | null>(null);

  const propsRef = useRef({ dice, rolls, canAct, onAction });
  propsRef.current = { dice, rolls, canAct, onAction };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x2b3442,
      camera: { position: [0, 4.2, 5.8], lookAt: [0, 0, 0.3], fov: 42 },
      onFrame: (dt) => {
        setsRef.current?.white.update(dt);
        setsRef.current?.colored.forEach((s) => s.update(dt));
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // トレイ
    const tray = new THREE.Mesh(
      new THREE.BoxGeometry(6.9, 0.2, 2.3),
      new THREE.MeshStandardMaterial({ color: 0x38604a, roughness: 0.85 }),
    );
    tray.position.set(0.05, 0.02, 0);
    tray.userData.pickId = "tray";
    scene.add(tray);
    const table = new THREE.Mesh(
      new THREE.CircleGeometry(8, 36),
      new THREE.MeshStandardMaterial({ color: 0x54432e, roughness: 1 }),
    );
    table.rotation.x = -Math.PI / 2;
    table.position.y = -0.1;
    scene.add(table);

    const restY = DIE / 2 + 0.12;
    const white = new DiceSet({
      size: DIE,
      restPositions: [new THREE.Vector3(XS[0], restY, 0), new THREE.Vector3(XS[1], restY, 0)],
      scatter: 0.2,
    });
    white.meshes().forEach((m) => { m.userData.pickId = "dice"; });
    scene.add(white.group);
    const colored: DiceSet[] = DQ_COLORS.map((color, i) => {
      const set = new DiceSet({
        size: DIE,
        body: COLOR_BODY[color],
        restPositions: [new THREE.Vector3(XS[2 + i], restY, 0)],
        scatter: 0.18,
      });
      set.meshes().forEach((m) => { m.userData.pickId = "dice"; });
      scene.add(set.group);
      // 色ダイスの下に色円盤を敷いて色を示す。
      const disc = createDisc(0.55, 0.07, COLOR_HEX[color]);
      disc.position.set(XS[2 + i], 0.15, 0);
      scene.add(disc);
      return set;
    });
    setsRef.current = { white, colored };

    const p = propsRef.current;
    if (p.dice) {
      white.setInstant([...p.dice.white]);
      DQ_COLORS.forEach((color, i) => colored[i].setInstant([p.dice!.colored[color]]));
    }
    prevRollsRef.current = p.rolls;

    detach = attachPickPointer(stage, () => [tray, ...white.meshes(), ...colored.flatMap((s) => s.meshes())], {
      onTap: () => { if (propsRef.current.canAct) propsRef.current.onAction(); },
      onFlick: () => { if (propsRef.current.canAct) propsRef.current.onAction(); },
    });
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      setsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 投目が進んだら全ダイスを転がして結果へ収束させる。
  useEffect(() => {
    const sets = setsRef.current;
    if (!sets || !dice) return;
    if (prevRollsRef.current === null) {
      prevRollsRef.current = rolls;
      return;
    }
    if (rolls !== prevRollsRef.current) {
      prevRollsRef.current = rolls;
      sets.white.roll([...dice.white]);
      DQ_COLORS.forEach((color, i) => sets.colored[i].roll([dice.colored[color]]));
    }
  }, [dice, rolls]);

  return (
    <SceneBox
      height={250}
      label="ダイスクエストのダイス置き場（3D）。タップで振ります"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#2b3442"
    />
  );
}
