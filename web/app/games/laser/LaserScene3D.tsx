"use client";
// レーザーミラーの 3D 盤。鏡は向き（ / と \ ）が造形で判別できるよう、
// 立てた鏡面プレートを斜めに置き、的は赤白の同心円盤、発射口は盤の
// 左端に置いた筒＋三角のノズルで表す（絵文字は使わない）。
// 光線は親が計算した光路（通過セルの列）を、セル中心をつなぐ赤い
// チューブ＋淡いグローで描くだけで、反射の計算はここでは一切しない。
// 終端の伸ばし方向も親が渡した endDir を描画に使うだけである。
// 入力は鏡のタップだけ: 親の回転ハンドラへそのまま渡す。
// 時間・回転数・状態テキストは親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { LaserDir, LaserState, LaserTrace } from "@/lib/laser";

interface Props {
  state: LaserState;
  /** 光路（親が lib で計算した結果。通過セル・的中・終端方向）。 */
  trace: LaserTrace;
  /** 鏡タップ（現行の回転ハンドラ）。 */
  onMirror: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;
const BEAM_Y = 0.38;
const BEAM_COLOR = 0xef4444;
// 終端方向 → 盤面ベクトル（描画の伸ばし専用）。
const DIR_VEC: Record<LaserDir, [number, number]> = {
  N: [0, -1],
  E: [1, 0],
  S: [0, 1],
  W: [-1, 0],
};

function cellPos(index: number, cols: number): [number, number] {
  const r = Math.floor(index / cols);
  const c = index % cols;
  return [(c - (cols - 1) / 2) * PITCH, (r - (cols - 1) / 2) * PITCH];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, size: number) {
  const w = container.clientWidth || 460;
  const h = container.clientHeight || 460;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (size / 2 + 1.3) / Math.tan(hFov / 2);
  const distD = ((size / 2 + 0.9) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.4;
  stage.setCamera({
    position: [0, dist * 0.82, dist * 0.58],
    lookAt: [-0.2, 0, 0.2],
    fov: 42,
  });
}

/** 2点間を結ぶ円柱セグメント（光線チューブ用）。 */
function createSegment(a: THREE.Vector3, b: THREE.Vector3, radius: number, mat: THREE.Material): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, Math.max(len, 0.01), 10), mat);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}

/** 鏡1枚。立てた鏡面プレートを / なら奥へ傾く斜め、 \ なら手前へ傾く斜めに置く。 */
function createMirror(kind: "/" | "\\"): THREE.Group {
  const grp = new THREE.Group();
  const stand = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.1, 0.34),
    new THREE.MeshStandardMaterial({ color: 0x4b4237, roughness: 0.7 }),
  );
  stand.position.y = 0.1;
  grp.add(stand);
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(0.92, 0.56, 0.06),
    new THREE.MeshStandardMaterial({ color: 0xbfdbfe, roughness: 0.12, metalness: 0.75 }),
  );
  plate.position.y = 0.4;
  // 盤面の斜め: "/" は右上がり（奥方向）、"\\" は右下がり（手前方向）。
  plate.rotation.y = kind === "/" ? Math.PI / 4 : -Math.PI / 4;
  grp.add(plate);
  // 上端の青バーはプレートの子にして、鏡面と同じ向きへ追従させる。
  const edge = new THREE.Mesh(
    new THREE.BoxGeometry(0.96, 0.06, 0.09),
    new THREE.MeshStandardMaterial({ color: 0x2563eb, roughness: 0.4 }),
  );
  edge.position.y = 0.3;
  plate.add(edge);
  return grp;
}

/** 的: 赤白赤の同心円盤を重ねる（現行 2D の同心円と同じ配色）。 */
function createTarget(hit: boolean): THREE.Group {
  const grp = new THREE.Group();
  const mk = (r: number, y: number, color: number, emissive = 0) => {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, 0.09, 28),
      new THREE.MeshStandardMaterial({
        color, roughness: 0.4,
        emissive: emissive ? BEAM_COLOR : 0x000000,
        emissiveIntensity: emissive ? 0.55 : 0,
      }),
    );
    m.position.y = y;
    grp.add(m);
  };
  mk(0.34, 0.16, 0xe53935, hit ? 1 : 0);
  mk(0.22, 0.22, 0xffffff);
  mk(0.11, 0.28, 0xe53935, hit ? 1 : 0);
  return grp;
}

interface SceneRt {
  stage: Stage;
  boardGroup: THREE.Group;
  hits: THREE.Mesh[];
  builtFor: string;
  mirrorGroup: THREE.Group | null;
  mirrorSig: string;
  beamGroup: THREE.Group | null;
  beamSig: string;
  targetGroup: THREE.Group | null;
  targetSig: string;
}

