"use client";
// ナイトツアーの 3D 盤。マスの造形:
//   未訪問 = 現行 2D と同じ市松（明 #e6e2d3 / 暗 #8a9a7b）の平板
//   訪問済み = 訪問順の数字を上面テクスチャに大きく描いたタイル
//     （現行 2D の数字表示と同じ情報。色も 2D の訪問済み色に合わせる）
//   現在位置 = ナイト駒が立つ。駒は chess シーンの createKnight と同じ
//     「傾けた首＋馬頭＋耳＋たてがみ」の造形をシーン内で小さく再実装した
//     もの（chess シーン全体を import すると対戦盤のコードまでこの
//     チャンクに入るため、queens のクイーン造形と同じく再実装を選んだ）。
//   移動可能マス = 緑の円盤マーカー＋発光で示す（2D の光るマスと同じ情報）
// 移動は差分同期＋補間追従: 現在位置が変わると駒が放物線のホップで
// 次のマスへ跳ぶ。訪問順・合法手・勝敗は lib/knightstour.ts と親が持ち、
// 3D 側では再実装しない（order / moves は親の計算結果をそのまま受ける）。
// 入力は現行クライアントの操作語彙どおり:
//   タップ = onCell（既存の handleMove = moveKnight へ接続。不正なマスは
//     lib 側が同状態を返して無視するので、全マスをタップ対象にする）
// 状態表示（巡回数・時間・ベスト）は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { KtStatus } from "@/lib/knightstour";

interface Props {
  size: number;
  /** 訪問順（index → 1始まりの手数、未訪問は 0）。親が visitOrder で計算。 */
  order: number[];
  /** 次に進めるマス（親が legalMoves で計算）。 */
  moves: number[];
  /** 現在位置の index。 */
  head: number;
  status: KtStatus;
  /** タップ（現行の handleMove へ接続）。 */
  onCell: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;

function cellPos(index: number, size: number): [number, number] {
  const r = Math.floor(index / size);
  const c = index % size;
  return [(c - (size - 1) / 2) * PITCH, (r - (size - 1) / 2) * PITCH];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, size: number) {
  const w = container.clientWidth || 460;
  const h = container.clientHeight || 440;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (size / 2 + 0.9) / Math.tan(hFov / 2);
  const distD = ((size / 2 + 0.9) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.4;
  stage.setCamera({
    position: [0, dist * 0.82, dist * 0.58],
    lookAt: [0, 0, 0.2],
    fov: 42,
  });
}

/** 訪問済みタイル（上面いっぱいに訪問順の数字を大きく描く）。 */
function createVisitedTile(step: number, dark: boolean): THREE.Mesh {
  const bg = dark ? "#b8a888" : "#d8cbb0";
  const topTex = canvasTexture(`kt-visited-${step}-${dark ? "d" : "l"}`, 128, 128, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#33302a";
    g.font = "bold 76px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(step), 64, 68);
  });
  const side = new THREE.MeshStandardMaterial({ color: dark ? 0xa08c66 : 0xc4b394, roughness: 0.65 });
  const top = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.6 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.22, 0.92), [side, side, top, side, side, side]);
  mesh.position.y = 0.11;
  return mesh;
}

/**
 * ナイト駒の造形（chess シーンの createKnight を小さく再実装）。
 * 生成りの胴＋濃色の縁取りで、首・馬頭・耳・たてがみで判別する。
 */
function createKnightPiece(): THREE.Group {
  const grp = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0xf0e7d3, roughness: 0.38, metalness: 0.05 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.45 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 0.09, 24), body);
  base.position.y = 0.045;
  grp.add(base);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.028, 8, 28), trim);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.09;
  grp.add(rim);
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.44, 0.3), body);
  neck.position.set(0, 0.3, -0.03);
  neck.rotation.x = -0.38;
  grp.add(neck);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.27, 0.47), body);
  head.position.set(0, 0.56, 0.1);
  head.rotation.x = 0.55;
  grp.add(head);
  const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.16, 0.24), body);
  muzzle.position.set(0, 0.44, 0.31);
  muzzle.rotation.x = 0.2;
  grp.add(muzzle);
  for (const sx of [-0.07, 0.07]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.17, 8), trim);
    ear.position.set(sx, 0.74, -0.03);
    ear.rotation.x = -0.25;
    grp.add(ear);
  }
  const mane = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.42, 0.24), trim);
  mane.position.set(0, 0.52, -0.18);
  mane.rotation.x = -0.38;
  grp.add(mane);
  return grp;
}

interface CellRt {
  sig: string;
  grp: THREE.Group;
  markerMat: THREE.MeshStandardMaterial | null;
}

interface KnightRt {
  grp: THREE.Group;
  head: number;
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  /** ホップの進行 (0..1)。1 で着地済み。 */
  hop: number;
}

interface SceneRt {
  stage: Stage;
  tilesGroup: THREE.Group;
  hits: THREE.Mesh[];
  hitSize: number;
  cellsRt: Map<number, CellRt>;
  knight: KnightRt | null;
}

