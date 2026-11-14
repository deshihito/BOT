"use client";
// 三目並べ（オンライン）の 3D 盤。OnlineShell の Board 差し替え方式:
//   盤 = 格子つきの平板 / ○ = 横置きのトーラス / × = 2本の細い
//   直方体を斜めに組んだ造形 / 勝ち筋 = 発光ライン（細い直方体）
// 勝敗判定はサーバー状態（view）が正で、勝ち筋ラインの位置は view の
// winCells から導く。着手可否は親クライアントのハンドラが決め、
// ここはマスタップを既存の着手ハンドラへ渡すだけ。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 盤に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

interface Props {
  /** 9 マス（0=空き, 1=seat0=○, 2=seat1=×）。 */
  board: number[];
  /** 勝ち筋のマス（view の情報。無ければ null）。 */
  winCells: number[] | null;
  /** マスタップ（既存の着手ハンドラ）。 */
  onCell: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.15;

function cellSeat(value: number): number {
  if (value === 1) return 0;
  if (value === 2 || value === -1) return 1;
  return -1;
}

function cellPos(index: number): [number, number] {
  const r = Math.floor(index / 3);
  const c = index % 3;
  return [(c - 1) * PITCH, (r - 1) * PITCH];
}

/** ○ の造形: 横置きのトーラス。 */
function createCircleMark(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.TorusGeometry(0.34, 0.1, 14, 32),
    new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.35 }),
  );
  mesh.rotation.x = Math.PI / 2;
  mesh.position.y = 0.16;
  return mesh;
}

/** × の造形: 2本の細い直方体を斜めに組む。 */
function createCrossMark(): THREE.Group {
  const grp = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x2456a6, roughness: 0.35 });
  const geo = new THREE.BoxGeometry(0.85, 0.14, 0.18);
  const barA = new THREE.Mesh(geo, mat);
  barA.rotation.y = Math.PI / 4;
  barA.position.y = 0.16;
  grp.add(barA);
  const barB = new THREE.Mesh(geo, mat);
  barB.rotation.y = -Math.PI / 4;
  barB.position.y = 0.16;
  grp.add(barB);
  return grp;
}

interface CellRt {
  sig: string;
  grp: THREE.Group;
}

interface SceneRt {
  marksGroup: THREE.Group;
  hits: THREE.Mesh[];
  cellsRt: Map<number, CellRt>;
  winLine: THREE.Mesh;
  winLineMat: THREE.MeshStandardMaterial;
}

export default function TictactoeScene3D({ board, winCells, onCell, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onCell });
  propsRef.current = { onCell };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0xf3ead8,
      camera: { position: [0, 4.6, 3.6], lookAt: [0, 0, 0.25], fov: 42 },
      onFrame: (_dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        if (rt.winLine.visible) {
          rt.winLineMat.emissiveIntensity = 0.7 + 0.3 * Math.sin(t * 3.2);
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // 盤: 現行 2D と同じ生成りの平板に格子線を描く。
    const topTex = canvasTexture("tictactoe-board", 384, 384, (g) => {
      g.fillStyle = "#fffdf6";
      g.fillRect(0, 0, 384, 384);
      g.strokeStyle = "#c9b489";
      g.lineWidth = 7;
      for (const p of [128, 256]) {
        g.beginPath();
        g.moveTo(p, 10);
        g.lineTo(p, 374);
        g.stroke();
        g.beginPath();
        g.moveTo(10, p);
        g.lineTo(374, p);
        g.stroke();
      }
    });
    const sideMat = new THREE.MeshStandardMaterial({ color: 0xc9b489, roughness: 0.8 });
    const topMat = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.75 });
    const boardMesh = new THREE.Mesh(
      new THREE.BoxGeometry(3 * PITCH + 0.35, 0.3, 3 * PITCH + 0.35),
      [sideMat, sideMat, topMat, sideMat, sideMat, sideMat],
    );
    boardMesh.position.y = -0.16;
    scene.add(boardMesh);

    const marksGroup = new THREE.Group();
    scene.add(marksGroup);

    // 勝ち筋の発光ライン（細い直方体）。位置は同期時に winCells から置く。
    const winLineMat = new THREE.MeshStandardMaterial({
      color: 0xd9a41c, roughness: 0.3, emissive: 0xd9a41c, emissiveIntensity: 0.8,
    });
    const winLine = new THREE.Mesh(new THREE.BoxGeometry(1, 0.07, 0.16), winLineMat);
    winLine.position.y = 0.1;
    winLine.visible = false;
    scene.add(winLine);

    // マスの当たり判定。
    const hits: THREE.Mesh[] = [];
    const hitGeo = new THREE.BoxGeometry(PITCH * 0.96, 0.7, PITCH * 0.96);
    for (let i = 0; i < 9; i++) {
      const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
      const [x, z] = cellPos(i);
      h.position.set(x, 0.2, z);
      h.userData.pickId = `cell-${i}`;
      scene.add(h);
      hits.push(h);
    }

    rtRef.current = { marksGroup, hits, cellsRt: new Map(), winLine, winLineMat };

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

  // 盤面同期: マスは署名差分で作り直し、勝ち筋ラインは winCells から導く。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    board.forEach((value, i) => {
      const seat = cellSeat(value);
      const sig = String(seat);
      const cur = rt.cellsRt.get(i);
      if (cur && cur.sig === sig) return;
      if (cur) rt.marksGroup.remove(cur.grp);
      const grp = new THREE.Group();
      const [x, z] = cellPos(i);
      grp.position.set(x, 0, z);
      if (seat === 0) grp.add(createCircleMark());
      else if (seat === 1) grp.add(createCrossMark());
      rt.marksGroup.add(grp);
      rt.cellsRt.set(i, { sig, grp });
    });

    // 勝ち筋: 先頭と末尾のマスを結ぶ発光ライン（view の winCells が正）。
    if (winCells && winCells.length >= 2) {
      const [x1, z1] = cellPos(winCells[0]);
      const [x2, z2] = cellPos(winCells[winCells.length - 1]);
      const len = Math.hypot(x2 - x1, z2 - z1) + PITCH * 0.95;
      rt.winLine.scale.x = len;
      rt.winLine.position.set((x1 + x2) / 2, 0.1, (z1 + z2) / 2);
      rt.winLine.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      rt.winLine.visible = true;
    } else {
      rt.winLine.visible = false;
    }
  }, [board, winCells]);

  return (
    <SceneBox
      height={360}
      label="三目並べ盤面（3D）。空きマスをタップして置きます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#f3ead8"
    />
  );
}
