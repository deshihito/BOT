"use client";
// ビルディング（Skyscrapers）の 3D 盤。ビルの高さ（1〜N）をそのまま
// ブロックの高さ比で表し、上面には高さの数字を大きく描く。
// 外周ヒントは盤の外周に置いた小プレートの上面テクスチャで大きく表示する
// （現行 2D では盤グリッド内の DOM が担っていた表示を 3D 側で引き継ぐ。
//   隠したヒント 0 は現行どおりプレートだけ置いて数字を描かない）。
// 本作に given（初期配置）は無く、盤上のビルはすべてプレイヤー入力のため
// 色の区別は付けない。代わりに選択中マスはリング＋面色、違反マスは赤面で示す。
// 操作は現行どおり「マスをタップして選択」で、選択は親の onSelect へ渡し、
// 高さの入力は親の DOM 数字パッド（inputValue → setSkyValue）が担う。
// ルール検証・完成判定は lib/skyscrapers.ts と親が決め、ここは表現と
// 入力の橋渡しだけを行う。状態は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { SkyClues } from "@/lib/skyscrapers";

interface Props {
  size: number;
  /** 現在の盤面（0 = 空き、1〜N = 高さ）。 */
  values: number[];
  clues: SkyClues;
  selected: number | null;
  /** ルール違反マス（親が skyViolations から算出）。 */
  badCells: number[];
  /** マスの選択（現行のセルタップハンドラ）。 */
  onSelect: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;
/** 高さごとのビル色（低いほど明るく、高いほど濃い青）。 */
const BUILDING_COLORS = ["#7fb6d9", "#5b9bd5", "#3f7fbf", "#2f5f9f", "#234a7d"];

function cellPos(index: number, size: number): [number, number] {
  const r = Math.floor(index / size);
  const c = index % size;
  return [(c - (size - 1) / 2) * PITCH, (r - (size - 1) / 2) * PITCH];
}

/** 盤＋外周ヒントが収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, size: number) {
  const extent = size + 2.4;
  const w = container.clientWidth || 640;
  const h = container.clientHeight || 420;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (extent / 2 + 0.9) / Math.tan(hFov / 2);
  const distD = ((extent / 2 + 0.9) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.4;
  stage.setCamera({
    position: [0, dist * 0.82, dist * 0.58],
    lookAt: [0, 0, 0.2],
    fov: 42,
  });
}

/** 高さ value のビル（上面いっぱいに数字を大きく描く）。 */
function createBuilding(value: number): THREE.Mesh {
  const bg = BUILDING_COLORS[(value - 1) % BUILDING_COLORS.length];
  const height = value * 0.3;
  const topTex = canvasTexture(`sky-top-${value}`, 128, 128, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#ffffff";
    g.font = "bold 84px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(value), 64, 68);
  });
  const side = new THREE.MeshStandardMaterial({
    color: new THREE.Color(bg).multiplyScalar(0.78),
    roughness: 0.55,
  });
  const top = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.5 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.72, height, 0.72), [side, side, top, side, side, side]);
  mesh.position.y = 0.1 + height / 2;
  return mesh;
}

/** 外周ヒントのプレート（数字は上面いっぱいに大きく描く）。 */
function createCluePlate(clue: number): THREE.Mesh {
  const bg = "#e8e4d8";
  const topTex = canvasTexture(`sky-clue-${clue}`, 128, 128, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#4a4a42";
    g.font = "bold 84px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(clue), 64, 68);
  });
  const side = new THREE.MeshStandardMaterial({ color: 0xb8b2a2, roughness: 0.7 });
  const top = new THREE.MeshStandardMaterial({
    map: clue > 0 ? topTex : undefined,
    color: clue > 0 ? 0xffffff : 0xd9d5c9,
    roughness: 0.65,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.08, 0.8), [side, side, top, side, side, side]);
  mesh.position.y = 0.04;
  return mesh;
}

interface CellRt {
  sig: string;
  grp: THREE.Group;
}

interface SceneRt {
  stage: Stage;
  group: THREE.Group;
  hits: THREE.Mesh[];
  hitKey: string;
  cellsRt: Map<number, CellRt>;
  selRing: THREE.Mesh;
}

