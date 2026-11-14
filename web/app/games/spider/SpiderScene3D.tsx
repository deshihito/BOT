"use client";
// スパイダー・ソリティアの 3D シーン（カード系の型・ソリティア系拡張）。
// 場札10列（104枚）を createCard で立体化する。列が多いためカードを
// 小さめにし、カメラを引いて10列がモバイル幅でも切れない画角にする。
// 重なり間隔は列の長さに応じて圧縮し、盤内に収める（可読性の床を守る）。
// 上段右に山札5山（残り配布回数ぶん）、上段左に完成した組の山を置く。
// 状態・合法判定は lib/spider.ts とクライアントの既存ハンドラが持ち、
// ここは表現と入力の橋渡しだけを行う:
//   タップ = 既存の選択→移動（山札タップ=配る）
//   ドラッグ = 掴んだ束を移動先の列へ落とす（同じハンドラ経由で判定）
//   盤面の下フリック（カードを掴んでいないとき）= 山札から配る（2D と同じ）
// 数字（手数・完成組数・残り配布回数）は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createCard } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import {
  SPIDER_COLUMNS,
  spiderRankLabel,
  spiderStockDeals,
  type SpiderCard,
  type SpiderState,
} from "@/lib/spider";

export type SpiderSelection = { col: number; index: number } | null;
export type SpiderDragSource = { col: number; index: number };

interface Props {
  state: SpiderState;
  selection: SpiderSelection;
  onCardTap: (col: number, index: number) => void;
  onEmptyColumnTap: (col: number) => void;
  onDealTap: () => void;
  /** ドラッグの落下。合法で実際に移動したら true（不正なら束は元の位置へ戻る）。 */
  onDragDrop: (source: SpiderDragSource, toCol: number) => boolean;
  onFail: () => void;
  fallback: ReactNode;
}

const CARD_W = 0.74;
const CARD_H = 1.03;
const PITCH = 0.84;
const TOP_Z = -2.55;
const TAB_Z0 = -1.7;
const TAB_BUDGET = 5.6;
const FACE_UP = -Math.PI / 2;
const FACE_DOWN = Math.PI / 2;
const STOCK_X0 = 2.35;

function colX(col: number): number {
  return (col - (SPIDER_COLUMNS - 1) / 2) * PITCH;
}

function makeCardMesh(card: SpiderCard | null): THREE.Mesh {
  if (!card || !card.faceUp) {
    return createCard(CARD_W, CARD_H, { back: 0x334155 });
  }
  return createCard(CARD_W, CARD_H, {
    label: `${spiderRankLabel(card.rank)}♠`,
    labelColor: "#1c2333",
  });
}

