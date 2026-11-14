"use client";
// 椅子取りの 3D シーン。椅子を円形に並べ、プレイヤーは色つき立体マーカー
// （円柱の胴＋球の頭）で円周上に配置する。
//   椅子 = 座面＋背もたれ＋4本脚の造形。数は親の chairs に差分同期し、
//         ラウンド遷移で減るときは沈みながら縮んで消える。
//   音楽再生中（phase playing）はマーカーが円周を回る。これはシーン内時計の
//         見た目だけの周回で、止まる時刻・勝敗・脱落の判定は一切しない
//         （判定はサーバー側モジュールと親状態が持ち、ここは追従するだけ）。
//   racing で周回は止まり、座れた人（sat）は椅子の位置へ寄って座る姿勢になる。
//   脱落・退出した人は灰色になって外周へ下がる。
// 入力: 椅子のタップ = 既存の「座る！」操作（{ type: "sit" }）。どの椅子を
// 押したかで結果は変わらない既存の操作語彙どおり、椅子タップは全て onSit へ
// つなぎ、座れるかどうか（racing 中・生存・未着席）は親が canSit で判定済み。
// 名前・スコア・ラウンド情報は 3D 内に置かず、親 DOM の併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createBall, createPeg } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

export interface McScenePlayer {
  seat: number;
  alive: boolean;
  left: boolean;
  sat: boolean;
}

interface Props {
  players: McScenePlayer[];
  /** 現在の椅子の数（生存者 - 1）。 */
  chairs: number;
  phase: "playing" | "racing" | "intermission" | "finished";
  round: number;
  mySeat: number;
  /** 自分が今座れる状態か（親がフェーズ・生存・着席で判定済み）。 */
  canSit: boolean;
  /** 椅子タップ = 既存の sit ハンドラ。 */
  onSit: () => void;
  onFail: () => void;
  fallback: ReactNode;
}

/** 座席ごとのマーカー色（最大8人）。 */
const SEAT_COLORS = [0xe84a4a, 0x3f7fe0, 0x35b567, 0xf2b53a, 0xef7d1a, 0x9b59d0, 0x2bb3a3, 0xe86aa8];
const CHAIR_R = 1.55;
const ORBIT_R = 2.45;
const CHAIR_WOOD = 0x9a6b3f;
const CHAIR_SEAT = 0xc0392b;

/** 椅子（座面＋背もたれ＋脚）。中心を向くよう yaw を渡す。 */
function createChair(idx: number): THREE.Group {
  const grp = new THREE.Group();
  const pickId = `chair-${idx}`;
  const wood = new THREE.MeshStandardMaterial({ color: CHAIR_WOOD, roughness: 0.7 });
  const seatMat = new THREE.MeshStandardMaterial({ color: CHAIR_SEAT, roughness: 0.55 });
  const add = (m: THREE.Mesh) => {
    m.userData.pickId = pickId;
    grp.add(m);
  };
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.07, 0.56), seatMat);
  seat.position.y = 0.46;
  add(seat);
  const back = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.62, 0.06), wood);
  back.position.set(0, 0.82, -0.26);
  add(back);
  const backSlat = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.1, 0.05), wood);
  backSlat.position.set(0, 0.68, -0.26);
  add(backSlat);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.46, 8), wood);
      leg.position.set(sx * 0.26, 0.23, sz * 0.22);
      add(leg);
    }
  }
  return grp;
}

/** プレイヤーの立体マーカー（円柱の胴＋球の頭＋自分の印の白リング）。 */
function createMarker(seat: number, isMe: boolean): { group: THREE.Group; mats: THREE.MeshStandardMaterial[] } {
  const grp = new THREE.Group();
  const col = SEAT_COLORS[seat % SEAT_COLORS.length];
  const bodyMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.5 });
  const headMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.4 });
  const body = createPeg(0.17, 0.52, col);
  (body.material as THREE.MeshStandardMaterial).dispose();
  body.material = bodyMat;
  body.position.y = 0.26;
  grp.add(body);
  const head = createBall(0.16, col, { roughness: 0.4 });
  (head.material as THREE.MeshStandardMaterial).dispose();
  head.material = headMat;
  head.position.y = 0.68;
  grp.add(head);
  if (isMe) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.3, 0.035, 8, 24),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.35, roughness: 0.4 }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.03;
    grp.add(ring);
  }
  return { group: grp, mats: [bodyMat, headMat] };
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

