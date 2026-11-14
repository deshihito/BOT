"use client";
// クレーンゲームの 3D シーン。ガラスケース風の筐体、レール上のクレーン、
// アーム/爪、丸みのある景品（球・箱・円柱・トーラス等の組合せ、絵文字なし）。
// クレーンの往復・降下・掴み判定は lib/cranegame.ts が決め、ここは状態へ
// 補間追従し、下降→掴む→上昇→排出シュートへの移動→落下をアニメーションで
// 見せるだけ（取得成否は既存ロジックの result のとおりに表現する）。
// 入力: タップ = 「とめる」（現行ボタンと同一。aimX で横、aimY で奥行き確定）。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createBall } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import { CRANE_DROP_MS, type CranePhase, type CranePrize, type CraneResult } from "@/lib/cranegame";

interface Props {
  prizes: CranePrize[];
  craneX: number;
  craneY: number;
  phase: CranePhase;
  dropElapsedMs: number;
  grabX: number | null;
  grabY: number | null;
  result: CraneResult | null;
  seed: number;
  onStop: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const WORLD_W = 6.4;
const WORLD_D = 4.6;
const TOP_Y = 3.35;
const xFor = (v: number) => ((v - 50) / 100) * WORLD_W;
const zFor = (v: number) => ((v - 50) / 100) * WORLD_D;
const sizeFor = (radius: number) => (radius / 100) * WORLD_W;

function hex(color: string): number {
  return parseInt(color.slice(1), 16);
}

/** 景品の造形（種類ごとに球・箱・円柱・トーラスの組合せ）。 */
function makePrize(p: CranePrize): THREE.Group {
  const grp = new THREE.Group();
  const r = Math.max(0.26, sizeFor(p.radius) * 0.52);
  const mat = new THREE.MeshStandardMaterial({ color: hex(p.color), roughness: 0.55 });
  if (p.kind === 0 || p.kind === 2) {
    // クマ/ネコ: 球体＋耳2つ。
    grp.add(createBall(r, hex(p.color), { roughness: 0.55 }));
    for (const sx of [-1, 1]) {
      const ear = createBall(r * 0.38, hex(p.color), { roughness: 0.55 });
      ear.position.set(sx * r * 0.72, r * 0.78, 0);
      grp.add(ear);
    }
  } else if (p.kind === 1) {
    // ウサギ: 球体＋長い耳（細い円柱2本）。
    grp.add(createBall(r, hex(p.color), { roughness: 0.55 }));
    for (const sx of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.16, r * 0.2, r * 1.1, 10), mat);
      ear.position.set(sx * r * 0.4, r * 1.25, 0);
      ear.rotation.z = sx * -0.18;
      grp.add(ear);
    }
  } else if (p.kind === 3) {
    // パンダ: 白い球＋黒い耳＋黒い目の帯（小さな黒球2つ）。
    grp.add(createBall(r, 0xeeeeee, { roughness: 0.55 }));
    for (const sx of [-1, 1]) {
      const ear = createBall(r * 0.36, 0x212121, { roughness: 0.6 });
      ear.position.set(sx * r * 0.72, r * 0.78, 0);
      grp.add(ear);
      const eye = createBall(r * 0.16, 0x212121, { roughness: 0.5 });
      eye.position.set(sx * r * 0.38, r * 0.15, r * 0.88);
      grp.add(eye);
    }
  } else if (p.kind === 4) {
    // ドーナツクッション: トーラス。
    const torus = new THREE.Mesh(new THREE.TorusGeometry(r * 0.85, r * 0.42, 12, 24), mat);
    torus.rotation.x = Math.PI / 2;
    grp.add(torus);
  } else if (p.kind === 5) {
    // 星のクッション: 扁平な球＋小さな球5つを周囲に。
    const core = createBall(r, hex(p.color), { roughness: 0.55 });
    core.scale.y = 0.62;
    grp.add(core);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const tip = createBall(r * 0.34, hex(p.color), { roughness: 0.55 });
      tip.position.set(Math.cos(a) * r * 0.95, 0, Math.sin(a) * r * 0.95);
      grp.add(tip);
    }
  } else if (p.kind === 6) {
    // プレゼント箱: 箱＋リボン（細い箱2本）。
    const box = new THREE.Mesh(new THREE.BoxGeometry(r * 1.7, r * 1.35, r * 1.7), mat);
    grp.add(box);
    const ribbonMat = new THREE.MeshStandardMaterial({ color: 0xffd54f, roughness: 0.4 });
    const r1 = new THREE.Mesh(new THREE.BoxGeometry(r * 1.74, r * 0.34, r * 0.4), ribbonMat);
    r1.position.y = r * 0.2;
    grp.add(r1);
    const r2 = new THREE.Mesh(new THREE.BoxGeometry(r * 0.4, r * 0.34, r * 1.74), ribbonMat);
    r2.position.y = r * 0.2;
    grp.add(r2);
  } else {
    // ケーキの置物: 円柱2段＋上の球。
    const lower = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.05, r * 0.8, 20), mat);
    lower.position.y = -r * 0.25;
    grp.add(lower);
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.68, r * 0.68, r * 0.55, 20), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
    upper.position.y = r * 0.42;
    grp.add(upper);
    const top = createBall(r * 0.3, 0xc2255c, { roughness: 0.35 });
    top.position.y = r * 0.95;
    grp.add(top);
  }
  grp.userData.pickId = `prize-${p.id}`;
  return grp;
}

