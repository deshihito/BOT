"use client";
// すごろくの 3D シーン。タイル列の立体盤面＋ゴール、DiceSet のサイコロ、
// プリミティブの駒。振った後は駒が出目のぶんマスを跳ねながら進む。
// 位置・出目・効果はすべて lib/sugoroku.ts が決め、ここは表現だけを行う。
// 盤面/サイコロへのタップ・フリックは既存の盤面タップ（振る）と同一。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 盤面に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { DiceSet } from "@/lib/three-kit/dice";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import { canvasTexture, createStone } from "@/lib/three-kit/primitives";
import SceneBox from "@/lib/three-kit/SceneBox";
import { SUGOROKU_GOAL, describeEffect, squareEffect } from "@/lib/sugoroku";

interface Props {
  positions: number[];
  lastRoll: number | null;
  turns: number;
  canRoll: boolean;
  onRoll: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const COLS = 6;
const CELL = 1.04;
const BOARD_X = -0.55; // 右にサイコロ置き場の余地を作る
const PLAYER_HEX = [0x2563eb, 0xdc2626, 0x059669];
const PAWN_OFFSETS: Array<[number, number]> = [[-0.27, -0.27], [0.27, -0.27], [0, 0.3]];
const DIE_POS = new THREE.Vector3(3.85, 0.55, 2.35);

function tileWorld(index: number): THREE.Vector3 {
  const r = Math.floor(index / COLS);
  const c = index % COLS;
  return new THREE.Vector3(BOARD_X + (c - (COLS - 1) / 2) * CELL, 0, (r - 2) * CELL);
}

function tileTexture(index: number): THREE.CanvasTexture {
  return canvasTexture(`sugoroku-tile-${index}`, 128, 128, (g) => {
    const e = squareEffect(index);
    let bg = "#fffdf6";
    if (index === 0) bg = "#dbeafe";
    else if (index === SUGOROKU_GOAL) bg = "#ffe9a8";
    else if (e.type === "forward") bg = "#dcfce7";
    else if (e.type === "back") bg = "#fee2e2";
    else if (e.type === "skip") bg = "#fef3c7";
    else if (e.type === "coins") bg = "#e0f2fe";
    g.fillStyle = bg;
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#333333";
    g.font = "bold 44px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(index), 64, index === 0 || index === SUGOROKU_GOAL ? 52 : 42);
    g.font = "bold 21px sans-serif";
    g.fillStyle = "#555555";
    const label = index === 0 ? "スタート" : index === SUGOROKU_GOAL ? "ゴール" : describeEffect(e);
    if (label) g.fillText(label, 64, 96);
  });
}

interface PawnAnim {
  mesh: THREE.Mesh;
  queue: number[]; // 次に跳ぶマス番号の列
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  duration: number;
  delay: number;
  active: boolean;
}

export default function SugorokuScene3D({ positions, lastRoll, turns, canRoll, onRoll, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const diceRef = useRef<DiceSet | null>(null);
  const pawnsRef = useRef<PawnAnim[]>([]);
  const prevRef = useRef<{ positions: number[]; turns: number } | null>(null);

  const propsRef = useRef({ positions, lastRoll, turns, canRoll, onRoll });
  propsRef.current = { positions, lastRoll, turns, canRoll, onRoll };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x27313d,
      camera: { position: [0, 8.6, 7.6], lookAt: [0.2, 0, 0.4], fov: 46 },
      onFrame: (dt) => {
        diceRef.current?.update(dt);
        for (const pawn of pawnsRef.current) {
          if (pawn.delay > 0) {
            pawn.delay -= dt;
            continue;
          }
          if (!pawn.active && pawn.queue.length > 0) {
            const next = pawn.queue.shift()!;
            pawn.from.copy(pawn.mesh.position);
            const target = tileWorld(next);
            const pi = pawnsRef.current.indexOf(pawn);
            const [ox, oz] = PAWN_OFFSETS[pi] ?? [0, 0];
            pawn.to.set(target.x + ox, 0.3, target.z + oz);
            pawn.t = 0;
            pawn.active = true;
          }
          if (pawn.active) {
            pawn.t += dt;
            const k = Math.min(1, pawn.t / pawn.duration);
            pawn.mesh.position.lerpVectors(pawn.from, pawn.to, k);
            pawn.mesh.position.y = 0.3 + Math.sin(k * Math.PI) * 0.34;
            if (k >= 1) {
              pawn.active = false;
              pawn.mesh.position.copy(pawn.to).setY(0.3);
            }
          }
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // 盤の土台
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(COLS * CELL + 0.4, 0.12, 5 * CELL + 0.4),
      new THREE.MeshStandardMaterial({ color: 0x4a3f30, roughness: 0.9 }),
    );
    base.position.set(BOARD_X, -0.07, 0);
    scene.add(base);

    const tiles: THREE.Object3D[] = [];
    for (let i = 0; i <= SUGOROKU_GOAL; i++) {
      const side = new THREE.MeshStandardMaterial({ color: 0xd8cdb2, roughness: 0.7 });
      const top = new THREE.MeshStandardMaterial({ map: tileTexture(i), roughness: 0.65 });
      const tile = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.16, 0.96), [side, side, top, side, side, side]);
      const w = tileWorld(i);
      tile.position.set(w.x, 0, w.z);
      tile.userData.pickId = "board";
      scene.add(tile);
      tiles.push(tile);
    }

    // サイコロ置き場（台＋DiceSet 1個）
    const pedestal = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 0.18, 1.5),
      new THREE.MeshStandardMaterial({ color: 0x38604a, roughness: 0.85 }),
    );
    pedestal.position.set(DIE_POS.x, 0.02, DIE_POS.z);
    pedestal.userData.pickId = "board";
    scene.add(pedestal);
    const dice = new DiceSet({ size: 0.85, restPositions: [new THREE.Vector3(DIE_POS.x, 0.55, DIE_POS.z)], scatter: 0.16 });
    dice.meshes().forEach((m) => { m.userData.pickId = "board"; });
    scene.add(dice.group);
    diceRef.current = dice;

    // 駒（色石）
    const pawns: PawnAnim[] = propsRef.current.positions.map((posIdx, pi) => {
      const stone = createStone(0.26, PLAYER_HEX[pi] ?? 0x888888);
      const w = tileWorld(posIdx);
      const [ox, oz] = PAWN_OFFSETS[pi] ?? [0, 0];
      stone.position.set(w.x + ox, 0.3, w.z + oz);
      scene.add(stone);
      return {
        mesh: stone,
        queue: [],
        from: stone.position.clone(),
        to: stone.position.clone(),
        t: 0,
        duration: 0.24,
        delay: 0,
        active: false,
      };
    });
    pawnsRef.current = pawns;
    if (propsRef.current.lastRoll) dice.setInstant([propsRef.current.lastRoll]);
    prevRef.current = { positions: [...propsRef.current.positions], turns: propsRef.current.turns };

    detach = attachPickPointer(stage, () => [...tiles, pedestal, ...dice.meshes()], {
      onTap: () => { if (propsRef.current.canRoll) propsRef.current.onRoll(); },
      onFlick: () => { if (propsRef.current.canRoll) propsRef.current.onRoll(); },
    });
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      diceRef.current = null;
      pawnsRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 出目でサイコロを転がし、位置変化ぶん駒の跳躍キューを積む。
  useEffect(() => {
    const prev = prevRef.current;
    if (!prev) return;
    const rolled = turns !== prev.turns && lastRoll !== null;
    if (rolled) diceRef.current?.roll([lastRoll]);
    positions.forEach((now, pi) => {
      const pawn = pawnsRef.current[pi];
      const before = prev.positions[pi];
      if (!pawn || now === before) return;
      if (turns < prev.turns) {
        // リスタート相当は即時合わせ。
        pawn.queue = [];
        pawn.active = false;
        const w = tileWorld(now);
        const [ox, oz] = PAWN_OFFSETS[pi] ?? [0, 0];
        pawn.mesh.position.set(w.x + ox, 0.3, w.z + oz);
        return;
      }
      const steps: number[] = [];
      const dir = now > before ? 1 : -1;
      for (let s = before + dir; dir > 0 ? s <= now : s >= now; s += dir) steps.push(s);
      pawn.queue = steps;
      // サイコロの転がりを先に見せてから駒を進める。
      pawn.delay = rolled ? 0.55 : 0.05;
    });
    prevRef.current = { positions: [...positions], turns };
  }, [positions, lastRoll, turns]);

  return (
    <SceneBox
      height={400}
      label="すごろくのコース（3D）。盤面をタップでサイコロを振ります"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#27313d"
    />
  );
}