export default function LaserScene3D({ state, trace, onMirror, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onMirror });
  propsRef.current = { onMirror };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x3a352b,
      camera: { position: [0, 8.6, 6], lookAt: [-0.2, 0, 0.2], fov: 42 },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const boardGroup = new THREE.Group();
    stage.scene.add(boardGroup);
    rtRef.current = {
      stage, boardGroup, hits: [], builtFor: "",
      mirrorGroup: null, mirrorSig: "",
      beamGroup: null, beamSig: "",
      targetGroup: null, targetSig: "",
    };
    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (id) propsRef.current.onMirror(Number(id.slice(4)));
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

  // 土台・セル・発射口の同期（盤サイズが変わったときだけ作り直す）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const key = `${state.rows}x${state.cols}:${state.emitterRow}:${state.target}`;
    if (rt.builtFor === key) return;
    rt.builtFor = key;
    const { stage, boardGroup } = rt;
    for (const child of [...boardGroup.children]) {
      if (child.userData.isBase) boardGroup.remove(child);
    }
    const size = state.cols;
    const base = new THREE.Group();
    base.userData.isBase = true;
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(size * PITCH + 0.4, 0.3, size * PITCH + 0.4),
      new THREE.MeshStandardMaterial({ color: 0x8a7f63, roughness: 0.85 }),
    );
    slab.position.y = -0.15;
    base.add(slab);
    for (let i = 0; i < state.rows * state.cols; i++) {
      const [x, z] = cellPos(i, state.cols);
      const isTarget = i === state.target;
      const tile = new THREE.Mesh(
        new THREE.BoxGeometry(0.94, 0.1, 0.94),
        new THREE.MeshStandardMaterial({ color: isTarget ? 0xfef3c7 : 0xf7f3e8, roughness: 0.8 }),
      );
      tile.position.set(x, 0.05, z);
      base.add(tile);
    }
    // 発射口: 発射行の左端外に筒とノズルを置く。
    const [ex, ez] = cellPos(state.emitterRow * state.cols, state.cols);
    const emitter = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.5, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x4b4237, roughness: 0.6 }),
    );
    body.position.set(ex - PITCH * 0.85, 0.35, ez);
    emitter.add(body);
    const nozzle = new THREE.Mesh(
      new THREE.ConeGeometry(0.2, 0.4, 16),
      new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.35 }),
    );
    nozzle.rotation.z = -Math.PI / 2; // 尖端を盤面（+x）へ向ける
    nozzle.position.set(ex - PITCH * 0.42, 0.35, ez);
    emitter.add(nozzle);
    base.add(emitter);
    boardGroup.add(base);
    const container = containerRef.current;
    if (container) fitCamera(stage, container, size);
  }, [state]);

  // 鏡と当たり判定の同期（鏡の構成・向きが変わったときだけ作り直す）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const sig = JSON.stringify(state.mirrors);
    if (rt.mirrorSig === sig) return;
    rt.mirrorSig = sig;
    if (rt.mirrorGroup) rt.boardGroup.remove(rt.mirrorGroup);
    const grp = new THREE.Group();
    rt.hits = [];
    const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
    for (const m of state.mirrors) {
      const [x, z] = cellPos(m.index, state.cols);
      const mirror = createMirror(m.kind);
      mirror.position.set(x, 0, z);
      grp.add(mirror);
      const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
      h.position.set(x, 0.35, z);
      h.userData.pickId = `mir-${m.index}`;
      grp.add(h);
      rt.hits.push(h);
    }
    rt.boardGroup.add(grp);
    rt.mirrorGroup = grp;
  }, [state]);

  // 的の同期（的中で発光を強める）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const sig = `${state.target}:${trace.hitTarget ? 1 : 0}`;
    if (rt.targetSig === sig) return;
    rt.targetSig = sig;
    if (rt.targetGroup) rt.boardGroup.remove(rt.targetGroup);
    const grp = createTarget(trace.hitTarget);
    const [x, z] = cellPos(state.target, state.cols);
    grp.position.set(x, 0, z);
    rt.boardGroup.add(grp);
    rt.targetGroup = grp;
  }, [state, trace]);

  // 光線の同期: 親から受けた通過セルの中心をつなぐだけ（反射計算なし）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const sig = JSON.stringify({ cells: trace.cells, hit: trace.hitTarget, looped: trace.looped, endDir: trace.endDir, emitterRow: state.emitterRow });
    if (rt.beamSig === sig) return;
    rt.beamSig = sig;
    if (rt.beamGroup) rt.boardGroup.remove(rt.beamGroup);
    const grp = new THREE.Group();
    const pts: THREE.Vector3[] = [];
    const [sx, sz] = cellPos(state.emitterRow * state.cols, state.cols);
    pts.push(new THREE.Vector3(sx - PITCH * 0.55, BEAM_Y, sz));
    for (const idx of trace.cells) {
      const [x, z] = cellPos(idx, state.cols);
      pts.push(new THREE.Vector3(x, BEAM_Y, z));
    }
    if (!trace.hitTarget && !trace.looped && trace.cells.length > 0) {
      const last = pts[pts.length - 1];
      const [dx, dz] = DIR_VEC[trace.endDir];
      pts.push(new THREE.Vector3(last.x + dx * PITCH * 0.55, BEAM_Y, last.z + dz * PITCH * 0.55));
    }
    const coreMat = new THREE.MeshStandardMaterial({
      color: BEAM_COLOR, roughness: 0.3, emissive: BEAM_COLOR, emissiveIntensity: 0.7,
    });
    const glowMat = new THREE.MeshBasicMaterial({ color: BEAM_COLOR, transparent: true, opacity: 0.22 });
    for (let i = 0; i + 1 < pts.length; i++) {
      grp.add(createSegment(pts[i], pts[i + 1], 0.045, coreMat));
      grp.add(createSegment(pts[i], pts[i + 1], 0.11, glowMat));
    }
    rt.boardGroup.add(grp);
    rt.beamGroup = grp;
  }, [state, trace]);

  return (
    <SceneBox
      height={460}
      label="レーザーミラーの盤（3D）。鏡をタップすると向きが切り替わります"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#3a352b"
    />
  );
}
