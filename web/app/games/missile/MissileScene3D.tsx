"use client";
// ミサイル防衛の 3D シーン。空＋都市/基地の造形、飛来ミサイル（軌跡つき）、
// 迎撃弾と爆発球を立体表現する。
// 物理・判定は lib/missile.ts の固定ステップが決め、ここは親の最新状態を
// getState() で毎フレーム読み、onFrame で補間追従するだけ（airhockey の型）。
// 3D 側で当たり判定はしない。爆風の半径も lib の blastRadius を使う。
// 入力: 空の面へのレイキャスト点 → 既存ハンドラ onFire の座標系
// （FIELD_W × FIELD_H）へ変換して渡す（2D の SVG タップと同じハンドラ）。
// スコア・ウェーブ・残弾等の数字は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import {
  FIELD_H,
  FIELD_W,
  GROUND_Y,
  blastRadius,
  enemyPosition,
  interceptorPosition,
  type MissileState,
} from "@/lib/missile";

interface Props {
  /** 親の固定ステップが進める最新の状態を読む (React 再描画を介さない)。 */
  getState: () => MissileState;
  onFire: (x: number, y: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const WORLD_W = 10;
const WORLD_H = 6;
const GROUND_WORLD_Y = (1 - GROUND_Y / FIELD_H) * WORLD_H; // 0.4
const toWorldX = (gx: number) => (gx / FIELD_W - 0.5) * WORLD_W;
const toWorldY = (gy: number) => (1 - gy / FIELD_H) * WORLD_H;
const toGameX = (wx: number) => (wx / WORLD_W + 0.5) * FIELD_W;
const toGameY = (wy: number) => (1 - wy / WORLD_H) * FIELD_H;

function makeCity(): { alive: THREE.Group; rubble: THREE.Mesh } {
  const alive = new THREE.Group();
  const tex = canvasTexture("missile-city", 96, 96, (g) => {
    g.fillStyle = "#aebfd8";
    g.fillRect(0, 0, 96, 96);
    g.fillStyle = "#ffe9a3";
    for (let y = 10; y < 88; y += 18) {
      for (let x = 10; x < 84; x += 18) g.fillRect(x, y, 9, 10);
    }
  });
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 });
  const main = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.34, 0.4), mat);
  main.position.y = 0.17;
  alive.add(main);
  const tower = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.48, 0.42), mat);
  tower.position.y = 0.24;
  alive.add(tower);
  const rubble = new THREE.Mesh(
    new THREE.BoxGeometry(0.44, 0.08, 0.4),
    new THREE.MeshStandardMaterial({ color: 0x555f6b, roughness: 0.9 }),
  );
  rubble.position.y = 0.04;
  return { alive, rubble };
}

function makeBase(): { alive: THREE.Group; rubble: THREE.Mesh } {
  const alive = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xc8b06a, roughness: 0.65 });
  const pyramid = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.36, 0.3, 4), mat);
  pyramid.rotation.y = Math.PI / 4;
  pyramid.position.y = 0.15;
  alive.add(pyramid);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), new THREE.MeshStandardMaterial({ color: 0x8a6d2f, roughness: 0.4 }));
  tip.position.y = 0.34;
  alive.add(tip);
  const rubble = new THREE.Mesh(
    new THREE.BoxGeometry(0.48, 0.08, 0.42),
    new THREE.MeshStandardMaterial({ color: 0x555f6b, roughness: 0.9 }),
  );
  rubble.position.y = 0.04;
  return { alive, rubble };
}

function makeMissile(color: number, headColor: number): THREE.Group {
  const grp = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.045, 0.26, 10),
    new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.3 }),
  );
  grp.add(body);
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.12, 10), new THREE.MeshStandardMaterial({ color: headColor, roughness: 0.3 }));
  head.position.y = 0.19;
  grp.add(head);
  return grp;
}

interface Tracked {
  group: THREE.Group;
  trail: THREE.Line;
  trailGeo: THREE.BufferGeometry;
  spawn: THREE.Vector3;
  sig: string;
}

