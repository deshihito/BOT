"use client";
// ぬりかべの 3D 盤。マスの造形:
//   海マス = 沈んだ濃色タイル / 島マス = 白い盛り上がりタイル /
//   未定 = 薄いグレーの平板 / 数字マス（島の固定セル）= 黄色いタイル＋
//   上面テクスチャに大きな数字。
// ルール違反マスは赤い縁取りの枠で示す（現行 2D の赤枠と同じ情報）。
// 入力は現行クライアントの操作語彙どおり:
//   タップ = onCell（未定→海→島→未定の循環は lib/nurikabe.ts と親が決める）
//   下スワイプ = onCheck（現行の盤面ジェスチャと同じ。ドラッグ終了時の
//     フリック方向で判定し、チェック自体は親の onCheck が行う）
// 状態表示（時間・ベスト・違反メッセージ）は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { NurikabeMark } from "@/lib/nurikabe";

interface Props {
  marks: NurikabeMark[];
  clues: (number | null)[];
  size: number;
  violationCells: number[];
  status: "playing" | "won";
  /** タップ（現行の onCell へ接続）。 */
  onCell: (index: number) => void;
  /** 下スワイプ＝チェック（現行の onCheck へ接続）。 */
  onCheck: () => void;
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
  const w = container.clientWidth || 460;
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

/** 数字つきタイル（上面いっぱいの大きな数字）。 */
function createClueTile(value: number): THREE.Mesh {
  const topTex = canvasTexture(`nk-clue-${value}`, 128, 128, (g) => {
    g.fillStyle = "#fef9c3";
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#111827";
    g.font = "bold 84px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(value), 64, 68);
  });
  const side = new THREE.MeshStandardMaterial({ color: 0xd9c98a, roughness: 0.65 });
  const top = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.6 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.34, 0.92), [side, side, top, side, side, side]);
  mesh.position.y = 0.17;
  return mesh;
}

/** 違反マスの赤い枠（タイルの上面の周囲に線を出す）。 */
function createBadFrame(): THREE.Group {
  const holder = new THREE.Group();
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(0.99, 0.06, 0.99)),
    new THREE.LineBasicMaterial({ color: 0xef4444 }),
  );
  edges.position.y = 0.3;
  holder.add(edges);
  return holder;
}

interface CellRt {
  sig: string;
  grp: THREE.Group;
}

interface SceneRt {
  stage: Stage;
  tilesGroup: THREE.Group;
  hits: THREE.Mesh[];
  hitSize: number;
  cellsRt: Map<number, CellRt>;
}

export default function NurikabeScene3D({
  marks, clues, size, violationCells, status, onCell, onCheck, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onCell, onCheck });
  propsRef.current = { onCell, onCheck };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x2e3a46,
      camera: { position: [0, 7.5, 5.2], lookAt: [0, 0, 0.2], fov: 42 },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    const tilesGroup = new THREE.Group();
    scene.add(tilesGroup);
    rtRef.current = { stage, tilesGroup, hits: [], hitSize: 0, cellsRt: new Map() };

    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (id) propsRef.current.onCell(Number(id.slice(5)));
      },
      // 下スワイプ＝チェック。マス上で始めたスワイプはドラッグ扱いになるため
      // onDragEnd のフリック方向で受け、素早いフリックは onFlick でも受ける。
      onDragEnd: (flick) => {
        if (flick.dir === "down") propsRef.current.onCheck();
      },
      onFlick: (flick) => {
        if (flick.dir === "down") propsRef.current.onCheck();
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

  // 盤面同期: サイズが変わったら土台と当たり判定を作り直し、マスは差分だけ作り直す。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, tilesGroup } = rt;
    if (rt.hitSize !== size) {
      rt.hitSize = size;
      for (const child of [...tilesGroup.children]) {
        if (child.userData.isBase) tilesGroup.remove(child);
      }
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(size * PITCH + 0.35, 0.3, size * PITCH + 0.35),
        new THREE.MeshStandardMaterial({ color: 0x54626e, roughness: 0.85 }),
      );
      base.position.y = -0.16;
      base.userData.isBase = true;
      tilesGroup.add(base);
      for (const [, c] of rt.cellsRt) tilesGroup.remove(c.grp);
      rt.cellsRt.clear();
      for (const h of rt.hits) tilesGroup.remove(h);
      rt.hits = [];
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
      for (let i = 0; i < size * size; i++) {
        const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        const [x, z] = cellPos(i, size);
        h.position.set(x, 0.3, z);
        h.userData.pickId = `cell-${i}`;
        tilesGroup.add(h);
        rt.hits.push(h);
      }
      const container = containerRef.current;
      if (container) fitCamera(stage, container, size);
    }

    const badSet = new Set(violationCells);
    marks.forEach((mark, i) => {
      const clue = clues[i];
      const bad = badSet.has(i);
      const sig = `${mark}|${clue ?? "-"}|${bad ? 1 : 0}|${status}`;
      const cur = rt.cellsRt.get(i);
      if (cur && cur.sig === sig) return;
      if (cur) tilesGroup.remove(cur.grp);
      const grp = new THREE.Group();
      const [x, z] = cellPos(i, size);
      grp.position.set(x, 0, z);
      if (clue !== null) {
        grp.add(createClueTile(clue));
      } else if (mark === 1) {
        // 海: 沈んだ濃色タイル。
        const tile = new THREE.Mesh(
          new THREE.BoxGeometry(0.92, 0.14, 0.92),
          new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.6 }),
        );
        tile.position.y = 0.07;
        grp.add(tile);
      } else if (mark === 2) {
        // 島: 白い盛り上がりタイル。
        const tile = new THREE.Mesh(
          new THREE.BoxGeometry(0.92, 0.42, 0.92),
          new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }),
        );
        tile.position.y = 0.21;
        grp.add(tile);
      } else {
        const tile = new THREE.Mesh(
          new THREE.BoxGeometry(0.92, 0.2, 0.92),
          new THREE.MeshStandardMaterial({ color: 0xf3f4f6, roughness: 0.7 }),
        );
        tile.position.y = 0.1;
        grp.add(tile);
      }
      if (bad) grp.add(createBadFrame());
      tilesGroup.add(grp);
      rt.cellsRt.set(i, { sig, grp });
    });
  }, [marks, clues, size, violationCells, status]);

  return (
    <SceneBox
      height={size === 5 ? 400 : 460}
      label="ぬりかべの盤（3D）。マスをタップで海・島・未定を切り替え、下にスワイプでチェックします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#2e3a46"
    />
  );
}
