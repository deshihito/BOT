"use client";
// ライアーズダイスの 3D シーン。自分のダイスは DiceSet で見せ、
// 相手のダイスはカップで伏せる（個数だけが公開情報なので値は描かない）。
// 新ラウンドで自分のダイスが振り直されたら転がし演出を行う。
// カップ/ダイスへのタップ・フリックは転がし演出の再生（状態は変えない）。
// 宣言・チャレンジは従来どおり DOM 操作のまま（このシーンは表現だけ）。
// WebGL が使えない場合は onFail で親へ知らせ、親は従来表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage } from "@/lib/three-kit/stage";
import { DiceSet } from "@/lib/three-kit/dice";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";

interface OpponentInfo {
  seat: number;
  diceCount: number;
  isCurrent: boolean;
  eliminated: boolean;
}

interface Props {
  myDice: number[];
  round: number;
  opponents: OpponentInfo[];
  onFail: () => void;
  fallback: ReactNode;
}

const DIE = 0.78;
const MAX_DICE = 5;
const MY_XS = [-2.0, -1.0, 0, 1.0, 2.0];

/** 相手のダイスを伏せるカップ（上から被せる形）。 */
function createCup(color: number): THREE.Group {
  const grp = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.52, 0.72, 0.85, 24, 1, true),
    new THREE.MeshStandardMaterial({ color, roughness: 0.45, side: THREE.DoubleSide }),
  );
  body.position.y = 0.43;
  grp.add(body);
  const top = new THREE.Mesh(
    new THREE.CircleGeometry(0.52, 24),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.8), roughness: 0.5 }),
  );
  top.rotation.x = -Math.PI / 2;
  top.position.y = 0.86;
  grp.add(top);
  const knob = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 14, 10),
    new THREE.MeshStandardMaterial({ color: 0xd9c58a, roughness: 0.35, metalness: 0.4 }),
  );
  knob.position.y = 0.95;
  grp.add(knob);
  grp.userData.pickId = "cup";
  body.userData.pickId = "cup";
  return grp;
}

export default function LiarsDiceScene3D({ myDice, round, opponents, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const setRef = useRef<DiceSet | null>(null);
  const cupsRef = useRef<THREE.Group[]>([]);
  const ringsRef = useRef<THREE.Mesh[]>([]);
  const prevSigRef = useRef<string | null>(null);

  const propsRef = useRef({ myDice, round, opponents });
  propsRef.current = { myDice, round, opponents };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x27313d,
      camera: { position: [0, 4.8, 6.4], lookAt: [0, 0, 0.2], fov: 44 },
      onFrame: (dt) => setRef.current?.update(dt),
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;

    // テーブル（フェルト）
    const table = new THREE.Mesh(
      new THREE.CircleGeometry(8, 40),
      new THREE.MeshStandardMaterial({ color: 0x2e5d43, roughness: 1 }),
    );
    table.rotation.x = -Math.PI / 2;
    table.position.y = -0.02;
    scene.add(table);

    // 自分のダイス（最大5個。個数が減ったら余りは隠す）
    const rest = MY_XS.map((x) => new THREE.Vector3(x, DIE / 2 + 0.04, 1.7));
    const set = new DiceSet({ size: DIE, restPositions: rest, scatter: 0.24 });
    set.meshes().forEach((m) => { m.userData.pickId = "mine"; });
    scene.add(set.group);
    setRef.current = set;

    // 相手のカップ列（奥側に弧状に並べる）
    const cups: THREE.Group[] = [];
    const rings: THREE.Mesh[] = [];
    const cupColors = [0x8e3b32, 0x31517d, 0x3f7a4e, 0x7a5a2e, 0x5d3a7a];
    for (let i = 0; i < 5; i++) {
      const cup = createCup(cupColors[i]);
      const x = (i - 2) * 1.35;
      cup.position.set(x, 0, -1.9 + Math.abs(i - 2) * 0.22);
      cup.visible = false;
      scene.add(cup);
      cups.push(cup);
      // 手番の相手のカップ下に敷く金のリング
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.82, 0.045, 8, 32),
        new THREE.MeshStandardMaterial({ color: 0xd9a41c, roughness: 0.35, metalness: 0.4 }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.set(cup.position.x, 0.03, cup.position.z);
      ring.visible = false;
      scene.add(ring);
      rings.push(ring);
    }
    cupsRef.current = cups;
    ringsRef.current = rings;

    const applyLayout = () => {
      const p = propsRef.current;
      set.meshes().forEach((m, i) => { m.visible = i < p.myDice.length; });
      p.opponents.forEach((op, i) => {
        const cup = cups[i];
        if (cup) cup.visible = op.diceCount > 0;
        const ring = rings[i];
        if (ring) ring.visible = op.diceCount > 0 && op.isCurrent;
      });
      for (let i = p.opponents.length; i < cups.length; i++) {
        cups[i].visible = false;
        rings[i].visible = false;
      }
    };
    applyLayout();
    if (propsRef.current.myDice.length > 0) set.setInstant(propsRef.current.myDice);
    prevSigRef.current = `${propsRef.current.round}:${propsRef.current.myDice.join(",")}`;

    detach = attachPickPointer(stage, () => [...set.meshes(), ...cupsRef.current], {
      // カップ/ダイスのタップ・フリック = 振る演出の再生（公開状態は変えない）
      onTap: () => {
        const p = propsRef.current;
        if (p.myDice.length > 0 && !set.isRolling()) set.roll(p.myDice);
      },
      onFlick: () => {
        const p = propsRef.current;
        if (p.myDice.length > 0 && !set.isRolling()) set.roll(p.myDice);
      },
    });
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      setRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 新ラウンド（ダイスの振り直し）で転がし、レイアウト変化（個数・手番）に追従する。
  useEffect(() => {
    const set = setRef.current;
    if (!set) return;
    set.meshes().forEach((m, i) => { m.visible = i < myDice.length; });
    opponents.forEach((op, i) => {
      const cup = cupsRef.current[i];
      if (cup) cup.visible = op.diceCount > 0;
      const ring = ringsRef.current[i];
      if (ring) ring.visible = op.diceCount > 0 && op.isCurrent;
    });
    for (let i = opponents.length; i < cupsRef.current.length; i++) {
      cupsRef.current[i].visible = false;
      if (ringsRef.current[i]) ringsRef.current[i].visible = false;
    }
    const sig = `${round}:${myDice.join(",")}`;
    if (prevSigRef.current !== null && sig !== prevSigRef.current && myDice.length > 0) {
      set.roll(myDice);
    } else if (myDice.length > 0 && prevSigRef.current === null) {
      set.setInstant(myDice);
    }
    prevSigRef.current = sig;
  }, [myDice, round, opponents]);

  return (
    <SceneBox
      height={300}
      label="ライアーズダイスのテーブル（3D）。手前のダイスがあなたのです。相手のダイスはカップで伏せてあります"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#27313d"
    />
  );
}