interface SceneRt {
  structures: Array<{ alive: THREE.Group; rubble: THREE.Mesh }>;
  enemies: Map<number, Tracked>;
  interceptors: Map<number, Tracked>;
  blasts: THREE.Mesh[];
  blastGroup: THREE.Group;
  fxGroup: THREE.Group;
}

const UP = new THREE.Vector3(0, 1, 0);

function orientAlong(obj: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3) {
  const dir = new THREE.Vector3().subVectors(to, from);
  if (dir.lengthSq() < 1e-8) return;
  dir.normalize();
  obj.quaternion.setFromUnitVectors(UP, dir);
}

export default function MissileScene3D({ getState, onFire, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ getState, onFire });
  propsRef.current = { getState, onFire };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x0b1026,
      camera: { position: [0, 3.1, 9.2], lookAt: [0, 2.9, 0], fov: 40 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        const s = propsRef.current.getState();
        // 構造物: 生存/壊滅の切り替えだけ（判定は lib 済み）。
        s.structures.forEach((st, i) => {
          const entry = rt.structures[i];
          if (!entry) return;
          entry.alive.visible = st.alive;
          entry.rubble.visible = !st.alive;
        });
        const kFast = Math.min(1, dt * 60);
        const kMissile = Math.min(1, dt * 30);
        const syncTracked = (
          pool: Map<number, Tracked>,
          items: Array<{ key: number; sx: number; sy: number; pos: { x: number; y: number }; tx: number; ty: number }>,
          make: () => THREE.Group,
          k: number,
          trailColor: number,
        ) => {
          const seen = new Set<number>();
          for (const it of items) {
            seen.add(it.key);
            const sig = `${it.sx},${it.sy},${it.tx},${it.ty}`;
            let tr = pool.get(it.key);
            if (tr && tr.sig !== sig) {
              // 迎撃弾は index キーなので、別弾への差し替わりでは軌跡ごと作り直す。
              rt.fxGroup.remove(tr.group);
              rt.fxGroup.remove(tr.trail);
              pool.delete(it.key);
              tr = undefined;
            }
            if (!tr) {
              const group = make();
              const spawn = new THREE.Vector3(toWorldX(it.sx), toWorldY(it.sy), 0);
              group.position.copy(spawn);
              const trailGeo = new THREE.BufferGeometry().setFromPoints([spawn, spawn.clone()]);
              const trail = new THREE.Line(
                trailGeo,
                new THREE.LineBasicMaterial({ color: trailColor, transparent: true, opacity: 0.6 }),
              );
              rt.fxGroup.add(trail);
              rt.fxGroup.add(group);
              tr = { group, trail, trailGeo, spawn, sig };
              pool.set(it.key, tr);
            }
            const target = new THREE.Vector3(toWorldX(it.pos.x), toWorldY(it.pos.y), 0);
            tr.group.position.lerp(target, k);
            if (tr.group.position.distanceToSquared(target) > 4) tr.group.position.copy(target);
            orientAlong(tr.group, new THREE.Vector3(toWorldX(it.sx), toWorldY(it.sy), 0), new THREE.Vector3(toWorldX(it.tx), toWorldY(it.ty), 0));
            tr.trailGeo.setFromPoints([tr.spawn, tr.group.position.clone()]);
          }
          for (const [key, tr] of [...pool]) {
            if (seen.has(key)) continue;
            rt.fxGroup.remove(tr.group);
            rt.fxGroup.remove(tr.trail);
            pool.delete(key);
          }
        };
        syncTracked(
          rt.enemies,
          s.enemies.map((m) => ({ key: m.id, sx: m.sx, sy: m.sy, pos: enemyPosition(m), tx: m.tx, ty: m.ty })),
          () => makeMissile(0xd8dee6, 0xff5c5c),
          kMissile,
          0xff9d5c,
        );
        syncTracked(
          rt.interceptors,
          s.interceptors.map((m, i) => ({ key: i, sx: m.sx, sy: m.sy, pos: interceptorPosition(m), tx: m.tx, ty: m.ty })),
          () => makeMissile(0x9fd8ff, 0xcfeaff),
          kFast,
          0x9fd8ff,
        );
        // 爆発球: lib の blastRadius をそのまま半径にする（判定には使わない）。
        while (rt.blasts.length < s.blasts.length) {
          const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(1, 20, 14),
            new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.45, depthWrite: false }),
          );
          rt.blastGroup.add(sphere);
          rt.blasts.push(sphere);
        }
        while (rt.blasts.length > s.blasts.length) {
          const sphere = rt.blasts.pop()!;
          rt.blastGroup.remove(sphere);
        }
        s.blasts.forEach((b, i) => {
          const sphere = rt.blasts[i];
          sphere.position.set(toWorldX(b.x), toWorldY(b.y), 0);
          const r = Math.max(0.001, blastRadius(b.ageSteps) / 100);
          sphere.scale.setScalar(r);
        });
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // 空（背面の大きな面がピック対象も兼ねる）
    const skyTex = canvasTexture("missile-sky", 32, 256, (g) => {
      const grad = g.createLinearGradient(0, 0, 0, 256);
      grad.addColorStop(0, "#0b1026");
      grad.addColorStop(1, "#1b2a4a");
      g.fillStyle = grad;
      g.fillRect(0, 0, 32, 256);
    });
    const sky = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD_W, WORLD_H),
      new THREE.MeshBasicMaterial({ map: skyTex }),
    );
    sky.position.set(0, WORLD_H / 2, -0.35);
    sky.userData.pickId = "sky";
    scene.add(sky);
    // 星（小さな点）
    const starMat = new THREE.MeshBasicMaterial({ color: 0xcfe0ff });
    for (let i = 0; i < 26; i++) {
      const star = new THREE.Mesh(new THREE.PlaneGeometry(0.045, 0.045), starMat);
      star.position.set(-4.8 + ((i * 37) % 96) / 10, 3.4 + ((i * 53) % 24) / 10, -0.3);
      scene.add(star);
    }
    // 地面
    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(WORLD_W, GROUND_WORLD_Y, 1.1),
      new THREE.MeshStandardMaterial({ color: 0x2e4a2f, roughness: 0.9 }),
    );
    ground.position.set(0, GROUND_WORLD_Y / 2, 0);
    scene.add(ground);

    // 構造物（初期状態の並びで造形し、生存表示は onFrame で切り替える）
    const s0 = propsRef.current.getState();
    const structures: SceneRt["structures"] = [];
    for (const st of s0.structures) {
      const built = st.kind === "city" ? makeCity() : makeBase();
      built.alive.position.set(toWorldX(st.x), GROUND_WORLD_Y, 0);
      built.rubble.position.set(toWorldX(st.x), GROUND_WORLD_Y, 0);
      built.rubble.visible = !st.alive;
      built.alive.visible = st.alive;
      scene.add(built.alive);
      scene.add(built.rubble);
      // rubble は alive グループとは別位置管理のため、座標をグループ基準に合わせる
      structures.push(built);
    }

    const fxGroup = new THREE.Group();
    scene.add(fxGroup);
    const blastGroup = new THREE.Group();
    scene.add(blastGroup);

    rtRef.current = { structures, enemies: new Map(), interceptors: new Map(), blasts: [], blastGroup, fxGroup };

    detach = attachPickPointer(
      stage,
      () => [sky],
      {
        onTap: (hit) => {
          if (!hit) return;
          // レイキャスト平面の点を既存ハンドラの座標系 (FIELD_W × FIELD_H) へ変換。
          propsRef.current.onFire(toGameX(hit.point.x), toGameY(hit.point.y));
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
      height={460}
      label="ミサイル防衛（3D）。空をタップした地点へ迎撃弾を撃ちます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#0b1026"
    />
  );
}
