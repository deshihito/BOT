"use client";
// 2x2キューブの 3D シーン。回転する立方体そのものを本体として造形する:
// 小キューブ8個＋面ステッカー（色は lib/cube.ts のステッカー状態そのまま）。
// ロジック（置換・勝敗）は lib が持ち、ここは表示と入力の橋渡しだけ:
//   面回転アニメーションは、クライアントが渡す lastMove（＝lib へ適用済みの手）を
//   検出して該当レイヤーを 90 度回すだけ。3D 側で置換や回転可否は判定しない。
//   アニメーション中は移動前の色のまま小キューブを物理的に回し、着地した瞬間に
//   lib の新しいステッカー状態へ色を差し替える（置換結果と一致する）。
// 入力の分岐（掴んだ対象で決める。現行の「面ごとの ⟳⟲」語彙の 3D 翻訳）:
//   - キューブ面（ステッカー/芯）を掴んだドラッグ → 面操作。
//     タップ（移動なし）= 掴んだ面を時計回り（⟳ に対応）。
//     スワイプ = ドラッグ方向へその層を回す（方向から軸と CW/CCW を決める。
//     反時計回りは ⟲ に対応し、2x2 では全ての層が面なので全12手に届く）。
//   - 背景（当たり判定用の球・地面）を掴んだドラッグ → 視点回転（カメラの周回）。
//     面操作とは掴んだ瞬間に分岐するので、回転中に視点は動かない。
// 手数・ベスト・状態文は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { CubeColor, CubeFace, CubeMove, CubeState } from "@/lib/cube";

interface Props {
  stickers: CubeState["stickers"];
  status: CubeState["status"];
  /** 直近に lib へ適用された手。seq は手ごとに増える連番（再戦時は null）。 */
  lastMove: { move: CubeMove; seq: number } | null;
  onMove: (move: CubeMove) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const COLOR_INT: Record<CubeColor, number> = {
  white: 0xf8f8f8,
  yellow: 0xffd93b,
  green: 0x2ecc71,
  blue: 0x3498db,
  orange: 0xff8c1a,
  red: 0xe74c3c,
};

// lib/cube.ts のステッカー定義と同じ並び（面順 U,D,F,B,L,R × [左上,右上,左下,右下]）。
// 位置（±1）と法線から 24 スロットを組み立て、stickers[index] の色を引くための
// レイアウト表。回転の置換そのものは lib 側にしか置かない。
type SlotDef = { pos: [number, number, number]; normal: [number, number, number] };
function buildSlots(): SlotDef[] {
  const defs: SlotDef[] = [];
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const)
    defs.push({ pos: [x, 1, z], normal: [0, 1, 0] });
  for (const [x, z] of [[-1, 1], [1, 1], [-1, -1], [1, -1]] as const)
    defs.push({ pos: [x, -1, z], normal: [0, -1, 0] });
  for (const [x, y] of [[-1, 1], [1, 1], [-1, -1], [1, -1]] as const)
    defs.push({ pos: [x, y, 1], normal: [0, 0, 1] });
  for (const [x, y] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const)
    defs.push({ pos: [x, y, -1], normal: [0, 0, -1] });
  for (const [z, y] of [[-1, 1], [1, 1], [-1, -1], [1, -1]] as const)
    defs.push({ pos: [-1, y, z], normal: [-1, 0, 0] });
  for (const [z, y] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const)
    defs.push({ pos: [1, y, z], normal: [1, 0, 0] });
  return defs;
}
const SLOTS = buildSlots();

/** 法線ベクトル（支配軸）から面を引く。 */
function faceFromNormal(n: THREE.Vector3): CubeFace {
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  if (ax >= ay && ax >= az) return n.x > 0 ? "R" : "L";
  if (ay >= ax && ay >= az) return n.y > 0 ? "U" : "D";
  return n.z > 0 ? "F" : "B";
}

