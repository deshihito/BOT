"use client";
// モグラたたきの 3D シーン。土マウンド＋穴から立体モグラが出入りする。
// 出現スケジュール・得点・コンボは lib/mole.ts とクライアントが持ち、ここは
// 表現と入力の橋渡しだけ:
//   穴（マウンド/穴/モグラ本体）のタップ = 既存 whack（穴 index）
//   出現/消滅は親の active 状態の差分で上下アニメーションに追従させる
//   叩かれたモグラは沈み＋扁平（scale.y を潰す）で反応する
// 種類の区別は現行 2D と対応させる: 通常 = 茶色、金 = 金色の体＋穴まわりの金リング。
// 絵文字は使わず、色と造形だけで区別する。スコア・残り時間は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { MoleKind } from "@/lib/mole";

export interface MoleActive3D {
  hole: number;
  kind: MoleKind;
  hit: boolean;
  id: number;
}

interface Props {
  active: MoleActive3D[];
  onWhack: (hole: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.55;
const HIDDEN_Y = -1.1;
const UP_Y = 0.14;
const HIT_Y = -0.55;
const NORMAL_COLOR = 0x8d6e63;
const GOLD_COLOR = 0xe8c832;

function holePos(hole: number): [number, number] {
  const col = hole % 3;
  const row = Math.floor(hole / 3);
  return [(col - 1) * PITCH, (row - 1) * PITCH];
}

function findPickId(obj: THREE.Object3D | null): string | null {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    const id = cur.userData.pickId as string | undefined;
    if (id) return id;
    cur = cur.parent;
  }
  return null;
}

interface HoleRt {
  moleGroup: THREE.Group;
  bodyMat: THREE.MeshStandardMaterial;
  ring: THREE.Mesh;
  curY: number;
  curScaleY: number;
  targetY: number;
  targetScaleY: number;
  up: boolean;
}

export default function MoleScene3D({ active, onWhack, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<{ holes: HoleRt[] } | null>(null);
  const propsRef = useRef({ onWhack });
  propsRef.current = { onWhack };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x9fc7e8,
      camera: { position: [0, 5.6, 5.4], lookAt: [0, 0, 0.3], fov: 42 },
      onFrame: (dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        rt.holes.forEach((h, i) => {
          const k = Math.min(1, dt * 13);
          h.curY += (h.targetY - h.curY) * k;
          h.curScaleY += (h.targetScaleY - h.curScaleY) * Math.min(1, dt * 16);
          const bob = h.up && h.targetY === UP_Y ? Math.sin(t * 3 + i * 1.7) * 0.022 : 0;
          h.moleGroup.position.y = h.curY + bob;
          h.moleGroup.scale.y = h.curScaleY;
        });
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(5.9, 0.25, 5.9),
      new THREE.MeshStandardMaterial({ color: 0x6a9a52, roughness: 0.95 }),
    );
    ground.position.y = -0.13;
    scene.add(ground);

    const holesGroup = new THREE.Group();
    scene.add(holesGroup);
    const holes: HoleRt[] = [];
    const moundGeo = new THREE.CylinderGeometry(0.5, 0.7, 0.24, 20);
    const moundMat = new THREE.MeshStandardMaterial({ color: 0x6d4c41, roughness: 0.95 });
    const holeGeo = new THREE.CircleGeometry(0.4, 20);
    const holeMat = new THREE.MeshStandardMaterial({ color: 0x17100a, roughness: 1 });
    const pickGeo = new THREE.CircleGeometry(0.78, 20);
    const bellyMat = new THREE.MeshStandardMaterial({ color: 0xd7ccc8, roughness: 0.7 });
    const noseMat = new THREE.MeshStandardMaterial({ color: 0x4e342e, roughness: 0.5 });
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x212121, roughness: 0.35 });
    const toothMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });

    for (let hole = 0; hole < 9; hole++) {
      const [x, z] = holePos(hole);
      const cell = new THREE.Group();
      cell.position.set(x, 0, z);
      const pickId = `hole-${hole}`;

      const mound = new THREE.Mesh(moundGeo, moundMat);
      mound.position.y = 0.12;
      mound.userData.pickId = pickId;
      cell.add(mound);
      const holeDisc = new THREE.Mesh(holeGeo, holeMat);
      holeDisc.rotation.x = -Math.PI / 2;
      holeDisc.position.y = 0.245;
      holeDisc.userData.pickId = pickId;
      cell.add(holeDisc);
      // セル全面をタップ対象にする透明な受け皿（2D のボタン全面タップに合わせる）。
      const pickDisc = new THREE.Mesh(
        pickGeo,
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
      );
      pickDisc.rotation.x = -Math.PI / 2;
      pickDisc.position.y = 0.27;
      pickDisc.userData.pickId = pickId;
      cell.add(pickDisc);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.54, 0.032, 8, 28),
        new THREE.MeshStandardMaterial({ color: 0xe8c832, emissive: 0x8a6d1f, emissiveIntensity: 0.6, roughness: 0.35 }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.25;
      ring.visible = false;
      cell.add(ring);

      // モグラ本体: 胴＋頭＋耳＋口元＋鼻＋目＋前歯のプリミティブ造形（2D の SVG と同じ要素）。
      const bodyMat = new THREE.MeshStandardMaterial({ color: NORMAL_COLOR, roughness: 0.75 });
      const moleGroup = new THREE.Group();
      moleGroup.position.y = HIDDEN_Y;
      const addPart = (mesh: THREE.Mesh) => {
        mesh.userData.pickId = pickId;
        moleGroup.add(mesh);
      };
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.34, 18, 14), bodyMat);
      body.scale.y = 1.15;
      body.position.y = 0.34;
      addPart(body);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 18, 14), bodyMat);
      head.position.y = 0.8;
      addPart(head);
      for (const sx of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), bodyMat);
        ear.position.set(sx * 0.19, 1.0, 0);
        addPart(ear);
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.033, 8, 8), eyeMat);
        eye.position.set(sx * 0.1, 0.86, 0.24);
        addPart(eye);
      }
      const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), bellyMat);
      muzzle.scale.set(1.15, 0.8, 0.9);
      muzzle.position.set(0, 0.71, 0.21);
      addPart(muzzle);
      const nose = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), noseMat);
      nose.position.set(0, 0.78, 0.33);
      addPart(nose);
      const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.02), toothMat);
      tooth.position.set(0, 0.6, 0.3);
      addPart(tooth);
      cell.add(moleGroup);

      holesGroup.add(cell);
      holes.push({
        moleGroup,
        bodyMat,
        ring,
        curY: HIDDEN_Y,
        curScaleY: 1,
        targetY: HIDDEN_Y,
        targetScaleY: 1,
        up: false,
      });
    }

    rtRef.current = { holes };

    detach = attachPickPointer(
      stage,
      () => [holesGroup],
      {
        onTap: (hit) => {
          const id = findPickId(hit?.object ?? null);
          if (!id || !id.startsWith("hole-")) return;
          propsRef.current.onWhack(Number(id.slice("hole-".length)));
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

  // 出現状態の差分同期: 出現でせり上がり、ヒットで沈み＋扁平、消滅で沈む。
  // 金モグラは体の色と穴まわりのリングで区別する（2D の金背景＋星印に対応）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    rt.holes.forEach((h, hole) => {
      const entry = active.find((a) => a.hole === hole);
      if (!entry) {
        h.targetY = HIDDEN_Y;
        h.targetScaleY = 1;
        h.up = false;
        h.ring.visible = false;
        return;
      }
      h.bodyMat.color.setHex(entry.kind === "gold" ? GOLD_COLOR : NORMAL_COLOR);
      h.bodyMat.emissive.setHex(entry.kind === "gold" ? 0x6b5410 : 0x000000);
      h.bodyMat.emissiveIntensity = entry.kind === "gold" ? 0.35 : 0;
      h.ring.visible = entry.kind === "gold" && !entry.hit;
      h.up = !entry.hit;
      h.targetY = entry.hit ? HIT_Y : UP_Y;
      h.targetScaleY = entry.hit ? 0.45 : 1;
    });
  }, [active, ready]);

  return (
    <SceneBox
      height={400}
      label="モグラたたき（3D）。穴から出たモグラをタップして叩きます。金モグラは高得点です"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#9fc7e8"
    />
  );
}
