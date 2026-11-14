"use client";
// 爆弾パスの 3D シーン。円卓の周りにプレイヤーの人型トークンを並べ、
// 爆弾は黒い球＋導火線＋火花の立体で表す。所持者が変わると爆弾は
// 補間追従で次の所持者の元へ飛ぶ（受け渡しの表現）。
// 爆発までの残り時間はサーバー側でも伏せられており、シーンへは
// 一切渡らない（タイマー情報は受け取らない）。分かるのは所持者・
// 生存・失点だけ。失点はトークンの足元に小さな赤い球の数で示す。
// 入力: 自分が所持者のとき、相手トークンのタップ = 既存のパス操作
// （親の doPass）へ接続する。脱落判定・勝敗は親＋サーバーが正。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { createBall } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

export interface BombScenePlayer {
  seat: number;
  alive: boolean;
  left: boolean;
  isHolder: boolean;
  isYou: boolean;
  losses: number;
}

interface Props {
  players: BombScenePlayer[];
  holderSeat: number;
  finished: boolean;
  /** 自分が所持者でパスできる状態か（親が判定した結果だけを受け取る）。 */
  canPass: boolean;
  mySeat: number;
  /** 相手トークンのタップ = 既存のパスハンドラ（親の doPass）へ渡す。 */
  onPass: (seat: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const TABLE_R = 2.35;

function seatPos(index: number, total: number, myIndex: number): [number, number] {
  const a = ((index - myIndex) / Math.max(1, total)) * Math.PI * 2;
  return [Math.sin(a) * TABLE_R, Math.cos(a) * TABLE_R];
}

/** 人型トークン（体＋頭）。色は自分/他者/脱落で変える。 */
function createPlayerToken(isYou: boolean): THREE.Group {
  const grp = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.24, 0.3, 0.52, 20),
    new THREE.MeshStandardMaterial({ color: isYou ? 0x3f6fb5 : 0x7a8699, roughness: 0.5 }),
  );
  body.position.y = 0.26;
  body.name = "token-body";
  grp.add(body);
  const head = createBall(0.19, 0xf2c894, { roughness: 0.5 });
  head.position.y = 0.68;
  head.name = "token-head";
  grp.add(head);
  return grp;
}

/** 爆弾の立体（黒球＋導火線＋火花）。 */
function createBomb(): THREE.Group {
  const grp = new THREE.Group();
  const body = createBall(0.34, 0x171a21, { roughness: 0.35 });
  body.position.y = 0.34;
  grp.add(body);
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.11, 0.14, 12),
    new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.4, metalness: 0.4 }),
  );
  cap.position.y = 0.7;
  grp.add(cap);
  const fuse = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.025, 0.34, 8),
    new THREE.MeshStandardMaterial({ color: 0xb08954, roughness: 0.8 }),
  );
  fuse.position.set(0.12, 0.86, 0);
  fuse.rotation.z = -0.6;
  grp.add(fuse);
  const sparkMat = new THREE.MeshStandardMaterial({ color: 0xffa726, emissive: 0xff7b1c, emissiveIntensity: 1.4, roughness: 0.4 });
  const spark = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), sparkMat);
  spark.position.set(0.24, 0.99, 0);
  spark.name = "bomb-spark";
  grp.add(spark);
  return grp;
}

interface PlayerRt {
  grp: THREE.Group;
  bodyMat: THREE.MeshStandardMaterial;
  headMat: THREE.MeshStandardMaterial;
  ringMat: THREE.MeshStandardMaterial;
  ring: THREE.Mesh;
  sig: string;
  lossGroup: THREE.Group;
}

interface SceneRt {
  playersGroup: THREE.Group;
  bombGrp: THREE.Group;
  bombPos: THREE.Vector3;
  bombPlaced: boolean;
  playersRt: Map<number, PlayerRt>;
}

