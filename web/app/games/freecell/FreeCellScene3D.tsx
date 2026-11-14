"use client";
// フリーセルの 3D シーン（カード系の型・ソリティア系拡張）。
// 場札8列＋フリーセル4枠＋組札4枠を createCard で立体化する。上段は
// 左半分がフリーセル枠（青寄りの枠）、右半分が組札枠（金寄りの枠）で、
// 3D でも両者の区別が付く配置にする。列が長い場合は間隔を圧縮する。
// 状態・合法判定は lib/freecell.ts とクライアントの既存ハンドラが持ち、
// ここは表現と入力の橋渡しだけを行う:
//   タップ = 既存の選択→移動（フリーセル/組札タップも同じ）
//   ドラッグ = 掴んだ束を移動先（列/フリーセル/組札）へ落とす
//   盤面の左/右フリック（カードを掴んでいないとき）= 2D 盤面スワイプと同じ
//     （左=1手戻す、右=自動送り）
// 数字（残り枚数・手数・移動可能枚数）は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createCard } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import {
  FC_COLUMNS,
  isRedSuit,
  rankLabel,
  suitSymbol,
  type FcCard,
  type FcState,
  type FcTarget,
} from "@/lib/freecell";

export type FcSelection =
  | { kind: "column"; column: number; startIndex: number }
  | { kind: "freecell"; index: number }
  | null;

export type FcDragSource =
  | { kind: "column"; column: number; startIndex: number }
  | { kind: "freecell"; index: number };

interface Props {
  state: FcState;
  selected: FcSelection;
  onColumnCardTap: (column: number, position: number) => void;
  onEmptyColumnTap: (column: number) => void;
  onFreeCellTap: (index: number) => void;
  onFoundationTap: (index: number) => void;
  /** ドラッグの落下。合法で実際に移動したら true（不正なら束は元の位置へ戻る）。 */
  onDragDrop: (source: FcDragSource, target: FcTarget) => boolean;
  onBoardSwipe: (dir: "left" | "right") => void;
  onFail: () => void;
  fallback: ReactNode;
}

const CARD_W = 0.84;
const CARD_H = 1.17;
const PITCH = 0.95;
const TOP_Z = -2.3;
const TAB_Z0 = -1.45;
const TAB_BUDGET = 5.0;
const FACE_UP = -Math.PI / 2;
const SPAWN_POS = new THREE.Vector3(0, 0.05, TOP_Z);

function colX(col: number): number {
  return (col - (FC_COLUMNS - 1) / 2) * PITCH;
}

function makeCardMesh(card: FcCard): THREE.Mesh {
  return createCard(CARD_W, CARD_H, {
    label: `${rankLabel(card.rank)}${suitSymbol(card.suit)}`,
    labelColor: isRedSuit(card.suit) ? "#c62828" : "#1c2333",
  });
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
  arc: number;
}

interface CardEntry {
  cardKey: string;
  group: THREE.Group;
  mesh: THREE.Mesh;
  highlight: THREE.Mesh;
  anim: CardAnim | null;
}

interface DragRt {
  source: FcDragSource;
  slots: string[];
  base: Map<string, THREE.Vector3>;
  startPoint: THREE.Vector3 | null;
  lastPoint: THREE.Vector3 | null;
}

interface SceneRt {
  cardsGroup: THREE.Group;
  slotsGroup: THREE.Group;
  entries: Map<string, CardEntry>;
  emptyColumnSlots: THREE.Mesh[];
}

