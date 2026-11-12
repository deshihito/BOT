"use client";
// ボウリングの 3D レーン（three.js）。このファイルはクライアント側で
// next/dynamic 経由でのみ読み込まれ、three はこのページ専用チャンクになる。
// 物理は自前の簡易 2D 円衝突（ボール×ピン、ピン×ピンの連鎖）で、
// 静止した時点で「倒れたピン」を親へ返し、スコア進行は lib/bowling.ts が担う。
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { PIN_POSITIONS } from "@/lib/bowling";
import { sfxGutter, sfxPinHit, sfxPinsDown, sfxRollStart } from "@/lib/sfx";

export interface BowlingSceneApi {
  adjustAim: (delta: number) => void;
  throwStraight: () => void;
}

interface Props {
  standing: boolean[];
  interactive: boolean;
  onResult: (knockedPins: number[]) => void;
  onBusyChange: (busy: boolean) => void;
  onReady: (api: BowlingSceneApi) => void;
}

const BALL_R = 0.36;
const PIN_R = 0.24;
const HIT_DIST = BALL_R + PIN_R; // 0.60
const PIN_PAIR_DIST = PIN_R * 2; // 0.48
const LANE_HALF = 1.73; // レーン端
const GUTTER_CENTER = 2.08; // ガター中心の |x|
const BALL_START_Z = 2.3;
const PIN_BASE_Z = -4.0; // ピン行（lib の y=0）の world z
const PIT_Z = -8.1;

interface PinSim {
  x: number;
  z: number;
  vx: number;
  vz: number;
  tilt: number;
  tiltVel: number;
  axisX: number;
  axisZ: number;
  hit: boolean;
  down: boolean;
  gone: boolean;
  // 同期アニメーション用
  mode: "idle" | "rerack" | "remove";
  fromX: number;
  fromZ: number;
  fromTilt: number;
  opacity: number;
}

interface BallSim {
  x: number;
  z: number;
  vx: number;
  vz: number;
  curve: number;
  inGutter: boolean;
  active: boolean;
}

type Phase = "aim" | "roll" | "waitSync" | "sync" | "done";

function pinWorldPos(i: number): { x: number; z: number } {
  return { x: PIN_POSITIONS[i].x, z: PIN_BASE_Z - PIN_POSITIONS[i].y };
}

function makePinSim(i: number): PinSim {
  const p = pinWorldPos(i);
  return {
    x: p.x, z: p.z, vx: 0, vz: 0,
    tilt: 0, tiltVel: 0, axisX: 0, axisZ: -1,
    hit: false, down: false, gone: false,
    mode: "idle", fromX: p.x, fromZ: p.z, fromTilt: 0, opacity: 1,
  };
}

function laneTexture(): THREE.Texture {
  const cv = document.createElement("canvas");
  cv.width = 256;
  cv.height = 1024;
  const g = cv.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 1024);
  grad.addColorStop(0, "#cfa55f");
  grad.addColorStop(1, "#bb9046");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 1024);
  // 板の継ぎ目（縦）
  g.strokeStyle = "rgba(120, 82, 30, 0.35)";
  g.lineWidth = 2;
  for (let i = 1; i < 8; i++) {
    g.beginPath();
    g.moveTo((256 / 8) * i, 0);
    g.lineTo((256 / 8) * i, 1024);
    g.stroke();
  }
  // 板の継ぎ目（横）
  g.strokeStyle = "rgba(120, 82, 30, 0.18)";
  for (let i = 1; i < 16; i++) {
    g.beginPath();
    g.moveTo(0, (1024 / 16) * i);
    g.lineTo(256, (1024 / 16) * i);
    g.stroke();
  }
  // レーンのドットと矢印（奥側 = canvas 上部）
  g.fillStyle = "rgba(90, 58, 18, 0.55)";
  for (const fx of [0.2, 0.38, 0.5, 0.62, 0.8]) {
    g.beginPath();
    g.arc(256 * fx, 150, 7, 0, Math.PI * 2);
    g.fill();
  }
  for (const fx of [0.14, 0.32, 0.5, 0.68, 0.86]) {
    g.beginPath();
    g.moveTo(256 * fx - 9, 330);
    g.lineTo(256 * fx + 9, 330);
    g.lineTo(256 * fx, 275);
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function pinGeometry(): THREE.LatheGeometry {
  const pts: Array<[number, number]> = [
    [0.0, 0.0], [0.19, 0.0], [0.235, 0.05], [0.24, 0.3], [0.205, 0.55],
    [0.15, 0.72], [0.135, 0.82], [0.155, 0.98], [0.185, 1.1], [0.14, 1.22], [0.0, 1.27],
  ];
  return new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), 20);
}