export default function BombPassScene3D({ players, holderSeat, finished, canPass, mySeat, onPass, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ canPass, onPass });
  propsRef.current = { canPass, onPass };
  const syncRef = useRef({ players, holderSeat, finished, mySeat });
  syncRef.current = { players, holderSeat, finished, mySeat };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x232830,
      camera: { position: [0, 6.4, 6.2], lookAt: [0, 0, 0], fov: 44 },
      onFrame: (dt, t) => {
        const rt = rtRef.current;
        if (!rt) return;
        const { players: ps, holderSeat: hs, finished: fin, mySeat: ms } = syncRef.current;
        // 爆弾は所持者の元へ補間追従する（距離がある間は少し浮かせて弧を描く）。
        const myIndex = Math.max(0, ps.findIndex((p) => p.seat === ms));
        const holderIndex = ps.findIndex((p) => p.seat === hs);
        if (holderIndex >= 0 && !fin) {
          const [hx, hz] = seatPos(holderIndex, ps.length, myIndex);
          const target = new THREE.Vector3(hx * 0.82, 0.15, hz * 0.82);
          if (!rt.bombPlaced) {
            rt.bombPos.copy(target);
            rt.bombPlaced = true;
          }
          const k = 1 - Math.exp(-dt * 5);
          rt.bombPos.lerp(target, k);
          const dist = rt.bombPos.distanceTo(target);
          rt.bombGrp.position.set(rt.bombPos.x, rt.bombPos.y + dist * 0.35, rt.bombPos.z);
          rt.bombGrp.visible = true;
          const spark = rt.bombGrp.getObjectByName("bomb-spark");
          if (spark) {
            const s = 1 + Math.sin(t * 9) * 0.25;
            spark.scale.setScalar(s);
          }
        } else {
          rt.bombGrp.visible = false;
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
      new THREE.CylinderGeometry(3.15, 3.25, 0.22, 40),
      new THREE.MeshStandardMaterial({ color: 0x24403a, roughness: 0.95 }),
    );
    table.position.y = -0.11;
    scene.add(table);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(3.18, 0.07, 10, 48),
      new THREE.MeshStandardMaterial({ color: 0x5b3a22, roughness: 0.6 }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.01;
    scene.add(rim);

    const playersGroup = new THREE.Group();
    scene.add(playersGroup);
    const bombGrp = createBomb();
    bombGrp.visible = false;
    scene.add(bombGrp);
    rtRef.current = { playersGroup, bombGrp, bombPos: new THREE.Vector3(), bombPlaced: false, playersRt: new Map() };

    detach = attachPickPointer(stage, () => [playersGroup], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (!id?.startsWith("pass-")) return;
        if (!propsRef.current.canPass) return;
        propsRef.current.onPass(Number(id.slice(5)));
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

  // プレイヤーの差分同期: 位置・生存・所持リング・失点球を状態に合わせる。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const myIndex = Math.max(0, players.findIndex((p) => p.seat === mySeat));
    const seen = new Set<number>();
    players.forEach((p, i) => {
      seen.add(p.seat);
      const [x, z] = seatPos(i, players.length, myIndex);
      const isHolderNow = p.isHolder && !finished;
      const sig = `${p.alive}|${p.left}|${isHolderNow}|${p.losses}|${p.isYou}`;
      const cur = rt.playersRt.get(p.seat);
      if (!cur) {
        const grp = createPlayerToken(p.isYou);
        grp.position.set(x, 0, z);
        const ringMat = new THREE.MeshStandardMaterial({
          color: 0xdc2626, roughness: 0.5, emissive: 0xdc2626, emissiveIntensity: 0.5, transparent: true, opacity: 0.95,
        });
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.48, 0.05, 10, 28), ringMat);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.04;
        ring.visible = isHolderNow;
        grp.add(ring);
        const hit = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.15, 0.95), new THREE.MeshBasicMaterial({ visible: false }));
        hit.position.y = 0.5;
        hit.userData.pickId = `pass-${p.seat}`;
        grp.add(hit);
        const lossGroup = new THREE.Group();
        grp.add(lossGroup);
        rt.playersGroup.add(grp);
        const bodyMat = (grp.getObjectByName("token-body") as THREE.Mesh).material as THREE.MeshStandardMaterial;
        const headMat = (grp.getObjectByName("token-head") as THREE.Mesh).material as THREE.MeshStandardMaterial;
        const entry: PlayerRt = { grp, bodyMat, headMat, ringMat, ring, sig, lossGroup };
        rt.playersRt.set(p.seat, entry);
        applyPlayerVisual(entry, p, isHolderNow);
        return;
      }
      cur.grp.position.set(x, 0, z);
      if (cur.sig !== sig) {
        cur.sig = sig;
        applyPlayerVisual(cur, p, isHolderNow);
      }
    });
    for (const [seat, e] of [...rt.playersRt]) {
      if (!seen.has(seat)) {
        rt.playersGroup.remove(e.grp);
        rt.playersRt.delete(seat);
      }
    }
  }, [players, finished, mySeat]);

  return (
    <SceneBox
      height={380}
      label="爆弾パス（3D）。自分が所持者のときは相手をタップでパスします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#232830"
    />
  );
}

/** 生存・失点・所持の見た目を反映する（脱落は灰色＋半透明、失点は足元の赤球）。 */
function applyPlayerVisual(entry: PlayerRt, p: BombScenePlayer, isHolderNow: boolean) {
  const dead = !p.alive;
  entry.bodyMat.color.setHex(dead ? 0x4b5563 : p.isYou ? 0x3f6fb5 : 0x7a8699);
  entry.bodyMat.transparent = dead;
  entry.bodyMat.opacity = dead ? 0.55 : 1;
  entry.headMat.transparent = dead;
  entry.headMat.opacity = dead ? 0.55 : 1;
  entry.ringMat.emissiveIntensity = isHolderNow ? 0.6 : 0;
  entry.ring.visible = isHolderNow;
  for (const child of [...entry.lossGroup.children]) entry.lossGroup.remove(child);
  for (let i = 0; i < p.losses; i++) {
    const pip = createBall(0.07, 0xdc2626, { roughness: 0.4 });
    pip.position.set(-0.14 + i * 0.14, 0.07, 0.42);
    entry.lossGroup.add(pip);
  }
}