// 面回転の見た目パラメータ（外側から見て時計回り = その面の外向き法線まわり -90 度。
// lib の座標回転と一致する符号）。prime（反時計回り）は符号を反転するだけ。
const MOVE_VISUAL: Record<CubeFace, { axis: "x" | "y" | "z"; layer: number; cwAngle: number }> = {
  U: { axis: "y", layer: 0.5, cwAngle: -Math.PI / 2 },
  D: { axis: "y", layer: -0.5, cwAngle: Math.PI / 2 },
  R: { axis: "x", layer: 0.5, cwAngle: -Math.PI / 2 },
  L: { axis: "x", layer: -0.5, cwAngle: Math.PI / 2 },
  F: { axis: "z", layer: 0.5, cwAngle: -Math.PI / 2 },
  B: { axis: "z", layer: -0.5, cwAngle: Math.PI / 2 },
};
const ANIM_MS = 220;

function findPickId(obj: THREE.Object3D | null): string | null {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    const id = cur.userData.pickId as string | undefined;
    if (id) return id;
    cur = cur.parent;
  }
  return null;
}

interface StickerRt {
  mat: THREE.MeshStandardMaterial;
  slot: number;
}
interface AnimRt {
  move: CubeMove;
  targetStickers: CubeColor[];
  pivot: THREE.Group;
  cubies: THREE.Group[];
  axis: "x" | "y" | "z";
  angle: number;
  start: number;
}
interface SceneRt {
  cubeGroup: THREE.Group;
  cubies: THREE.Group[];
  stickers: StickerRt[];
  anim: AnimRt | null;
  queue: Array<{ move: CubeMove; stickers: CubeColor[] }>;
  seenSeq: number;
  // 入力分岐の状態
  dragMode: "orbit" | "face" | null;
  dragSlot: { pos: THREE.Vector3; normal: THREE.Vector3 } | null;
  lastPlane: THREE.Vector3 | null;
  orbit: { theta: number; phi: number; radius: number; tTheta: number; tPhi: number };
}

function easeOutCubic(k: number): number {
  return 1 - Math.pow(1 - k, 3);
}

