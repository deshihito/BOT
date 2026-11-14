"use client";
// チェッカーの 3D 盤。駒は円盤（createDisc）で、キング化は2段目を重ねて
// 表現する。入力は既存操作（駒タップ→移動先タップ）をレイキャストで
// クライアントの onCell へそのまま渡す。着手可否はサーバー側の view と
// クライアント状態が決め、ここは表現と入力の橋渡しだけを行う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 盤に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createDisc, canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

interface Props {
  /** 64 マス（0=空, 1=seat0, 2=seat1, 3=seat0キング, 4=seat1キング）。 */
  board: number[];
  selected: number | null;
  targets: number[];
  captureTargets: number[];
  lastMove: { from: number; to: number } | null;
  onCell: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;
const SEAT_COLORS = [0x26262b, 0xc0392b] as const;

function ownerOf(value: number): number {
  if (value === 1 || value === 3) return 0;
  if (value === 2 || value === 4) return 1;
  return -1;
}
function isKing(value: number): boolean {
  return value === 3 || value === 4;
}
function cellPos(index: number): [number, number] {
  return [((index % 8) - 3.5) * PITCH, (Math.floor(index / 8) - 3.5) * PITCH];
}

interface PieceRt {
  grp: THREE.Group;
  kingDisc: THREE.Group;
  cell: number;
  owner: number;
  anim: { from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number } | null;
}

export default function CheckersScene3D({ board, selected, targets, captureTargets, lastMove, onCell, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<{
    pieces: Map<number, PieceRt>;
    markers: THREE.Mesh[];
    selRing: THREE.Mesh;
    scene: THREE.Scene;
    initialized: boolean;
  } | null>(null);
  const propsRef = useRef({ onCell });
  propsRef.current = { onCell };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x7a4a21,
      camera: { position: [0, 7.6, 5.4], lookAt: [0, 0, 0.5], fov: 40 },
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
          p.grp.position.y = p.anim.from.y + (p.anim.to.y - p.anim.from.y) * ease + Math.sin(ease * Math.PI) * 0.22;
          if (k >= 1) {
            p.grp.position.copy(p.anim.to);
            p.anim = null;
          }
        }
        if (rt.selRing.visible) {
          (rt.selRing.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.3 * Math.sin(now / 240);
        }
        const pulse = 0.5 + 0.25 * Math.sin(now / 280);
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

    const topTex = canvasTexture("checkers-board", 512, 512, (g) => {
      const step = 512 / 8;
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          g.fillStyle = (r + c) % 2 === 1 ? "#9c6b30" : "#ecd7ac";
          g.fillRect(c * step, r * step, step, step);
        }
      }
    });
    const boardMesh = new THREE.Mesh(
      new THREE.BoxGeometry(8.3, 0.35, 8.3),
      [
        new THREE.MeshStandardMaterial({ color: 0x5d3715, roughness: 0.8 }),
        new THREE.MeshStandardMaterial({ color: 0x5d3715, roughness: 0.8 }),
        new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.75 }),
        new THREE.MeshStandardMaterial({ color: 0x4a2c10, roughness: 0.85 }),
        new THREE.MeshStandardMaterial({ color: 0x5d3715, roughness: 0.8 }),
        new THREE.MeshStandardMaterial({ color: 0x5d3715, roughness: 0.8 }),
      ],
    );
    boardMesh.position.y = -0.18;
    scene.add(boardMesh);

    // 移動先マーカー（通常=緑、取り=赤）。色は同期時に差し替える。
    const markers: THREE.Mesh[] = [];
    const markerGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.04, 18);
    for (let i = 0; i < 64; i++) {
      const m = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: 0x5da65d, transparent: true, opacity: 0.6 }));
      const [x, z] = cellPos(i);
      m.position.set(x, 0.04, z);
      m.visible = false;
      scene.add(m);
      markers.push(m);
    }

    // 選択中コマのリング
    const selRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.46, 0.045, 10, 32),
      new THREE.MeshBasicMaterial({ color: 0xffd94d, transparent: true, opacity: 0.8 }),
    );
    selRing.rotation.x = Math.PI / 2;
    selRing.position.y = 0.05;
    selRing.visible = false;
    scene.add(selRing);

    // セルの当たり判定
    const hitGeo = new THREE.BoxGeometry(PITCH * 0.96, 0.6, PITCH * 0.96);
    const hits: THREE.Mesh[] = [];
    for (let i = 0; i < 64; i++) {
      const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
      const [x, z] = cellPos(i);
      h.position.set(x, 0.15, z);
      h.userData.pickId = `cell-${i}`;
      scene.add(h);
      hits.push(h);
    }

    rtRef.current = { pieces: new Map(), markers, selRing, scene, initialized: false };
    detach = attachPickPointer(stage, () => hits, {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (!id) return;
        propsRef.current.onCell(Number(id.slice(5)));
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

  // 盤面同期: 駒の生成・移動（スライド）・除去・キング化、選択/移動先表示。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const makePiece = (owner: number, king: boolean, cell: number): PieceRt => {
      const grp = createDisc(0.4, 0.14, SEAT_COLORS[owner]);
      const kingDisc = createDisc(0.33, 0.13, SEAT_COLORS[owner]);
      kingDisc.position.y = 0.15;
      kingDisc.visible = king;
      grp.add(kingDisc);
      const [x, z] = cellPos(cell);
      grp.position.set(x, 0.1, z);
      rt.scene.add(grp);
      return { grp, kingDisc, cell, owner, anim: null };
    };
    // 希望配置
    const desired = new Map<number, { owner: number; king: boolean }>();
    board.forEach((v, i) => {
      const o = ownerOf(v);
      if (o >= 0) desired.set(i, { owner: o, king: isKing(v) });
    });
    // その場に残る駒を確定し、外れた駒は同色の予備として再利用する
    // （移動した駒を拾ってスライドさせ、取られた駒だけが消える）。
    const spares = new Map<number, PieceRt[]>([[0, []], [1, []]]);
    for (const [cell, p] of [...rt.pieces]) {
      const d = desired.get(cell);
      if (d && d.owner === p.owner) {
        p.kingDisc.visible = d.king;
        desired.delete(cell);
      } else {
        rt.pieces.delete(cell);
        spares.get(p.owner)!.push(p);
      }
    }
    for (const [cell, d] of desired) {
      const spare = spares.get(d.owner)!.pop();
      if (spare) {
        spare.cell = cell;
        spare.kingDisc.visible = d.king;
        const [x, z] = cellPos(cell);
        const to = new THREE.Vector3(x, 0.1, z);
        spare.anim = rt.initialized
          ? { from: spare.grp.position.clone(), to, t: 0, dur: 0.35 }
          : null;
        if (!rt.initialized) spare.grp.position.copy(to);
        rt.pieces.set(cell, spare);
      } else {
        rt.pieces.set(cell, makePiece(d.owner, d.king, cell));
      }
    }
    for (const list of spares.values()) {
      for (const p of list) rt.scene.remove(p.grp);
    }
    rt.initialized = true;

    // 選択リングと移動先マーカー
    if (selected !== null && rt.pieces.has(selected)) {
      const [x, z] = cellPos(selected);
      rt.selRing.position.set(x, 0.05, z);
      rt.selRing.visible = true;
    } else {
      rt.selRing.visible = false;
    }
    const capSet = new Set(captureTargets);
    rt.markers.forEach((m, i) => {
      const isT = targets.includes(i);
      m.visible = isT && !rt.pieces.has(i);
      if (isT) (m.material as THREE.MeshBasicMaterial).color.setHex(capSet.has(i) ? 0xd9534f : 0x5da65d);
    });
    void lastMove;
  }, [board, selected, targets, captureTargets, lastMove]);

  return (
    <SceneBox
      height={440}
      label="チェッカー盤面（3D）。コマをタップして選び、移動先をタップします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#7a4a21"
    />
  );
}
