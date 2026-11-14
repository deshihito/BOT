"use client";
// じゃんけん大会の 3D シーン。手は造形そのもので判別できるようにする:
//   グー   = 角ばった岩のような塊（多面体の球）
//   チョキ = 2本の指を V 字に開いた立体（細長い円柱2本＋手のひらの球）
//   パー   = 平らな平板（薄い直方体＋指の溝を表す細い箱）
// 色も手ごとに変えるが、形だけでも判別できることを優先した。
// 選択フェーズでは手前の3つの手をタップ = 既存の提出ハンドラへ接続する。
// 相手の手は公開前はシーンへ渡さない: 親は choosing の間、相手については
// submitted（出したかどうか）だけを渡し、シーンは提出状況を小さな
// トークンの色で示すだけにする。reveal で初めて revealed（手・勝敗）が
// 届き、勝った手は持ち上げ＋金色に発光させる。勝敗判定は親＋サーバーが正。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createBall } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

export type JankenHand3D = "rock" | "scissors" | "paper";

export interface JankenScenePlayer {
  seat: number;
  /** 提出済みかどうかだけ。手の中身は公開前は受け取らない。 */
  submitted: boolean;
  isYou: boolean;
}

export interface JankenSceneReveal {
  seat: number;
  /** reveal でのみ親が渡す。出さなかった人は null。 */
  hand: JankenHand3D | null;
  won: boolean;
  isYou: boolean;
}

interface Props {
  phase: "choosing" | "reveal" | "finished";
  canThrow: boolean;
  yourHand: JankenHand3D | null;
  players: JankenScenePlayer[];
  /** phase が reveal のときだけ親が組み立てる（それ以外は空配列）。 */
  revealed: JankenSceneReveal[];
  /** 手のタップ = 既存の提出ハンドラ（親の doThrow）へそのまま渡す。 */
  onThrow: (hand: JankenHand3D) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const HANDS: JankenHand3D[] = ["rock", "scissors", "paper"];
const HAND_COLORS: Record<JankenHand3D, number> = {
  rock: 0xd96a4a,
  scissors: 0x4a7fb5,
  paper: 0xe3b23c,
};
const CHOICE_X: Record<JankenHand3D, number> = { rock: -2.15, scissors: 0, paper: 2.15 };
const CHOICE_Z = 1.55;

/** 手の立体造形を作る。形そのもので手を判別できることを優先する。 */
function createHandMesh(hand: JankenHand3D): THREE.Group {
  const grp = new THREE.Group();
  const color = HAND_COLORS[hand];
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
  if (hand === "rock") {
    // グー: 角ばった塊（多面体）＋握りこぶしの小さな突起。
    const lump = new THREE.Mesh(new THREE.IcosahedronGeometry(0.46, 0), mat);
    lump.position.y = 0.46;
    lump.scale.set(1, 0.88, 1);
    grp.add(lump);
    const knuckle = new THREE.Mesh(new THREE.IcosahedronGeometry(0.26, 0), mat);
    knuckle.position.set(0.22, 0.72, 0.14);
    grp.add(knuckle);
  } else if (hand === "scissors") {
    // チョキ: 手のひらの球から2本の指を V 字に開く。
    const palm = createBall(0.3, color, { roughness: 0.55 });
    palm.position.y = 0.28;
    palm.scale.y = 0.8;
    grp.add(palm);
    const fingerGeo = new THREE.CylinderGeometry(0.085, 0.105, 0.92, 12);
    const left = new THREE.Mesh(fingerGeo, mat);
    left.position.set(-0.22, 0.78, 0);
    left.rotation.z = 0.38;
    grp.add(left);
    const right = new THREE.Mesh(fingerGeo, mat);
    right.position.set(0.22, 0.78, 0);
    right.rotation.z = -0.38;
    grp.add(right);
  } else {
    // パー: 平らな平板＋指の分かれ目を表す細い溝箱。
    const slab = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.14, 1.18), mat);
    slab.position.y = 0.42;
    grp.add(slab);
    const grooveMat = new THREE.MeshStandardMaterial({ color: 0x8a6a1d, roughness: 0.7 });
    for (let i = 0; i < 3; i++) {
      const groove = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.05, 0.62), grooveMat);
      groove.position.set(-0.26 + i * 0.26, 0.51, -0.22);
      grp.add(groove);
    }
    const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.12, 0.55), mat);
    thumb.position.set(0.58, 0.4, 0.28);
    thumb.rotation.y = -0.5;
    grp.add(thumb);
  }
  return grp;
}

