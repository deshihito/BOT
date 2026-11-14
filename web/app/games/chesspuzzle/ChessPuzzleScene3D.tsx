"use client";
// 詰めチェスの 3D 盤（パズル専用。本体の chess とは別実装で、基盤化はしない）。
// 盤は現行 2D と同じ配色の 8x8、駒はプリミティブ造形の簡易版で
// 6 種（P/N/B/R/Q/K）が形で判別できるようにする:
//   ポーン=小球+台、ナイト=傾けた首+頭、ビショップ=円錐+小球、
//   ルーク=円柱+胸壁、クイーン=冠の突起+球、キング=十字架。
// 白は生成り色、黒は濃茶で、現行 2D のグリフ表示と役割は同じ。
// 入力はレイキャストのタップ = 既存ハンドラ（onSquare）へそのまま渡し、
// 左フリック=1手戻す、上フリック=ヒント（既存の盤スワイプと同じ経路）。
// 手数・ヒント等の状態は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { canvasTexture, createBall } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { CpBoard, CpColor, CpPieceType } from "@/lib/chesspuzzle";

interface Props {
  board: CpBoard;
  selected: number | null;
  targets: number[];
  hintFrom: number | null;
  hintTo: number | null;
  onSquare: (index: number) => void;
  /** フリック（左=1手戻す、上=ヒント）。既存の盤スワイプと同じ。 */
  onSwipe: (dir: "left" | "up") => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;

/** index = rank*8 + file（rank 0 = 1段目 = 白側の手前）。 */
function cellPos(index: number): [number, number] {
  const file = index % 8;
  const rank = Math.floor(index / 8);
  return [(file - 3.5) * PITCH, (3.5 - rank) * PITCH];
}

function pieceMaterial(color: CpColor): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: color === "w" ? 0xf3ead3 : 0x2e2620,
    roughness: 0.42,
  });
}

function baseDisc(mat: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.1, 24), mat);
}

/** プリミティブ造形のチェス駒（6種判別可能）。原点はマス中心・底面。 */
function createChessPiece(type: CpPieceType, color: CpColor): THREE.Group {
  const grp = new THREE.Group();
  const mat = pieceMaterial(color);
  const base = baseDisc(mat);
  base.position.y = 0.05;
  grp.add(base);
  const add = (mesh: THREE.Mesh, y: number, x = 0, z = 0) => {
    mesh.position.set(x, y, z);
    grp.add(mesh);
    return mesh;
  };
  if (type === "P") {
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.2, 0.28, 16), mat), 0.24);
    add(createBall(0.17, color === "w" ? 0xf3ead3 : 0x2e2620, { roughness: 0.4 }), 0.52);
  } else if (type === "R") {
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.42, 18), mat), 0.31);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.14, 18), mat), 0.58);
    // 胸壁（4つの小ブロック）
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + Math.PI / 4;
      add(
        new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.12, 0.13), mat),
        0.7, Math.cos(a) * 0.21, Math.sin(a) * 0.21,
      );
    }
  } else if (type === "N") {
    const neck = add(new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.5, 0.3), mat), 0.36, 0, 0.02);
    neck.rotation.x = color === "w" ? 0.5 : -0.5;
    const head = add(
      new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.22, 0.46), mat),
      0.62, 0, color === "w" ? -0.12 : 0.12,
    );
    head.rotation.x = color === "w" ? -0.25 : 0.25;
    // 耳
    add(new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.18, 8), mat), 0.78, 0, color === "w" ? 0.02 : -0.02);
  } else if (type === "B") {
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.26, 0.3, 16), mat), 0.25);
    const mitre = add(new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.48, 18), mat), 0.62);
    mitre.scale.z = 0.78;
    add(createBall(0.09, color === "w" ? 0xf3ead3 : 0x2e2620, { roughness: 0.4 }), 0.93);
  } else if (type === "Q") {
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.29, 0.5, 18), mat), 0.35);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.22, 0.14, 18), mat), 0.66);
    // 冠の突起（5つの小球）
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      add(createBall(0.065, color === "w" ? 0xf3ead3 : 0x2e2620, { roughness: 0.4 }),
        0.78, Math.cos(a) * 0.22, Math.sin(a) * 0.22);
    }
    add(createBall(0.1, color === "w" ? 0xf3ead3 : 0x2e2620, { roughness: 0.4 }), 0.84);
  } else {
    // K: クイーンより太い胴 + 十字架で判別する。
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 0.52, 18), mat), 0.36);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.24, 0.13, 18), mat), 0.68);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.3, 0.09), mat), 0.88);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.09, 0.09), mat), 0.9);
  }
  // 黒駒は白側から見て奥向き（ナイトの頭の向きを対面させる）。
  if (color === "b") grp.rotation.y = Math.PI;
  return grp;
}

interface PieceRt {
  grp: THREE.Group;
  cell: number;
  key: string;
  anim: { from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number } | null;
}

interface SceneRt {
  pieces: Map<number, PieceRt>;
  markers: THREE.Mesh[];
  selRing: THREE.Mesh;
  hintRingFrom: THREE.Mesh;
  hintRingTo: THREE.Mesh;
  scene: THREE.Scene;
  initialized: boolean;
}

function makeRing(color: number): THREE.Mesh {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.42, 0.04, 10, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.05;
  ring.visible = false;
  return ring;
}

