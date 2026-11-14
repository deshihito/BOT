"use client";
// 氷の迷路の 3D 盤。氷盤 = 半透明寄りの明るい青タイル、岩／壁 =
// グレーの造形、プレイヤー = 青い球、ゴール = 発光する円盤で表す。
// スワイプで滑走する現行仕様どおり、到達セルは lib/icemaze.ts の
// 滑走関数の結果が正で、シーンはその経路へ滑走アニメーションで
// 追従するだけ（停止位置を 3D 側で再計算しない）。
// 入力は maze と同型: 盤面スワイプ = onFlick を親の slide ハンドラへ
// 接続する。方向キー・方向ボタン・1手戻すは親 DOM が従来どおり担う。
// 状態（手数・最短・ベスト）は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { createBall } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { IceDir } from "@/lib/icemaze";

interface Props {
  /** 壁マスなら true（row-major）。 */
  walls: boolean[];
  cols: number;
  rows: number;
  player: number;
  goal: number;
  start: number;
  status: "playing" | "won";
  /** スワイプ方向への滑走（既存の slide ハンドラ）。 */
  onSlide: (dir: IceDir) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;

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

interface SlideAnim {
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  dur: number;
}

interface SceneRt {
  stage: Stage;
  boardGroup: THREE.Group;
  floor: THREE.Mesh;
  playerBall: THREE.Mesh;
  goalDiscMat: THREE.MeshStandardMaterial;
  slideAnim: SlideAnim | null;
  playerCell: number;
  boardSig: string;
  snapped: boolean;
}

export default function IceMazeScene3D({
  walls, cols, rows, player, goal, start, status, onSlide, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onSlide, status });
  propsRef.current = { onSlide, status };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x274b63,
      camera: { position: [0, 9, 5.4], lookAt: [0, 0, 0.2], fov: 42 },
      onFrame: (dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        // 滑走アニメーション: lib が決めた到達セルへ、区間を滑らかに進む。
        if (rt.slideAnim) {
          const a = rt.slideAnim;
          a.t += dt;
          const k = Math.min(1, a.t / a.dur);
          // 滑り出しは速く、壁の手前で減速するイージング。
          const ease = 1 - Math.pow(1 - k, 2);
          rt.playerBall.position.lerpVectors(a.from, a.to, ease);
          if (k >= 1) {
            rt.playerBall.position.copy(a.to);
            rt.slideAnim = null;
          }
        }
        rt.goalDiscMat.emissiveIntensity =
          propsRef.current.status === "won" ? 0.9 : 0.5 + 0.22 * Math.sin(t * 2.6);
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

    // 土台（スワイプのレイキャスト対象も兼ねる）。
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.24, 1),
      new THREE.MeshStandardMaterial({ color: 0x9fc6dd, roughness: 0.85 }),
    );
    floor.position.y = -0.14;
    floor.userData.pickId = "floor";
    boardGroup.add(floor);

    // ゴール: 発光する円盤。
    const goalGroup = new THREE.Group();
    const goalDiscMat = new THREE.MeshStandardMaterial({
      color: 0xffd54d, roughness: 0.3, emissive: 0xa97b12, emissiveIntensity: 0.55,
    });
    const goalDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.08, 28), goalDiscMat);
    goalDisc.position.y = 0.05;
    goalGroup.add(goalDisc);
    const goalRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.42, 0.045, 10, 32),
      new THREE.MeshStandardMaterial({ color: 0xfff3c4, roughness: 0.35 }),
    );
    goalRing.rotation.x = Math.PI / 2;
    goalRing.position.y = 0.09;
    goalGroup.add(goalRing);
    goalGroup.userData.isGoal = true;
    boardGroup.add(goalGroup);

    // プレイヤー: 青い球。
    const playerBall = createBall(0.3, 0x0d47a1, { roughness: 0.25 });
    playerBall.position.y = 0.32;
    boardGroup.add(playerBall);

    rtRef.current = {
      stage,
      boardGroup,
      floor,
      playerBall,
      goalDiscMat,
      slideAnim: null,
      playerCell: -1,
      boardSig: "",
      snapped: false,
    };

    detach = attachPickPointer(stage, () => [floor], {
      onFlick: (flick) => {
        // スワイプ = 滑走（現行の盤面スワイプと同じ語彙）。
        if (flick.dir) propsRef.current.onSlide(flick.dir);
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

  // 盤面同期: 氷タイルと岩は壁の署名が変わったときだけ作り直す。
  // プレイヤー位置が変わったら滑走アニメーションを開始する。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const sig = `${cols}x${rows}|${walls.map((w) => (w ? 1 : 0)).join("")}|${goal}|${start}`;
    const boardChanged = rt.boardSig !== sig;
    if (boardChanged) {
      rt.boardSig = sig;
      for (const child of [...rt.boardGroup.children]) {
        if (child.userData.isTiles) rt.boardGroup.remove(child);
      }
      rt.floor.scale.set(cols * PITCH + 0.3, 1, rows * PITCH + 0.3);

      const tilesGroup = new THREE.Group();
      tilesGroup.userData.isTiles = true;
      // 氷タイル: 半透明寄りの明るい青。
      const iceMat = new THREE.MeshStandardMaterial({
        color: 0xd6f0ff, roughness: 0.25, transparent: true, opacity: 0.82,
      });
      const iceGeo = new THREE.BoxGeometry(0.94, 0.1, 0.94);
      // 岩／壁: グレーの造形（角の取れた岩らしく八面体を併用）。
      const rockMat = new THREE.MeshStandardMaterial({ color: 0x607080, roughness: 0.95 });
      const rockGeo = new THREE.BoxGeometry(0.92, 0.62, 0.92);
      const rockTopGeo = new THREE.OctahedronGeometry(0.34);
      for (let i = 0; i < walls.length; i++) {
        const [x, z] = cellPos(i, rows, cols);
        if (walls[i]) {
          const rock = new THREE.Mesh(rockGeo, rockMat);
          rock.position.set(x, 0.31, z);
          tilesGroup.add(rock);
          const top = new THREE.Mesh(rockTopGeo, rockMat);
          top.position.set(x, 0.68, z);
          top.scale.y = 0.55;
          tilesGroup.add(top);
        } else if (i !== goal) {
          const ice = new THREE.Mesh(iceGeo, iceMat);
          ice.position.set(x, 0.05, z);
          tilesGroup.add(ice);
        }
      }
      rt.boardGroup.add(tilesGroup);

      // ゴール位置を合わせる。
      for (const child of rt.boardGroup.children) {
        if (child.userData.isGoal) {
          const [gx, gz] = cellPos(goal, rows, cols);
          child.position.set(gx, 0, gz);
        }
      }
      const container = containerRef.current;
      if (container) fitCamera(rt.stage, container, cols, rows);
    }

    // プレイヤー: 新規盤面では即置き、それ以外は滑走アニメーション。
    const [px, pz] = cellPos(player, rows, cols);
    const target = new THREE.Vector3(px, 0.32, pz);
    if (boardChanged || !rt.snapped) {
      rt.playerBall.position.copy(target);
      rt.slideAnim = null;
      rt.snapped = true;
    } else if (rt.playerCell !== player) {
      const from = rt.playerBall.position.clone();
      const dist = Math.hypot(target.x - from.x, target.z - from.z);
      // 滑走区間の長さに応じて時間を伸ばす（経路への追従のみ）。
      rt.slideAnim = { from, to: target, t: 0, dur: Math.min(0.75, Math.max(0.18, dist * 0.11)) };
    }
    rt.playerCell = player;
  }, [walls, cols, rows, player, goal, start]);

  return (
    <SceneBox
      height={420}
      label="氷の迷路の盤（3D）。盤面をスワイプすると壁の手前まで滑ります"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#274b63"
    />
  );
}
