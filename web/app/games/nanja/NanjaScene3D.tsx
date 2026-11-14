"use client";
// ナンジャモンジャ風の 3D シーン。山札からめくられるカードと生き物を立体化する:
//   場の山 = 立ち並ぶカードの積層（一番上が最新）、その手前に生き物の立体トークン
//   山札   = 裏向きカードの積層（残り枚数に応じて層数が変わる）
// 生き物は lib/online/games/nanja.ts の NANJA_CREATURES と同じ色×形で判別する
// （丸=球 / 三角=三角錐 / 四角=立方体 / 星=星型押し出し / 菱形=八面体）。
// 名前は「覚える」ことが勝負なので 3D 内には一切置かず、親 DOM の併記が担う。
// カードの文字テクスチャにも依存しない（カード面は無地、判別は色と造形だけ）。
// 入力: 山札（と場のカード）のタップ = 既存の「カードをめくる」操作（flip）。
// めくれるかどうか（手番・フェーズ）の判定は親が canFlip で渡し、シーンは
// onFlip を呼ぶだけ。命名・叫ぶはテキスト入力が本質なので DOM のまま残す。
// 新しいカードは山札位置から場へ飛びながら Y 回転でフリップして現れ、
// 山が流れる/取られるときは沈みながら縮んで消える（キー単位 Map の差分同期）。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createCard, createStone } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

interface Props {
  /** 場の山の一番上の生き物 id（無ければ null）。 */
  top: number | null;
  /** 場の山（めくられた順・末尾が一番上）。 */
  pile: number[];
  pileCount: number;
  deckCount: number;
  /** 自分が今めくれる状態か（親が手番・フェーズで判定済み）。 */
  canFlip: boolean;
  /** 山札タップ = 既存の flip ハンドラ。 */
  onFlip: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

/** lib の NANJA_CREATURES と同じ並び（表示専用に色と形だけ複製）。 */
const CREATURES: { color: string; shape: string }[] = [
  { color: "#d93a3a", shape: "circle" }, { color: "#d93a3a", shape: "triangle" },
  { color: "#d93a3a", shape: "square" }, { color: "#d93a3a", shape: "star" },
  { color: "#d93a3a", shape: "diamond" },
  { color: "#2f6fd0", shape: "circle" }, { color: "#2f6fd0", shape: "triangle" },
  { color: "#2f6fd0", shape: "square" }, { color: "#2f6fd0", shape: "star" },
  { color: "#2f6fd0", shape: "diamond" },
  { color: "#2f9e5f", shape: "circle" }, { color: "#2f9e5f", shape: "triangle" },
  { color: "#2f9e5f", shape: "square" }, { color: "#2f9e5f", shape: "star" },
  { color: "#2f9e5f", shape: "diamond" },
  { color: "#e0aa00", shape: "circle" }, { color: "#e0aa00", shape: "triangle" },
  { color: "#e0aa00", shape: "square" }, { color: "#e0aa00", shape: "star" },
  { color: "#e0aa00", shape: "diamond" },
  { color: "#ef7d1a", shape: "circle" }, { color: "#ef7d1a", shape: "triangle" },
  { color: "#ef7d1a", shape: "square" }, { color: "#ef7d1a", shape: "star" },
  { color: "#ef7d1a", shape: "diamond" },
  { color: "#8b4fc0", shape: "circle" }, { color: "#8b4fc0", shape: "triangle" },
  { color: "#8b4fc0", shape: "square" }, { color: "#8b4fc0", shape: "star" },
  { color: "#8b4fc0", shape: "diamond" },
];

const CARD_W = 1.05;
const CARD_H = 1.45;
const PILE_POS = new THREE.Vector3(-1.05, CARD_H / 2 + 0.06, 0);
const DECK_POS = new THREE.Vector3(1.35, 0, 0.1);
const MAX_PILE_LAYERS = 6;
const MAX_DECK_LAYERS = 10;

function colorInt(hex: string): number {
  return parseInt(hex.slice(1), 16);
}

/** 生き物の立体トークン（色×形の造形のみ。顔や文字は描かない）。 */
function createCreature(id: number): THREE.Group {
  const c = CREATURES[id] ?? CREATURES[0];
  const col = colorInt(c.color);
  const grp = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.42 });
  // 台座（全種共通の丸い足場）。
  const base = createStone(0.34, 0x3a3f47);
  base.position.y = 0.05;
  grp.add(base);
  let body: THREE.Mesh;
  if (c.shape === "triangle") {
    body = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.4, 0.66, 3), mat);
    body.position.y = 0.48;
  } else if (c.shape === "square") {
    body = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.56, 0.56), mat);
    body.position.y = 0.46;
    body.rotation.y = Math.PI / 5;
  } else if (c.shape === "star") {
    const shape = new THREE.Shape();
    for (let i = 0; i < 10; i++) {
      const a = (i * Math.PI) / 5 - Math.PI / 2;
      const r = i % 2 === 0 ? 0.4 : 0.17;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    shape.closePath();
    body = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.2, bevelEnabled: false }), mat);
    body.position.set(0, 0.5, -0.1);
  } else if (c.shape === "diamond") {
    body = new THREE.Mesh(new THREE.OctahedronGeometry(0.4), mat);
    body.scale.y = 1.3;
    body.position.y = 0.55;
  } else {
    // circle
    body = new THREE.Mesh(new THREE.SphereGeometry(0.36, 22, 16), mat);
    body.position.y = 0.5;
  }
  grp.add(body);
  // 頭頂の小さなアンテナ球（全種共通のアクセント。色は白で統一）。
  const tip = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 }),
  );
  tip.position.y = c.shape === "diamond" ? 1.12 : 0.92;
  grp.add(tip);
  return grp;
}

