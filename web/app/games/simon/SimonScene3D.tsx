"use client";
// サイモンの 3D シーン。円形の台座に4色パッドを立体造形し、発光は
// emissive、押し込みは沈み込みで表現する。再生シーケンス・入力タイミング・
// 音はすべてクライアント（SimonClient）が持ち、ここは表示とタップ接続のみ:
//   パッドのタップ = 既存 onPad（フェーズ判定はクライアント側）
// 色はクライアントの PADS と同じ値を使う（材質色＋発光色）。
// ラウンド・メッセージは親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

interface Props {
  lit: number | null;
  pressed: number | null;
  onPad: (pad: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

/** クライアント PADS と同じ並び（みどり/あか/きいろ/あお）。 */
const PAD_COLORS = [0x2fbf71, 0xef476f, 0xf2c531, 0x4361ee];
const PAD_DARK = [0x1e7f4c, 0xa12c49, 0xa8861a, 0x2b3f9e];
const PAD_POS: Array<[number, number]> = [
  [-0.64, -0.64],
  [0.64, -0.64],
  [-0.64, 0.64],
  [0.64, 0.64],
];
const PAD_Y = 0.3;

function findPickId(obj: THREE.Object3D | null): string | null {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    const id = cur.userData.pickId as string | undefined;
    if (id) return id;
    cur = cur.parent;
  }
  return null;
}

interface SceneRt {
  pads: THREE.Mesh[];
  padMats: THREE.MeshStandardMaterial[];
}

export default function SimonScene3D({ lit, pressed, onPad, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onPad });
  propsRef.current = { onPad };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x20242e,
      camera: { position: [0, 4.4, 4.4], lookAt: [0, 0, 0.1], fov: 42 },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(1.78, 1.9, 0.34, 44),
      new THREE.MeshStandardMaterial({ color: 0x20242e, roughness: 0.55 }),
    );
    base.position.y = 0;
    scene.add(base);
    const baseRim = new THREE.Mesh(
      new THREE.TorusGeometry(1.78, 0.035, 10, 44),
      new THREE.MeshStandardMaterial({ color: 0x39404e, roughness: 0.4 }),
    );
    baseRim.rotation.x = Math.PI / 2;
    baseRim.position.y = 0.17;
    scene.add(baseRim);

    const padsGroup = new THREE.Group();
    scene.add(padsGroup);
    const pads: THREE.Mesh[] = [];
    const padMats: THREE.MeshStandardMaterial[] = [];
    PAD_POS.forEach(([x, z], i) => {
      const mat = new THREE.MeshStandardMaterial({
        color: PAD_DARK[i],
        roughness: 0.42,
        emissive: new THREE.Color(PAD_COLORS[i]),
        emissiveIntensity: 0.12,
      });
      const pad = new THREE.Mesh(new THREE.BoxGeometry(1.12, 0.24, 1.12), mat);
      pad.position.set(x, PAD_Y, z);
      pad.userData.pickId = `pad-${i}`;
      padsGroup.add(pad);
      pads.push(pad);
      padMats.push(mat);
    });
    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.44, 0.44, 0.3, 28),
      new THREE.MeshStandardMaterial({ color: 0x11141a, roughness: 0.45 }),
    );
    hub.position.y = PAD_Y;
    scene.add(hub);

    rtRef.current = { pads, padMats };

    detach = attachPickPointer(
      stage,
      () => [padsGroup],
      {
        onTap: (hit) => {
          const id = findPickId(hit?.object ?? null);
          if (!id || !id.startsWith("pad-")) return;
          propsRef.current.onPad(Number(id.slice("pad-".length)));
        },
      },
    );
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 発光・押し込みの同期（クライアントの lit / pressed に完全追従）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    rt.pads.forEach((pad, i) => {
      const isLit = lit === i || pressed === i;
      rt.padMats[i].emissiveIntensity = isLit ? 1.15 : 0.12;
      rt.padMats[i].color.setHex(isLit ? PAD_COLORS[i] : PAD_DARK[i]);
      pad.position.y = PAD_Y - (pressed === i ? 0.055 : 0) + (lit === i ? 0.02 : 0);
    });
  }, [lit, pressed]);

  return (
    <SceneBox
      height={400}
      label="サイモン（3D）。光る順番を覚えて、同じ順番でパッドをタップします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#20242e"
    />
  );
}
