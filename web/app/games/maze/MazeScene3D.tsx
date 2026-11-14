"use client";
// めいろの 3D 盤。壁は盤テクスチャではなく実ブロックで表す:
//   壁 = 立体ブロック（共有壁は重複させず InstancedMesh で軽量化）
//   床 = 平板 / プレイヤー = 青い球トークン（補間移動）
//   ゴール = 発光する円盤＋旗の造形 / ヒント = 最短路マスの淡い発光タイル
// 移動判定は lib/maze.ts と親ハンドラが決め、ここは
// 表現と入力の橋渡しだけを行う。
// 入力は現行の操作語彙どおり: 盤面スワイプ = onFlick を親の移動
// ハンドラ（doMove）へ接続する。矢印キー／WASD は親の window
// リスナーが従来どおり受ける。
// 状態（手数・時間・ヒント説明）は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { createBall } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { MazeDir } from "@/lib/maze";

interface Props {
  /** 各マスの壁ビットマスク（1=北 2=東 4=南 8=西、row-major）。 */
  walls: number[];
  cols: number;
  rows: number;
  player: number;
  goal: number;
  showHint: boolean;
  /** lib が求めた最短路（start → goal の index 列）。 */
  solution: number[];
  status: "playing" | "won";
  /** スワイプ方向の移動（既存の doMove ハンドラ）。 */
  onMove: (dir: MazeDir) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;
const WALL_H = 0.62;

function cellPos(index: number, rows: number, cols: number): [number, number] {
  const r = Math.floor(index / cols);
  const c = index % cols;
  return [(c - (cols - 1) / 2) * PITCH, (r - (rows - 1) / 2) * PITCH];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, cols: number, rows: number) {
  const w = container.clientWidth || 640;
  const h = container.clientHeight || 420;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (cols / 2 + 0.9) / Math.tan(hFov / 2);
  const distD = ((rows / 2 + 0.9) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.2;
  stage.setCamera({
    position: [0, dist * 0.86, dist * 0.52],
    lookAt: [0, 0, 0.2],
    fov: 42,
  });
}

/** ゴールの旗の造形（柱＋布）。 */
function createGoalFlag(): THREE.Group {
  const grp = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 0.62, 8),
    new THREE.MeshStandardMaterial({ color: 0x5d4037, roughness: 0.6 }),
  );
  pole.position.set(-0.16, 0.31, 0);
  grp.add(pole);
  const cloth = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.26, 0.04),
    new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 0.55 }),
  );
  cloth.position.set(0.06, 0.47, 0);
  grp.add(cloth);
  return grp;
}

interface SceneRt {
  stage: Stage;
  boardGroup: THREE.Group;
  floor: THREE.Mesh;
  playerBall: THREE.Mesh;
  playerTarget: THREE.Vector3;
  goalGroup: THREE.Group;
  goalDiscMat: THREE.MeshStandardMaterial;
  hintGroup: THREE.Group;
  boardSig: string;
  hintSig: string;
  playerSnapped: boolean;
}