export default function SkyscrapersScene3D({
  size, values, clues, selected, badCells, onSelect, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onSelect });
  propsRef.current = { onSelect };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x3c4653,
      camera: { position: [0, 9, 6.5], lookAt: [0, 0, 0.2], fov: 42 },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const group = new THREE.Group();
    stage.scene.add(group);
    const selRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.5, 0.045, 10, 32),
      new THREE.MeshBasicMaterial({ color: 0xf59e0b }),
    );
    selRing.rotation.x = Math.PI / 2;
    selRing.position.y = 0.12;
    selRing.visible = false;
    group.add(selRing);
    rtRef.current = { stage, group, hits: [], hitKey: "", cellsRt: new Map(), selRing };
    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (!id) return;
        propsRef.current.onSelect(Number(id.slice(5)));
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

  // 盤面同期: サイズ/ヒントが変わったら土台・ヒントプレート・当たり判定を
  // 作り直し、マスは差分だけ作り直す。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, group } = rt;
    const clueKey = `${size}|${clues.top.join(",")}|${clues.bottom.join(",")}|${clues.left.join(",")}|${clues.right.join(",")}`;
    if (rt.hitKey !== clueKey) {
      rt.hitKey = clueKey;
      for (const child of [...group.children]) {
        if (child.userData.isBase) group.remove(child);
      }
      const baseGrp = new THREE.Group();
      baseGrp.userData.isBase = true;
      const extent = size + 2.4;
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(extent, 0.3, extent),
        new THREE.MeshStandardMaterial({ color: 0x6b7a6e, roughness: 0.85 }),
      );
      base.position.y = -0.16;
      baseGrp.add(base);
      const off = size / 2 + 0.62;
      for (let i = 0; i < size; i++) {
        const x = (i - (size - 1) / 2) * PITCH;
        const spots: [number, number, number][] = [
          [x, -off, clues.top[i]],
          [x, off, clues.bottom[i]],
          [-off, x, clues.left[i]],
          [off, x, clues.right[i]],
        ];
        for (const [px, pz, clue] of spots) {
          const plate = createCluePlate(clue);
          plate.position.x = px;
          plate.position.z = pz;
          baseGrp.add(plate);
        }
      }
      group.add(baseGrp);
      for (const [, c] of rt.cellsRt) group.remove(c.grp);
      rt.cellsRt.clear();
      for (const h of rt.hits) group.remove(h);
      rt.hits = [];
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 1.8, PITCH * 0.98);
      for (let i = 0; i < size * size; i++) {
        const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        const [x, z] = cellPos(i, size);
        h.position.set(x, 0.8, z);
        h.userData.pickId = `cell-${i}`;
        group.add(h);
        rt.hits.push(h);
      }
      const container = containerRef.current;
      if (container) fitCamera(stage, container, size);
    }

    const badSet = new Set(badCells);
    values.forEach((value, i) => {
      const isBad = badSet.has(i);
      const sig = `${value}|${isBad ? 1 : 0}`;
      const cur = rt.cellsRt.get(i);
      // 選択表示はリング側で追従するため、マスの署名には含めない。
      if (!(cur && cur.sig === sig)) {
        if (cur) group.remove(cur.grp);
        const grp = new THREE.Group();
        const [x, z] = cellPos(i, size);
        grp.position.set(x, 0, z);
        const plate = new THREE.Mesh(
          new THREE.BoxGeometry(0.92, 0.1, 0.92),
          new THREE.MeshStandardMaterial({
            color: isBad ? 0xf7e3e0 : 0xf4f2ec,
            roughness: 0.7,
          }),
        );
        plate.position.y = 0.05;
        grp.add(plate);
        if (value > 0) grp.add(createBuilding(value));
        group.add(grp);
        rt.cellsRt.set(i, { sig, grp });
      }
    });

    if (selected !== null && selected < size * size) {
      const [x, z] = cellPos(selected, size);
      const topY = 0.12 + (values[selected] ?? 0) * 0.3;
      rt.selRing.position.set(x, topY, z);
      rt.selRing.visible = true;
    } else {
      rt.selRing.visible = false;
    }
  }, [size, values, clues, selected, badCells]);

  return (
    <SceneBox
      height={460}
      label="ビルディングの盤（3D）。マスをタップして選び、数字パッドで高さを入れます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#3c4653"
    />
  );
}
