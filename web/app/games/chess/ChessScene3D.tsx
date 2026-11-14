"use client";
// チェスの 3D 盤。駒はプリミティブ造形（球・円柱・円錐・箱・トーラス・十字）
// で6種を判別させる。ロジックは lib/chess-game.ts のまま一切触らず、
// ここは表現と入力の橋渡しだけ: マスのタップはレイキャストで割り出し、
// 親の onSquareClick（0x88 座標）へそのまま渡す。
// 盤の向きは playerColor に追従する（2D の ranks/files 反転と一致）。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 盤に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

interface Props {
  /** 0x88 盤面（128要素）。駒コードは白 1..6 / 黒 9..14、種別は code & 7。 */
  board: Int8Array;
  /** WHITE=0 / BLACK=1（lib/chess-perft）。盤の向きの基準。 */
  playerColor: number;
  selected: number | null;
  /** 合法手の移動先マス（0x88）。 */
  targets: number[];
  lastMove: { from: number; to: number } | null;
  /** チェックされているキングのマス（0x88）。なければ null。 */
  checkSquare: number | null;
  onSquare: (sq: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;
const WHITE = 0;
const BASE_Y = 0.02;

// 駒コード → 種別（code & 7）: 1ポーン 2ナイト 3ビショップ 4ルーク 5クイーン 6キング
const isWhiteCode = (code: number) => code >= 1 && code <= 6;

/** 0x88 マス → 表示上の列・行（playerColor 側を手前に置く）。 */
function displayCell(sq: number, playerColor: number): [number, number] {
  const file = sq & 15;
  const rank = sq >> 4;
  return playerColor === WHITE ? [file, 7 - rank] : [7 - file, rank];
}
function sqPos(sq: number, playerColor: number): [number, number] {
  const [col, row] = displayCell(sq, playerColor);
  return [(col - 3.5) * PITCH, (row - 3.5) * PITCH];
}

// ---- 駒の造形（プリミティブのみ） ----
// 白は生成り＋濃色の縁取り、黒は濃紺黒＋明色の縁取りで区別する。
// 王冠まわりの金色アクセントは両色共通（クイーン/キングの識別補助）。
function bodyMat(white: boolean): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: white ? 0xf0e7d3 : 0x23262e, roughness: 0.38, metalness: 0.05 });
}
function trimMat(white: boolean): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: white ? 0x3a3f47 : 0xd8d2c2, roughness: 0.45 });
}
const GOLD_MAT = new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.3, metalness: 0.45 });

function addBase(grp: THREE.Group, white: boolean, r = 0.33): void {
  const base = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.12, 0.09, 24), bodyMat(white));
  base.position.y = 0.045;
  grp.add(base);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(r * 0.92, 0.028, 8, 28), trimMat(white));
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.09;
  grp.add(rim);
}
function stem(white: boolean, rTop: number, rBottom: number, h: number, y: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, 20), bodyMat(white));
  m.position.y = y;
  return m;
}

/** ポーン: 小柄で球頭。 */
export function createPawn(white: boolean): THREE.Group {
  const grp = new THREE.Group();
  addBase(grp, white, 0.29);
  grp.add(stem(white, 0.13, 0.19, 0.2, 0.19));
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.165, 20, 14), bodyMat(white));
  head.position.y = 0.42;
  grp.add(head);
  return grp;
}

/** ナイト: 傾けた首＋前方へ突き出す馬頭＋耳＋たてがみで判別する。 */
export function createKnight(white: boolean): THREE.Group {
  const grp = new THREE.Group();
  addBase(grp, white, 0.32);
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.44, 0.3), bodyMat(white));
  neck.position.set(0, 0.3, -0.03);
  neck.rotation.x = -0.38;
  grp.add(neck);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.27, 0.47), bodyMat(white));
  head.position.set(0, 0.56, 0.1);
  head.rotation.x = 0.55;
  grp.add(head);
  const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.16, 0.24), bodyMat(white));
  muzzle.position.set(0, 0.44, 0.31);
  muzzle.rotation.x = 0.2;
  grp.add(muzzle);
  for (const sx of [-0.07, 0.07]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.17, 8), trimMat(white));
    ear.position.set(sx, 0.74, -0.03);
    ear.rotation.x = -0.25;
    grp.add(ear);
  }
  const mane = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.42, 0.24), trimMat(white));
  mane.position.set(0, 0.52, -0.18);
  mane.rotation.x = -0.38;
  grp.add(mane);
  return grp;
}

