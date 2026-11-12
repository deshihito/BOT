"use client";
// ワニワニの 3D シーン（three.js）。このファイルはクライアント側で
// next/dynamic 経由でのみ読み込まれ、three はこのページ専用チャンクになる。
// 頭部はプリミティブの組み合わせで造形し、歯はレイキャストでタップする。
// 進行・勝敗は lib/crocodile.ts が担い、ここでは押下アニメーション
// （指/棒で歯を沈める→当たりなら顎が高速で閉じる）を再生する。
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { CR_TEETH, type CrStatus } from "@/lib/crocodile";
import { sfxJawSnap, sfxJingle, sfxPop, sfxSafePress } from "@/lib/sfx";

interface Props {
  pressed: boolean[];
  status: CrStatus;
  lastPlayer: number | null;
  lastCpu: number | null;
  trap: number;
  onPress: (index: number) => void;
}

// 上あご7本（index 0〜6）: upperGroup ピボット (0, 0.75, -1.9) からの相対位置。
const UPPER_POS: Array<{ x: number; z: number; s: number }> = [
  { x: -0.68, z: 4.05, s: 1.12 }, { x: 0, z: 4.12, s: 1.18 }, { x: 0.68, z: 4.05, s: 1.12 },
  { x: -1.02, z: 3.25, s: 1.0 }, { x: 1.02, z: 3.25, s: 1.0 },
  { x: -1.02, z: 2.4, s: 0.9 }, { x: 1.02, z: 2.4, s: 0.9 },
];
// 下あご6本（index 7〜12）: ワールド位置。
const LOWER_POS: Array<{ x: number; z: number; s: number }> = [
  { x: -0.34, z: 2.05, s: 1.05 }, { x: 0.34, z: 2.05, s: 1.05 },
  { x: -0.98, z: 1.3, s: 0.95 }, { x: 0.98, z: 1.3, s: 0.95 },
  { x: -0.98, z: 0.45, s: 0.85 }, { x: 0.98, z: 0.45, s: 0.85 },
];
const UPPER_Y = -0.16;
const LOWER_Y = 0.36;
const SINK = 0.2;
const JAW_OPEN = -0.44;
const JAW_CLOSED = 0.02;

type AnimItem =
  | { kind: "press"; index: number; by: "player" | "cpu" }
  | { kind: "snap"; loser: "player" | "cpu" }
  | { kind: "open" };

interface ActiveAnim {
  item: AnimItem;
  t: number;
  toothWorld: THREE.Vector3;
  trapFinal: boolean;
  soundPlayed?: boolean;
}

