"use client";
// ウォーターソートの 3D シーン。試験管を半透明の円柱（ガラス）＋色円柱の
// 層（液体）で立体化する。状態・注ぎ可否は lib/watersort.ts とクライアント
// の既存 onBottle が持ち、ここは表現と入力の橋渡しだけ:
//   管のタップ = 既存 onBottle（選択→注ぐ の2タップフローそのまま）
// 注ぎが起きたことは状態差分（どの管が減り、どの管が増えたか）で検出し、
// 注ぎ元の管が注ぎ先の上へ移動して傾く＋液体の粒が弧を描くアニメーションで
// 表現する（状態遷移そのものは lib の結果に完全一致させる）。
// 液体の色は色材質で表す。手数・ベストは親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { WsState } from "@/lib/watersort";

interface Props {
  state: WsState;
  selected: number | null;
  onBottle: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

/** クライアントの LIQUID_COLORS と同じ色（色材質として使う）。 */
const LIQUID = [0xe2534a, 0x3366cc, 0x3f9e4d, 0xf2c230, 0x8a55c7, 0xef7d1a, 0x2bb3a3];
const TUBE_H = 1.5;
const LAYER_H = 0.33;

function bottleX(i: number, n: number): number {
  return (i - (n - 1) / 2) * 1.02;
}

function findPickId(obj: THREE.Object3D | null): string | null {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    const id = cur.userData.pickId as string | undefined;
    if (id) return id;
    cur = cur.parent;
  }
  return null;
}

interface PourAnim {
  start: number;
  dur: number;
  from: number;
  to: number;
  color: number;
}

interface SceneRt {
  tubesGroup: THREE.Group;
  tubeGroups: THREE.Group[];
  liquidGroups: THREE.Group[];
  droplet: THREE.Mesh;
  pour: PourAnim | null;
}

