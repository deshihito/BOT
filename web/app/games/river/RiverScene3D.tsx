"use client";
// 川渡りの 3D シーン。両岸（草の台）＋川（青い面）＋ボート（木の船体）を置き、
// 農夫と荷物は色つきトークンで表す。トークンの前面には lib/river.ts の
// RiverItemDef が持つ漢字1字を大きなプレートで出す（現行 2D の漢字チップと
// 同じ情報で、絵文字は使わない）。色も def の color をそのまま使う。
// 状態同期は差分同期＋補間追従（第4期の盤駒差分同期と同じ考え方）:
//   親から locations / farmerSide を受け取り、各トークンとボートの目標位置
//   だけを更新し、毎フレーム指数補間で滑らかに寄せる。渡河中もボートと
//   船上のトークンは同じ補間で一緒に動くので、荷物が船からずれない。
// 危険ペア・勝敗の判定は lib/river.ts と親が持ち、3D 側では再実装しない。
// 入力は現行クライアントの操作語彙どおり:
//   荷物タップ = onItem（ボートへの乗せ降ろし = 既存 toggleRiverItem 経路）
//   農夫タップ / ボートタップ = onCross（渡河）
//   対岸方向へのスワイプ = onCross（現行のボートスワイプと同じ）
// 問題名・最短手数・失敗理由は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { RiverItemDef, RiverLoc, RiverSide, RiverStatus } from "@/lib/river";

interface Props {
  items: RiverItemDef[];
  locations: Record<string, RiverLoc>;
  farmerSide: RiverSide;
  status: RiverStatus;
  /** 荷物タップ（現行の乗せ降ろしハンドラへ接続）。 */
  onItem: (id: string) => void;
  /** ボートタップ／対岸スワイプ（現行の cross へ接続）。 */
  onCross: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

const BANK_X = 3.35;
const BOAT_X = 1.55;
const BANK_TOP = 0.15;
const DECK_Y = 0.3;

/** 岸にいる荷物の並び位置（問題定義の順で中央寄せ）。 */
function bankSlotZ(slot: number, count: number): number {
  return (slot - (count - 1) / 2) * 1.05;
}
/** 船上の荷物の並び位置（農夫は船尾 -1.05、荷物はその手前から）。 */
function boatSlotZ(slot: number): number {
  return -0.1 + slot * 0.85;
}

/** 表示エリアのアスペクトから、両岸と川が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement) {
  const w = container.clientWidth || 640;
  const h = container.clientHeight || 400;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (5.1 / Math.tan(hFov / 2));
  const distD = (3.1 / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.2;
  stage.setCamera({
    position: [0, dist * 0.78, dist * 0.62],
    lookAt: [0, 0, 0.1],
    fov: 42,
  });
}

/** 荷物・農夫のトークン（色つき胴体＋頭＋漢字プレート）。 */
function createToken(def: { id: string; kanji: string; color: string }, isFarmer: boolean): THREE.Group {
  const grp = new THREE.Group();
  const color = new THREE.Color(def.color);
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.38, 0.1, 20),
    new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.75), roughness: 0.6 }),
  );
  base.position.y = 0.05;
  grp.add(base);
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.24, 0.44, 16),
    new THREE.MeshStandardMaterial({ color, roughness: 0.55 }),
  );
  body.position.y = 0.32;
  grp.add(body);
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 18, 14),
    new THREE.MeshStandardMaterial({ color: 0xf2d5b8, roughness: 0.5 }),
  );
  head.position.y = 0.68;
  grp.add(head);
  if (isFarmer) {
    // 農夫だけ麦わら帽子（円錐）で判別する。
    const hat = new THREE.Mesh(
      new THREE.ConeGeometry(0.3, 0.15, 16),
      new THREE.MeshStandardMaterial({ color: 0xd9b45b, roughness: 0.7 }),
    );
    hat.position.y = 0.84;
    grp.add(hat);
  }
  // 前面の漢字プレート（2D チップの漢字バッジと同じ大きさ感で読ませる）。
  const tex = canvasTexture(`river-kanji-${def.id}-${def.kanji}`, 128, 128, (g) => {
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = def.color;
    g.font = "bold 82px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(def.kanji, 64, 68);
  });
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(0.46, 0.46),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 }),
  );
  plate.position.set(0, 0.32, 0.245);
  grp.add(plate);
  return grp;
}

/** 岸の名前プレート（上面に大きく寝かせて置く）。 */
function createBankPlate(label: string, key: string): THREE.Mesh {
  const tex = canvasTexture(`river-bank-${key}`, 256, 80, (g) => {
    g.fillStyle = "#5d8a46";
    g.fillRect(0, 0, 256, 80);
    g.fillStyle = "#ffffff";
    g.font = "bold 52px sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(label, 128, 44);
  });
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.6, 0.5),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }),
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

