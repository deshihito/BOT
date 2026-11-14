"use client";
// 橋をかけろの 3D 盤。島 = 数字を上面に大きく描いた円柱、橋 = 島間に架かる
// 直方体（現行 2D の二重線表現に合わせ、2本のときは並行2本のバーで表す）。
// 操作は現行どおり「島と島の間のマスをタップ」で、タップしたセル index を
// 親の onBridgeCellTap（hashiTapEdge → cycleHashiBridge）へそのまま渡す。
// 島タップやドラッグで橋を引く操作は現行に無いため、3D でも追加しない。
// 橋の本数・交差可否・完成判定はすべて lib/hashi.ts と親ハンドラが決め、
// ここは表現と入力の橋渡しだけを行う。状態（秒数・ベスト・違反表示）は
// 親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import {
  hashiBridgeCount,
  hashiCandidateEdges,
  type HashiState,
} from "@/lib/hashi";

interface Props {
  state: HashiState;
  /** 各島から出ている橋の総数（島 id 順、親が hashiDegrees で算出）。 */
  degrees: number[];
  /** チェック表示で違反になった島 id（親が hashiViolations から算出）。 */
  badIslandIds: number[];
  /** 橋マスのタップ（現行の onBridgeCellTap）。 */
  onBridgeCell: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;

function cellPos(index: number, size: number): [number, number] {
  const r = Math.floor(index / size);
  const c = index % size;
  return [(c - (size - 1) / 2) * PITCH, (r - (size - 1) / 2) * PITCH];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, size: number) {
  const w = container.clientWidth || 640;
  const h = container.clientHeight || 420;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (size / 2 + 0.9) / Math.tan(hFov / 2);
  const distD = ((size / 2 + 0.9) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.4;
  stage.setCamera({
    position: [0, dist * 0.82, dist * 0.58],
    lookAt: [0, 0, 0.2],
    fov: 42,
  });
}

const ISLAND_TONES = {
  normal: { bg: "#ffffff", side: 0xb9c2c7, fg: "#222222" },
  done: { bg: "#dff3e4", side: 0x8fce9f, fg: "#222222" },
  bad: { bg: "#fbe3e0", side: 0xd98a80, fg: "#c0392b" },
} as const;

/** 島の円柱（上面いっぱいに必要本数の数字を大きく描く）。 */
function createIsland(need: number, tone: keyof typeof ISLAND_TONES): THREE.Group {
  const t = ISLAND_TONES[tone];
  const topTex = canvasTexture(`hashi-island-${need}-${tone}`, 128, 128, (g) => {
    g.fillStyle = t.bg;
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = t.fg;
    g.font = "bold 84px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(need), 64, 68);
  });
  const side = new THREE.MeshStandardMaterial({ color: t.side, roughness: 0.6 });
  const top = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.55 });
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.44, 0.34, 28), [side, top, side]);
  cyl.position.y = 0.17;
  const grp = new THREE.Group();
  grp.add(cyl);
  return grp;
}

interface SceneRt {
  stage: Stage;
  group: THREE.Group;
  hits: THREE.Mesh[];
  hitKey: string;
  islandsRt: Map<number, { sig: string; grp: THREE.Group }>;
  bridgesSig: string;
  bridgesGrp: THREE.Group | null;
}