export default function WaterSortScene3D({ state, selected, onBottle, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const prevBottlesRef = useRef<number[][] | null>(null);
  const propsRef = useRef({ onBottle });
  propsRef.current = { onBottle };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;
  const bottleCount = state.bottles.length;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x1d2733,
      camera: { position: [0, 2.9, 6.6], lookAt: [0, 0.75, 0], fov: 42 },
      onFrame: () => {
        const rt = rtRef.current;
        if (!rt) return;
        const pour = rt.pour;
        if (!pour) {
          rt.droplet.visible = false;
          return;
        }
        const n = rt.tubeGroups.length;
        const src = rt.tubeGroups[pour.from];
        const dst = rt.tubeGroups[pour.to];
        if (!src || !dst) {
          rt.pour = null;
          return;
        }
        const k = Math.min(1, Math.max(0, (performance.now() - pour.start) / pour.dur));
        const lift = Math.sin(k * Math.PI);
        const fromX = bottleX(pour.from, n);
        const toX = bottleX(pour.to, n);
        const dir = Math.sign(toX - fromX) || 1;
        // 注ぎ元: 注ぎ先の横上へ移動して傾く
        src.position.set(fromX + (toX - fromX) * lift * 0.72, 0.28 + lift * 1.15, 0);
        src.rotation.z = -dir * lift * 1.9;
        // 液体の粒: 弧を描いて注ぎ先の口へ
        const t = k;
        const px = fromX + (toX - fromX) * (0.72 * lift) + dir * 0.35 * lift + (toX - (fromX + (toX - fromX) * 0.72 + dir * 0.35)) * t * lift;
        const py = 1.55 + lift * 1.15 - Math.pow(t, 2) * 0.5;
        rt.droplet.visible = k > 0.25 && k < 0.95;
        rt.droplet.position.set(px, Math.max(1.35, py), 0);
        (rt.droplet.material as THREE.MeshStandardMaterial).color.setHex(pour.color);
        if (k >= 1) {
          src.position.set(fromX, 0, 0);
          src.rotation.z = 0;
          rt.droplet.visible = false;
          rt.pour = null;
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    const table = new THREE.Mesh(
      new THREE.BoxGeometry(8.4, 0.18, 2.6),
      new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 0.8 }),
    );
    table.position.y = -0.1;
    scene.add(table);

    const tubesGroup = new THREE.Group();
    scene.add(tubesGroup);
    const tubeGroups: THREE.Group[] = [];
    const liquidGroups: THREE.Group[] = [];
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0xdfeaf2, transparent: true, opacity: 0.28, roughness: 0.12, metalness: 0.05,
      side: THREE.DoubleSide, depthWrite: false,
    });
    for (let i = 0; i < bottleCount; i++) {
      const grp = new THREE.Group();
      grp.position.set(bottleX(i, bottleCount), 0, 0);
      grp.userData.pickId = `bottle-${i}`;
      const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.26, TUBE_H, 20, 1, true), glassMat);
      glass.position.y = TUBE_H / 2 + 0.04;
      glass.userData.pickId = `bottle-${i}`;
      grp.add(glass);
      const bottom = new THREE.Mesh(
        new THREE.SphereGeometry(0.26, 20, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
        glassMat,
      );
      bottom.position.y = 0.04;
      bottom.userData.pickId = `bottle-${i}`;
      grp.add(bottom);
      const rimRing = new THREE.Mesh(new THREE.TorusGeometry(0.31, 0.02, 8, 24), glassMat);
      rimRing.rotation.x = Math.PI / 2;
      rimRing.position.y = TUBE_H + 0.04;
      rimRing.userData.pickId = `bottle-${i}`;
      grp.add(rimRing);
      const liquids = new THREE.Group();
      liquids.userData.pickId = `bottle-${i}`;
      grp.add(liquids);
      liquidGroups.push(liquids);
      tubesGroup.add(grp);
      tubeGroups.push(grp);
    }
    const droplet = new THREE.Mesh(
      new THREE.SphereGeometry(0.085, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }),
    );
    droplet.visible = false;
    scene.add(droplet);

    rtRef.current = { tubesGroup, tubeGroups, liquidGroups, droplet, pour: null };

    detach = attachPickPointer(
      stage,
      () => [tubesGroup],
      {
        onTap: (hit) => {
          const id = findPickId(hit?.object ?? null);
          if (!id || !id.startsWith("bottle-")) return;
          propsRef.current.onBottle(Number(id.slice("bottle-".length)));
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
  }, [bottleCount]);

  // 液体層の差分同期＋注ぎアニメーションの検出。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const prev = prevBottlesRef.current;
    if (prev) {
      let from = -1;
      let to = -1;
      for (let i = 0; i < state.bottles.length; i++) {
        if (state.bottles[i].length < (prev[i]?.length ?? 0)) from = i;
        if (state.bottles[i].length > (prev[i]?.length ?? 0)) to = i;
      }
      if (from >= 0 && to >= 0 && state.bottles[to].length > 0) {
        const colorIdx = state.bottles[to][state.bottles[to].length - 1];
        rt.pour = { start: performance.now(), dur: 620, from, to, color: LIQUID[colorIdx] ?? 0xffffff };
      }
    }
    prevBottlesRef.current = state.bottles.map((b) => [...b]);

    state.bottles.forEach((bottle, i) => {
      const liquids = rt.liquidGroups[i];
      if (!liquids) return;
      for (const child of [...liquids.children]) {
        liquids.remove(child);
        (child as THREE.Mesh).geometry?.dispose();
      }
      bottle.forEach((colorIdx, j) => {
        const layer = new THREE.Mesh(
          new THREE.CylinderGeometry(0.255, 0.24, LAYER_H - 0.015, 18),
          new THREE.MeshStandardMaterial({ color: LIQUID[colorIdx] ?? 0xcccccc, roughness: 0.35 }),
        );
        layer.position.y = 0.1 + j * LAYER_H + LAYER_H / 2;
        layer.userData.pickId = `bottle-${i}`;
        liquids.add(layer);
      });
      const grp = rt.tubeGroups[i];
      if (grp && !rt.pour) {
        grp.position.y = selected === i ? 0.28 : 0;
        grp.position.x = bottleX(i, state.bottles.length);
      }
    });
  }, [state, selected]);

  return (
    <SceneBox
      height={380}
      label="ウォーターソート（3D）。試験管をタップして選び、注ぎ先の試験管をタップします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#1d2733"
    />
  );
}
