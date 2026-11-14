"use client";
// 海戦ゲームの 3D 盤（1盤分）。海面の上に艦船を立体造形する:
//   艦船 = 長さ方向に伸びた船体（箱）＋中央の艦橋＋マスト。沈没時は
//     船体を暗くし、横倒しにして沈みを示す。
//   命中 = 炎色の爆発マーカー（球＋炎コーン）
//   はずれ = 水しぶきマーカー（白い輪＝トーラス＋しずく球）
//   直近の射撃 = 金の輪で強調
// 配置フェーズ（自盤・タップで配置/取消）と戦闘フェーズ（自盤=表示のみ、
// 敵盤=タップで射撃）の両方に使う。合法判定はすべて親ハンドラが行う。
// 残り隻数・手番などの状態は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

export interface BattleshipShipView {
  cells: number[];
  sunk: boolean;
}

export interface BattleshipShotView {
  index: number;
  result: string;
}

interface Props {
  label: string;
  /** 表示する艦（敵盤では沈没した艦だけが渡る）。 */
  ships: BattleshipShipView[];
  /** この盤への射撃記録。 */
  shots: BattleshipShotView[];
  /** 直近の射撃マス（金の輪で強調）。 */
  lastShotIndex: number | null;
  interactive: boolean;
  height?: number;
  /** マスタップ（配置フェーズは tryPlace、敵盤は fire へ接続）。 */
  onCell?: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const SIZE = 10;
const PITCH = 1.0;

function isHitResult(result: string): boolean {
  return result === "hit" || result === "sunk";
}

function cellPos(index: number): [number, number] {
  const r = Math.floor(index / SIZE);
  const c = index % SIZE;
  return [(c - (SIZE - 1) / 2) * PITCH, (r - (SIZE - 1) / 2) * PITCH];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement) {
  const w = container.clientWidth || 420;
  const h = container.clientHeight || 320;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (SIZE / 2 + 0.9) / Math.tan(hFov / 2);
  const distD = ((SIZE / 2 + 0.9) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.4;
  stage.setCamera({
    position: [0, dist * 0.82, dist * 0.58],
    lookAt: [0, 0, 0.2],
    fov: 42,
  });
}

/** 艦船の造形（船体＋艦橋＋マスト）。cells は連続した直線状である前提。 */
function createShip(ship: BattleshipShipView): THREE.Group {
  const grp = new THREE.Group();
  const cells = [...ship.cells].sort((a, b) => a - b);
  const horizontal = cells.length === 1 || Math.floor(cells[0] / SIZE) === Math.floor(cells[cells.length - 1] / SIZE);
  const len = cells.length;
  const hullColor = ship.sunk ? 0x37474f : 0x607d8b;
  const hullMat = new THREE.MeshStandardMaterial({ color: hullColor, roughness: 0.45, metalness: 0.25 });
  const hull = new THREE.Mesh(
    horizontal
      ? new THREE.BoxGeometry(len * PITCH - 0.14, 0.3, 0.68)
      : new THREE.BoxGeometry(0.68, 0.3, len * PITCH - 0.14),
    hullMat,
  );
  hull.position.y = 0.3;
  grp.add(hull);
  // 艦橋（中央付近の塔）とマスト。
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.3, 0.42), hullMat);
  bridge.position.y = 0.6;
  grp.add(bridge);
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 0.42, 8),
    new THREE.MeshStandardMaterial({ color: ship.sunk ? 0x263238 : 0x455a64, roughness: 0.5 }),
  );
  mast.position.y = 0.95;
  grp.add(mast);
  const mid = cells[Math.floor(cells.length / 2)];
  const [mx, mz] = cellPos(mid);
  grp.position.set(mx, 0, mz);
  if (ship.sunk) {
    // 沈没: 横倒しにして水面に沈める。
    grp.rotation.z = horizontal ? 0.5 : 0;
    grp.rotation.x = horizontal ? 0 : 0.5;
    grp.position.y = -0.12;
  }
  return grp;
}

/** 命中マーカー（炎色の球＋炎コーン）。 */
function createHitMarker(): THREE.Group {
  const grp = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 14, 10),
    new THREE.MeshStandardMaterial({ color: 0xe53935, emissive: 0x7f0000, emissiveIntensity: 0.7, roughness: 0.4 }),
  );
  core.position.y = 0.42;
  grp.add(core);
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.13, 0.34, 10),
    new THREE.MeshStandardMaterial({ color: 0xff7043, emissive: 0xbf360c, emissiveIntensity: 0.6, roughness: 0.5 }),
  );
  flame.position.y = 0.68;
  grp.add(flame);
  return grp;
}

