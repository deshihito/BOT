"use client";
// ドミノ（オンライン）の 3D シーン。OnlineShell の Board 差し替え方式:
//   牌 = 白い直方体＋両半分に目（ピップ）を canvasTexture で大きく描く
//     （目の数は lib/online/games/domino の dominoTilePips の返り値を使う）
//   場の牌 = 両端へ連なるチェーン配置（向きは view の left/right どおり、
//     長くなったら行折り返し＋ fitCamera で全体を収める）
//   手札 = 自分の分のみ扇状に配置。相手は枚数表現のみ（裏向き牌の列）で、
//     秘匿情報（相手の手札の中身）は view 契約に含まれないため渡されない。
//   山 = 裏向き牌の積み重ね。
// 牌タップ = 既存の配置／選択ハンドラへそのまま渡す。両端どちらにも
// 置ける牌は親が選択状態を持ち、シーンの両端マーカーのタップで
// 置く側を伝える。配置可否の判定はすべて親とサーバーが決める。
// 状態（手番・両端の目・山の枚数・ログ）は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import { dominoTilePips } from "@/lib/online/games/domino";

export interface DominoSceneOther {
  seat: number;
  /** 残り枚数だけを受け取る（手札の中身は受け取らない）。 */
  count: number;
}

export interface DominoScenePlaced {
  tile: number;
  left: number;
  right: number;
}

interface Props {
  /** 自分の手札（牌 id 配列）。 */
  yourHand: number[];
  /** 場のチェーン（view の配置情報どおり）。 */
  board: DominoScenePlaced[];
  others: DominoSceneOther[];
  boneyardCount: number;
  /** 両端どちらにも置ける牌の選択中 id（親が持つ）。 */
  selectedTile: number | null;
  /** 出せる牌の id（親が view から導いたもの。ハイライト用）。 */
  yourPlayable: number[];
  myTurn: boolean;
  mySeat: number;
  totalPlayers: number;
  /** 手札の牌タップ（既存の配置／選択ハンドラ）。 */
  onHandTap: (tile: number) => void;
  /** 両端マーカーのタップ（置く側の選択）。 */
  onEndTap: (side: "left" | "right") => void;
  onFail: () => void;
  fallback: ReactNode;
}

const TILE_L = 1.5;
const TILE_W = 0.76;
const TILE_H = 0.16;
const CHAIN_PER_ROW = 6;
const CHAIN_ROW_GAP = 1.25;

/** ピップ配置（0〜6）。半面の中心座標に対する相対位置。 */
const PIP_LAYOUT: Record<number, [number, number][]> = {
  0: [],
  1: [[0, 0]],
  2: [[-1, -1], [1, 1]],
  3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
};

function drawPips(g: CanvasRenderingContext2D, value: number, cx: number, cy: number) {
  g.fillStyle = "#23272e";
  for (const [dx, dy] of PIP_LAYOUT[value] ?? []) {
    g.beginPath();
    g.arc(cx + dx * 26, cy + dy * 26, 11, 0, Math.PI * 2);
    g.fill();
  }
}

/** 牌の上面テクスチャ（左半分 = a、右半分 = b、中央に仕切り線）。 */
function tileTopTexture(a: number, b: number): THREE.CanvasTexture {
  return canvasTexture(`domino-tile-${a}-${b}`, 256, 128, (g) => {
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, 256, 128);
    g.strokeStyle = "#94a3b8";
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(128, 10);
    g.lineTo(128, 118);
    g.stroke();
    drawPips(g, a, 64, 64);
    drawPips(g, b, 192, 64);
  });
}

const backTexture = (() => {
  let tex: THREE.CanvasTexture | null = null;
  return () => {
    if (!tex) {
      tex = canvasTexture("domino-back", 256, 128, (g) => {
        g.fillStyle = "#7d8ea3";
        g.fillRect(0, 0, 256, 128);
        g.strokeStyle = "rgba(255,255,255,0.55)";
        g.lineWidth = 5;
        g.strokeRect(14, 14, 228, 100);
      });
    }
    return tex;
  };
})();

