"use client";
// メモリーマッチ（神経衰弱）の 3D 盤。カードは薄い立体カードで表し、
// めくれは mesh の X 回転（裏向き = 背面が上 / 表向き = 絵柄面が上）を
// 補間で追従させるフリップアニメーションで表す。ペア確定（matched）の
// カードは少し持ち上げて金色に発光させる。
// カード表面の絵柄は 2D と同じ「形×色」を CanvasTexture に図形として描く
// （絵文字は使わない）。裏面は 2D と同じく白い星の図形を描く。
// 秘匿の扱い: 裏向きカードの絵柄はシーンへ渡さない。親は表向きの間だけ
// icon を渡し（icon: string | null）、シーンはめくれた瞬間に受け取った
// 絵柄で表面テクスチャを作る。照合・勝敗・状態遷移は親＋lib が正で、
// ここは表現と入力（タップ = 親の onFlip）だけを持つ。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import { memorySymbol } from "@/lib/memory-match";

export interface MemorySceneCard {
  faceUp: boolean;
  matched: boolean;
  /** 表向きの間だけ親が渡す絵柄 ID。裏向きは null（中身を渡さない）。 */
  icon: string | null;
}

interface Props {
  cards: MemorySceneCard[];
  /** カードのタップ = 既存のめくりハンドラ（親の onFlip）へそのまま渡す。 */
  onFlip: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const COLS = 4;
const CARD_W = 0.92;
const CARD_H = 1.24;
const PITCH_X = 1.06;
const PITCH_Z = 1.4;
const FACE_UP = -Math.PI / 2;
const FACE_DOWN = Math.PI / 2;

/** 2D の SVG 図形と同じ形を Canvas に描く（形×色は lib の memorySymbol が正）。 */
function drawShape(g: CanvasRenderingContext2D, icon: string) {
  const s = memorySymbol(icon);
  const cx = 64;
  const cy = 88;
  const r = 46;
  g.fillStyle = s.color;
  g.beginPath();
  switch (s.shape) {
    case "circle":
      g.arc(cx, cy, r, 0, Math.PI * 2);
      break;
    case "triangle":
      g.moveTo(cx, cy - r);
      g.lineTo(cx + r, cy + r * 0.85);
      g.lineTo(cx - r, cy + r * 0.85);
      g.closePath();
      break;
    case "square":
      g.rect(cx - r * 0.85, cy - r * 0.85, r * 1.7, r * 1.7);
      break;
    case "star":
      for (let i = 0; i < 10; i++) {
        const ang = (i * Math.PI) / 5 - Math.PI / 2;
        const rad = i % 2 === 0 ? r : r * 0.45;
        const x = cx + Math.cos(ang) * rad;
        const y = cy + Math.sin(ang) * rad;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      break;
    case "diamond":
      g.moveTo(cx, cy - r);
      g.lineTo(cx + r * 0.95, cy);
      g.lineTo(cx, cy + r);
      g.lineTo(cx - r * 0.95, cy);
      g.closePath();
      break;
    case "heart":
      g.moveTo(cx, cy + r * 0.9);
      g.bezierCurveTo(cx - r * 1.15, cy + r * 0.25, cx - r * 0.95, cy - r * 0.75, cx - r * 0.42, cy - r * 0.82);
      g.bezierCurveTo(cx - r * 0.12, cy - r * 0.88, cx, cy - r * 0.55, cx, cy - r * 0.3);
      g.bezierCurveTo(cx, cy - r * 0.55, cx + r * 0.12, cy - r * 0.88, cx + r * 0.42, cy - r * 0.82);
      g.bezierCurveTo(cx + r * 0.95, cy - r * 0.75, cx + r * 1.15, cy + r * 0.25, cx, cy + r * 0.9);
      break;
    case "pentagon":
      for (let i = 0; i < 5; i++) {
        const ang = (i * 2 * Math.PI) / 5 - Math.PI / 2;
        const x = cx + Math.cos(ang) * r;
        const y = cy + Math.sin(ang) * r;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      break;
    case "cross": {
      const a = r * 0.36;
      const b = r;
      g.moveTo(cx - a, cy - b);
      g.lineTo(cx + a, cy - b);
      g.lineTo(cx + a, cy - a);
      g.lineTo(cx + b, cy - a);
      g.lineTo(cx + b, cy + a);
      g.lineTo(cx + a, cy + a);
      g.lineTo(cx + a, cy + b);
      g.lineTo(cx - a, cy + b);
      g.lineTo(cx - a, cy + a);
      g.lineTo(cx - b, cy + a);
      g.lineTo(cx - b, cy - a);
      g.lineTo(cx - a, cy - a);
      g.closePath();
      break;
    }
  }
  g.fill();
}

function faceTexture(icon: string): THREE.CanvasTexture {
  return canvasTexture(`memory-face-${icon}`, 128, 176, (g) => {
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, 128, 176);
    drawShape(g, icon);
  });
}

function backTexture(): THREE.CanvasTexture {
  return canvasTexture("memory-back", 128, 176, (g) => {
    g.fillStyle = "#31517d";
    g.fillRect(0, 0, 128, 176);
    // 裏面は 2D と同じ白い星（文字ではなく図形として描く）。
    g.fillStyle = "#ffffff";
    g.beginPath();
    const cx = 64;
    const cy = 88;
    const r = 42;
    for (let i = 0; i < 10; i++) {
      const ang = (i * Math.PI) / 5 - Math.PI / 2;
      const rad = i % 2 === 0 ? r : r * 0.45;
      const x = cx + Math.cos(ang) * rad;
      const y = cy + Math.sin(ang) * rad;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    g.fill();
  });
}

function makeCardMesh(icon: string | null, pickId: string): THREE.Mesh {
  const edge = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.5 });
  const faceMat = new THREE.MeshStandardMaterial({
    map: icon ? faceTexture(icon) : undefined,
    color: icon ? 0xffffff : 0xf2f2f2,
    roughness: 0.45,
  });
  const backMat = new THREE.MeshStandardMaterial({ map: backTexture(), roughness: 0.5 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(CARD_W, CARD_H, 0.045), [edge, edge, edge, edge, faceMat, backMat]);
  mesh.rotation.x = FACE_DOWN;
  mesh.userData.pickId = pickId;
  return mesh;
}

/** 表面テクスチャを差し替える（めくれて絵柄が初めて分かった瞬間に作る）。 */
function setFaceIcon(mesh: THREE.Mesh, icon: string) {
  const mats = mesh.material as THREE.Material[];
  const next = mats.slice();
  next[4] = new THREE.MeshStandardMaterial({ map: faceTexture(icon), roughness: 0.45 });
  mesh.material = next;
}

function cellPos(index: number, total: number): [number, number] {
  const rows = Math.ceil(total / COLS);
  const r = Math.floor(index / COLS);
  const c = index % COLS;
  return [(c - (COLS - 1) / 2) * PITCH_X, (r - (rows - 1) / 2) * PITCH_Z];
}

function fitCamera(stage: Stage, container: HTMLElement, total: number) {
  const rows = Math.ceil(total / COLS);
  const boardW = COLS * PITCH_X + 0.6;
  const boardD = rows * PITCH_Z + 0.6;
  const w = container.clientWidth || 420;
  const h = container.clientHeight || 440;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (boardW / 2 + 0.4) / Math.tan(hFov / 2);
  const distD = ((boardD / 2 + 0.4) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.2;
  stage.setCamera({ position: [0, dist * 0.84, dist * 0.56], lookAt: [0, 0, 0.2], fov: 42 });
}

interface CardRt {
  grp: THREE.Group;
  mesh: THREE.Mesh;
  /** 現在表示に使っている絵柄（裏向きへ戻ってもテクスチャは保持する）。 */
  iconShown: string | null;
  faceUp: boolean;
  matched: boolean;
  targetRotX: number;
  targetY: number;
}

interface SceneRt {
  stage: Stage;
  cardsGroup: THREE.Group;
  slabGroup: THREE.Group;
  builtFor: number;
  cardsRt: Map<number, CardRt>;
}

export default function MemoryScene3D({ cards, onFlip, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onFlip });
  propsRef.current = { onFlip };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x22303c,
      camera: { position: [0, 7.6, 5.2], lookAt: [0, 0, 0.2], fov: 42 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        // フリップ回転と持ち上げを滑らかに追従させる（補間追従）。
        const k = 1 - Math.exp(-dt * 10);
        for (const c of rt.cardsRt.values()) {
          c.mesh.rotation.x += (c.targetRotX - c.mesh.rotation.x) * k;
          c.grp.position.y += (c.targetY - c.grp.position.y) * k;
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    const slabGroup = new THREE.Group();
    scene.add(slabGroup);
    const cardsGroup = new THREE.Group();
    scene.add(cardsGroup);
    rtRef.current = { stage, cardsGroup, slabGroup, builtFor: 0, cardsRt: new Map() };

    detach = attachPickPointer(stage, () => [cardsGroup], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (id) propsRef.current.onFlip(Number(id.slice(5)));
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

  // 盤面同期: 台は枚数が変わったときだけ作り直し、カードは差分同期する。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const total = cards.length;
    if (rt.builtFor !== total) {
      rt.builtFor = total;
      for (const child of [...rt.slabGroup.children]) rt.slabGroup.remove(child);
      const rows = Math.ceil(total / COLS);
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(COLS * PITCH_X + 0.5, 0.3, rows * PITCH_Z + 0.5),
        new THREE.MeshStandardMaterial({ color: 0x2e4a3f, roughness: 0.9 }),
      );
      slab.position.y = -0.16;
      rt.slabGroup.add(slab);
      const container = containerRef.current;
      if (container) fitCamera(rt.stage, container, total);
    }

    for (const [i, c] of [...rt.cardsRt]) {
      if (i >= total) {
        rt.cardsGroup.remove(c.grp);
        rt.cardsRt.delete(i);
      }
    }

    cards.forEach((card, i) => {
      const cur = rt.cardsRt.get(i);
      if (!cur) {
        const grp = new THREE.Group();
        const mesh = makeCardMesh(card.icon, `card-${i}`);
        grp.add(mesh);
        const [x, z] = cellPos(i, total);
        grp.position.set(x, 0, z);
        rt.cardsGroup.add(grp);
        const entry: CardRt = {
          grp,
          mesh,
          iconShown: card.icon,
          faceUp: card.faceUp,
          matched: card.matched,
          targetRotX: card.faceUp ? FACE_UP : FACE_DOWN,
          targetY: card.matched ? 0.22 : 0,
        };
        mesh.rotation.x = entry.targetRotX;
        rt.cardsRt.set(i, entry);
        return;
      }
      // めくれて絵柄が届いたら表面テクスチャを作る（裏向きでは届かない）。
      if (card.icon && cur.iconShown !== card.icon) {
        cur.iconShown = card.icon;
        setFaceIcon(cur.mesh, card.icon);
      }
      cur.faceUp = card.faceUp;
      cur.matched = card.matched;
      cur.targetRotX = card.faceUp ? FACE_UP : FACE_DOWN;
      cur.targetY = card.matched ? 0.22 : card.faceUp ? 0.05 : 0;
      // ペア確定は金色の発光で示す。
      const faceMat = (cur.mesh.material as THREE.Material[])[4] as THREE.MeshStandardMaterial;
      if (faceMat) {
        faceMat.emissive.setHex(card.matched ? 0xd9a41c : 0x000000);
        faceMat.emissiveIntensity = card.matched ? 0.35 : 0;
      }
      const [x, z] = cellPos(i, total);
      cur.grp.position.x = x;
      cur.grp.position.z = z;
    });
  }, [cards]);

  return (
    <SceneBox
      height={440}
      label="メモリーマッチの盤（3D）。カードをタップでめくります"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#22303c"
    />
  );
}
