"use client";
// LLL 3D バトルアリーナ（Three.js + three-kit）。
// 6枚の5:7カードが魔方陣の祭壇上に浮かび、手番オーラ・ターゲットリング・
// 3Dシールドドーム・属性パーティクル・突進アニメ・カメラシェイク＆ヒットストップを演出する。
// WebGL 非対応環境では onFail() により 2D 表示へフォールバックする。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { PlaybackVfx } from "@/lib/lll/lll-playback";
import {
  ELEMENT_NUM,
  TIER_NUM,
  createArenaCircleTexture,
  createCardBackTexture,
  createCardFaceTexture,
  createGlowSpriteTexture,
  type ThreeCardInput,
} from "./LllThreeTextures";

export interface BattleSceneActor extends ThreeCardInput {
  key: string;
  side: "player" | "cpu";
}

interface Props {
  actors: BattleSceneActor[];
  currentActorKey: string | null;
  targetableKeys: string[];
  guideTargetKey: string | null;
  vfx: PlaybackVfx | null;
  vfxNonce: number;
  shakeIntensity: 0 | 1 | 2 | 3;
  isBossOrAbyss?: boolean;
  onActorTap: (actorKey: string) => void;
  onFail: () => void;
  fallback: ReactNode;
  height?: number | string;
}

const CARD_W = 1.32;
const CARD_H = 1.84;
const CARD_D = 0.05;

const SLOT_XS = [-2.25, 0, 2.25] as const;

type ActorSlotNode = {
  key: string;
  side: "player" | "cpu";
  basePos: THREE.Vector3;
  root: THREE.Group;
  cardPivot: THREE.Group;
  frameMat: THREE.MeshStandardMaterial;
  faceMat: THREE.MeshBasicMaterial;
  redrawFace: (next: ThreeCardInput) => void;
  ringMesh: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  shieldDome: THREE.Mesh;
  statusOrb: THREE.Mesh;
  signature: string;
  alive: boolean;
  lungeEndAt: number;
  lungeFrom: THREE.Vector3;
  lungeTo: THREE.Vector3;
  recoilUntil: number;
};

type Spark = {
  mesh: THREE.Sprite;
  vel: THREE.Vector3;
  gravity: number;
  born: number;
  life: number;
  startScale: number;
};

type Beam = {
  mesh: THREE.Mesh;
  from: THREE.Vector3;
  to: THREE.Vector3;
  born: number;
  life: number;
};

function actorSignature(a: BattleSceneActor): string {
  return [
    a.name,
    a.tier,
    a.level,
    a.limitBreak ?? 0,
    a.hp,
    a.maxHp,
    a.atk,
    a.def,
    a.spd,
    a.shield ?? 0,
    a.defending ? 1 : 0,
    a.alive ? 1 : 0,
    (a.statuses ?? []).map((s) => `${s.kind}:${s.turns}`).join(","),
  ].join("|");
}

function slotPosition(side: "player" | "cpu", slotIdx: number): THREE.Vector3 {
  const x = SLOT_XS[slotIdx] ?? 0;
  const z = side === "cpu" ? -1.65 : 1.68;
  return new THREE.Vector3(x, 1.02, z);
}