export default function KnightsTourScene3D({
  size, order, moves, head, status, onCell, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onCell });
  propsRef.current = { onCell };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x3a4149,
      camera: { position: [0, 7.5, 5.2], lookAt: [0, 0, 0.2], fov: 42 },
      onFrame: (dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        // 移動可能マーカーをゆっくり脈動させる（演出のみ）。
        const pulse = 0.45 + 0.3 * Math.sin(t * 3.2);
        for (const c of rt.cellsRt.values()) {
          if (c.markerMat) c.markerMat.emissiveIntensity = pulse;
        }
        // ナイト駒のホップ移動（現在位置の差分へ放物線で追従する）。
        const k = rt.knight;
        if (k && k.hop < 1) {
          k.hop = Math.min(1, k.hop + dt / 0.38);
          const e = k.hop;
          k.grp.position.x = k.fromX + (k.toX - k.fromX) * e;
          k.grp.position.z = k.fromZ + (k.toZ - k.fromZ) * e;
          k.grp.position.y = 0.22 + Math.sin(e * Math.PI) * 0.55;
          if (k.hop >= 1) k.grp.position.y = 0.22;
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    const tilesGroup = new THREE.Group();
    scene.add(tilesGroup);
    rtRef.current = { stage, tilesGroup, hits: [], hitSize: 0, cellsRt: new Map(), knight: null };

    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (id) propsRef.current.onCell(Number(id.slice(5)));
      },
    });
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 盤面同期: サイズが変わったら土台と当たり判定を作り直し、マスは差分だけ作り直す。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, tilesGroup } = rt;
    if (rt.hitSize !== size) {
      rt.hitSize = size;
      for (const child of [...tilesGroup.children]) {
        if (child.userData.isBase) tilesGroup.remove(child);
      }
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(size * PITCH + 0.35, 0.3, size * PITCH + 0.35),
        new THREE.MeshStandardMaterial({ color: 0x6b5b3e, roughness: 0.85 }),
      );
      base.position.y = -0.16;
      base.userData.isBase = true;
      tilesGroup.add(base);
      for (const [, c] of rt.cellsRt) tilesGroup.remove(c.grp);
      rt.cellsRt.clear();
      for (const h of rt.hits) tilesGroup.remove(h);
      rt.hits = [];
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
      for (let i = 0; i < size * size; i++) {
        const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        const [x, z] = cellPos(i, size);
        h.position.set(x, 0.3, z);
        h.userData.pickId = `cell-${i}`;
        tilesGroup.add(h);
        rt.hits.push(h);
      }
      if (rt.knight) {
        tilesGroup.remove(rt.knight.grp);
        rt.knight = null;
      }
      const container = containerRef.current;
      if (container) fitCamera(stage, container, size);
    }

    const moveSet = new Set(moves);
    for (let i = 0; i < size * size; i++) {
      const r = Math.floor(i / size);
      const c = i % size;
      const dark = (r + c) % 2 === 1;
      const step = order[i] ?? 0;
      const visited = step > 0;
      const isMove = moveSet.has(i) && status !== "won";
      const isHead = i === head;
      const sig = `${step}|${isMove ? 1 : 0}|${isHead ? 1 : 0}|${status}`;
      const cur = rt.cellsRt.get(i);
      if (cur && cur.sig === sig) continue;
      if (cur) tilesGroup.remove(cur.grp);
      const grp = new THREE.Group();
      const [x, z] = cellPos(i, size);
      grp.position.set(x, 0, z);
      let markerMat: THREE.MeshStandardMaterial | null = null;
      if (visited) {
        grp.add(createVisitedTile(step, dark));
      } else {
        const tile = new THREE.Mesh(
          new THREE.BoxGeometry(0.92, 0.16, 0.92),
          new THREE.MeshStandardMaterial({ color: dark ? 0x8a9a7b : 0xe6e2d3, roughness: 0.7 }),
        );
        tile.position.y = 0.08;
        grp.add(tile);
      }
      if (isMove) {
        // 移動可能マス: 緑の円盤マーカー（2D の「・」と光る表現の立体版）。
        markerMat = new THREE.MeshStandardMaterial({
          color: 0x69b86b,
          roughness: 0.4,
          emissive: 0x2e7d32,
          emissiveIntensity: 0.5,
        });
        const marker = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.06, 20), markerMat);
        marker.position.y = visited ? 0.25 : 0.19;
        grp.add(marker);
      }
      if (isHead) {
        // 現在位置は金のリングで囲む（駒本体は別グループでホップさせる）。
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.42, 0.045, 10, 32),
          new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.3, metalness: 0.45, emissive: 0xd9a441, emissiveIntensity: 0.25 }),
        );
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.24;
        grp.add(ring);
      }
      tilesGroup.add(grp);
      rt.cellsRt.set(i, { sig, grp, markerMat });
    }

    // ナイト駒の差分同期（現在位置が変わったらホップ開始、初回は即置き）。
    const [hx, hz] = cellPos(head, size);
    if (!rt.knight) {
      const grp = createKnightPiece();
      grp.position.set(hx, 0.22, hz);
      tilesGroup.add(grp);
      rt.knight = { grp, head, fromX: hx, fromZ: hz, toX: hx, toZ: hz, hop: 1 };
    } else if (rt.knight.head !== head) {
      rt.knight.fromX = rt.knight.grp.position.x;
      rt.knight.fromZ = rt.knight.grp.position.z;
      rt.knight.toX = hx;
      rt.knight.toZ = hz;
      rt.knight.head = head;
      rt.knight.hop = 0;
    }
  }, [size, order, moves, head, status]);

  return (
    <SceneBox
      height={440}
      label="ナイトツアーの盤（3D）。光っているマスをタップしてナイトを進めます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#3a4149"
    />
  );
}
