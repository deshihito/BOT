"use client";
// 麻雀ソリティアの 3D 盤。牌は厚みのある直方体で、上面に現行 2D と同じ
// 牌文字（MJ_KINDS）を大きく描く。積層レイアウトは layer の段差でそのまま
// 表現し、層が高い牌ほど現行 2D と同じく手前へ少しずらす。
// フリーな牌は明るく、取れない牌は現行 2D と同じく暗く（#d8d2c2＋減光）する。
// 選択中の牌は持ち上げて金縁で示す。ヒントの牌は金縁を脈動させる
// （現行 2D のヒント色 #f2b01e と同じ金）。
// 入力は現行どおり牌タップ = onTile（選択/ペア確定は親ハンドラと
// lib/mahjong.ts が判定する）。残り枚数等の状態は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import { MJ_BOARD_H, MJ_BOARD_W, MJ_KINDS, type MjTile } from "@/lib/mahjong";

interface Props {
  tiles: MjTile[];
  /** フリーな牌の id 集合（freeTileIds の結果）。 */
  free: Set<number>;
  selected: number | null;
  hint: [number, number] | null;
  onTile: (id: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

/** 盤座標 1 単位のワールド寸法。牌は 2x2 単位なので一辺 1.1 になる。 */
const S = 0.55;
const TILE = 2 * S;
const THICK = 0.27;
const LAYER_STEP = 0.3;
const GOLD = 0xf2b01e;

function tilePos(tile: MjTile): THREE.Vector3 {
  return new THREE.Vector3(
    (tile.x + 1 - MJ_BOARD_W / 2) * S + tile.layer * 0.06,
    THICK / 2 + tile.layer * LAYER_STEP,
    (tile.y + 1 - MJ_BOARD_H / 2) * S - tile.layer * 0.06,
  );
}

/** 牌の上面テクスチャ（現行 2D と同じ牌文字を大きく、フリー/非フリーで地の色を変える）。 */
function tileTopTexture(kind: number, isFree: boolean): THREE.CanvasTexture {
  return canvasTexture(`mj-kind-${kind}-${isFree ? "free" : "dim"}`, 128, 128, (g) => {
    g.fillStyle = isFree ? "#fffdf4" : "#d8d2c2";
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#2f2a20";
    g.font = "76px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(MJ_KINDS[kind] ?? "", 64, 68);
  });
}

function createTileMesh(tile: MjTile, isFree: boolean): THREE.Mesh {
  const side = new THREE.MeshStandardMaterial({
    color: isFree ? 0xefe9d8 : 0xcfc8b4,
    roughness: 0.55,
  });
  const top = new THREE.MeshStandardMaterial({ map: tileTopTexture(tile.kind, isFree), roughness: 0.5 });
  const bottom = new THREE.MeshStandardMaterial({ color: 0xd9d2bd, roughness: 0.6 });
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(TILE * 0.96, THICK, TILE * 0.96),
    [side, side, top, bottom, side, side],
  );
  return mesh;
}

/** 金縁（牌の下に敷く金の平板）。選択中・ヒント共通。 */
function createGoldFrame(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(TILE * 1.08, 0.07, TILE * 1.08),
    new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.35, metalness: 0.35 }),
  );
  mesh.position.y = -THICK / 2 - 0.02;
  return mesh;
}

interface SceneRt {
  tilesGroup: THREE.Group;
  hintFrames: THREE.Mesh[];
}

export default function MahjongScene3D({ tiles, free, selected, hint, onTile, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onTile });
  propsRef.current = { onTile };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x2e6b46,
      camera: { position: [0, 8.8, 6.9], lookAt: [0, 0, 0.2], fov: 42 },
      onFrame: (_dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        // ヒントの金縁だけを脈動させ、選択中の金縁（静止）と区別する。
        const s = 1 + 0.05 * Math.sin(t * 5);
        for (const f of rt.hintFrames) f.scale.set(s, 1, s);
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    const felt = new THREE.Mesh(
      new THREE.BoxGeometry(MJ_BOARD_W * S + 0.7, 0.3, MJ_BOARD_H * S + 0.7),
      new THREE.MeshStandardMaterial({ color: 0x2e6b46, roughness: 1 }),
    );
    felt.position.y = -0.16;
    scene.add(felt);

    const tilesGroup = new THREE.Group();
    scene.add(tilesGroup);
    rtRef.current = { tilesGroup, hintFrames: [] };

    detach = attachPickPointer(stage, () => [tilesGroup], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (!id) return;
        propsRef.current.onTile(Number(id.slice(5)));
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

  // 盤面同期: 残っている牌をすべて作り直す（最大88枚）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    for (const child of [...rt.tilesGroup.children]) rt.tilesGroup.remove(child);
    rt.hintFrames = [];
    const hintSet = new Set(hint ?? []);
    for (const tile of tiles) {
      if (tile.removed) continue;
      const isFree = free.has(tile.id);
      const isSelected = selected === tile.id;
      const isHint = hintSet.has(tile.id);
      const grp = new THREE.Group();
      grp.position.copy(tilePos(tile));
      if (isSelected) grp.position.y += 0.24; // 選択中は持ち上げる
      const mesh = createTileMesh(tile, isFree);
      grp.add(mesh);
      if (isSelected || isHint) {
        const frame = createGoldFrame();
        grp.add(frame);
        if (isHint && !isSelected) rt.hintFrames.push(frame);
      }
      grp.traverse((o) => { o.userData.pickId = `tile-${tile.id}`; });
      rt.tilesGroup.add(grp);
    }
  }, [tiles, free, selected, hint]);

  return (
    <SceneBox
      height={330}
      label="麻雀ソリティアの盤（3D）。フリーな牌をタップしてペアにします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#2e6b46"
    />
  );
}
