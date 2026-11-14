"use client";
// マスターマインドの 3D 盤。推測ペグ=色球（three-kit の createBall）を
// 縦に並ぶ盤へ配置し、フィードバックは小さな黒/白ペグで表す
// （ヒット=黒、ブロー=白。意味は現行 DOM の「● ヒット / ○ ブロー」と同じ）。
// 現在の行は一段持ち上がった帯の上に置き、入力中のスロットはリングで、
// 置かれた球は淡く発光させて「いま編集中」を示す。
// 入力は現行どおり:
//   現在の行のスロットタップ = 親の onSlotTap（選択中スロットの切替。
//     色そのものは DOM の色パレットが担い、置く処理は親の pickColor）
//   盤の上スワイプ = 判定（親の onSubmitGuess）/ 左スワイプ = クリア
//     （親の onClearGuess）。現行 2D の予想欄ジェスチャと同じ割当。
// 答え（secret）はシーンへ渡さない・描かない。確定前の伏せは現行仕様どおり
// 親が守り、シーンは guesses と編集中の current だけを受け取る。
// 残り回数・勝敗・正解表示は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { createBall } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import { MM_CODE_LENGTH, MM_MAX_GUESSES, type MmColor, type MmGuess } from "@/lib/mastermind";

interface Props {
  /** 判定済みの推測履歴（答えは含まない）。 */
  guesses: MmGuess[];
  /** 編集中の予想（色 ID か null）。 */
  current: (string | null)[];
  /** 選択中のスロット位置。 */
  slot: number;
  palette: MmColor[];
  status: "playing" | "won" | "lost";
  /** スロットタップ（現行のスロット選択ハンドラ）。 */
  onSlotTap: (index: number) => void;
  /** 上スワイプ（現行の判定ハンドラ）。 */
  onSubmitGuess: () => void;
  /** 左スワイプ（現行のクリア ハンドラ）。 */
  onClearGuess: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const SLOT_PITCH = 0.66;
const ROW_PITCH = 1.02;
const BALL_R = 0.27;
const BOARD_W = 5.6;
const BOARD_D = MM_MAX_GUESSES * ROW_PITCH + 0.7;

function slotX(i: number): number {
  return (i - (MM_CODE_LENGTH - 1) / 2) * SLOT_PITCH - 0.55;
}

function rowZ(row: number): number {
  return (row - (MM_MAX_GUESSES - 1) / 2) * ROW_PITCH;
}

function colorInt(c: MmColor): number {
  return parseInt(c.value.slice(1), 16);
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement) {
  const w = container.clientWidth || 520;
  const h = container.clientHeight || 540;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (BOARD_W / 2 + 0.9) / Math.tan(hFov / 2);
  const distD = ((BOARD_D / 2 + 0.9) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.4;
  stage.setCamera({
    position: [0, dist * 0.8, dist * 0.6],
    lookAt: [0, 0, 0.4],
    fov: 42,
  });
}

/** 色球（置かれた球は淡く発光させる）。 */
function createColorBall(color: MmColor): THREE.Mesh {
  const ball = createBall(BALL_R, colorInt(color), { roughness: 0.22 });
  const mat = ball.material as THREE.MeshStandardMaterial;
  mat.emissive = new THREE.Color(colorInt(color));
  mat.emissiveIntensity = 0.18;
  return ball;
}

/** 空きスロットの受け皿（沈んだ円盤）。 */
function createSocket(): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(BALL_R * 0.92, BALL_R * 0.92, 0.06, 24),
    new THREE.MeshStandardMaterial({ color: 0x2c2118, roughness: 0.9 }),
  );
  return m;
}

/** 推測1行（球＋フィードバック小ペグ）を作る。 */
function createGuessRow(guess: MmGuess, palette: MmColor[]): THREE.Group {
  const grp = new THREE.Group();
  guess.pegs.forEach((id, i) => {
    const color = palette.find((c) => c.id === id);
    const ball = color
      ? createColorBall(color)
      : createBall(BALL_R, 0x999999, { roughness: 0.4 });
    ball.position.set(slotX(i), BALL_R + 0.04, 0);
    grp.add(ball);
  });
  // フィードバック: ヒット=黒、ブロー=白の小ペグを 2x2 に並べる。
  const kinds: ("hit" | "blow" | "none")[] = [
    ...Array<"hit">(guess.hits).fill("hit"),
    ...Array<"blow">(guess.blows).fill("blow"),
  ];
  while (kinds.length < MM_CODE_LENGTH) kinds.push("none");
  kinds.forEach((kind, i) => {
    const dx = i % 2;
    const dz = Math.floor(i / 2);
    const peg = createBall(0.095, kind === "hit" ? 0x1c1c1e : kind === "blow" ? 0xf5f5f5 : 0x3a2d20, {
      roughness: 0.35,
    });
    peg.position.set(1.95 + dx * 0.34, 0.1, -0.17 + dz * 0.34);
    grp.add(peg);
  });
  return grp;
}

interface RowRt {
  grp: THREE.Group;
  sig: string;
}

interface SceneRt {
  stage: Stage;
  boardGroup: THREE.Group;
  hits: THREE.Mesh[];
  built: boolean;
  rowsRt: Map<string, RowRt>;
  currentGrp: THREE.Group | null;
  currentSig: string;
}

