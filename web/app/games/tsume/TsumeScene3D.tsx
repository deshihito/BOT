"use client";
// 詰将棋の 3D 盤。将棋盤は格子テクスチャつきの板、駒は五角形の楔形
// プリズム（ExtrudeGeometry）で、上面に駒文字を大きく描く
// （麻雀牌の文字テクスチャ手法と同じ canvasTexture）。
// 攻め方（A）は明るい木色、玉方（D）は青灰色で色分けし、玉方は
// 180 度回して対面させる。持ち駒は盤の手前（攻め方）と奥（玉方）に
// 立体配置し、タップで既存の持ち駒選択フローへ接続する。
// 入力はレイキャストのタップ = 既存ハンドラ（onCell / onHand）へそのまま
// 渡し、左フリックは既存の左スワイプ（1手戻す）と同じ経路へ渡す。
// 着手可否・成り選択はすべて親クライアントと lib/tsume.ts が決め、
// ここは表現と入力の橋渡しだけを行う。状態・手数・手順は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import {
  PIECE_LABEL,
  type TsumeBasePiece,
  type TsumeCell,
  type TsumePiece,
} from "@/lib/tsume";

interface Props {
  board: (TsumeCell | null)[];
  handA: Partial<Record<TsumeBasePiece, number>>;
  handD: Partial<Record<TsumeBasePiece, number>>;
  /** 盤上で選択中のマス（selection.kind === "board" のとき）。 */
  selected: number | null;
  /** 持ち駒選択中の駒（selection.kind === "hand" のとき）。 */
  selectedHand: TsumeBasePiece | null;
  targets: number[];
  onCell: (index: number) => void;
  onHand: (piece: TsumeBasePiece) => void;
  /** 左フリック = 既存の左スワイプ（1手戻す）。 */
  onSwipeLeft: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 0.92;
const HAND_ORDER: TsumeBasePiece[] = ["R", "B", "G", "S", "N", "L", "P"];
const ATTACK_COLOR = 0xf2d38a;
const DEFEND_COLOR = 0xb9c9d6;

/** index = y*9 + x（x=0 が9筋・左端、y=0 が1段・上段）。 */
function cellPos(index: number): [number, number] {
  const col = index % 9;
  const row = Math.floor(index / 9);
  return [(col - 4) * PITCH, (row - 4) * PITCH];
}

/** 盤＋持ち駒台が収まるカメラへ寄せる（小画面では引いて全体を収める）。 */
function fitCamera(stage: Stage, container: HTMLElement) {
  const w = container.clientWidth || 640;
  const h = container.clientHeight || 520;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (9 * PITCH / 2 + 1.1) / Math.tan(hFov / 2);
  const distD = ((11.6 / 2 + 0.9) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.2;
  stage.setCamera({
    position: [0, dist * 0.84, dist * 0.56],
    lookAt: [0, 0, 0.35],
    fov: 42,
  });
}

/** 五角形の輪郭（上が頂点）。Shape の y+ が駒の進行方向になる。 */
function pentagonShape(scale = 1): THREE.Shape {
  const s = new THREE.Shape();
  const pts: Array<[number, number]> = [
    [0, 0.5], [0.4, 0.16], [0.33, -0.46], [-0.33, -0.46], [-0.4, 0.16],
  ];
  pts.forEach(([x, y], i) => {
    if (i === 0) s.moveTo(x * scale, y * scale);
    else s.lineTo(x * scale, y * scale);
  });
  s.closePath();
  return s;
}

/** 駒の上面テクスチャ: 五角形の地に駒文字を大きく描く。 */
function pieceTopTexture(piece: TsumePiece, side: "A" | "D"): THREE.CanvasTexture {
  const label = PIECE_LABEL[piece];
  const promoted = piece.startsWith("+");
  return canvasTexture(`tsume-piece-${piece}-${side}`, 128, 152, (g) => {
    g.clearRect(0, 0, 128, 152);
    // 五角形の地（プリズム上面と同形）
    g.beginPath();
    const pts: Array<[number, number]> = [
      [64, 4], [118, 55], [106, 146], [22, 146], [10, 55],
    ];
    pts.forEach(([x, y], i) => {
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.closePath();
    g.fillStyle = side === "A" ? "#f7dd96" : "#c3d2de";
    g.fill();
    g.strokeStyle = "rgba(90,64,20,0.55)";
    g.lineWidth = 3;
    g.stroke();
    g.fillStyle = promoted ? "#c62828" : "#3a2c14";
    const fontSize = label.length >= 2 ? 52 : 76;
    g.font = `bold ${fontSize}px serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    // 頂点側に少し寄せて、2文字でも五角形内に収める。
    g.fillText(label, 64, label.length >= 2 ? 92 : 86);
  });
}

const prismGeoCache = new Map<number, THREE.ExtrudeGeometry>();
function prismGeometry(scale: number): THREE.ExtrudeGeometry {
  const hit = prismGeoCache.get(scale);
  if (hit) return hit;
  const geo = new THREE.ExtrudeGeometry(pentagonShape(scale), {
    depth: 0.16,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.02,
    bevelSegments: 1,
  });
  prismGeoCache.set(scale, geo);
  return geo;
}

/**
 * 楔形の駒グループを作る。rotation.x=-90度で Shape の y+ を -z（攻め方の
 * 進行方向）へ向け、押し出し方向を高さにする。上面には文字テクスチャの
 * 平面を重ねる。玉方はグループごと Y 180 度回す。
 */
function createShogiPiece(piece: TsumePiece, side: "A" | "D", scale = 1): THREE.Group {
  const grp = new THREE.Group();
  const body = new THREE.Mesh(
    prismGeometry(scale),
    new THREE.MeshStandardMaterial({
      color: side === "A" ? ATTACK_COLOR : DEFEND_COLOR,
      roughness: 0.55,
    }),
  );
  body.rotation.x = -Math.PI / 2;
  grp.add(body);
  const top = new THREE.Mesh(
    new THREE.PlaneGeometry(0.84 * scale, 1.0 * scale),
    new THREE.MeshStandardMaterial({
      map: pieceTopTexture(piece, side),
      transparent: true,
      roughness: 0.5,
    }),
  );
  top.rotation.x = -Math.PI / 2;
  top.position.y = 0.205;
  // 平面の +y（テクスチャの上＝五角形の頂点側）が -z（攻め方の進行方向）へ向く。
  grp.add(top);
  if (side === "D") grp.rotation.y = Math.PI;
  return grp;
}

/** 持ち駒の並び（種類ごとに1枚＋個数は DOM 併記と選択リングで示す）。 */
function handEntries(
  hand: Partial<Record<TsumeBasePiece, number>>,
): Array<{ piece: TsumeBasePiece; count: number }> {
  return HAND_ORDER.filter((p) => (hand[p] ?? 0) > 0).map((p) => ({ piece: p, count: hand[p] ?? 0 }));
}

interface PieceRt {
  grp: THREE.Group;
  cell: number;
  side: "A" | "D";
  piece: TsumePiece;
  anim: { from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number } | null;
}

interface SceneRt {
  stage: Stage;
  pieces: Map<number, PieceRt>;
  markers: THREE.Mesh[];
  selRing: THREE.Mesh;
  handGroup: THREE.Group;
  handHits: THREE.Mesh[];
  scene: THREE.Scene;
  initialized: boolean;
}

export default function TsumeScene3D({
  board, handA, handD, selected, selectedHand, targets, onCell, onHand, onSwipeLeft, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onCell, onHand, onSwipeLeft });
  propsRef.current = { onCell, onHand, onSwipeLeft };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x6b543a,
      camera: { position: [0, 9.6, 6.4], lookAt: [0, 0, 0.35], fov: 42 },
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
            p.anim.from.y + (p.anim.to.y - p.anim.from.y) * ease + Math.sin(ease * Math.PI) * 0.2;
          if (k >= 1) {
            p.grp.position.copy(p.anim.to);
            p.anim = null;
          }
        }
        if (rt.selRing.visible) {
          (rt.selRing.material as THREE.MeshBasicMaterial).opacity =
            0.55 + 0.3 * Math.sin(now / 240);
        }
        const pulse = 0.45 + 0.25 * Math.sin(now / 280);
        for (const m of rt.markers) {
          if (m.visible) (m.material as THREE.MeshBasicMaterial).opacity = pulse;
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    fitCamera(stage, container);

    // 将棋盤（格子テクスチャ）
    const topTex = canvasTexture("tsume-board", 576, 576, (g) => {
      g.fillStyle = "#f2d38a";
      g.fillRect(0, 0, 576, 576);
      const step = 576 / 9;
      g.strokeStyle = "#8a6d3b";
      g.lineWidth = 2;
      for (let i = 0; i <= 9; i++) {
        g.beginPath();
        g.moveTo(i * step, 0);
        g.lineTo(i * step, 576);
        g.stroke();
        g.beginPath();
        g.moveTo(0, i * step);
        g.lineTo(576, i * step);
        g.stroke();
      }
      // 星（3三・3六・6三・6六相当の目印）
      g.fillStyle = "#8a6d3b";
      for (const [cx, cy] of [[3, 3], [6, 3], [3, 6], [6, 6]]) {
        g.beginPath();
        g.arc(cx * step, cy * step, 5, 0, Math.PI * 2);
        g.fill();
      }
    });
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x8a6d3b, roughness: 0.8 });
    const boardMesh = new THREE.Mesh(
      new THREE.BoxGeometry(9 * PITCH + 0.35, 0.35, 9 * PITCH + 0.35),
      [sideMat, sideMat, new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.75 }),
        sideMat, sideMat, sideMat],
    );
    boardMesh.position.y = -0.18;
    scene.add(boardMesh);

    // 持ち駒台（手前=攻め方、奥=玉方）
    const standMat = new THREE.MeshStandardMaterial({ color: 0x9c7c46, roughness: 0.8 });
    for (const z of [5.15, -5.15]) {
      const stand = new THREE.Mesh(new THREE.BoxGeometry(7.6, 0.22, 1.25), standMat);
      stand.position.set(0, -0.1, z);
      scene.add(stand);
    }

    // 移動先マーカー
    const markers: THREE.Mesh[] = [];
    const markerGeo = new THREE.PlaneGeometry(PITCH * 0.86, PITCH * 0.86);
    for (let i = 0; i < 81; i++) {
      const m = new THREE.Mesh(
        markerGeo,
        new THREE.MeshBasicMaterial({ color: 0x5da65d, transparent: true, opacity: 0.55, depthWrite: false }),
      );
      m.rotation.x = -Math.PI / 2;
      const [x, z] = cellPos(i);
      m.position.set(x, 0.03, z);
      m.visible = false;
      scene.add(m);
      markers.push(m);
    }
    // 選択中マスの枠
    const selRing = new THREE.Mesh(
      new THREE.PlaneGeometry(PITCH * 0.98, PITCH * 0.98),
      new THREE.MeshBasicMaterial({ color: 0xffd54d, transparent: true, opacity: 0.75, depthWrite: false }),
    );
    selRing.rotation.x = -Math.PI / 2;
    selRing.position.y = 0.025;
    selRing.visible = false;
    scene.add(selRing);

    const handGroup = new THREE.Group();
    scene.add(handGroup);

    // マスの当たり判定
    const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.7, PITCH * 0.98);
    const hits: THREE.Mesh[] = [];
    for (let i = 0; i < 81; i++) {
      const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
      const [x, z] = cellPos(i);
      h.position.set(x, 0.2, z);
      h.userData.pickId = `cell-${i}`;
      scene.add(h);
      hits.push(h);
    }

    rtRef.current = {
      stage, pieces: new Map(), markers, selRing, handGroup, handHits: [], scene, initialized: false,
    };
    detach = attachPickPointer(
      stage,
      () => [...hits, ...(rtRef.current?.handHits ?? []), handGroup],
      {
        onTap: (hit) => {
          const id = hit?.object.userData.pickId as string | undefined;
          if (!id) return;
          if (id.startsWith("cell-")) propsRef.current.onCell(Number(id.slice(5)));
          else if (id.startsWith("hand-")) propsRef.current.onHand(id.slice(5) as TsumeBasePiece);
        },
        onFlick: (flick) => {
          if (flick.dir === "left") propsRef.current.onSwipeLeft();
        },
      },
    );
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 盤面同期: 駒の生成・スライド・除去（取った駒は持ち駒側で再表示される）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const desired = new Map<number, TsumeCell>();
    board.forEach((cell, i) => {
      if (cell) desired.set(i, cell);
    });
    const spares = new Map<string, PieceRt[]>();
    const spareKey = (side: string, piece: string) => `${side}:${piece}`;
    for (const [cellIdx, p] of [...rt.pieces]) {
      const d = desired.get(cellIdx);
      if (d && d.side === p.side && d.piece === p.piece) {
        desired.delete(cellIdx);
      } else {
        rt.pieces.delete(cellIdx);
        const key = spareKey(p.side, p.piece);
        spares.set(key, [...(spares.get(key) ?? []), p]);
      }
    }
    for (const [cellIdx, d] of desired) {
      const key = spareKey(d.side, d.piece);
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
        const grp = createShogiPiece(d.piece, d.side, 0.92);
        grp.position.copy(to);
        rt.scene.add(grp);
        rt.pieces.set(cellIdx, { grp, cell: cellIdx, side: d.side, piece: d.piece, anim: null });
      }
    }
    for (const list of spares.values()) {
      for (const p of list) rt.scene.remove(p.grp);
    }
    rt.initialized = true;

    // 選択枠と移動先マーカー
    if (selected !== null) {
      const [x, z] = cellPos(selected);
      rt.selRing.position.set(x, 0.025, z);
      rt.selRing.visible = true;
    } else {
      rt.selRing.visible = false;
    }
    const targetSet = new Set(targets);
    rt.markers.forEach((m, i) => {
      m.visible = targetSet.has(i);
    });

    // 持ち駒の立体配置（作り直し。最大で攻守あわせ14種）
    for (const child of [...rt.handGroup.children]) rt.handGroup.remove(child);
    rt.handHits = [];
    const placeHand = (
      entries: Array<{ piece: TsumeBasePiece; count: number }>,
      side: "A" | "D",
      z: number,
    ) => {
      entries.forEach((entry, idx) => {
        const x = (idx - (entries.length - 1) / 2) * 1.05;
        const grp = createShogiPiece(entry.piece, side, 0.8);
        grp.position.set(x, 0.03, z);
        grp.traverse((o) => { o.userData.pickId = `hand-${entry.piece}`; });
        // 玉方の持ち駒はタップ対象にしない（選択できるのは攻め方だけ）。
        if (side === "D") grp.traverse((o) => { delete o.userData.pickId; });
        rt.handGroup.add(grp);
        if (side === "A") {
          // 個数分の小さな積み重ねで残数を示す（正確な数は DOM 併記が担う）。
          for (let s = 1; s < Math.min(entry.count, 3); s++) {
            const extra = createShogiPiece(entry.piece, side, 0.8);
            extra.position.set(x, 0.03 + s * 0.19, z);
            extra.traverse((o) => { o.userData.pickId = `hand-${entry.piece}`; });
            rt.handGroup.add(extra);
          }
          const hit = new THREE.Mesh(
            new THREE.BoxGeometry(0.95, 0.8, 1.05),
            new THREE.MeshBasicMaterial({ visible: false }),
          );
          hit.position.set(x, 0.3, z);
          hit.userData.pickId = `hand-${entry.piece}`;
          rt.handGroup.add(hit);
          rt.handHits.push(hit);
          if (selectedHand === entry.piece) {
            const ring = new THREE.Mesh(
              new THREE.PlaneGeometry(1.0, 1.1),
              new THREE.MeshBasicMaterial({ color: 0xffd54d, transparent: true, opacity: 0.65, depthWrite: false }),
            );
            ring.rotation.x = -Math.PI / 2;
            ring.position.set(x, 0.02, z);
            rt.handGroup.add(ring);
          }
        }
      });
    };
    placeHand(handEntries(handA), "A", 5.15);
    placeHand(handEntries(handD), "D", -5.15);
  }, [board, handA, handD, selected, selectedHand, targets]);

  return (
    <SceneBox
      height={520}
      label="詰将棋の盤（3D）。駒をタップして選び、移動先をタップします。持ち駒もタップで選べます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#6b543a"
    />
  );
}
