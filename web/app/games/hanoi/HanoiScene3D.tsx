"use client";
// ハノイの塔の 3D シーン。円盤は「持ち上げ→横移動→降ろす」の3段階で動く。
// 操作は柱のタップ（持ち上げ/配置、既存と同じ）と、柱から柱へのドラッグ。
// 移動可否は lib/hanoi.ts が決め、ここは表現と入力の橋渡しだけを行う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createPeg, createRingDisc } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

interface Props {
  pegs: number[][];
  diskCount: number;
  selected: number | null;
  wrongPeg: number | null;
  interactive: boolean;
  onPeg: (peg: number) => void;
  onMovePeg: (from: number, to: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PEG_X = [-2.3, 0, 2.3];
const DISK_H = 0.27;
const BASE_Y = 0.16;
const LIFT_Y = 3.1;
const DISK_COLORS = [0xe5484d, 0xf76b15, 0xffd60a, 0x46a758, 0x3e9bdc, 0x8e4ec6, 0xe93d82, 0x697177];

interface DiskRt {
  mesh: THREE.Mesh;
  peg: number;
  index: number;
  phase: "rest" | "lift" | "move" | "drop";
  targetPeg: number;
  targetIndex: number;
}

function diskRadius(disk: number, count: number): number {
  if (count <= 1) return 1.05;
  return 0.55 + ((disk - 1) / (count - 1)) * 0.95;
}

export default function HanoiScene3D({ pegs, diskCount, selected, wrongPeg, interactive, onPeg, onMovePeg, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<{ disks: Map<number, DiskRt>; stage: ReturnType<typeof createStage> } | null>(null);
  const shakeRef = useRef<{ peg: number; until: number } | null>(null);

  const propsRef = useRef({ pegs, diskCount, selected, interactive, onPeg, onMovePeg });
  propsRef.current = { pegs, diskCount, selected, interactive, onPeg, onMovePeg };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0xf3ead3,
      camera: { position: [0, 4.4, 7.6], lookAt: [0, 1.0, 0], fov: 42 },
      onFrame: (dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        const { selected: sel } = propsRef.current;
        for (const d of rt.disks.values()) {
          const m = d.mesh;
          const targetX = PEG_X[d.targetPeg];
          const restY = BASE_Y + d.targetIndex * DISK_H + DISK_H / 2;
          const isSelectedTop = sel !== null && d.targetPeg === sel && d.targetIndex === (propsRef.current.pegs[sel]?.length ?? 0) - 1 && d.phase === "rest";
          const goalY = isSelectedTop ? restY + 0.55 : restY;
          if (d.phase === "lift") {
            m.position.y += (LIFT_Y - m.position.y) * Math.min(1, dt * 9);
            if (Math.abs(m.position.y - LIFT_Y) < 0.05) d.phase = "move";
          } else if (d.phase === "move") {
            m.position.x += (targetX - m.position.x) * Math.min(1, dt * 9);
            if (Math.abs(m.position.x - targetX) < 0.04) d.phase = "drop";
          } else if (d.phase === "drop") {
            m.position.y += (restY - m.position.y) * Math.min(1, dt * 11);
            if (Math.abs(m.position.y - restY) < 0.02) {
              m.position.y = restY;
              d.phase = "rest";
              d.peg = d.targetPeg;
              d.index = d.targetIndex;
            }
          } else {
            // rest: 選択中の浮き上がりなどをなめらかに
            m.position.x += (targetX - m.position.x) * Math.min(1, dt * 12);
            m.position.y += (goalY - m.position.y) * Math.min(1, dt * 12);
            if (shakeRef.current && d.targetPeg === shakeRef.current.peg && t * 1000 < shakeRef.current.until) {
              m.position.x = targetX + Math.sin(t * 55) * 0.05;
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

    // 台と土台
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(9, 36),
      new THREE.MeshStandardMaterial({ color: 0xe7dcc0, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    scene.add(ground);
    const baseBoard = new THREE.Mesh(
      new THREE.BoxGeometry(6.6, 0.3, 2.2),
      new THREE.MeshStandardMaterial({ color: 0x8a7a52, roughness: 0.7 }),
    );
    baseBoard.position.y = 0.01;
    scene.add(baseBoard);

    const hitBoxes: THREE.Mesh[] = [];
    for (let peg = 0; peg < 3; peg++) {
      const pegMesh = createPeg(0.09, 2.9, 0xb09a6a);
      pegMesh.position.set(PEG_X[peg], BASE_Y + 1.45, 0);
      scene.add(pegMesh);
      const hit = new THREE.Mesh(
        new THREE.BoxGeometry(2.0, 3.4, 1.8),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hit.position.set(PEG_X[peg], BASE_Y + 1.6, 0);
      hit.userData.pickId = `peg-${peg}`;
      scene.add(hit);
      hitBoxes.push(hit);
    }

    rtRef.current = { disks: new Map(), stage };

    let dragFrom: number | null = null;
    detach = attachPickPointer(stage, () => hitBoxes, {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (!id || !propsRef.current.interactive) return;
        propsRef.current.onPeg(Number(id.slice(4)));
      },
      onDragStart: (hit) => {
        const id = hit.object.userData.pickId as string | undefined;
        dragFrom = id ? Number(id.slice(4)) : null;
      },
      onDragEnd: (_flick, hit) => {
        if (dragFrom === null || !propsRef.current.interactive) return;
        let to: number | null = null;
        const id = hit?.object.userData.pickId as string | undefined;
        if (id) to = Number(id.slice(4));
        if (to !== null && to !== dragFrom) propsRef.current.onMovePeg(dragFrom, to);
        dragFrom = null;
      },
    }, { planeY: BASE_Y });
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 盤面の変化をランタイムへ同期する（円盤メッシュの生成/移動予約）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt || !rt.stage) return;
    const scene = rt.stage.scene;
    const seen = new Set<number>();
    pegs.forEach((stack, peg) => {
      stack.forEach((disk, index) => {
        seen.add(disk);
        let d = rt.disks.get(disk);
        if (!d) {
          const mesh = createRingDisc(diskRadius(disk, diskCount), DISK_H - 0.03, DISK_COLORS[disk - 1] ?? 0x697177);
          mesh.position.set(PEG_X[peg], BASE_Y + index * DISK_H + DISK_H / 2, 0);
          scene.add(mesh);
          d = { mesh, peg, index, phase: "rest", targetPeg: peg, targetIndex: index };
          rt.disks.set(disk, d);
        }
        if (d.targetPeg !== peg || d.targetIndex !== index) {
          d.targetPeg = peg;
          d.targetIndex = index;
          if (d.phase === "rest") d.phase = "lift";
        }
      });
    });
    // 枚数変更などで消えた円盤を除去する。
    for (const [disk, d] of [...rt.disks.entries()]) {
      if (!seen.has(disk)) {
        scene.remove(d.mesh);
        d.mesh.geometry.dispose();
        (d.mesh.material as THREE.Material).dispose();
        rt.disks.delete(disk);
      }
    }
  }, [pegs, diskCount]);

  // 置けない柱のシェイク。
  useEffect(() => {
    if (wrongPeg === null) return;
    shakeRef.current = { peg: wrongPeg, until: performance.now() + 350 };
  }, [wrongPeg]);

  return (
    <SceneBox
      height={300}
      label="ハノイの塔（3D）。柱をタップ、または円盤を隣の柱へドラッグします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#f3ead3"
      radius={12}
    />
  );
}
