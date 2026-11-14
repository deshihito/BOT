"use client";
// あかりの 3D 盤。マスの造形:
//   電球マス = 台座＋発光する球（emissive を脈動させる。ライツアウトの
//     発光表現と同じ考え方）
//   照らされたマス = 明るい面色（emissive 寄り）
//   暗いマス = 薄い平板
//   壁マス = 黒いブロック／数字つき壁は上面テクスチャで数字を大きく
//   数字と合わない壁は赤、照らし合う電球は赤枠で示す（現行 2D と同じ情報）
// 光の届く範囲（lit）は親が lib/akari.ts の evaluateAkari で計算した結果を
// そのまま受け取り、3D 側で光伝播を再計算しない。
// 入力は現行クライアントの操作語彙どおり:
//   タップ = onCell（電球の設置／取り外しは lib の toggleBulb と親が決める）
// 状態表示（照らしたマス数・時間など）は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture, createPeg } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

interface Props {
  rows: number;
  cols: number;
  walls: number[];
  numbers: Record<number, number>;
  bulbs: number[];
  /** 親が evaluateAkari で計算した照光マスク（index 順）。 */
  lit: boolean[];
  conflictBulbs: number[];
  badWalls: number[];
  status: "playing" | "won";
  /** タップ（現行の handleCell へ接続）。 */
  onCell: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;

function cellPos(index: number, cols: number, rows: number): [number, number] {
  const r = Math.floor(index / cols);
  const c = index % cols;
  return [(c - (cols - 1) / 2) * PITCH, (r - (rows - 1) / 2) * PITCH];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, cols: number, rows: number) {
  const w = container.clientWidth || 460;
  const h = container.clientHeight || 440;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (cols / 2 + 0.9) / Math.tan(hFov / 2);
  const distD = ((rows / 2 + 0.9) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.4;
  stage.setCamera({
    position: [0, dist * 0.82, dist * 0.58],
    lookAt: [0, 0, 0.2],
    fov: 42,
  });
}

/** 数字つき壁ブロック（上面いっぱいの大きな白数字）。 */
function createNumberedWall(value: number, bad: boolean): THREE.Mesh {
  const bg = bad ? "#b03a2e" : "#26221f";
  const topTex = canvasTexture(`akari-wall-${value}-${bad ? "bad" : "ok"}`, 128, 128, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#ffffff";
    g.font = "bold 84px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(value), 64, 68);
  });
  const side = new THREE.MeshStandardMaterial({ color: bad ? 0xb03a2e : 0x26221f, roughness: 0.7 });
  const top = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.65 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.6, 0.92), [side, side, top, side, side, side]);
  mesh.position.y = 0.3;
  return mesh;
}

/** 電球の造形（台座＋発光球）。戻り値の lampMat を脈動させる。 */
function createBulb(): { grp: THREE.Group; lampMat: THREE.MeshStandardMaterial } {
  const grp = new THREE.Group();
  const base = createPeg(0.3, 0.14, 0x8a7f6d);
  base.position.y = 0.07;
  grp.add(base);
  const lampMat = new THREE.MeshStandardMaterial({
    color: 0xffe082,
    roughness: 0.25,
    emissive: 0xffb300,
    emissiveIntensity: 0.95,
  });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.27, 22, 16), lampMat);
  lamp.position.y = 0.42;
  grp.add(lamp);
  return { grp, lampMat };
}

interface CellRt {
  sig: string;
  grp: THREE.Group;
  lampMat: THREE.MeshStandardMaterial | null;
}

interface SceneRt {
  stage: Stage;
  tilesGroup: THREE.Group;
  hits: THREE.Mesh[];
  hitDims: string;
  cellsRt: Map<number, CellRt>;
}

