"use client";
// 倉庫番の 3D 盤。壁=レンガ色ブロック、箱=木箱色の立方体（ゴール上では
// 現行 2D と同じ緑に変わる）、ゴール=床の赤い円盤、プレイヤー=円柱の体＋
// 球の頭の人型トークンで表す（絵文字は使わない）。
// プレイヤーと箱はセル間を指数補間でスライドさせる（fifteen と同じ追従）。
// 入力は現行クライアントの操作語彙どおり:
//   スワイプ = onFlick / ドラッグ終了時の FlickInfo.dir を親の move へ
//   箱タップ = 親の onBoxTap（歩いて行って押す pushBoxByClick 経路）
//   床のダブルタップ = 親の onUndo（1手戻す。誤発火防止は親側の記録で判定）
//   キーボード（矢印/WASD・Ctrl+Z）は親の window リスナーが従来どおり担う。
// 移動可否・詰み判定はすべて lib/sokoban.ts と親ハンドラが決め、
// ここは表現と入力の橋渡しだけを行う。手数・ベストは親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { createBall } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { SokobanDir } from "@/lib/sokoban";

interface Props {
  width: number;
  height: number;
  walls: boolean[];
  goals: boolean[];
  boxes: number[];
  player: number;
  /** 詰み（デッドロック）になっている箱の index 一覧。 */
  deadlocked: number[];
  status: "playing" | "won";
  /** スワイプ移動（現行の move ハンドラ）。 */
  onMove: (dir: SokobanDir) => void;
  /** 箱タップ（現行の onBoxClick ハンドラ）。 */
  onBoxTap: (index: number) => void;
  /** 床ダブルタップ（現行の1手戻す経路）。 */
  onUndo: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;

function cellPos(index: number, width: number, height: number): [number, number] {
  const r = Math.floor(index / width);
  const c = index % width;
  return [(c - (width - 1) / 2) * PITCH, (r - (height - 1) / 2) * PITCH];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, width: number, height: number) {
  const w = container.clientWidth || 640;
  const h = container.clientHeight || 420;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (width / 2 + 0.9) / Math.tan(hFov / 2);
  const distD = ((height / 2 + 0.9) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.4;
  stage.setCamera({
    position: [0, dist * 0.82, dist * 0.58],
    lookAt: [0, 0, 0.2],
    fov: 42,
  });
}

/** 木箱の造形。ゴール上は現行 2D と同じ緑、詰みの箱は赤みを帯びる。 */
function createCrate(onGoal: boolean, dead: boolean): THREE.Group {
  const grp = new THREE.Group();
  const bodyColor = dead ? 0xb23b2e : onGoal ? 0x7cb342 : 0xb07d3c;
  const edgeColor = dead ? 0x7e271b : onGoal ? 0x4e7a27 : 0x7c4f1d;
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.84, 0.72, 0.84),
    new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.7 }),
  );
  body.position.y = 0.36;
  grp.add(body);
  // 木枠の十字（上面と側面の縁取りで木箱らしく見せる）。
  const edgeMat = new THREE.MeshStandardMaterial({ color: edgeColor, roughness: 0.75 });
  const barGeoH = new THREE.BoxGeometry(0.88, 0.1, 0.2);
  const barGeoV = new THREE.BoxGeometry(0.2, 0.1, 0.88);
  const bar1 = new THREE.Mesh(barGeoH, edgeMat);
  bar1.position.y = 0.73;
  grp.add(bar1);
  const bar2 = new THREE.Mesh(barGeoV, edgeMat);
  bar2.position.y = 0.73;
  grp.add(bar2);
  return grp;
}

/** プレイヤーの人型トークン（円柱の体＋球の頭、現行 2D の青丸と同じ青）。 */
function createPlayerToken(): THREE.Group {
  const grp = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.24, 0.3, 0.52, 20),
    new THREE.MeshStandardMaterial({ color: 0x3f6fb5, roughness: 0.5 }),
  );
  body.position.y = 0.26;
  grp.add(body);
  const head = createBall(0.19, 0xf2c894, { roughness: 0.5 });
  head.position.y = 0.68;
  grp.add(head);
  return grp;
}