export default function CubeScene3D({ stickers, status, lastMove, onMove, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onMove, stickers });
  propsRef.current = { onMove, stickers };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  const applyColors = (rt: SceneRt, next: CubeColor[]) => {
    for (const s of rt.stickers) {
      s.mat.color.setHex(COLOR_INT[next[s.slot]] ?? 0xcccccc);
    }
  };

  const startNextAnim = (rt: SceneRt) => {
    if (rt.anim) return;
    const next = rt.queue.shift();
    if (!next) return;
    const face = next.move[0] as CubeFace;
    const prime = next.move.endsWith("'");
    const vis = MOVE_VISUAL[face];
    const pivot = new THREE.Group();
    rt.cubeGroup.parent?.add(pivot);
    const cubies = rt.cubies.filter((c) => Math.abs(c.position[vis.axis] - vis.layer) < 0.01);
    for (const c of cubies) pivot.attach(c);
    rt.anim = {
      move: next.move,
      targetStickers: next.stickers,
      pivot,
      cubies,
      axis: vis.axis,
      angle: prime ? -vis.cwAngle : vis.cwAngle,
      start: performance.now(),
    };
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    // onFrame は createStage の引数内で定義するため、生成後のカメラを後から差す。
    let stageCam: THREE.PerspectiveCamera | null = null;
    const stage = createStage(container, {
      background: 0x22252a,
      camera: { position: [0, 3.4, 6.8], lookAt: [0, 0, 0], fov: 42 },
      onFrame: (_dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        // 視点回転（カメラの周回）: 目標角へなめらかに追従する。
        if (stageCam) {
          const o = rt.orbit;
          o.theta += (o.tTheta - o.theta) * 0.22;
          o.phi += (o.tPhi - o.phi) * 0.22;
          const sp = Math.sin(o.phi);
          stageCam.position.set(
            o.radius * sp * Math.sin(o.theta),
            o.radius * Math.cos(o.phi),
            o.radius * sp * Math.cos(o.theta),
          );
          stageCam.lookAt(0, 0, 0);
        }
        void t;
        // 面回転アニメーション
        const anim = rt.anim;
        if (anim) {
          const k = Math.min(1, (performance.now() - anim.start) / ANIM_MS);
          anim.pivot.rotation[anim.axis] = anim.angle * easeOutCubic(k);
          if (k >= 1) {
            for (const c of anim.cubies) rt.cubeGroup.attach(c);
            anim.pivot.rotation.set(0, 0, 0);
            anim.pivot.removeFromParent();
            applyColors(rt, anim.targetStickers);
            rt.anim = null;
            startNextAnim(rt);
          }
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    stageCam = stage.camera;
    const { scene } = stage;

    // 背景の当たり判定（視点回転ドラッグの掴み先）と地面。
    const backdrop = new THREE.Mesh(
      new THREE.SphereGeometry(30, 16, 12),
      new THREE.MeshBasicMaterial({ side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false }),
    );
    backdrop.userData.pickId = "background";
    scene.add(backdrop);
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(3.6, 36),
      new THREE.MeshStandardMaterial({ color: 0x2e3238, roughness: 0.9 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1.35;
    ground.userData.pickId = "background";
    scene.add(ground);

    // キューブ本体: 小キューブ8個＋ステッカー24枚。
    const cubeGroup = new THREE.Group();
    scene.add(cubeGroup);
    const cubieMap = new Map<string, THREE.Group>();
    const stickerRts: StickerRt[] = [];
    const coreGeo = new THREE.BoxGeometry(0.96, 0.96, 0.96);
    const coreMat = new THREE.MeshStandardMaterial({ color: 0x141519, roughness: 0.45 });
    const stickerGeo = new THREE.PlaneGeometry(0.8, 0.8);
    SLOTS.forEach((slot, slotIndex) => {
      const key = slot.pos.join(",");
      let cubie = cubieMap.get(key);
      if (!cubie) {
        cubie = new THREE.Group();
        cubie.position.set(slot.pos[0] * 0.5, slot.pos[1] * 0.5, slot.pos[2] * 0.5);
        const core = new THREE.Mesh(coreGeo, coreMat);
        core.userData.pickId = `core-${key}`;
        core.userData.cubiePos = slot.pos;
        cubie.add(core);
        cubieMap.set(key, cubie);
        cubeGroup.add(cubie);
      }
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.32 });
      const sticker = new THREE.Mesh(stickerGeo, mat);
      const n = new THREE.Vector3(...slot.normal);
      sticker.position.copy(n.clone().multiplyScalar(0.49));
      sticker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      sticker.userData.pickId = `slot-${slotIndex}`;
      sticker.userData.slotPos = slot.pos;
      sticker.userData.slotNormal = slot.normal;
      cubie.add(sticker);
      stickerRts.push({ mat, slot: slotIndex });
    });
    const cubies = [...cubieMap.values()];

    const rt: SceneRt = {
      cubeGroup,
      cubies,
      stickers: stickerRts,
      anim: null,
      queue: [],
      seenSeq: 0,
      dragMode: null,
      dragSlot: null,
      lastPlane: null,
      orbit: { theta: 0, phi: 1.05, radius: 7.55, tTheta: 0, tPhi: 1.05 },
    };
    rtRef.current = rt;
    applyColors(rt, propsRef.current.stickers);

    const slotFromHit = (hit: THREE.Intersection | null): { pos: THREE.Vector3; normal: THREE.Vector3 } | null => {
      if (!hit) return null;
      const obj = hit.object;
      const posArr = obj.userData.slotPos as number[] | undefined;
      const norArr = obj.userData.slotNormal as number[] | undefined;
      if (posArr && norArr) {
        return {
          pos: new THREE.Vector3(posArr[0] * 0.5, posArr[1] * 0.5, posArr[2] * 0.5),
          normal: new THREE.Vector3(norArr[0], norArr[1], norArr[2]),
        };
      }
      const cubiePos = obj.userData.cubiePos as number[] | undefined;
      if (cubiePos) {
        // 芯（黒い隙間）を掴んだ場合は、ヒット点の支配軸をその面とみなす。
        const p = hit.point.clone();
        const normal = new THREE.Vector3();
        const ax = Math.abs(p.x);
        const ay = Math.abs(p.y);
        const az = Math.abs(p.z);
        if (ax >= ay && ax >= az) normal.set(Math.sign(p.x), 0, 0);
        else if (ay >= ax && ay >= az) normal.set(0, Math.sign(p.y), 0);
        else normal.set(0, 0, Math.sign(p.z));
        return {
          pos: new THREE.Vector3(cubiePos[0] * 0.5, cubiePos[1] * 0.5, cubiePos[2] * 0.5),
          normal,
        };
      }
      return null;
    };

    detach = attachPickPointer(
      stage,
      () => [cubeGroup, backdrop, ground],
      {
        onDragStart: (hit) => {
          const id = findPickId(hit.object);
          const slot = slotFromHit(hit);
          if (slot && id !== "background") {
            rt.dragMode = "face";
            rt.dragSlot = slot;
          } else {
            rt.dragMode = "orbit";
            rt.dragSlot = null;
            rt.lastPlane = null;
          }
        },
        onDragMove: (point) => {
          if (rt.dragMode !== "orbit") return;
          if (rt.lastPlane) {
            const dx = point.x - rt.lastPlane.x;
            const dz = point.z - rt.lastPlane.z;
            rt.orbit.tTheta = rt.orbit.tTheta - dx * 0.55;
            rt.orbit.tPhi = Math.min(1.35, Math.max(0.35, rt.orbit.tPhi + dz * 0.55));
          }
          rt.lastPlane = point.clone();
        },
        onDragEnd: (flick) => {
          const mode = rt.dragMode;
          const slot = rt.dragSlot;
          rt.dragMode = null;
          rt.dragSlot = null;
          rt.lastPlane = null;
          if (mode !== "face" || !slot) return;
          if (!flick.dir) {
            // 方向の付かない短いドラッグはタップ相当（掴んだ面を時計回り）。
            propsRef.current.onMove(faceFromNormal(slot.normal) as CubeMove);
            return;
          }
          // スワイプ: 画面方向をカメラ基準のワールド方向へ直し、
          // 回転軸 = 法線 × 方向、層 = 掴んだ位置を含む面、CW/CCW = 軸の符号。
          const cam = stage.camera;
          const right = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 0);
          const up = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 1);
          const s =
            flick.dir === "right" ? [1, 0] : flick.dir === "left" ? [-1, 0] : flick.dir === "up" ? [0, -1] : [0, 1];
          const d = right.multiplyScalar(s[0]).add(up.multiplyScalar(-s[1])).normalize();
          const axisVec = new THREE.Vector3().crossVectors(slot.normal, d);
          const ax = Math.abs(axisVec.x);
          const ay = Math.abs(axisVec.y);
          const az = Math.abs(axisVec.z);
          const axisUnit =
            ax >= ay && ax >= az
              ? new THREE.Vector3(Math.sign(axisVec.x) || 1, 0, 0)
              : ay >= ax && ay >= az
                ? new THREE.Vector3(0, Math.sign(axisVec.y) || 1, 0)
                : new THREE.Vector3(0, 0, Math.sign(axisVec.z) || 1);
          const layerSign = Math.sign(slot.pos.dot(axisUnit)) || 1;
          const faceNormal = axisUnit.clone().multiplyScalar(layerSign);
          const face = faceFromNormal(faceNormal);
          // 時計回りは外向き法線まわり -90 度なので、角速度が法線と逆向きなら CW。
          const isCw = axisVec.dot(faceNormal) < 0;
          propsRef.current.onMove((isCw ? face : `${face}'`) as CubeMove);
        },
        onTap: (hit) => {
          const slot = slotFromHit(hit);
          if (!slot) return;
          propsRef.current.onMove(faceFromNormal(slot.normal) as CubeMove);
        },
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

  // 状態遷移の検出: lastMove の seq が進んだら該当レイヤーの回転アニメーションを
  // キューへ積む。それ以外のステッカー変化（再戦など）は即時反映する。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    if (lastMove && lastMove.seq !== rt.seenSeq) {
      rt.seenSeq = lastMove.seq;
      rt.queue.push({ move: lastMove.move, stickers: [...stickers] });
      startNextAnim(rt);
      return;
    }
    if (!rt.anim && rt.queue.length === 0) applyColors(rt, stickers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stickers, lastMove]);

  // 完成時はステッカーを金色に光らせる（状態は親 DOM の文言と一致）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    for (const s of rt.stickers) {
      if (status === "won") {
        s.mat.emissive.setHex(0x8a6d1f);
        s.mat.emissiveIntensity = 0.45;
      } else {
        s.mat.emissiveIntensity = 0;
      }
    }
  }, [status, ready]);

  return (
    <SceneBox
      height={400}
      label="2x2キューブ（3D）。面をタップすると時計回り、面をなぞるとその方向に回ります。背景をドラッグすると視点が回ります"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#22252a"
    />
  );
}
