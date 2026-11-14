"use client";
// ダーツの 3D シーン。同心円セグメントのボードを ShapeGeometry の扇形で
// 立体化し、刺さったダーツはコーン＋シャフト＋フライトで表現する。
// 最新の1投は手前から飛んで刺さるアニメーションで表示する。
// 状態・得点判定は lib/darts.ts とクライアントの onThrow が持ち、ここは
// 表現と入力の橋渡しだけ: ボードへのタップ位置（正規化座標）をそのまま
// 既存 onThrow へ渡す（2D の SVG クリックと同じ座標系・同じハンドラ）。
// 数字はボード外周に CanvasTexture で描き、スコア/ラウンドは親の DOM 併記。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import { DART_RADII, DART_SECTORS, type DartsState } from "@/lib/darts";

interface Props {
  state: DartsState;
  onThrow: (x: number, y: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

/** 上方向を 0 度・時計回りの角度から XY 平面上の点を求める（2D 版 polar と同じ）。 */
function polar(r: number, degFromTop: number): { x: number; y: number } {
  const rad = (degFromTop * Math.PI) / 180;
  return { x: r * Math.sin(rad), y: r * Math.cos(rad) };
}

/** 扇形（rInner=0 なら中心からの扇、>0 ならリングの一部）。 */
function wedgeGeo(rOuter: number, rInner: number, a0: number, a1: number): THREE.ShapeGeometry {
  const shape = new THREE.Shape();
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    const p = polar(rOuter, a0 + ((a1 - a0) * i) / steps);
    if (i === 0) shape.moveTo(p.x, p.y);
    else shape.lineTo(p.x, p.y);
  }
  if (rInner > 0) {
    for (let i = steps; i >= 0; i--) {
      const p = polar(rInner, a0 + ((a1 - a0) * i) / steps);
      shape.lineTo(p.x, p.y);
    }
  } else {
    shape.lineTo(0, 0);
  }
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

function makeDart(): THREE.Group {
  const grp = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0xb9c0c7, roughness: 0.35, metalness: 0.7 });
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.09, 10), metal);
  tip.rotation.x = -Math.PI / 2;
  tip.position.z = 0.045;
  grp.add(tip);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.3, 10), new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.5 }));
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = 0.24;
  grp.add(shaft);
  const flightMat = new THREE.MeshStandardMaterial({ color: 0xffd54a, roughness: 0.55, side: THREE.DoubleSide });
  for (const rot of [0, Math.PI / 2]) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.09, 0.004), flightMat);
    fin.position.z = 0.4;
    fin.rotation.z = rot;
    grp.add(fin);
  }
  return grp;
}

interface DartEntry {
  group: THREE.Group;
  anim: { start: number; from: THREE.Vector3; to: THREE.Vector3 } | null;
}

interface SceneRt {
  boardGroup: THREE.Group;
  dartsGroup: THREE.Group;
  entries: Map<number, DartEntry>;
}

