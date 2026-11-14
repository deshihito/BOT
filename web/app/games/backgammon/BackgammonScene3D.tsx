"use client";
// バックギャモンの 3D 盤。ポイントの三角は薄いプリミティブで描き、
// チェッカーは createDisc を積み重ねる。ダイスは DiceSet で盤上に表示し、
// 振った目に転がりアニメーションを付ける。バー上の駒・上がった駒
// （ボードオフ）も盤の中央バーと右側トレイに表現する。
// 入力は既存操作（駒/移動先のタップ）をレイキャストでクライアントの
// onPoint へ渡す。上がりはトレイのタップでも行える（盤面スワイプと併存）。
// 着手可否は lib/backgammon.ts とクライアント状態が決め、ここは表現と
// 入力の橋渡しだけを行う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 盤に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createDisc } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import { DiceSet } from "@/lib/three-kit/dice";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { BgFrom } from "@/lib/backgammon";

interface Props {
  points: number[];
  bar: [number, number];
  off: [number, number];
  selected: BgFrom | null;
  /** 選択中コマの移動先ポイント（数値のみ）。 */
  targets: number[];
  canBearOff: boolean;
  lastRoll: [number, number] | null;
  /** ロールを一意に識別する値（state.rng）。変化したらダイスを転がす。 */
  rollKey: number | null;
  onPoint: (index: number) => void;
  onBearOff: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PW = 0.64; // ポイント幅
const BAR_W = 0.72; // 中央バーの幅
const DEPTH = 6.4; // 盤の奥行き
const PL = 2.95; // ポイントの長さ
const R = 0.29; // チェッカー半径
const CH = 0.13; // チェッカー厚
const W = 12 * PW + BAR_W;
const TRAY_X = W / 2 + 0.55;
const PLAYER_COLORS = [0xf8fafc, 0x1f2937] as const;

function colX(col: number): number {
  return -W / 2 + PW / 2 + col * PW + (col >= 6 ? BAR_W : 0);
}
/** ポイント index → 列と上下。2D 盤と同じ並び（上段 12..23 / 下段 11..0）。 */
function pointLayout(index: number): { x: number; top: boolean } {
  if (index >= 12) return { x: colX(index - 12), top: true };
  return { x: colX(11 - index), top: false };
}
function slotPos(index: number, slot: number): [number, number, number] {
  const { x, top } = pointLayout(index);
  const inRow = slot % 5;
  const level = Math.floor(slot / 5);
  const z = top ? -DEPTH / 2 + R + 0.08 + inRow * R * 2 : DEPTH / 2 - R - 0.08 - inRow * R * 2;
  return [x, CH / 2 + 0.03 + level * CH, z];
}
function barPos(player: number, slot: number): [number, number, number] {
  // 自分（0）は手前側、CPU（1）は奥側のバーに置く。
  const z = player === 0 ? 0.85 + slot * (R * 2 + 0.04) : -0.85 - slot * (R * 2 + 0.04);
  return [0, CH / 2 + 0.09, z];
}
function offPos(player: number, slot: number): [number, number, number] {
  return [TRAY_X, CH / 2 + 0.08 + slot * CH, player === 0 ? 1.55 : -1.55];
}

interface CheckerRt {
  grp: THREE.Group;
  key: string | null;
  anim: { from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number } | null;
}

interface Place {
  key: string;
  player: number;
  pos: [number, number, number];
}

export default function BackgammonScene3D({ points, bar, off, selected, targets, canBearOff, lastRoll, rollKey, onPoint, onBearOff, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<{
    checkers: CheckerRt[][];
    pointGlows: THREE.Mesh[];
    barGlow: THREE.Mesh;
    offGlow: THREE.Mesh;
    diceSet: DiceSet;
    scene: THREE.Scene;
    initialized: boolean;
  } | null>(null);
  const propsRef = useRef({ bar, onPoint, onBearOff });
  propsRef.current = { bar, onPoint, onBearOff };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;
  const prevRollRef = useRef<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x6b4423,
      camera: { position: [0, 9.4, 6.8], lookAt: [0, 0, 0.2], fov: 42 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        rt.diceSet.update(dt);
        for (const pool of rt.checkers) {
          for (const c of pool) {
            if (!c.anim) continue;
            c.anim.t += dt;
            const k = Math.min(1, c.anim.t / c.anim.dur);
            const ease = 1 - Math.pow(1 - k, 2);
            c.grp.position.lerpVectors(c.anim.from, c.anim.to, ease);
            c.grp.position.y = c.anim.from.y + (c.anim.to.y - c.anim.from.y) * ease + Math.sin(ease * Math.PI) * 0.35;
            if (k >= 1) {
              c.grp.position.copy(c.anim.to);
              c.anim = null;
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

    // 盤（上面はフェルト色、側面は木枠）
    const boardMesh = new THREE.Mesh(
      new THREE.BoxGeometry(W + 0.25, 0.34, DEPTH + 0.25),
      [
        new THREE.MeshStandardMaterial({ color: 0x92400e, roughness: 0.8 }),
        new THREE.MeshStandardMaterial({ color: 0x92400e, roughness: 0.8 }),
        new THREE.MeshStandardMaterial({ color: 0xead9b0, roughness: 0.9 }),
        new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.85 }),
        new THREE.MeshStandardMaterial({ color: 0x92400e, roughness: 0.8 }),
        new THREE.MeshStandardMaterial({ color: 0x92400e, roughness: 0.8 }),
      ],
    );
    boardMesh.position.y = -0.17;
    scene.add(boardMesh);

    // ポイントの三角（薄い三角プリミティブを盤面に寝かせる）
    const triShape = (x: number, top: boolean, color: number) => {
      const geo = new THREE.BufferGeometry();
      const zEdge = top ? -DEPTH / 2 + 0.06 : DEPTH / 2 - 0.06;
      const zTip = top ? -DEPTH / 2 + PL : DEPTH / 2 - PL;
      const verts = new Float32Array([
        x - PW * 0.46, 0.012, zEdge,
        x + PW * 0.46, 0.012, zEdge,
        x, 0.012, zTip,
      ]);
      geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.85, side: THREE.DoubleSide }));
      scene.add(m);
    };
    for (let i = 0; i < 24; i++) {
      const { x, top } = pointLayout(i);
      const col = i >= 12 ? i - 12 : 11 - i;
      triShape(x, top, col % 2 === 0 ? 0xb45309 : 0x78716c);
    }

    // 中央バー
    const barMesh = new THREE.Mesh(
      new THREE.BoxGeometry(BAR_W, 0.07, DEPTH),
      new THREE.MeshStandardMaterial({ color: 0x92400e, roughness: 0.8 }),
    );
    barMesh.position.y = 0.035;
    scene.add(barMesh);

    // 上がりトレイ（右側）
    for (const p of [0, 1] as const) {
      const tray = new THREE.Mesh(
        new THREE.BoxGeometry(0.85, 0.08, DEPTH * 0.44),
        new THREE.MeshStandardMaterial({ color: 0x78350f, roughness: 0.85 }),
      );
      tray.position.set(TRAY_X, 0.02, p === 0 ? 1.55 : -1.55);
      scene.add(tray);
    }

    // ハイライト用の薄板（選択中=青、移動先=琥珀、バー/トレイも同系）
    const glowGeo = new THREE.PlaneGeometry(PW * 0.94, PL);
    const pointGlows: THREE.Mesh[] = [];
    for (let i = 0; i < 24; i++) {
      const { x, top } = pointLayout(i);
      const m = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ color: 0xd97706, transparent: true, opacity: 0.45, depthWrite: false }));
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.02, top ? -DEPTH / 2 + PL / 2 : DEPTH / 2 - PL / 2);
      m.visible = false;
      scene.add(m);
      pointGlows.push(m);
    }
    const barGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(BAR_W * 0.9, DEPTH * 0.9),
      new THREE.MeshBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.4, depthWrite: false }),
    );
    barGlow.rotation.x = -Math.PI / 2;
    barGlow.position.set(0, 0.08, 0);
    barGlow.visible = false;
    scene.add(barGlow);
    const offGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.85, DEPTH * 0.92),
      new THREE.MeshBasicMaterial({ color: 0xd97706, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    offGlow.rotation.x = -Math.PI / 2;
    offGlow.position.set(TRAY_X, 0.09, 0);
    offGlow.visible = false;
    scene.add(offGlow);

    // チェッカーのプール（各プレイヤー15個、相互に交換可能として扱う）
    const checkers: CheckerRt[][] = [[], []];
    for (const p of [0, 1] as const) {
      for (let s = 0; s < 15; s++) {
        const grp = createDisc(R, CH, PLAYER_COLORS[p]);
        grp.position.set(0, -5, 0);
        scene.add(grp);
        checkers[p].push({ grp, key: null, anim: null });
      }
    }

    // ダイス（盤上右寄り中央に置く）
    const diceSet = new DiceSet({
      size: 0.52,
      restPositions: [new THREE.Vector3(2.3, 0.3, 0), new THREE.Vector3(3.3, 0.3, 0)],
      scatter: 0.3,
    });
    diceSet.group.visible = false;
    scene.add(diceSet.group);

    // 当たり判定: ポイント24 + バー + 上がりトレイ
    const hits: THREE.Mesh[] = [];
    const hitGeo = new THREE.BoxGeometry(PW * 0.98, 1.5, PL);
    for (let i = 0; i < 24; i++) {
      const { x, top } = pointLayout(i);
      const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
      h.position.set(x, 0.6, top ? -DEPTH / 2 + PL / 2 : DEPTH / 2 - PL / 2);
      h.userData.pickId = `point-${i}`;
      scene.add(h);
      hits.push(h);
    }
    const barHit = new THREE.Mesh(new THREE.BoxGeometry(BAR_W, 1.5, DEPTH), new THREE.MeshBasicMaterial({ visible: false }));
    barHit.position.set(0, 0.6, 0);
    barHit.userData.pickId = "bar";
    scene.add(barHit);
    hits.push(barHit);
    const offHit = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.5, DEPTH), new THREE.MeshBasicMaterial({ visible: false }));
    offHit.position.set(TRAY_X, 0.6, 0);
    offHit.userData.pickId = "off";
    scene.add(offHit);
    hits.push(offHit);

    rtRef.current = { checkers, pointGlows, barGlow, offGlow, diceSet, scene, initialized: false };
    detach = attachPickPointer(stage, () => hits, {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (!id) return;
        const cur = propsRef.current;
        if (id === "off") {
          cur.onBearOff();
        } else if (id === "bar") {
          // バーに自分の駒があるとき、2D ではどのマスのタップでも
          // バー選択になる。バー自体のタップも同じ扱いにする。
          if (cur.bar[0] > 0) cur.onPoint(0);
        } else {
          cur.onPoint(Number(id.slice(6)));
        }
      },
    });
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 盤面同期: 配置キーでチェッカーを対応付け、動いた駒だけアニメーション。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const desired = new Map<string, Place>();
    points.forEach((v, i) => {
      const count = Math.abs(v);
      const player = v > 0 ? 0 : 1;
      for (let s = 0; s < count; s++) {
        desired.set(`pt${i}:${s}`, { key: `pt${i}:${s}`, player, pos: slotPos(i, s) });
      }
    });
    for (const p of [0, 1] as const) {
      for (let s = 0; s < bar[p]; s++) desired.set(`bar${p}:${s}`, { key: `bar${p}:${s}`, player: p, pos: barPos(p, s) });
      for (let s = 0; s < off[p]; s++) desired.set(`off${p}:${s}`, { key: `off${p}:${s}`, player: p, pos: offPos(p, s) });
    }
    for (const p of [0, 1] as const) {
      const pool = rt.checkers[p];
      const kept = new Set<string>();
      for (const c of pool) {
        if (c.key && desired.has(c.key) && desired.get(c.key)!.player === p) kept.add(c.key);
        else c.key = null;
      }
      const free = pool.filter((c) => c.key === null);
      for (const place of desired.values()) {
        if (place.player !== p || kept.has(place.key)) continue;
        const c = free.pop();
        if (!c) break;
        c.key = place.key;
        const to = new THREE.Vector3(...place.pos);
        if (rt.initialized && c.grp.position.distanceTo(to) > 0.01) {
          c.anim = { from: c.grp.position.clone(), to, t: 0, dur: 0.38 };
        } else {
          c.grp.position.copy(to);
          c.anim = null;
        }
      }
    }
    rt.initialized = true;

    // ハイライト
    const targetSet = new Set(targets);
    rt.pointGlows.forEach((m, i) => {
      if (selected === i) {
        (m.material as THREE.MeshBasicMaterial).color.setHex(0x60a5fa);
        m.visible = true;
      } else if (targetSet.has(i)) {
        (m.material as THREE.MeshBasicMaterial).color.setHex(0xd97706);
        m.visible = true;
      } else {
        m.visible = false;
      }
    });
    rt.barGlow.visible = selected === "bar";
    rt.offGlow.visible = canBearOff && selected !== null;

    // ダイス: 新しいロールなら転がし、それ以外は表示だけ合わせる。
    if (lastRoll) {
      rt.diceSet.group.visible = true;
      if (rollKey !== null && rollKey !== prevRollRef.current) {
        rt.diceSet.roll([lastRoll[0], lastRoll[1]]);
      }
    } else {
      rt.diceSet.group.visible = false;
    }
    prevRollRef.current = rollKey;
  }, [points, bar, off, selected, targets, canBearOff, lastRoll, rollKey]);

  return (
    <SceneBox
      height={470}
      label="バックギャモン盤面（3D）。コマをタップして選び、移動先をタップします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#6b4423"
    />
  );
}
