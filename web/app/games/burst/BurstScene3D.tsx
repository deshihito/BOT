"use client";
// バーストの 3D シーン。カード系の型の応用（hearts）:
// 場の4列は公開情報なので数字カードを列ごとに並べ、自分の手札は手前に
// 扇状に置く。他プレイヤーの手札・提出カードは view に含まれない秘匿情報
// なので、このシーンは受け取らず描かない（枚数・提出状況は親の DOM 併記）。
// 手札のタップ = 既存の選択操作（選んだカードは金縁＋持ち上げ、確定は
// 親の DOM の「出す」ボタンが担う）。列を選ぶ局面では列のタップ =
// 既存の takeRow 操作（DOM の「この列を取る」と同じ move）。
// 列が5枚のときは赤縁でバースト寸前を示し、列選択中は金縁にする。
// あなたの pendingCard（どの列にも置けない自分のカード）は金縁で
// 中央手前に出す。数字・ペナルティ・残り時間は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createCard } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

export interface BurstSceneRow {
  cards: number[];
  count: number;
  penalty: number;
}

interface Props {
  rows: BurstSceneRow[];
  myHand: number[];
  selected: number | null;
  canPlay: boolean;
  choosing: boolean;
  pendingCard: number | null;
  phase: string;
  /** 手札カードのタップ。既存の選択ハンドラへ接続する。 */
  onCardTap: (card: number) => void;
  /** 列のタップ。列選択中のみ、既存の takeRow ハンドラへ接続する。 */
  onRowTap: (row: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const HAND_W = 0.78;
const HAND_H = 1.08;
const ROW_W = 0.66;
const ROW_H = 0.92;
const FACE_UP = -Math.PI / 2;
const DECK_POS = new THREE.Vector3(3.35, 0.05, -2.05);

/** バースト値の高さでラベルの色を変える（55・11の倍数は高ペナルティ）。 */
function labelColorOf(card: number): string {
  if (card === 55 || card % 11 === 0) return "#c62828";
  return "#1c2333";
}

function makeCardMesh(value: number, w: number, h: number, pickId?: string): THREE.Mesh {
  const mesh = createCard(w, h, {
    label: String(value),
    labelColor: labelColorOf(value),
  });
  if (pickId !== undefined) mesh.userData.pickId = pickId;
  return mesh;
}

function makeFrameMesh(w: number, h: number): THREE.Mesh {
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.12, h + 0.12, 0.018),
    new THREE.MeshStandardMaterial({ color: 0x2b3442, roughness: 0.45 }),
  );
  frame.rotation.x = FACE_UP;
  frame.position.y = -0.014;
  return frame;
}

function setCardDim(mesh: THREE.Mesh, dim: boolean) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) {
    const std = m as THREE.MeshStandardMaterial;
    std.transparent = dim;
    std.opacity = dim ? 0.5 : 1;
  }
}

function rowPos(row: number, j: number): THREE.Vector3 {
  return new THREE.Vector3(-2.95 + j * 0.74, 0.05, -1.95 + row * 0.98);
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
  frame: THREE.Mesh | null;
  anim: CardAnim | null;
}

interface SceneRt {
  cardsGroup: THREE.Group;
  entries: Map<string, CardEntry>;
}

