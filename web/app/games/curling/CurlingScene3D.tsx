"use client";
// カーリングの 3D シーン。氷面 + ハウス円 + ストーン。
// 物理は lib/curling.ts が決め、ここは displayStones (親がフレーム列を再生した
// 位置) へ補間追従するだけ。3D 側で衝突・得点判定はしない。
// 投げたストーンが最終位置へ収束する見た目は、親の frames 再生 + ここでの
// 指数補間 (減速に合わせて追従が緩む) で表現する。
// 入力: シート上のドラッグ = 強さ (投げ位置からの引き/送り量) と
//       カール (横ずれ) をスライダー値へ接続し、速いフリック / 上向き
//       ドラッグ終了で投げる。スライダー + 「投げる」も従来どおり使える。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createDisc, canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import {
  CU_BACK_Y,
  CU_BUTTON,
  CU_HEIGHT,
  CU_HOG_Y,
  CU_HOUSE_RADII,
  CU_STONE_RADIUS,
  CU_THROW_Y,
  CU_WIDTH,
  type CuStone,
} from "@/lib/curling";

interface Props {
  stones: CuStone[];
  /** 自分の手番で待機中のストーンを投げ位置に表示するか。 */
  waiting: boolean;
  canThrow: boolean;
  onAim: (power: number, curl: number) => void;
  onThrow: (power: number, curl: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const S = 100;
const toX = (gx: number) => (gx - CU_WIDTH / 2) / S;
const toZ = (gy: number) => (gy - CU_HEIGHT / 2) / S;
const STONE_R = CU_STONE_RADIUS / S;
const STONE_Y = 0.05;

function makeStone(side: "player" | "cpu"): THREE.Group {
  const color = side === "player" ? 0xd43a2f : 0xf6c90e;
  const grp = new THREE.Group();
  const body = createDisc(STONE_R, 0.09, 0x4a4f55);
  body.position.y = 0.02;
  grp.add(body);
  const band = new THREE.Mesh(
    new THREE.CylinderGeometry(STONE_R * 0.82, STONE_R * 0.82, 0.035, 24),
    new THREE.MeshStandardMaterial({ color, roughness: 0.35 }),
  );
  band.position.y = 0.085;
  grp.add(band);
  const handle = new THREE.Mesh(
    new THREE.TorusGeometry(0.055, 0.016, 8, 18),
    new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.3, metalness: 0.5 }),
  );
  handle.rotation.x = Math.PI / 2;
  handle.position.y = 0.125;
  grp.add(handle);
  grp.userData.pickId = `stone-${side}`;
  return grp;
}