export default function MastermindScene3D({
  guesses, current, slot, palette, status, onSlotTap, onSubmitGuess, onClearGuess, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onSlotTap, onSubmitGuess, onClearGuess });
  propsRef.current = { onSlotTap, onSubmitGuess, onClearGuess };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x3a3128,
      camera: { position: [0, 9, 7], lookAt: [0, 0, 0.4], fov: 42 },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    const boardGroup = new THREE.Group();
    scene.add(boardGroup);
    rtRef.current = { stage, boardGroup, hits: [], built: false, rowsRt: new Map(), currentGrp: null, currentSig: "" };

    // 盤上のスワイプ（現行 2D の予想欄ジェスチャと同じ: 上=判定、左=クリア）。
    // 掴んだ対象の有無で onFlick / onDragEnd のどちらかに届くため両方つなぐ。
    const handleFlick = (dir: string | null) => {
      if (dir === "up") propsRef.current.onSubmitGuess();
      else if (dir === "left") propsRef.current.onClearGuess();
    };
    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (id) propsRef.current.onSlotTap(Number(id.slice(5)));
      },
      onFlick: (flick) => handleFlick(flick.dir),
      onDragEnd: (flick) => handleFlick(flick.dir),
    });
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 盤面同期: 土台は初回だけ、履歴の行と現在の行は差分同期する。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, boardGroup } = rt;
    if (!rt.built) {
      rt.built = true;
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(BOARD_W, 0.3, BOARD_D),
        new THREE.MeshStandardMaterial({ color: 0x54432e, roughness: 0.85 }),
      );
      slab.position.y = -0.15;
      boardGroup.add(slab);
      // 行ごとの帯（現在の行の帯だけ持ち上げるため、帯は行同期側で持つ）。
      const stripGeo = new THREE.BoxGeometry(BOARD_W - 0.5, 0.05, ROW_PITCH * 0.86);
      const stripMat = new THREE.MeshStandardMaterial({ color: 0x6b5638, roughness: 0.85 });
      for (let r = 0; r < MM_MAX_GUESSES; r++) {
        const strip = new THREE.Mesh(stripGeo, stripMat);
        strip.position.set(0, 0.025, rowZ(r));
        strip.userData.rowStrip = r;
        boardGroup.add(strip);
      }
      const container = containerRef.current;
      if (container) fitCamera(stage, container);
    }

    // 履歴の行（差分同期）。
    const seen = new Set<string>();
    guesses.forEach((g, ri) => {
      const key = `g-${ri}`;
      seen.add(key);
      const sig = `${g.pegs.join(",")}|${g.hits}|${g.blows}`;
      const cur = rt.rowsRt.get(key);
      if (cur && cur.sig === sig) return;
      if (cur) boardGroup.remove(cur.grp);
      const grp = createGuessRow(g, palette);
      grp.position.set(0, 0.05, rowZ(ri));
      boardGroup.add(grp);
      rt.rowsRt.set(key, { grp, sig });
    });
    for (const [key, row] of [...rt.rowsRt]) {
      if (seen.has(key)) continue;
      boardGroup.remove(row.grp);
      rt.rowsRt.delete(key);
    }

    // 現在の行: 帯を持ち上げ、スロットの受け皿＋選択リング＋球を置く。
    const curRow = guesses.length;
    const sig = `${current.join(",")}|${slot}|${status}|${curRow}`;
    if (rt.currentSig !== sig) {
      rt.currentSig = sig;
      if (rt.currentGrp) {
        boardGroup.remove(rt.currentGrp);
        rt.currentGrp = null;
      }
      for (const h of rt.hits) boardGroup.remove(h);
      rt.hits = [];
      if (status === "playing" && curRow < MM_MAX_GUESSES) {
        const grp = new THREE.Group();
        grp.position.set(0, 0.16, rowZ(curRow)); // 現在の行は持ち上げて示す
        const lift = new THREE.Mesh(
          new THREE.BoxGeometry(BOARD_W - 0.5, 0.1, ROW_PITCH * 0.86),
          new THREE.MeshStandardMaterial({ color: 0x7d6540, roughness: 0.8 }),
        );
        lift.position.y = -0.08;
        grp.add(lift);
        current.forEach((id, i) => {
          const socket = createSocket();
          socket.position.set(slotX(i), 0.03, 0);
          grp.add(socket);
          if (i === slot) {
            const ring = new THREE.Mesh(
              new THREE.TorusGeometry(BALL_R + 0.07, 0.035, 10, 28),
              new THREE.MeshStandardMaterial({ color: 0x3e7bdb, roughness: 0.4, emissive: 0x3e7bdb, emissiveIntensity: 0.5 }),
            );
            ring.rotation.x = Math.PI / 2;
            ring.position.set(slotX(i), 0.06, 0);
            grp.add(ring);
          }
          const color = id ? palette.find((c) => c.id === id) : undefined;
          if (color) {
            const ball = createColorBall(color);
            ball.position.set(slotX(i), BALL_R + 0.04, 0);
            grp.add(ball);
          }
        });
        boardGroup.add(grp);
        rt.currentGrp = grp;
        // スロットの当たり判定。
        const hitGeo = new THREE.BoxGeometry(SLOT_PITCH * 0.95, 0.95, ROW_PITCH * 0.9);
        for (let i = 0; i < MM_CODE_LENGTH; i++) {
          const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
          h.position.set(slotX(i), 0.45, rowZ(curRow));
          h.userData.pickId = `slot-${i}`;
          boardGroup.add(h);
          rt.hits.push(h);
        }
      }
    }
  }, [guesses, current, slot, palette, status]);

  return (
    <SceneBox
      height={540}
      label="マスターマインドの盤（3D）。スロットをタップで選び、色は下のパレットから置きます。上にスワイプで判定します"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#3a3128"
    />
  );
}
