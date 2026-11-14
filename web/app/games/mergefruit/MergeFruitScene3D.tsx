"use client";
// フルーツマージの 3D シーン。箱（6列×10行）とフルーツ球を 3D 化する。
// 落下・合体・連鎖の判定は lib/mergefruit.ts が決め、ここは盤面スナップ
// ショットへ補間追従するだけ（3D 側で合体判定はしない）。フルーツは
// 絵文字テクスチャを使わず、段階ごとの色つき球体＋大きさで表現する。
// 入力: ポインタの x で列を選び（planePoint で追従）、タップでその列へ落とす
// （現行のマス/列タップと同一）。次のフルーツは箱の上に球で予告する。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createBall } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import { FRUIT_KINDS, landingRow, MERGE_COLS, MERGE_ROWS } from "@/lib/mergefruit";

interface Props {
  board: (number | null)[];
  current: number;
  next: number;
  hoverCol: number | null;
  status: "playing" | "gameover";
  onHoverCol: (col: number) => void;
  onDrop: (col: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const CELL = 0.82;
const BOX_W = MERGE_COLS * CELL;
const BOX_H = MERGE_ROWS * CELL;
const radiusFor = (level: number) => 0.24 + level * 0.018;
const colorFor = (level: number) => parseInt(FRUIT_KINDS[level].color.slice(1), 16);
const xForCol = (c: number) => (c - (MERGE_COLS - 1) / 2) * CELL;
const yForRow = (r: number) => (MERGE_ROWS - 1 - r) * CELL + CELL / 2;
interface FruitRt {
  mesh: THREE.Mesh;
  level: number;
  born: number;
  popAt: number;
}

export default function MergeFruitScene3D({ board, current, next, hoverCol, status, onHoverCol, onDrop, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<{
    scene: THREE.Scene;
    fruits: Map<number, FruitRt>;
    preview: THREE.Mesh;
    previewNext: THREE.Mesh;
    ghost: THREE.Mesh;
    guide: THREE.Mesh;
  } | null>(null);

  const propsRef = useRef({ board, current, next, hoverCol, status, onHoverCol, onDrop });
  propsRef.current = { board, current, next, hoverCol, status, onHoverCol, onDrop };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x20262e,
      camera: { position: [0, 4.9, 9.8], lookAt: [0, 4.15, 0], fov: 42 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        const p = propsRef.current;
        const k = Math.min(1, dt * 13);
        for (const [idx, fr] of rt.fruits) {
          const r = Math.floor(idx / MERGE_COLS);
          const c = idx % MERGE_COLS;
          fr.mesh.position.x += (xForCol(c) - fr.mesh.position.x) * k;
          fr.mesh.position.z += (0 - fr.mesh.position.z) * k;
          // 落下は重みを付けて収束させる（上から落ちてきて着地で止まる）。
          fr.mesh.position.y += (yForRow(r) - fr.mesh.position.y) * Math.min(1, dt * 11);
          // 合体で大きくなった直後のポップ。
          const age = (performance.now() - fr.popAt) / 380;
          const s = age < 1 ? 1 + Math.sin(age * Math.PI) * 0.3 : 1;
          fr.mesh.scale.setScalar(s);
          void fr.born;
        }
        // 予告: 現在のフルーツは選択列の上に浮き、次のフルーツは右上に小さく浮く。
        const col = p.hoverCol ?? Math.floor(MERGE_COLS / 2);
        const showPreview = p.status === "playing";
        rt.preview.visible = showPreview;
        rt.previewNext.visible = showPreview;
        rt.guide.visible = showPreview;
        if (showPreview) {
          rt.preview.position.x += (xForCol(col) - rt.preview.position.x) * Math.min(1, dt * 18);
          rt.preview.position.y = BOX_H + 0.62;
          const pr = radiusFor(p.current);
          rt.preview.scale.setScalar(pr / radiusFor(0));
          (rt.preview.material as THREE.MeshStandardMaterial).color.setHex(colorFor(p.current));
          rt.previewNext.position.set(BOX_W / 2 + 0.15, BOX_H + 0.62, 0);
          const nr = radiusFor(p.next);
          rt.previewNext.scale.setScalar((nr / radiusFor(0)) * 0.72);
          (rt.previewNext.material as THREE.MeshStandardMaterial).color.setHex(colorFor(p.next));
          rt.guide.position.x = rt.preview.position.x;
          // 着地ゴースト（半透明）は landingRow の結果位置に置く（判定は lib の関数）。
          const gr = landingRow(p.board, col);
          rt.ghost.visible = gr >= 0;
          if (gr >= 0) {
            rt.ghost.position.set(xForCol(col), yForRow(gr), 0);
            rt.ghost.scale.setScalar(pr / radiusFor(0));
            (rt.ghost.material as THREE.MeshStandardMaterial).color.setHex(colorFor(p.current));
          }
        } else {
          rt.ghost.visible = false;
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    // 箱: 背板＋左右壁＋底＋天井ライン（赤）。
    const back = new THREE.Mesh(
      new THREE.BoxGeometry(BOX_W + 0.24, BOX_H + 0.24, 0.18),
      new THREE.MeshStandardMaterial({ color: 0x2c3644, roughness: 0.85 }),
    );
    back.position.set(0, BOX_H / 2, -0.32);
    back.userData.pickId = "board";
    scene.add(back);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x54677f, roughness: 0.6 });
    for (const sx of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.14, BOX_H + 0.3, 0.7), wallMat);
      wall.position.set(sx * (BOX_W / 2 + 0.07), BOX_H / 2, 0);
      wall.userData.pickId = "board";
      scene.add(wall);
    }
    const floor = new THREE.Mesh(new THREE.BoxGeometry(BOX_W + 0.3, 0.16, 0.8), wallMat);
    floor.position.set(0, -0.08, 0);
    floor.userData.pickId = "board";
    scene.add(floor);
    const ceiling = new THREE.Mesh(
      new THREE.BoxGeometry(BOX_W + 0.24, 0.07, 0.5),
      new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.5 }),
    );
    ceiling.position.set(0, BOX_H + 0.05, 0);
    scene.add(ceiling);
    // 列ガイド（選択列の縦帯）。
    const guide = new THREE.Mesh(
      new THREE.BoxGeometry(CELL - 0.06, BOX_H, 0.04),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, transparent: true, opacity: 0.1 }),
    );
    guide.position.set(0, BOX_H / 2, -0.18);
    scene.add(guide);
    const preview = createBall(radiusFor(0), colorFor(0), { roughness: 0.3 });
    preview.position.set(0, BOX_H + 0.62, 0);
    scene.add(preview);
    const previewNext = createBall(radiusFor(0), colorFor(0), { roughness: 0.3 });
    scene.add(previewNext);
    const ghost = createBall(radiusFor(0), colorFor(0), { roughness: 0.4 });
    (ghost.material as THREE.MeshStandardMaterial).transparent = true;
    (ghost.material as THREE.MeshStandardMaterial).opacity = 0.35;
    scene.add(ghost);
    rtRef.current = { scene, fruits: new Map(), preview, previewNext, ghost, guide };

    const colFromPoint = (pt: THREE.Vector3) => {
      const c = Math.round((pt.x - xForCol(0)) / CELL);
      return Math.max(0, Math.min(MERGE_COLS - 1, c));
    };
    detach = attachPickPointer(
      stage,
      () => [back, floor],
      {
        onHover: (hit) => { if (hit) propsRef.current.onHoverCol(colFromPoint(hit.point)); },
        onDragMove: (point) => propsRef.current.onHoverCol(colFromPoint(point)),
        onTap: (hit) => {
          if (!hit) return;
          const col = colFromPoint(hit.point);
          propsRef.current.onHoverCol(col);
          propsRef.current.onDrop(col);
        },
      },
      { planeY: BOX_H / 2, hover: true },
    );
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 盤面の差分同期。新規は箱の上から、合体で段階が変わったマスはポップさせる。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const seen = new Set<number>();
    board.forEach((v, idx) => {
      if (v === null) return;
      seen.add(idx);
      const fr = rt.fruits.get(idx);
      if (!fr) {
        const mesh = createBall(radiusFor(v), colorFor(v), { roughness: 0.3 });
        const r = Math.floor(idx / MERGE_COLS);
        const c = idx % MERGE_COLS;
        mesh.position.set(xForCol(c), BOX_H + 0.9, 0);
        void r;
        rt.scene.add(mesh);
        rt.fruits.set(idx, { mesh, level: v, born: performance.now(), popAt: 0 });
      } else if (fr.level !== v) {
        fr.level = v;
        fr.popAt = performance.now();
        const mesh = createBall(radiusFor(v), colorFor(v), { roughness: 0.3 });
        mesh.position.copy(fr.mesh.position);
        rt.scene.remove(fr.mesh);
        rt.scene.add(mesh);
        fr.mesh = mesh;
      }
    });
    for (const [idx, fr] of [...rt.fruits]) {
      if (!seen.has(idx)) {
        rt.scene.remove(fr.mesh);
        rt.fruits.delete(idx);
      }
    }
  }, [board]);

  return (
    <SceneBox
      height={430}
      label="フルーツマージ（3D）。列を選んでタップで落とします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#20262e"
    />
  );
}