/** はずれ（着水）マーカー: 水しぶきの輪＋しずく。 */
function createMissMarker(): THREE.Group {
  const grp = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.27, 0.05, 8, 24),
    new THREE.MeshStandardMaterial({ color: 0xf5fbff, roughness: 0.35 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.16;
  grp.add(ring);
  const drop = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xf5fbff, roughness: 0.3 }),
  );
  drop.position.y = 0.38;
  grp.add(drop);
  return grp;
}

interface SceneRt {
  stage: Stage;
  boardGroup: THREE.Group;
  hits: THREE.Mesh[];
  built: boolean;
  sig: string;
}

export default function BattleshipScene3D({
  label, ships, shots, lastShotIndex, interactive, height = 320, onCell, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onCell, interactive });
  propsRef.current = { onCell, interactive };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x10344d,
      camera: { position: [0, 9, 6.5], lookAt: [0, 0, 0.2], fov: 42 },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    const boardGroup = new THREE.Group();
    scene.add(boardGroup);
    rtRef.current = { stage, boardGroup, hits: [], built: false, sig: "" };

    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        if (!propsRef.current.interactive) return;
        const id = hit?.object.userData.pickId as string | undefined;
        if (id) propsRef.current.onCell?.(Number(id.slice(5)));
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

  // 盤面同期: 海面と当たり判定は初回だけ作り、艦とマーカーは内容が
  // 変わったときだけ作り直す（署名で差分判定）。
  const sig = JSON.stringify({ ships, shots, lastShotIndex });
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, boardGroup } = rt;
    if (!rt.built) {
      rt.built = true;
      const sea = new THREE.Mesh(
        new THREE.BoxGeometry(SIZE * PITCH + 0.35, 0.3, SIZE * PITCH + 0.35),
        new THREE.MeshStandardMaterial({ color: 0x1d5d85, roughness: 0.7 }),
      );
      sea.position.y = -0.16;
      sea.userData.isBase = true;
      boardGroup.add(sea);
      // マス目の水面プレート（交互に僅かに色を変えて格子を出す）。
      const plateGeo = new THREE.BoxGeometry(0.94, 0.06, 0.94);
      const plateMats = [0x2f6f9f, 0x2a6795].map(
        (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.65 }),
      );
      for (let i = 0; i < SIZE * SIZE; i++) {
        const plate = new THREE.Mesh(plateGeo, plateMats[(Math.floor(i / SIZE) + (i % SIZE)) % 2]);
        const [x, z] = cellPos(i);
        plate.position.set(x, 0.03, z);
        plate.userData.isBase = true;
        boardGroup.add(plate);
      }
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
      for (let i = 0; i < SIZE * SIZE; i++) {
        const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        const [x, z] = cellPos(i);
        h.position.set(x, 0.3, z);
        h.userData.pickId = `cell-${i}`;
        boardGroup.add(h);
        rt.hits.push(h);
      }
      const containerEl = containerRef.current;
      if (containerEl) fitCamera(stage, containerEl);
    }
    if (rt.sig === sig) return;
    rt.sig = sig;

    for (const child of [...boardGroup.children]) {
      if (!child.userData.pickId && !child.userData.isBase) boardGroup.remove(child);
    }
    for (const ship of ships) boardGroup.add(createShip(ship));
    const goldMat = new THREE.MeshStandardMaterial({ color: 0xffd54f, emissive: 0x8d6e00, emissiveIntensity: 0.5, roughness: 0.35 });
    for (const shot of shots) {
      const [x, z] = cellPos(shot.index);
      const marker = isHitResult(shot.result) ? createHitMarker() : createMissMarker();
      marker.position.set(x, 0, z);
      boardGroup.add(marker);
      if (shot.index === lastShotIndex) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.045, 8, 28), goldMat);
        ring.rotation.x = Math.PI / 2;
        ring.position.set(x, 0.14, z);
        boardGroup.add(ring);
      }
    }
  }, [sig, ships, shots, lastShotIndex]);

  return (
    <SceneBox
      height={height}
      label={label}
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#10344d"
    />
  );
}
