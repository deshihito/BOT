"use client";
// AGO WORLD BOX（横スクロール2Dサンドボックス）の v1 基底。
// 生成されたワールドを歩き・跳び、ブロックを掘って集め、置いて作る。
// ゲームループと描画は canvas + refs で回し、React state は HUD 表示だけに使う。
// 純粋ロジック（生成・物理・掘る/置く・保存変換）は lib/worldbox/ に分離。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AIR, BLOCKS, HOTBAR_BLOCKS, canDigBlock, hardnessOf } from "@/lib/worldbox/blocks";
import { generateWorld, getTile, findSpawn, WORLD_H, WORLD_W, type World } from "@/lib/worldbox/worldgen";
import { createBody, stepPlayer, PLAYER_H, PLAYER_W, type PlayerBody } from "@/lib/worldbox/physics";
import { digTile, placeTile, withinReach, type Inventory } from "@/lib/worldbox/rules";
import { parseSave, serializeSave } from "@/lib/worldbox/save";
import { sfxPlace, sfxTap } from "@/lib/sfx";
import { useGamesNav } from "../GamesShell";

const SAVE_KEY = "ago-worldbox-save-v1";
const DAY_LENGTH_SEC = 240;

type Hud = { inv: Inventory; depth: number };

/** セーブから読み戻したタイル列から地表列を再計算する（深度表示用）。 */
function computeSurfaces(tiles: Uint8Array): Uint8Array {
  const surfaces = new Uint8Array(WORLD_W);
  const groundIds = new Set([1, 2, 3, 6, 7, 8, 9]); // 草・土・石・砂・鉱石・岩盤
  for (let x = 0; x < WORLD_W; x++) {
    let y = WORLD_H - 1;
    for (let yy = 0; yy < WORLD_H; yy++) {
      if (groundIds.has(tiles[yy * WORLD_W + x])) {
        y = yy;
        break;
      }
    }
    surfaces[x] = y;
  }
  return surfaces;
}

function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

type SkyStop = [number, [number, number, number]];
const SKY: SkyStop[] = [
  [0.0, [11, 16, 38]],
  [0.2, [126, 200, 227]],
  [0.5, [174, 227, 247]],
  [0.74, [247, 178, 103]],
  [0.84, [53, 64, 110]],
  [1.0, [11, 16, 38]],
];

function skyColor(t: number): [number, number, number] {
  for (let i = 0; i < SKY.length - 1; i++) {
    const [t0, c0] = SKY[i];
    const [t1, c1] = SKY[i + 1];
    if (t >= t0 && t <= t1) {
      const k = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      return [0, 1, 2].map((j) => Math.round(c0[j] + (c1[j] - c0[j]) * k)) as [number, number, number];
    }
  }
  return SKY[0][1];
}

/** 夜の暗さ（0=昼、1=真夜中）。 */
function nightAmount(t: number): number {
  if (t < 0.18 || t > 0.9) return 1;
  if (t > 0.24 && t < 0.8) return 0;
  if (t <= 0.24) return 1 - (t - 0.18) / 0.06;
  return (t - 0.8) / 0.1;
}