interface BoxRt {
  grp: THREE.Group;
  cell: number;
  tx: number;
  tz: number;
  sig: string;
}

interface SceneRt {
  stage: Stage;
  boardGroup: THREE.Group;
  staticGroup: THREE.Group;
  hits: THREE.Mesh[];
  staticSig: string;
  boxesRt: BoxRt[];
  playerGrp: THREE.Group;
  playerTx: number;
  playerTz: number;
  playerPlaced: boolean;
  lastFloorTapAt: number;
}

export default function SokobanScene3D({
  width, height, walls, goals, boxes, player, deadlocked, status,
  onMove, onBoxTap, onUndo, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onMove, onBoxTap, onUndo, boxes });
  propsRef.current = { onMove, onBoxTap, onUndo, boxes };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x37424c,
      camera: { position: [0, 8, 5.6], lookAt: [0, 0, 0.2], fov: 42 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        // プレイヤーと箱を目標セルへ滑らかに追従させる（スライドアニメーション）。
        const k = 1 - Math.exp(-dt * 11);
        rt.playerGrp.position.x += (rt.playerTx - rt.playerGrp.position.x) * k;
        rt.playerGrp.position.z += (rt.playerTz - rt.playerGrp.position.z) * k;
        for (const b of rt.boxesRt) {
          b.grp.position.x += (b.tx - b.grp.position.x) * k;
          b.grp.position.z += (b.tz - b.grp.position.z) * k;
        }
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
    const staticGroup = new THREE.Group();
    boardGroup.add(staticGroup);
    const playerGrp = createPlayerToken();
    boardGroup.add(playerGrp);
    rtRef.current = {
      stage, boardGroup, staticGroup, hits: [], staticSig: "",
      boxesRt: [], playerGrp, playerTx: 0, playerTz: 0, playerPlaced: false, lastFloorTapAt: 0,
    };

    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        const rt = rtRef.current;
        const id = hit?.object.userData.pickId as string | undefined;
        if (!rt || !id) return;
        const index = Number(id.slice(5));
        if (propsRef.current.boxes.includes(index)) {
          rt.lastFloorTapAt = 0;
          propsRef.current.onBoxTap(index);
          return;
        }
        // 床のダブルタップ = 1手戻す（現行 2D の盤面ダブルタップと同じ）。
        const now = performance.now();
        if (now - rt.lastFloorTapAt < 350) {
          rt.lastFloorTapAt = 0;
          propsRef.current.onUndo();
        } else {
          rt.lastFloorTapAt = now;
        }
      },
      // スワイプは掴んだ対象の有無で onFlick / onDragEnd のどちらかに届くため、
      // 両方を親の移動ハンドラへ橋渡しする（方向は FlickInfo.dir をそのまま使う）。
      onFlick: (flick) => {
        if (flick.dir) propsRef.current.onMove(flick.dir);
      },
      onDragEnd: (flick) => {
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

  // 盤面同期: 壁・ゴール・土台は面が変わったときだけ作り直し、
  // 箱とプレイヤーは差分で目標位置だけを更新する（補間は onFrame）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, boardGroup, staticGroup } = rt;
    const deadSet = new Set(deadlocked);
    const staticSig = `${width}x${height}|${walls.map((w) => (w ? 1 : 0)).join("")}|${goals.map((g) => (g ? 1 : 0)).join("")}`;
    if (rt.staticSig !== staticSig) {
      rt.staticSig = staticSig;
      // 面が変わったら箱とプレイヤーは滑らせず置き直す。
      for (const b of rt.boxesRt) boardGroup.remove(b.grp);
      rt.boxesRt = [];
      rt.playerPlaced = false;
      for (const child of [...staticGroup.children]) staticGroup.remove(child);
      for (const h of rt.hits) boardGroup.remove(h);
      rt.hits = [];
      // 土台＋床。
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(width * PITCH + 0.35, 0.3, height * PITCH + 0.35),
        new THREE.MeshStandardMaterial({ color: 0xcfc0a2, roughness: 0.9 }),
      );
      base.position.y = -0.16;
      staticGroup.add(base);
      const floor = new THREE.Mesh(
        new THREE.BoxGeometry(width * PITCH, 0.06, height * PITCH),
        new THREE.MeshStandardMaterial({ color: 0xf3ead8, roughness: 0.95 }),
      );
      floor.position.y = 0.03;
      staticGroup.add(floor);
      // ゴール（床の赤い円盤）と壁（レンガ色ブロック）。
      const goalGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.05, 24);
      const goalMat = new THREE.MeshStandardMaterial({ color: 0xd63c30, roughness: 0.5 });
      const wallGeo = new THREE.BoxGeometry(0.96, 0.78, 0.96);
      const wallMat = new THREE.MeshStandardMaterial({ color: 0x97503c, roughness: 0.85 });
      const wallTopMat = new THREE.MeshStandardMaterial({ color: 0xa85a44, roughness: 0.85 });
      for (let i = 0; i < width * height; i++) {
        const [x, z] = cellPos(i, width, height);
        if (goals[i] && !walls[i]) {
          const disc = new THREE.Mesh(goalGeo, goalMat);
          disc.position.set(x, 0.08, z);
          staticGroup.add(disc);
        }
        if (walls[i]) {
          const wall = new THREE.Mesh(wallGeo, wallMat);
          wall.position.set(x, 0.39, z);
          staticGroup.add(wall);
          const cap = new THREE.Mesh(new THREE.BoxGeometry(0.99, 0.08, 0.99), wallTopMat);
          cap.position.set(x, 0.82, z);
          staticGroup.add(cap);
        }
      }
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
      for (let i = 0; i < width * height; i++) {
        const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        const [x, z] = cellPos(i, width, height);
        h.position.set(x, 0.3, z);
        h.userData.pickId = `cell-${i}`;
        boardGroup.add(h);
        rt.hits.push(h);
      }
      const container = containerRef.current;
      if (container) fitCamera(stage, container, width, height);
    }

    // 箱の差分同期: 同じセルの箱はそのまま、動いた箱は一番近い未割当の
    // 箱オブジェクトを引き継いでスライドさせ、余りは消し、不足は作る。
    const used = new Set<BoxRt>();
    const pending: number[] = [];
    for (const cell of boxes) {
      const same = rt.boxesRt.find((b) => !used.has(b) && b.cell === cell);
      if (same) used.add(same);
      else pending.push(cell);
    }
    for (const cell of pending) {
      const free = rt.boxesRt.find((b) => !used.has(b));
      if (free) {
        free.cell = cell;
        used.add(free);
      } else {
        const grp = new THREE.Group();
        const [x, z] = cellPos(cell, width, height);
        grp.position.set(x, 0, z);
        boardGroup.add(grp);
        const nb: BoxRt = { grp, cell, tx: x, tz: z, sig: "" };
        rt.boxesRt.push(nb);
        used.add(nb);
      }
    }
    rt.boxesRt = rt.boxesRt.filter((b) => {
      if (used.has(b)) return true;
      boardGroup.remove(b.grp);
      return false;
    });
    for (const b of rt.boxesRt) {
      const [x, z] = cellPos(b.cell, width, height);
      b.tx = x;
      b.tz = z;
      const sig = `${goals[b.cell] ? 1 : 0}|${deadSet.has(b.cell) ? 1 : 0}`;
      if (b.sig !== sig) {
        b.sig = sig;
        for (const child of [...b.grp.children]) b.grp.remove(child);
        b.grp.add(createCrate(goals[b.cell], deadSet.has(b.cell)));
      }
    }

    // プレイヤーの目標位置。
    const [px, pz] = cellPos(player, width, height);
    rt.playerTx = px;
    rt.playerTz = pz;
    if (!rt.playerPlaced) {
      // 初回配置だけは補間せず即置く（盤の外から滑ってこないように）。
      rt.playerPlaced = true;
      rt.playerGrp.position.set(px, status === "won" ? 0.05 : 0, pz);
    }
    rt.playerGrp.position.y = status === "won" ? 0.05 : 0;
  }, [width, height, walls, goals, boxes, player, deadlocked, status]);

  const sceneHeight = Math.max(320, Math.min(560, Math.round(500 * (height / width))));
  return (
    <SceneBox
      height={sceneHeight}
      label="倉庫番の盤（3D）。スワイプで移動、箱をタップで押します"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#37424c"
    />
  );
}