export default function CurlingScene3D({ stones, waiting, canThrow, onAim, onThrow, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<{
    stones: Map<number, THREE.Group>;
    targets: Map<number, { x: number; z: number }>;
    waitingStone: THREE.Group;
    scene: THREE.Scene;
  } | null>(null);
  const aimRef = useRef<{ power: number; curl: number; dragged: number }>({ power: 78, curl: 0, dragged: 0 });

  const propsRef = useRef({ stones, waiting, canThrow, onAim, onThrow });
  propsRef.current = { stones, waiting, canThrow, onAim, onThrow };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0xb9d6e6,
      camera: { position: [0, 9.2, 4.2], lookAt: [0, 0, -0.2], fov: 46 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        // 減速して止まる動きに合わせ、追従係数は控えめにする (氷の滑走感)。
        const k = Math.min(1, dt * 30);
        for (const [id, mesh] of rt.stones) {
          const t = rt.targets.get(id);
          if (!t) continue;
          mesh.position.x += (t.x - mesh.position.x) * k;
          mesh.position.z += (t.z - mesh.position.z) * k;
          mesh.position.y = STONE_Y;
        }
        rt.waitingStone.visible = propsRef.current.waiting;
        rt.waitingStone.position.set(toX(CU_BUTTON.x), STONE_Y, toZ(CU_THROW_Y));
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // 氷面
    const iceTex = canvasTexture("curling-ice", 160, 390, (g) => {
      g.fillStyle = "#dceef7";
      g.fillRect(0, 0, 160, 390);
      g.fillStyle = "rgba(255,255,255,0.5)";
      for (let i = 0; i < 260; i++) g.fillRect((i * 29) % 160, (i * 47) % 390, 3, 2);
    });
    const ice = new THREE.Mesh(
      new THREE.BoxGeometry(CU_WIDTH / S, 0.05, CU_HEIGHT / S),
      new THREE.MeshStandardMaterial({ map: iceTex, roughness: 0.25 }),
    );
    ice.position.y = -0.025;
    ice.userData.pickId = "ice";
    scene.add(ice);
    const apron = new THREE.Mesh(
      new THREE.BoxGeometry(CU_WIDTH / S + 0.3, 0.04, CU_HEIGHT / S + 0.3),
      new THREE.MeshStandardMaterial({ color: 0x8fb4c9, roughness: 0.7 }),
    );
    apron.position.y = -0.06;
    scene.add(apron);
    // ハウス円 (外から青・白・赤、中心は白)
    const houseCols = [0x2456c8, 0xf4f4f4, 0xd43a2f];
    CU_HOUSE_RADII.forEach((r, i) => {
      const ring = new THREE.Mesh(
        new THREE.CircleGeometry(r / S, 36),
        new THREE.MeshStandardMaterial({ color: houseCols[i], roughness: 0.4 }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(toX(CU_BUTTON.x), 0.006 + i * 0.002, toZ(CU_BUTTON.y));
      scene.add(ring);
    });
    const button = new THREE.Mesh(
      new THREE.CircleGeometry(0.08, 20),
      new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.4 }),
    );
    button.rotation.x = -Math.PI / 2;
    button.position.set(toX(CU_BUTTON.x), 0.013, toZ(CU_BUTTON.y));
    scene.add(button);
    // ライン類 (ティー / バック / ホッグ) と投げ位置マーカー
    const lineMat = new THREE.MeshStandardMaterial({ color: 0x7d99a8, roughness: 0.6 });
    const mkLine = (gy: number, w = CU_WIDTH / S) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.006, 0.02), lineMat);
      m.position.set(0, 0.004, toZ(gy));
      scene.add(m);
    };
    mkLine(CU_BUTTON.y);
    mkLine(CU_BACK_Y);
    mkLine(CU_HOG_Y);
    const throwMark = new THREE.Mesh(
      new THREE.CircleGeometry(0.05, 16),
      new THREE.MeshStandardMaterial({ color: 0x56707e, roughness: 0.6 }),
    );
    throwMark.rotation.x = -Math.PI / 2;
    throwMark.position.set(toX(CU_BUTTON.x), 0.006, toZ(CU_THROW_Y));
    scene.add(throwMark);

    const stoneMeshes = new Map<number, THREE.Group>();
    const targets = new Map<number, { x: number; z: number }>();
    for (const s of propsRef.current.stones) {
      const mesh = makeStone(s.side);
      mesh.position.set(toX(s.x), STONE_Y, toZ(s.y));
      scene.add(mesh);
      stoneMeshes.set(s.id, mesh);
      targets.set(s.id, { x: toX(s.x), z: toZ(s.y) });
    }
    const waitingStone = makeStone("player");
    waitingStone.visible = propsRef.current.waiting;
    scene.add(waitingStone);
    rtRef.current = { stones: stoneMeshes, targets, waitingStone, scene };

    const aimFromPoint = (pt: THREE.Vector3) => {
      // 投げ位置 (下端) からハウス方向への送り量で強さ、横ずれでカールを決める。
      // pt.z が小さい (奥) ほど強い。スライダー値域にそのまま写す。
      const dz = toZ(CU_THROW_Y) - pt.z; // 奥へ進んだ量 (world)
      const power = Math.max(0, Math.min(100, Math.round(55 + dz * 16)));
      const curl = Math.max(-100, Math.min(100, Math.round(pt.x * 55)));
      aimRef.current = { power, curl, dragged: Math.max(aimRef.current.dragged, dz) };
      propsRef.current.onAim(power, curl);
    };

    detach = attachPickPointer(
      stage,
      () => [ice, waitingStone, ...stoneMeshes.values()],
      {
        onDragStart: () => { aimRef.current = { power: 78, curl: 0, dragged: 0 }; },
        onDragMove: (point) => { if (propsRef.current.canThrow) aimFromPoint(point); },
        onDragEnd: (flick) => {
          const a = aimRef.current;
          const speed = Math.hypot(flick.vxPx, flick.vyPx);
          // 上向きへの十分なドラッグ、または速いフリックで投げる。
          if (propsRef.current.canThrow && (a.dragged > 0.55 || (speed > 650 && flick.vyPx < 0))) {
            propsRef.current.onThrow(a.power, a.curl);
          }
        },
        onFlick: (flick) => {
          if (!propsRef.current.canThrow) return;
          if (flick.dir === "up" || flick.vyPx < -300) {
            const speed = Math.hypot(flick.vxPx, flick.vyPx);
            const power = Math.max(30, Math.min(100, Math.round(45 + speed / 18)));
            const curl = Math.max(-100, Math.min(100, Math.round(flick.vxPx / 12)));
            propsRef.current.onThrow(power, curl);
          }
        },
      },
      { planeY: STONE_Y },
    );
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 親の表示ストーン (フレーム再生結果) を補間ターゲットへ同期し、消えた石を除く。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const seen = new Set<number>();
    for (const s of stones) {
      seen.add(s.id);
      if (!rt.stones.has(s.id)) {
        const mesh = makeStone(s.side);
        // 新規ストーンは投げ位置から現れる (frames の先頭が投げ位置のため)。
        mesh.position.set(toX(s.x), STONE_Y, toZ(s.y));
        rt.scene.add(mesh);
        rt.stones.set(s.id, mesh);
      }
      rt.targets.set(s.id, { x: toX(s.x), z: toZ(s.y) });
    }
    for (const [id, mesh] of [...rt.stones]) {
      if (!seen.has(id)) {
        rt.scene.remove(mesh);
        rt.stones.delete(id);
        rt.targets.delete(id);
      }
    }
  }, [stones]);

  return (
    <SceneBox
      height={560}
      label="カーリングシート (3D)。ドラッグで強さとカールを決め、フリックで投げます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#b9d6e6"
    />
  );
}
