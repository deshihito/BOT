"use client";
// フラッドフィルの 3D 盤。マスは立体タイルで表す:
//   色面の色は現行 2D の COLOR_DEFS と一致させる（赤/オレンジ/黄/緑/青/紫）。
//   左上の領域（親が lib/floodit.ts の floodRegionIndices で求めた集合）は
//   タイルを一段高く＋発光寄りにして、塗り広がりを高さの差分で表現する。
//   144 マスあるためタイル本体は InstancedMesh で軽量化し、色と高さだけを
//   差分同期する（色が変わったマスは instanceColor、領域の出入りは目標高さ）。
// 入力は現行クライアントの操作語彙どおり:
//   色選択は DOM パレットが正（クライアント側に維持）で、盤タップは
//   そのマスの色を選ぶ操作として親の onCell → pickColor へ接続する
//   （塗り広げの判定は親＋lib が担い、ここでは再実装しない）。
// 状態表示（手数・ベスト等）は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

interface Props {
  cells: number[];
  size: number;
  /** 左上とつながった領域（親が floodRegionIndices で計算した集合）。 */
  region: Set<number>;
  /** 盤タップ（そのマスの色を選ぶ。現行の pickColor ハンドラへ接続）。 */
  onCell: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;
// 現行 2D（FloodItClient の COLOR_DEFS）と同じ色順・同じ色。
const COLOR_HEX = [0xef4444, 0xf59e0b, 0xeab308, 0x22c55e, 0x3b82f6, 0xa855f7];
const TILE_H = 0.24;
const REGION_H = 0.48;

function cellPos(index: number, size: number): [number, number] {
  const r = Math.floor(index / size);
  const c = index % size;
  return [(c - (size - 1) / 2) * PITCH, (r - (size - 1) / 2) * PITCH];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, size: number) {
  const w = container.clientWidth || 480;
  const h = container.clientHeight || 460;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (size / 2 + 0.9) / Math.tan(hFov / 2);
  const distD = ((size / 2 + 0.9) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.4;
  stage.setCamera({
    position: [0, dist * 0.84, dist * 0.56],
    lookAt: [0, 0, 0.2],
    fov: 42,
  });
}

interface SceneRt {
  stage: Stage;
  tilesGroup: THREE.Group;
  hits: THREE.Mesh[];
  inst: THREE.InstancedMesh | null;
  curH: Float32Array;
  tgtH: Float32Array;
  pos: Array<[number, number]>;
  builtSize: number;
  tmpM: THREE.Matrix4;
  tmpQ: THREE.Quaternion;
  tmpV: THREE.Vector3;
  tmpS: THREE.Vector3;
}

export default function FloodItScene3D({ cells, size, region, onCell, onFail, fallback }: Props) {
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
      background: 0x37312a,
      camera: { position: [0, 9, 6], lookAt: [0, 0, 0.2], fov: 42 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt || !rt.inst) return;
        // 領域の高さを目標へ補間し、塗り広がりを一段ずつ盛り上がらせる。
        const k = 1 - Math.exp(-dt * 10);
        let dirty = false;
        for (let i = 0; i < rt.tgtH.length; i++) {
          const diff = rt.tgtH[i] - rt.curH[i];
          if (Math.abs(diff) < 0.002) {
            if (rt.curH[i] !== rt.tgtH[i]) { rt.curH[i] = rt.tgtH[i]; dirty = true; }
            else continue;
          } else {
            rt.curH[i] += diff * k;
            dirty = true;
          }
          const [x, z] = rt.pos[i];
          const h = rt.curH[i];
          rt.tmpS.set(1, h, 1);
          rt.tmpV.set(x, h / 2, z);
          rt.tmpM.compose(rt.tmpV, rt.tmpQ, rt.tmpS);
          rt.inst.setMatrixAt(i, rt.tmpM);
        }
        if (dirty) rt.inst.instanceMatrix.needsUpdate = true;
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
    rtRef.current = {
      stage, tilesGroup, hits: [], inst: null,
      curH: new Float32Array(0), tgtH: new Float32Array(0), pos: [],
      builtSize: 0,
      tmpM: new THREE.Matrix4(), tmpQ: new THREE.Quaternion(),
      tmpV: new THREE.Vector3(), tmpS: new THREE.Vector3(1, 1, 1),
    };

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

  // 盤面同期: 土台・InstancedMesh・当たり判定は寸法が変わったときだけ作り、
  // 以後は色（instanceColor）と領域の高さ（目標値）だけを差分同期する。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, tilesGroup } = rt;
    if (rt.builtSize !== size) {
      rt.builtSize = size;
      for (const child of [...tilesGroup.children]) tilesGroup.remove(child);
      rt.hits = [];
      rt.pos = [];
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(size * PITCH + 0.35, 0.28, size * PITCH + 0.35),
        new THREE.MeshStandardMaterial({ color: 0x57493a, roughness: 0.9 }),
      );
      base.position.y = -0.15;
      tilesGroup.add(base);
      const inst = new THREE.InstancedMesh(
        new THREE.BoxGeometry(0.92, 1, 0.92),
        new THREE.MeshStandardMaterial({ roughness: 0.55 }),
        size * size,
      );
      tilesGroup.add(inst);
      rt.inst = inst;
      rt.curH = new Float32Array(size * size).fill(TILE_H);
      rt.tgtH = new Float32Array(size * size).fill(TILE_H);
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
      for (let i = 0; i < size * size; i++) {
        const [x, z] = cellPos(i, size);
        rt.pos.push([x, z]);
        const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        h.position.set(x, 0.3, z);
        h.userData.pickId = `cell-${i}`;
        tilesGroup.add(h);
        rt.hits.push(h);
        // 初期行列（高さは onFrame の補間が毎回書き直す）。
        rt.tmpS.set(1, TILE_H, 1);
        rt.tmpV.set(x, TILE_H / 2, z);
        rt.tmpM.compose(rt.tmpV, rt.tmpQ, rt.tmpS);
        inst.setMatrixAt(i, rt.tmpM);
      }
      inst.instanceMatrix.needsUpdate = true;
      const container = containerRef.current;
      if (container) fitCamera(stage, container, size);
    }

    const inst = rt.inst;
    if (!inst) return;
    const col = new THREE.Color();
    for (let i = 0; i < cells.length; i++) {
      inst.setColorAt(i, col.setHex(COLOR_HEX[cells[i]] ?? 0x888888));
      // 領域のマスは高く、それ以外は通常の高さ（差は onFrame が補間する）。
      rt.tgtH[i] = region.has(i) ? REGION_H : TILE_H;
    }
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  }, [cells, size, region]);

  return (
    <SceneBox
      height={460}
      label="フラッドフィルの盤（3D）。マスをタップするとその色で領域が広がります。色の選択は下のパレットでもできます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#37312a"
    />
  );
}