export default function MazeScene3D({
  walls, cols, rows, player, goal, showHint, solution, status, onMove, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onMove, status });
  propsRef.current = { onMove, status };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x2e3a42,
      camera: { position: [0, 10, 6], lookAt: [0, 0, 0.2], fov: 42 },
      onFrame: (dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        // プレイヤー球は目標セルへ補間移動する（移動可否は lib が決める）。
        const k = Math.min(1, dt * 14);
        rt.playerBall.position.x += (rt.playerTarget.x - rt.playerBall.position.x) * k;
        rt.playerBall.position.z += (rt.playerTarget.z - rt.playerBall.position.z) * k;
        // ゴール円盤はゆっくり脈動させ、到達時は強く光らせる。
        const pulse = propsRef.current.status === "won" ? 0.85 : 0.45 + 0.2 * Math.sin(t * 2.4);
        rt.goalDiscMat.emissiveIntensity = pulse;
        rt.goalGroup.position.y = 0.02 + 0.02 * Math.sin(t * 2.4);
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    const boardGroup = new THREE.Group();
    scene.add(boardGroup);

    // 床（平板）。スワイプのレイキャスト対象も兼ねる。
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.24, 1),
      new THREE.MeshStandardMaterial({ color: 0xe8e2d2, roughness: 0.9 }),
    );
    floor.position.y = -0.13;
    floor.userData.pickId = "floor";
    boardGroup.add(floor);

    const hintGroup = new THREE.Group();
    boardGroup.add(hintGroup);

    // ゴール: 発光する円盤＋旗。
    const goalGroup = new THREE.Group();
    const goalDiscMat = new THREE.MeshStandardMaterial({
      color: 0x66bb6a, roughness: 0.35, emissive: 0x2e7d32, emissiveIntensity: 0.5,
    });
    const goalDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.07, 28), goalDiscMat);
    goalDisc.position.y = 0.04;
    goalGroup.add(goalDisc);
    const flag = createGoalFlag();
    flag.position.set(0.1, 0.07, -0.08);
    goalGroup.add(flag);
    boardGroup.add(goalGroup);

    // プレイヤー: 青い球トークン。
    const playerBall = createBall(0.3, 0x1565c0, { roughness: 0.3 });
    playerBall.position.y = 0.32;
    boardGroup.add(playerBall);

    rtRef.current = {
      stage,
      boardGroup,
      floor,
      playerBall,
      playerTarget: new THREE.Vector3(0, 0.32, 0),
      goalGroup,
      goalDiscMat,
      hintGroup,
      boardSig: "",
      hintSig: "",
      playerSnapped: false,
    };

    detach = attachPickPointer(stage, () => [floor], {
      onFlick: (flick) => {
        // スワイプ = 移動（現行の盤面スワイプと同じ語彙）。
        if (flick.dir) propsRef.current.onMove(flick.dir);
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

  // 盤面同期: 壁ブロック（InstancedMesh）・床・ゴール位置は寸法と壁の
  // 署名が変わったときだけ作り直し、プレイヤーは目標位置だけ更新する。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const sig = `${cols}x${rows}|${walls.join(",")}|${goal}`;
    const boardChanged = rt.boardSig !== sig;
    if (boardChanged) {
      rt.boardSig = sig;
      // 旧い壁インスタンスを外す。
      for (const child of [...rt.boardGroup.children]) {
        if (child.userData.isWalls) rt.boardGroup.remove(child);
      }
      // 床の大きさを盤に合わせる。
      rt.floor.scale.set(cols * PITCH + 0.3, 1, rows * PITCH + 0.3);

      // 壁セグメントを重複なく集める（隣接マスと共有する壁は1つだけ）。
      const segs: { x: number; z: number; rotY: number }[] = [];
      const seen = new Set<string>();
      const addSeg = (key: string, x: number, z: number, rotY: number) => {
        if (seen.has(key)) return;
        seen.add(key);
        segs.push({ x, z, rotY });
      };
      for (let i = 0; i < walls.length; i++) {
        const bits = walls[i];
        const r = Math.floor(i / cols);
        const c = i % cols;
        const [x, z] = cellPos(i, rows, cols);
        if (bits & 1) addSeg(`h-${r}-${c}`, x, z - PITCH / 2, 0);
        if (bits & 4) addSeg(`h-${r + 1}-${c}`, x, z + PITCH / 2, 0);
        if (bits & 8) addSeg(`v-${r}-${c}`, x - PITCH / 2, z, Math.PI / 2);
        if (bits & 2) addSeg(`v-${r}-${c + 1}`, x + PITCH / 2, z, Math.PI / 2);
      }
      const wallGeo = new THREE.BoxGeometry(PITCH + 0.1, WALL_H, 0.14);
      const wallMat = new THREE.MeshStandardMaterial({ color: 0x37474f, roughness: 0.7 });
      const inst = new THREE.InstancedMesh(wallGeo, wallMat, Math.max(1, segs.length));
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0);
      segs.forEach((s, idx) => {
        q.setFromAxisAngle(up, s.rotY);
        m4.compose(
          new THREE.Vector3(s.x, WALL_H / 2, s.z),
          q,
          new THREE.Vector3(1, 1, 1),
        );
        inst.setMatrixAt(idx, m4);
      });
      inst.count = segs.length;
      inst.instanceMatrix.needsUpdate = true;
      inst.userData.isWalls = true;
      rt.boardGroup.add(inst);

      const [gx, gz] = cellPos(goal, rows, cols);
      rt.goalGroup.position.set(gx, 0, gz);
      const container = containerRef.current;
      if (container) fitCamera(rt.stage, container, cols, rows);
    }

    // プレイヤーの目標位置（補間は onFrame が担う）。
    const [px, pz] = cellPos(player, rows, cols);
    rt.playerTarget.set(px, 0.32, pz);
    // 新しい盤面では補間せず即座にスタートへ置く。
    if (boardChanged || !rt.playerSnapped) {
      rt.playerBall.position.copy(rt.playerTarget);
      rt.playerSnapped = true;
    }

    // ヒント: 最短路マスに淡い発光タイルを置く（表示のみ、判定は lib）。
    const hintSig = `${showHint ? 1 : 0}|${solution.join(",")}|${cols}x${rows}`;
    if (rt.hintSig !== hintSig) {
      rt.hintSig = hintSig;
      for (const child of [...rt.hintGroup.children]) rt.hintGroup.remove(child);
      if (showHint) {
        const hintMat = new THREE.MeshStandardMaterial({
          color: 0xf9d976, roughness: 0.5, emissive: 0xa97b12, emissiveIntensity: 0.35,
          transparent: true, opacity: 0.85,
        });
        const hintGeo = new THREE.BoxGeometry(0.7, 0.05, 0.7);
        for (const idx of solution) {
          if (idx === player || idx === goal) continue;
          const tile = new THREE.Mesh(hintGeo, hintMat);
          const [hx, hz] = cellPos(idx, rows, cols);
          tile.position.set(hx, 0.03, hz);
          rt.hintGroup.add(tile);
        }
      }
    }
  }, [walls, cols, rows, player, goal, showHint, solution]);

  const height = Math.max(320, Math.min(520, Math.round((560 * rows) / Math.max(1, cols)) + 60));
  return (
    <SceneBox
      height={height}
      label="めいろの盤（3D）。盤面をスワイプして移動します"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#2e3a42"
    />
  );
}