export default function WorldBoxClient() {
  const { prefix } = useGamesNav();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const worldRef = useRef<World | null>(null);
  const bodyRef = useRef<PlayerBody | null>(null);
  const invRef = useRef<Inventory>({});
  const selectedRef = useRef<number>(HOTBAR_BLOCKS[1]); // 初期選択は土
  const keysRef = useRef({ left: false, right: false, jump: false, fastFall: false });
  const touchRef = useRef({ left: false, right: false, jump: false, fastFall: false, dig: false });
  const digKeyRef = useRef(false);
  const pointerRef = useRef<{ down: boolean; tx: number; ty: number }>({ down: false, tx: -1, ty: -1 });
  const digRef = useRef<{ x: number; y: number; progress: number } | null>(null);
  const placeCooldownRef = useRef(0);
  const camRef = useRef({ x: 0, y: 0 });
  const dayRef = useRef(0.3); // 昼から始める
  const walkPhaseRef = useRef(0);
  const dirtyRef = useRef(false);
  const lastHudRef = useRef(0);
  const seedRef = useRef(0);

  const [hud, setHud] = useState<Hud>({ inv: {}, depth: 0 });
  const [selected, setSelected] = useState<number>(HOTBAR_BLOCKS[1]);
  const [touchUi, setTouchUi] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const [seedShown, setSeedShown] = useState(0);

  const selectBlock = (id: number) => {
    selectedRef.current = id;
    setSelected(id);
  };

  /** ワールドを（セーブ or 新規で）用意し、プレイヤーを配置する。 */
  const setupWorld = (forceNew: boolean) => {
    let loaded = false;
    if (!forceNew) {
      try {
        const raw = localStorage.getItem(SAVE_KEY);
        const save = parseSave(raw);
        if (save) {
          worldRef.current = {
            seed: save.seed,
            width: WORLD_W,
            height: WORLD_H,
            tiles: save.tiles,
            surfaces: computeSurfaces(save.tiles),
          };
          invRef.current = { ...save.inventory };
          bodyRef.current = createBody(save.player.x, save.player.y);
          seedRef.current = save.seed;
          loaded = true;
        }
      } catch {
        /* 読めなければ新規ワールドにする */
      }
    }
    if (!loaded) {
      const seed = (Math.floor(Math.random() * 2 ** 31) + 1) >>> 0;
      const world = generateWorld(seed);
      worldRef.current = world;
      invRef.current = {};
      const spawn = findSpawn(world);
      bodyRef.current = createBody(spawn.x + 0.1, spawn.y + 2 - PLAYER_H);
      seedRef.current = seed;
      dirtyRef.current = true;
    }
    digRef.current = null;
    setSeedShown(seedRef.current);
    setHud({ inv: { ...invRef.current }, depth: 0 });
  };

  const saveNow = () => {
    const world = worldRef.current;
    const body = bodyRef.current;
    if (!world || !body) return;
    try {
      localStorage.setItem(
        SAVE_KEY,
        serializeSave({ seed: world.seed, tiles: world.tiles, inventory: invRef.current, player: { x: body.x, y: body.y } }),
      );
      dirtyRef.current = false;
    } catch {
      /* 保存できなくても遊べる */
    }
  };

  // ---- 初期化とメインループ ----
  useEffect(() => {
    setupWorld(false);
    setTouchUi(window.matchMedia?.("(pointer: coarse)").matches || "ontouchstart" in window);
    let raf = 0;
    let last = performance.now();
    let lastSave = performance.now();

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const world = worldRef.current;
      const body = bodyRef.current;
      if (!world || !body) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      dayRef.current = (dayRef.current + dt / DAY_LENGTH_SEC) % 1;

      const input = {
        left: keysRef.current.left || touchRef.current.left,
        right: keysRef.current.right || touchRef.current.right,
        jump: keysRef.current.jump || touchRef.current.jump,
        fastFall: keysRef.current.fastFall || touchRef.current.fastFall,
      };
      // 物理は2サブステップで安定させる
      stepPlayer(world, body, input, dt / 2);
      stepPlayer(world, body, input, dt / 2);
      if (input.left || input.right) walkPhaseRef.current += dt * 10;
      if (body.y > WORLD_H + 4) {
        const spawn = findSpawn(world);
        body.x = spawn.x + 0.1;
        body.y = spawn.y + 2 - PLAYER_H;
        body.vy = 0;
      }

      // ---- 掘る ----
      const centerX = body.x + PLAYER_W / 2;
      const centerY = body.y + PLAYER_H / 2;
      let target: { x: number; y: number } | null = null;
      if (pointerRef.current.down) {
        target = { x: pointerRef.current.tx, y: pointerRef.current.ty };
      } else if (digKeyRef.current || touchRef.current.dig) {
        // 向き方向のブロック（中央→足元→頭上の順に固体を探す）
        const frontX = body.face > 0 ? Math.floor(body.x + PLAYER_W + 0.2) : Math.floor(body.x - 0.2);
        const rows = [Math.floor(body.y + 0.9), Math.floor(body.y + PLAYER_H - 0.1), Math.floor(body.y + 0.2)];
        for (const ty of rows) {
          if (getTile(world, frontX, ty) !== AIR) {
            target = { x: frontX, y: ty };
            break;
          }
        }
      }
      let dug = false;
      if (target) {
        const id = getTile(world, target.x, target.y);
        const reachable = withinReach(centerX, centerY, target.x, target.y);
        if (id !== AIR && canDigBlock(id) && reachable) {
          if (!digRef.current || digRef.current.x !== target.x || digRef.current.y !== target.y) {
            digRef.current = { x: target.x, y: target.y, progress: 0 };
          }
          digRef.current.progress += dt / hardnessOf(id);
          if (digRef.current.progress >= 1) {
            if (digTile(world, invRef.current, target.x, target.y) !== null) {
              sfxTap();
              dirtyRef.current = true;
              dug = true;
            }
            digRef.current = null;
          }
        } else {
          digRef.current = null;
        }
      } else {
        digRef.current = null;
      }

      // ---- 置く（ポインタを押している間、空セルへ連続設置） ----
      placeCooldownRef.current -= dt;
      if (pointerRef.current.down && !dug && placeCooldownRef.current <= 0) {
        const { tx, ty } = pointerRef.current;
        if (getTile(world, tx, ty) === AIR && withinReach(centerX, centerY, tx, ty)) {
          if (placeTile(world, invRef.current, tx, ty, selectedRef.current, { x: body.x, y: body.y, w: PLAYER_W, h: PLAYER_H })) {
            sfxPlace();
            dirtyRef.current = true;
            placeCooldownRef.current = 0.22;
          }
        }
      }

      draw(now);

      // HUD は 150ms ごとに同期（毎フレーム setState しない）
      if (now - lastHudRef.current >= 150) {
        lastHudRef.current = now;
        const col = Math.max(0, Math.min(WORLD_W - 1, Math.floor(centerX)));
        const depth = Math.max(0, Math.floor(body.y + PLAYER_H) - world.surfaces[col]);
        setHud({ inv: { ...invRef.current }, depth });
      }
      // オートセーブ（変更があったときだけ、4秒間隔）
      if (dirtyRef.current && now - lastSave >= 4000) {
        lastSave = now;
        saveNow();
      }
    };
    raf = requestAnimationFrame(loop);

    const onHide = () => {
      if (document.hidden) saveNow();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onHide);
      saveNow();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- キーボード ----
  useEffect(() => {
    const setKey = (e: KeyboardEvent, down: boolean) => {
      const k = e.key;
      if (k === "ArrowLeft" || k === "a" || k === "A") keysRef.current.left = down;
      else if (k === "ArrowRight" || k === "d" || k === "D") keysRef.current.right = down;
      else if (k === "ArrowDown" || k === "s" || k === "S") keysRef.current.fastFall = down;
      else if (k === " " || k === "ArrowUp" || k === "w" || k === "W") {
        keysRef.current.jump = down;
        e.preventDefault();
      } else if (k === "j" || k === "J") digKeyRef.current = down;
      else if (down && (k === "k" || k === "K")) {
        // K は単発設置（向き方向）なので keydown のたびに処理する
        if (!e.repeat) placeFacing();
      } else if (down && /^[1-8]$/.test(k)) {
        const idx = Number(k) - 1;
        if (HOTBAR_BLOCKS[idx] !== undefined) selectBlock(HOTBAR_BLOCKS[idx]);
      }
    };
    const downH = (e: KeyboardEvent) => setKey(e, true);
    const upH = (e: KeyboardEvent) => setKey(e, false);
    const reset = () => {
      keysRef.current = { left: false, right: false, jump: false, fastFall: false };
      digKeyRef.current = false;
    };
    window.addEventListener("keydown", downH);
    window.addEventListener("keyup", upH);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", downH);
      window.removeEventListener("keyup", upH);
      window.removeEventListener("blur", reset);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 向いている方向の空セルへ選択中ブロックを1つ置く（ボタン／Kキー用）。 */
  const placeFacing = () => {
    const world = worldRef.current;
    const body = bodyRef.current;
    if (!world || !body) return;
    const frontX = body.face > 0 ? Math.floor(body.x + PLAYER_W + 0.2) : Math.floor(body.x - 0.2);
    const centerX = body.x + PLAYER_W / 2;
    const centerY = body.y + PLAYER_H / 2;
    const rows = [Math.floor(body.y + 0.9), Math.floor(body.y + PLAYER_H - 0.1), Math.floor(body.y + 0.2)];
    for (const ty of rows) {
      if (getTile(world, frontX, ty) === AIR && withinReach(centerX, centerY, frontX, ty)) {
        if (placeTile(world, invRef.current, frontX, ty, selectedRef.current, { x: body.x, y: body.y, w: PLAYER_W, h: PLAYER_H })) {
          sfxPlace();
          dirtyRef.current = true;
          setHud({ inv: { ...invRef.current }, depth: hud.depth });
          return;
        }
      }
    }
  };

  // ---- 描画 ----
  const draw = (now: number) => {
    const canvas = canvasRef.current;
    const world = worldRef.current;
    const body = bodyRef.current;
    if (!canvas || !world || !body) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const vw = rect.width;
    const vh = rect.height;
    const tilePx = Math.max(18, Math.floor(vw / 28));
    const viewW = vw / tilePx;
    const viewH = vh / tilePx;

    // カメラ（プレイヤー中心、ワールド端でクランプ）
    const cx = body.x + PLAYER_W / 2;
    const cy = body.y + PLAYER_H / 2;
    let camX = cx - viewW / 2;
    let camY = cy - viewH / 2;
    camX = viewW >= WORLD_W ? (WORLD_W - viewW) / 2 : Math.max(0, Math.min(WORLD_W - viewW, camX));
    camY = viewH >= WORLD_H ? (WORLD_H - viewH) / 2 : Math.max(0, Math.min(WORLD_H - viewH, camY));
    camRef.current = { x: camX, y: camY };

    // 空
    const [sr, sg, sb] = skyColor(dayRef.current);
    ctx.fillStyle = `rgb(${sr},${sg},${sb})`;
    ctx.fillRect(0, 0, vw, vh);

    const x0 = Math.max(0, Math.floor(camX));
    const x1 = Math.min(WORLD_W - 1, Math.ceil(camX + viewW));
    const y0 = Math.max(0, Math.floor(camY));
    const y1 = Math.min(WORLD_H - 1, Math.ceil(camY + viewH));
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const id = getTile(world, tx, ty);
        if (id === AIR) continue;
        const px = (tx - camX) * tilePx;
        const py = (ty - camY) * tilePx;
        drawBlock(ctx, id, tx, ty, px, py, tilePx);
      }
    }

    // 掘り対象の枠とヒビ
    if (pointerRef.current.down || digRef.current) {
      const t = digRef.current ?? (pointerRef.current.down ? { x: pointerRef.current.tx, y: pointerRef.current.ty, progress: 0 } : null);
      if (t && getTile(world, t.x, t.y) !== AIR) {
        const px = (t.x - camX) * tilePx;
        const py = (t.y - camY) * tilePx;
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 1, py + 1, tilePx - 2, tilePx - 2);
        if (t.progress > 0) {
          ctx.strokeStyle = `rgba(20,16,8,${0.35 + t.progress * 0.5})`;
          ctx.lineWidth = 1.6;
          const p = t.progress;
          ctx.beginPath();
          ctx.moveTo(px + tilePx * 0.15, py + tilePx * 0.2);
          ctx.lineTo(px + tilePx * (0.3 + p * 0.3), py + tilePx * 0.5);
          ctx.lineTo(px + tilePx * 0.25, py + tilePx * 0.85);
          ctx.moveTo(px + tilePx * 0.85, py + tilePx * 0.15);
          ctx.lineTo(px + tilePx * (0.7 - p * 0.25), py + tilePx * 0.55);
          ctx.lineTo(px + tilePx * 0.8, py + tilePx * 0.9);
          ctx.stroke();
        }
      }
    }

    // プレイヤー（標準AGOキャラ）
    drawAgo(ctx, (body.x - camX) * tilePx, (body.y - camY) * tilePx, PLAYER_W * tilePx, PLAYER_H * tilePx, body.face, walkPhaseRef.current, body.onGround, now);

    // 夜の暗さ
    const night = nightAmount(dayRef.current);
    if (night > 0.02) {
      ctx.fillStyle = `rgba(6,8,32,${night * 0.42})`;
      ctx.fillRect(0, 0, vw, vh);
    }
  };

  const drawBlock = (ctx: CanvasRenderingContext2D, id: number, tx: number, ty: number, px: number, py: number, s: number) => {
    const def = BLOCKS[id];
    if (!def) return;
    const h = hash2(tx, ty);
    ctx.fillStyle = def.color;
    ctx.fillRect(px, py, s, s);
    // 下半分を少し暗くして立体感を出す
    ctx.fillStyle = def.colorDark;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(px, py + s * 0.62, s, s * 0.38);
    ctx.globalAlpha = 1;
    if (id === 1) {
      // 草: 上面は緑、下は土色
      ctx.fillStyle = def.colorDark;
      ctx.fillRect(px, py + s * 0.34, s, s * 0.66);
      ctx.fillStyle = def.color;
      ctx.fillRect(px, py, s, s * 0.4);
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.fillRect(px + s * (0.15 + h * 0.5), py + s * 0.55, s * 0.16, s * 0.16);
    } else if (id === 3 || id === 7 || id === 8) {
      // 石・鉱石: 斑点。鉱石は色付きの粒を足す
      ctx.fillStyle = "rgba(0,0,0,0.16)";
      ctx.fillRect(px + s * (0.12 + h * 0.4), py + s * 0.2, s * 0.2, s * 0.14);
      ctx.fillRect(px + s * (0.5 + h * 0.25), py + s * 0.62, s * 0.18, s * 0.13);
      if (id === 7) ctx.fillStyle = "#23232a";
      if (id === 8) ctx.fillStyle = "#e07f3f";
      if (id !== 3) {
        ctx.fillRect(px + s * 0.2, py + s * 0.25, s * 0.18, s * 0.18);
        ctx.fillRect(px + s * 0.6, py + s * 0.55, s * 0.18, s * 0.18);
        ctx.fillRect(px + s * (0.35 + h * 0.2), py + s * 0.72, s * 0.14, s * 0.14);
      }
    } else if (id === 4) {
      // 原木: 縦の筋
      ctx.strokeStyle = "rgba(0,0,0,0.28)";
      ctx.lineWidth = Math.max(1, s * 0.07);
      ctx.beginPath();
      ctx.moveTo(px + s * 0.33, py);
      ctx.lineTo(px + s * 0.33, py + s);
      ctx.moveTo(px + s * 0.68, py);
      ctx.lineTo(px + s * 0.68, py + s);
      ctx.stroke();
    } else if (id === 5) {
      // 葉: 濃淡の点々
      ctx.fillStyle = "rgba(0,0,0,0.2)";
      ctx.fillRect(px + s * (0.1 + h * 0.45), py + s * 0.25, s * 0.2, s * 0.18);
      ctx.fillRect(px + s * (0.45 + h * 0.3), py + s * 0.6, s * 0.2, s * 0.18);
      ctx.fillStyle = "rgba(255,255,255,0.16)";
      ctx.fillRect(px + s * 0.55, py + s * 0.15, s * 0.16, s * 0.14);
    } else if (id === 9) {
      // 岩盤: 暗色に斜めの割れ
      ctx.strokeStyle = "rgba(255,255,255,0.13)";
      ctx.lineWidth = Math.max(1, s * 0.08);
      ctx.beginPath();
      ctx.moveTo(px + s * (0.1 + h * 0.3), py + s);
      ctx.lineTo(px + s * (0.5 + h * 0.3), py);
      ctx.stroke();
    } else {
      // 土・砂: 小さな斑点
      ctx.fillStyle = "rgba(0,0,0,0.15)";
      ctx.fillRect(px + s * (0.2 + h * 0.45), py + s * 0.3, s * 0.15, s * 0.12);
      ctx.fillRect(px + s * (0.55 + h * 0.2), py + s * 0.65, s * 0.13, s * 0.11);
    }
  };

  /** 標準AGOキャラ（nomal.png の白い丸体＋黒目＋水色の影）を平たく描く。 */
  const drawAgo = (
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    w: number,
    h: number,
    face: 1 | -1,
    walkPhase: number,
    onGround: boolean,
    now: number,
  ) => {
    const moving = Math.abs(Math.sin(walkPhase)) > 0.15 && onGround;
    const bob = onGround && moving ? Math.abs(Math.sin(walkPhase)) * h * 0.03 : Math.sin(now / 380) * h * 0.012;
    const y = py - bob;
    const cxp = px + w / 2;
    ctx.save();
    ctx.translate(cxp, y);
    ctx.scale(face, 1);
    // 足（後ろ下の小さい丸）
    ctx.beginPath();
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#14161c";
    ctx.lineWidth = Math.max(1.6, w * 0.09);
    const footSwing = moving ? Math.sin(walkPhase) * w * 0.14 : 0;
    ctx.arc(-w * 0.28 + footSwing, h * 0.94, w * 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // 体（大きな丸い頭身）
    ctx.beginPath();
    const bx = -w * 0.52;
    const by = h * 0.04;
    const bw = w * 1.04;
    const bh = h * 0.86;
    ctx.roundRect(bx, by, bw, bh, [bw * 0.48, bw * 0.48, bw * 0.42, bw * 0.3]);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.stroke();
    // 首元の水色の影
    ctx.beginPath();
    ctx.fillStyle = "#aebfc6";
    ctx.ellipse(-bw * 0.08, by + bh * 0.88, bw * 0.3, bh * 0.13, -0.25, 0, Math.PI * 2);
    ctx.fill();
    // 口の突起（進行方向へ小さく張り出す）
    ctx.beginPath();
    ctx.roundRect(bw * 0.32, by + bh * 0.34, bw * 0.3, bh * 0.13, bh * 0.06);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.stroke();
    // 目（縦長の黒目2つ）
    ctx.fillStyle = "#14161c";
    for (const ex of [0.02, 0.3]) {
      ctx.beginPath();
      ctx.ellipse(bw * ex, by + bh * 0.34, bw * 0.055, bh * 0.085, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };

  // ---- ポインタ（マウス／タッチ共通: 掘る・置く） ----
  const pointerTile = (e: React.PointerEvent<HTMLCanvasElement>): { tx: number; ty: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const tilePx = Math.max(18, Math.floor(rect.width / 28));
    const tx = Math.floor(camRef.current.x + (e.clientX - rect.left) / tilePx);
    const ty = Math.floor(camRef.current.y + (e.clientY - rect.top) / tilePx);
    return { tx, ty };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const t = pointerTile(e);
    if (!t) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointerRef.current = { down: true, tx: t.tx, ty: t.ty };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointerRef.current.down) return;
    const t = pointerTile(e);
    if (t) {
      pointerRef.current.tx = t.tx;
      pointerRef.current.ty = t.ty;
    }
  };
  const onPointerUp = () => {
    pointerRef.current.down = false;
    digRef.current = null;
  };

  // ---- タッチ用パッド ----
  const holdBtn = (
    label: string,
    onChange: (down: boolean) => void,
    ariaLabel: string,
  ) => (
    <button
      type="button"
      aria-label={ariaLabel}
      onPointerDown={(e) => {
        e.preventDefault();
        onChange(true);
      }}
      onPointerUp={() => onChange(false)}
      onPointerLeave={() => onChange(false)}
      onPointerCancel={() => onChange(false)}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        width: 60, height: 60, borderRadius: 16, border: "1px solid rgba(255,255,255,0.35)",
        background: "rgba(10,14,24,0.5)", color: "#fff", fontSize: 15, fontWeight: 700,
        touchAction: "none", userSelect: "none", WebkitTapHighlightColor: "transparent",
      }}
    >
      {label}
    </button>
  );

  const btn: React.CSSProperties = {
    padding: "8px 12px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.06)", color: "inherit", cursor: "pointer", fontWeight: 700, minHeight: 40, touchAction: "manipulation",
  };

  const selectedName = BLOCKS[selected]?.name ?? "";
  const statusText = `深さ ${hud.depth} m ・ 選択中: ${selectedName}（所持 ${hud.inv[selected] ?? 0}）・ ワールドは自動保存されます`;

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>AGO WORLD BOX</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>AGO WORLD BOX</h1>
        <p className="muted">横スクロールの2Dサンドボックス。地面を掘って素材を集め、ブロックを置いて自分の世界を作ります。</p>
      </div>

      <p className="classic-status" role="status">{statusText}</p>

      <div style={{ position: "relative", maxWidth: 960, margin: "0 auto" }}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
          aria-label="AGO WORLD BOX のワールド。ブロックを押し続けると掘れて、空いた場所を押すと置けます"
          style={{
            width: "100%", height: "min(62vh, 560px)", minHeight: 340, display: "block",
            borderRadius: 16, border: "2px solid rgba(255,255,255,0.15)",
            touchAction: "none", userSelect: "none", WebkitTapHighlightColor: "transparent",
          }}
        />
        {touchUi && (
          <>
            <div style={{ position: "absolute", left: 10, bottom: 10, display: "flex", gap: 8 }}>
              {holdBtn("←", (d) => { touchRef.current.left = d; }, "左へ移動")}
              {holdBtn("↓", (d) => { touchRef.current.fastFall = d; }, "速く落ちる")}
              {holdBtn("→", (d) => { touchRef.current.right = d; }, "右へ移動")}
            </div>
            <div style={{ position: "absolute", right: 10, bottom: 10, display: "flex", gap: 8 }}>
              {holdBtn("掘る", (d) => { touchRef.current.dig = d; }, "向いている方向を掘る")}
              {holdBtn("置く", (d) => { if (d) placeFacing(); }, "向いている方向に置く")}
              {holdBtn("跳", (d) => { touchRef.current.jump = d; }, "ジャンプ")}
            </div>
          </>
        )}
      </div>

      {/* ホットバー */}
      <div role="group" aria-label="ホットバー" style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center", marginTop: 12, maxWidth: 960, marginLeft: "auto", marginRight: "auto" }}>
        {HOTBAR_BLOCKS.map((id, i) => {
          const def = BLOCKS[id];
          const count = hud.inv[id] ?? 0;
          const active = selected === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => selectBlock(id)}
              aria-pressed={active}
              style={{
                width: 74, padding: "7px 4px 6px", borderRadius: 10, cursor: "pointer",
                border: active ? "2px solid #ffd23e" : "1px solid rgba(255,255,255,0.18)",
                background: "rgba(255,255,255,0.05)", color: "inherit", touchAction: "manipulation",
              }}
            >
              <span
                aria-hidden
                style={{
                  display: "block", width: 26, height: 26, margin: "0 auto 4px", borderRadius: 5,
                  border: "1px solid rgba(0,0,0,0.35)",
                  background: id === 1 ? "linear-gradient(#57a639 0 40%, #8a5a2b 40% 100%)" : def.color,
                }}
              />
              <span style={{ display: "block", fontSize: 11, fontWeight: 700, lineHeight: 1.25 }}>{def.name}</span>
              <span style={{ display: "block", fontSize: 11, opacity: 0.85 }}>{count} 個 ・ {i + 1}</span>
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 14, flexWrap: "wrap" }}>
        <span className="muted" style={{ fontSize: 13, alignSelf: "center" }}>シード: {seedShown}</span>
        {!confirmNew ? (
          <button type="button" style={btn} onClick={() => setConfirmNew(true)}>新しいワールド</button>
        ) : (
          <>
            <button
              type="button"
              style={{ ...btn, background: "#c0392b", borderColor: "#c0392b", color: "#fff" }}
              onClick={() => {
                setConfirmNew(false);
                try { localStorage.removeItem(SAVE_KEY); } catch { /* noop */ }
                setupWorld(true);
                saveNow();
              }}
            >
              本当に作り直す（今のワールドは消えます）
            </button>
            <button type="button" style={btn} onClick={() => setConfirmNew(false)}>やめる</button>
          </>
        )}
      </div>

      <p className="muted" style={{ textAlign: "center", fontSize: 13, maxWidth: 860, margin: "14px auto 0" }}>
        PC: A/D・←/→で移動、Space/W/↑でジャンプ、S/↓で速く落下。ブロックをマウスで押し続けると掘れて、
        空いた場所を押すと選択中のブロックを置きます（届く範囲は約4マス）。J長押しでも掘れて、Kで前に置けます。
        数字キー1〜8とホットバーのクリックで置くブロックを切り替えます。
        スマホ・タブレットでは左下パッドと右下ボタンでも操作できます。岩盤だけは掘れません。
      </p>
    </>
  );
}
