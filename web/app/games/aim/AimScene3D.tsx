"use client";
// エイムの 3D シーン。空間内の立体ターゲット（円盤 + 同心リング）を表示する。
// 出現スケジュール・命中判定・得点は lib/aim.ts とクライアントが持ち、
// ここは表現と入力の橋渡しだけ: 的は親状態（targets）から差分同期し、
// タップ位置はレイキャスト点を lib と同じ統一単位（横幅=100）へ変換して
// 既存の shootAt へ渡す（3D 側で命中判定は再実装しない）。
// 的の出現はスケール + 発光、消滅は縮小で表現する。
// スコア・残り時間は親の DOM 併記が正。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import { AIM_FIELD_HEIGHT, AIM_FIELD_WIDTH, type AimTarget } from "@/lib/aim";

interface Props {
  targets: AimTarget[];
  /** 統一単位（x: 0〜100、y: 0〜75）での射撃。判定はクライアント/lib が行う。 */
  onShoot: (x: number, y: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

/** 統一単位 → ワールド座標のスケール。 */
const S = 0.05;
const toWorldX = (x: number) => (x - AIM_FIELD_WIDTH / 2) * S;
const toWorldY = (y: number) => (AIM_FIELD_HEIGHT / 2 - y) * S;
const toFieldX = (wx: number) => wx / S + AIM_FIELD_WIDTH / 2;
const toFieldY = (wy: number) => AIM_FIELD_HEIGHT / 2 - wy / S;

/** 2D 版の同心円配色（基本点の tier ごと）。絵文字は使わず材質色で表す。 */
function tierColors(points: number): { outer: number; mid: number } {
  if (points >= 30) return { outer: 0xd8542e, mid: 0xffd23e };
  if (points >= 20) return { outer: 0xb33a1e, mid: 0xff9a3e };
  return { outer: 0x8f2d1a, mid: 0xe85d4a };
}

interface TargetEntry {
  group: THREE.Group;
  mats: THREE.MeshStandardMaterial[];
  appearAt: number;
  dyingAt: number | null;
  durationMs: number;
}

function makeTarget(t: AimTarget): TargetEntry {
  const r = t.radius * S;
  const { outer, mid } = tierColors(t.points);
  const mats: THREE.MeshStandardMaterial[] = [];
  const mat = (color: number) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.5, emissive: color, emissiveIntensity: 0.25 });
    mats.push(m);
    return m;
  };
  const group = new THREE.Group();
  const bodyGeo = new THREE.CylinderGeometry(r, r, 0.07, 28);
  bodyGeo.rotateX(Math.PI / 2);
  const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.6 }));
  body.userData.pickId = "target";
  group.add(body);
  const ring = (radius: number, z: number, color: number) => {
    const m = new THREE.Mesh(new THREE.CircleGeometry(radius, 28), mat(color));
    m.position.z = z;
    m.userData.pickId = "target";
    group.add(m);
  };
  ring(r * 0.96, 0.037, outer);
  ring(r * 0.6, 0.044, mid);
  ring(r * 0.3, 0.051, 0xffffff);
  group.position.set(toWorldX(t.x), toWorldY(t.y), 0);
  group.scale.setScalar(0.01);
  return { group, mats, appearAt: performance.now(), dyingAt: null, durationMs: t.durationMs };
}

interface SceneRt {
  targetsGroup: THREE.Group;
  entries: Map<number, TargetEntry>;
}

export default function AimScene3D({ targets, onShoot, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ targets, onShoot });
  propsRef.current = { targets, onShoot };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x141c26,
      camera: { position: [0, 0, 6.2], lookAt: [0, 0, 0], fov: 42 },
      onFrame: () => {
        const rt = rtRef.current;
        if (!rt) return;
        const now = performance.now();
        const cur = propsRef.current.targets;
        const seen = new Set<number>();
        // 出現の差分同期: 新規はスケールイン + 発光、残存は経過で発光を落とす。
        for (const t of cur) {
          seen.add(t.id);
          let e = rt.entries.get(t.id);
          if (!e) {
            e = makeTarget(t);
            rt.entries.set(t.id, e);
            rt.targetsGroup.add(e.group);
          }
          e.dyingAt = null;
          const age = now - e.appearAt;
          const pop = Math.min(1, age / 160);
          const ease = 1 - Math.pow(1 - pop, 3);
          e.group.scale.setScalar(Math.max(0.01, ease));
          const life = Math.min(1, age / Math.max(1, e.durationMs));
          const glow = 0.35 * (1 - life) + 0.08;
          for (const m of e.mats) m.emissiveIntensity = glow;
        }
        // 消滅: 状態から消えた的は縮小してから外す（命中・時間切れ共通）。
        for (const [id, e] of [...rt.entries]) {
          if (seen.has(id)) continue;
          if (e.dyingAt === null) e.dyingAt = now;
          const k = Math.min(1, (now - e.dyingAt) / 130);
          e.group.scale.setScalar(Math.max(0.01, 1 - k));
          for (const m of e.mats) m.emissiveIntensity = 0.5 * (1 - k);
          if (k >= 1) {
            rt.targetsGroup.remove(e.group);
            rt.entries.delete(id);
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

    // 背後の壁（フィールド枠つき）。ここへのタップも射撃として座標を渡す。
    const wallTex = canvasTexture("aim-wall", 640, 426, (g) => {
      g.fillStyle = "#1a2635";
      g.fillRect(0, 0, 640, 426);
      g.strokeStyle = "rgba(255,255,255,0.05)";
      g.lineWidth = 1;
      for (let x = 0; x <= 640; x += 40) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 426); g.stroke(); }
      for (let y = 0; y <= 426; y += 40) { g.beginPath(); g.moveTo(0, y); g.lineTo(640, y); g.stroke(); }
      // フィールド (5 x 3.75 world) の枠。壁 9 x 6 world に対する割合で描く。
      g.strokeStyle = "rgba(216,84,46,0.8)";
      g.lineWidth = 4;
      g.strokeRect((2 / 9) * 640, (1.125 / 6) * 426, (5 / 9) * 640, (3.75 / 6) * 426);
    });
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 6),
      new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.9 }),
    );
    wall.position.z = -0.06;
    wall.userData.pickId = "wall";
    scene.add(wall);
    // 奥行き付けの側壁
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x10161f, roughness: 0.95 });
    for (const sx of [-1, 1]) {
      const side = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 6), sideMat);
      side.position.set(sx * 5.2, 0, 1.2);
      side.rotation.y = -sx * 0.9;
      scene.add(side);
    }

    const targetsGroup = new THREE.Group();
    scene.add(targetsGroup);
    rtRef.current = { targetsGroup, entries: new Map() };

    detach = attachPickPointer(
      stage,
      () => [wall, targetsGroup],
      {
        onTap: (hit) => {
          if (!hit) return;
          // レイキャスト点を lib の統一単位へ戻して既存ハンドラへ渡すだけ。
          propsRef.current.onShoot(toFieldX(hit.point.x), toFieldY(hit.point.y));
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

  return (
    <SceneBox
      height={420}
      label="エイムの的 (3D)。的をタップして撃ちます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#141c26"
    />
  );
}