/** ドミノ牌（白い直方体＋上面の目）。裏向きは目なしで作る。 */
function createDominoTile(a: number | null, b: number | null): THREE.Mesh {
  const side = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.5 });
  const top = a !== null && b !== null
    ? new THREE.MeshStandardMaterial({ map: tileTopTexture(a, b), roughness: 0.42 })
    : new THREE.MeshStandardMaterial({ map: backTexture(), roughness: 0.5 });
  const bottom = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.55 });
  return new THREE.Mesh(
    new THREE.BoxGeometry(TILE_L, TILE_H, TILE_W),
    [side, side, top, bottom, side, side],
  );
}

interface ChainLayout {
  pos: THREE.Vector3;
  /** ダブル（両目同じ）は縦置き。 */
  vertical: boolean;
}

/** チェーン配置: 左から右へ連ね、行がいっぱいになったら折り返す。 */
function layoutChain(board: DominoScenePlaced[]): ChainLayout[] {
  const out: ChainLayout[] = [];
  let x = 0;
  let z = 0;
  let prevHalf = 0;
  board.forEach((placed, i) => {
    const vertical = placed.left === placed.right;
    const half = vertical ? TILE_W / 2 : TILE_L / 2;
    if (i > 0) {
      x += prevHalf + half + 0.09;
      if (i % CHAIN_PER_ROW === 0) {
        x = 0;
        z += CHAIN_ROW_GAP;
      }
    }
    out.push({ pos: new THREE.Vector3(x, TILE_H / 2 + 0.02, z), vertical });
    prevHalf = half;
  });
  // 全体を原点中心へ寄せる。
  if (out.length > 0) {
    const maxX = Math.max(...out.map((o) => o.pos.x));
    const maxZ = Math.max(...out.map((o) => o.pos.z));
    for (const o of out) {
      o.pos.x -= maxX / 2;
      o.pos.z -= maxZ / 2 + 0.4;
    }
  }
  return out;
}

/** チェーンの配置範囲から、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, board: DominoScenePlaced[]) {
  const layout = layoutChain(board);
  const spanX = layout.length > 0 ? Math.max(...layout.map((o) => Math.abs(o.pos.x))) * 2 + TILE_L + 1 : 7;
  const rows = Math.max(1, Math.ceil(board.length / CHAIN_PER_ROW));
  const spanZ = rows * CHAIN_ROW_GAP + 3.4;
  const w = container.clientWidth || 640;
  const h = container.clientHeight || 420;
  const aspect = w / h;
  const vFov = (44 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (spanX / 2 + 0.6) / Math.tan(hFov / 2);
  const distD = ((spanZ / 2 + 0.6) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD, 6.2) + 0.9;
  stage.setCamera({
    position: [0, dist * 0.84, dist * 0.56],
    lookAt: [0, 0, 0.3],
    fov: 44,
  });
}

/** 自分から見た相対席位置（他プレイヤーの裏向き列の置き場）。 */
function seatPos(seat: number, mySeat: number, totalPlayers: number): THREE.Vector3 {
  const total = Math.max(2, totalPlayers);
  const rel = ((seat - mySeat) % total + total) % total;
  if (total === 2) return new THREE.Vector3(0, 0, -2.6);
  if (total === 3) return rel === 1 ? new THREE.Vector3(-3.1, 0, -1.7) : new THREE.Vector3(3.1, 0, -1.7);
  if (rel === 1) return new THREE.Vector3(-3.5, 0, -0.4);
  if (rel === 2) return new THREE.Vector3(0, 0, -2.6);
  return new THREE.Vector3(3.5, 0, -0.4);
}

interface TileEntry {
  sig: string;
  grp: THREE.Group;
}

interface SceneRt {
  stage: Stage;
  tilesGroup: THREE.Group;
  entries: Map<string, TileEntry>;
  endL: THREE.Mesh;
  endR: THREE.Mesh;
  endMatL: THREE.MeshStandardMaterial;
  endMatR: THREE.MeshStandardMaterial;
  chainSig: string;
}

