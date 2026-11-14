"use client";
// リバーシの 3D 盤。石は両面（黒/白）の円盤で、反転は X 軸回転で表現する
// （着手地点からの距離で遅延させ、波のように裏返る）。
// 着手可否はサーバー側の view が決め、ここは表現と入力の橋渡しだけを行う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 盤に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createDisc, canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

interface Props {
  /** seat 配列（-1=空き, 0=黒, 1=白）。 */
  cells: number[];
  legalMoves: number[];
  lastMove: number | null;
  flipped: number[];
  myTurn: boolean;
  onPlace: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.02;
const BLACK = 0x17181a;
const WHITE = 0xf2f0e8;

interface DiscRt {
  grp: THREE.Group;
  rot: number;
  targetRot: number;
  delayUntil: number;
  popAt: number;
}

function cellPos(index: number): [number, number] {
  return [((index % 8) - 3.5) * PITCH, (Math.floor(index / 8) - 3.5) * PITCH];
}

export default function ReversiScene3D({ cells, legalMoves, lastMove, flipped, myTurn, onPlace, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<{ discs: Map<number, DiscRt>; markers: THREE.Mesh[]; scene: THREE.Scene } | null>(null);
  const propsRef = useRef({ cells, legalMoves, lastMove, flipped, myTurn, onPlace });
  propsRef.current = { cells, legalMoves, lastMove, flipped, myTurn, onPlace };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x14532d,
      camera: { position: [0, 7.6, 5.4], lookAt: [0, 0, 0.5], fov: 40 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        const now = performance.now();
        for (const d of rt.discs.values()) {
          if (now >= d.delayUntil && d.rot !== d.targetRot) {
            const dir = Math.sign(d.targetRot - d.rot);
            d.rot += dir * Math.min(Math.abs(d.targetRot - d.rot), (Math.PI / 0.45) * dt);
            d.grp.rotation.x = d.rot;
          }
          const age = (now - d.popAt) / 220;
          const s = d.popAt > 0 && age < 1 ? 1 + 0.25 * Math.sin(age * Math.PI) : 1;
          d.grp.scale.setScalar(s);
        }
        const pulse = 0.45 + 0.25 * Math.sin(now / 280);
        for (const m of rt.markers) {
          (m.material as THREE.MeshBasicMaterial).opacity = m.visible ? pulse : 0;
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // 盤（上面にマス目テクスチャ）と枠
    const topTex = canvasTexture("reversi-board", 512, 512, (g) => {
      g.fillStyle = "#1f7a4d";
      g.fillRect(0, 0, 512, 512);
      g.strokeStyle = "rgba(10, 40, 24, 0.85)";
      g.lineWidth = 3;
      const step = 512 / 8;
      for (let i = 0; i <= 8; i++) {
        g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step, 512); g.stroke();
        g.beginPath(); g.moveTo(0, i * step); g.lineTo(512, i * step); g.stroke();
      }
    });
    const span = PITCH * 8;
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(span + 0.3, 0.35, span + 0.3),
      [
        new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.7 }),
        new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.7 }),
        new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.75 }),
        new THREE.MeshStandardMaterial({ color: 0x51351b, roughness: 0.8 }),
        new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.7 }),
        new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.7 }),
      ],
    );
    board.position.y = -0.18;
    scene.add(board);

    // 合法手マーカー
    const markers: THREE.Mesh[] = [];
    const markerGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.03, 16);
    for (let i = 0; i < 64; i++) {
      const m = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
      const [x, z] = cellPos(i);
      m.position.set(x, 0.03, z);
      m.visible = false;
      scene.add(m);
      markers.push(m);
    }

    // セルの当たり判定
    const hitGeo = new THREE.BoxGeometry(PITCH * 0.96, 0.5, PITCH * 0.96);
    const hits: THREE.Mesh[] = [];
    for (let i = 0; i < 64; i++) {
      const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
      const [x, z] = cellPos(i);
      h.position.set(x, 0.1, z);
      h.userData.pickId = `cell-${i}`;
      scene.add(h);
      hits.push(h);
    }

    rtRef.current = { discs: new Map(), markers, scene };
    detach = attachPickPointer(stage, () => hits, {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (!id) return;
        const cur = propsRef.current;
        const idx = Number(id.slice(5));
        if (cur.myTurn && cur.cells[idx] === -1 && cur.legalMoves.includes(idx)) cur.onPlace(idx);
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

  // 盤面同期: 石の生成・反転予約・マーカー表示。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const now = performance.now();
    cells.forEach((seat, i) => {
      let d = rt.discs.get(i);
      if (seat === -1) {
        if (d) {
          rt.scene.remove(d.grp);
          rt.discs.delete(i);
        }
        return;
      }
      const targetRot = seat === 0 ? 0 : Math.PI;
      if (!d) {
        const grp = createDisc(0.42, 0.13, BLACK, WHITE);
        const [x, z] = cellPos(i);
        grp.position.set(x, 0.09, z);
        grp.rotation.x = targetRot;
        rt.scene.add(grp);
        d = { grp, rot: targetRot, targetRot, delayUntil: 0, popAt: i === lastMove ? now : 0 };
        rt.discs.set(i, d);
      } else if (d.targetRot !== targetRot) {
        d.targetRot = targetRot;
        const dist = lastMove !== null
          ? Math.abs(Math.floor(i / 8) - Math.floor(lastMove / 8)) + Math.abs((i % 8) - (lastMove % 8))
          : 0;
        d.delayUntil = now + (flipped.includes(i) ? dist * 45 : 0);
      }
      if (i === lastMove && d.popAt === 0) d.popAt = now;
      if (i !== lastMove) d.popAt = d.popAt;
    });
    rt.markers.forEach((m, i) => {
      m.visible = myTurn && cells[i] === -1 && legalMoves.includes(i);
    });
  }, [cells, legalMoves, lastMove, flipped, myTurn]);

  return (
    <SceneBox
      height={400}
      label="リバーシ盤面（3D）。置けるマスをタップします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#14532d"
    />
  );
}