export default function DartsScene3D({ state, onThrow, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onThrow });
  propsRef.current = { onThrow };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x2a2f36,
      camera: { position: [0, 0.15, 3.4], lookAt: [0, 0, 0], fov: 42 },
      onFrame: () => {
        const rt = rtRef.current;
        if (!rt) return;
        const now = performance.now();
        for (const e of rt.entries.values()) {
          if (!e.anim) continue;
          const k = Math.min(1, Math.max(0, (now - e.anim.start) / 240));
          const ease = 1 - Math.pow(1 - k, 2);
          e.group.position.lerpVectors(e.anim.from, e.anim.to, ease);
          if (k >= 1) {
            e.group.position.copy(e.anim.to);
            e.anim = null;
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

    const boardGroup = new THREE.Group();
    scene.add(boardGroup);
    // 背板（2D の外周の黒い円に相当。ここへの着弾は MISS 座標として渡る）
    const backing = new THREE.Mesh(
      new THREE.CylinderGeometry(1.18, 1.18, 0.07, 48),
      new THREE.MeshStandardMaterial({ color: 0x22252a, roughness: 0.7 }),
    );
    backing.rotation.x = Math.PI / 2;
    backing.position.z = -0.045;
    backing.userData.pickId = "board";
    boardGroup.add(backing);

    const redMat = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.6 });
    const greenMat = new THREE.MeshStandardMaterial({ color: 0x1e8449, roughness: 0.6 });
    const blackMat = new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.65 });
    const creamMat = new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 0.65 });
    DART_SECTORS.forEach((num, i) => {
      const a0 = i * 18 - 9;
      const a1 = i * 18 + 9;
      const colorMat = i % 2 === 0 ? redMat : greenMat;
      const baseMat = i % 2 === 0 ? blackMat : creamMat;
      const outer = new THREE.Mesh(wedgeGeo(DART_RADII.doubleOuter, 0, a0, a1), colorMat);
      outer.position.z = 0.0;
      outer.userData.pickId = "board";
      boardGroup.add(outer);
      const inner = new THREE.Mesh(wedgeGeo(DART_RADII.doubleInner, 0, a0, a1), baseMat);
      inner.position.z = 0.006;
      inner.userData.pickId = "board";
      boardGroup.add(inner);
      const triple = new THREE.Mesh(wedgeGeo(DART_RADII.tripleOuter, DART_RADII.tripleInner, a0, a1), colorMat);
      triple.position.z = 0.012;
      triple.userData.pickId = "board";
      boardGroup.add(triple);
      // 数字（外周）。DOM 併記のスコアとは別に、ボード上の目印として描く。
      const tex = canvasTexture(`dart-num-${num}`, 72, 72, (g) => {
        g.clearRect(0, 0, 72, 72);
        g.fillStyle = "#f5f5f5";
        g.font = "bold 40px sans-serif";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(String(num), 36, 38);
      });
      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(0.17, 0.17),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
      );
      const lp = polar(1.1, i * 18);
      label.position.set(lp.x, lp.y, 0.01);
      boardGroup.add(label);
    });
    const bullOuter = new THREE.Mesh(new THREE.CircleGeometry(DART_RADII.bullOuter, 28), greenMat);
    bullOuter.position.z = 0.012;
    bullOuter.userData.pickId = "board";
    boardGroup.add(bullOuter);
    const bullInner = new THREE.Mesh(new THREE.CircleGeometry(DART_RADII.bullInner, 20), redMat);
    bullInner.position.z = 0.018;
    bullInner.userData.pickId = "board";
    boardGroup.add(bullInner);

    const dartsGroup = new THREE.Group();
    scene.add(dartsGroup);
    rtRef.current = { boardGroup, dartsGroup, entries: new Map() };

    detach = attachPickPointer(
      stage,
      () => [boardGroup],
      {
        onTap: (hit) => {
          if (!hit) return;
          // ワールド座標 = ボード中心原点の正規化座標（半径1 = ダブル外周）。
          propsRef.current.onThrow(hit.point.x, hit.point.y);
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

  // 投擲の差分同期。新規のダーツは手前から飛んで刺さる。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const darts = state.rounds.flat();
    for (const [idx, e] of [...rt.entries]) {
      if (idx >= darts.length) {
        rt.dartsGroup.remove(e.group);
        rt.entries.delete(idx);
      }
    }
    darts.forEach((d, idx) => {
      if (rt.entries.has(idx)) return;
      const group = makeDart();
      const to = new THREE.Vector3(d.x, d.y, 0.01);
      const from = new THREE.Vector3(d.x * 0.8, d.y * 0.8 + 0.35, 2.4);
      group.position.copy(from);
      rt.dartsGroup.add(group);
      rt.entries.set(idx, { group, anim: { start: performance.now(), from, to } });
    });
  }, [state]);

  return (
    <SceneBox
      height={420}
      label="ダーツボード（3D）。ボードをタップした位置に投げます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#2a2f36"
    />
  );
}