export default function HashiScene3D({ state, degrees, badIslandIds, onBridgeCell, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onBridgeCell });
  propsRef.current = { onBridgeCell };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x39525a,
      camera: { position: [0, 9, 6.5], lookAt: [0, 0, 0.2], fov: 42 },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const group = new THREE.Group();
    stage.scene.add(group);
    rtRef.current = {
      stage,
      group,
      hits: [],
      hitKey: "",
      islandsRt: new Map(),
      bridgesSig: "",
      bridgesGrp: null,
    };
    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (!id) return;
        propsRef.current.onBridgeCell(Number(id.slice(5)));
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

  // 盤面同期: 島配置が変わったら土台と当たり判定を作り直し、島は差分だけ、
  // 橋は橋マップの署名が変わったときだけ作り直す。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, group } = rt;
    const size = state.size;
    const edges = hashiCandidateEdges(state);
    const layoutKey = `${size}|${state.islands.map((i) => i.index).join(",")}`;
    if (rt.hitKey !== layoutKey) {
      rt.hitKey = layoutKey;
      for (const child of [...group.children]) {
        if (child.userData.isBase) group.remove(child);
      }
      const baseGrp = new THREE.Group();
      baseGrp.userData.isBase = true;
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(size * PITCH + 0.35, 0.3, size * PITCH + 0.35),
        new THREE.MeshStandardMaterial({ color: 0x7d9291, roughness: 0.85 }),
      );
      base.position.y = -0.16;
      baseGrp.add(base);
      const tileGeo = new THREE.BoxGeometry(0.94, 0.06, 0.94);
      const tileMat = new THREE.MeshStandardMaterial({ color: 0xe9efec, roughness: 0.8 });
      for (let i = 0; i < size * size; i++) {
        const tile = new THREE.Mesh(tileGeo, tileMat);
        const [x, z] = cellPos(i, size);
        tile.position.set(x, 0.03, z);
        baseGrp.add(tile);
      }
      group.add(baseGrp);
      for (const [, c] of rt.islandsRt) group.remove(c.grp);
      rt.islandsRt.clear();
      if (rt.bridgesGrp) {
        group.remove(rt.bridgesGrp);
        rt.bridgesGrp = null;
        rt.bridgesSig = "";
      }
      for (const h of rt.hits) group.remove(h);
      rt.hits = [];
      // 当たり判定は現行 2D と同じく「候補辺が通るセル」だけに付ける。
      const tappable = new Set<number>();
      for (const e of edges) for (const cell of e.cells) tappable.add(cell);
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
      for (const index of tappable) {
        const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        const [x, z] = cellPos(index, size);
        h.position.set(x, 0.3, z);
        h.userData.pickId = `cell-${index}`;
        group.add(h);
        rt.hits.push(h);
      }
      const container = containerRef.current;
      if (container) fitCamera(stage, container, size);
    }

    const badSet = new Set(badIslandIds);
    state.islands.forEach((island) => {
      const deg = degrees[island.id] ?? 0;
      const tone: keyof typeof ISLAND_TONES =
        badSet.has(island.id) || deg > island.need ? "bad" : deg === island.need ? "done" : "normal";
      const sig = `${island.index}|${island.need}|${tone}`;
      const cur = rt.islandsRt.get(island.id);
      if (cur && cur.sig === sig) return;
      if (cur) group.remove(cur.grp);
      const grp = createIsland(island.need, tone);
      const [x, z] = cellPos(island.index, size);
      grp.position.set(x, 0, z);
      group.add(grp);
      rt.islandsRt.set(island.id, { sig, grp });
    });

    const bridgesSig = `${layoutKey}|${JSON.stringify(state.bridges)}`;
    if (rt.bridgesSig !== bridgesSig) {
      rt.bridgesSig = bridgesSig;
      if (rt.bridgesGrp) group.remove(rt.bridgesGrp);
      const grp = new THREE.Group();
      const barMat = new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 0.55 });
      const hintMat = new THREE.MeshStandardMaterial({ color: 0xc3cfca, roughness: 0.8 });
      const bridgedCells = new Set<number>();
      for (const edge of edges) {
        const count = hashiBridgeCount(state, edge.a, edge.b);
        if (count <= 0) continue;
        for (const cell of edge.cells) bridgedCells.add(cell);
        const a = state.islands[edge.a];
        const b = state.islands[edge.b];
        if (!a || !b) continue;
        const [ax, az] = cellPos(a.index, size);
        const [bx, bz] = cellPos(b.index, size);
        const len = Math.hypot(bx - ax, bz - az);
        // 現行 2D の表現に合わせる: 1本 = 中央の1本、2本 = 並行2本。
        const offsets = count === 2 ? [-0.13, 0.13] : [0];
        for (const off of offsets) {
          const bar =
            edge.orientation === "h"
              ? new THREE.Mesh(new THREE.BoxGeometry(len, 0.13, 0.13), barMat)
              : new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, len), barMat);
          bar.position.set(
            (ax + bx) / 2 + (edge.orientation === "v" ? off : 0),
            0.2,
            (az + bz) / 2 + (edge.orientation === "h" ? off : 0),
          );
          grp.add(bar);
        }
      }
      // 橋が架けられる空きセルには薄い目印を置き、タップ先が分かるようにする。
      const hintGeo = new THREE.BoxGeometry(0.5, 0.04, 0.5);
      const tappable = new Set<number>();
      for (const e of edges) for (const cell of e.cells) tappable.add(cell);
      for (const index of tappable) {
        if (bridgedCells.has(index)) continue;
        const hint = new THREE.Mesh(hintGeo, hintMat);
        const [x, z] = cellPos(index, size);
        hint.position.set(x, 0.08, z);
        grp.add(hint);
      }
      group.add(grp);
      rt.bridgesGrp = grp;
    }
  }, [state, degrees, badIslandIds]);

  return (
    <SceneBox
      height={460}
      label="橋をかけろの盤（3D）。島と島の間のマスをタップして橋をかけます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#39525a"
    />
  );
}