export default function DominoScene3D({
  yourHand, board, others, boneyardCount, selectedTile, yourPlayable, myTurn, mySeat, totalPlayers,
  onHandTap, onEndTap, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onHandTap, onEndTap });
  propsRef.current = { onHandTap, onEndTap };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x1f3d2b,
      camera: { position: [0, 6.4, 4.6], lookAt: [0, 0, 0.3], fov: 44 },
      onFrame: (_dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        const pulse = 0.55 + 0.3 * Math.sin(t * 3);
        if (rt.endL.visible) rt.endMatL.emissiveIntensity = pulse;
        if (rt.endR.visible) rt.endMatR.emissiveIntensity = pulse;
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // テーブル。
    const table = new THREE.Mesh(
      new THREE.BoxGeometry(9.2, 0.22, 6.2),
      new THREE.MeshStandardMaterial({ color: 0x2e6b45, roughness: 0.95 }),
    );
    table.position.y = -0.13;
    table.userData.pickId = "table";
    scene.add(table);
    const rim = new THREE.Mesh(
      new THREE.BoxGeometry(9.6, 0.16, 6.6),
      new THREE.MeshStandardMaterial({ color: 0x5b3a22, roughness: 0.65 }),
    );
    rim.position.y = -0.2;
    scene.add(rim);

    const tilesGroup = new THREE.Group();
    scene.add(tilesGroup);

    // 両端マーカー（置く側の選択用）。選択中だけ表示する。
    const mkEnd = (pickId: string) => {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffd54d, roughness: 0.3, emissive: 0xa97b12, emissiveIntensity: 0.6,
      });
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.09, 24), mat);
      mesh.visible = false;
      mesh.userData.pickId = pickId;
      scene.add(mesh);
      return { mesh, mat };
    };
    const endL = mkEnd("end-left");
    const endR = mkEnd("end-right");

    rtRef.current = {
      stage,
      tilesGroup,
      entries: new Map(),
      endL: endL.mesh,
      endR: endR.mesh,
      endMatL: endL.mat,
      endMatR: endR.mat,
      chainSig: "",
    };

    detach = attachPickPointer(stage, () => [tilesGroup, endL.mesh, endR.mesh, table], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (!id) return;
        if (id === "end-left") propsRef.current.onEndTap("left");
        else if (id === "end-right") propsRef.current.onEndTap("right");
        else if (id.startsWith("tile-")) {
          const tile = Number(id.slice(5));
          if (Number.isInteger(tile)) propsRef.current.onHandTap(tile);
        }
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

  // 差分同期: 場チェーン・自分の手札（扇状）・相手の裏向き列・山を
  // スロットキー＋署名で管理する。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const desired = new Map<string, {
      sig: string;
      make: () => THREE.Group;
      pos: THREE.Vector3;
      yaw: number;
    }>();

    // 場のチェーン。
    const layout = layoutChain(board);
    board.forEach((placed, i) => {
      const lay = layout[i];
      desired.set(`b${i}`, {
        sig: `b-${placed.tile}-${placed.left}-${placed.right}`,
        make: () => {
          const grp = new THREE.Group();
          grp.add(createDominoTile(placed.left, placed.right));
          return grp;
        },
        pos: lay.pos,
        yaw: lay.vertical ? Math.PI / 2 : 0,
      });
    });

    // 自分の手札（扇状）。目は dominoTilePips の返り値で描く。
    const handCount = yourHand.length;
    const handSpacing = handCount <= 1 ? 0 : Math.min(0.62, 6.4 / (handCount - 1));
    yourHand.forEach((tile, i) => {
      const [a, b] = dominoTilePips(tile);
      const offset = i - (handCount - 1) / 2;
      const isSelected = selectedTile === tile;
      const playable = myTurn && yourPlayable.includes(tile);
      desired.set(`h${tile}`, {
        sig: `h-${tile}-${a}-${b}-${isSelected ? 1 : 0}-${playable ? 1 : 0}`,
        make: () => {
          const grp = new THREE.Group();
          if (playable || isSelected) {
            const frame = new THREE.Mesh(
              new THREE.BoxGeometry(TILE_L + 0.14, 0.05, TILE_W + 0.14),
              new THREE.MeshStandardMaterial({
                color: isSelected ? 0xffd54d : 0xd97706, roughness: 0.4,
                emissive: isSelected ? 0xa97b12 : 0x000000, emissiveIntensity: isSelected ? 0.5 : 0,
              }),
            );
            frame.position.y = -0.05;
            frame.userData.pickId = `tile-${tile}`;
            grp.add(frame);
          }
          const mesh = createDominoTile(a, b);
          mesh.userData.pickId = `tile-${tile}`;
          grp.add(mesh);
          return grp;
        },
        pos: new THREE.Vector3(offset * handSpacing, isSelected ? 0.3 : 0.1, 2.35 + Math.abs(offset) * 0.05),
        yaw: offset * 0.06,
      });
    });

    // 相手の手札は裏向き牌の列（枚数表現のみ、中身は参照しない）。
    for (const other of others) {
      const center = seatPos(other.seat, mySeat, totalPlayers);
      const spacing = other.count <= 1 ? 0 : Math.min(0.3, 2.4 / (other.count - 1));
      for (let i = 0; i < other.count; i++) {
        const offset = i - (other.count - 1) / 2;
        desired.set(`o${other.seat}-${i}`, {
          sig: "back",
          make: () => {
            const grp = new THREE.Group();
            grp.add(createDominoTile(null, null));
            return grp;
          },
          pos: new THREE.Vector3(center.x + offset * spacing, 0.1, center.z),
          yaw: Math.abs(center.x) > 3.2 ? Math.PI / 2 : 0,
        });
      }
    }

    // 山: 裏向き牌の積み重ね（枚数があれば表示）。
    if (boneyardCount > 0) {
      const stack = Math.min(6, boneyardCount);
      desired.set("boneyard", {
        sig: `y-${stack}`,
        make: () => {
          const grp = new THREE.Group();
          for (let i = 0; i < stack; i++) {
            const mesh = createDominoTile(null, null);
            mesh.position.y = i * 0.07;
            grp.add(mesh);
          }
          return grp;
        },
        pos: new THREE.Vector3(3.9, 0.1, 1.9),
        yaw: 0.4,
      });
    }

    for (const [slot, e] of [...rt.entries]) {
      if (!desired.has(slot)) {
        rt.tilesGroup.remove(e.grp);
        rt.entries.delete(slot);
      }
    }
    for (const [slot, d] of desired) {
      const cur = rt.entries.get(slot);
      if (cur && cur.sig !== d.sig) {
        rt.tilesGroup.remove(cur.grp);
        rt.entries.delete(slot);
      }
      const entry = rt.entries.get(slot);
      if (!entry) {
        const grp = d.make();
        grp.position.copy(d.pos);
        grp.rotation.y = d.yaw;
        rt.tilesGroup.add(grp);
        rt.entries.set(slot, { sig: d.sig, grp });
      } else {
        entry.grp.position.copy(d.pos);
        entry.grp.rotation.y = d.yaw;
      }
    }

    // 両端マーカー: 選択中（置く側の決定待ち）のときだけ両端に置く。
    const showEnds = selectedTile !== null && board.length > 0;
    if (showEnds && layout.length > 0) {
      const first = layout[0];
      const last = layout[layout.length - 1];
      rt.endL.position.set(first.pos.x - TILE_L / 2 - 0.55, 0.06, first.pos.z);
      rt.endR.position.set(last.pos.x + TILE_L / 2 + 0.55, 0.06, last.pos.z);
    }
    rt.endL.visible = showEnds;
    rt.endR.visible = showEnds;

    // チェーンが伸びたら全体が収まるようカメラを再計算する。
    const chainSig = board.map((p) => `${p.tile}:${p.left}-${p.right}`).join(",");
    if (rt.chainSig !== chainSig) {
      rt.chainSig = chainSig;
      const container = containerRef.current;
      if (container) fitCamera(rt.stage, container, board);
    }
  }, [yourHand, board, others, boneyardCount, selectedTile, yourPlayable, myTurn, mySeat, totalPlayers]);

  return (
    <SceneBox
      height={460}
      label="ドミノの卓（3D）。手札の牌をタップして置きます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#1f3d2b"
    />
  );
}