interface TokenRt {
  sig: string;
  grp: THREE.Group;
  loc: RiverLoc;
  slot: number;
}

interface SceneRt {
  stage: Stage;
  worldGroup: THREE.Group;
  boatGroup: THREE.Group;
  hits: THREE.Object3D[];
  tokensRt: Map<string, TokenRt>;
  farmerRt: TokenRt | null;
  boatTargetX: number;
  built: boolean;
}

const FARMER_DEF = { id: "farmer", kanji: "農", color: "#3c6e47" };

export default function RiverScene3D({
  items, locations, farmerSide, status, onItem, onCross, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onItem, onCross, farmerSide });
  propsRef.current = { onItem, onCross, farmerSide };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x1d3a4a,
      camera: { position: [0, 6.2, 7.4], lookAt: [0, 0, 0.1], fov: 42 },
      onFrame: (dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        // 差分同期した目標へ指数補間で追従させる（渡河・乗せ降ろし共通）。
        const k = 1 - Math.exp(-dt * 5.5);
        const bob = Math.sin(t * 2) * 0.03;
        rt.boatGroup.position.x += (rt.boatTargetX - rt.boatGroup.position.x) * k;
        rt.boatGroup.position.y = bob;
        const follow = (tok: TokenRt, countOf: (loc: RiverLoc) => number) => {
          let tx = 0;
          let ty = BANK_TOP;
          let tz = 0;
          if (tok.loc === "boat") {
            tx = rt.boatGroup.position.x;
            ty = DECK_Y + bob;
            tz = tok.slot < 0 ? -1.05 : boatSlotZ(tok.slot);
          } else {
            tx = tok.loc === "left" ? -BANK_X : BANK_X;
            tz = bankSlotZ(tok.slot, countOf(tok.loc));
          }
          tok.grp.position.x += (tx - tok.grp.position.x) * k;
          tok.grp.position.y += (ty - tok.grp.position.y) * k;
          tok.grp.position.z += (tz - tok.grp.position.z) * k;
        };
        // 岸ごとの荷物総数はトークン集合から数える（スロット中央寄せ用）。
        const counts: Record<string, number> = { left: 0, right: 0, boat: 0 };
        for (const tok of rt.tokensRt.values()) counts[tok.loc]++;
        const countOf = (loc: RiverLoc) => counts[loc] ?? 1;
        for (const tok of rt.tokensRt.values()) follow(tok, countOf);
        if (rt.farmerRt) follow(rt.farmerRt, countOf);
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    const worldGroup = new THREE.Group();
    scene.add(worldGroup);
    const boatGroup = new THREE.Group();
    worldGroup.add(boatGroup);
    rtRef.current = {
      stage, worldGroup, boatGroup, hits: [], tokensRt: new Map(), farmerRt: null,
      boatTargetX: -BOAT_X, built: false,
    };

    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (!id) return;
        if (id === "boat") propsRef.current.onCross();
        else if (id.startsWith("item-")) propsRef.current.onItem(id.slice(5));
        else if (id === "farmer") propsRef.current.onCross();
      },
      // 対岸方向へのスワイプ＝渡河（現行のボートスワイプと同じ向き判定）。
      onDragEnd: (flick) => {
        const side = propsRef.current.farmerSide;
        if ((side === "left" && flick.dir === "right") || (side === "right" && flick.dir === "left")) {
          propsRef.current.onCross();
        }
      },
      onFlick: (flick) => {
        const side = propsRef.current.farmerSide;
        if ((side === "left" && flick.dir === "right") || (side === "right" && flick.dir === "left")) {
          propsRef.current.onCross();
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

  // 盤面同期: 地形とボートは初回だけ作り、トークンは差分同期する。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, worldGroup, boatGroup } = rt;
    if (!rt.built) {
      rt.built = true;
      // 土台（川底）と川の面。
      const bed = new THREE.Mesh(
        new THREE.BoxGeometry(9.9, 0.2, 6.0),
        new THREE.MeshStandardMaterial({ color: 0x2f6d8f, roughness: 0.9 }),
      );
      bed.position.y = -0.22;
      worldGroup.add(bed);
      const river = new THREE.Mesh(
        new THREE.BoxGeometry(4.2, 0.12, 5.6),
        new THREE.MeshStandardMaterial({ color: 0x3d8bc2, roughness: 0.25 }),
      );
      river.position.y = -0.02;
      worldGroup.add(river);
      // 両岸。
      for (const sideSign of [-1, 1]) {
        const bank = new THREE.Mesh(
          new THREE.BoxGeometry(2.7, 0.3, 5.6),
          new THREE.MeshStandardMaterial({ color: 0x7fae5f, roughness: 0.85 }),
        );
        bank.position.set(sideSign * BANK_X, 0, 0);
        worldGroup.add(bank);
        const plate = createBankPlate(sideSign < 0 ? "左岸" : "右岸", sideSign < 0 ? "left" : "right");
        plate.position.set(sideSign * BANK_X, BANK_TOP + 0.01, 2.3);
        worldGroup.add(plate);
      }
      // ボート（船体＋甲板＋両端の立ち上がり）。農夫と荷物は別トークンで追従する。
      const hull = new THREE.Mesh(
        new THREE.BoxGeometry(1.3, 0.26, 3.1),
        new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.75 }),
      );
      hull.position.y = 0.18;
      boatGroup.add(hull);
      const deck = new THREE.Mesh(
        new THREE.BoxGeometry(1.08, 0.06, 2.9),
        new THREE.MeshStandardMaterial({ color: 0xb98a4e, roughness: 0.8 }),
      );
      deck.position.y = 0.32;
      boatGroup.add(deck);
      for (const endSign of [-1, 1]) {
        const cap = new THREE.Mesh(
          new THREE.BoxGeometry(1.3, 0.36, 0.18),
          new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.75 }),
        );
        cap.position.set(0, 0.28, endSign * 1.5);
        boatGroup.add(cap);
      }
      boatGroup.position.set(-BOAT_X, 0, 0);
      const boatHit = new THREE.Mesh(
        new THREE.BoxGeometry(1.7, 1.4, 3.5),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      boatHit.position.y = 0.6;
      boatHit.userData.pickId = "boat";
      boatGroup.add(boatHit);
      rt.hits.push(boatHit);
      const container = containerRef.current;
      if (container) fitCamera(stage, container);
    }

    rt.boatTargetX = farmerSide === "left" ? -BOAT_X : BOAT_X;

    // 農夫トークン（常駐。位置は常にボートと一緒）。
    if (!rt.farmerRt) {
      const grp = createToken(FARMER_DEF, true);
      grp.position.set(rt.boatTargetX, DECK_Y, -1.05);
      const hit = new THREE.Mesh(
        new THREE.BoxGeometry(0.85, 1.15, 0.85),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hit.position.y = 0.5;
      hit.userData.pickId = "farmer";
      grp.add(hit);
      rt.hits.push(hit);
      worldGroup.add(grp);
      rt.farmerRt = { sig: "farmer", grp, loc: "boat", slot: -1 };
    }

    // 荷物トークンの差分同期（場所と並び順だけを更新し、移動は補間に任せる）。
    const seen = new Set<string>();
    const slotCount: Record<string, number> = {};
    for (const item of items) {
      const loc = locations[item.id] ?? "left";
      const slot = slotCount[loc] ?? 0;
      slotCount[loc] = slot + 1;
      seen.add(item.id);
      const sig = `${item.id}|${item.kanji}|${item.color}`;
      const cur = rt.tokensRt.get(item.id);
      if (cur && cur.sig === sig) {
        cur.loc = loc;
        cur.slot = slot;
        continue;
      }
      if (cur) {
        worldGroup.remove(cur.grp);
        rt.hits = rt.hits.filter((h) => h.userData.pickId !== `item-${item.id}`);
      }
      const grp = createToken(item, false);
      // 初回は目標位置へ即置きする（原点からのスライドで現れないように）。
      if (loc === "boat") grp.position.set(rt.boatTargetX, DECK_Y, boatSlotZ(slot));
      else grp.position.set(loc === "left" ? -BANK_X : BANK_X, BANK_TOP, bankSlotZ(slot, items.filter((i) => (locations[i.id] ?? "left") === loc).length));
      const hit = new THREE.Mesh(
        new THREE.BoxGeometry(0.85, 1.15, 0.85),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      hit.position.y = 0.5;
      hit.userData.pickId = `item-${item.id}`;
      grp.add(hit);
      rt.hits.push(hit);
      worldGroup.add(grp);
      rt.tokensRt.set(item.id, { sig, grp, loc, slot });
    }
    for (const [id, tok] of [...rt.tokensRt]) {
      if (seen.has(id)) continue;
      worldGroup.remove(tok.grp);
      rt.hits = rt.hits.filter((h) => h.userData.pickId !== `item-${id}`);
      rt.tokensRt.delete(id);
    }
  }, [items, locations, farmerSide, status]);

  return (
    <SceneBox
      height={400}
      label="川渡りの情景（3D）。荷物をタップでボートに乗せ降ろしし、ボートをタップするか対岸へスワイプで渡ります"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#1d3a4a"
    />
  );
}
