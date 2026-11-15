"use client";
// AGO WORLD BOX（横スクロール2Dサンドボックス）v2。
// v1 の基底（生成・歩行・掘る/置く・保存）に、夜の敵と体力、道具と
// クラフト/精錬、崩落、5枠インベントリ、オンラインセーブを足した版。
// ゲームループと描画は canvas + refs で回し、React state は HUD 表示だけに使う。
// 純粋ロジックは lib/worldbox/ に分離（生成・物理・在庫・敵・体力・工作・崩落・保存）。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AIR, BEDROCK, BLOCKS, COAL_ORE, COPPER_ORE, DIRT, GRASS, LEAVES, SAND, STONE, WOOD, canDigBlock, dropOf } from "@/lib/worldbox/blocks";
import { generateWorld, getTile, findSpawn, WORLD_H, WORLD_W, type World } from "@/lib/worldbox/worldgen";
import { createBody, stepPlayer, PLAYER_H, PLAYER_W, type PlayerBody } from "@/lib/worldbox/physics";
import { digTile, placeTile, withinReach } from "@/lib/worldbox/rules";
import { SLOT_COUNT, addItem, canAdd, cloneInventory, countOf, createInventory, isInventoryFull, type InventoryV2, type InvSlot } from "@/lib/worldbox/inventory";
import { attackDamageOf, canDigWith, digSecondsFor, isTool, itemDef, requiredTier, tierOfTool, COPPER_INGOT, COPPER_PICKAXE, DEEP_STONE_Y, STONE_PICKAXE, SWORD, WOODEN_PICKAXE } from "@/lib/worldbox/items";
import { advancePhase, isNightPhase, nightAmount } from "@/lib/worldbox/daynight";
import { CONTACT_DAMAGE, ENEMY_H, ENEMY_MAX_HP, ENEMY_W, SPAWN_INTERVAL_SEC, attackEnemy, burnEnemiesAtDawn, enemyTouches, rollsHeartDrop, stepEnemy, trySpawnEnemy, type Enemy } from "@/lib/worldbox/enemies";
import { HEART_HEAL, createPickup, pickupTouches, stepPickup, type Pickup } from "@/lib/worldbox/pickups";
import { PLAYER_MAX_HP, createHealth, damagePlayer, deathDrops, fallDamageFor, healPlayer, isDead, type HealthState } from "@/lib/worldbox/health";
import { RECIPES, SMELT_SECONDS, applyCraft, canStartSmelt, checkCraft, collectSmelt, createFurnace, startSmelt, tickFurnace, type Furnace } from "@/lib/worldbox/craft";
import { FALL_BLOCK_DAMAGE, settleAfterChange, stepFalling, type FallingBlock } from "@/lib/worldbox/collapse";
import { parseSave, serializeSave, type WorldBoxState } from "@/lib/worldbox/save";
import { chooseInitialSave } from "@/lib/worldbox/save-source";
import { TEXTURE_DATA, loadTextures } from "@/lib/worldbox/textures";
import { sfxPlace, sfxTap } from "@/lib/sfx";
import { useGamesNav } from "../GamesShell";

const SAVE_KEY = "ago-worldbox-save-v1";
const JOY_RADIUS = 52;

/** ブロックID → テクスチャキー（lib/worldbox/textures.ts の用意済み素材）。 */
const TEXTURE_KEY_BY_BLOCK: Record<number, string> = {
  [GRASS]: "grass",
  [DIRT]: "dirt",
  [STONE]: "stone",
  [WOOD]: "wood",
  [LEAVES]: "leaves",
  [SAND]: "sand",
  [COAL_ORE]: "coal",
  [COPPER_ORE]: "copper",
  [BEDROCK]: "bedrock",
};

/** 画像が描画可能（読み込み完了）かどうか。 */
function texReady(img: HTMLImageElement | undefined): img is HTMLImageElement {
  return !!img && img.complete && img.naturalWidth > 0;
}
const TIER_TOOL_NAME: Record<number, string> = { 1: "木のツルハシ", 2: "石のツルハシ", 3: "銅のツルハシ" };

type Hud = {
  slots: InvSlot[];
  hp: number;
  depth: number;
  night: boolean;
  gate: string | null;
  full: boolean;
  furnace: { remaining: number | null; output: number };
};

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

const HEART_PATH = "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z";

/** ハート（描画アイコン。絵文字は使わない）。fill は 0 / 0.5 / 1。 */
function HeartIcon({ fill }: { fill: number }) {
  return (
    <span style={{ position: "relative", width: 22, height: 22, display: "inline-block", flex: "0 0 auto" }} aria-hidden>
      <svg viewBox="0 0 24 24" width="22" height="22" style={{ display: "block" }}>
        <path d={HEART_PATH} fill="rgba(20,22,28,0.55)" stroke="rgba(255,255,255,0.5)" strokeWidth="1" />
      </svg>
      {fill > 0 && (
        <span style={{ position: "absolute", left: 0, top: 0, width: `${fill * 100}%`, height: 22, overflow: "hidden" }}>
          <svg viewBox="0 0 24 24" width="22" height="22" style={{ display: "block" }}>
            <path d={HEART_PATH} fill="#e5484d" />
          </svg>
        </span>
      )}
    </span>
  );
}

/** アイテムの小アイコン（道具とインゴットは SVG、それ以外は色スウォッチ）。 */
function ItemIcon({ id, size = 26 }: { id: number; size?: number }) {
  const idef = itemDef(id);
  if (id === WOODEN_PICKAXE || id === STONE_PICKAXE || id === COPPER_PICKAXE) {
    const head = id === WOODEN_PICKAXE ? "#a9743f" : id === STONE_PICKAXE ? "#9a9aa0" : "#e07f3f";
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden style={{ display: "block", margin: "0 auto" }}>
        <path d="M5 19 L13.5 10.5" stroke="#7a5230" strokeWidth="2.6" strokeLinecap="round" />
        <path d="M4.5 7.5 Q12 2.5 20 6.5" stroke={head} strokeWidth="2.8" fill="none" strokeLinecap="round" />
      </svg>
    );
  }
  if (idef && id === SWORD) {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden style={{ display: "block", margin: "0 auto" }}>
        <path d="M6 18 L15.5 8.5" stroke="#e8e8ec" strokeWidth="2.6" strokeLinecap="round" />
        <path d="M14 5 L19.5 4 L19 9.5 Z" fill="#e8e8ec" />
        <path d="M8.5 13.5 L12 17" stroke="#e07f3f" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M5.5 18.5 L8 21" stroke="#7a5230" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (idef && id === COPPER_INGOT) {
    // 銅インゴット
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden style={{ display: "block", margin: "0 auto" }}>
        <path d="M7 9 L17 9 L19.5 16 L4.5 16 Z" fill="#e07f3f" stroke="#b35a24" strokeWidth="1.2" />
        <path d="M7.5 12.5 L16.5 12.5" stroke="#b35a24" strokeWidth="1" opacity="0.6" />
      </svg>
    );
  }
  const texKey = TEXTURE_KEY_BY_BLOCK[id];
  if (texKey && TEXTURE_DATA[texKey]) {
    return (
      <img
        src={TEXTURE_DATA[texKey]}
        alt=""
        aria-hidden
        style={{ display: "block", width: size, height: size, margin: "0 auto", borderRadius: 5, border: "1px solid rgba(0,0,0,0.35)" }}
      />
    );
  }
  const def = BLOCKS[id];
  return (
    <span
      aria-hidden
      style={{
        display: "block", width: size, height: size, margin: "0 auto", borderRadius: 5,
        border: "1px solid rgba(0,0,0,0.35)",
        background: def?.color ?? "#888",
      }}
    />
  );
}