export default function FreeCellScene3D({
  state, selected, onColumnCardTap, onEmptyColumnTap, onFreeCellTap, onFoundationTap,
  onDragDrop, onBoardSwipe, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const dragRef = useRef<DragRt | null>(null);

  const propsRef = useRef({
    state, selected, onColumnCardTap, onEmptyColumnTap, onFreeCellTap, onFoundationTap,
    onDragDrop, onBoardSwipe,
  });
  propsRef.current = {
    state, selected, onColumnCardTap, onEmptyColumnTap, onFreeCellTap, onFoundationTap,
    onDragDrop, onBoardSwipe,
  };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x14231c,
      camera: { position: [0, 9.8, 9.0], lookAt: [0, 0, 0.5], fov: 42 },
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
      new THREE.BoxGeometry(8.2, 0.14, 9.0),
      new THREE.MeshStandardMaterial({ color: 0x5b3a22, roughness: 0.6 }),
    );
    rim.position.set(0, -0.1, 0.6);
    scene.add(rim);
    const felt = new THREE.Mesh(
      new THREE.BoxGeometry(7.8, 0.16, 8.6),
      new THREE.MeshStandardMaterial({ color: 0x1e5c3a, roughness: 1 }),
    );
    felt.position.set(0, -0.04, 0.6);
    scene.add(felt);

    const slotsGroup = new THREE.Group();
    scene.add(slotsGroup);
    const slotGeo = new THREE.BoxGeometry(CARD_W + 0.05, 0.02, CARD_H + 0.05);
    const freeMat = new THREE.MeshStandardMaterial({
      color: 0x7db4ff, transparent: true, opacity: 0.22, roughness: 0.9,
    });
    const foundMat = new THREE.MeshStandardMaterial({
      color: 0xf5b301, transparent: true, opacity: 0.2, roughness: 0.9,
    });
    const colMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, transparent: true, opacity: 0.13, roughness: 0.9,
    });
    const addSlot = (pickId: string, x: number, z: number, mat: THREE.Material): THREE.Mesh => {
      const m = new THREE.Mesh(slotGeo, mat);
      m.position.set(x, 0.02, z);
      m.userData.pickId = pickId;
      slotsGroup.add(m);
      return m;
    };
    // 上段: 左4つがフリーセル枠、右4つが組札枠（色で区別する）
    for (let i = 0; i < 4; i++) addSlot(`freecell-${i}`, colX(i), TOP_Z, freeMat);
    for (let i = 0; i < 4; i++) addSlot(`foundation-${i}`, colX(4 + i), TOP_Z, foundMat);
    const emptyColumnSlots: THREE.Mesh[] = [];
    for (let c = 0; c < FC_COLUMNS; c++) {
      const m = addSlot(`empty-col-${c}`, colX(c), TAB_Z0, colMat);
      m.visible = false;
      emptyColumnSlots.push(m);
    }

    const cardsGroup = new THREE.Group();
    scene.add(cardsGroup);
    rtRef.current = { cardsGroup, slotsGroup, entries: new Map(), emptyColumnSlots };

    const parseCard = (id: string): { col: number; index: number } | null => {
      const m = /^card-(\d+)-(\d+)$/.exec(id);
      return m ? { col: Number(m[1]), index: Number(m[2]) } : null;
    };

    const handleSwipe = (dir: string | null) => {
      if (dir === "left" || dir === "right") propsRef.current.onBoardSwipe(dir);
    };

    detach = attachPickPointer(
      stage,
      () => [cardsGroup, slotsGroup],
      {
        onTap: (hit) => {
          const id = findPickId(hit?.object ?? null);
          const p = propsRef.current;
          if (!id) return;
          if (id.startsWith("freecell-")) {
            p.onFreeCellTap(Number(id.slice("freecell-".length)));
            return;
          }
          if (id.startsWith("foundation-")) {
            p.onFoundationTap(Number(id.slice("foundation-".length)));
            return;
          }
          if (id.startsWith("empty-col-")) {
            p.onEmptyColumnTap(Number(id.slice("empty-col-".length)));
            return;
          }
          const card = parseCard(id);
          if (card) p.onColumnCardTap(card.col, card.index);
        },
        onFlick: (f) => handleSwipe(f.dir),
        onDragStart: (hit) => {
          const id = findPickId(hit.object);
          const p = propsRef.current;
          const rt = rtRef.current;
          if (!id || !rt) return;
          let source: FcDragSource | null = null;
          let slots: string[] = [];
          if (id.startsWith("freecell-")) {
            const index = Number(id.slice("freecell-".length));
            if (p.state.freeCells[index]) {
              source = { kind: "freecell", index };
              slots = [`free-${index}`];
            }
          } else {
            const card = parseCard(id);
            if (card) {
              const pile = p.state.columns[card.col];
              if (pile && card.index < pile.length) {
                source = { kind: "column", column: card.col, startIndex: card.index };
                slots = pile.slice(card.index).map((_, k) => `c${card.col}-${card.index + k}`);
              }
            }
          }
          if (!source || slots.length === 0) return;
          const base = new Map<string, THREE.Vector3>();
          for (const s of slots) {
            const e = rt.entries.get(s);
            if (e) {
              e.anim = null;
              base.set(s, e.group.position.clone());
            }
          }
          if (base.size === 0) return;
          dragRef.current = { source, slots, base, startPoint: null, lastPoint: null };
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
            handleSwipe(flick.dir);
            return;
          }
          const rt = rtRef.current;
          let target: FcTarget | null = null;
          const hitId = findPickId(hit?.object ?? null);
          if (hitId) {
            const card = parseCard(hitId);
            if (card) target = { kind: "column", column: card.col };
            else if (hitId.startsWith("empty-col-")) {
              target = { kind: "column", column: Number(hitId.slice("empty-col-".length)) };
            } else if (hitId.startsWith("freecell-")) {
              target = { kind: "freecell", index: Number(hitId.slice("freecell-".length)) };
            } else if (hitId.startsWith("foundation-")) {
              target = { kind: "foundation", index: Number(hitId.slice("foundation-".length)) };
            }
          }
          if (!target && drag.lastPoint && drag.lastPoint.z > TAB_Z0 - 0.9) {
            const col = Math.max(
              0,
              Math.min(FC_COLUMNS - 1, Math.round(drag.lastPoint.x / PITCH + (FC_COLUMNS - 1) / 2)),
            );
            target = { kind: "column", column: col };
          }
          const ok = target ? propsRef.current.onDragDrop(drag.source, target) : false;
          if (!ok && rt) {
            const now = performance.now();
            for (const s of drag.slots) {
              const e = rt.entries.get(s);
              const b = drag.base.get(s);
              if (e && b) {
                e.anim = {
                  start: now, dur: 260,
                  fromPos: e.group.position.clone(), toPos: b.clone(), arc: 0.05,
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

  // 盤面の差分同期（スロット=列×位置・フリーセル・組札）。新規カードは
  // 移動元の最終位置（無ければ上段中央）から滑らかに移動する。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const now = performance.now();

    const desired = new Map<string, { card: FcCard; pos: THREE.Vector3; pickId: string; selected: boolean }>();
    state.freeCells.forEach((card, i) => {
      if (!card) return;
      const sel = selected?.kind === "freecell" && selected.index === i;
      desired.set(`free-${i}`, {
        card,
        pos: new THREE.Vector3(colX(i), sel ? 0.22 : 0.05, TOP_Z),
        pickId: `freecell-${i}`,
        selected: sel,
      });
    });
    state.foundations.forEach((pile, i) => {
      if (pile.length === 0) return;
      const card = pile[pile.length - 1];
      desired.set(`found-${i}`, {
        card,
        pos: new THREE.Vector3(colX(4 + i), 0.05, TOP_Z),
        pickId: `foundation-${i}`,
        selected: false,
      });
    });
    state.columns.forEach((pile, col) => {
      const step = pile.length > 1
        ? Math.min(0.4, TAB_BUDGET / (pile.length - 1))
        : 0.4;
      pile.forEach((card, index) => {
        const sel =
          selected?.kind === "column" && selected.column === col && index >= selected.startIndex;
        desired.set(`c${col}-${index}`, {
          card,
          pos: new THREE.Vector3(colX(col), sel ? 0.22 : 0.05, TAB_Z0 + index * step),
          pickId: `card-${col}-${index}`,
          selected: sel,
        });
      });
    });
    rt.emptyColumnSlots.forEach((m, col) => {
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
        const from = lastPosByCard.get(d.card.id) ?? SPAWN_POS;
        group.position.copy(from);
        const mesh = makeCardMesh(d.card);
        mesh.rotation.x = FACE_UP;
        mesh.userData.pickId = d.pickId;
        group.add(mesh);
        const highlight = new THREE.Mesh(
          new THREE.BoxGeometry(CARD_W + 0.1, 0.02, CARD_H + 0.1),
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
          group, mesh, highlight,
          anim: {
            start: now, dur: 380,
            fromPos: group.position.clone(), toPos: d.pos.clone(),
            arc: Math.min(0.5, dist * 0.3),
          },
        });
        continue;
      }
      entry.group.userData.pickId = d.pickId;
      entry.mesh.userData.pickId = d.pickId;
      entry.highlight.visible = d.selected;
      entry.highlight.userData.pickId = d.pickId;
      if (entry.group.position.distanceTo(d.pos) > 0.01 && !entry.anim) {
        entry.anim = {
          start: now, dur: 300,
          fromPos: entry.group.position.clone(), toPos: d.pos.clone(), arc: 0.06,
        };
      }
    }
  }, [state, selected]);

  return (
    <SceneBox
      height={500}
      label="フリーセル（3D）。左上がフリーセル、右上が組札。カードをタップで選び移動先をタップ、ドラッグでも移動できます"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#14231c"
    />
  );
}