function findPickId(obj: THREE.Object3D | null): string | null {
  let cur: THREE.Object3D | null = obj;
  while (cur) {
    const id = cur.userData.pickId as string | undefined;
    if (id) return id;
    cur = cur.parent;
  }
  return null;
}

interface EntryAnim {
  start: number;
  dur: number;
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  arc: number;
  flip: boolean;
}

interface Entry {
  creatureId: number;
  group: THREE.Group;
  flipGroup: THREE.Group;
  anim: EntryAnim | null;
  exiting: boolean;
  exitStart: number;
}

interface SceneRt {
  root: THREE.Group;
  entries: Map<string, Entry>;
  deckGroup: THREE.Group;
}

export default function NanjaScene3D({ top, pile, pileCount, deckCount, canFlip, onFlip, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ canFlip, onFlip });
  propsRef.current = { canFlip, onFlip };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x232b26,
      camera: { position: [0, 3.4, 5.6], lookAt: [0, 0.55, 0], fov: 42 },
      onFrame: () => {
        const rt = rtRef.current;
        if (!rt) return;
        const now = performance.now();
        for (const [key, e] of [...rt.entries]) {
          if (e.exiting) {
            const k = Math.min(1, (now - e.exitStart) / 220);
            e.group.scale.setScalar(Math.max(0.001, 1 - k));
            e.group.position.y -= 0.012;
            if (k >= 1) {
              e.group.parent?.remove(e.group);
              rt.entries.delete(key);
            }
            continue;
          }
          if (!e.anim) continue;
          const a = e.anim;
          const k = Math.min(1, Math.max(0, (now - a.start) / a.dur));
          const ease = 1 - Math.pow(1 - k, 3);
          e.group.position.lerpVectors(a.fromPos, a.toPos, ease);
          e.group.position.y += Math.sin(k * Math.PI) * a.arc;
          if (a.flip) e.flipGroup.rotation.y = (1 - ease) * Math.PI;
          if (k >= 1) {
            e.anim = null;
            e.flipGroup.rotation.y = 0;
          }
        }
        // めくれる番のときは山札が軽く上下して合図する。
        if (rt.deckGroup) {
          const target = propsRef.current.canFlip ? 0.06 + Math.sin(now / 280) * 0.03 : 0;
          rt.deckGroup.position.y += (target - rt.deckGroup.position.y) * 0.2;
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    const table = new THREE.Mesh(
      new THREE.CylinderGeometry(3.1, 3.3, 0.18, 40),
      new THREE.MeshStandardMaterial({ color: 0x2e4a38, roughness: 0.9 }),
    );
    table.position.y = -0.1;
    scene.add(table);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(3.1, 0.05, 10, 48),
      new THREE.MeshStandardMaterial({ color: 0x8a6f45, roughness: 0.5 }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.0;
    scene.add(rim);

    const root = new THREE.Group();
    scene.add(root);
    const deckGroup = new THREE.Group();
    deckGroup.position.copy(DECK_POS);
    scene.add(deckGroup);
    rtRef.current = { root, entries: new Map(), deckGroup };

    detach = attachPickPointer(stage, () => [root, deckGroup], {
      onTap: (hit) => {
        const id = findPickId(hit?.object ?? null);
        if (id !== "flip") return;
        if (!propsRef.current.canFlip) return;
        propsRef.current.onFlip();
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

  // 差分同期: 場の山（末尾最大6層＋一番上の生き物）と山札の層をキー単位で管理。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const now = performance.now();
    const desired = new Map<string, { creatureId: number; pos: THREE.Vector3; isTop: boolean; layer: number }>();
    const startIdx = Math.max(0, pile.length - MAX_PILE_LAYERS);
    for (let i = startIdx; i < pile.length; i++) {
      const layer = i - startIdx;
      desired.set(`pile-${i}`, {
        creatureId: pile[i],
        pos: new THREE.Vector3(PILE_POS.x - layer * 0.07, PILE_POS.y + layer * 0.035, PILE_POS.z - layer * 0.06),
        isTop: i === pile.length - 1,
        layer,
      });
    }
    const deckLayers = deckCount <= 0 ? 0 : Math.min(MAX_DECK_LAYERS, Math.max(1, Math.ceil(deckCount / 12)));
    for (let i = 0; i < deckLayers; i++) {
      desired.set(`deck-${i}`, {
        creatureId: -1,
        pos: new THREE.Vector3(DECK_POS.x, 0.05 + i * 0.05, DECK_POS.z),
        isTop: false,
        layer: i,
      });
    }
    void top;
    void pileCount;

    // 消滅は即削除せず、縮小アニメーション付きで退出させる。
    for (const [key, e] of [...rt.entries]) {
      if (!desired.has(key) && !e.exiting) {
        e.exiting = true;
        e.exitStart = now;
        e.anim = null;
      }
    }
    for (const [key, d] of desired) {
      const existing = rt.entries.get(key);
      if (existing && !existing.exiting && existing.creatureId === d.creatureId) {
        const targetPos = key.startsWith("deck-") ? new THREE.Vector3(0, d.pos.y, 0) : d.pos;
        if (existing.group.position.distanceTo(targetPos) > 0.01 && !existing.anim) {
          existing.anim = { start: now, dur: 260, fromPos: existing.group.position.clone(), toPos: targetPos.clone(), arc: 0.04, flip: false };
        }
        continue;
      }
      if (existing) {
        existing.group.parent?.remove(existing.group);
        rt.entries.delete(key);
      }
      const group = new THREE.Group();
      const flipGroup = new THREE.Group();
      group.add(flipGroup);
      const isDeck = key.startsWith("deck-");
      if (isDeck) {
        const card = createCard(CARD_W, CARD_H, { back: 0x8a7a55 });
        card.rotation.x = Math.PI / 2; // 裏面を上へ
        card.userData.pickId = "flip";
        flipGroup.add(card);
        // 山札の層は deckGroup（合図の上下動）の子としてローカル座標で置く。
        group.position.set(0, d.pos.y, 0);
      } else {
        const card = createCard(CARD_W, CARD_H, { face: "#fffdf6" });
        card.userData.pickId = "flip";
        flipGroup.add(card);
        if (d.isTop) {
          const creature = createCreature(d.creatureId);
          creature.position.set(0, -CARD_H / 2 - 0.02, 0.62);
          creature.traverse((o) => { o.userData.pickId = "flip"; });
          group.add(creature);
        }
        // 新しい場カードは山札位置から飛んでフリップする。
        group.position.copy(DECK_POS).add(new THREE.Vector3(0, 0.9, 0));
      }
      if (isDeck) rt.deckGroup.add(group);
      else rt.root.add(group);
      const targetPos = isDeck ? new THREE.Vector3(0, d.pos.y, 0) : d.pos.clone();
      const dist = group.position.distanceTo(targetPos);
      const fromPos = isDeck
        ? group.position.clone().add(new THREE.Vector3(0, 0.25, 0))
        : group.position.clone();
      if (isDeck) group.position.copy(fromPos);
      rt.entries.set(key, {
        creatureId: d.creatureId,
        group,
        flipGroup,
        anim: { start: now, dur: isDeck ? 200 : 480, fromPos, toPos: targetPos, arc: isDeck ? 0 : Math.min(0.7, dist * 0.35), flip: !isDeck },
        exiting: false,
        exitStart: 0,
      });
    }
  }, [pile, pileCount, deckCount, top, ready]);

  return (
    <SceneBox
      height={300}
      label={`ナンジャモンジャ風（3D）。場の山 ${pileCount}枚、山札 残り ${deckCount}枚。山札のタップでカードをめくります`}
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#232b26"
    />
  );
}