/** 列内の各カードの Z オフセット（伏せは詰め、表は広く。長い列は圧縮する）。 */
function columnOffsets(pile: SpiderCard[]): number[] {
  const offsets = [0];
  let total = 0;
  for (let i = 1; i < pile.length; i++) {
    total += pile[i - 1].faceUp ? 0.36 : 0.24;
    offsets.push(total);
  }
  if (total > TAB_BUDGET) {
    const s = TAB_BUDGET / total;
    for (let i = 0; i < offsets.length; i++) offsets[i] *= s;
  }
  return offsets;
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

interface CardAnim {
  start: number;
  dur: number;
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromRotX: number;
  toRotX: number;
  arc: number;
}

interface CardEntry {
  cardKey: string;
  faceUp: boolean;
  group: THREE.Group;
  mesh: THREE.Mesh;
  highlight: THREE.Mesh;
  anim: CardAnim | null;
}

interface DragRt {
  source: SpiderDragSource;
  slots: string[];
  base: Map<string, THREE.Vector3>;
  startPoint: THREE.Vector3 | null;
  lastPoint: THREE.Vector3 | null;
}

interface SceneRt {
  cardsGroup: THREE.Group;
  slotsGroup: THREE.Group;
  stockGroup: THREE.Group;
  entries: Map<string, CardEntry>;
  emptySlots: THREE.Mesh[];
  stockDeals: number;
  completed: number;
}

export default function SpiderScene3D({
  state, selection, onCardTap, onEmptyColumnTap, onDealTap, onDragDrop, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const dragRef = useRef<DragRt | null>(null);

  const propsRef = useRef({ state, selection, onCardTap, onEmptyColumnTap, onDealTap, onDragDrop });
  propsRef.current = { state, selection, onCardTap, onEmptyColumnTap, onDealTap, onDragDrop };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x1a2436,
      camera: { position: [0, 11, 10], lookAt: [0, 0, 0.5], fov: 42 },
      onFrame: () => {
        const rt = rtRef.current;
        if (!rt) return;
        const now = performance.now();
        for (const e of rt.entries.values()) {
          if (!e.anim) continue;
          const a = e.anim;
          const k = Math.min(1, Math.max(0, (now - a.start) / a.dur));
          const ease = 1 - Math.pow(1 - k, 3);
          e.group.position.lerpVectors(a.fromPos, a.toPos, ease);
          e.group.position.y += Math.sin(k * Math.PI) * a.arc;
          e.mesh.rotation.x = a.fromRotX + (a.toRotX - a.fromRotX) * ease;
          if (k >= 1) e.anim = null;
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    const rim = new THREE.Mesh(
      new THREE.BoxGeometry(9.2, 0.14, 9.8),
      new THREE.MeshStandardMaterial({ color: 0x3d2c1c, roughness: 0.6 }),
    );
    rim.position.set(0, -0.1, 0.7);
    scene.add(rim);
    const felt = new THREE.Mesh(
      new THREE.BoxGeometry(8.8, 0.16, 9.4),
      new THREE.MeshStandardMaterial({ color: 0x24354d, roughness: 1 }),
    );
    felt.position.set(0, -0.04, 0.7);
    scene.add(felt);

    const slotsGroup = new THREE.Group();
    scene.add(slotsGroup);
    const slotMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, transparent: true, opacity: 0.13, roughness: 0.9,
    });
    const slotGeo = new THREE.BoxGeometry(CARD_W + 0.05, 0.02, CARD_H + 0.05);
    const emptySlots: THREE.Mesh[] = [];
    for (let c = 0; c < SPIDER_COLUMNS; c++) {
      const m = new THREE.Mesh(slotGeo, slotMat);
      m.position.set(colX(c), 0.02, TAB_Z0);
      m.userData.pickId = `empty-col-${c}`;
      m.visible = false;
      slotsGroup.add(m);
      emptySlots.push(m);
    }

    const stockGroup = new THREE.Group();
    scene.add(stockGroup);
    const cardsGroup = new THREE.Group();
    scene.add(cardsGroup);
    rtRef.current = {
      cardsGroup, slotsGroup, stockGroup,
      entries: new Map(), emptySlots, stockDeals: -1, completed: -1,
    };

    const parseCard = (id: string): { col: number; index: number } | null => {
      const m = /^card-(\d+)-(\d+)$/.exec(id);
      return m ? { col: Number(m[1]), index: Number(m[2]) } : null;
    };

    detach = attachPickPointer(
      stage,
      () => [cardsGroup, slotsGroup, stockGroup],
      {
        onTap: (hit) => {
          const id = findPickId(hit?.object ?? null);
          const p = propsRef.current;
          if (!id) return;
          if (id === "stock") { p.onDealTap(); return; }
          if (id.startsWith("empty-col-")) {
            p.onEmptyColumnTap(Number(id.slice("empty-col-".length)));
            return;
          }
          const card = parseCard(id);
          if (card) {
            // 裏向きカードは 2D でもタップ対象外（選択中の置き先にもならない）。
            const target = p.state.columns[card.col]?.[card.index];
            if (target?.faceUp) p.onCardTap(card.col, card.index);
          }
        },
        onFlick: (f) => {
          if (f.dir === "down") propsRef.current.onDealTap();
        },
        onDragStart: (hit) => {
          const id = findPickId(hit.object);
          const p = propsRef.current;
          const rt = rtRef.current;
          if (!id || !rt) return;
          const card = parseCard(id);
          if (!card) return;
          const pile = p.state.columns[card.col];
          if (!pile || !pile[card.index]?.faceUp) return;
          const slots = pile.slice(card.index).map((_, k) => `c${card.col}-${card.index + k}`);
          const base = new Map<string, THREE.Vector3>();
          for (const s of slots) {
            const e = rt.entries.get(s);
            if (e) {
              e.anim = null;
              base.set(s, e.group.position.clone());
            }
          }
          if (base.size === 0) return;
          dragRef.current = {
            source: { col: card.col, index: card.index },
            slots, base, startPoint: null, lastPoint: null,
          };
        },
        onDragMove: (point) => {
          const drag = dragRef.current;
          const rt = rtRef.current;
          if (!drag || !rt) return;
          if (!drag.startPoint) drag.startPoint = point.clone();
          drag.lastPoint = point.clone();
          const dx = point.x - drag.startPoint.x;
          const dz = point.z - drag.startPoint.z;
          for (const s of drag.slots) {
            const e = rt.entries.get(s);
            const b = drag.base.get(s);
            if (e && b) e.group.position.set(b.x + dx, 0.32, b.z + dz);
          }
        },
        onDragEnd: (flick, hit) => {
          const drag = dragRef.current;
          dragRef.current = null;
          if (!drag) {
            if (flick.dir === "down") propsRef.current.onDealTap();
            return;
          }
          const rt = rtRef.current;
          let toCol: number | null = null;
          const hitId = findPickId(hit?.object ?? null);
          if (hitId) {
            const card = parseCard(hitId);
            if (card) toCol = card.col;
            else if (hitId.startsWith("empty-col-")) {
              toCol = Number(hitId.slice("empty-col-".length));
            }
          }
          if (toCol === null && drag.lastPoint && drag.lastPoint.z > TAB_Z0 - 0.9) {
            toCol = Math.max(
              0,
              Math.min(SPIDER_COLUMNS - 1, Math.round(drag.lastPoint.x / PITCH + (SPIDER_COLUMNS - 1) / 2)),
            );
          }
          const ok = toCol !== null ? propsRef.current.onDragDrop(drag.source, toCol) : false;
          if (!ok && rt) {
            const now = performance.now();
            for (const s of drag.slots) {
              const e = rt.entries.get(s);
              const b = drag.base.get(s);
              if (e && b) {
                e.anim = {
                  start: now, dur: 260,
                  fromPos: e.group.position.clone(), toPos: b.clone(),
                  fromRotX: e.mesh.rotation.x, toRotX: e.mesh.rotation.x, arc: 0.05,
                };
              }
            }
          }
        },
      },
      { planeY: 0.32 },
    );
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
      dragRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 盤面の差分同期（スロット=列×位置）。104枚でも毎回全生成はしない。
  // 新規カード（配布・移動）は移動元の最終位置（無ければ山札位置）から移動し、
  // 伏せ札が表になる瞬間はその場フリップする。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const now = performance.now();
    const stockSpawn = new THREE.Vector3(STOCK_X0, 0.05, TOP_Z);

    // 山札（残り配布回数ぶんの山）と完成した組の山
    const deals = spiderStockDeals(state);
    if (rt.stockDeals !== deals || rt.completed !== state.completed) {
      rt.stockDeals = deals;
      rt.completed = state.completed;
      while (rt.stockGroup.children.length > 0) rt.stockGroup.remove(rt.stockGroup.children[0]);
      for (let d = 0; d < deals; d++) {
        const g = new THREE.Group();
        g.position.set(STOCK_X0 + d * 0.52, 0.05, TOP_Z);
        for (let i = 0; i < 3; i++) {
          const m = makeCardMesh(null);
          m.rotation.x = FACE_DOWN;
          m.position.y = i * 0.016;
          m.userData.pickId = "stock";
          g.add(m);
        }
        g.userData.pickId = "stock";
        rt.stockGroup.add(g);
      }
      for (let c = 0; c < state.completed; c++) {
        const g = new THREE.Group();
        g.position.set(colX(0) + c * 0.52, 0.05, TOP_Z);
        for (let i = 0; i < 2; i++) {
          const m = createCard(CARD_W, CARD_H, { back: 0x8a6d1f });
          m.rotation.x = FACE_DOWN;
          m.position.y = i * 0.016;
          g.add(m);
        }
        rt.stockGroup.add(g);
      }
    }

    const desired = new Map<string, { card: SpiderCard; pos: THREE.Vector3; pickId: string; selected: boolean }>();
    state.columns.forEach((pile, col) => {
      const offsets = columnOffsets(pile);
      pile.forEach((card, index) => {
        const sel = selection !== null && selection.col === col && index >= selection.index;
        desired.set(`c${col}-${index}`, {
          card,
          pos: new THREE.Vector3(colX(col), sel ? 0.22 : 0.05, TAB_Z0 + offsets[index]),
          pickId: `card-${col}-${index}`,
          selected: sel,
        });
      });
    });
    rt.emptySlots.forEach((m, col) => {
      m.visible = state.columns[col].length === 0;
    });

    const lastPosByCard = new Map<string, THREE.Vector3>();
    for (const [slot, e] of [...rt.entries]) {
      const d = desired.get(slot);
      if (!d || d.card.id !== e.cardKey) {
        lastPosByCard.set(e.cardKey, e.group.position.clone());
        rt.cardsGroup.remove(e.group);
        rt.entries.delete(slot);
      }
    }

    for (const [slot, d] of desired) {
      const entry = rt.entries.get(slot);
      if (!entry) {
        const group = new THREE.Group();
        const from = lastPosByCard.get(d.card.id) ?? stockSpawn;
        group.position.copy(from);
        const mesh = makeCardMesh(d.card);
        mesh.rotation.x = d.card.faceUp ? FACE_UP : FACE_DOWN;
        mesh.userData.pickId = d.pickId;
        group.add(mesh);
        const highlight = new THREE.Mesh(
          new THREE.BoxGeometry(CARD_W + 0.09, 0.02, CARD_H + 0.09),
          new THREE.MeshBasicMaterial({ color: 0x5b9dff }),
        );
        highlight.position.y = -0.02;
        highlight.visible = d.selected;
        highlight.userData.pickId = d.pickId;
        group.add(highlight);
        group.userData.pickId = d.pickId;
        rt.cardsGroup.add(group);
        const dist = group.position.distanceTo(d.pos);
        rt.entries.set(slot, {
          cardKey: d.card.id,
          faceUp: d.card.faceUp,
          group, mesh, highlight,
          anim: {
            start: now, dur: 380,
            fromPos: group.position.clone(), toPos: d.pos.clone(),
            fromRotX: mesh.rotation.x, toRotX: mesh.rotation.x,
            arc: Math.min(0.5, dist * 0.3),
          },
        });
        continue;
      }
      entry.group.userData.pickId = d.pickId;
      entry.mesh.userData.pickId = d.pickId;
      entry.highlight.visible = d.selected;
      entry.highlight.userData.pickId = d.pickId;
      if (entry.faceUp !== d.card.faceUp) {
        const oldRot = entry.mesh.rotation.x;
        entry.group.remove(entry.mesh);
        const mesh = makeCardMesh(d.card);
        mesh.rotation.x = oldRot;
        mesh.userData.pickId = d.pickId;
        entry.group.add(mesh);
        entry.mesh = mesh;
        entry.faceUp = d.card.faceUp;
        entry.anim = {
          start: now, dur: 460,
          fromPos: entry.group.position.clone(), toPos: d.pos.clone(),
          fromRotX: oldRot, toRotX: d.card.faceUp ? FACE_UP : FACE_DOWN, arc: 0,
        };
        continue;
      }
      if (entry.group.position.distanceTo(d.pos) > 0.01 && !entry.anim) {
        entry.anim = {
          start: now, dur: 300,
          fromPos: entry.group.position.clone(), toPos: d.pos.clone(),
          fromRotX: entry.mesh.rotation.x, toRotX: entry.mesh.rotation.x, arc: 0.06,
        };
      }
    }
  }, [state, selection]);

  return (
    <SceneBox
      height={520}
      label={`スパイダーソリティア（3D）。完成 ${state.completed}組、山札からあと ${spiderStockDeals(state)}回配れます。カードをタップで選び移動先をタップ、ドラッグでも移動できます`}
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#1a2436"
    />
  );
}