export default function AkariScene3D({
  rows, cols, walls, numbers, bulbs, lit, conflictBulbs, badWalls, status, onCell, onFail, fallback,
}: Props) {
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
      background: 0x201d1a,
      camera: { position: [0, 8, 5.6], lookAt: [0, 0, 0.2], fov: 42 },
      onFrame: (_dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        // 電球の発光をゆっくり脈動させる（点灯感の演出のみ、判定には使わない）。
        const pulse = 0.85 + 0.3 * Math.sin(t * 3);
        for (const c of rt.cellsRt.values()) {
          if (c.lampMat) c.lampMat.emissiveIntensity = pulse;
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    const tilesGroup = new THREE.Group();
    scene.add(tilesGroup);
    rtRef.current = { stage, tilesGroup, hits: [], hitDims: "", cellsRt: new Map() };

    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (id) propsRef.current.onCell(Number(id.slice(5)));
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

  // 盤面同期: 寸法が変わったら土台と当たり判定を作り直し、マスは差分だけ作り直す。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, tilesGroup } = rt;
    const dims = `${rows}x${cols}`;
    if (rt.hitDims !== dims) {
      rt.hitDims = dims;
      for (const child of [...tilesGroup.children]) {
        if (child.userData.isBase) tilesGroup.remove(child);
      }
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(cols * PITCH + 0.35, 0.3, rows * PITCH + 0.35),
        new THREE.MeshStandardMaterial({ color: 0x4c463f, roughness: 0.85 }),
      );
      base.position.y = -0.16;
      base.userData.isBase = true;
      tilesGroup.add(base);
      for (const [, c] of rt.cellsRt) tilesGroup.remove(c.grp);
      rt.cellsRt.clear();
      for (const h of rt.hits) tilesGroup.remove(h);
      rt.hits = [];
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
      for (let i = 0; i < rows * cols; i++) {
        const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        const [x, z] = cellPos(i, cols, rows);
        h.position.set(x, 0.3, z);
        h.userData.pickId = `cell-${i}`;
        tilesGroup.add(h);
        rt.hits.push(h);
      }
      const container = containerRef.current;
      if (container) fitCamera(stage, container, cols, rows);
    }

    const wallSet = new Set(walls);
    const bulbSet = new Set(bulbs);
    const conflictSet = new Set(conflictBulbs);
    const badWallSet = new Set(badWalls);
    for (let i = 0; i < rows * cols; i++) {
      const isWall = wallSet.has(i);
      const num = numbers[i];
      const hasBulb = bulbSet.has(i);
      const isLit = lit[i] ?? false;
      const conflict = conflictSet.has(i);
      const badWall = badWallSet.has(i);
      const sig = `${isWall ? 1 : 0}|${num ?? "-"}|${hasBulb ? 1 : 0}|${isLit ? 1 : 0}|${conflict ? 1 : 0}|${badWall ? 1 : 0}|${status}`;
      const cur = rt.cellsRt.get(i);
      if (cur && cur.sig === sig) continue;
      if (cur) tilesGroup.remove(cur.grp);
      const grp = new THREE.Group();
      const [x, z] = cellPos(i, cols, rows);
      grp.position.set(x, 0, z);
      let lampMat: THREE.MeshStandardMaterial | null = null;
      if (isWall) {
        if (num !== undefined) {
          grp.add(createNumberedWall(num, badWall));
        } else {
          const block = new THREE.Mesh(
            new THREE.BoxGeometry(0.92, 0.6, 0.92),
            new THREE.MeshStandardMaterial({ color: badWall ? 0xb03a2e : 0x26221f, roughness: 0.7 }),
          );
          block.position.y = 0.3;
          grp.add(block);
        }
      } else {
        // 白マス: 照らされている面は emissive 寄りの明色、電球マスはさらに明るく。
        const tileMat = new THREE.MeshStandardMaterial({
          color: conflict ? 0xf7e3e0 : hasBulb ? 0xffe9a8 : isLit ? 0xfff6cf : 0xe9e6df,
          roughness: 0.65,
          emissive: hasBulb ? 0xffca28 : isLit ? 0xffecb3 : 0x000000,
          emissiveIntensity: hasBulb ? 0.5 : isLit ? 0.28 : 0,
        });
        const tile = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.16, 0.92), tileMat);
        tile.position.y = 0.08;
        grp.add(tile);
        if (hasBulb) {
          const bulb = createBulb();
          lampMat = bulb.lampMat;
          grp.add(bulb.grp);
        }
        if (conflict) {
          const frame = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(0.99, 0.3, 0.99)),
            new THREE.LineBasicMaterial({ color: 0xb03a2e }),
          );
          frame.position.y = 0.15;
          grp.add(frame);
        }
      }
      tilesGroup.add(grp);
      rt.cellsRt.set(i, { sig, grp, lampMat });
    }
  }, [rows, cols, walls, numbers, bulbs, lit, conflictBulbs, badWalls, status]);

  return (
    <SceneBox
      height={440}
      label="あかりの盤（3D）。白マスをタップして電球を置いたり外したりします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#201d1a"
    />
  );
}