/** ビショップ: 尖頭（ミトル）に斜めの切り込みを入れる。 */
export function createBishop(white: boolean): THREE.Group {
  const grp = new THREE.Group();
  addBase(grp, white);
  grp.add(stem(white, 0.15, 0.24, 0.3, 0.24));
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.035, 8, 24), trimMat(white));
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 0.4;
  grp.add(collar);
  const mitre = new THREE.Mesh(new THREE.SphereGeometry(0.19, 20, 14), bodyMat(white));
  mitre.scale.set(1, 1.45, 1);
  mitre.position.y = 0.62;
  grp.add(mitre);
  // 切り込み風: 頭部を斜めに横切る細い溝（反対色の薄い箱）。
  const slit = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.26, 0.12), trimMat(white));
  slit.position.set(0, 0.66, 0.13);
  slit.rotation.z = 0.65;
  slit.rotation.x = 0.15;
  grp.add(slit);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 10), trimMat(white));
  tip.position.y = 0.92;
  grp.add(tip);
  return grp;
}

/** ルーク: 円筒の塔＋胸壁（4つの突起）。 */
export function createRook(white: boolean): THREE.Group {
  const grp = new THREE.Group();
  addBase(grp, white);
  grp.add(stem(white, 0.24, 0.27, 0.3, 0.24));
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.13, 24), bodyMat(white));
  top.position.y = 0.45;
  grp.add(top);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const merlon = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.11, 0.13), bodyMat(white));
    merlon.position.set(Math.cos(a) * 0.21, 0.56, Math.sin(a) * 0.21);
    grp.add(merlon);
  }
  return grp;
}

/** クイーン: 冠（6つの珠）＋頂点の球。 */
export function createQueen(white: boolean): THREE.Group {
  const grp = new THREE.Group();
  addBase(grp, white);
  grp.add(stem(white, 0.14, 0.25, 0.42, 0.3));
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.16, 0.16, 24), bodyMat(white));
  crown.position.y = 0.58;
  grp.add(crown);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const point = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), GOLD_MAT);
    point.position.set(Math.cos(a) * 0.21, 0.7, Math.sin(a) * 0.21);
    grp.add(point);
  }
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.085, 14, 10), GOLD_MAT);
  orb.position.y = 0.74;
  grp.add(orb);
  return grp;
}

/** キング: 冠＋十字架（一番背が高い）。 */
export function createKing(white: boolean): THREE.Group {
  const grp = new THREE.Group();
  addBase(grp, white);
  grp.add(stem(white, 0.15, 0.26, 0.44, 0.31));
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.17, 0.17, 24), bodyMat(white));
  crown.position.y = 0.61;
  grp.add(crown);
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.03, 8, 24), GOLD_MAT);
  band.rotation.x = Math.PI / 2;
  band.position.y = 0.68;
  grp.add(band);
  const crossV = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.24, 0.055), GOLD_MAT);
  crossV.position.y = 0.86;
  grp.add(crossV);
  const crossH = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.055, 0.055), GOLD_MAT);
  crossH.position.y = 0.89;
  grp.add(crossH);
  return grp;
}

/** 駒コードから3D駒を生成する（種別は code & 7）。 */
export function createChessPiece(code: number): THREE.Group {
  const white = isWhiteCode(code);
  switch (code & 7) {
    case 1: return createPawn(white);
    case 2: return createKnight(white);
    case 3: return createBishop(white);
    case 4: return createRook(white);
    case 5: return createQueen(white);
    default: return createKing(white);
  }
}

// 盤面テクスチャ（向きごとに座標ラベルが変わるため2種用意する）。
function boardTexture(playerColor: number): THREE.CanvasTexture {
  return canvasTexture(`chess-board-${playerColor}`, 1024, 1024, (g) => {
    const step = 1024 / 8;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const file = playerColor === WHITE ? col : 7 - col;
        const rank = playerColor === WHITE ? 7 - row : row;
        const dark = (rank + file) % 2 === 0;
        g.fillStyle = dark ? "#7fa39c" : "#eef0e2";
        g.fillRect(col * step, row * step, step, step);
        g.fillStyle = dark ? "#eef0e2" : "#5b7a76";
        g.font = "bold 30px sans-serif";
        if (col === 0) {
          g.textAlign = "left";
          g.textBaseline = "top";
          g.fillText(String(rank + 1), 8, 6);
        }
        if (row === 7) {
          g.textAlign = "right";
          g.textBaseline = "bottom";
          g.fillText("abcdefgh"[file], step - 8, 1024 - 4);
        }
      }
    }
  });
}

interface PieceRt {
  grp: THREE.Group;
  code: number;
  cell: number;
  anim: { from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number } | null;
}