export default function BurstScene3D({
  rows, myHand, selected, canPlay, choosing, pendingCard, phase,
  onCardTap, onRowTap, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);

  const propsRef = useRef({ rows, myHand, selected, canPlay, choosing, pendingCard, phase, onCardTap, onRowTap });
  propsRef.current = { rows, myHand, selected, canPlay, choosing, pendingCard, phase, onCardTap, onRowTap };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x14231c,
      camera: { position: [0, 6.6, 5.9], lookAt: [0, 0, 0.2], fov: 46 },
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
      new THREE.BoxGeometry(8.8, 0.14, 6.4),
      new THREE.MeshStandardMaterial({ color: 0x5b3a22, roughness: 0.6 }),
    );
    rim.position.y = -0.1;
    rim.userData.pickId = "table";
    scene.add(rim);
    const felt = new THREE.Mesh(
      new THREE.BoxGeometry(8.4, 0.16, 6.0),
      new THREE.MeshStandardMaterial({ color: 0x1e5c3a, roughness: 1 }),
    );
    felt.position.y = -0.04;
    felt.userData.pickId = "table";
    scene.add(felt);

    // 山札（裏面のみ。残りカードの中身は秘匿なので label は付けない）。
    const deckGroup = new THREE.Group();
    for (let i = 0; i < 5; i++) {
      const m = createCard(ROW_W, ROW_H, {});
      m.rotation.x = Math.PI / 2;
      m.position.set(0, i * 0.016, 0);
      deckGroup.add(m);
    }
    deckGroup.position.copy(DECK_POS);
    scene.add(deckGroup);

    const cardsGroup = new THREE.Group();
    scene.add(cardsGroup);
    rtRef.current = { cardsGroup, entries: new Map() };

    detach = attachPickPointer(stage, () => [felt, rim, cardsGroup], {
      onTap: (hit) => {
        const pickId = hit?.object.userData.pickId as string | undefined;
        if (!pickId) return;
        if (pickId.startsWith("card-")) {
          const v = Number(pickId.slice("card-".length));
          if (Number.isInteger(v)) propsRef.current.onCardTap(v);
        } else if (pickId.startsWith("row-")) {
          const r = Number(pickId.slice("row-".length));
          if (Number.isInteger(r)) propsRef.current.onRowTap(r);
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

  // 差分同期（hearts 型）: スロットキー＋カードキー Map で管理する。
  // 新規は山札位置からフライイン、位置変化は再配置アニメ、消滅は除去。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const now = performance.now();
    const desired = new Map<string, {
      value: number;
      w: number;
      h: number;
      pos: THREE.Vector3;
      yaw: number;
      fromPos: THREE.Vector3;
      dealOrder: number;
      pickId?: string;
      frameColor?: number;
      dim: boolean;
      withFrame: boolean;
    }>();

    // 場の列（公開情報）。列選択中は列全体がタップ対象、金縁。
    // 5枚の列は赤縁（次の配置で引き取りになる状態の表現）。
    rows.forEach((row, r) => {
      row.cards.forEach((value, j) => {
        const danger = row.count >= 5;
        desired.set(`r${r}-${j}`, {
          value,
          w: ROW_W,
          h: ROW_H,
          pos: rowPos(r, j),
          yaw: 0,
          fromPos: DECK_POS.clone(),
          dealOrder: j,
          pickId: choosing ? `row-${r}` : undefined,
          frameColor: choosing ? 0xf2b33d : danger ? 0xc62828 : undefined,
          dim: false,
          withFrame: choosing || danger,
        });
      });
    });

    // 列に置けない自分のカード（列選択中のみ自分に届く公開範囲の情報）。
    if (pendingCard !== null) {
      desired.set("pending", {
        value: pendingCard,
        w: HAND_W,
        h: HAND_H,
        pos: new THREE.Vector3(0, 0.12, 1.5),
        yaw: 0,
        fromPos: new THREE.Vector3(0, 0.05, 2.4),
        dealOrder: 0,
        frameColor: 0xf2b33d,
        dim: false,
        withFrame: true,
      });
    }

    // 自分の手札（扇状）。選択中は金縁＋持ち上げ、出せない局面では減光。
    const spacing = myHand.length > 1 ? Math.min(0.68, 6.8 / (myHand.length - 1)) : 0.68;
    myHand.forEach((value, i) => {
      const offset = i - (myHand.length - 1) / 2;
      const isSel = selected === value;
      desired.set(`h${i}`, {
        value,
        w: HAND_W,
        h: HAND_H,
        pos: new THREE.Vector3(offset * spacing, isSel ? 0.24 : 0.05, 2.4 + Math.abs(offset) * 0.03),
        yaw: offset * 0.05,
        fromPos: DECK_POS.clone(),
        dealOrder: i,
        pickId: `card-${value}`,
        frameColor: isSel ? 0xf2b33d : 0x2b3442,
        dim: !canPlay,
        withFrame: true,
      });
    });

    for (const [slot, e] of [...rt.entries]) {
      if (!desired.has(slot)) {
        rt.cardsGroup.remove(e.group);
        rt.entries.delete(slot);
      }
    }

    for (const [slot, d] of desired) {
      const cardKey = `v-${d.value}-${d.w}x${d.h}`;
      const existing = rt.entries.get(slot);
      if (existing && existing.cardKey !== cardKey) {
        rt.cardsGroup.remove(existing.group);
        rt.entries.delete(slot);
      }
      const entry = rt.entries.get(slot);
      if (!entry) {
        const group = new THREE.Group();
        group.position.copy(d.fromPos);
        let frame: THREE.Mesh | null = null;
        if (d.withFrame) {
          frame = makeFrameMesh(d.w, d.h);
          if (d.frameColor !== undefined) {
            (frame.material as THREE.MeshStandardMaterial).color.setHex(d.frameColor);
          }
          group.add(frame);
        }
        const mesh = makeCardMesh(d.value, d.w, d.h, d.pickId);
        mesh.rotation.x = FACE_UP;
        setCardDim(mesh, d.dim);
        group.add(mesh);
        group.rotation.y = d.yaw;
        rt.cardsGroup.add(group);
        const dist = group.position.distanceTo(d.pos);
        rt.entries.set(slot, {
          cardKey,
          group,
          mesh,
          frame,
          anim: {
            start: now + d.dealOrder * 50,
            dur: 420,
            fromPos: group.position.clone(),
            toPos: d.pos.clone(),
            arc: Math.min(0.5, dist * 0.3),
          },
        });
        continue;
      }
      // 既存カード: フレーム色・減光・pickId を最新状態へ合わせる。
      if (d.withFrame && !entry.frame) {
        entry.frame = makeFrameMesh(d.w, d.h);
        entry.group.add(entry.frame);
      }
      if (!d.withFrame && entry.frame) {
        entry.group.remove(entry.frame);
        entry.frame = null;
      }
      if (entry.frame && d.frameColor !== undefined) {
        (entry.frame.material as THREE.MeshStandardMaterial).color.setHex(d.frameColor);
      }
      if (d.pickId !== undefined) entry.mesh.userData.pickId = d.pickId;
      else delete entry.mesh.userData.pickId;
      setCardDim(entry.mesh, d.dim);
      if (entry.group.position.distanceTo(d.pos) > 0.01 && !entry.anim) {
        entry.anim = {
          start: now,
          dur: 300,
          fromPos: entry.group.position.clone(),
          toPos: d.pos.clone(),
          arc: 0.05,
        };
      }
      entry.group.rotation.y = d.yaw;
    }
  }, [rows, myHand, selected, canPlay, choosing, pendingCard, phase]);

  return (
    <SceneBox
      height={400}
      label={`バースト（3D）。場は4列、あなたの手札 ${myHand.length}枚。手札のタップで選択、列選択中は列のタップでその列を取る`}
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#14231c"
    />
  );
}