function createPedestal(color: number): THREE.Group {
  const grp = new THREE.Group();
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(0.62, 0.68, 0.14, 28),
    new THREE.MeshStandardMaterial({ color, roughness: 0.6 }),
  );
  disc.position.y = 0.07;
  grp.add(disc);
  return grp;
}

/** 提出状況だけを示す小さな人型トークン（手の中身は表さない）。 */
function createStatusToken(isYou: boolean): THREE.Group {
  const grp = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.2, 0.36, 16),
    new THREE.MeshStandardMaterial({ color: isYou ? 0x3f6fb5 : 0x8a94a3, roughness: 0.55 }),
  );
  body.position.y = 0.18;
  body.name = "token-body";
  grp.add(body);
  const head = createBall(0.13, 0xf2c894, { roughness: 0.5 });
  head.position.y = 0.5;
  grp.add(head);
  return grp;
}

interface RevealRt {
  grp: THREE.Group;
  hand: JankenHand3D | null;
  targetY: number;
}

interface SceneRt {
  choicesGroup: THREE.Group;
  statusGroup: THREE.Group;
  revealGroup: THREE.Group;
  choicePedMats: Map<JankenHand3D, THREE.MeshStandardMaterial>;
  statusRt: Map<number, { grp: THREE.Group; bodyMat: THREE.MeshStandardMaterial; submitted: boolean }>;
  revealRt: Map<number, RevealRt>;
}