export default function ChessScene3D({ board, playerColor, selected, targets, lastMove, checkSquare, onSquare, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<{
    pieces: Map<number, PieceRt>;
    markers: THREE.Mesh[];
    captureRings: THREE.Mesh[];
    lastPlanes: THREE.Mesh[];
    selRing: THREE.Mesh;
    checkGlow: THREE.Mesh;
    boardTopMat: THREE.MeshStandardMaterial;
    scene: THREE.Scene;
    initialized: boolean;
  } | null>(null);
  const propsRef = useRef({ onSquare, selected });
  propsRef.current = { onSquare, selected };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x39524e,
      camera: { position: [0, 7.9, 5.8], lookAt: [0, 0, 0.55], fov: 40 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        const now = performance.now();
        const sel = propsRef.current.selected;
        for (const p of rt.pieces.values()) {
          if (p.anim) {
            p.anim.t += dt;
            const k = Math.min(1, p.anim.t / p.anim.dur);
            const ease = 1 - Math.pow(1 - k, 2);
            p.grp.position.lerpVectors(p.anim.from, p.anim.to, ease);
            p.grp.position.y = p.anim.from.y + (p.anim.to.y - p.anim.from.y) * ease + Math.sin(ease * Math.PI) * 0.18;
            if (k >= 1) {
              p.grp.position.copy(p.anim.to);
              p.anim = null;
            }
          } else if (p.cell === sel) {
            // 選択中の駒は持ち上げる。
            p.grp.position.y += (BASE_Y + 0.26 - p.grp.position.y) * Math.min(1, dt * 14);
          } else if (p.grp.position.y !== BASE_Y) {
            p.grp.position.y += (BASE_Y - p.grp.position.y) * Math.min(1, dt * 14);
          }
        }
        if (rt.selRing.visible) {
          (rt.selRing.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.3 * Math.sin(now / 240);
        }
        if (rt.checkGlow.visible) {
          (rt.checkGlow.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.25 * Math.sin(now / 200);
        }
        const pulse = 0.5 + 0.25 * Math.sin(now / 280);
        for (const m of rt.markers) {
          if (m.visible) (m.material as THREE.MeshBasicMaterial).opacity = pulse;
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    const boardTopMat = new THREE.MeshStandardMaterial({ map: boardTexture(WHITE), roughness: 0.75 });
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x46635e, roughness: 0.8 });
    const boardMesh = new THREE.Mesh(new THREE.BoxGeometry(8.3, 0.35, 8.3), [sideMat, sideMat, boardTopMat, sideMat, sideMat, sideMat]);
    boardMesh.position.y = -0.18;
    scene.add(boardMesh);

    // 合法手マーカー（空きマス=円盤、取りマス=リング）。位置は向きに追従させる。
    const markers: THREE.Mesh[] = [];
    const markerGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.04, 18);
    const captureRings: THREE.Mesh[] = [];
    const ringGeo = new THREE.TorusGeometry(0.4, 0.05, 10, 32);
    const lastPlanes: THREE.Mesh[] = [];
    const planeGeo = new THREE.PlaneGeometry(0.94, 0.94);
    for (let i = 0; i < 128; i++) {
      if (i & 0x88) continue;
      const m = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: 0x2e6e2e, transparent: true, opacity: 0.6 }));
      m.visible = false;
      scene.add(m);
      markers[i] = m;
      const r = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xd9534f, transparent: true, opacity: 0.85 }));
      r.rotation.x = Math.PI / 2;
      r.visible = false;
      scene.add(r);
      captureRings[i] = r;
      const p = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({ color: 0x427f87, transparent: true, opacity: 0.4, depthWrite: false }));
      p.rotation.x = -Math.PI / 2;
      p.visible = false;
      scene.add(p);
      lastPlanes[i] = p;
    }

    const selRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.44, 0.05, 10, 32),
      new THREE.MeshBasicMaterial({ color: 0xe6b93d, transparent: true, opacity: 0.8 }),
    );
    selRing.rotation.x = Math.PI / 2;
    selRing.visible = false;
    scene.add(selRing);

    const checkGlow = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.42, 0.03, 24),
      new THREE.MeshBasicMaterial({ color: 0xe0483e, transparent: true, opacity: 0.45 }),
    );
    checkGlow.visible = false;
    scene.add(checkGlow);

    // マスの当たり判定（pickId に 0x88 マス番号を持たせる）。
    const hitGeo = new THREE.BoxGeometry(PITCH * 0.96, 0.7, PITCH * 0.96);
    const hits: THREE.Mesh[] = [];
    for (let i = 0; i < 128; i++) {
      if (i & 0x88) continue;
      const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
      h.position.y = 0.2;
      h.userData.pickId = `sq-${i}`;
      h.userData.sq = i;
      scene.add(h);
      hits.push(h);
    }

    rtRef.current = { pieces: new Map(), markers, captureRings, lastPlanes, selRing, checkGlow, boardTopMat, scene, initialized: false };
    detach = attachPickPointer(stage, () => hits, {
      onTap: (hit) => {
        const sq = hit?.object.userData.sq as number | undefined;
        if (sq === undefined) return;
        propsRef.current.onSquare(sq);
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

  // 盤面同期: 駒の生成・移動（スライド）・除去・昇格差し替え、各種ハイライト。
  // 駒は「駒コード＋マス」の Map で管理し、外れた駒は同コードの予備として
  // 再利用する（移動した駒を拾って滑らせ、取られた駒だけが消える）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    rt.boardTopMat.map = boardTexture(playerColor);
    rt.boardTopMat.needsUpdate = true;

    const makePiece = (code: number, cell: number): PieceRt => {
      const grp = createChessPiece(code);
      const [x, z] = sqPos(cell, playerColor);
      grp.position.set(x, BASE_Y, z);
      rt.scene.add(grp);
      return { grp, code, cell, anim: null };
    };
    const facePieces = () => {
      // ナイトは敵方向（自軍と反対側）を向く。その他は回転なし。
      for (const p of rt.pieces.values()) {
        if ((p.code & 7) === 2) {
          const whitePiece = isWhiteCode(p.code);
          // 白は rank 増加方向、黒は rank 減少方向へ進む。表示では自軍が手前。
          const forwardIsNear = (playerColor === WHITE) === whitePiece;
          p.grp.rotation.y = forwardIsNear ? Math.PI : 0;
        }
      }
    };

    const desired = new Map<number, number>();
    board.forEach((code, sq) => {
      if (code !== 0) desired.set(sq, code);
    });
    const spares = new Map<number, PieceRt[]>();
    for (const [cell, p] of [...rt.pieces]) {
      if (desired.get(cell) === p.code) {
        desired.delete(cell);
        // 向きが変わった場合に備え位置を再計算する（通常は不変）。
        const [x, z] = sqPos(cell, playerColor);
        if (!p.anim) p.grp.position.set(x, p.grp.position.y, z);
      } else {
        rt.pieces.delete(cell);
        const list = spares.get(p.code) ?? [];
        list.push(p);
        spares.set(p.code, list);
      }
    }
    for (const [cell, code] of desired) {
      const spare = spares.get(code)?.pop();
      if (spare) {
        spare.cell = cell;
        const [x, z] = sqPos(cell, playerColor);
        const to = new THREE.Vector3(x, BASE_Y, z);
        spare.anim = rt.initialized ? { from: spare.grp.position.clone(), to, t: 0, dur: 0.32 } : null;
        if (!rt.initialized) spare.grp.position.copy(to);
        rt.pieces.set(cell, spare);
      } else {
        rt.pieces.set(cell, makePiece(code, cell));
      }
    }
    for (const list of spares.values()) {
      for (const p of list) rt.scene.remove(p.grp);
    }
    rt.initialized = true;
    facePieces();

    // マーカー・ハイライト類の位置（向きに追従）と表示。
    const place = (obj: THREE.Object3D, sq: number, y: number) => {
      const [x, z] = sqPos(sq, playerColor);
      obj.position.set(x, y, z);
    };
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      const isTarget = targets.includes(sq);
      const occupied = board[sq] !== 0;
      rt.markers[sq].visible = isTarget && !occupied;
      if (isTarget) place(rt.markers[sq], sq, 0.04);
      rt.captureRings[sq].visible = isTarget && occupied;
      if (isTarget && occupied) place(rt.captureRings[sq], sq, 0.06);
      const isLast = lastMove !== null && (lastMove.from === sq || lastMove.to === sq);
      rt.lastPlanes[sq].visible = isLast;
      if (isLast) place(rt.lastPlanes[sq], sq, 0.012);
    }
    if (selected !== null && rt.pieces.has(selected)) {
      place(rt.selRing, selected, 0.05);
      rt.selRing.visible = true;
    } else {
      rt.selRing.visible = false;
    }
    if (checkSquare !== null) {
      place(rt.checkGlow, checkSquare, 0.03);
      rt.checkGlow.visible = true;
    } else {
      rt.checkGlow.visible = false;
    }
  }, [board, playerColor, selected, targets, lastMove, checkSquare]);

  // 当たり判定マスの位置は向きに追従する。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    rt.scene.traverse((obj) => {
      const sq = obj.userData?.sq as number | undefined;
      if (sq === undefined) return;
      const [x, z] = sqPos(sq, playerColor);
      obj.position.x = x;
      obj.position.z = z;
    });
  }, [playerColor, ready]);

  return (
    <SceneBox
      height={460}
      label="チェス盤面（3D）。駒をタップして選び、移動先をタップします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#39524e"
    />
  );
}
