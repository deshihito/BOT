"use client";
// ソリティア（クロンダイク）の 3D シーン（カード系の型・ソリティア系拡張）。
// 場札7列・山札・捨て札・組札4枠を createCard で立体化する。重なりは
// 伏せ札を詰め、表札を広く取り、列が長い場合は間隔を圧縮して盤内に収める。
// 状態・合法判定は lib/solitaire.ts とクライアントの既存ハンドラが持ち、
// ここは表現と入力の橋渡しだけを行う:
//   タップ = 既存の選択→移動（山札タップ=めくる、組札タップ等も同じ）
//   ダブルタップ（捨て札/場札の先頭）= 組札へ自動移動（2D のダブルクリック）
//   ドラッグ = 掴んだ束を移動先の列/組札へ落とす（同じハンドラ経由で判定）
//   盤面の左/右フリック（カードを掴んでいないとき）= 2D 盤面スワイプと同じ
//     （左=1手もどる、右=組札へ自動移動）
// 数字（手数・経過・組札枚数・山札枚数）は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createCard } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import { isRedSuit, rankLabel, suitSymbol, type SolCard, type SolState } from "@/lib/solitaire";

export type SolSelection =
  | { kind: "waste" }
  | { kind: "tableau"; col: number; index: number }
  | { kind: "foundation"; pile: number }
  | null;

export type SolDragSource =
  | { kind: "waste" }
  | { kind: "tableau"; col: number; index: number }
  | { kind: "foundation"; pile: number };

export type SolDragTarget = { kind: "tableau"; col: number } | { kind: "foundation" };

interface Props {
  state: SolState;
  selection: SolSelection;
  onStockTap: () => void;
  onWasteTap: () => void;
  onWasteDoubleTap: () => void;
  onTableauTap: (col: number, index: number) => void;
  onTableauDoubleTap: (col: number) => void;
  onFoundationTap: (pile: number) => void;
  onEmptyTableauTap: (col: number) => void;
  /** ドラッグの落下。合法で実際に移動したら true（不正ならカードは元の位置へ戻る）。 */
  onDragDrop: (source: SolDragSource, target: SolDragTarget) => boolean;
  onBoardSwipe: (dir: "left" | "right") => void;
  onFail: () => void;
  fallback: ReactNode;
}

const CARD_W = 0.92;
const CARD_H = 1.28;
const PITCH = 1.04;
const TOP_Z = -2.35;
const TAB_Z0 = -1.5;
const TAB_BUDGET = 5.1;
const FACE_UP = -Math.PI / 2;
const FACE_DOWN = Math.PI / 2;
const STOCK_POS = new THREE.Vector3(-3 * PITCH, 0.05, TOP_Z);

function colX(col: number): number {
  return (col - 3) * PITCH;
}
function foundationX(i: number): number {
  return i * PITCH;
}

function makeCardMesh(card: SolCard | null): THREE.Mesh {
  if (!card || !card.faceUp) return createCard(CARD_W, CARD_H, {});
  return createCard(CARD_W, CARD_H, {
    label: `${rankLabel(card.rank)}${suitSymbol(card.suit)}`,
    labelColor: isRedSuit(card.suit) ? "#c62828" : "#1c2333",
  });
}