function chairPos(i: number, total: number): THREE.Vector3 {
  const a = (i / Math.max(1, total)) * Math.PI * 2;
  return new THREE.Vector3(Math.cos(a) * CHAIR_R, 0, Math.sin(a) * CHAIR_R);
}

interface ChairEntry {
  group: THREE.Group;
  exiting: boolean;
  exitStart: number;
  bornAt: number;
}

interface PlayerEntry {
  group: THREE.Group;
  mats: THREE.MeshStandardMaterial[];
  seat: number;
  alive: boolean;
  left: boolean;
  sat: boolean;
  baseAngle: number;
  chairIndex: number;
}

interface SceneRt {
  root: THREE.Group;
  chairs: Map<string, ChairEntry>;
  players: Map<number, PlayerEntry>;
  orbitAngle: number;
  disc: THREE.Mesh | null;
}

export default function MusicalChairsScene3D({ players, chairs, phase, round, mySeat, canSit, onSit, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ players, chairs, phase, round, mySeat, canSit, onSit });
  propsRef.current = { players, chairs, phase, round, mySeat, canSit, onSit };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x1f2733,
      camera: { position: [0, 5.4, 5.8], lookAt: [0, 0.2, 0], fov: 44 },
      onFrame: (dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        const p = propsRef.current;
        const now = performance.now();
        // 音楽再生中だけ円周を回る（シーン内時計の見た目表現。判定はしない）。
        if (p.phase === "playing") rt.orbitAngle += dt * 0.85;
        if (rt.disc) rt.disc.rotation.y += p.phase === "playing" ? dt * 2.4 : 0;
        // 椅子の出現/消滅アニメーション。
        for (const [key, e] of [...rt.chairs]) {
          if (e.exiting) {
            const k = Math.min(1, (now - e.exitStart) / 260);
            e.group.scale.setScalar(Math.max(0.001, 1 - k));
            e.group.position.y = -0.3 * k;
            if (k >= 1) {
              e.group.parent?.remove(e.group);
              rt.chairs.delete(key);
            }
          } else if (e.bornAt > 0) {
            const k = Math.min(1, (now - e.bornAt) / 240);
            e.group.scale.setScalar(0.3 + 0.7 * k);
            if (k >= 1) e.bornAt = 0;
          }
        }
        // プレイヤーマーカーの配置（状態へ追従）。
        const alivePlayers = p.players.filter((pl) => pl.alive);
        for (const e of rt.players.values()) {
          const satIdx = alivePlayers.findIndex((pl) => pl.seat === e.seat);
          if (!e.alive || e.left) {
            // 脱落・退出: 外周で灰色く沈む。
            const a = e.baseAngle;
            e.group.position.set(Math.cos(a) * (ORBIT_R + 0.75), 0, Math.sin(a) * (ORBIT_R + 0.75));
            e.group.scale.setScalar(0.82);
            continue;
          }
          e.group.scale.setScalar(1);
          if (e.sat && satIdx >= 0) {
            // 座れた人: 対応する椅子の位置へ寄せて低くする。
            const cp = chairPos(satIdx, Math.max(1, p.chairs));
            e.group.position.lerp(new THREE.Vector3(cp.x, 0.18, cp.z), 0.25);
          } else if (p.phase === "playing") {
            const a = e.baseAngle + rt.orbitAngle;
            const bob = Math.abs(Math.sin(t * 7 + e.seat * 1.3)) * 0.07;
            e.group.position.set(Math.cos(a) * ORBIT_R, bob, Math.sin(a) * ORBIT_R);
          } else {
            // racing / intermission / finished: その場で静止（少しだけ呼吸）。
            const a = e.baseAngle + rt.orbitAngle;
            e.group.position.set(Math.cos(a) * ORBIT_R, 0, Math.sin(a) * ORBIT_R);
          }
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    const floor = new THREE.Mesh(
      new THREE.CylinderGeometry(3.6, 3.8, 0.18, 44),
      new THREE.MeshStandardMaterial({ color: 0x34495e, roughness: 0.9 }),
    );
    floor.position.y = -0.1;
    scene.add(floor);
    const ringLine = new THREE.Mesh(
      new THREE.TorusGeometry(ORBIT_R, 0.025, 8, 56),
      new THREE.MeshStandardMaterial({ color: 0xf2b53a, roughness: 0.5 }),
    );
    ringLine.rotation.x = Math.PI / 2;
    ringLine.position.y = 0.01;
    scene.add(ringLine);

    // 中央のターンテーブル（音楽の見た目表現。再生中は回る）。
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.13, 0.5, 12),
      new THREE.MeshStandardMaterial({ color: 0x22282f, roughness: 0.5 }),
    );
    pole.position.y = 0.25;
    scene.add(pole);
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.52, 0.52, 0.06, 28),
      new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.35 }),
    );
    disc.position.y = 0.53;
    scene.add(disc);
    const discDot = createBall(0.09, 0xf2b53a);
    discDot.position.set(0.3, 0.06, 0);
    disc.add(discDot);

    const root = new THREE.Group();
    scene.add(root);
    rtRef.current = { root, chairs: new Map(), players: new Map(), orbitAngle: 0, disc };

    detach = attachPickPointer(stage, () => [root], {
      onTap: (hit) => {
        const id = findPickId(hit?.object ?? null);
        if (!id || !id.startsWith("chair-")) return;
        if (!propsRef.current.canSit) return;
        propsRef.current.onSit();
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

  // 差分同期: 椅子はキー単位 Map で増減（消滅はアニメーション付き）。
  // プレイヤーマーカーは座席単位で作り、状態（生存/着席/色）はここで反映し、
  // 円周上の動きそのものは onFrame が phase に追従して担う。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const now = performance.now();
    const desiredChairs = new Set<string>();
    for (let i = 0; i < chairs; i++) desiredChairs.add(`chair-${i}`);
    for (const [key, e] of [...rt.chairs]) {
      if (!desiredChairs.has(key) && !e.exiting) {
        e.exiting = true;
        e.exitStart = now;
      }
    }
    for (let i = 0; i < chairs; i++) {
      const key = `chair-${i}`;
      const existing = rt.chairs.get(key);
      if (existing && !existing.exiting) {
        const pos = chairPos(i, Math.max(1, chairs));
        existing.group.position.set(pos.x, 0, pos.z);
        existing.group.lookAt(0, 0, 0);
        continue;
      }
      if (existing) {
        existing.group.parent?.remove(existing.group);
        rt.chairs.delete(key);
      }
      const grp = createChair(i);
      const pos = chairPos(i, Math.max(1, chairs));
      grp.position.set(pos.x, 0, pos.z);
      grp.lookAt(0, 0, 0);
      grp.scale.setScalar(0.3);
      rt.root.add(grp);
      rt.chairs.set(key, { group: grp, exiting: false, exitStart: 0, bornAt: now });
    }
    // プレイヤー。
    const seen = new Set<number>();
    players.forEach((pl, idx) => {
      seen.add(pl.seat);
      let e = rt.players.get(pl.seat);
      if (!e) {
        const { group, mats } = createMarker(pl.seat, pl.seat === mySeat);
        rt.root.add(group);
        e = {
          group,
          mats,
          seat: pl.seat,
          alive: pl.alive,
          left: pl.left,
          sat: pl.sat,
          baseAngle: (idx / Math.max(1, players.length)) * Math.PI * 2,
          chairIndex: -1,
        };
        rt.players.set(pl.seat, e);
      }
      e.alive = pl.alive;
      e.left = pl.left;
      e.sat = pl.sat;
      const grey = !pl.alive || pl.left;
      const col = grey ? 0x8a8f96 : SEAT_COLORS[pl.seat % SEAT_COLORS.length];
      for (const m of e.mats) m.color.setHex(col);
    });
    for (const [seat, e] of [...rt.players]) {
      if (!seen.has(seat)) {
        e.group.parent?.remove(e.group);
        rt.players.delete(seat);
      }
    }
  }, [players, chairs, phase, round, mySeat, ready]);

  return (
    <SceneBox
      height={340}
      label={`椅子取り（3D）。椅子 ${chairs}個、プレイヤー ${players.length}人。音楽が止まったら椅子をタップして座ります`}
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#1f2733"
    />
  );
}