export default function BowlingScene3D({ standing, interactive, onResult, onBusyChange, onReady }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  const standingRef = useRef(standing);
  standingRef.current = standing;
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const onBusyRef = useRef(onBusyChange);
  onBusyRef.current = onBusyChange;

  // シーン内部の可変状態（初期化 effect が apiRef に詰める）。
  const apiRef = useRef<{
    startRoll: (vx: number, speed: number, curve: number) => void;
    setBallX: (x: number) => void;
    getBallX: () => number;
    syncToStanding: (standing: boolean[], instant: boolean) => void;
    isAiming: () => boolean;
  } | null>(null);
  const firstStandingRef = useRef(true);

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
    scene.background = new THREE.Color(0x232b36);
    scene.fog = new THREE.Fog(0x232b36, 12, 22);

    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 60);
    camera.position.set(0, 2.05, 5.1);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x2c3844, 1.05));
    const dir = new THREE.DirectionalLight(0xfff2d8, 1.6);
    dir.position.set(3.5, 7, 3);
    scene.add(dir);
    const back = new THREE.DirectionalLight(0xbfd4ff, 0.5);
    back.position.set(-2, 4, -6);
    scene.add(back);

    // レーン
    const lane = new THREE.Mesh(
      new THREE.PlaneGeometry(LANE_HALF * 2, 13.6),
      new THREE.MeshStandardMaterial({ map: laneTexture(), roughness: 0.75, metalness: 0.02 }),
    );
    lane.rotation.x = -Math.PI / 2;
    lane.position.set(0, 0, -1.6);
    scene.add(lane);
    // ガター（左右の溝）
    const gutterMat = new THREE.MeshStandardMaterial({ color: 0x39424e, roughness: 0.6, metalness: 0.25 });
    for (const s of [-1, 1]) {
      const gut = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.06, 13.6), gutterMat);
      gut.position.set(s * GUTTER_CENTER, -0.045, -1.6);
      scene.add(gut);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 13.6), new THREE.MeshStandardMaterial({ color: 0x6b7684, roughness: 0.5, metalness: 0.3 }));
      rail.position.set(s * (GUTTER_CENTER + 0.42), 0.02, -1.6);
      scene.add(rail);
    }
    // ピット（奥の暗がり）と後壁
    const pit = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 2.2), new THREE.MeshStandardMaterial({ color: 0x11161c, roughness: 1 }));
    pit.rotation.x = -Math.PI / 2;
    pit.position.set(0, -0.02, -7.6);
    scene.add(pit);
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 2.6), new THREE.MeshStandardMaterial({ color: 0x171d26, roughness: 1 }));
    wall.position.set(0, 1.3, -8.7);
    scene.add(wall);
    // ピンデッキ
    const deck = new THREE.Mesh(new THREE.PlaneGeometry(LANE_HALF * 2, 4.4), new THREE.MeshStandardMaterial({ color: 0xd8b878, roughness: 0.7 }));
    deck.rotation.x = -Math.PI / 2;
    deck.position.set(0, 0.005, -5.6);
    scene.add(deck);

    // ピン
    const geo = pinGeometry();
    const stripeGeo = new THREE.TorusGeometry(0.146, 0.02, 8, 24);
    const pinGroups: THREE.Group[] = [];
    const pinMats: THREE.MeshStandardMaterial[] = [];
    const stripeMats: THREE.MeshStandardMaterial[] = [];
    for (let i = 0; i < 10; i++) {
      const grp = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: 0xf7f4ec, roughness: 0.32, transparent: true });
      const body = new THREE.Mesh(geo, mat);
      grp.add(body);
      const smat = new THREE.MeshStandardMaterial({ color: 0xc8402f, roughness: 0.4, transparent: true });
      for (const y of [0.86, 0.95]) {
        const ring = new THREE.Mesh(stripeGeo, smat);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = y;
        grp.add(ring);
      }
      const p = pinWorldPos(i);
      grp.position.set(p.x, 0, p.z);
      scene.add(grp);
      pinGroups.push(grp);
      pinMats.push(mat);
      stripeMats.push(smat);
    }

    // ボールとその影
    const ballMesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 28, 20),
      new THREE.MeshStandardMaterial({ color: 0x2d3a8f, roughness: 0.22, metalness: 0.15 }),
    );
    scene.add(ballMesh);
    const ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(BALL_R * 1.05, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22 }),
    );
    ballShadow.rotation.x = -Math.PI / 2;
    ballShadow.position.y = 0.012;
    scene.add(ballShadow);

    // ---- シミュレーション状態 ----
    const pins: PinSim[] = Array.from({ length: 10 }, (_, i) => makePinSim(i));
    const ball: BallSim = { x: 0.34, z: BALL_START_Z, vx: 0, vz: 0, curve: 0, inGutter: false, active: false };
    let aimX = 0.34; // 狙いの横位置。投球が終わったらボールはここへ戻る。
    let phase: Phase = "aim";
    let rollTime = 0;
    let syncTime = 0;
    let ballHitPin = false;
    let gutterPlayed = false;
    let stopRoll: (() => void) | null = null;
    let camX = 0;
    let disposed = false;

    const setBallVisible = (v: boolean) => { ballMesh.visible = v; ballShadow.visible = v; };

    const startRoll = (vx: number, speed: number, curve: number) => {
      if (phase !== "aim") return;
      ball.x = aimX;
      ball.z = BALL_START_Z;
      ball.vx = vx;
      ball.vz = -speed;
      ball.curve = curve;
      ball.active = true;
      ball.inGutter = false;
      rollTime = 0;
      ballHitPin = false;
      gutterPlayed = false;
      phase = "roll";
      stopRoll = sfxRollStart();
      onBusyRef.current(true);
    };

    const finalizeRoll = () => {
      const knockedPins: number[] = [];
      for (let i = 0; i < 10; i++) {
        const p = pins[i];
        if (p.gone) continue;
        const origin = pinWorldPos(i);
        const disp = Math.hypot(p.x - origin.x, p.z - origin.z);
        if (p.tilt > 0.75 || disp > 0.55 || p.z < -7.6 || Math.abs(p.x) > GUTTER_CENTER + 0.35) {
          p.down = true;
          knockedPins.push(i + 1);
        }
      }
      if (stopRoll) { stopRoll(); stopRoll = null; }
      if (knockedPins.length > 0) sfxPinsDown(knockedPins.length);
      phase = "waitSync";
      setBallVisible(false);
      onResultRef.current(knockedPins);
    };

    const syncToStanding = (next: boolean[], instant: boolean) => {
      if (phase === "roll") return;
      const keepFallen = !interactiveRef.current; // 終了時は倒れたピンを残す
      phase = "sync";
      syncTime = instant ? 1 : 0;
      for (let i = 0; i < 10; i++) {
        const p = pins[i];
        p.fromX = p.x; p.fromZ = p.z; p.fromTilt = p.tilt;
        if (next[i]) {
          p.mode = "rerack";
          if (instant) {
            const o = pinWorldPos(i);
            p.x = o.x; p.z = o.z; p.tilt = 0; p.tiltVel = 0; p.vx = 0; p.vz = 0;
            p.hit = false; p.down = false; p.gone = false; p.opacity = 1;
          }
        } else if (p.gone || keepFallen) {
          p.mode = "idle";
        } else {
          p.mode = "remove";
        }
      }
      if (instant) finishSync();
    };

    const finishSync = () => {
      for (let i = 0; i < 10; i++) {
        const p = pins[i];
        if (p.mode === "rerack") {
          const o = pinWorldPos(i);
          p.x = o.x; p.z = o.z; p.tilt = 0; p.tiltVel = 0; p.vx = 0; p.vz = 0;
          p.hit = false; p.down = false; p.gone = false; p.opacity = 1;
        } else if (p.mode === "remove") {
          p.gone = true;
          p.opacity = 0;
        }
        p.mode = "idle";
      }
      ball.x = aimX;
      ball.z = BALL_START_Z;
      ball.vx = 0; ball.vz = 0; ball.active = false; ball.inGutter = false;
      setBallVisible(true);
      phase = interactiveRef.current ? "aim" : "done";
      if (phase === "aim") onBusyRef.current(false);
    };

    apiRef.current = {
      startRoll,
      setBallX: (x) => { if (phase === "aim") { aimX = THREE.MathUtils.clamp(x, -1.6, 1.6); ball.x = aimX; } },
      getBallX: () => aimX,
      syncToStanding,
      isAiming: () => phase === "aim",
    };
    onReady({
      adjustAim: (d) => { if (phase === "aim") { aimX = THREE.MathUtils.clamp(aimX + d, -1.6, 1.6); ball.x = aimX; } },
      throwStraight: () => startRoll(0, 11.6, 0),
    });
    syncToStanding(standingRef.current, true);
    setReady(true);

    // ---- 入力（ドラッグで狙い、フリックで投球） ----
    const el = renderer.domElement;
    let aiming = false;
    let samples: Array<{ t: number; x: number; y: number }> = [];
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    const pointerBallX = (clientX: number): number | null => {
      const rect = el.getBoundingClientRect();
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, 0);
      raycaster.setFromCamera(ndc, camera);
      const o = raycaster.ray.origin;
      const d = raycaster.ray.direction;
      if (Math.abs(d.z) < 1e-6) return null;
      const t = (BALL_START_Z - o.z) / d.z;
      if (t < 0) return null;
      return THREE.MathUtils.clamp(o.x + d.x * t, -1.6, 1.6);
    };

    const onDown = (e: PointerEvent) => {
      if (phase !== "aim" || !interactiveRef.current) return;
      aiming = true;
      samples = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
      const bx = pointerBallX(e.clientX);
      if (bx !== null) { aimX = bx; ball.x = bx; }
      try { el.setPointerCapture(e.pointerId); } catch { /* noop */ }
    };
    const onMove = (e: PointerEvent) => {
      if (!aiming) return;
      const bx = pointerBallX(e.clientX);
      if (bx !== null) { aimX = bx; ball.x = bx; }
      const now = performance.now();
      samples.push({ t: now, x: e.clientX, y: e.clientY });
      samples = samples.filter((s) => now - s.t <= 160);
    };
    const onUp = (e: PointerEvent) => {
      if (!aiming) return;
      aiming = false;
      const now = performance.now();
      samples.push({ t: now, x: e.clientX, y: e.clientY });
      samples = samples.filter((s) => now - s.t <= 160);
      if (samples.length < 2) return;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = (last.t - first.t) / 1000;
      if (dt <= 0.01) return;
      const vy = (first.y - last.y) / dt; // 上方向へのフリック速度 px/s
      const vxPx = (last.x - first.x) / dt;
      if (vy < 260) return; // フリックが弱い = 狙い調整だけ
      const power = THREE.MathUtils.clamp(vy / 1500, 0.25, 1);
      const speed = 8 + power * 5.5;
      const latVx = THREE.MathUtils.clamp(vxPx / 450, -2.2, 2.2);
      const curve = THREE.MathUtils.clamp(vxPx / 1400, -1, 1) * 1.5;
      startRoll(latVx, speed, curve);
    };
    const onCancel = () => { aiming = false; };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);

    // ---- 物理 ----
    const stepPhysics = (h: number) => {
      if (ball.active) {
        const speed = -ball.vz;
        ball.vx += ball.curve * 2.3 * Math.exp(-rollTime * 1.1) * h;
        ball.vx *= Math.max(0, 1 - 0.55 * h);
        ball.vz *= Math.max(0, 1 - 0.045 * h);
        ball.x += ball.vx * h;
        ball.z += ball.vz * h;
        if (!ball.inGutter && Math.abs(ball.x) > LANE_HALF + 0.12) {
          ball.inGutter = true;
          if (!gutterPlayed) { gutterPlayed = true; sfxGutter(); if (stopRoll) { stopRoll(); stopRoll = null; } }
        }
        if (ball.inGutter) {
          const c = Math.sign(ball.x) * GUTTER_CENTER;
          ball.x += (c - ball.x) * Math.min(1, 10 * h);
          ball.vx = 0;
        }
        void speed;
        // ボール × ピン
        if (!ball.inGutter) {
          for (let i = 0; i < 10; i++) {
            const p = pins[i];
            if (p.gone || p.down) continue;
            const dx = p.x - ball.x;
            const dz = p.z - ball.z;
            const d2 = dx * dx + dz * dz;
            if (d2 >= HIT_DIST * HIT_DIST) continue;
            const d = Math.sqrt(d2) || 0.0001;
            const nx = dx / d;
            const nz = dz / d;
            const spd = -ball.vz;
            p.vx += nx * (spd * 0.92 + 1.4);
            p.vz += nz * (spd * 0.92 + 1.4);
            p.hit = true;
            ball.vz *= 0.9;
            ball.vx -= nx * spd * 0.13;
            if (!ballHitPin) { ballHitPin = true; sfxPinHit(); }
          }
        }
        if (ball.z < PIT_Z || -ball.vz < 0.4) ball.active = false;
      }
      // ピン × ピン
      for (let i = 0; i < 10; i++) {
        const a = pins[i];
        if (a.gone) continue;
        for (let j = i + 1; j < 10; j++) {
          const b = pins[j];
          if (b.gone) continue;
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const d2 = dx * dx + dz * dz;
          if (d2 >= PIN_PAIR_DIST * PIN_PAIR_DIST || d2 === 0) continue;
          const d = Math.sqrt(d2);
          const nx = dx / d;
          const nz = dz / d;
          const overlap = (PIN_PAIR_DIST - d) / 2;
          a.x -= nx * overlap; a.z -= nz * overlap;
          b.x += nx * overlap; b.z += nz * overlap;
          const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
          if (rel < 0) {
            const imp = -rel * 0.82;
            a.vx -= nx * imp; a.vz -= nz * imp;
            b.vx += nx * imp; b.vz += nz * imp;
            if (Math.abs(imp) > 0.3) { a.hit = true; b.hit = true; }
          }
        }
      }
      // ピンの移動と転倒
      for (const p of pins) {
        if (p.gone || p.mode !== "idle") continue;
        const spd = Math.hypot(p.vx, p.vz);
        if (spd > 0.01 || p.tiltVel > 0) {
          p.x += p.vx * h;
          p.z += p.vz * h;
          const fr = Math.max(0, 1 - 2.8 * h);
          p.vx *= fr; p.vz *= fr;
          if (p.hit && !p.down) {
            if (p.tilt === 0 && spd > 0.55) {
              // 転倒開始: 倒れる方向を固定する
              p.axisX = p.vz / spd;
              p.axisZ = -p.vx / spd;
              p.tiltVel = Math.min(3.4, spd * 1.6);
            }
            if (p.tilt > 0) {
              p.tilt = Math.min(1.62, p.tilt + p.tiltVel * h);
              if (p.tilt >= 1.45) { p.down = true; p.tiltVel = 0; }
            }
            // 大きく滑ったピンも倒す
            const origin = pinWorldPos(pins.indexOf(p));
            if (!p.down && Math.hypot(p.x - origin.x, p.z - origin.z) > 0.55 && p.tilt === 0) {
              const dx = p.x - origin.x;
              const dz = p.z - origin.z;
              const dd = Math.hypot(dx, dz) || 1;
              p.axisX = dz / dd;
              p.axisZ = -dx / dd;
              p.tiltVel = 2.6;
              p.tilt = 0.01;
            }
          }
          if (p.z < -7.7 || Math.abs(p.x) > GUTTER_CENTER + 0.4) {
            p.down = true;
            p.tilt = Math.max(p.tilt, 1.62);
            p.vx = 0; p.vz = 0; p.tiltVel = 0;
          }
        }
      }
    };

    const allPinsSettled = (): boolean => {
      for (const p of pins) {
        if (p.gone || p.mode !== "idle") continue;
        const spd = Math.hypot(p.vx, p.vz);
        if (spd > 0.35) return false;
        if (p.tilt > 0.02 && p.tilt < 1.4) return false;
      }
      return true;
    };

    // ---- 描画ループ ----
    const clock = new THREE.Clock();
    let raf = 0;
    const animate = () => {
      if (disposed) return;
      raf = requestAnimationFrame(animate);
      const dt = Math.min(0.05, clock.getDelta());

      if (phase === "roll") {
        rollTime += dt;
        const steps = Math.max(1, Math.min(12, Math.ceil(dt / (1 / 240))));
        const h = dt / steps;
        for (let s = 0; s < steps; s++) stepPhysics(h);
        if ((rollTime > 0.85 && !ball.active && allPinsSettled()) || rollTime > 4.2) {
          finalizeRoll();
        }
      } else if (phase === "sync") {
        syncTime += dt;
        const t = Math.min(1, syncTime / 0.5);
        const e = 1 - Math.pow(1 - t, 3);
        for (const p of pins) {
          if (p.mode === "rerack") {
            const o = pinWorldPos(pins.indexOf(p));
            p.x = p.fromX + (o.x - p.fromX) * e;
            p.z = p.fromZ + (o.z - p.fromZ) * e;
            p.tilt = p.fromTilt * (1 - e);
            p.opacity = Math.min(1, p.opacity + dt * 3);
          } else if (p.mode === "remove") {
            p.z = p.fromZ - 1.5 * e;
            p.opacity = 1 - e;
          }
        }
        if (t >= 1) finishSync();
      }

      // メッシュへ反映
      for (let i = 0; i < 10; i++) {
        const p = pins[i];
        const grp = pinGroups[i];
        grp.visible = !p.gone && p.opacity > 0.01;
        grp.position.set(p.x, 0, p.z);
        if (p.tilt > 0.001) {
          grp.quaternion.setFromAxisAngle(new THREE.Vector3(p.axisX, 0, p.axisZ).normalize(), p.tilt);
        } else {
          grp.quaternion.identity();
        }
        pinMats[i].opacity = p.opacity;
        stripeMats[i].opacity = p.opacity;
      }
      ballMesh.position.set(ball.x, ball.inGutter ? 0.17 : BALL_R, ball.z);
      ballShadow.position.set(ball.x, 0.012, ball.z);

      // カメラ
      let targetPos: THREE.Vector3;
      let targetLook: THREE.Vector3;
      if (phase === "roll" || phase === "waitSync") {
        const chase = Math.min(2.3, Math.max(0, (BALL_START_Z - ball.z) * 0.3));
        targetPos = new THREE.Vector3(ball.x * 0.4, 2.0, 5.1 - chase);
        targetLook = new THREE.Vector3(ball.x * 0.55, 0.25, ball.z - 2.4);
      } else {
        targetPos = new THREE.Vector3(ball.x * 0.45, 2.05, 5.1);
        targetLook = new THREE.Vector3(ball.x * 0.5, 0.25, -3.6);
      }
      const k = 1 - Math.exp(-7 * dt);
      camera.position.lerp(targetPos, k);
      camX += (targetLook.x - camX) * k;
      camera.lookAt(camX, targetLook.y, targetLook.z);

      const w = container.clientWidth || 1;
      const hgt = container.clientHeight || 1;
      if (renderer.domElement.width !== Math.floor(w * renderer.getPixelRatio()) || renderer.domElement.height !== Math.floor(hgt * renderer.getPixelRatio())) {
        renderer.setSize(w, hgt, false);
        camera.aspect = w / hgt;
        camera.updateProjectionMatrix();
      }
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
      if (stopRoll) stopRoll();
      renderer.dispose();
      geo.dispose();
      container.removeChild(renderer.domElement);
      apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 親の standing 変化へ同期する（初回は初期化 effect 内で即時適用）。
  useEffect(() => {
    if (firstStandingRef.current) {
      firstStandingRef.current = false;
      return;
    }
    apiRef.current?.syncToStanding(standing, false);
  }, [standing]);

  if (failed) {
    return (
      <div
        role="alert"
        style={{
          padding: "28px 16px",
          borderRadius: 12,
          border: "2px solid #7d5a24",
          background: "#f6ecd8",
          textAlign: "center",
          fontSize: 14,
        }}
      >
        この環境では 3D 表示（WebGL）が使えないため、ボウリングを表示できません。WebGL 対応ブラウザでお試しください。
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label="ボウリングの3Dレーン"
      style={{
        position: "relative",
        width: "100%",
        height: 470,
        borderRadius: 12,
        overflow: "hidden",
        background: "#232b36",
        touchAction: "none",
        cursor: ready ? "pointer" : "wait",
      }}
    >
      {!ready && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#dfe7ef", fontSize: 14 }}>
          読み込み中…
        </div>
      )}
    </div>
  );
}
