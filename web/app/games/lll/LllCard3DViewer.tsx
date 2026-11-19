"use client";
// LLL 3D カードビューア ＆ 召喚演出（Three.js + three-kit）。
// - mode="inspect": ドラッグでカードを3D空間内で自由に傾け、ティア別の金属光沢・属性オーラを楽しめる。
// - mode="summon": ガチャ召喚の3Dスピン＆光柱バースト演出からカード表面へ反転する。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import SceneBox from "@/lib/three-kit/SceneBox";
import {
  ELEMENT_NUM,
  TIER_NUM,
  createArenaCircleTexture,
  createCardBackTexture,
  createCardFaceTexture,
  createGlowSpriteTexture,
  type ThreeCardInput,
} from "./LllThreeTextures";

interface Props {
  card: ThreeCardInput;
  mode?: "inspect" | "summon";
  height?: number;
  onFail?: () => void;
  fallback: ReactNode;
}

export default function LllCard3DViewer({
  card,
  mode = "inspect",
  height = 310,
  onFail,
  fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  const stageRef = useRef<Stage | null>(null);
  const cardPivotRef = useRef<THREE.Group | null>(null);
  const targetTiltRef = useRef({ rx: 0, ry: 0 });
  const summonStartRef = useRef<number>(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const elColor = ELEMENT_NUM[card.element] ?? 0xffe47a;
    const tierColor = TIER_NUM[card.tier] ?? 0x6f7794;
    let ringMesh: THREE.Mesh | null = null;
    let pillarMesh: THREE.Mesh | null = null;
    let motes: THREE.Points | null = null;
    let holoLight: THREE.PointLight | null = null;

    summonStartRef.current = performance.now();

    const stage = createStage(el, {
      background: card.tier === "legend" ? 0x17130c : card.tier === "elite" ? 0x0f1620 : 0x101318,
      camera: { position: [0, 0.3, 4.35], lookAt: [0, 0, 0], fov: 40 },
      pixelRatioCap: 2,
      onFrame: (dt, t) => {
        const pivot = cardPivotRef.current;
        if (!pivot) return;

        if (mode === "summon") {
          const elapsed = (performance.now() - summonStartRef.current) / 1000;
          if (elapsed < 0.95) {
            const p = elapsed / 0.95;
            pivot.rotation.y = Math.PI + p * Math.PI * 3;
            pivot.scale.setScalar(0.55 + p * 0.48);
            pivot.position.y = Math.sin(p * Math.PI) * 0.25;
            if (pillarMesh) {
              pillarMesh.visible = true;
              pillarMesh.scale.set(1.2 - p * 0.4, 1, 1.2 - p * 0.4);
              (pillarMesh.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - p * 0.5);
            }
          } else {
            const settle = Math.min(1, (elapsed - 0.95) / 0.35);
            pivot.rotation.y = (1 - settle) * 0.4 + Math.sin(t * 1.4) * 0.14;
            pivot.rotation.x = Math.sin(t * 1.1) * 0.05;
            pivot.scale.setScalar(1.0 + Math.sin(settle * Math.PI) * 0.06);
            pivot.position.y = Math.sin(t * 2.1) * 0.05;
            if (pillarMesh) pillarMesh.visible = false;
          }
        } else {
          const tx = targetTiltRef.current.rx + Math.sin(t * 1.6) * 0.04;
          const ty = targetTiltRef.current.ry + Math.sin(t * 1.1) * 0.12;
          pivot.rotation.x += (tx - pivot.rotation.x) * Math.min(1, dt * 10 || 1);
          pivot.rotation.y += (ty - pivot.rotation.y) * Math.min(1, dt * 10 || 1);
          pivot.position.y = Math.sin(t * 2.0) * 0.05;
        }

        if (ringMesh) {
          ringMesh.rotation.z = t * 0.22;
        }
        if (holoLight) {
          holoLight.position.x = Math.sin(t * 2.1) * 2.4;
          holoLight.position.y = Math.cos(t * 1.5) * 1.8;
        }
        if (motes) {
          motes.rotation.y = t * 0.14;
        }
      },
    });

    if (!stage) {
      setFailed(true);
      onFail?.();
      return;
    }

    stageRef.current = stage;

    // ホログラム用ライト
    holoLight = new THREE.PointLight(card.tier === "legend" ? 0xe8c77f : elColor, 2.8, 10);
    holoLight.position.set(1.5, 1.5, 2.8);
    stage.scene.add(holoLight);

    // 背面幾何学リング
    const ringHex = card.tier === "legend" ? "#d4a24c" : card.tier === "elite" ? "#5b9bd5" : "#6c7588";
    const circleTex = createArenaCircleTexture(ringHex);
    ringMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 3.4),
      new THREE.MeshBasicMaterial({
        map: circleTex,
        transparent: true,
        opacity: card.tier === "legend" ? 0.55 : 0.35,
        depthWrite: false,
      }),
    );
    ringMesh.position.set(0, 0, -0.55);
    stage.scene.add(ringMesh);

    // 召喚時の光柱
    pillarMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 1.2, 4.6, 24, 1, true),
      new THREE.MeshBasicMaterial({
        color: tierColor,
        transparent: true,
        opacity: 0.4,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    pillarMesh.visible = mode === "summon";
    stage.scene.add(pillarMesh);

    // 浮遊粒子
    const glowTex = createGlowSpriteTexture();
    const count = card.tier === "legend" ? 36 : 20;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 3.8;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 3.4;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 1.4 - 0.1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    motes = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: card.tier === "legend" ? 0xe6c07b : elColor,
        size: 0.12,
        map: glowTex,
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    stage.scene.add(motes);

    // 3D カード本体
    const pivot = new THREE.Group();
    cardPivotRef.current = pivot;
    stage.scene.add(pivot);

    const { texture: faceTex } = createCardFaceTexture(card);
    const backTex = createCardBackTexture();
    const frameMat = new THREE.MeshStandardMaterial({
      color: tierColor,
      roughness: card.tier === "normal" ? 0.5 : 0.24,
      metalness: card.tier === "legend" ? 0.78 : card.tier === "elite" ? 0.52 : 0.22,
    });
    const faceMat = new THREE.MeshStandardMaterial({
      map: faceTex,
      roughness: card.tier === "normal" ? 0.65 : 0.26,
      metalness: card.tier === "legend" ? 0.3 : 0.14,
    });
    const backMat = new THREE.MeshStandardMaterial({
      map: backTex,
      roughness: 0.35,
      metalness: 0.4,
    });

    const cardMesh = new THREE.Mesh(new THREE.BoxGeometry(1.72, 2.4, 0.06), [
      frameMat,
      frameMat,
      frameMat,
      frameMat,
      faceMat,
      backMat,
    ]);
    pivot.add(cardMesh);

    let summonTimer: ReturnType<typeof setTimeout> | null = null;
    if (mode === "summon") {
      pivot.rotation.y = Math.PI;
      summonTimer = setTimeout(() => {
        if (card.tier === "legend") stage.shake(2);
      }, 950);
    }

    // ポインタ傾き追従
    const canvas = stage.canvas;
    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      const ny = ((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1;
      targetTiltRef.current = {
        rx: THREE.MathUtils.clamp(-ny * 0.42, -0.5, 0.5),
        ry: THREE.MathUtils.clamp(nx * 0.52, -0.65, 0.65),
      };
    };
    const onLeave = () => {
      targetTiltRef.current = { rx: 0, ry: 0 };
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);

    setReady(true);
    return () => {
      if (summonTimer) clearTimeout(summonTimer);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      glowTex.dispose();
      backTex.dispose();
      faceTex.dispose();
      circleTex.dispose();
      stage.dispose();
      stageRef.current = null;
      cardPivotRef.current = null;
    };
  }, [card, mode, onFail]);

  return (
    <SceneBox
      height={height}
      label={`${card.name} 3Dビューア`}
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background={card.tier === "legend" ? "#17130c" : card.tier === "elite" ? "#0f1620" : "#101318"}
      radius={10}
    />
  );
}