export default function JankenScene3D({ phase, canThrow, yourHand, players, revealed, onThrow, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ canThrow, onThrow });
  propsRef.current = { canThrow, onThrow };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x2a2f38,
      camera: { position: [0, 5.6, 6.4], lookAt: [0, 0, -0.2], fov: 44 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        // 勝った手の持ち上げを滑らかに追従させる。
        const k = 1 - Math.exp(-dt * 10);
        for (const r of rt.revealRt.values()) {
          r.grp.position.y += (r.targetY - r.grp.position.y) * k;
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
      new THREE.BoxGeometry(7.6, 0.24, 5.2),
      new THREE.MeshStandardMaterial({ color: 0x3d4a3a, roughness: 0.95 }),
    );
    table.position.y = -0.13;
    scene.add(table);

    const choicesGroup = new THREE.Group();
    scene.add(choicesGroup);
    const statusGroup = new THREE.Group();
    scene.add(statusGroup);
    const revealGroup = new THREE.Group();
    scene.add(revealGroup);

    const choicePedMats = new Map<JankenHand3D, THREE.MeshStandardMaterial>();
    const hitGeo = new THREE.BoxGeometry(1.35, 1.5, 1.35);
    for (const hand of HANDS) {
      const holder = new THREE.Group();
      holder.position.set(CHOICE_X[hand], 0, CHOICE_Z);
      const ped = createPedestal(0x5a6472);
      const pedMat = (ped.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
      choicePedMats.set(hand, pedMat);
      holder.add(ped);
      const mesh = createHandMesh(hand);
      mesh.position.y = 0.14;
      holder.add(mesh);
      const hit = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.y = 0.7;
      hit.userData.pickId = `hand-${hand}`;
      holder.add(hit);
      choicesGroup.add(holder);
    }

    rtRef.current = { choicesGroup, statusGroup, revealGroup, choicePedMats, statusRt: new Map(), revealRt: new Map() };

    detach = attachPickPointer(stage, () => [choicesGroup], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (!id?.startsWith("hand-")) return;
        if (!propsRef.current.canThrow) return;
        propsRef.current.onThrow(id.slice(5) as JankenHand3D);
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

  // 同期: 選択中の手は台座を金色に光らせる。提出状況トークンは差分同期し、
  // 提出済みは体色を緑にする。reveal の手は seat 単位で差分同期する。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;

    for (const hand of HANDS) {
      const mat = rt.choicePedMats.get(hand);
      if (!mat) continue;
      const mine = yourHand === hand;
      mat.color.setHex(mine ? 0xd9a41c : 0x5a6472);
      mat.emissive.setHex(mine ? 0xd9a41c : 0x000000);
      mat.emissiveIntensity = mine ? 0.4 : 0;
    }
    rt.choicesGroup.visible = phase === "choosing";

    // 提出状況（choosing のみ。手の中身は受け取っていない）。
    const showStatus = phase === "choosing";
    rt.statusGroup.visible = showStatus;
    if (showStatus) {
      const seen = new Set<number>();
      players.forEach((p, i) => {
        seen.add(p.seat);
        const x = players.length <= 1 ? 0 : (i - (players.length - 1) / 2) * 1.05;
        const cur = rt.statusRt.get(p.seat);
        if (!cur) {
          const grp = createStatusToken(p.isYou);
          grp.position.set(x, 0, -1.95);
          rt.statusGroup.add(grp);
          const bodyMat = (grp.getObjectByName("token-body") as THREE.Mesh).material as THREE.MeshStandardMaterial;
          rt.statusRt.set(p.seat, { grp, bodyMat, submitted: p.submitted });
          if (p.submitted) bodyMat.color.setHex(0x37b24d);
          return;
        }
        cur.grp.position.x = x;
        if (cur.submitted !== p.submitted) {
          cur.submitted = p.submitted;
          cur.bodyMat.color.setHex(p.submitted ? 0x37b24d : p.isYou ? 0x3f6fb5 : 0x8a94a3);
        }
      });
      for (const [seat, e] of [...rt.statusRt]) {
        if (!seen.has(seat)) {
          rt.statusGroup.remove(e.grp);
          rt.statusRt.delete(seat);
        }
      }
    }

    // reveal の手（公開済みの情報だけが届く）。
    const seenReveal = new Set<number>();
    revealed.forEach((r, i) => {
      seenReveal.add(r.seat);
      const x = revealed.length <= 1 ? 0 : (i - (revealed.length - 1) / 2) * 1.5;
      const cur = rt.revealRt.get(r.seat);
      if (!cur || cur.hand !== r.hand) {
        if (cur) rt.revealGroup.remove(cur.grp);
        const grp = new THREE.Group();
        grp.position.set(x, 0, -0.55);
        grp.add(createPedestal(r.won ? 0xd9a41c : 0x5a6472));
        if (r.hand) {
          const mesh = createHandMesh(r.hand);
          mesh.position.y = 0.14;
          if (r.won) {
            mesh.traverse((o) => {
              const m = o as THREE.Mesh;
              const mat = m.material as THREE.MeshStandardMaterial | undefined;
              if (mat && "emissive" in mat) {
                mat.emissive = new THREE.Color(0xd9a41c);
                mat.emissiveIntensity = 0.35;
              }
            });
          }
          grp.add(mesh);
        } else {
          const none = createBall(0.22, 0x6b7280, { roughness: 0.7 });
          none.position.y = 0.36;
          none.scale.y = 0.5;
          grp.add(none);
        }
        rt.revealGroup.add(grp);
        rt.revealRt.set(r.seat, { grp, hand: r.hand, targetY: r.won ? 0.3 : 0 });
        return;
      }
      cur.grp.position.x = x;
      cur.targetY = r.won ? 0.3 : 0;
    });
    for (const [seat, e] of [...rt.revealRt]) {
      if (!seenReveal.has(seat)) {
        rt.revealGroup.remove(e.grp);
        rt.revealRt.delete(seat);
      }
    }
  }, [phase, yourHand, players, revealed]);

  return (
    <SceneBox
      height={360}
      label="じゃんけん（3D）。グー・チョキ・パーの手をタップで出します"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#2a2f38"
    />
  );
}