function itemName(id: number): string {
  return itemDef(id)?.name ?? BLOCKS[id]?.name ?? "";
}

export default function WorldBoxClient() {
  const { prefix } = useGamesNav();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const worldRef = useRef<World | null>(null);
  const bodyRef = useRef<PlayerBody | null>(null);
  const invRef = useRef<InventoryV2>(createInventory());
  const healthRef = useRef<HealthState>(createHealth());
  const enemiesRef = useRef<Enemy[]>([]);
  const pickupsRef = useRef<Pickup[]>([]);
  const fallingRef = useRef<FallingBlock[]>([]);
  const furnaceRef = useRef<Furnace>(createFurnace());
  const poofsRef = useRef<{ x: number; y: number; at: number }[]>([]);
  const texturesRef = useRef<Record<string, HTMLImageElement> | null>(null);
  const charImgRef = useRef<{ ago: HTMLImageElement; jinrou: HTMLImageElement } | null>(null);
  const enemyHitRef = useRef(new Map<number, number>());
  const selectedRef = useRef(0);
  const keysRef = useRef({ left: false, right: false, jump: false, fastFall: false });
  const touchRef = useRef({ jump: false, dig: false });
  const digKeyRef = useRef(false);
  const pointerRef = useRef<{ down: boolean; pointerId: number; tx: number; ty: number }>({ down: false, pointerId: -1, tx: -1, ty: -1 });
  const joyRef = useRef<{ active: boolean; pointerId: number; ox: number; oy: number; dx: number; dy: number }>({
    active: false, pointerId: -1, ox: 0, oy: 0, dx: 0, dy: 0,
  });
  const digRef = useRef<{ x: number; y: number; progress: number } | null>(null);
  const gatedRef = useRef<string | null>(null);
  const attackCdRef = useRef(0);
  const spawnTimerRef = useRef(0);
  const placeCooldownRef = useRef(0);
  const camRef = useRef({ x: 0, y: 0 });
  const dayRef = useRef(0.3); // 昼から始める
  const gameTimeRef = useRef(0);
  const walkPhaseRef = useRef(0);
  const dirtyRef = useRef(false);
  const lastHudRef = useRef(0);
  const seedRef = useRef(0);
  const onlineRef = useRef<{ enabled: boolean; lastPutAt: number }>({ enabled: false, lastPutAt: 0 });

  const [hud, setHud] = useState<Hud>({
    slots: createInventory().slots, hp: PLAYER_MAX_HP, depth: 0, night: false, gate: null, full: false,
    furnace: { remaining: null, output: 0 },
  });
  const [selected, setSelected] = useState(0);
  const [touchUi, setTouchUi] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const [seedShown, setSeedShown] = useState(0);
  const [craftOpen, setCraftOpen] = useState(false);
  const [deathFlash, setDeathFlash] = useState(false);
  const [onlineMode, setOnlineMode] = useState(false);

  const selectSlot = (i: number) => {
    selectedRef.current = i;
    setSelected(i);
  };

  /** 選択中スロットの道具 ID（道具でなければ null = 素手）。 */
  const activeToolId = (): number | null => {
    const slot = invRef.current.slots[selectedRef.current];
    return slot && isTool(slot.id) ? slot.id : null;
  };

  const buildHud = (): Hud => {
    const world = worldRef.current;
    const body = bodyRef.current;
    let depth = 0;
    if (world && body) {
      const col = Math.max(0, Math.min(WORLD_W - 1, Math.floor(body.x + PLAYER_W / 2)));
      depth = Math.max(0, Math.floor(body.y + PLAYER_H) - world.surfaces[col]);
    }
    return {
      slots: cloneInventory(invRef.current).slots,
      hp: healthRef.current.hp,
      depth,
      night: isNightPhase(dayRef.current),
      gate: gatedRef.current,
      full: isInventoryFull(invRef.current),
      furnace: {
        remaining: furnaceRef.current.smelting ? furnaceRef.current.smelting.remaining : null,
        output: furnaceRef.current.output,
      },
    };
  };

  const syncHud = () => setHud(buildHud());

  /** 状態（セーブ or 新規）を各 ref へ反映する。 */
  const applyState = (state: WorldBoxState | null) => {
    enemiesRef.current = [];
    pickupsRef.current = [];
    fallingRef.current = [];
    furnaceRef.current = createFurnace();
    healthRef.current = createHealth();
    digRef.current = null;
    gatedRef.current = null;
    if (state) {
      worldRef.current = {
        seed: state.seed,
        width: WORLD_W,
        height: WORLD_H,
        tiles: state.tiles,
        surfaces: computeSurfaces(state.tiles),
      };
      invRef.current = cloneInventory(state.inventory);
      bodyRef.current = createBody(state.player.x, state.player.y);
      healthRef.current.hp = state.hp;
      dayRef.current = state.dayPhase;
      seedRef.current = state.seed;
    } else {
      const seed = (Math.floor(Math.random() * 2 ** 31) + 1) >>> 0;
      const world = generateWorld(seed);
      worldRef.current = world;
      invRef.current = createInventory();
      const spawn = findSpawn(world);
      bodyRef.current = createBody(spawn.x + 0.1, spawn.y + 2 - PLAYER_H);
      dayRef.current = 0.3;
      seedRef.current = seed;
      dirtyRef.current = true;
    }
    setSeedShown(seedRef.current);
    syncHud();
  };

  const currentSaveJson = (): string | null => {
    const world = worldRef.current;
    const body = bodyRef.current;
    if (!world || !body) return null;
    return serializeSave({
      seed: world.seed,
      tiles: world.tiles,
      inventory: invRef.current,
      player: { x: body.x, y: body.y },
      hp: healthRef.current.hp,
      dayPhase: dayRef.current,
    });
  };

  const saveNow = () => {
    const json = currentSaveJson();
    if (!json) return;
    try {
      localStorage.setItem(SAVE_KEY, json);
      dirtyRef.current = false;
    } catch {
      /* 保存できなくても遊べる */
    }
  };

  /** サーバーへ保存する（失敗してもゲームは止めない。ローカルが正の保険）。 */
  const putOnlineSave = (keepalive = false) => {
    if (!onlineRef.current.enabled) return;
    const json = currentSaveJson();
    if (!json) return;
    onlineRef.current.lastPutAt = performance.now();
    fetch("/api/worldbox/save", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ save: json }),
      keepalive,
    })
      .then((res) => {
        if (res.status === 401) {
          onlineRef.current.enabled = false;
          setOnlineMode(false);
        }
      })
      .catch(() => {
        /* 次の自動保存で再試行する */
      });
  };

  /** 敵を倒したときの処理（消滅・煙・ハートドロップ）。 */
  const killEnemy = (e: Enemy, now: number) => {
    enemiesRef.current = enemiesRef.current.filter((o) => o.id !== e.id);
    poofsRef.current.push({ x: e.x, y: e.y, at: now });
    if (rollsHeartDrop(Math.random)) {
      pickupsRef.current.push(createPickup("heart", 0, 1, e.x + 0.2, e.y));
    }
  };

  /** 死亡処理: 所持ブロックの一部を落とし、スポーンへ戻る（ワールドは残る）。 */
  const handleDeath = () => {
    const world = worldRef.current;
    const body = bodyRef.current;
    if (!world || !body) return;
    for (const drop of deathDrops(invRef.current)) {
      pickupsRef.current.push(createPickup("block", drop.blockId, drop.count, body.x + PLAYER_W / 2 - 0.25, body.y));
    }
    const spawn = findSpawn(world);
    body.x = spawn.x + 0.1;
    body.y = spawn.y + 2 - PLAYER_H;
    body.vx = 0;
    body.vy = 0;
    body.kx = 0;
    enemiesRef.current = [];
    healthRef.current.hp = PLAYER_MAX_HP;
    healthRef.current.invulnUntil = gameTimeRef.current + 2;
    dirtyRef.current = true;
    setDeathFlash(true);
    window.setTimeout(() => setDeathFlash(false), 1400);
    syncHud();
  };

  // ---- 初期化（オンライン優先で解決してからループ開始）とメインループ ----
  useEffect(() => {
    setTouchUi(window.matchMedia?.("(pointer: coarse)").matches || "ontouchstart" in window);
    let raf = 0;
    let cancelled = false;
    let last = performance.now();
    let lastSave = performance.now();

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const world = worldRef.current;
      const body = bodyRef.current;
      if (!world || !body) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      gameTimeRef.current += dt;
      const gt = gameTimeRef.current;
      dayRef.current = advancePhase(dayRef.current, dt);
      const night = isNightPhase(dayRef.current);

      // ---- 入力（キーボード or ジョイスティック） ----
      const joy = joyRef.current;
      let moveX: number | undefined;
      let stickFastFall = false;
      if (joy.active) {
        moveX = Math.max(-1, Math.min(1, joy.dx / JOY_RADIUS));
        stickFastFall = joy.dy / JOY_RADIUS > 0.55;
      }
      const input = {
        left: keysRef.current.left,
        right: keysRef.current.right,
        jump: keysRef.current.jump || touchRef.current.jump,
        fastFall: keysRef.current.fastFall || stickFastFall,
        moveX,
      };
      // 物理は2サブステップで安定させる。落下ダメージはサブステップごとに拾う
      for (let s = 0; s < 2; s++) {
        stepPlayer(world, body, input, dt / 2);
        if (body.landedFall > 0) {
          const dmg = fallDamageFor(body.landedFall);
          if (dmg > 0 && damagePlayer(healthRef.current, dmg, gt)) syncHud();
        }
      }
      if (input.left || input.right || (moveX !== undefined && Math.abs(moveX) > 0.2)) walkPhaseRef.current += dt * 10;
      if (body.y > WORLD_H + 4) {
        const spawn = findSpawn(world);
        body.x = spawn.x + 0.1;
        body.y = spawn.y + 2 - PLAYER_H;
        body.vy = 0;
      }

      const centerX = body.x + PLAYER_W / 2;
      const centerY = body.y + PLAYER_H / 2;
      const toolId = activeToolId();
      const tier = tierOfTool(toolId);
      attackCdRef.current -= dt;
      placeCooldownRef.current -= dt;

      // ---- 敵: 出現・移動・燃焼・接触 ----
      spawnTimerRef.current -= dt;
      if (night && spawnTimerRef.current <= 0) {
        spawnTimerRef.current = SPAWN_INTERVAL_SEC;
        const spawned = trySpawnEnemy(world, dayRef.current, { x: body.x, y: body.y }, enemiesRef.current.length, Math.random);
        if (spawned) enemiesRef.current.push(spawned);
      }
      const burned = burnEnemiesAtDawn(enemiesRef.current, dayRef.current, dt);
      if (burned.length > 0) {
        for (const id of burned) {
          const e = enemiesRef.current.find((o) => o.id === id);
          if (e) poofsRef.current.push({ x: e.x, y: e.y, at: now });
        }
        enemiesRef.current = enemiesRef.current.filter((e) => !burned.includes(e.id));
      }
      const playerRect = { x: body.x, y: body.y, w: PLAYER_W, h: PLAYER_H };
      for (const e of [...enemiesRef.current]) {
        stepEnemy(world, e, centerX, dt);
        if (enemyTouches(e, playerRect)) {
          if (damagePlayer(healthRef.current, CONTACT_DAMAGE, gt)) {
            body.kx = (centerX < e.x + 0.45 ? -1 : 1) * 7;
            body.vy = Math.min(body.vy, -5.5);
            syncHud();
          }
        }
      }

      // ---- 攻撃（ポインタが敵の上 or 掘るボタンで正面の敵） ----
      const tryAttack = (e: Enemy): boolean => {
        if (attackCdRef.current > 0) return true; // 攻撃扱いで掘りに行かない
        attackCdRef.current = 0.35;
        const dead = attackEnemy(e, attackDamageOf(toolId), centerX);
        enemyHitRef.current.set(e.id, now);
        sfxTap();
        if (dead) killEnemy(e, now);
        return true;
      };
      let attacked = false;
      if (pointerRef.current.down) {
        const pt = { x: pointerRef.current.tx + 0.5, y: pointerRef.current.ty + 0.5 };
        const e = enemiesRef.current.find((o) => pt.x >= o.x - 0.2 && pt.x <= o.x + 1.1 && pt.y >= o.y - 0.2 && pt.y <= o.y + 1.1);
        if (e) attacked = tryAttack(e);
      }
      if (!attacked && (digKeyRef.current || touchRef.current.dig)) {
        const e = enemiesRef.current.find(
          (o) => Math.abs(o.x + 0.45 - centerX) < 2.1 && Math.abs(o.y + 0.45 - centerY) < 1.6 && (o.x + 0.45 - centerX) * body.face >= -0.4,
        );
        if (e) attacked = tryAttack(e);
      }

      // ---- 掘る ----
      let target: { x: number; y: number } | null = null;
      if (!attacked) {
        if (pointerRef.current.down) {
          target = { x: pointerRef.current.tx, y: pointerRef.current.ty };
        } else if (digKeyRef.current || touchRef.current.dig) {
          const frontX = body.face > 0 ? Math.floor(body.x + PLAYER_W + 0.2) : Math.floor(body.x - 0.2);
          const rows = [Math.floor(body.y + 0.9), Math.floor(body.y + PLAYER_H - 0.1), Math.floor(body.y + 0.2)];
          for (const ty of rows) {
            if (getTile(world, frontX, ty) !== AIR) {
              target = { x: frontX, y: ty };
              break;
            }
          }
        }
      }
      let dug = false;
      gatedRef.current = null;
      if (target) {
        const id = getTile(world, target.x, target.y);
        const reachable = withinReach(centerX, centerY, target.x, target.y);
        if (id !== AIR && canDigBlock(id) && reachable) {
          if (!canDigWith(id, target.y, tier)) {
            // 道具の段階が足りない（本当のゲート: 進捗は一切進まない）
            gatedRef.current = `${BLOCKS[id]?.name ?? "ブロック"}には${TIER_TOOL_NAME[requiredTier(id, target.y)] ?? "道具"}が必要`;
            digRef.current = null;
          } else if (!canAdd(invRef.current, dropOf(id), 1)) {
            gatedRef.current = "持ち物がいっぱいで掘れない";
            digRef.current = null;
          } else {
            if (!digRef.current || digRef.current.x !== target.x || digRef.current.y !== target.y) {
              digRef.current = { x: target.x, y: target.y, progress: 0 };
            }
            digRef.current.progress += dt / digSecondsFor(id, target.y, toolId);
            if (digRef.current.progress >= 1) {
              if (digTile(world, invRef.current, target.x, target.y) !== null) {
                sfxTap();
                dirtyRef.current = true;
                dug = true;
                // 支えを失った緩いブロックが崩落する
                fallingRef.current.push(...settleAfterChange(world, target.x, target.y));
              }
              digRef.current = null;
            }
          }
        } else {
          digRef.current = null;
        }
      } else {
        digRef.current = null;
      }

      // ---- 置く（ポインタを押している間、空セルへ連続設置） ----
      if (pointerRef.current.down && !dug && !attacked && placeCooldownRef.current <= 0) {
        const { tx, ty } = pointerRef.current;
        const slot = invRef.current.slots[selectedRef.current];
        if (slot && BLOCKS[slot.id]?.placeable && getTile(world, tx, ty) === AIR && withinReach(centerX, centerY, tx, ty)) {
          if (placeTile(world, invRef.current, tx, ty, slot.id, playerRect)) {
            sfxPlace();
            dirtyRef.current = true;
            placeCooldownRef.current = 0.22;
            fallingRef.current.push(...settleAfterChange(world, tx, ty));
          }
        }
      }

      // ---- 崩落（落下ブロックの進行・着地・潰し） ----
      if (fallingRef.current.length > 0) {
        const targets = [
          { key: "player", x: body.x, y: body.y, w: PLAYER_W, h: PLAYER_H },
          ...enemiesRef.current.map((e) => ({ key: `enemy:${e.id}`, x: e.x, y: e.y, w: ENEMY_W, h: ENEMY_H })),
        ];
        const events = stepFalling(world, fallingRef.current, dt, targets);
        if (events.landed.length > 0) dirtyRef.current = true;
        for (const crush of events.crushed) {
          if (crush.targetKey === "player") {
            if (damagePlayer(healthRef.current, FALL_BLOCK_DAMAGE, gt)) syncHud();
          } else {
            const id = Number(crush.targetKey.slice("enemy:".length));
            const e = enemiesRef.current.find((o) => o.id === id);
            if (e && attackEnemy(e, FALL_BLOCK_DAMAGE, crush.block.x + 0.5)) killEnemy(e, now);
          }
        }
      }

      // ---- 拾い物 ----
      for (const p of [...pickupsRef.current]) {
        stepPickup(world, p, dt);
        if (!pickupTouches(p, playerRect)) continue;
        if (p.kind === "heart") {
          if (healPlayer(healthRef.current, HEART_HEAL) > 0) {
            pickupsRef.current = pickupsRef.current.filter((o) => o.id !== p.id);
            syncHud();
          }
        } else {
          const added = addItem(invRef.current, p.blockId, p.count);
          if (added >= p.count) {
            pickupsRef.current = pickupsRef.current.filter((o) => o.id !== p.id);
            dirtyRef.current = true;
          } else if (added > 0) {
            p.count -= added;
            dirtyRef.current = true;
          }
        }
      }

      // ---- かまど ----
      tickFurnace(furnaceRef.current, dt);

      // ---- 死亡 ----
      if (isDead(healthRef.current)) handleDeath();

      draw(now);

      // HUD は 150ms ごとに同期（毎フレーム setState しない）
      if (now - lastHudRef.current >= 150) {
        lastHudRef.current = now;
        syncHud();
      }
      // ローカル自動保存（変更があったときだけ、4秒間隔）
      if (dirtyRef.current && now - lastSave >= 4000) {
        lastSave = now;
        saveNow();
      }
      // サーバー保存はデバウンス（変更が続いても最大で8秒に1回まで）
      if (onlineRef.current.enabled && dirtyRef.current && now - onlineRef.current.lastPutAt >= 8000) {
        putOnlineSave();
      }
    };

    const init = async () => {
      let local: WorldBoxState | null = null;
      try {
        local = parseSave(localStorage.getItem(SAVE_KEY));
      } catch {
        local = null;
      }
      let online: WorldBoxState | null = null;
      let loggedIn = false;
      try {
        const res = await fetch("/api/worldbox/save", {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(3500),
        });
        if (res.ok) {
          loggedIn = true;
          const data = (await res.json()) as { save?: unknown };
          if (typeof data.save === "string") online = parseSave(data.save);
        }
      } catch {
        /* オフライン等ではローカルで続ける */
      }
      if (cancelled) return;
      const choice = chooseInitialSave(online, local, loggedIn);
      applyState(choice.state);
      onlineRef.current.enabled = loggedIn;
      setOnlineMode(loggedIn);
      if (choice.pushLocalToOnline) {
        // ローカルしか無かった場合はオンラインへ移行保存する
        putOnlineSave();
      }
      last = performance.now();
      raf = requestAnimationFrame(loop);
    };
    void init();

    const onHide = () => {
      if (document.hidden) {
        saveNow();
        putOnlineSave(true);
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onHide);
      saveNow();
      putOnlineSave(true);
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
        if (!e.repeat) placeFacing();
      } else if (down && (k === "c" || k === "C")) {
        if (!e.repeat) setCraftOpen((v) => !v);
      } else if (down && k === "Escape") {
        setCraftOpen(false);
      } else if (down && /^[1-5]$/.test(k)) {
        selectSlot(Number(k) - 1);
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

  /** 向いている方向の空セルへ選択中スロットのブロックを1つ置く（ボタン／Kキー用）。 */
  const placeFacing = () => {
    const world = worldRef.current;
    const body = bodyRef.current;
    if (!world || !body) return;
    const slot = invRef.current.slots[selectedRef.current];
    if (!slot || !BLOCKS[slot.id]?.placeable) return;
    const frontX = body.face > 0 ? Math.floor(body.x + PLAYER_W + 0.2) : Math.floor(body.x - 0.2);
    const centerX = body.x + PLAYER_W / 2;
    const centerY = body.y + PLAYER_H / 2;
    const rows = [Math.floor(body.y + 0.9), Math.floor(body.y + PLAYER_H - 0.1), Math.floor(body.y + 0.2)];
    for (const ty of rows) {
      if (getTile(world, frontX, ty) === AIR && withinReach(centerX, centerY, frontX, ty)) {
        if (placeTile(world, invRef.current, frontX, ty, slot.id, { x: body.x, y: body.y, w: PLAYER_W, h: PLAYER_H })) {
          sfxPlace();
          dirtyRef.current = true;
          fallingRef.current.push(...settleAfterChange(world, frontX, ty));
          syncHud();
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

    // 素材は初回描画で一度だけ読み込む（タイルテクスチャ＋公式キャラ画像）
    if (!texturesRef.current) texturesRef.current = loadTextures();
    if (!charImgRef.current) {
      const ago = new Image();
      ago.src = "/img/nomal.png";
      const jinrou = new Image();
      jinrou.src = "/img/jinrou.png";
      charImgRef.current = { ago, jinrou };
    }

    // 空
    const [sr, sg, sb] = skyColor(dayRef.current);
    ctx.fillStyle = `rgb(${sr},${sg},${sb})`;
    ctx.fillRect(0, 0, vw, vh);

    // 遠景の丘（パララックス）
    drawHills(ctx, camX, camY, vw, vh, tilePx);

    const x0 = Math.max(0, Math.floor(camX));
    const x1 = Math.min(WORLD_W - 1, Math.ceil(camX + viewW));
    const y0 = Math.max(0, Math.floor(camY));
    const y1 = Math.min(WORLD_H - 1, Math.ceil(camY + viewH));
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const id = getTile(world, tx, ty);
        if (id === AIR) continue;
        drawBlock(ctx, id, tx, ty, (tx - camX) * tilePx, (ty - camY) * tilePx, tilePx);
      }
    }

    // 落下中のブロック
    for (const f of fallingRef.current) {
      drawBlock(ctx, f.blockId, f.x, Math.floor(f.y), (f.x - camX) * tilePx, (f.y - camY) * tilePx, tilePx);
    }

    // 拾い物
    for (const p of pickupsRef.current) {
      const px = (p.x - camX) * tilePx;
      const py = (p.y - camY) * tilePx + Math.sin(now / 300 + p.id) * tilePx * 0.05;
      const s = tilePx * 0.5;
      if (p.kind === "heart") {
        ctx.save();
        ctx.translate(px, py);
        ctx.scale(s / 24, s / 24);
        ctx.beginPath();
        ctx.moveTo(12, 21.35);
        ctx.bezierCurveTo(10.55, 20.03, 2, 12.28, 2, 8.5);
        ctx.bezierCurveTo(2, 5.42, 4.42, 3, 7.5, 3);
        ctx.bezierCurveTo(9.24, 3, 10.91, 3.81, 12, 5.09);
        ctx.bezierCurveTo(13.09, 3.81, 14.76, 3, 16.5, 3);
        ctx.bezierCurveTo(19.58, 3, 22, 5.42, 22, 8.5);
        ctx.bezierCurveTo(22, 12.28, 13.45, 20.03, 12, 21.35);
        ctx.fillStyle = "#e5484d";
        ctx.fill();
        ctx.strokeStyle = "rgba(24,10,14,0.85)";
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.restore();
      } else {
        drawBlock(ctx, p.blockId, Math.floor(p.x), Math.floor(p.y), px, py, s);
        if (p.count > 1) {
          ctx.fillStyle = "#fff";
          ctx.font = `700 ${Math.max(10, tilePx * 0.34)}px sans-serif`;
          ctx.textAlign = "right";
          ctx.fillText(String(p.count), px + s, py + s);
        }
      }
    }

    // 敵
    for (const e of enemiesRef.current) {
      drawEnemy(ctx, e, (e.x - camX) * tilePx, (e.y - camY) * tilePx, tilePx, now);
    }

    // 消滅の煙
    poofsRef.current = poofsRef.current.filter((p) => now - p.at < 380);
    for (const p of poofsRef.current) {
      const k = (now - p.at) / 380;
      ctx.fillStyle = `rgba(230,230,235,${0.5 * (1 - k)})`;
      for (const [ox, oy, r] of [[0.2, 0.5, 0.28], [0.55, 0.3, 0.36], [0.8, 0.55, 0.24]] as const) {
        ctx.beginPath();
        ctx.arc((p.x + ox - camX) * tilePx, (p.y + oy - camY) * tilePx, tilePx * r * (0.6 + k * 0.9), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 掘り対象の枠とヒビ（ゲート中は赤枠＋バツ）
    if (pointerRef.current.down || digRef.current) {
      const t = digRef.current ?? (pointerRef.current.down ? { x: pointerRef.current.tx, y: pointerRef.current.ty, progress: 0 } : null);
      if (t && getTile(world, t.x, t.y) !== AIR) {
        const px = (t.x - camX) * tilePx;
        const py = (t.y - camY) * tilePx;
        const gated = gatedRef.current !== null;
        ctx.strokeStyle = gated ? "rgba(229,72,77,0.95)" : "rgba(255,255,255,0.85)";
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 1, py + 1, tilePx - 2, tilePx - 2);
        if (gated) {
          ctx.beginPath();
          ctx.moveTo(px + tilePx * 0.25, py + tilePx * 0.25);
          ctx.lineTo(px + tilePx * 0.75, py + tilePx * 0.75);
          ctx.moveTo(px + tilePx * 0.75, py + tilePx * 0.25);
          ctx.lineTo(px + tilePx * 0.25, py + tilePx * 0.75);
          ctx.stroke();
        } else if (t.progress > 0) {
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

    // プレイヤー（標準AGOキャラ）。無敵時間中は点滅させる
    const invuln = gameTimeRef.current < healthRef.current.invulnUntil;
    if (!invuln || Math.floor(now / 90) % 2 === 0) {
      drawPlayer(ctx, (body.x - camX) * tilePx, (body.y - camY) * tilePx, tilePx, body.face, walkPhaseRef.current, body.onGround, now);
    }

    // 夜の暗さ
    const night = nightAmount(dayRef.current);
    if (night > 0.02) {
      ctx.fillStyle = `rgba(6,8,32,${night * 0.42})`;
      ctx.fillRect(0, 0, vw, vh);
    }

    // ジョイスティック（タッチ中だけ表示）
    const joy = joyRef.current;
    if (joy.active) {
      const kx = Math.max(-JOY_RADIUS, Math.min(JOY_RADIUS, joy.dx));
      const ky = Math.max(-JOY_RADIUS, Math.min(JOY_RADIUS, joy.dy));
      ctx.beginPath();
      ctx.arc(joy.ox, joy.oy, JOY_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.13)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(joy.ox + kx * 0.62, joy.oy + ky * 0.62, 24, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.fill();
    }
  };

  const drawEnemy = (ctx: CanvasRenderingContext2D, e: Enemy, px: number, py: number, tilePx: number, now: number) => {
    const w = 0.9 * tilePx;
    const img = charImgRef.current?.jinrou;
    const bob = Math.sin(now / 160 + e.id * 2) * tilePx * 0.03;
    const feetX = px + (ENEMY_W * tilePx) / 2;
    const feetY = py + ENEMY_H * tilePx;
    if (texReady(img)) {
      // 公式の人狼あごむに（/img/jinrou.png）。プレイヤーと同程度の大きさ、足元アンカー、向き反転
      const size = tilePx * 1.5;
      const burning = !isNightPhase(dayRef.current); // 夜明けは燃焼中: 明滅させる
      const hitAgo = now - (enemyHitRef.current.get(e.id) ?? -10000);
      ctx.save();
      ctx.translate(feetX, feetY + bob);
      ctx.scale(e.face, 1);
      if (burning) ctx.globalAlpha = 0.6 + 0.3 * Math.sin(now / 45);
      ctx.drawImage(img, -size / 2, -size, size, size);
      if (hitAgo < 150) {
        // 被弾フラッシュ（白く重ねる）
        ctx.globalAlpha = 0.55;
        ctx.filter = "brightness(3) saturate(0.2)";
        ctx.drawImage(img, -size / 2, -size, size, size);
        ctx.filter = "none";
      }
      ctx.restore();
    } else {
      // 読み込み中だけの無地シルエット（造形は描かない）
      ctx.save();
      ctx.translate(feetX, feetY + bob);
      ctx.beginPath();
      ctx.arc(0, -w * 0.45, w * 0.45, 0, Math.PI * 2);
      ctx.fillStyle = "#3c414d";
      ctx.fill();
      ctx.restore();
    }
    // HP バー（減っているときだけ）
    if (e.hp < ENEMY_MAX_HP) {
      ctx.fillStyle = "rgba(10,10,14,0.65)";
      ctx.fillRect(px, py - tilePx * 0.22, w, tilePx * 0.13);
      ctx.fillStyle = "#7ee787";
      ctx.fillRect(px, py - tilePx * 0.22, (w * e.hp) / ENEMY_MAX_HP, tilePx * 0.13);
    }
  };

  const drawBlock = (ctx: CanvasRenderingContext2D, id: number, tx: number, ty: number, px: number, py: number, s: number) => {
    const def = BLOCKS[id];
    if (!def) return;
    // 用意済みテクスチャ素材で描く（読み込み前/失敗時は下のフラット描画にフォールバック）
    const texKey = TEXTURE_KEY_BY_BLOCK[id];
    const tex = texKey ? texturesRef.current?.[texKey] : undefined;
    if (texReady(tex)) {
      // 既存のシードハッシュで一部のタイルだけ左右反転し、単調さを崩す
      if (hash2(tx, ty) >= 0.5) {
        ctx.save();
        ctx.translate(px + s, py);
        ctx.scale(-1, 1);
        ctx.drawImage(tex, 0, 0, s, s);
        ctx.restore();
      } else {
        ctx.drawImage(tex, px, py, s, s);
      }
      // 深層の石は石テクスチャ＋暗がり
      if (id === STONE && ty >= DEEP_STONE_Y) {
        ctx.fillStyle = "rgba(8,8,20,0.38)";
        ctx.fillRect(px, py, s, s);
      }
      return;
    }
    const h = hash2(tx, ty);
    ctx.fillStyle = def.color;
    ctx.fillRect(px, py, s, s);
    ctx.fillStyle = def.colorDark;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(px, py + s * 0.62, s, s * 0.38);
    ctx.globalAlpha = 1;
    if (id === 1) {
      ctx.fillStyle = def.colorDark;
      ctx.fillRect(px, py + s * 0.34, s, s * 0.66);
      ctx.fillStyle = def.color;
      ctx.fillRect(px, py, s, s * 0.4);
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.fillRect(px + s * (0.15 + h * 0.5), py + s * 0.55, s * 0.16, s * 0.16);
    } else if (id === 3 || id === 7 || id === 8) {
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
      ctx.strokeStyle = "rgba(0,0,0,0.28)";
      ctx.lineWidth = Math.max(1, s * 0.07);
      ctx.beginPath();
      ctx.moveTo(px + s * 0.33, py);
      ctx.lineTo(px + s * 0.33, py + s);
      ctx.moveTo(px + s * 0.68, py);
      ctx.lineTo(px + s * 0.68, py + s);
      ctx.stroke();
    } else if (id === 5) {
      ctx.fillStyle = "rgba(0,0,0,0.2)";
      ctx.fillRect(px + s * (0.1 + h * 0.45), py + s * 0.25, s * 0.2, s * 0.18);
      ctx.fillRect(px + s * (0.45 + h * 0.3), py + s * 0.6, s * 0.2, s * 0.18);
      ctx.fillStyle = "rgba(255,255,255,0.16)";
      ctx.fillRect(px + s * 0.55, py + s * 0.15, s * 0.16, s * 0.14);
    } else if (id === 9) {
      ctx.strokeStyle = "rgba(255,255,255,0.13)";
      ctx.lineWidth = Math.max(1, s * 0.08);
      ctx.beginPath();
      ctx.moveTo(px + s * (0.1 + h * 0.3), py + s);
      ctx.lineTo(px + s * (0.5 + h * 0.3), py);
      ctx.stroke();
    } else {
      ctx.fillStyle = "rgba(0,0,0,0.15)";
      ctx.fillRect(px + s * (0.2 + h * 0.45), py + s * 0.3, s * 0.15, s * 0.12);
      ctx.fillRect(px + s * (0.55 + h * 0.2), py + s * 0.65, s * 0.13, s * 0.11);
    }
  };

  /** プレイヤー: 公式あごむに画像（/img/nomal.png）を足元アンカーで描く。歩行は足元の上下＋潰れで表す。 */
  const drawPlayer = (
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    tilePx: number,
    face: 1 | -1,
    walkPhase: number,
    onGround: boolean,
    now: number,
  ) => {
    const size = tilePx * 1.5;
    const feetX = px + (PLAYER_W * tilePx) / 2;
    const feetY = py + PLAYER_H * tilePx;
    const moving = onGround && Math.abs(Math.sin(walkPhase)) > 0.15;
    const bob = moving ? Math.abs(Math.sin(walkPhase)) * size * 0.03 : Math.sin(now / 380) * size * 0.012;
    // 歩行位相の半周期ごとに足元基準で少し潰す（scaleY 0.94）
    const squash = moving && Math.sin(walkPhase) < 0 ? 0.94 : 1;
    const img = charImgRef.current?.ago;
    ctx.save();
    ctx.translate(feetX, feetY - bob);
    ctx.scale(face, 1);
    ctx.scale(1, squash);
    if (texReady(img)) {
      ctx.drawImage(img, -size / 2, -size, size, size);
    } else {
      // 読み込み中だけの無地プレースホルダ（顔などの造形は描かない）
      ctx.beginPath();
      ctx.arc(0, -size / 2, size * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = "#f4f4f6";
      ctx.fill();
      ctx.strokeStyle = "rgba(20,22,28,0.7)";
      ctx.lineWidth = Math.max(1.4, size * 0.05);
      ctx.stroke();
    }
    ctx.restore();
  };

  /** 遠景の丘シルエット（2層パララックス）。地表ラインに追随し、深い地下では画面外に出る。 */
  const drawHills = (ctx: CanvasRenderingContext2D, camX: number, camY: number, vw: number, vh: number, tilePx: number) => {
    const world = worldRef.current;
    if (!world) return;
    const centerCol = Math.max(0, Math.min(WORLD_W - 1, Math.floor(camX + vw / tilePx / 2)));
    const surfY = (world.surfaces[centerCol] - camY) * tilePx;
    if (surfY < -tilePx * 3) return;
    const night = nightAmount(dayRef.current);
    const layers = [
      { par: 0.25, amp: 2.4, color: `rgba(116,166,96,${0.5 - night * 0.22})` },
      { par: 0.5, amp: 1.5, color: `rgba(79,128,62,${0.75 - night * 0.3})` },
    ];
    for (const L of layers) {
      ctx.fillStyle = L.color;
      ctx.beginPath();
      ctx.moveTo(0, vh);
      for (let sx = 0; sx <= vw; sx += Math.max(8, tilePx / 2)) {
        const wx = camX * L.par + sx / tilePx;
        const n = 0.5 + 0.32 * Math.sin(wx * 0.55 + L.par * 9) + 0.18 * Math.sin(wx * 1.37 + 1.7);
        ctx.lineTo(sx, surfY + tilePx * 0.4 - n * L.amp * tilePx);
      }
      ctx.lineTo(vw, vh);
      ctx.closePath();
      ctx.fill();
    }
  };

  // ---- ポインタ ----
  // タッチ: キャンバス左側へのタッチはフローティング・ジョイスティック
  // （触れた場所に出る。横の傾き=移動量、下への傾き=急降下）。
  // それ以外（右側タッチ・マウス）は従来どおり掘る/置く/攻撃の照準。
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
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (e.pointerType === "touch" && touchUi && !joyRef.current.active && e.clientX - rect.left < rect.width * 0.45) {
      joyRef.current = {
        active: true,
        pointerId: e.pointerId,
        ox: e.clientX - rect.left,
        oy: e.clientY - rect.top,
        dx: 0,
        dy: 0,
      };
      e.currentTarget.setPointerCapture?.(e.pointerId);
      return;
    }
    const t = pointerTile(e);
    if (!t) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointerRef.current = { down: true, pointerId: e.pointerId, tx: t.tx, ty: t.ty };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const joy = joyRef.current;
    if (joy.active && e.pointerId === joy.pointerId) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      joy.dx = e.clientX - rect.left - joy.ox;
      joy.dy = e.clientY - rect.top - joy.oy;
      return;
    }
    if (!pointerRef.current.down || e.pointerId !== pointerRef.current.pointerId) return;
    const t = pointerTile(e);
    if (t) {
      pointerRef.current.tx = t.tx;
      pointerRef.current.ty = t.ty;
    }
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (joyRef.current.active && e.pointerId === joyRef.current.pointerId) {
      joyRef.current = { active: false, pointerId: -1, ox: 0, oy: 0, dx: 0, dy: 0 };
      return;
    }
    if (e.pointerId === pointerRef.current.pointerId) {
      pointerRef.current.down = false;
      digRef.current = null;
    }
  };

  // ---- タッチ用ボタン（右側の3つだけ: 掘る/置く/跳） ----
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
        touchAction: "none", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none", WebkitTapHighlightColor: "transparent",
      }}
    >
      {label}
    </button>
  );

  const btn: React.CSSProperties = {
    padding: "8px 12px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.06)", color: "inherit", cursor: "pointer", fontWeight: 700, minHeight: 40, touchAction: "manipulation",
  };

  const selectedSlot = hud.slots[selected] ?? null;
  const selectedName = selectedSlot ? itemName(selectedSlot.id) : "空き枠";
  const statusText =
    `深さ ${hud.depth} m ・ ${hud.night ? "夜（人狼あごむにが出ます）" : "昼"} ・ 選択中: ${selectedName}` +
    (selectedSlot && !isTool(selectedSlot.id) ? `（所持 ${selectedSlot.count}）` : "") +
    (hud.gate ? ` ・ ${hud.gate}` : "") +
    (onlineMode ? " ・ オンライン保存" : "");

  const invForPanel = invRef.current;

  return (
    <div
      onContextMenu={(e) => e.preventDefault()}
      style={{
        WebkitTouchCallout: "none",
        WebkitUserSelect: "none",
        MozUserSelect: "none",
        msUserSelect: "none",
        userSelect: "none",
      }}
    >
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href={`${prefix}/games`}>ゲーム</Link>
        <span> / </span>
        <span>AGO WORLD BOX</span>
      </nav>
      <div className="page-heading compact-heading">
        <h1>AGO WORLD BOX</h1>
        <p className="muted">横スクロールの2Dサンドボックス。掘って集めて道具を作り、夜の人狼あごむにから生き延びます。</p>
      </div>

      <p className="classic-status" role="status">{statusText}</p>

      <div style={{ position: "relative", maxWidth: 960, margin: "0 auto", touchAction: "none" }}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
          aria-label="AGO WORLD BOX のワールド。ブロックを押し続けると掘れて、空いた場所を押すと置けます。タッチでは左側にスティックが出ます"
          style={{
            width: "100%", height: "min(62vh, 560px)", minHeight: 340, display: "block",
            borderRadius: 16, border: "2px solid rgba(255,255,255,0.15)",
            touchAction: "none", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none", WebkitTapHighlightColor: "transparent",
          }}
        />
        {/* 体力ハート */}
        <div
          role="img"
          aria-label={`体力 ${hud.hp} / ${PLAYER_MAX_HP}`}
          style={{ position: "absolute", left: 10, top: 10, display: "flex", gap: 2, pointerEvents: "none" }}
        >
          {[0, 1, 2, 3, 4].map((i) => (
            <HeartIcon key={i} fill={Math.max(0, Math.min(1, (hud.hp - i * 2) / 2))} />
          ))}
        </div>
        {deathFlash && (
          <div
            role="alert"
            style={{
              position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
              background: "rgba(120,10,10,0.35)", borderRadius: 16, color: "#fff", fontSize: 22, fontWeight: 800,
              pointerEvents: "none",
            }}
          >
            やられた… スポーンに戻ります
          </div>
        )}
        {touchUi && (
          <div style={{ position: "absolute", right: 10, bottom: 10, display: "flex", gap: 8 }}>
            {holdBtn("掘る", (d) => { touchRef.current.dig = d; }, "向いている方向を掘る・攻撃する")}
            {holdBtn("置く", (d) => { if (d) placeFacing(); }, "向いている方向に置く")}
            {holdBtn("跳", (d) => { touchRef.current.jump = d; }, "ジャンプ")}
          </div>
        )}
        {/* クラフトパネル（ドロワー） */}
        {craftOpen && (
          <div
            role="dialog"
            aria-label="クラフト"
            style={{
              position: "absolute", top: 0, right: 0, bottom: 0, width: "min(320px, 88%)",
              background: "rgba(12,15,24,0.94)", borderLeft: "1px solid rgba(255,255,255,0.2)",
              borderRadius: "0 16px 16px 0", padding: 12, overflowY: "auto", color: "#fff",
              touchAction: "pan-y", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <strong style={{ fontSize: 15 }}>つくる</strong>
              <button type="button" style={{ ...btn, minHeight: 32, padding: "4px 10px" }} onClick={() => setCraftOpen(false)} aria-label="閉じる">×</button>
            </div>
            {RECIPES.map((recipe) => {
              const check = checkCraft(invForPanel, recipe);
              const owned = countOf(invForPanel, recipe.output) > 0;
              return (
                <div key={recipe.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                  <div style={{ width: 34, flex: "0 0 auto" }}><ItemIcon id={recipe.output} size={30} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{recipe.name}</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {recipe.costs.map((cost) => {
                        const have = countOf(invForPanel, cost.id);
                        return (
                          <span key={cost.id} style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 12, color: have >= cost.count ? "#b7f0c0" : "#ff9d9d" }}>
                            <ItemIcon id={cost.id} size={15} /> {have}/{cost.count}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={check !== "ok"}
                    onClick={() => {
                      if (applyCraft(invRef.current, recipe)) {
                        dirtyRef.current = true;
                        sfxPlace();
                        syncHud();
                      }
                    }}
                    style={{ ...btn, minHeight: 34, padding: "5px 10px", opacity: check === "ok" ? 1 : 0.45 }}
                  >
                    {owned ? "所持済" : check === "no_slot" ? "枠不足" : "作る"}
                  </button>
                </div>
              );
            })}
            {/* かまど（精錬） */}
            <div style={{ marginTop: 12 }}>
              <strong style={{ fontSize: 14 }}>かまど（銅を焼く）</strong>
              <div style={{ display: "flex", gap: 10, marginTop: 6, fontSize: 12 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                  <ItemIcon id={COPPER_ORE} size={15} /> {countOf(invForPanel, COPPER_ORE)}/1
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                  <ItemIcon id={COAL_ORE} size={15} /> {countOf(invForPanel, COAL_ORE)}/1
                </span>
                <span aria-hidden>→</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                  <ItemIcon id={COPPER_INGOT} size={15} /> ×1
                </span>
              </div>
              {hud.furnace.remaining !== null ? (
                <div style={{ marginTop: 8 }}>
                  <div style={{ height: 8, borderRadius: 4, background: "rgba(255,255,255,0.15)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.max(0, Math.min(100, (1 - hud.furnace.remaining / SMELT_SECONDS) * 100))}%`, background: "#e07f3f" }} />
                  </div>
                  <div style={{ fontSize: 12, marginTop: 4 }}>焼いています…</div>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={!canStartSmelt(furnaceRef.current, invForPanel)}
                  onClick={() => {
                    if (startSmelt(furnaceRef.current, invRef.current)) {
                      dirtyRef.current = true;
                      syncHud();
                    }
                  }}
                  style={{ ...btn, marginTop: 8, opacity: canStartSmelt(furnaceRef.current, invForPanel) ? 1 : 0.45 }}
                >
                  焼く
                </button>
              )}
              {hud.furnace.output > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    if (collectSmelt(furnaceRef.current, invRef.current) > 0) {
                      dirtyRef.current = true;
                      sfxTap();
                    }
                    syncHud();
                  }}
                  style={{ ...btn, marginTop: 8, marginLeft: 6 }}
                >
                  インゴット ×{hud.furnace.output} を受け取る
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* インベントリ（5枠・ホットバー兼用） */}
      <div role="group" aria-label="インベントリ（5枠）" style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center", marginTop: 12, maxWidth: 960, marginLeft: "auto", marginRight: "auto" }}>
        {Array.from({ length: SLOT_COUNT }, (_, i) => {
          const slot = hud.slots[i] ?? null;
          const active = selected === i;
          return (
            <button
              key={i}
              type="button"
              onClick={() => selectSlot(i)}
              aria-pressed={active}
              aria-label={slot ? `${i + 1}枠: ${itemName(slot.id)}` : `${i + 1}枠: 空き`}
              style={{
                width: 74, minHeight: 74, padding: "7px 4px 6px", borderRadius: 10, cursor: "pointer",
                border: active ? "2px solid #ffd23e" : "1px solid rgba(255,255,255,0.18)",
                background: "rgba(255,255,255,0.05)", color: "inherit", touchAction: "manipulation",
                userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none",
              }}
            >
              {slot ? (
                <>
                  <ItemIcon id={slot.id} size={26} />
                  <span style={{ display: "block", fontSize: 11, fontWeight: 700, lineHeight: 1.25, marginTop: 4 }}>{itemName(slot.id)}</span>
                  <span style={{ display: "block", fontSize: 11, opacity: 0.85 }}>{isTool(slot.id) ? "道具" : `${slot.count} 個`} ・ {i + 1}</span>
                </>
              ) : (
                <>
                  <span aria-hidden style={{ display: "block", width: 26, height: 26, margin: "0 auto", borderRadius: 5, border: "1px dashed rgba(255,255,255,0.3)" }} />
                  <span style={{ display: "block", fontSize: 11, fontWeight: 700, lineHeight: 1.25, marginTop: 4, opacity: 0.6 }}>空き</span>
                  <span style={{ display: "block", fontSize: 11, opacity: 0.6 }}>{i + 1}</span>
                </>
              )}
            </button>
          );
        })}
      </div>
      {hud.full && (
        <p className="muted" role="status" style={{ textAlign: "center", fontSize: 13, marginTop: 6 }}>
          持ち物がいっぱいです（5枠）。置いて枠を空けるか、道具に作り替えてください。
        </p>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 14, flexWrap: "wrap" }}>
        <span className="muted" style={{ fontSize: 13, alignSelf: "center" }}>シード: {seedShown}</span>
        <button type="button" style={btn} onClick={() => { syncHud(); setCraftOpen((v) => !v); }}>つくる（C）</button>
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
                applyState(null);
                saveNow();
                putOnlineSave();
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
        数字キー1〜5で枠を切り替え、Cで「つくる」を開きます。
        スマホ・タブレットでは、画面左側を触るとスティックが出て（傾けた量で歩き/走り、下に倒すと急降下）、
        右下のボタンで掘る・置く・跳ぶができます。
        夜は人狼あごむにが出ます。石は木のツルハシ、石炭・銅の鉱石は石のツルハシ、深い石は銅のツルハシがないと掘れません。
        草・土・砂・葉は支えを失うと崩れ落ち、当たると痛いです。持ち物は5枠まで。
        ログイン中はサーバーにも自動保存され、別の端末でも続きが遊べます。
      </p>
    </div>
  );
}