/** 列内の各カードの Z オフセット（伏せは詰め、表は広く。長い列は圧縮する）。 */
function tableauOffsets(pile: SolCard[]): number[] {
  const offsets = [0];
  let total = 0;
  for (let i = 1; i < pile.length; i++) {
    total += pile[i - 1].faceUp ? 0.44 : 0.3;
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
  source: SolDragSource;
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
  emptyTableauSlots: THREE.Mesh[];
  stockCount: number;
}

export default function SolitaireScene3D({
  state, selection, onStockTap, onWasteTap, onWasteDoubleTap, onTableauTap,
  onTableauDoubleTap, onFoundationTap, onEmptyTableauTap, onDragDrop, onBoardSwipe,
  onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const dragRef = useRef<DragRt | null>(null);
  const lastTapRef = useRef<{ id: string; at: number } | null>(null);

  const propsRef = useRef({
    state, selection, onStockTap, onWasteTap, onWasteDoubleTap, onTableauTap,
    onTableauDoubleTap, onFoundationTap, onEmptyTableauTap, onDragDrop, onBoardSwipe,
  });
  propsRef.current = {
    state, selection, onStockTap, onWasteTap, onWasteDoubleTap, onTableauTap,
    onTableauDoubleTap, onFoundationTap, onEmptyTableauTap, onDragDrop, onBoardSwipe,
  };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x14231c,
      camera: { position: [0, 10.5, 9.5], lookAt: [0, 0, 0.5], fov: 42 },
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

    // テーブル（木枠＋フェルト）
    const rim = new THREE.Mesh(
      new THREE.BoxGeometry(8.4, 0.14, 9.2),
      new THREE.MeshStandardMaterial({ color: 0x5b3a22, roughness: 0.6 }),
    );
    rim.position.set(0, -0.1, 0.6);
    scene.add(rim);
    const felt = new THREE.Mesh(
      new THREE.BoxGeometry(8.0, 0.16, 8.8),
      new THREE.MeshStandardMaterial({ color: 0x1e5c3a, roughness: 1 }),
    );
    felt.position.set(0, -0.04, 0.6);
    scene.add(felt);

    const slotsGroup = new THREE.Group();
    scene.add(slotsGroup);
    const slotMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, transparent: true, opacity: 0.13, roughness: 0.9,
    });
    const slotGeo = new THREE.BoxGeometry(CARD_W + 0.05, 0.02, CARD_H + 0.05);
    const addSlot = (pickId: string, x: number, z: number): THREE.Mesh => {
      const m = new THREE.Mesh(slotGeo, slotMat);
      m.position.set(x, 0.02, z);
      m.userData.pickId = pickId;
      slotsGroup.add(m);
      return m;
    };
    // 山札の空枠（再循環タップ用。山札がある間も下に敷いておく）
    addSlot("stock", STOCK_POS.x, TOP_Z);
    // 捨て札の空枠
    addSlot("waste", colX(1), TOP_Z);
    // 組札4枠
    for (let i = 0; i < 4; i++) addSlot(`foundation-${i}`, foundationX(i), TOP_Z);
    // 場札の空列枠（列が空のときだけ見せる）
    const emptyTableauSlots: THREE.Mesh[] = [];
    for (let c = 0; c < 7; c++) {
      const m = addSlot(`empty-tableau-${c}`, colX(c), TAB_Z0);
      m.visible = false;
      emptyTableauSlots.push(m);
    }

    const stockGroup = new THREE.Group();
    scene.add(stockGroup);
    const cardsGroup = new THREE.Group();
    scene.add(cardsGroup);
    rtRef.current = {
      cardsGroup, slotsGroup, stockGroup,
      entries: new Map(), emptyTableauSlots, stockCount: -1,
    };

    const parseTableau = (id: string): { col: number; index: number } | null => {
      const m = /^tableau-(\d+)-(\d+)$/.exec(id);
      return m ? { col: Number(m[1]), index: Number(m[2]) } : null;
    };

    const dispatchTap = (id: string | null, isDouble: boolean) => {
      const p = propsRef.current;
      if (!id) return;
      if (id === "stock") { p.onStockTap(); return; }
      if (id === "waste") {
        // 空の捨て札枠は 2D でもタップ対象外。
        if (p.state.waste.length === 0) return;
        if (isDouble) p.onWasteDoubleTap();
        else p.onWasteTap();
        return;
      }
      const tab = parseTableau(id);
      if (tab) {
        const pile = p.state.tableau[tab.col];
        if (isDouble && pile && tab.index === pile.length - 1) p.onTableauDoubleTap(tab.col);
        else p.onTableauTap(tab.col, tab.index);
        return;
      }
      if (id.startsWith("empty-tableau-")) {
        p.onEmptyTableauTap(Number(id.slice("empty-tableau-".length)));
        return;
      }
      if (id.startsWith("foundation-")) {
        p.onFoundationTap(Number(id.slice("foundation-".length)));
      }
    };

    const handleSwipe = (dir: string | null) => {
      if (dir === "left" || dir === "right") propsRef.current.onBoardSwipe(dir);
    };

    detach = attachPickPointer(
      stage,
      () => [cardsGroup, slotsGroup, stockGroup],
      {
        onTap: (hit) => {
          const id = findPickId(hit?.object ?? null);
          if (!id) return;
          const now = performance.now();
          const last = lastTapRef.current;
          const doubleAble =
            id === "waste" || parseTableau(id) !== null;
          if (doubleAble && last && last.id === id && now - last.at < 320) {
            lastTapRef.current = null;
            dispatchTap(id, true);
            return;
          }
          lastTapRef.current = { id, at: now };
          dispatchTap(id, false);
        },
        onFlick: (f) => handleSwipe(f.dir),
        onDragStart: (hit) => {
          const id = findPickId(hit.object);
          const p = propsRef.current;
          const rt = rtRef.current;
          if (!id || !rt) return;
          let source: SolDragSource | null = null;
          let slots: string[] = [];
          if (id === "waste" && p.state.waste.length > 0) {
            source = { kind: "waste" };
            slots = ["waste"];
          } else if (id.startsWith("foundation-")) {
            const pile = Number(id.slice("foundation-".length));
            if (p.state.foundations[pile]?.length > 0) {
              source = { kind: "foundation", pile };
              slots = [`f${pile}`];
            }
          } else {
            const tab = parseTableau(id);
            if (tab) {
              const pile = p.state.tableau[tab.col];
              if (pile && pile[tab.index]?.faceUp) {
                source = { kind: "tableau", col: tab.col, index: tab.index };
                slots = pile.slice(tab.index).map((_, k) => `t${tab.col}-${tab.index + k}`);
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
            // カードを掴んでいないドラッグ終了は盤面スワイプとして扱う。
            handleSwipe(flick.dir);
            return;
          }
          const rt = rtRef.current;
          let target: SolDragTarget | null = null;
          const hitId = findPickId(hit?.object ?? null);
          if (hitId) {
            const tab = parseTableau(hitId);
            if (tab) target = { kind: "tableau", col: tab.col };
            else if (hitId.startsWith("empty-tableau-")) {
              target = { kind: "tableau", col: Number(hitId.slice("empty-tableau-".length)) };
            } else if (hitId.startsWith("foundation-")) target = { kind: "foundation" };
          }
          if (!target && drag.lastPoint && drag.lastPoint.z > TAB_Z0 - 0.9) {
            const col = Math.max(0, Math.min(6, Math.round(drag.lastPoint.x / PITCH + 3)));
            target = { kind: "tableau", col };
          }
          const ok = target ? propsRef.current.onDragDrop(drag.source, target) : false;
          if (!ok && rt) {
            // 不正な落下: 掴んだ束を元の位置へ滑らかに戻す。
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

  // 盤面の差分同期: スロット（列×位置・捨て札・組札）単位で Map 管理し、
  // 新規カードは移動元の最終位置（無ければ山札位置）から滑らかに移動する。
  // 伏せ札が表になる瞬間はその場フリップ（裏→表・表→裏の両方向）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const now = performance.now();

    // 山札スタック（枚数に応じて厚みだけ変える）
    if (rt.stockCount !== state.stock.length) {
      rt.stockCount = state.stock.length;
      while (rt.stockGroup.children.length > 0) rt.stockGroup.remove(rt.stockGroup.children[0]);
      const n = Math.min(6, state.stock.length);
      for (let i = 0; i < n; i++) {
        const m = makeCardMesh(null);
        m.rotation.x = FACE_DOWN;
        m.position.set(0, i * 0.016, 0);
        m.userData.pickId = "stock";
        const g = new THREE.Group();
        g.position.copy(STOCK_POS);
        g.add(m);
        rt.stockGroup.add(g);
      }
    }

    const desired = new Map<string, { card: SolCard; pos: THREE.Vector3; pickId: string; selected: boolean }>();
    if (state.waste.length > 0) {
      const card = state.waste[state.waste.length - 1];
      desired.set("waste", {
        card,
        pos: new THREE.Vector3(colX(1), selection?.kind === "waste" ? 0.22 : 0.05, TOP_Z),
        pickId: "waste",
        selected: selection?.kind === "waste",
      });
    }
    state.foundations.forEach((pile, i) => {
      if (pile.length === 0) return;
      const card = pile[pile.length - 1];
      const sel = selection?.kind === "foundation" && selection.pile === i;
      desired.set(`f${i}`, {
        card,
        pos: new THREE.Vector3(foundationX(i), sel ? 0.22 : 0.05, TOP_Z),
        pickId: `foundation-${i}`,
        selected: sel,
      });
    });
    state.tableau.forEach((pile, col) => {
      const offsets = tableauOffsets(pile);
      pile.forEach((card, index) => {
        const sel =
          selection?.kind === "tableau" && selection.col === col && index >= selection.index;
        desired.set(`t${col}-${index}`, {
          card,
          pos: new THREE.Vector3(colX(col), sel ? 0.22 : 0.05, TAB_Z0 + offsets[index]),
          pickId: `tableau-${col}-${index}`,
          selected: sel,
        });
      });
    });
    rt.emptyTableauSlots.forEach((m, col) => {
      m.visible = state.tableau[col].length === 0;
    });

    // 消えたスロットのカードの最終位置を覚え、別スロットへの移動の起点にする。
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
        const from = lastPosByCard.get(d.card.id) ?? STOCK_POS;
        group.position.copy(from);
        const mesh = makeCardMesh(d.card);
        mesh.rotation.x = d.card.faceUp ? FACE_UP : FACE_DOWN;
        mesh.userData.pickId = d.pickId;
        group.add(mesh);
        const highlight = new THREE.Mesh(
          new THREE.BoxGeometry(CARD_W + 0.1, 0.02, CARD_H + 0.1),
          new THREE.MeshBasicMaterial({ color: 0xf5b301 }),
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
        // めくれ: メッシュを差し替えてその場で回転させる。
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
      height={500}
      label={`ソリティア（3D）。山札 ${state.stock.length}枚、組札 ${state.foundations.reduce((s, p) => s + p.length, 0)}枚。カードをタップで選び移動先をタップ、ダブルタップで組札へ、ドラッグでも移動できます`}
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#14231c"
    />
  );
}