interface CarryState {
  prizeId: number;
  startedAt: number;
  grabPos: THREE.Vector3;
}

export default function CraneScene3D({ prizes, craneX, craneY, phase, dropElapsedMs, grabX, grabY, result, seed, onStop, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<{
    scene: THREE.Scene;
    prizeGroups: Map<number, THREE.Group>;
    prizeHome: Map<number, THREE.Vector3>;
    carriage: THREE.Group;
    cable: THREE.Mesh;
    clawL: THREE.Mesh;
    clawR: THREE.Mesh;
    missMark: THREE.Group;
    carriagePos: THREE.Vector3;
    carry: CarryState | null;
    carrySeed: number;
  } | null>(null);

  const propsRef = useRef({ prizes, craneX, craneY, phase, dropElapsedMs, grabX, grabY, result, seed, onStop });
  propsRef.current = { prizes, craneX, craneY, phase, dropElapsedMs, grabX, grabY, result, seed, onStop };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0xfdf3d8,
      camera: { position: [0, 3.4, 7.4], lookAt: [0, 1.35, 0], fov: 42 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        const p = propsRef.current;
        // 排出アニメーションの開始検出（done かつ取得成功を seed ごとに1回）。
        if (p.phase === "done" && p.result && p.result.prizeId !== null && rt.carrySeed !== p.seed) {
          rt.carrySeed = p.seed;
          rt.carry = {
            prizeId: p.result.prizeId,
            startedAt: performance.now(),
            grabPos: new THREE.Vector3(xFor(p.grabX ?? p.craneX), 0, zFor(p.grabY ?? p.craneY)),
          };
        }
        if (p.phase !== "done") {
          rt.carry = null;
          if (p.phase === "aimX" || p.phase === "aimY") rt.carrySeed = -1;
        }
        // キャリッジ目標: 通常は状態のクレーン位置、排出中はシュートへ寄る。
        const target = new THREE.Vector3(xFor(p.craneX), TOP_Y, zFor(p.phase === "aimX" ? 0 : p.craneY));
        let prizeCarried: THREE.Group | null = null;
        if (rt.carry) {
          const age = (performance.now() - rt.carry.startedAt) / 1000;
          const chute = new THREE.Vector3(-WORLD_W / 2 + 0.55, TOP_Y, WORLD_D / 2 - 0.5);
          if (age < 0.45) {
            target.copy(rt.carry.grabPos).setY(TOP_Y);
          } else if (age < 1.25) {
            const k = Math.min(1, (age - 0.45) / 0.8);
            const e = k * k * (3 - 2 * k);
            target.lerpVectors(rt.carry.grabPos.clone().setY(TOP_Y), chute, e);
          } else {
            target.copy(chute);
          }
          const grp = rt.prizeGroups.get(rt.carry.prizeId);
          if (grp) prizeCarried = grp;
        }
        rt.carriagePos.lerp(target, Math.min(1, dt * 26));
        rt.carriage.position.copy(rt.carriagePos);
        // ケーブル長と爪: dropping は sin で降りて戻る（lib の CRANE_DROP_MS に同期）。
        const ratio = p.phase === "dropping" ? Math.min(1, p.dropElapsedMs / CRANE_DROP_MS) : 0;
        const dip = p.phase === "dropping" ? Math.sin(ratio * Math.PI) : 0;
        let cableLen = 0.55 + dip * (TOP_Y - 0.95);
        if (rt.carry) {
          // 排出中: 最初は景品まで降りたまま、掴んだら吊り上げ高さへ戻す。
          const age = (performance.now() - rt.carry.startedAt) / 1000;
          cableLen = age < 0.3 ? TOP_Y - 0.95 : age < 1.25 ? 2.15 : 0.55;
        }
        rt.cable.scale.y = cableLen;
        rt.cable.position.y = -cableLen / 2;
        const clawY = TOP_Y - cableLen;
        rt.clawL.position.y = clawY - TOP_Y;
        rt.clawR.position.y = clawY - TOP_Y;
        const closing = p.phase === "dropping" && ratio > 0.7;
        const closed = closing || (rt.carry !== null && (performance.now() - rt.carry.startedAt) / 1000 < 1.25);
        const clawAngle = closed ? 0.1 : 0.48;
        rt.clawL.rotation.z += (clawAngle - rt.clawL.rotation.z) * Math.min(1, dt * 10);
        rt.clawR.rotation.z += (-clawAngle - rt.clawR.rotation.z) * Math.min(1, dt * 10);
        // 景品: 通常はホーム位置、排出中は爪の下へ追従してシュートに落ちる。
        for (const [id, grp] of rt.prizeGroups) {
          const home = rt.prizeHome.get(id);
          if (!home) continue;
          if (prizeCarried && grp === prizeCarried && rt.carry) {
            const age = (performance.now() - rt.carry.startedAt) / 1000;
            if (age < 1.25) {
              const clawWorld = new THREE.Vector3(rt.carriagePos.x, clawY - 0.32, rt.carriagePos.z);
              grp.position.lerp(clawWorld, Math.min(1, dt * 18));
            } else if (age < 1.7) {
              const bin = new THREE.Vector3(-WORLD_W / 2 + 0.55, 0.32, WORLD_D / 2 - 0.5);
              grp.position.lerp(bin, Math.min(1, dt * 10));
              grp.scale.setScalar(Math.max(0.75, 1 - (age - 1.25) * 0.4));
            }
          } else {
            grp.position.lerp(home, Math.min(1, dt * 14));
            grp.scale.setScalar(1);
          }
        }
        // ハズレ位置の ✕ マーク（done かつ取得失敗のときだけ）。
        const showMiss = p.phase === "done" && p.result !== null && p.result.prizeId === null && p.grabX !== null && p.grabY !== null;
        rt.missMark.visible = !!showMiss;
        if (showMiss) rt.missMark.position.set(xFor(p.grabX as number), 0.06, zFor(p.grabY as number));
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    // 筐体: 床＋四隅の柱＋天枠＋ガラス（薄い透明板）。
    const floorMesh = new THREE.Mesh(
      new THREE.BoxGeometry(WORLD_W + 0.5, 0.22, WORLD_D + 0.5),
      new THREE.MeshStandardMaterial({ color: 0xf7e3ae, roughness: 0.9 }),
    );
    floorMesh.position.y = -0.11;
    floorMesh.userData.pickId = "cabinet";
    scene.add(floorMesh);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x8a6d3b, roughness: 0.5, metalness: 0.3 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, TOP_Y + 0.5, 0.14), frameMat);
      post.position.set(sx * (WORLD_W / 2 + 0.18), (TOP_Y + 0.5) / 2, sz * (WORLD_D / 2 + 0.18));
      scene.add(post);
    }
    const topFrame = new THREE.Mesh(new THREE.BoxGeometry(WORLD_W + 0.5, 0.16, WORLD_D + 0.5), frameMat);
    topFrame.position.y = TOP_Y + 0.42;
    scene.add(topFrame);
    const glassMat = new THREE.MeshStandardMaterial({ color: 0xcfe8ff, roughness: 0.1, transparent: true, opacity: 0.1, depthWrite: false });
    const glassFront = new THREE.Mesh(new THREE.BoxGeometry(WORLD_W + 0.36, TOP_Y + 0.4, 0.03), glassMat);
    glassFront.position.set(0, (TOP_Y + 0.4) / 2, WORLD_D / 2 + 0.18);
    scene.add(glassFront);
    // 排出シュート（手前左の受け箱）。
    const chute = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 0.5, 0.95),
      new THREE.MeshStandardMaterial({ color: 0x37474f, roughness: 0.6 }),
    );
    chute.position.set(-WORLD_W / 2 + 0.55, 0.25, WORLD_D / 2 - 0.5);
    scene.add(chute);
    // レール（奥行き方向の移動レール＋横レールはキャリッジ側）。
    const railZ = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, WORLD_D), frameMat);
    railZ.position.set(0, TOP_Y + 0.28, 0);
    scene.add(railZ);
    // クレーン: 横レール＋キャリッジ＋ケーブル＋爪。
    const carriage = new THREE.Group();
    const railX = new THREE.Mesh(new THREE.BoxGeometry(WORLD_W, 0.1, 0.14), frameMat);
    railX.position.y = 0.22;
    carriage.add(railX);
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.62, 0.24, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x37474f, roughness: 0.45, metalness: 0.3 }),
    );
    carriage.add(body);
    const cable = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 1, 8),
      new THREE.MeshStandardMaterial({ color: 0x263238, roughness: 0.5 }),
    );
    carriage.add(cable);
    const clawGeo = new THREE.BoxGeometry(0.09, 0.55, 0.09);
    const clawMat = new THREE.MeshStandardMaterial({ color: 0x546e7a, roughness: 0.35, metalness: 0.5 });
    const clawL = new THREE.Mesh(clawGeo, clawMat);
    clawL.geometry = clawGeo.clone();
    clawL.position.x = -0.2;
    carriage.add(clawL);
    const clawR = new THREE.Mesh(clawGeo, clawMat);
    clawR.position.x = 0.2;
    carriage.add(clawR);
    carriage.position.set(xFor(0), TOP_Y, zFor(0));
    scene.add(carriage);
    // ハズレ ✕ マーク（細い箱2本の交差）。
    const missMark = new THREE.Group();
    const missMat = new THREE.MeshStandardMaterial({ color: 0xc62828, roughness: 0.5 });
    for (const rz of [Math.PI / 4, -Math.PI / 4]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.05, 0.12), missMat);
      bar.rotation.y = rz;
      missMark.add(bar);
    }
    missMark.visible = false;
    scene.add(missMark);

    rtRef.current = {
      scene,
      prizeGroups: new Map(),
      prizeHome: new Map(),
      carriage,
      cable,
      clawL,
      clawR,
      missMark,
      carriagePos: carriage.position.clone(),
      carry: null,
      carrySeed: -1,
    };
    detach = attachPickPointer(
      stage,
      () => [floorMesh, glassFront],
      {
        onTapAnywhere: () => propsRef.current.onStop(),
        onFlick: () => propsRef.current.onStop(),
      },
      { planeY: 0 },
    );
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 景品の差分同期（配置はシード決定的でゲーム中は不変、リスタートで作り直し）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const ids = new Set(prizes.map((p) => p.id));
    for (const [id, grp] of [...rt.prizeGroups]) {
      if (!ids.has(id)) {
        rt.scene.remove(grp);
        rt.prizeGroups.delete(id);
        rt.prizeHome.delete(id);
      }
    }
    for (const p of prizes) {
      const home = new THREE.Vector3(xFor(p.x), Math.max(0.26, sizeFor(p.radius) * 0.52), zFor(p.y));
      const existing = rt.prizeGroups.get(p.id);
      const prevHome = rt.prizeHome.get(p.id);
      if (!existing || !prevHome || prevHome.distanceToSquared(home) > 0.01) {
        if (existing) rt.scene.remove(existing);
        const grp = makePrize(p);
        grp.position.copy(home);
        rt.scene.add(grp);
        rt.prizeGroups.set(p.id, grp);
      }
      rt.prizeHome.set(p.id, home);
    }
  }, [prizes]);

  return (
    <SceneBox
      height={380}
      label="クレーンゲーム（3D）。タップでクレーンを止めます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#fdf3d8"
    />
  );
}