export default function LllBattleScene3D({
  actors,
  currentActorKey,
  targetableKeys,
  guideTargetKey,
  vfx,
  vfxNonce,
  shakeIntensity,
  isBossOrAbyss = false,
  onActorTap,
  onFail,
  fallback,
  height = 360,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  const stageRef = useRef<Stage | null>(null);
  const nodesRef = useRef<Map<string, ActorSlotNode>>(new Map());
  const sparksRef = useRef<Spark[]>([]);
  const beamsRef = useRef<Beam[]>([]);
  const glowTexRef = useRef<THREE.Texture | null>(null);
  const backTexRef = useRef<THREE.Texture | null>(null);
  const onActorTapRef = useRef(onActorTap);
  onActorTapRef.current = onActorTap;

  const currentKeyRef = useRef<string | null>(currentActorKey);
  currentKeyRef.current = currentActorKey;
  const targetableRef = useRef<Set<string>>(new Set(targetableKeys));
  targetableRef.current = new Set(targetableKeys);
  const guideKeyRef = useRef<string | null>(guideTargetKey);
  guideKeyRef.current = guideTargetKey;

  const simClockRef = useRef(0);

  // ステージ初期化（アンマウントまで維持）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let ambientParticles: THREE.Points | null = null;
    let circleMesh: THREE.Mesh | null = null;

    const stage = createStage(el, {
      background: isBossOrAbyss ? 0x13091f : 0x0d0a1b,
      camera: { position: [0, 5.9, 6.8], lookAt: [0, 0.35, 0.0], fov: 42 },
      pixelRatioCap: 2,
      onFrame: (dt, t) => {
        simClockRef.current = t;
        if (circleMesh) circleMesh.rotation.z = t * 0.11;

        if (ambientParticles) {
          const pos = ambientParticles.geometry.getAttribute("position") as THREE.BufferAttribute;
          for (let i = 0; i < pos.count; i++) {
            let y = pos.getY(i) + dt * 0.35;
            if (y > 3.6) y = 0.08;
            pos.setY(i, y);
          }
          pos.needsUpdate = true;
          ambientParticles.rotation.y = t * 0.04;
        }

        const nowMs = performance.now();
        const curKey = currentKeyRef.current;
        const targets = targetableRef.current;
        const guideKey = guideKeyRef.current;

        for (const node of nodesRef.current.values()) {
          const isCur = node.key === curKey && node.alive;
          const isTgt = targets.has(node.key) && node.alive;
          const isGuide = node.key === guideKey && node.alive;

          // 位置（突進 + 浮遊 + 戦闘不能沈下）
          const bob = node.alive ? Math.sin(t * 2.2 + node.basePos.x * 1.1) * 0.055 : 0;
          const curY = (node.alive ? node.basePos.y + bob : 0.45) + (isCur ? 0.12 : 0);
          let px = node.basePos.x;
          let py = curY;
          let pz = node.basePos.z;

          if (nowMs < node.lungeEndAt) {
            const p = 1 - (node.lungeEndAt - nowMs) / 360;
            const arc = Math.sin(Math.max(0, Math.min(1, p)) * Math.PI);
            px = THREE.MathUtils.lerp(node.lungeFrom.x, node.lungeTo.x, arc * 0.72);
            pz = THREE.MathUtils.lerp(node.lungeFrom.z, node.lungeTo.z, arc * 0.72);
            py += arc * 0.42;
          }

          if (nowMs < node.recoilUntil) {
            const r = (node.recoilUntil - nowMs) / 260;
            pz += (node.side === "player" ? 0.24 : -0.24) * r;
            node.frameMat.emissive.setHex(0xff5247);
            node.frameMat.emissiveIntensity = 1.4 * r;
          } else {
            node.frameMat.emissive.setHex(
              isGuide ? 0xf5c518 : isTgt ? 0xff4d4d : isCur ? 0xf5c518 : 0x000000,
            );
            node.frameMat.emissiveIntensity = isGuide ? 0.9 : isTgt ? 0.65 + Math.sin(t * 6) * 0.25 : isCur ? 0.55 : 0;
          }

          node.root.position.set(px, py, pz);

          // 傾き（生存時は手前向きに少し起こす、ダウン時は寝かせる）
          const targetRotX = node.alive ? (node.side === "cpu" ? -0.22 : -0.34) : -1.25;
          node.cardPivot.rotation.x += (targetRotX - node.cardPivot.rotation.x) * Math.min(1, dt * 10 || 1);
          const wobbleZ = node.alive && isCur ? Math.sin(t * 3.1) * 0.04 : 0;
          node.cardPivot.rotation.z = wobbleZ;

          // 足元リング
          node.ringMesh.position.set(node.basePos.x, 0.025, node.basePos.z);
          if (isGuide || isCur) {
            node.ringMesh.visible = true;
            node.ringMat.color.setHex(0xf5c518);
            const s = 1 + Math.sin(t * 5) * 0.08;
            node.ringMesh.scale.set(s, s, 1);
          } else if (isTgt) {
            node.ringMesh.visible = true;
            node.ringMat.color.setHex(0xff5a52);
            const s = 1.05 + Math.sin(t * 8) * 0.1;
            node.ringMesh.scale.set(s, s, 1);
          } else {
            node.ringMesh.visible = false;
          }

          if (node.shieldDome.visible) {
            node.shieldDome.rotation.y = t * 0.9;
          }
          if (node.statusOrb.visible) {
            node.statusOrb.rotation.y = t * 2.4;
            node.statusOrb.position.y = CARD_H * 0.62 + Math.sin(t * 4) * 0.06;
          }
        }

        // ビーム・飛翔体更新
        const activeBeams: Beam[] = [];
        for (const b of beamsRef.current) {
          const p = (nowMs - b.born) / b.life;
          if (p >= 1) {
            stage?.scene.remove(b.mesh);
            b.mesh.geometry.dispose();
            (b.mesh.material as THREE.Material).dispose();
            continue;
          }
          b.mesh.position.lerpVectors(b.from, b.to, p);
          b.mesh.position.y += Math.sin(p * Math.PI) * 0.65;
          b.mesh.rotation.y += dt * 14;
          activeBeams.push(b);
        }
        beamsRef.current = activeBeams;

        // パーティクル更新
        const activeSparks: Spark[] = [];
        for (const sp of sparksRef.current) {
          const p = (nowMs - sp.born) / sp.life;
          if (p >= 1) {
            stage?.scene.remove(sp.mesh);
            (sp.mesh.material as THREE.Material).dispose();
            continue;
          }
          sp.vel.y -= sp.gravity * dt;
          sp.mesh.position.addScaledVector(sp.vel, dt);
          const sc = sp.startScale * (1 - p * 0.75);
          sp.mesh.scale.set(sc, sc, 1);
          (sp.mesh.material as THREE.SpriteMaterial).opacity = 1 - p;
          activeSparks.push(sp);
        }
        sparksRef.current = activeSparks;
      },
    });

    if (!stage) {
      setFailed(true);
      onFail();
      return;
    }

    stageRef.current = stage;
    glowTexRef.current = createGlowSpriteTexture();
    backTexRef.current = createCardBackTexture();

    // 祭壇フロア + 魔方陣
    const floor = new THREE.Mesh(
      new THREE.CylinderGeometry(5.6, 5.9, 0.28, 48),
      new THREE.MeshStandardMaterial({
        color: isBossOrAbyss ? 0x1a102b : 0x17132a,
        roughness: 0.72,
        metalness: 0.25,
      }),
    );
    floor.position.y = -0.15;
    stage.scene.add(floor);

    const circleTex = createArenaCircleTexture(isBossOrAbyss ? "#e36a61" : "#7c5cff");
    circleMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(8.8, 8.8),
      new THREE.MeshBasicMaterial({
        map: circleTex,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      }),
    );
    circleMesh.rotation.x = -Math.PI / 2;
    circleMesh.position.y = 0.006;
    stage.scene.add(circleMesh);

    // 各スロットの台座マーカー
    for (const side of ["cpu", "player"] as const) {
      for (let i = 0; i < 3; i++) {
        const pos = slotPosition(side, i);
        const pad = new THREE.Mesh(
          new THREE.RingGeometry(0.42, 0.56, 32),
          new THREE.MeshBasicMaterial({
            color: side === "cpu" ? 0xe36a61 : 0x7c5cff,
            transparent: true,
            opacity: 0.35,
            side: THREE.DoubleSide,
          }),
        );
        pad.rotation.x = -Math.PI / 2;
        pad.position.set(pos.x, 0.012, pos.z);
        stage.scene.add(pad);
      }
    }

    // 浮遊マナ粒子
    const moteCount = 46;
    const positions = new Float32Array(moteCount * 3);
    for (let i = 0; i < moteCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 8.4;
      positions[i * 3 + 1] = Math.random() * 3.5;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 6.5;
    }
    const moteGeo = new THREE.BufferGeometry();
    moteGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    ambientParticles = new THREE.Points(
      moteGeo,
      new THREE.PointsMaterial({
        color: isBossOrAbyss ? 0xff9a8a : 0xbba6ff,
        size: 0.14,
        map: glowTexRef.current,
        transparent: true,
        opacity: 0.65,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    stage.scene.add(ambientParticles);

    const detach = attachPickPointer(
      stage,
      () => [...nodesRef.current.values()].map((n) => n.cardPivot),
      {
        onTap: (hit) => {
          let obj: THREE.Object3D | null = hit?.object ?? null;
          while (obj) {
            if (typeof obj.userData.actorKey === "string") {
              onActorTapRef.current(obj.userData.actorKey);
              return;
            }
            obj = obj.parent;
          }
        },
      },
    );

    const nodes = nodesRef.current;
    setReady(true);
    return () => {
      detach();
      nodes.clear();
      sparksRef.current = [];
      beamsRef.current = [];
      glowTexRef.current?.dispose();
      backTexRef.current?.dispose();
      stage.dispose();
      stageRef.current = null;
    };
  }, [isBossOrAbyss, onFail]);

  // アクター配列の変更に応じてカードノードを生成・更新
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const cpus = actors.filter((a) => a.side === "cpu");
    const players = actors.filter((a) => a.side === "player");
    const slotMap = new Map<string, number>();
    cpus.forEach((a, idx) => slotMap.set(a.key, idx));
    players.forEach((a, idx) => slotMap.set(a.key, idx));

    const seenKeys = new Set<string>();
    for (const actor of actors) {
      seenKeys.add(actor.key);
      const slotIdx = slotMap.get(actor.key) ?? 0;
      const basePos = slotPosition(actor.side, slotIdx);
      const sig = actorSignature(actor);
      const cardInput: ThreeCardInput = { ...actor, showHpBar: true };

      let node = nodesRef.current.get(actor.key);
      if (!node) {
        const root = new THREE.Group();
        root.position.copy(basePos);

        const cardPivot = new THREE.Group();
        cardPivot.userData.actorKey = actor.key;
        root.add(cardPivot);

        const { texture, redraw } = createCardFaceTexture(cardInput);
        const frameMat = new THREE.MeshStandardMaterial({
          color: TIER_NUM[actor.tier] ?? 0x6f7794,
          roughness: actor.tier === "normal" ? 0.6 : 0.3,
          metalness: actor.tier === "legend" ? 0.65 : 0.3,
        });
        const faceMat = new THREE.MeshBasicMaterial({ map: texture });
        const backMat = new THREE.MeshBasicMaterial({ map: backTexRef.current ?? texture });

        const box = new THREE.Mesh(new THREE.BoxGeometry(CARD_W, CARD_H, CARD_D), [
          frameMat,
          frameMat,
          frameMat,
          frameMat,
          faceMat,
          backMat,
        ]);
        box.userData.actorKey = actor.key;
        cardPivot.add(box);

        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xf5c518,
          transparent: true,
          opacity: 0.85,
          side: THREE.DoubleSide,
        });
        const ringMesh = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.78, 36), ringMat);
        ringMesh.rotation.x = -Math.PI / 2;
        ringMesh.position.set(basePos.x, 0.025, basePos.z);
        ringMesh.visible = false;
        stage.scene.add(ringMesh);

        const shieldDome = new THREE.Mesh(
          new THREE.SphereGeometry(1.06, 16, 12),
          new THREE.MeshBasicMaterial({
            color: 0x7ac3ff,
            wireframe: true,
            transparent: true,
            opacity: 0.32,
          }),
        );
        shieldDome.visible = (actor.shield ?? 0) > 0;
        root.add(shieldDome);

        const statusOrb = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.16, 0),
          new THREE.MeshBasicMaterial({ color: 0xffa15c }),
        );
        statusOrb.position.set(0, CARD_H * 0.62, 0.1);
        statusOrb.visible = (actor.statuses?.length ?? 0) > 0;
        root.add(statusOrb);

        stage.scene.add(root);

        node = {
          key: actor.key,
          side: actor.side,
          basePos,
          root,
          cardPivot,
          frameMat,
          faceMat,
          redrawFace: redraw,
          ringMesh,
          ringMat,
          shieldDome,
          statusOrb,
          signature: sig,
          alive: actor.alive !== false,
          lungeEndAt: 0,
          lungeFrom: basePos.clone(),
          lungeTo: basePos.clone(),
          recoilUntil: 0,
        };
        nodesRef.current.set(actor.key, node);
      } else {
        node.basePos.copy(basePos);
        node.alive = actor.alive !== false;
        node.shieldDome.visible = (actor.shield ?? 0) > 0 && node.alive;
        node.statusOrb.visible = (actor.statuses?.length ?? 0) > 0 && node.alive;
        if (node.signature !== sig) {
          node.signature = sig;
          node.redrawFace(cardInput);
          node.frameMat.color.setHex(TIER_NUM[actor.tier] ?? 0x6f7794);
        }
      }
    }

    for (const [key, node] of nodesRef.current.entries()) {
      if (!seenKeys.has(key)) {
        stage.scene.remove(node.root);
        stage.scene.remove(node.ringMesh);
        nodesRef.current.delete(key);
      }
    }
  }, [actors]);

  // VFX ステップの発火（ビーム・粒子・突進・カメラシェイク＆ヒットストップ）
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !vfx || vfxNonce === 0) return;
    const nowMs = performance.now();
    const tex = glowTexRef.current;

    const spawnBurst = (pos: THREE.Vector3, colorHex: number, count: number, upward = false) => {
      if (!tex) return;
      for (let i = 0; i < count; i++) {
        const mat = new THREE.SpriteMaterial({
          map: tex,
          color: colorHex,
          transparent: true,
          opacity: 1,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const sprite = new THREE.Sprite(mat);
        sprite.position.copy(pos);
        const angle = Math.random() * Math.PI * 2;
        const speed = 1.6 + Math.random() * 2.8;
        const vel = upward
          ? new THREE.Vector3(Math.cos(angle) * 0.9, 1.8 + Math.random() * 1.8, Math.sin(angle) * 0.9)
          : new THREE.Vector3(Math.cos(angle) * speed, 0.8 + Math.random() * 2.2, Math.sin(angle) * speed);
        stage.scene.add(sprite);
        sparksRef.current.push({
          mesh: sprite,
          vel,
          gravity: upward ? -0.5 : 4.2,
          born: nowMs,
          life: 480 + Math.random() * 260,
          startScale: 0.28 + Math.random() * 0.22,
        });
      }
    };

    const elColor = ELEMENT_NUM[vfx.element] ?? 0xffe47a;
    const fromNode = vfx.fromKey ? nodesRef.current.get(vfx.fromKey) : undefined;
    const toNode = vfx.toKey ? nodesRef.current.get(vfx.toKey) : undefined;

    if (vfx.kind === "attack" && toNode) {
      if (fromNode && fromNode.key !== toNode.key) {
        fromNode.lungeFrom.copy(fromNode.basePos);
        fromNode.lungeTo.copy(toNode.basePos);
        fromNode.lungeEndAt = nowMs + 360;

        const orb = new THREE.Mesh(
          new THREE.OctahedronGeometry(vfx.strong ? 0.26 : 0.18, 1),
          new THREE.MeshBasicMaterial({ color: elColor }),
        );
        orb.position.copy(fromNode.basePos);
        stage.scene.add(orb);
        beamsRef.current.push({
          mesh: orb,
          from: fromNode.basePos.clone(),
          to: toNode.basePos.clone(),
          born: nowMs,
          life: 230,
        });
      }
      toNode.recoilUntil = nowMs + 260;
      spawnBurst(toNode.basePos.clone().add(new THREE.Vector3(0, 0.15, 0.1)), elColor, vfx.strong ? 22 : 14);
    } else if (vfx.kind === "heal" && toNode) {
      spawnBurst(toNode.basePos.clone().add(new THREE.Vector3(0, -0.3, 0)), 0x57c785, 16, true);
    } else if (vfx.kind === "shield" && toNode) {
      spawnBurst(toNode.basePos.clone(), 0x8bc2ff, 12, true);
    } else if (vfx.kind === "status" && toNode) {
      spawnBurst(toNode.basePos.clone(), elColor, 12);
    } else if (vfx.kind === "ko" && toNode) {
      toNode.recoilUntil = nowMs + 320;
      spawnBurst(toNode.basePos.clone(), 0xf5c518, 24);
      spawnBurst(toNode.basePos.clone(), 0xe36a61, 16);
    }

    if (shakeIntensity > 0) {
      stage.hitstop(shakeIntensity);
      stage.shake(shakeIntensity);
    }
  }, [vfx, vfxNonce, shakeIntensity]);

  return (
    <SceneBox
      height={height}
      label="LLL 3Dバトルアリーナ"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background={isBossOrAbyss ? "#13091f" : "#0d0a1b"}
      radius={12}
    />
  );
}
