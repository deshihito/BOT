"use client";
// セイムゲームの 3D 盤。ブロックは立体ブロックで表す:
//   色は現行 2D の COLOR_STYLES と一致させる（赤/青/緑/黄/紫）。
//   ホバー中のグループ（親が lib のグループ判定で求めた集合）は持ち上げ＋
//   発光で示し、それ以外は現行 2D と同じく少し暗くする。
// 消去・落下・左詰めは差分同期で追従する:
//   状態が変わったら、前回のブロックと同色のものを最も近い位置で対応付け
//   （これは見た目の対応付けだけで、消去や重力の判定は親＋lib が正）、
//   生き残ったブロックは目標位置へ補間移動する＝落下・左詰めアニメーション。
//   消えたブロックは差分で取り除き、新しいブロックは上から落として着地させる。
// 入力は現行クライアントの操作語彙どおり:
//   タップ = onCell（グループ消去は親ハンドラが担う）
//   ホバー = onHover（グループ表示は親の状態が正）
// 状態表示（スコア・残り個数など）は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

interface Props {
  cells: (number | null)[];
  cols: number;
  rows: number;
  /** ホバー中のグループの index 一覧（親が計算したもの）。 */
  hoverGroup: number[];
  /** タップ（現行の消去ハンドラへ接続）。 */
  onCell: (index: number) => void;
  /** ホバー（現行の setHover へ接続）。 */
  onHover: (index: number | null) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;
// 現行 2D（SameGameClient の COLOR_STYLES）と同じ色順・同じ色。
const COLOR_HEX = [0xe2534a, 0x3f7fbf, 0x43a35c, 0xe6b93d, 0x8d5bb5];

function cellPos(index: number, cols: number, rows: number): [number, number] {
  const r = Math.floor(index / cols);
  const c = index % cols;
  return [(c - (cols - 1) / 2) * PITCH, (r - (rows - 1) / 2) * PITCH];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, cols: number, rows: number) {
  const w = container.clientWidth || 560;
  const h = container.clientHeight || 440;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (cols / 2 + 0.9) / Math.tan(hFov / 2);
  const distD = ((rows / 2 + 0.9) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.4;
  stage.setCamera({
    position: [0, dist * 0.84, dist * 0.56],
    lookAt: [0, 0, 0.2],
    fov: 42,
  });
}

interface BlockRt {
  grp: THREE.Group;
  mat: THREE.MeshStandardMaterial;
  color: number;
  index: number;
  /** 目標位置（補間は onFrame）。 */
  tx: number;
  tz: number;
  ty: number;
}

interface SceneRt {
  stage: Stage;
  boardGroup: THREE.Group;
  hits: THREE.Mesh[];
  hitDims: string;
  blocks: BlockRt[];
}

export default function SameGameScene3D({ cells, cols, rows, hoverGroup, onCell, onHover, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onCell, onHover });
  propsRef.current = { onCell, onHover };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x2c3138,
      camera: { position: [0, 9, 6.4], lookAt: [0, 0, 0.2], fov: 42 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        // ブロックの落下・左詰め・持ち上げを滑らかに追従させる。
        const k = 1 - Math.exp(-dt * 11);
        for (const b of rt.blocks) {
          b.grp.position.x += (b.tx - b.grp.position.x) * k;
          b.grp.position.z += (b.tz - b.grp.position.z) * k;
          b.grp.position.y += (b.ty - b.grp.position.y) * k;
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
    rtRef.current = { stage, boardGroup, hits: [], hitDims: "", blocks: [] };

    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (id) propsRef.current.onCell(Number(id.slice(5)));
      },
      onHover: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        propsRef.current.onHover(id ? Number(id.slice(5)) : null);
      },
    }, { hover: true });
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 盤面同期: 土台と当たり判定は寸法が変わったときだけ作り直す。
  // ブロックは同色・最近傍で対応付けて差分同期する（判定は親＋lib が正）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, boardGroup } = rt;
    const dims = `${cols}x${rows}`;
    if (rt.hitDims !== dims) {
      rt.hitDims = dims;
      for (const child of [...boardGroup.children]) boardGroup.remove(child);
      rt.blocks = [];
      rt.hits = [];
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(cols * PITCH + 0.35, 0.3, rows * PITCH + 0.35),
        new THREE.MeshStandardMaterial({ color: 0x454b54, roughness: 0.9 }),
      );
      base.position.y = -0.16;
      boardGroup.add(base);
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
      for (let i = 0; i < rows * cols; i++) {
        const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        const [x, z] = cellPos(i, cols, rows);
        h.position.set(x, 0.3, z);
        h.userData.pickId = `cell-${i}`;
        boardGroup.add(h);
        rt.hits.push(h);
      }
      const container = containerRef.current;
      if (container) fitCamera(stage, container, cols, rows);
    }

    const hoverSet = new Set(hoverGroup);
    const hasHover = hoverGroup.length >= 2;
    const used = new Set<BlockRt>();
    const nextBlocks: BlockRt[] = [];
    const tmpColor = new THREE.Color();
    for (let i = 0; i < cells.length; i++) {
      const color = cells[i];
      if (color === null) continue;
      const [x, z] = cellPos(i, cols, rows);
      // 生き残りブロックの対応付け: 未使用の同色ブロックで最も近いもの。
      let best: BlockRt | null = null;
      let bestD = Infinity;
      for (const b of rt.blocks) {
        if (used.has(b) || b.color !== color) continue;
        const d = (b.grp.position.x - x) ** 2 + (b.grp.position.z - z) ** 2;
        if (d < bestD) { bestD = d; best = b; }
      }
      let blk: BlockRt;
      if (best) {
        blk = best;
        used.add(blk);
      } else {
        // 新規ブロックは上から落として着地させる。
        const mat = new THREE.MeshStandardMaterial({ color: COLOR_HEX[color], roughness: 0.45 });
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.52, 0.9), mat);
        mesh.position.y = 0.26;
        const grp = new THREE.Group();
        grp.add(mesh);
        grp.position.set(x, 1.1, z);
        boardGroup.add(grp);
        blk = { grp, mat, color, index: i, tx: x, tz: z, ty: 0 };
      }
      blk.index = i;
      blk.tx = x;
      blk.tz = z;
      // ホバー中のグループは持ち上げ＋発光、それ以外は現行 2D と同じく暗くする。
      const inHover = hoverSet.has(i);
      blk.ty = inHover ? 0.16 : 0;
      tmpColor.setHex(COLOR_HEX[color]);
      if (hasHover && !inHover) tmpColor.multiplyScalar(0.55);
      blk.mat.color.copy(tmpColor);
      blk.mat.emissive.setHex(inHover ? COLOR_HEX[color] : 0x000000);
      blk.mat.emissiveIntensity = inHover ? 0.4 : 0;
      nextBlocks.push(blk);
    }
    // 対応付かなかったブロック = 消去されたものとして取り除く。
    for (const b of rt.blocks) {
      if (!used.has(b) && !nextBlocks.includes(b)) boardGroup.remove(b.grp);
    }
    rt.blocks = nextBlocks;
  }, [cells, cols, rows, hoverGroup]);

  return (
    <SceneBox
      height={440}
      label="セイムゲームの盤（3D）。同色でつながったブロックをタップして消します"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#2c3138"
    />
  );
}
