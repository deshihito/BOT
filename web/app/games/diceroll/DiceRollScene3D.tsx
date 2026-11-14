"use client";
// ダイスロールの 3D シーン。盤面の上をサイコロが実際に転がって隣マスへ
// 移動し、最終的な向きが lib/diceroll.ts の orientation と一致する。
// 向きの変換: このシーンのダイスは面配置 [東3,西4,上1,下6,南5,北2] で
// 作り、orientation（top/bottom/north/south/east/west）から基底行列を
// 組んで quaternion を決める。転がしは移動方向に沿った回転として、
// 開始 quaternion から終了 quaternion へ slerp で補間する。
// 入力は既存の盤面スワイプ（フリック=方向）と、隣マスのタップ。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 盤面に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import { canvasTexture } from "@/lib/three-kit/primitives";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { DiceDir, DiceOrientation } from "@/lib/diceroll";

interface Props {
  rows: number;
  cols: number;
  blocked: number[];
  start: number;
  goal: number;
  targetTop: number;
  pos: number;
  orientation: DiceOrientation;
  moves: number;
  onRoll: (dir: DiceDir) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const CELL = 1.02;
const DIE = 0.72;
const TILE_TOP = 0.09;

// このシーンのダイスの面配置（BoxGeometry 素材順 [+x,-x,+y,-y,+z,-z]）。
// 北=-z / 南=+z / 東=+x と置くと、初期向き（上1・北2・東3）と一致する。
const FACE_BY_AXIS = [3, 4, 1, 6, 5, 2] as const;
const WORLD_DIR: Record<string, THREE.Vector3> = {
  top: new THREE.Vector3(0, 1, 0),
  bottom: new THREE.Vector3(0, -1, 0),
  east: new THREE.Vector3(1, 0, 0),
  west: new THREE.Vector3(-1, 0, 0),
  south: new THREE.Vector3(0, 0, 1),
  north: new THREE.Vector3(0, 0, -1),
};

/** orientation から、その向きを再現する quaternion を組み立てる。 */
export function orientationQuaternion(o: DiceOrientation): THREE.Quaternion {
  const dirOfValue = (v: number): THREE.Vector3 => {
    if (o.top === v) return WORLD_DIR.top;
    if (o.bottom === v) return WORLD_DIR.bottom;
    if (o.north === v) return WORLD_DIR.north;
    if (o.south === v) return WORLD_DIR.south;
    if (o.east === v) return WORLD_DIR.east;
    return WORLD_DIR.west;
  };
  // ローカル +x(値3) / +y(値1) / +z(値5) が移る先を基底にする。
  const m = new THREE.Matrix4().makeBasis(dirOfValue(3), dirOfValue(1), dirOfValue(5));
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

function dieFaceTexture(value: number): THREE.CanvasTexture {
  return canvasTexture(`diceroll-die-${value}`, 128, 128, (g) => {
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = value === 1 || value === 4 ? "#c0392b" : "#23272e";
    const P = (x: number, y: number, r = 13) => {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    };
    const lo = 32, mid = 64, hi = 96;
    if (value === 1) P(mid, mid, 20);
    else if (value === 2) { P(lo, lo); P(hi, hi); }
    else if (value === 3) { P(lo, lo); P(mid, mid); P(hi, hi); }
    else if (value === 4) { P(lo, lo); P(hi, lo); P(lo, hi); P(hi, hi); }
    else if (value === 5) { P(lo, lo); P(hi, lo); P(mid, mid); P(lo, hi); P(hi, hi); }
    else if (value === 6) { P(lo, lo); P(hi, lo); P(lo, mid); P(hi, mid); P(lo, hi); P(hi, hi); }
  });
}

function createRollDie(size: number): THREE.Mesh {
  const mats = FACE_BY_AXIS.map(
    (v) => new THREE.MeshStandardMaterial({ map: dieFaceTexture(v), roughness: 0.38, metalness: 0.02 }),
  );
  return new THREE.Mesh(new THREE.BoxGeometry(size, size, size), mats);
}

function tileTexture(kind: "goal" | "start", label: string): THREE.CanvasTexture {
  return canvasTexture(`diceroll-tile-${kind}-${label}`, 128, 128, (g) => {
    g.fillStyle = kind === "goal" ? "#ffe9a8" : "#dbeafe";
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = kind === "goal" ? "#8a6100" : "#1d4ed8";
    g.font = "bold 64px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(label, 64, 68);
  });
}

interface AnimState {
  active: boolean;
  t: number;
  duration: number;
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromQ: THREE.Quaternion;
  toQ: THREE.Quaternion;
}

export default function DiceRollScene3D({ rows, cols, blocked, start, goal, targetTop, pos, orientation, moves, onRoll, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const dieRef = useRef<THREE.Mesh | null>(null);
  const animRef = useRef<AnimState | null>(null);
  const prevRef = useRef<{ pos: number; orientation: DiceOrientation; moves: number } | null>(null);

  const propsRef = useRef({ rows, cols, pos, onRoll });
  propsRef.current = { rows, cols, pos, onRoll };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  const tilePos = (index: number, colsN: number, rowsN: number) => {
    const r = Math.floor(index / colsN);
    const c = index % colsN;
    return new THREE.Vector3((c - (colsN - 1) / 2) * CELL, TILE_TOP + DIE / 2, (r - (rowsN - 1) / 2) * CELL);
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x2b3442,
      camera: { position: [0, 8.4, 5.4], lookAt: [0, 0, 0.25], fov: 42 },
      onFrame: (dt) => {
        const anim = animRef.current;
        const die = dieRef.current;
        if (!anim || !die || !anim.active) return;
        anim.t += dt;
        const k = Math.min(1, anim.t / anim.duration);
        // 転がり: 位置は直線＋小さな弧、向きは開始→終了 quaternion を補間。
        const e = k * k * (3 - 2 * k);
        die.position.lerpVectors(anim.fromPos, anim.toPos, e);
        die.position.y = anim.fromPos.y + Math.sin(k * Math.PI) * 0.16;
        die.quaternion.slerpQuaternions(anim.fromQ, anim.toQ, e);
        if (k >= 1) {
          anim.active = false;
          die.position.copy(anim.toPos);
          die.quaternion.copy(anim.toQ);
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    const p = propsRef.current;
    // 盤の土台
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(p.cols * CELL + 0.35, 0.12, p.rows * CELL + 0.35),
      new THREE.MeshStandardMaterial({ color: 0x4a3f30, roughness: 0.9 }),
    );
    base.position.y = -0.06;
    scene.add(base);

    const blockedSet = new Set(blocked);
    const tiles: THREE.Object3D[] = [];
    for (let i = 0; i < p.rows * p.cols; i++) {
      const isGoal = i === goal;
      const isStart = i === start;
      const isBlocked = blockedSet.has(i);
      let mesh: THREE.Mesh;
      if (isBlocked) {
        mesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.94, 0.34, 0.94),
          new THREE.MeshStandardMaterial({ color: 0x26221f, roughness: 0.85 }),
        );
        mesh.position.y = 0.08;
      } else {
        const side = new THREE.MeshStandardMaterial({ color: 0xd8d2c0, roughness: 0.7 });
        const topMat = isGoal
          ? new THREE.MeshStandardMaterial({ map: tileTexture("goal", String(targetTop)), roughness: 0.6 })
          : isStart
            ? new THREE.MeshStandardMaterial({ map: tileTexture("start", "S"), roughness: 0.6 })
            : new THREE.MeshStandardMaterial({ color: 0xf5f1e6, roughness: 0.7 });
        mesh = new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.18, 0.94), [side, side, topMat, side, side, side]);
        mesh.position.y = 0;
      }
      const tp = tilePos(i, p.cols, p.rows);
      mesh.position.x = tp.x;
      mesh.position.z = tp.z;
      mesh.userData.pickId = `tile-${i}`;
      scene.add(mesh);
      tiles.push(mesh);
    }

    const die = createRollDie(DIE);
    die.userData.pickId = "die";
    scene.add(die);
    dieRef.current = die;

    // 初期配置（マウント時点の状態へ即時合わせ）
    const initPos = tilePos(pos, p.cols, p.rows);
    die.position.copy(initPos);
    die.quaternion.copy(orientationQuaternion(orientation));
    prevRef.current = { pos, orientation, moves };
    animRef.current = {
      active: false, t: 0, duration: 0.34,
      fromPos: initPos.clone(), toPos: initPos.clone(),
      fromQ: die.quaternion.clone(), toQ: die.quaternion.clone(),
    };

    detach = attachPickPointer(stage, () => [...tiles, die], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (!id || !id.startsWith("tile-")) return;
        const target = Number(id.slice(5));
        const cur = propsRef.current;
        const r = Math.floor(cur.pos / cur.cols);
        const c = cur.pos % cur.cols;
        const tr = Math.floor(target / cur.cols);
        const tc = target % cur.cols;
        const dir: DiceDir | null =
          tr === r - 1 && tc === c ? "N" : tr === r + 1 && tc === c ? "S" : tc === c + 1 && tr === r ? "E" : tc === c - 1 && tr === r ? "W" : null;
        if (dir) cur.onRoll(dir);
      },
      // 盤面フリック（スワイプ）= その方向へ転がす（既存の盤面スワイプと同一）。
      onFlick: (flick) => {
        const cur = propsRef.current;
        if (flick.dir === "up") cur.onRoll("N");
        else if (flick.dir === "right") cur.onRoll("E");
        else if (flick.dir === "down") cur.onRoll("S");
        else if (flick.dir === "left") cur.onRoll("W");
      },
    });
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      dieRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 位置と向きの変化で転がしアニメーションを起動する。
  useEffect(() => {
    const die = dieRef.current;
    const prev = prevRef.current;
    if (!die || !prev) return;
    if (pos === prev.pos && moves === prev.moves) {
      prevRef.current = { pos, orientation, moves };
      return;
    }
    if (moves === 0 || moves < prev.moves) {
      // 新規ゲーム/リセットはアニメーションなしで即時合わせ。
      die.position.copy(tilePos(pos, cols, rows));
      die.quaternion.copy(orientationQuaternion(orientation));
      if (animRef.current) animRef.current.active = false;
    } else if (pos !== prev.pos) {
      animRef.current = {
        active: true,
        t: 0,
        duration: 0.34,
        fromPos: tilePos(prev.pos, cols, rows),
        toPos: tilePos(pos, cols, rows),
        fromQ: orientationQuaternion(prev.orientation),
        toQ: orientationQuaternion(orientation),
      };
      die.position.copy(animRef.current.fromPos);
      die.quaternion.copy(animRef.current.fromQ);
    }
    prevRef.current = { pos, orientation, moves };
  }, [pos, orientation, moves, cols, rows]);

  return (
    <SceneBox
      height={380}
      label="ダイスロールの盤（3D）。盤をフリックした方向へサイコロが転がります"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#2b3442"
    />
  );
}