export default function CrocodileScene3D({ pressed, status, lastPlayer, lastCpu, trap, onPress }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  const pressedRef = useRef(pressed);
  pressedRef.current = pressed;
  const statusRef = useRef(status);
  statusRef.current = status;
  const trapRef = useRef(trap);
  trapRef.current = trap;
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;

  const queueRef = useRef<AnimItem[]>([]);
  const prevPressedRef = useRef<boolean[]>(Array.from({ length: CR_TEETH }, () => false));
  const prevStatusRef = useRef<CrStatus>("playing");

  // props の変化をアニメーションキューへ変換する。
  useEffect(() => {
    const prev = prevPressedRef.current;
    const isReset = status === "playing" && pressed.every((p) => !p) && prev.some(Boolean);
    if (isReset) {
      queueRef.current = [{ kind: "open" }];
      prevPressedRef.current = [...pressed];
      prevStatusRef.current = status;
      return;
    }
    const newly: number[] = [];
    for (let i = 0; i < CR_TEETH; i++) {
      if (pressed[i] && !prev[i]) newly.push(i);
    }
    if (newly.length > 0) {
      const order: AnimItem[] = [];
      const rest = [...newly];
      const take = (idx: number | null, by: "player" | "cpu") => {
        if (idx === null) return;
        const at = rest.indexOf(idx);
        if (at >= 0) {
          rest.splice(at, 1);
          order.push({ kind: "press", index: idx, by });
        }
      };
      take(lastPlayer, "player");
      take(lastCpu, "cpu");
      for (const idx of rest) order.push({ kind: "press", index: idx, by: "player" });
      if (status !== "playing" && newly.includes(trap)) {
        order.push({ kind: "snap", loser: status === "lost" ? "player" : "cpu" });
      }
      queueRef.current.push(...order);
    }
    prevPressedRef.current = [...pressed];
    prevStatusRef.current = status;
  }, [pressed, status, lastPlayer, lastCpu, trap]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.touchAction = "none";
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xe9f4ec);

    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 60);
    camera.position.set(0, 3.35, 6.9);
    camera.lookAt(0, 0.3, 0.5);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x51735c, 1.1));
    const dir = new THREE.DirectionalLight(0xfff4dc, 1.5);
    dir.position.set(3, 6, 4);
    scene.add(dir);

    // 地面（池のほとりのマット）
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(9, 40),
      new THREE.MeshStandardMaterial({ color: 0xa9d6b8, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.3;
    scene.add(ground);

    const croc = new THREE.Group();
    scene.add(croc);

    const skinMat = new THREE.MeshStandardMaterial({ color: 0x3e8e4f, roughness: 0.65 });
    const skinDark = new THREE.MeshStandardMaterial({ color: 0x2f7040, roughness: 0.7 });
    const gumMat = new THREE.MeshStandardMaterial({ color: 0x8e2f35, roughness: 0.85 });

    // 下あご
    const lower = new THREE.Group();
    croc.add(lower);
    const lowerJaw = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.5, 4.4), skinMat);
    lowerJaw.position.set(0, 0, 0.2);
    lower.add(lowerJaw);
    const lowerTip = new THREE.Mesh(new THREE.SphereGeometry(1.25, 20, 14), skinMat);
    lowerTip.scale.set(1.0, 0.2, 0.42);
    lowerTip.position.set(0, 0, 2.35);
    lower.add(lowerTip);
    const lowerGum = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 4.0), gumMat);
    lowerGum.position.set(0, 0.3, 0.25);
    lower.add(lowerGum);

    // 上あご（ピボットは頭の付け根）
    const upper = new THREE.Group();
    upper.position.set(0, 0.75, -1.9);
    upper.rotation.x = JAW_OPEN;
    croc.add(upper);
    const upperJaw = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, 4.4), skinMat);
    upperJaw.position.set(0, 0.18, 2.2);
    upper.add(upperJaw);
    const upperTip = new THREE.Mesh(new THREE.SphereGeometry(1.3, 20, 14), skinMat);
    upperTip.scale.set(1.0, 0.21, 0.45);
    upperTip.position.set(0, 0.18, 4.35);
    upper.add(upperTip);
    const upperGum = new THREE.Mesh(new THREE.BoxGeometry(2.25, 0.12, 4.0), gumMat);
    upperGum.position.set(0, -0.12, 2.15);
    upper.add(upperGum);
    // 目と眉、鼻先、背びれ状の突起
    const eyeWhite = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
    const eyeBlack = new THREE.MeshStandardMaterial({ color: 0x14181c, roughness: 0.25 });
    for (const s of [-1, 1]) {
      const brow = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), skinDark);
      brow.scale.set(1, 0.62, 1);
      brow.position.set(s * 0.78, 0.5, 3.05);
      upper.add(brow);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 10), eyeWhite);
      eye.position.set(s * 0.78, 0.66, 3.12);
      upper.add(eye);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.095, 10, 8), eyeBlack);
      pupil.position.set(s * 0.78, 0.72, 3.28);
      upper.add(pupil);
      const nostril = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), skinDark);
      nostril.position.set(s * 0.34, 0.47, 4.3);
      upper.add(nostril);
    }
    for (let i = 0; i < 4; i++) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.3, 8), skinDark);
      spike.position.set(0, 0.52, 0.5 + i * 0.55);
      upper.add(spike);
    }

    // 歯
    const toothGeoUpper = new THREE.ConeGeometry(0.15, 0.44, 12);
    toothGeoUpper.rotateX(Math.PI);
    toothGeoUpper.translate(0, -0.22, 0);
    const toothGeoLower = new THREE.ConeGeometry(0.15, 0.44, 12);
    toothGeoLower.translate(0, 0.22, 0);
    const toothMeshes: THREE.Mesh[] = [];
    const toothMats: THREE.MeshStandardMaterial[] = [];
    const toothSink = new Float32Array(CR_TEETH);
    const addTooth = (index: number, parent: THREE.Object3D, geo: THREE.BufferGeometry, x: number, y: number, z: number, s: number) => {
      const mat = new THREE.MeshStandardMaterial({ color: 0xfffdf4, roughness: 0.35 });
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.scale.setScalar(s);
      m.userData.index = index;
      parent.add(m);
      toothMeshes[index] = m;
      toothMats[index] = mat;
    };
    UPPER_POS.forEach((p, i) => addTooth(i, upper, toothGeoUpper, p.x, UPPER_Y, p.z, p.s));
    LOWER_POS.forEach((p, i) => addTooth(7 + i, lower, toothGeoLower, p.x, LOWER_Y, p.z, p.s));

    // 押す側: プレイヤー=指（カプセル）、CPU=棒（円柱＋玉）
    const finger = new THREE.Group();
    const fingerMesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.15, 0.55, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0xf2c79b, roughness: 0.6 }),
    );
    fingerMesh.position.y = 0.45;
    finger.add(fingerMesh);
    finger.visible = false;
    scene.add(finger);
    const stick = new THREE.Group();
    const stickMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.09, 1.1, 10),
      new THREE.MeshStandardMaterial({ color: 0xd98a3d, roughness: 0.55 }),
    );
    stickMesh.position.y = 0.55;
    stick.add(stickMesh);
    const stickTop = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), stickMesh.material);
    stickTop.position.y = 1.1;
    stick.add(stickTop);
    stick.visible = false;
    scene.add(stick);

    // ---- アニメーション状態 ----
    let active: ActiveAnim | null = null;
    let jawAngle = JAW_OPEN;
    let jawMode: "open" | "closed" = "open";
    let shake = 0;
    let disposed = false;
    const tmpV = new THREE.Vector3();

    const toothTipWorld = (index: number): THREE.Vector3 => {
      const m = toothMeshes[index];
      m.getWorldPosition(tmpV);
      const tip = tmpV.clone();
      tip.y += index < 7 ? -0.4 : 0.4;
      return tip;
    };

    const startNext = () => {
      if (active) return;
      const item = queueRef.current.shift();
      if (!item) return;
      if (item.kind === "press") {
        const tip = toothTipWorld(item.index);
        const trapFinal = statusRef.current !== "playing" && item.index === trapRef.current;
        active = { item, t: 0, toothWorld: tip, trapFinal };
        const presser = item.by === "player" ? finger : stick;
        presser.visible = true;
        presser.position.copy(tip).add(new THREE.Vector3(0, 1.6, 1.7));
      } else if (item.kind === "snap") {
        active = { item, t: 0, toothWorld: new THREE.Vector3(), trapFinal: false };
        sfxJawSnap();
        jawMode = "closed";
        shake = 1;
        const tm = toothMats[trapRef.current];
        if (tm) tm.color.set(0xe0483e);
      } else {
        // open（リスタート）: 歯と顎を初期状態へ
        active = { item, t: 0, toothWorld: new THREE.Vector3(), trapFinal: false };
        jawMode = "open";
        finger.visible = false;
        stick.visible = false;
        toothSink.fill(0);
        for (let i = 0; i < CR_TEETH; i++) toothMats[i].color.set(0xfffdf4);
      }
    };

    const stepAnim = (dt: number) => {
      startNext();
      if (!active) return;
      const a = active;
      a.t += dt;
      if (a.item.kind === "press") {
        const idx = a.item.index;
        const presser = a.item.by === "player" ? finger : stick;
        const target = a.toothWorld.clone().add(new THREE.Vector3(0, 0.04, 0.12));
        const start = a.toothWorld.clone().add(new THREE.Vector3(0, 1.6, 1.7));
        const DUR = 0.85;
        const t = Math.min(1, a.t / DUR);
        if (t < 0.42) {
          const e = 1 - Math.pow(1 - t / 0.42, 2);
          presser.position.lerpVectors(start, target, e);
        } else if (t < 0.58) {
          const k = (t - 0.42) / 0.16;
          toothSink[idx] = SINK * k;
          presser.position.copy(target).y -= SINK * k;
          if (!a.soundPlayed) {
            a.soundPlayed = true;
            if (a.trapFinal) {
              // 顎が閉じる音は snap 側で鳴らす。
            } else if (a.item.by === "player") {
              sfxSafePress();
            } else {
              sfxPop(0.65);
            }
          }
        } else if (a.trapFinal) {
          // 当たり: 指/棒はそのまま（顎に挟まれる）。snap へ進む。
          if (t >= 1) active = null;
        } else {
          const k = (t - 0.58) / 0.42;
          const e = k * k;
          presser.position.lerpVectors(target.clone().setY(target.y - SINK), start, e);
          if (t >= 1) {
            presser.visible = false;
            active = null;
          }
        }
      } else if (a.item.kind === "snap") {
        const DUR = 0.6;
        if (a.t < 0.13) {
          const k = a.t / 0.13;
          jawAngle = JAW_OPEN + (JAW_CLOSED - JAW_OPEN) * k * k;
        } else {
          jawAngle = JAW_CLOSED;
        }
        if (!a.soundPlayed && a.t >= 0.3) {
          a.soundPlayed = true;
          sfxJingle(statusRef.current === "won");
        }
        if (a.t >= DUR) active = null;
      } else {
        // open
        const DUR = 0.45;
        const k = Math.min(1, a.t / DUR);
        jawAngle = jawAngle + (JAW_OPEN - jawAngle) * Math.min(1, k * 1.6);
        if (a.t >= DUR) {
          jawAngle = JAW_OPEN;
          active = null;
        }
      }
    };

    // ---- 入力（レイキャスト） ----
    const el = renderer.domElement;
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const pick = (e: PointerEvent): number | null => {
      const rect = el.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1));
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(toothMeshes, false);
      if (hits.length === 0) return null;
      return hits[0].object.userData.index as number;
    };
    const onDown = (e: PointerEvent) => {
      if (statusRef.current !== "playing") return;
      if (active || queueRef.current.length > 0) return;
      const idx = pick(e);
      if (idx === null) return;
      if (pressedRef.current[idx]) return;
      onPressRef.current(idx);
    };
    let hovered: number | null = null;
    const onMove = (e: PointerEvent) => {
      if (statusRef.current !== "playing") return;
      const idx = pick(e);
      if (idx !== hovered) {
        if (hovered !== null) toothMats[hovered].emissive.set(0x000000);
        hovered = idx;
        if (hovered !== null && !pressedRef.current[hovered]) toothMats[hovered].emissive.set(0x554411);
        el.style.cursor = hovered !== null ? "pointer" : "default";
      }
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);

    setReady(true);

    const clock = new THREE.Clock();
    let raf = 0;
    const animate = () => {
      if (disposed) return;
      raf = requestAnimationFrame(animate);
      const dt = Math.min(0.05, clock.getDelta());
      const time = clock.elapsedTime;

      stepAnim(dt);

      // 顎の待機モーション（呼吸）と揺れ
      if (!active || active.item.kind === "press") {
        if (jawMode === "open") {
          const target = JAW_OPEN + Math.sin(time * 1.4) * 0.014;
          jawAngle += (target - jawAngle) * Math.min(1, dt * 6);
        } else {
          jawAngle += (JAW_CLOSED - jawAngle) * Math.min(1, dt * 10);
        }
      }
      upper.rotation.x = jawAngle;
      if (shake > 0) {
        shake = Math.max(0, shake - dt * 2.2);
        croc.rotation.z = Math.sin(time * 70) * 0.02 * shake;
        camera.position.x = Math.sin(time * 65) * 0.05 * shake;
      } else {
        croc.rotation.z = 0;
        camera.position.x = 0;
      }

      // 歯の沈み込み（アニメーション対象以外は目標値へ寄せる）
      for (let i = 0; i < CR_TEETH; i++) {
        const isActiveTooth = active?.item.kind === "press" && active.item.index === i;
        if (!isActiveTooth) {
          const target = pressedRef.current[i] ? SINK : 0;
          toothSink[i] += (target - toothSink[i]) * Math.min(1, dt * 10);
        }
        const m = toothMeshes[i];
        if (i < 7) m.position.y = UPPER_Y + toothSink[i];
        else m.position.y = LOWER_Y - toothSink[i];
        const pressedNow = pressedRef.current[i];
        if (!(statusRef.current !== "playing" && i === trapRef.current)) {
          toothMats[i].color.set(pressedNow ? 0xd8d2c0 : 0xfffdf4);
        }
      }

      const w = container.clientWidth || 1;
      const hgt = container.clientHeight || 1;
      renderer.setSize(w, hgt, false);
      camera.aspect = w / hgt;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failed) {
    return (
      <div
        role="alert"
        style={{
          padding: "28px 16px",
          borderRadius: 24,
          border: "3px solid #2e7d46",
          background: "#eef7f0",
          textAlign: "center",
          fontSize: 14,
        }}
      >
        この環境では 3D 表示（WebGL）が使えないため、ワニワニを表示できません。WebGL 対応ブラウザでお試しください。
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label="ワニの頭部（3D）。歯をタップして押します"
      style={{
        position: "relative",
        width: "100%",
        height: 380,
        borderRadius: 24,
        overflow: "hidden",
        background: "#e9f4ec",
        touchAction: "none",
      }}
    >
      {!ready && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#2f5d3a", fontSize: 14 }}>
          読み込み中…
        </div>
      )}
    </div>
  );
}
