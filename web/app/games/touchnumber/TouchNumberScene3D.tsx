"use client";
// タッチザナンバーの 3D 盤。数字タイルは立体タイルで表す:
//   数字は上面テクスチャで大きく太く描く（160px キャンバスに 92px 級）。
//   次に押す数字（親の状態 next が正）は現行 2D の金色 #d9a41c の枠＋
//   持ち上げ＋発光の脈動で強調する。
//   片付け済みの数字は現行 2D と同じ灰色で一段沈ませ、ミスしたタイルは
//   赤系の面色にする。通常タイルの面色・文字色も現行 2D と一致させる。
// 入力は現行クライアントの操作語彙どおり:
//   タップ = onTap（次かどうか・ミス集計は親ハンドラと lib が決め、
//   ここでは再実装しない。片付け済みタイルの無視も親側の判定に従う）。
// 状態表示（タイマー・次の数字など）は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

interface Props {
  board: number[];
  cols: number;
  size: number;
  /** 次にタップすべき数字（親の状態が正）。 */
  next: number;
  wrongIndex: number | null;
  status: "playing" | "won";
  /** タップ（現行の onTap ハンドラへ接続）。 */
  onTap: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;
const GOLD_HEX = 0xd9a41c;

type TileKind = "normal" | "next" | "cleared" | "wrong";

function cellPos(index: number, cols: number, rows: number): [number, number] {
  const r = Math.floor(index / cols);
  const c = index % cols;
  return [(c - (cols - 1) / 2) * PITCH, (r - (rows - 1) / 2) * PITCH];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, cols: number, rows: number) {
  const w = container.clientWidth || 420;
  const h = container.clientHeight || 400;
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

/** 数字タイル（上面いっぱいの大きな太字数字）。次の数字は金の枠線つき。 */
function createNumberTile(value: number, kind: TileKind): { grp: THREE.Group; topMat: THREE.MeshStandardMaterial } {
  const bg =
    kind === "cleared" ? "#e5e7eb" : kind === "wrong" ? "#f7e3e0" : kind === "next" ? "#fff3c4" : "#fffdf6";
  const fg = kind === "cleared" ? "#9ca3af" : "#22252a";
  const topTex = canvasTexture(`touchnumber-${value}-${kind}`, 160, 160, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, 160, 160);
    if (kind === "next") {
      g.strokeStyle = "#d9a41c";
      g.lineWidth = 10;
      g.strokeRect(6, 6, 148, 148);
    }
    g.fillStyle = fg;
    g.font = "bold 92px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(value), 80, 84);
  });
  const sideColor = new THREE.Color(bg).multiplyScalar(0.85);
  const side = new THREE.MeshStandardMaterial({ color: sideColor, roughness: 0.6 });
  const topMat = new THREE.MeshStandardMaterial({
    map: topTex,
    roughness: 0.5,
    emissive: kind === "next" ? GOLD_HEX : 0x000000,
    emissiveIntensity: kind === "next" ? 0.35 : 0,
  });
  const height = kind === "cleared" ? 0.16 : kind === "next" ? 0.44 : 0.3;
  const grp = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, height, 0.9),
    [side, side, topMat, side, side, side],
  );
  mesh.position.y = height / 2;
  grp.add(mesh);
  if (kind === "next") {
    const frame = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(0.96, height + 0.06, 0.96)),
      new THREE.LineBasicMaterial({ color: GOLD_HEX }),
    );
    frame.position.y = height / 2;
    grp.add(frame);
  }
  return { grp, topMat };
}

interface CellRt {
  sig: string;
  grp: THREE.Group;
  topMat: THREE.MeshStandardMaterial | null;
}

interface SceneRt {
  stage: Stage;
  tilesGroup: THREE.Group;
  hits: THREE.Mesh[];
  hitDims: string;
  cellsRt: Map<number, CellRt>;
}

export default function TouchNumberScene3D({ board, cols, size, next, wrongIndex, status, onTap, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onTap });
  propsRef.current = { onTap };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  const rows = Math.max(1, Math.ceil(board.length / cols));

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x3a4149,
      camera: { position: [0, 7, 5], lookAt: [0, 0, 0.2], fov: 42 },
      onFrame: (_dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        // 次の数字の発光をゆっくり脈動させる（強調の演出のみ、判定には使わない）。
        const pulse = 0.3 + 0.18 * Math.sin(t * 4);
        for (const c of rt.cellsRt.values()) {
          if (c.topMat && c.topMat.emissiveIntensity > 0) c.topMat.emissiveIntensity = pulse;
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
    rtRef.current = { stage, tilesGroup, hits: [], hitDims: "", cellsRt: new Map() };

    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (id) propsRef.current.onTap(Number(id.slice(5)));
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

  // 盤面同期: 寸法が変わったら土台と当たり判定を作り直し、タイルは
  // 状態の署名（数字×種別）が変わったものだけ作り直す差分同期にする。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, tilesGroup } = rt;
    const dims = `${cols}x${rows}|${board.length}`;
    if (rt.hitDims !== dims) {
      rt.hitDims = dims;
      for (const child of [...tilesGroup.children]) tilesGroup.remove(child);
      rt.cellsRt.clear();
      rt.hits = [];
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(cols * PITCH + 0.35, 0.3, rows * PITCH + 0.35),
        new THREE.MeshStandardMaterial({ color: 0x8b95a1, roughness: 0.85 }),
      );
      base.position.y = -0.16;
      tilesGroup.add(base);
      const hitGeo = new THREE.BoxGeometry(PITCH * 0.98, 0.9, PITCH * 0.98);
      for (let i = 0; i < board.length; i++) {
        const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        const [x, z] = cellPos(i, cols, rows);
        h.position.set(x, 0.3, z);
        h.userData.pickId = `cell-${i}`;
        tilesGroup.add(h);
        rt.hits.push(h);
      }
      const container = containerRef.current;
      if (container) fitCamera(stage, container, cols, rows);
    }

    board.forEach((value, i) => {
      const kind: TileKind =
        status === "playing" && wrongIndex === i
          ? "wrong"
          : value < next
            ? "cleared"
            : status === "playing" && value === next
              ? "next"
              : "normal";
      const sig = `${value}|${kind}`;
      const cur = rt.cellsRt.get(i);
      if (cur && cur.sig === sig) return;
      if (cur) tilesGroup.remove(cur.grp);
      const { grp, topMat } = createNumberTile(value, kind);
      const [x, z] = cellPos(i, cols, rows);
      grp.position.set(x, 0, z);
      tilesGroup.add(grp);
      rt.cellsRt.set(i, { sig, grp, topMat: kind === "next" ? topMat : null });
    });
  }, [board, cols, rows, next, wrongIndex, status]);

  return (
    <SceneBox
      height={size === 50 ? 540 : 400}
      label="タッチザナンバーの盤（3D）。数字を順番にタップします。次に押す数字は金色に光ります"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#3a4149"
    />
  );
}