export default function ChessPuzzleScene3D({
  board, selected, targets, hintFrom, hintTo, onSquare, onSwipe, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onSquare, onSwipe });
  propsRef.current = { onSquare, onSwipe };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x5b4632,
      camera: { position: [0, 7.4, 5.6], lookAt: [0, 0, 0.3], fov: 40 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        const now = performance.now();
        for (const p of rt.pieces.values()) {
          if (!p.anim) continue;
          p.anim.t += dt;
          const k = Math.min(1, p.anim.t / p.anim.dur);
          const ease = 1 - Math.pow(1 - k, 2);
          p.grp.position.lerpVectors(p.anim.from, p.anim.to, ease);
          p.grp.position.y =
            p.anim.from.y + (p.anim.to.y - p.anim.from.y) * ease + Math.sin(ease * Math.PI) * 0.18;
          if (k >= 1) {
            p.grp.position.copy(p.anim.to);
            p.anim = null;
          }
        }
        const pulse = 0.55 + 0.3 * Math.sin(now / 240);
        if (rt.selRing.visible) (rt.selRing.material as THREE.MeshBasicMaterial).opacity = pulse;
        for (const m of rt.markers) {
          if (m.visible) (m.material as THREE.MeshBasicMaterial).opacity = 0.45 + 0.25 * Math.sin(now / 280);
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    const topTex = canvasTexture("chesspuzzle-board", 512, 512, (g) => {
      const step = 512 / 8;
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          g.fillStyle = (r + c) % 2 === 0 ? "#f0d9b5" : "#b58863";
          g.fillRect(c * step, r * step, step, step);
        }
      }
    });
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x5b4632, roughness: 0.85 });
    const boardMesh = new THREE.Mesh(
      new THREE.BoxGeometry(8.3, 0.35, 8.3),
      [sideMat, sideMat, new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.75 }),
        sideMat, sideMat, sideMat],
    );
    boardMesh.position.y = -0.18;
    scene.add(boardMesh);

    const markers: THREE.Mesh[] = [];
    const markerGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.04, 18);
    for (let i = 0; i < 64; i++) {
      const m = new THREE.Mesh(
        markerGeo,
        new THREE.MeshBasicMaterial({ color: 0x3366cc, transparent: true, opacity: 0.6 }),
      );
      const [x, z] = cellPos(i);
      m.position.set(x, 0.04, z);
      m.visible = false;
      scene.add(m);
      markers.push(m);
    }
    const selRing = makeRing(0xffd94d);
    scene.add(selRing);
    const hintRingFrom = makeRing(0x7ac74f);
    scene.add(hintRingFrom);
    const hintRingTo = makeRing(0x7ac74f);
    scene.add(hintRingTo);

    const hitGeo = new THREE.BoxGeometry(PITCH * 0.96, 0.7, PITCH * 0.96);
    const hits: THREE.Mesh[] = [];
    for (let i = 0; i < 64; i++) {
      const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
      const [x, z] = cellPos(i);
      h.position.set(x, 0.2, z);
      h.userData.pickId = `cell-${i}`;
      scene.add(h);
      hits.push(h);
    }

    rtRef.current = { pieces: new Map(), markers, selRing, hintRingFrom, hintRingTo, scene, initialized: false };
    detach = attachPickPointer(stage, () => hits, {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (!id) return;
        propsRef.current.onSquare(Number(id.slice(5)));
      },
      onFlick: (flick) => {
        if (flick.dir === "left") propsRef.current.onSwipe("left");
        else if (flick.dir === "up") propsRef.current.onSwipe("up");
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

  // 盤面同期: 駒の生成・スライド・除去、選択/移動先/ヒント表示。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const desired = new Map<number, string>();
    board.forEach((piece, i) => {
      if (piece) desired.set(i, `${piece.color}${piece.type}`);
    });
    const spares = new Map<string, PieceRt[]>();
    for (const [cellIdx, p] of [...rt.pieces]) {
      if (desired.get(cellIdx) === p.key) {
        desired.delete(cellIdx);
      } else {
        rt.pieces.delete(cellIdx);
        spares.set(p.key, [...(spares.get(p.key) ?? []), p]);
      }
    }
    for (const [cellIdx, key] of desired) {
      const spare = spares.get(key)?.pop();
      const [x, z] = cellPos(cellIdx);
      const to = new THREE.Vector3(x, 0.02, z);
      if (spare) {
        spare.cell = cellIdx;
        spare.anim = rt.initialized
          ? { from: spare.grp.position.clone(), to, t: 0, dur: 0.32 }
          : null;
        if (!rt.initialized) spare.grp.position.copy(to);
        rt.pieces.set(cellIdx, spare);
      } else {
        const color = key[0] as CpColor;
        const type = key[1] as CpPieceType;
        const grp = createChessPiece(type, color);
        grp.position.copy(to);
        rt.scene.add(grp);
        rt.pieces.set(cellIdx, { grp, cell: cellIdx, key, anim: null });
      }
    }
    for (const list of spares.values()) {
      for (const p of list) rt.scene.remove(p.grp);
    }
    rt.initialized = true;

    if (selected !== null) {
      const [x, z] = cellPos(selected);
      rt.selRing.position.set(x, 0.05, z);
      rt.selRing.visible = true;
    } else {
      rt.selRing.visible = false;
    }
    const placeRing = (ring: THREE.Mesh, idx: number | null) => {
      if (idx === null) {
        ring.visible = false;
        return;
      }
      const [x, z] = cellPos(idx);
      ring.position.set(x, 0.05, z);
      ring.visible = true;
    };
    placeRing(rt.hintRingFrom, hintFrom);
    placeRing(rt.hintRingTo, hintTo);
    const targetSet = new Set(targets);
    rt.markers.forEach((m, i) => {
      m.visible = targetSet.has(i) && !rt.pieces.has(i);
    });
  }, [board, selected, targets, hintFrom, hintTo]);

  return (
    <SceneBox
      height={420}
      label="詰めチェスの盤（3D）。白の駒をタップして選び、移動先をタップします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#5b4632"
    />
  );
}
