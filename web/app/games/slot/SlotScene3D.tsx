"use client";
// スロットの 3D シーン。筐体に 3 つのリール（回転する箱）とレバー。
// リールは左から順に止まり、最終結果は lib/slot.ts のスピン結果と一致する
// （親が display / stopped を管理し、ここは回転演出だけを行う）。
// レバーを引く操作は、画面の下スワイプ/下フリック（既存ジェスチャと同一）。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import { slotSymbol, type SlotSymbolId } from "@/lib/slot";

interface Props {
  display: SlotSymbolId[];
  spinning: boolean;
  stopped: number;
  onPull: () => void;
  onTapMachine: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

function symbolTexture(id: SlotSymbolId): THREE.CanvasTexture {
  return canvasTexture(`slot-${id}`, 128, 128, (g) => {
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = id === "seven" ? "#c0392b" : "#243447";
    g.font = "bold 76px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(slotSymbol(id).glyph, 64, 68);
  });
}

interface ReelRt {
  mesh: THREE.Mesh;
  mats: THREE.MeshStandardMaterial[];
}

export default function SlotScene3D({ display, spinning, stopped, onPull, onTapMachine, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<{ reels: ReelRt[]; leverBall: THREE.Mesh; leverAt: number } | null>(null);
  const propsRef = useRef({ display, spinning, stopped, onPull, onTapMachine });
  propsRef.current = { display, spinning, stopped, onPull, onTapMachine };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x10182b,
      camera: { position: [0, 2.0, 8.6], lookAt: [0, 1.25, 0], fov: 42 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        const cur = propsRef.current;
        rt.reels.forEach((reel, i) => {
          const reelSpinning = cur.spinning && cur.stopped <= i;
          if (reelSpinning) {
            reel.mesh.rotation.x -= dt * 15;
          } else {
            // 最寄りの 1 回転倍数へ収束させて正面で止める
            const target = Math.round(reel.mesh.rotation.x / (Math.PI * 2)) * Math.PI * 2;
            const diff = target - reel.mesh.rotation.x;
            reel.mesh.rotation.x += diff * Math.min(1, dt * 14);
            if (Math.abs(diff) < 0.001) reel.mesh.rotation.x = target;
          }
        });
        // レバー: スピン開始から 0.5 秒でボールが下がって戻る
        if (rt.leverAt > 0) {
          const k = (performance.now() - rt.leverAt) / 500;
          if (k >= 1) {
            rt.leverBall.position.y = 2.6;
            rt.leverAt = 0;
          } else {
            rt.leverBall.position.y = 2.6 - Math.sin(k * Math.PI) * 0.85;
          }
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // 筐体
    const cabinet = new THREE.Mesh(
      new THREE.BoxGeometry(5.6, 3.6, 0.6),
      new THREE.MeshStandardMaterial({ color: 0x182238, roughness: 0.5 }),
    );
    cabinet.position.set(-0.3, 1.55, -0.45);
    cabinet.userData.pickId = "cabinet";
    scene.add(cabinet);
    const trim = new THREE.Mesh(
      new THREE.BoxGeometry(5.85, 3.85, 0.4),
      new THREE.MeshStandardMaterial({ color: 0xf2b33d, roughness: 0.35, metalness: 0.4 }),
    );
    trim.position.set(-0.3, 1.55, -0.62);
    scene.add(trim);
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(6.6, 0.35, 2.2),
      new THREE.MeshStandardMaterial({ color: 0x0d1424, roughness: 0.8 }),
    );
    base.position.set(0, -0.15, 0.2);
    scene.add(base);

    // リール
    const reels: ReelRt[] = [];
    const sideIds: SlotSymbolId[] = ["cherry", "bell", "star", "lemon"];
    for (let i = 0; i < 3; i++) {
      const mats: THREE.MeshStandardMaterial[] = [
        new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.5 }),
        new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.5 }),
        new THREE.MeshStandardMaterial({ map: symbolTexture(sideIds[i % 4]), roughness: 0.45 }),
        new THREE.MeshStandardMaterial({ map: symbolTexture(sideIds[(i + 1) % 4]), roughness: 0.45 }),
        new THREE.MeshStandardMaterial({ map: symbolTexture(propsRef.current.display[i]), roughness: 0.45 }),
        new THREE.MeshStandardMaterial({ color: 0xbbbbbb, roughness: 0.5 }),
      ];
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.3, 0.55), mats);
      mesh.position.set(-1.85 + i * 1.55, 1.6, 0);
      mesh.userData.pickId = "cabinet";
      scene.add(mesh);
      reels.push({ mesh, mats });
    }

    // レバー
    const rod = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 1.6, 10),
      new THREE.MeshStandardMaterial({ color: 0x8a90a3, roughness: 0.35, metalness: 0.5 }),
    );
    rod.position.set(2.95, 1.8, 0);
    scene.add(rod);
    const leverBall = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 18, 14),
      new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.3 }),
    );
    leverBall.position.set(2.95, 2.6, 0);
    leverBall.userData.pickId = "cabinet";
    scene.add(leverBall);

    rtRef.current = { reels, leverBall, leverAt: 0 };
    detach = attachPickPointer(stage, () => [cabinet, leverBall, ...reels.map((r) => r.mesh)], {
      onTap: () => propsRef.current.onTapMachine(),
      onFlick: (f) => { if (f.dir === "down") propsRef.current.onPull(); },
      onDragEnd: (f) => { if (f.dir === "down") propsRef.current.onPull(); },
    });
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 表示シンボルの同期（止まったリールの正面を差し替える）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    display.forEach((id, i) => {
      const reel = rt.reels[i];
      if (reel) reel.mats[4].map = symbolTexture(id);
    });
  }, [display]);

  // スピン開始でレバーを引く。
  const prevSpinningRef = useRef(spinning);
  useEffect(() => {
    if (spinning && !prevSpinningRef.current && rtRef.current) {
      rtRef.current.leverAt = performance.now();
    }
    prevSpinningRef.current = spinning;
  }, [spinning]);

  return (
    <SceneBox
      height={300}
      label={`スロット（3D）。リール: ${display.map((id) => slotSymbol(id).label).join("、")}。下へスワイプでスピン`}
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#10182b"
    />
  );
}
