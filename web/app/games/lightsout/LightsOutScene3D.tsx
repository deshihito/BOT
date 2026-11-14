"use client";
// ライツアウトの 3D 盤。パネルを立体化し:
//   点灯 = 発光（emissive）＋盛り上がり＋上面のランプ球
//   消灯 = 沈み込み＋暗色
// で押し込み感を表現する。高さの遷移は onFrame の補間で滑らかにする。
// 入力は現行クライアントの操作語彙どおり:
//   タップ = onPress（押したマスと上下左右の反転は lib/lightsout.ts の
//     pressCell と親ハンドラが行う）
// 点灯数・手数・時間などの状態は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

interface Props {
  cells: boolean[];
  size: number;
  won: boolean;
  /** タップ（現行の handlePress へ接続）。 */
  onPress: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;
/** 点灯パネルの上面の高さ（盛り上がり）と消灯時の沈み込み。 */
const LIT_TOP = 0.42;
const UNLIT_TOP = 0.14;

function cellPos(index: number, size: number): [number, number] {
  const r = Math.floor(index / size);
  const c = index % size;
  return [(c - (size - 1) / 2) * PITCH, (r - (size - 1) / 2) * PITCH];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, size: number) {
  const w = container.clientWidth || 400;
  const h = container.clientHeight || 400;
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

interface PanelRt {
  grp: THREE.Group;
  bodyMat: THREE.MeshStandardMaterial;
  lampMat: THREE.MeshStandardMaterial;
  on: boolean;
  targetTop: number;
}

interface SceneRt {
  stage: Stage;
  boardGroup: THREE.Group;
  hits: THREE.Mesh[];
  panels: Map<number, PanelRt>;
  builtSize: number;
}

export default function LightsOutScene3D({ cells, size, won, onPress, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onPress, won });
  propsRef.current = { onPress, won };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x141a22,
      camera: { position: [0, 7, 5], lookAt: [0, 0, 0.2], fov: 42 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        // パネルの高さを目標へ追従させる（押し込み／盛り上がりの遷移）。
        const k = 1 - Math.exp(-dt * 14);
        for (const p of rt.panels.values()) {
          p.grp.position.y += (p.targetTop - p.grp.position.y) * k;
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    const boardGroup = new THREE.Group();
    scene.add(boardGroup);
    rtRef.current = { stage, boardGroup, hits: [], panels: new Map(), builtSize: 0 };

    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        if (propsRef.current.won) return;
        const id = hit?.object.userData.pickId as string | undefined;
        if (id) propsRef.current.onPress(Number(id.slice(5)));
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

  // 盤面同期: サイズが変わったら土台・当たり判定・パネルを作り直し、
  // それ以外は各パネルの発光と目標高さだけを更新する。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, boardGroup } = rt;
    if (rt.builtSize !== size) {
      rt.builtSize = size;
      for (const child of [...boardGroup.children]) boardGroup.remove(child);
      rt.panels.clear();
      rt.hits = [];
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(size * PITCH + 0.35, 0.3, size * PITCH + 0.35),
        new THREE.MeshStandardMaterial({ color: 0x232c36, roughness: 0.9 }),
      );
      base.position.y = -0.16;
      boardGroup.add(base);
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
      for (let i = 0; i < size * size; i++) {
        const [x, z] = cellPos(i, size);
        const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        h.position.set(x, 0.3, z);
        h.userData.pickId = `cell-${i}`;
        boardGroup.add(h);
        rt.hits.push(h);

        const grp = new THREE.Group();
        grp.position.set(x, UNLIT_TOP, z);
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.6 });
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.3, 0.9), bodyMat);
        body.position.y = -0.15;
        grp.add(body);
        // 上面のランプ（扁平な球）。点灯時は emissive で発光させる。
        const lampMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.35 });
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.3, 20, 14), lampMat);
        lamp.scale.y = 0.45;
        lamp.position.y = 0.02;
        grp.add(lamp);
        boardGroup.add(grp);
        rt.panels.set(i, { grp, bodyMat, lampMat, on: false, targetTop: UNLIT_TOP });
      }
      const containerEl = containerRef.current;
      if (containerEl) fitCamera(stage, containerEl, size);
    }

    cells.forEach((on, i) => {
      const p = rt.panels.get(i);
      if (!p || p.on === on) return;
      p.on = on;
      p.targetTop = on ? LIT_TOP : UNLIT_TOP;
      if (on) {
        p.bodyMat.color.set(0xfbbf24);
        p.bodyMat.emissive.set(0xd97706);
        p.bodyMat.emissiveIntensity = 0.55;
        p.lampMat.color.set(0xfde68a);
        p.lampMat.emissive.set(0xf59e0b);
        p.lampMat.emissiveIntensity = 0.9;
      } else {
        p.bodyMat.color.set(0x1e293b);
        p.bodyMat.emissive.set(0x000000);
        p.bodyMat.emissiveIntensity = 0;
        p.lampMat.color.set(0x334155);
        p.lampMat.emissive.set(0x000000);
        p.lampMat.emissiveIntensity = 0;
      }
    });
  }, [cells, size]);

  return (
    <SceneBox
      height={400}
      label="ライツアウトの盤（3D）。パネルをタップすると周囲も反転します"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#141a22"
    />
  );
}
