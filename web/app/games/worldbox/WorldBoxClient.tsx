"use client";
// AGO WORLD BOX（横スクロール2Dサンドボックス）v3。
// v2 までに基底（生成・歩行・掘る/置く）＋敵と体力・道具とクラフト/精錬・
// 崩落・5枠・オンラインセーブを実装。v3 で世界は全員共有の1つになり、
// セーブはプレイヤー状態だけ、昼夜は共有時計になった。
// ゲームループと描画は canvas + refs で回し、React state は HUD 表示だけに使う。
// 純粋ロジックは lib/worldbox/ に分離（生成・物理・在庫・敵・体力・工作・崩落・保存）。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AIR, BEDROCK, BLOCKS, COAL_ORE, COPPER_ORE, DIRT, GRASS, LEAVES, SAND, STONE, TORCH, WOOD, WORKBENCH, canDigBlock, dropOf, isFullSolidBlock } from "@/lib/worldbox/blocks";
import { generateWorld, getTile, findSpawn, WORLD_H, WORLD_SEED, WORLD_W, type World } from "@/lib/worldbox/worldgen";
import { createBody, stepPlayer, PLAYER_H, PLAYER_W, RUN_SPEED, type PlayerBody } from "@/lib/worldbox/physics";
import { crackStage, digTile, placeTile, placeTorch, pressModeFor, withinReach, type PressMode } from "@/lib/worldbox/rules";
import { buildLightField, skyLevelAt, type LightField } from "@/lib/worldbox/light";
import {
  ARM_REST_ANGLE, advanceEnemyPhase, advanceWalkPhase, airPose, attackSwingAngle, damp, digSwingAngle,
  enemyRock, flickerNoise, flipDeathPose, landingSquashY, magnetStep, moveLean, poofPose, respawnPose,
  springStep, stepBeatIndex, telegraphSquashY, torchFlameScale, torchLightFlicker, walkBob, walkSquashY,
  type SpringState,
} from "@/lib/worldbox/anim";
import { SLOT_COUNT, addItem, canAdd, cloneInventory, countOf, createInventory, isInventoryFull, type InventoryV2, type InvSlot } from "@/lib/worldbox/inventory";
import { attackDamageOf, canDigWith, digSecondsFor, isTool, itemDef, requiredTier, tierOfTool, COPPER_INGOT, COPPER_PICKAXE, DEEP_STONE_Y, STONE_PICKAXE, SWORD, WOODEN_PICKAXE } from "@/lib/worldbox/items";
import { isNightPhase, nightAmount, phaseAtTime } from "@/lib/worldbox/daynight";
import { CONTACT_DAMAGE, ENEMY_H, ENEMY_MAX_HP, ENEMY_SPEED, ENEMY_W, SPAWN_INTERVAL_SEC, attackEnemy, burnEnemiesAtDawn, enemyTouches, rollsHeartDrop, stepEnemy, trySpawnEnemy, type Enemy } from "@/lib/worldbox/enemies";
import { HEART_HEAL, PICKUP_SIZE, createPickup, pickupTouches, stepPickup, type Pickup } from "@/lib/worldbox/pickups";
import { PLAYER_MAX_HP, createHealth, damagePlayer, deathDrops, fallDamageFor, healPlayer, isDead, type HealthState } from "@/lib/worldbox/health";
import { RECIPES, SMELT_SECONDS, applyCraft, canStartSmelt, checkCraft, collectSmelt, createFurnace, startSmelt, tickFurnace, type Furnace } from "@/lib/worldbox/craft";
import { FALL_BLOCK_DAMAGE, settleAfterChange, stepFalling, type FallingBlock } from "@/lib/worldbox/collapse";
import { parseSave, serializeSave, type WorldBoxState } from "@/lib/worldbox/save";
import { chooseInitialSave } from "@/lib/worldbox/save-source";
import { MAX_CHANGE_BATCH, applyDiffs, diffKey, diffTilesAgainst } from "@/lib/worldbox/world-sync";
import { TEXTURE_DATA, loadTextures } from "@/lib/worldbox/textures";
import { sfxHit, sfxKo, sfxPlace, sfxPop, sfxTap, sfxTick } from "@/lib/sfx";
import { useGamesNav } from "../GamesShell";

const SAVE_KEY = "ago-worldbox-save-v1";
const JOY_RADIUS = 52;
/** 敵の攻撃モーション: 溜めの秒数と、溜めに入る距離・突進の初速。 */
const ENEMY_WINDUP_SEC = 0.3;
const ENEMY_TELEGRAPH_RANGE = 2.0;
const ENEMY_LUNGE_KX = 8.5;

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
  if (id === TORCH) {
    // 松明（棒＋炎）
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden style={{ display: "block", margin: "0 auto" }}>
        <path d="M11 11 L13 11 L12.7 21 L11.3 21 Z" fill="#8a5a2b" />
        <path d="M12 2.5 C14.5 5.5 15.5 7.5 15.5 9.8 A3.5 3.5 0 1 1 8.5 9.8 C8.5 7.5 9.5 5.5 12 2.5 Z" fill="#ff9d2e" />
        <path d="M12 6.5 C13.2 8.2 13.7 9.2 13.7 10.4 A1.7 1.7 0 1 1 10.3 10.4 C10.3 9.2 10.8 8.2 12 6.5 Z" fill="#ffd76a" />
      </svg>
    );
  }
  if (id === WORKBENCH) {
    // 作業台（天板＋脚）
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden style={{ display: "block", margin: "0 auto" }}>
        <rect x="3" y="7" width="18" height="4.5" rx="1" fill="#a9743f" stroke="#7a5230" strokeWidth="1" />
        <rect x="5" y="11.5" width="2.6" height="8.5" fill="#7a5230" />
        <rect x="16.4" y="11.5" width="2.6" height="8.5" fill="#7a5230" />
        <path d="M7 9.2 L12 9.2" stroke="rgba(255,255,255,0.45)" strokeWidth="1.2" strokeLinecap="round" />
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
  const lightRef = useRef<LightField | null>(null);
  const lightDirtyRef = useRef(true);
  /** ブロック破砕・回収の破片パーティクル（タイル座標、life は残り秒数）。dust は土煙。 */
  const particlesRef = useRef<{ x: number; y: number; vx: number; vy: number; life: number; maxLife: number; blockId: number; heart: boolean; dust: boolean }[]>([]);
  /** 着地した瞬間の記録（描画側の潰れ・カメラの沈み・土煙のトリガー）。 */
  const landFxRef = useRef<{ at: number; fall: number } | null>(null);
  /** 被弾した時刻（赤フラッシュ＋揺れ用）。HP の減少をループで検知して記録する。 */
  const hurtAtRef = useRef(0);
  const prevHpRef = useRef(PLAYER_MAX_HP);
  /** 攻撃が振られた時刻 / ブロックが壊れた時刻（スイングと反動用）。 */
  const attackAtRef = useRef(0);
  const breakAtRef = useRef(0);
  /** 死亡ポフの発生位置と時刻 / 復活した時刻（出現フェード用）。 */
  const deathFxRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const respawnAtRef = useRef(0);
  /** 撃破されて倒れ込む敵の残像（フリップ＋フェード）。 */
  const dyingRef = useRef<{ id: number; x: number; y: number; face: 1 | -1; at: number }[]>([]);
  /** プレイヤーのアニメ状態（着地バネ・カメラ平滑化。描画側でだけ進める）。 */
  const playerAnimRef = useRef<{
    squash: SpringState; dip: SpringState; landAt: number;
    camX: number; camY: number; camInit: boolean; lastDrawAt: number;
  }>({ squash: { x: 1, v: 0 }, dip: { x: 0, v: 0 }, landAt: 0, camX: 0, camY: 0, camInit: false, lastDrawAt: 0 });
  /** 敵ごとのアニメ状態（歩行位相・溜め/突進・被弾の凹みバネ）。 */
  const enemyBrainRef = useRef(new Map<number, {
    mode: "chase" | "windup" | "lunge" | "cool"; until: number; phase: number; squash: SpringState; lastHitAt: number;
  }>());
  const hitstopUntilRef = useRef(0);
  /** 置いた直後のタイルの「ポップ」演出（キー "x,y" → 時刻）。 */
  const placedPopRef = useRef(new Map<string, number>());
  /** 作業台タップ判定（押した時刻と場所）。短く離すと「つくる」が開く。 */
  const benchTapRef = useRef<{ x: number; y: number; at: number } | null>(null);
  /** 掘りヒビの段階（音を鳴らすための前回値）。 */
  const digStageRef = useRef(0);
  const texturesRef = useRef<Record<string, HTMLImageElement> | null>(null);
  const charImgRef = useRef<{ ago: HTMLImageElement; jinrou: HTMLImageElement } | null>(null);
  const enemyHitRef = useRef(new Map<number, number>());
  const selectedRef = useRef(0);
  const keysRef = useRef({ left: false, right: false, jump: false, fastFall: false });
  const touchRef = useRef({ jump: false, dig: false, place: false });
  /** プレスの操作モード（押し始めた対象で固定。離すまで変わらない）。 */
  const pressModeRef = useRef<PressMode | null>(null);
  /** 設置モードで最後に処理したタイル（スワイプ軌跡の補間用）。 */
  const lastPlaceRef = useRef<{ tx: number; ty: number } | null>(null);
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
  /** 共有ワールド同期の状態（v3）。known はサーバーと同期済みのタイル列。 */
  const worldSyncRef = useRef<{
    shared: boolean;
    loggedIn: boolean;
    epoch: number;
    known: Uint8Array | null;
    recentLocal: Map<string, number>;
    lastFlushAt: number;
    lastPollAt: number;
  }>({ shared: false, loggedIn: false, epoch: 0, known: null, recentLocal: new Map(), lastFlushAt: 0, lastPollAt: 0 });

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
  const [sharedMode, setSharedMode] = useState(false);

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

  /** 共有ワールド（生成地形＋サーバー差分を適用済みのタイル列）を worldRef へ置く。 */
  const installWorld = (tiles: Uint8Array) => {
    worldRef.current = {
      seed: WORLD_SEED,
      width: WORLD_W,
      height: WORLD_H,
      tiles,
      surfaces: computeSurfaces(tiles),
    };
    seedRef.current = WORLD_SEED;
    setSeedShown(WORLD_SEED);
    lightDirtyRef.current = true;
  };

  /** 読み込んだ位置が固体に埋まっていたら、その列の地表へ出す（共有世界の変更対策）。 */
  const ensureSafePosition = (world: World, body: PlayerBody) => {
    const x0 = Math.max(0, Math.floor(body.x));
    const x1 = Math.min(WORLD_W - 1, Math.floor(body.x + PLAYER_W - 0.001));
    const y0 = Math.max(0, Math.floor(body.y));
    const y1 = Math.min(WORLD_H - 1, Math.floor(body.y + PLAYER_H - 0.001));
    let buried = false;
    for (let ty = y0; ty <= y1 && !buried; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (isFullSolidBlock(getTile(world, tx, ty))) {
          buried = true;
          break;
        }
      }
    }
    if (!buried) return;
    const col = Math.max(0, Math.min(WORLD_W - 1, Math.floor(body.x + PLAYER_W / 2)));
    body.y = world.surfaces[col] - PLAYER_H;
    body.vy = 0;
  };

  /** プレイヤー状態（セーブ or 新規）を各 ref へ反映する。ワールド自体は触らない。 */
  const applyPlayerState = (state: WorldBoxState | null) => {
    enemiesRef.current = [];
    pickupsRef.current = [];
    fallingRef.current = [];
    furnaceRef.current = createFurnace();
    healthRef.current = createHealth();
    digRef.current = null;
    gatedRef.current = null;
    if (state) {
      invRef.current = cloneInventory(state.inventory);
      bodyRef.current = createBody(state.player.x, state.player.y);
      healthRef.current.hp = state.hp;
    } else {
      // 「進行をリセット」は世界を変えず、所持品・位置・体力だけを初期化する。
      invRef.current = createInventory();
      const world = worldRef.current;
      if (world) {
        const spawn = findSpawn(world);
        bodyRef.current = createBody(spawn.x + 0.1, spawn.y + 2 - PLAYER_H);
      }
      dirtyRef.current = true;
    }
    if (worldRef.current && bodyRef.current) ensureSafePosition(worldRef.current, bodyRef.current);
    prevHpRef.current = healthRef.current.hp;
    syncHud();
  };

  const currentSaveJson = (): string | null => {
    const body = bodyRef.current;
    if (!body) return null;
    return serializeSave({
      inventory: invRef.current,
      player: { x: body.x, y: body.y },
      hp: healthRef.current.hp,
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

  /** 自分のタイル変更を共有ワールドへ送る（ログイン中・共有接続時のみ、最大256件ずつ）。 */
  const flushWorldChanges = (keepalive = false) => {
    const ws = worldSyncRef.current;
    const world = worldRef.current;
    if (!ws.shared || !ws.loggedIn || !ws.known || !world) return;
    ws.lastFlushAt = performance.now();
    const changes = diffTilesAgainst(world.tiles, ws.known);
    if (changes.length === 0) return;
    const now = performance.now();
    for (const c of changes) ws.recentLocal.set(diffKey(c.x, c.y), now);
    const batch = changes.slice(0, MAX_CHANGE_BATCH);
    fetch("/api/worldbox/world", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes: batch }),
      keepalive,
    })
      .then(async (res) => {
        if (res.status === 401) {
          ws.loggedIn = false;
          return;
        }
        if (!res.ok) return;
        const data = (await res.json()) as { epoch?: number; rejected?: { x: number; y: number }[] };
        const rejectedKeys = new Set((data.rejected ?? []).map((r) => diffKey(r.x, r.y)));
        const w = worldRef.current;
        for (const c of batch) {
          const idx = c.y * WORLD_W + c.x;
          if (rejectedKeys.has(diffKey(c.x, c.y))) {
            // 拒否されたセルは、その後触っていない場合だけ同期済みの値へ戻す
            if (w && ws.known && w.tiles[idx] === c.tile) w.tiles[idx] = ws.known[idx];
          } else if (ws.known) {
            ws.known[idx] = c.tile;
          }
        }
        if (typeof data.epoch === "number") ws.epoch = data.epoch;
        if (rejectedKeys.size > 0) lightDirtyRef.current = true;
      })
      .catch(() => {
        /* 次のフラッシュで再送する */
      });
  };

  /** 共有ワールドの最新状態を取り込み、他人の変更を反映する（ゲストも読む）。 */
  const pollWorld = () => {
    const ws = worldSyncRef.current;
    const world = worldRef.current;
    if (!ws.shared || !ws.known || !world) return;
    ws.lastPollAt = performance.now();
    fetch("/api/worldbox/world", { headers: { Accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) {
          if (res.status === 503) {
            ws.shared = false;
            setSharedMode(false);
          }
          return;
        }
        const data = (await res.json()) as { epoch?: number; diffs?: Record<string, number> };
        if (typeof data.epoch !== "number" || !data.diffs || typeof data.diffs !== "object") return;
        if (data.epoch === ws.epoch) return;
        ws.epoch = data.epoch;
        const w = worldRef.current;
        const known = ws.known;
        if (!w || !known) return;
        // サーバー状態 = 生成地形 + diffs
        const serverWorld = generateWorld(WORLD_SEED);
        applyDiffs(serverWorld, data.diffs);
        const serverTiles = serverWorld.tiles;
        const now = performance.now();
        let appliedAny = false;
        for (let i = 0; i < serverTiles.length; i++) {
          if (serverTiles[i] === known[i]) continue;
          const key = diffKey(i % WORLD_W, Math.floor(i / WORLD_W));
          const recent = ws.recentLocal.get(key);
          known[i] = serverTiles[i];
          // 自分が直近（3秒以内）に変えたタイルは上書きしない（自分の送信が LWW で勝つ）
          if (recent !== undefined && now - recent < 3000) continue;
          if (w.tiles[i] !== serverTiles[i]) {
            w.tiles[i] = serverTiles[i];
            appliedAny = true;
          }
        }
        if (ws.recentLocal.size > 1024) {
          for (const [k, at] of ws.recentLocal) {
            if (now - at > 3000) ws.recentLocal.delete(k);
          }
        }
        if (appliedAny) {
          w.surfaces = computeSurfaces(w.tiles);
          lightDirtyRef.current = true;
          if (bodyRef.current) ensureSafePosition(w, bodyRef.current);
        }
      })
      .catch(() => {
        /* 次のポーリングで再試行する */
      });
  };

  /** ブロック破砕・回収の破片を散らす（テクスチャの小片、重力で落ちて消える）。 */
  const spawnParticles = (cx: number, cy: number, blockId: number, heart: boolean, count: number) => {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.2 + Math.random() * 2.6;
      particlesRef.current.push({
        x: cx + (Math.random() - 0.5) * 0.5,
        y: cy + (Math.random() - 0.5) * 0.5,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 2.2,
        life: 0.4,
        maxLife: 0.4,
        blockId,
        heart,
        dust: false,
      });
    }
  };

  /** 足元の土煙（歩行の一歩・着地の衝撃で出す、柔らかい円のパーティクル）。 */
  const spawnDust = (cx: number, cy: number, count: number, spread: number) => {
    for (let i = 0; i < count; i++) {
      const life = 0.28 + Math.random() * 0.18;
      particlesRef.current.push({
        x: cx + (Math.random() - 0.5) * 0.5,
        y: cy - Math.random() * 0.08,
        vx: (Math.random() - 0.5) * 2 * spread,
        vy: -(0.4 + Math.random() * 1.1),
        life,
        maxLife: life,
        blockId: 0,
        heart: false,
        dust: true,
      });
    }
  };

  /** 敵を倒したときの処理（倒れ込み残像・煙・ハートドロップ）。 */
  const killEnemy = (e: Enemy, now: number) => {
    enemiesRef.current = enemiesRef.current.filter((o) => o.id !== e.id);
    dyingRef.current.push({ id: e.id, x: e.x, y: e.y, face: e.face, at: now });
    poofsRef.current.push({ x: e.x, y: e.y, at: now });
    sfxKo();
    if (rollsHeartDrop(Math.random)) {
      pickupsRef.current.push(createPickup("heart", 0, 1, e.x + 0.2, e.y));
    }
  };

  /** 死亡処理: 所持ブロックの一部を落とし、スポーンへ戻る（ワールドは残る）。 */
  const handleDeath = () => {
    const world = worldRef.current;
    const body = bodyRef.current;
    if (!world || !body) return;
    // テレポート前に死亡位置を記録する（ポフ演出用）。復活の出現フェードもここから。
    deathFxRef.current = { x: body.x, y: body.y, at: performance.now() };
    respawnAtRef.current = performance.now();
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
      const rawDt = Math.min(0.05, (now - last) / 1000);
      last = now;
      // ヒットストップ中はシミュレーションだけを止める（描画は続く）
      const dt = now < hitstopUntilRef.current ? 0 : rawDt;
      // 光フィールドはタイルが変わったフレームだけ作り直す
      if (lightDirtyRef.current) {
        lightRef.current = buildLightField(world);
        lightDirtyRef.current = false;
      }
      gameTimeRef.current += dt;
      const gt = gameTimeRef.current;
      // 昼夜は共有時計（unix 時刻から決まる。全員が同じ時刻を生きる）
      dayRef.current = phaseAtTime(Date.now() / 1000);

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
        // one-way の上での下入力はすり抜け（キーボードの下キー／スティック下倒し共通）
        dropThrough: keysRef.current.fastFall || stickFastFall,
        moveX,
      };
      // 物理は2サブステップで安定させる。落下ダメージはサブステップごとに拾う
      for (let s = 0; s < 2; s++) {
        stepPlayer(world, body, input, dt / 2);
        if (body.landedFall > 0) {
          // 着地の手触り: 記録（描画の潰れ・カメラの沈み）＋衝撃の大きさで土煙
          landFxRef.current = { at: now, fall: body.landedFall };
          spawnDust(body.x + PLAYER_W / 2, body.y + PLAYER_H, Math.min(10, 3 + Math.floor(body.landedFall * 1.2)), 1.6);
          const dmg = fallDamageFor(body.landedFall);
          if (dmg > 0 && damagePlayer(healthRef.current, dmg, gt)) {
            sfxHit(2);
            syncHud();
          }
        }
      }
      // 歩行位相は実速に比例して進める。拍が変わるたびに足元へ小さな土煙
      {
        const prevBeat = stepBeatIndex(walkPhaseRef.current);
        walkPhaseRef.current = advanceWalkPhase(walkPhaseRef.current, body.vx, dt);
        if (body.onGround && Math.abs(body.vx) > 0.6 && stepBeatIndex(walkPhaseRef.current) !== prevBeat) {
          spawnDust(body.x + PLAYER_W / 2 - body.face * 0.25, body.y + PLAYER_H, 2, 0.8);
        }
      }
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

      // ---- 敵: 出現（暗さベース）・移動・燃焼・接触 ----
      spawnTimerRef.current -= dt;
      if (spawnTimerRef.current <= 0) {
        spawnTimerRef.current = SPAWN_INTERVAL_SEC;
        const field = lightRef.current;
        if (field) {
          const spawned = trySpawnEnemy(world, field, dayRef.current, { x: body.x, y: body.y }, enemiesRef.current.length, Math.random);
          if (spawned) enemiesRef.current.push(spawned);
        }
      }
      const burned = lightRef.current ? burnEnemiesAtDawn(world, lightRef.current, enemiesRef.current, dayRef.current, dt) : [];
      if (burned.length > 0) {
        for (const id of burned) {
          const e = enemiesRef.current.find((o) => o.id === id);
          if (e) poofsRef.current.push({ x: e.x, y: e.y, at: now });
        }
        enemiesRef.current = enemiesRef.current.filter((e) => !burned.includes(e.id));
      }
      const playerRect = { x: body.x, y: body.y, w: PLAYER_W, h: PLAYER_H };
      for (const e of [...enemiesRef.current]) {
        // 攻撃モーションの状態機械（溜め→突進→休み）。移動そのものは stepEnemy に任せ、
        // 溜め中は歩行を打ち消し、突進はノックバック速度 kx の初速で表現する。
        let brain = enemyBrainRef.current.get(e.id);
        if (!brain) {
          brain = { mode: "chase", until: 0, phase: Math.random() * 6, squash: { x: 1, v: 0 }, lastHitAt: -1 };
          enemyBrainRef.current.set(e.id, brain);
        }
        const dirP = centerX < e.x + ENEMY_W / 2 ? -1 : 1;
        const distP = Math.abs(centerX - (e.x + ENEMY_W / 2));
        if (brain.mode === "chase") {
          if (e.onGround && distP < ENEMY_TELEGRAPH_RANGE && Math.abs(centerY - (e.y + ENEMY_H / 2)) < 1.6 && gt >= brain.until) {
            brain.mode = "windup";
            brain.until = gt + ENEMY_WINDUP_SEC;
          }
        } else if (brain.mode === "windup") {
          e.kx = -dirP * ENEMY_SPEED; // 歩行分を打ち消してその場で溜める
          if (gt >= brain.until) {
            brain.mode = "lunge";
            brain.until = gt + 0.22;
            e.kx = dirP * ENEMY_LUNGE_KX;
          }
        } else if (brain.mode === "lunge") {
          if (gt >= brain.until) {
            brain.mode = "cool";
            brain.until = gt + 0.9;
          }
        } else if (gt >= brain.until) {
          brain.mode = "chase";
        }
        stepEnemy(world, e, centerX, dt);
        // 歩行位相（速さ比例）と被弾の凹みバネ
        brain.phase = advanceEnemyPhase(brain.phase, e.vx, dt);
        const hitAt = enemyHitRef.current.get(e.id) ?? -1;
        if (hitAt !== brain.lastHitAt) {
          brain.lastHitAt = hitAt;
          brain.squash.v -= 7;
        }
        brain.squash = springStep(brain.squash, 1, 180, 13, dt);
        if (enemyTouches(e, playerRect)) {
          if (damagePlayer(healthRef.current, CONTACT_DAMAGE, gt)) {
            body.kx = (centerX < e.x + 0.45 ? -1 : 1) * 7;
            body.vy = Math.min(body.vy, -5.5);
            sfxHit(2);
            syncHud();
          }
        }
      }

      // 消えた敵のアニメ状態を掃除する
      if (enemyBrainRef.current.size > 0) {
        const alive = new Set(enemiesRef.current.map((e) => e.id));
        for (const id of enemyBrainRef.current.keys()) {
          if (!alive.has(id)) enemyBrainRef.current.delete(id);
        }
      }

      // ---- 攻撃（ポインタが敵の上 or 掘るボタンで正面の敵） ----
      const tryAttack = (e: Enemy): boolean => {
        if (attackCdRef.current > 0) return true; // 攻撃扱いで掘りに行かない
        attackCdRef.current = 0.35;
        attackAtRef.current = now;
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
        if (pointerRef.current.down && pressModeRef.current === "dig") {
          // 採掘モードで固定したプレスだけが掘る（ドラッグで隣へ移っても連続採掘）
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
      if (!digRef.current) digStageRef.current = 0;
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
            // ヒビが深くなるたびに小さな掘り音
            const stage = crackStage(digRef.current.progress);
            if (stage > digStageRef.current) {
              digStageRef.current = stage;
              sfxTick();
            }
            if (digRef.current.progress >= 1) {
              const dugId = digTile(world, invRef.current, target.x, target.y);
              if (dugId !== null) {
                // 破砕: 音＋破片＋ごく短いヒットストップ＋腕の反動
                sfxHit(1);
                hitstopUntilRef.current = now + 40;
                breakAtRef.current = now;
                spawnParticles(target.x + 0.5, target.y + 0.5, dugId, false, 8);
                dirtyRef.current = true;
                lightDirtyRef.current = true;
                dug = true;
                // 支えを失った緩いブロックが崩落する
                fallingRef.current.push(...settleAfterChange(world, target.x, target.y));
              }
              digRef.current = null;
              digStageRef.current = 0;
            }
          }
        } else {
          digRef.current = null;
        }
      } else {
        digRef.current = null;
      }

      // ---- 置く（設置モードで固定したプレスだけ。スワイプの軌跡に沿って連続設置） ----
      if (pointerRef.current.down && pressModeRef.current === "place" && !attacked) {
        const slot = invRef.current.slots[selectedRef.current];
        if (slot && (slot.id === TORCH || BLOCKS[slot.id]?.placeable) && countOf(invRef.current, slot.id) > 0) {
          const from = lastPlaceRef.current ?? { tx: pointerRef.current.tx, ty: pointerRef.current.ty };
          const to = { tx: pointerRef.current.tx, ty: pointerRef.current.ty };
          // 前フレームの位置から今の位置までを補間し、間のセルにも置く（速いスワイプでも隙間を作らない）
          const steps = Math.max(Math.abs(to.tx - from.tx), Math.abs(to.ty - from.ty));
          let placedAny = false;
          for (let i = 0; i <= steps; i++) {
            const tx = Math.round(from.tx + ((to.tx - from.tx) * i) / Math.max(1, steps));
            const ty = Math.round(from.ty + ((to.ty - from.ty) * i) / Math.max(1, steps));
            if (getTile(world, tx, ty) !== AIR || !withinReach(centerX, centerY, tx, ty)) continue;
            const placed =
              slot.id === TORCH
                ? placeTorch(world, invRef.current, tx, ty)
                : placeTile(world, invRef.current, tx, ty, slot.id, playerRect);
            if (placed) {
              placedAny = true;
              placedPopRef.current.set(`${tx},${ty}`, now);
              fallingRef.current.push(...settleAfterChange(world, tx, ty));
              if (countOf(invRef.current, slot.id) <= 0) break;
            }
          }
          if (placedAny) {
            sfxPlace();
            dirtyRef.current = true;
            lightDirtyRef.current = true;
          }
          lastPlaceRef.current = to;
        }
      }

      // タッチの「置く」長押し: 向いている方向へ連続設置（掘る側には化けない）
      if (touchRef.current.place && placeCooldownRef.current <= 0) {
        placeFacing();
        placeCooldownRef.current = 0.22;
      }

      // ---- 崩落（落下ブロックの進行・着地・潰し） ----
      if (fallingRef.current.length > 0) {
        const targets = [
          { key: "player", x: body.x, y: body.y, w: PLAYER_W, h: PLAYER_H },
          ...enemiesRef.current.map((e) => ({ key: `enemy:${e.id}`, x: e.x, y: e.y, w: ENEMY_W, h: ENEMY_H })),
        ];
        const events = stepFalling(world, fallingRef.current, dt, targets);
        if (events.landed.length > 0) {
          dirtyRef.current = true;
          lightDirtyRef.current = true;
        }
        for (const crush of events.crushed) {
          if (crush.targetKey === "player") {
            if (damagePlayer(healthRef.current, FALL_BLOCK_DAMAGE, gt)) {
              sfxHit(2);
              syncHud();
            }
          } else {
            const id = Number(crush.targetKey.slice("enemy:".length));
            const e = enemiesRef.current.find((o) => o.id === id);
            if (e && attackEnemy(e, FALL_BLOCK_DAMAGE, crush.block.x + 0.5)) killEnemy(e, now);
          }
        }
      }

      // ---- 拾い物 ----
      for (const p of [...pickupsRef.current]) {
        // 近づくと吸い寄せられる（マグネット）。範囲外は従来どおり落下して地面に止まる
        const pcx = p.x + PICKUP_SIZE / 2;
        const pcy = p.y + PICKUP_SIZE / 2;
        const pDist = Math.hypot(centerX - pcx, centerY - pcy);
        if (pDist < 1.5 && pDist > 0.001) {
          const speed = 4 + (1.5 - pDist) * 6;
          const moved = magnetStep(pcx, pcy, centerX, centerY, speed * dt);
          p.x = moved.x - PICKUP_SIZE / 2;
          p.y = moved.y - PICKUP_SIZE / 2;
          p.vy = 0;
          p.onGround = false;
        } else {
          stepPickup(world, p, dt);
        }
        if (!pickupTouches(p, playerRect)) continue;
        if (p.kind === "heart") {
          if (healPlayer(healthRef.current, HEART_HEAL) > 0) {
            pickupsRef.current = pickupsRef.current.filter((o) => o.id !== p.id);
            sfxPop();
            spawnParticles(p.x + PICKUP_SIZE / 2, p.y + PICKUP_SIZE / 2, p.blockId, true, 4);
            syncHud();
          }
        } else {
          const added = addItem(invRef.current, p.blockId, p.count);
          if (added >= p.count) {
            pickupsRef.current = pickupsRef.current.filter((o) => o.id !== p.id);
            sfxPop();
            spawnParticles(p.x + PICKUP_SIZE / 2, p.y + PICKUP_SIZE / 2, p.blockId, false, 4);
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

      // ---- パーティクル更新 ----
      if (particlesRef.current.length > 0) {
        const next: typeof particlesRef.current = [];
        for (const p of particlesRef.current) {
          p.life -= dt;
          if (p.life <= 0) continue;
          if (p.dust) {
            // 土煙は重力でなく空気抵抗で漂って消える
            p.vx *= Math.max(0, 1 - 4 * dt);
            p.vy *= Math.max(0, 1 - 3 * dt);
          } else {
            p.vy = Math.min(14, p.vy + 22 * dt);
          }
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          next.push(p);
        }
        particlesRef.current = next;
      }
      for (const [k, at] of placedPopRef.current) {
        if (now - at > 200) placedPopRef.current.delete(k);
      }

      // 被弾の検知（HP が減っていたら赤フラッシュ＋揺れのトリガーにする）
      if (healthRef.current.hp < prevHpRef.current) hurtAtRef.current = now;
      prevHpRef.current = healthRef.current.hp;

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
      // 共有ワールド: 自分の変更は最大8秒に1回送り、他人の変更は約15秒ごとに取り込む
      const ws = worldSyncRef.current;
      if (ws.shared) {
        if (ws.loggedIn && now - ws.lastFlushAt >= 8000) flushWorldChanges();
        if (now - ws.lastPollAt >= 15000) pollWorld();
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
      // 共有ワールド: 生成地形にサーバーの差分を重ねる（ゲストも読める）
      const world = generateWorld(WORLD_SEED);
      let shared = false;
      let epoch = 0;
      try {
        const res = await fetch("/api/worldbox/world", {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(3500),
        });
        if (res.ok) {
          const data = (await res.json()) as { epoch?: unknown; diffs?: unknown };
          if (typeof data.epoch === "number" && data.diffs && typeof data.diffs === "object") {
            applyDiffs(world, data.diffs as Record<string, number>);
            shared = true;
            epoch = data.epoch;
          }
        }
      } catch {
        /* 共有に届かなければ生成地形だけで遊ぶ */
      }
      if (cancelled) return;
      installWorld(world.tiles);
      worldSyncRef.current = {
        shared,
        loggedIn,
        epoch,
        known: shared ? world.tiles.slice() : null,
        recentLocal: new Map(),
        lastFlushAt: performance.now(),
        lastPollAt: performance.now(),
      };
      setSharedMode(shared);
      const choice = chooseInitialSave(online, local, loggedIn);
      applyPlayerState(choice.state);
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
        flushWorldChanges(true);
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onHide);
      saveNow();
      putOnlineSave(true);
      flushWorldChanges(true);
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
    if (!slot || (slot.id !== TORCH && !BLOCKS[slot.id]?.placeable)) return;
    const frontX = body.face > 0 ? Math.floor(body.x + PLAYER_W + 0.2) : Math.floor(body.x - 0.2);
    const centerX = body.x + PLAYER_W / 2;
    const centerY = body.y + PLAYER_H / 2;
    const rows = [Math.floor(body.y + 0.9), Math.floor(body.y + PLAYER_H - 0.1), Math.floor(body.y + 0.2)];
    for (const ty of rows) {
      if (getTile(world, frontX, ty) === AIR && withinReach(centerX, centerY, frontX, ty)) {
        const placed =
          slot.id === TORCH
            ? placeTorch(world, invRef.current, frontX, ty)
            : placeTile(world, invRef.current, frontX, ty, slot.id, { x: body.x, y: body.y, w: PLAYER_W, h: PLAYER_H });
        if (placed) {
          sfxPlace();
          dirtyRef.current = true;
          lightDirtyRef.current = true;
          placedPopRef.current.set(`${frontX},${ty}`, performance.now());
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

    // カメラ（平滑追従＋向き方向への先読み＋着地の沈み。ワールド端でクランプ）
    const cx = body.x + PLAYER_W / 2;
    const cy = body.y + PLAYER_H / 2;
    const anim = playerAnimRef.current;
    const dtDraw = anim.lastDrawAt ? Math.min(0.05, (now - anim.lastDrawAt) / 1000) : 0.016;
    anim.lastDrawAt = now;
    // 着地したフレームだけ、潰れバネとカメラの沈みに初速を与える
    const landFx = landFxRef.current;
    if (landFx && landFx.at !== anim.landAt) {
      anim.landAt = landFx.at;
      anim.squash.x = Math.min(anim.squash.x, landingSquashY(landFx.fall));
      anim.squash.v = 0;
      anim.dip.x = Math.min(0.22, landFx.fall * 0.03);
      anim.dip.v = 0;
    }
    anim.squash = springStep(anim.squash, 1, 190, 14, dtDraw);
    anim.dip = springStep(anim.dip, 0, 130, 10, dtDraw);
    let targetX = cx + body.face * 1.1 - viewW / 2;
    let targetY = cy - viewH / 2;
    targetX = viewW >= WORLD_W ? (WORLD_W - viewW) / 2 : Math.max(0, Math.min(WORLD_W - viewW, targetX));
    targetY = viewH >= WORLD_H ? (WORLD_H - viewH) / 2 : Math.max(0, Math.min(WORLD_H - viewH, targetY));
    if (!anim.camInit || Math.abs(targetX - anim.camX) > viewW * 1.2 || Math.abs(targetY - anim.camY) > viewH * 1.2) {
      // 初回とテレポート直後は吸着させる（長いパンを避ける）
      anim.camX = targetX;
      anim.camY = targetY;
      anim.camInit = true;
    } else {
      anim.camX = damp(anim.camX, targetX, 7, dtDraw);
      anim.camY = damp(anim.camY, targetY, 9, dtDraw);
    }
    const camX = anim.camX;
    const camY = anim.camY + anim.dip.x;
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

    // 流れる雲（パララックス背景）
    drawClouds(ctx, camX, camY, vw, vh, tilePx, now);

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
        // 置いた直後のタイルは少し膨らんで跳ねる（ポップ）
        const popAt = placedPopRef.current.get(`${tx},${ty}`);
        const pop = popAt !== undefined && now - popAt < 130 ? 1 + 0.16 * (1 - (now - popAt) / 130) : 1;
        // 隙間対策: 位置をピクセルへスナップし、1px重ねて描く
        // （カメラの小数オフセットや反転描画でブロック間に継ぎ目を作らない）
        const px = Math.round((tx - camX) * tilePx);
        const py = Math.round((ty - camY) * tilePx);
        drawBlock(ctx, id, tx, ty, px, py, tilePx + 1, pop, now);
      }
    }

    // 落下中のブロック（動きは滑らかなまま、大きさだけ1px重ねる）
    for (const f of fallingRef.current) {
      drawBlock(ctx, f.blockId, f.x, Math.floor(f.y), (f.x - camX) * tilePx, (f.y - camY) * tilePx, tilePx + 1, 1, now);
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
        drawBlock(ctx, p.blockId, Math.floor(p.x), Math.floor(p.y), px, py, s, 1, now);
        if (p.count > 1) {
          ctx.fillStyle = "#fff";
          ctx.font = `700 ${Math.max(10, tilePx * 0.34)}px sans-serif`;
          ctx.textAlign = "right";
          ctx.fillText(String(p.count), px + s, py + s);
        }
      }
    }

    // 暗さ（光フィールドからタイルごとに引く。近傍平均で境目を滑らかにする）
    // キャラは暗くしない（暗がりでも自分と敵は見える、操作性優先）
    // 松明が勝っているタイルだけ、炎のゆらぎ（±5%）を描画時に乗せる（フィールドは作り直さない）
    const field = lightRef.current;
    if (field) {
      const phase = dayRef.current;
      const skyK = skyLevelAt(phase);
      const tSec = now / 1000;
      const lv = (x: number, y: number): number => {
        if (y < 0) return skyK;
        if (x < 0 || x >= WORLD_W || y >= WORLD_H) return 0;
        const idx = y * WORLD_W + x;
        const s = field.sky[idx] * skyK;
        const t = field.torch[idx];
        if (t <= s) return s;
        return Math.min(1, Math.max(s, t * torchLightFlicker(tSec, (x * 31 + y * 17) % 10)));
      };
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const l = (lv(tx, ty) * 2 + lv(tx - 1, ty) + lv(tx + 1, ty) + lv(tx, ty - 1) + lv(tx, ty + 1)) / 6;
          const a = (1 - l) * 0.86;
          if (a > 0.02) {
            ctx.fillStyle = `rgba(5,7,26,${a.toFixed(3)})`;
            ctx.fillRect((tx - camX) * tilePx - 0.5, (ty - camY) * tilePx - 0.5, tilePx + 1, tilePx + 1);
          }
        }
      }
    }

    // 敵
    for (const e of enemiesRef.current) {
      drawEnemy(ctx, e, (e.x - camX) * tilePx, (e.y - camY) * tilePx, tilePx, now);
    }

    // 撃破された敵の倒れ込み（回転しながら薄くなる）
    dyingRef.current = dyingRef.current.filter((d) => now - d.at < 320);
    for (const d of dyingRef.current) {
      const pose = flipDeathPose((now - d.at) / 320);
      const img = charImgRef.current?.jinrou;
      const size = tilePx * 1.5;
      ctx.save();
      ctx.translate((d.x + ENEMY_W / 2 - camX) * tilePx, (d.y + ENEMY_H / 2 - camY) * tilePx);
      ctx.rotate(pose.rot * d.face);
      ctx.globalAlpha = pose.alpha;
      if (texReady(img)) {
        ctx.drawImage(img, -size / 2, -size / 2, size, size);
      }
      ctx.restore();
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
          // ヒビは4段階: 段階が上がるごとに線の組が増える
          const stage = crackStage(t.progress);
          ctx.strokeStyle = "rgba(20,16,8,0.78)";
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          const line = (ax: number, ay: number, bx: number, by: number) => {
            ctx.moveTo(px + tilePx * ax, py + tilePx * ay);
            ctx.lineTo(px + tilePx * bx, py + tilePx * by);
          };
          if (stage >= 1) {
            line(0.5, 0.3, 0.44, 0.52);
            line(0.44, 0.52, 0.56, 0.68);
          }
          if (stage >= 2) {
            line(0.44, 0.52, 0.28, 0.62);
            line(0.56, 0.68, 0.74, 0.78);
            line(0.5, 0.3, 0.66, 0.22);
          }
          if (stage >= 3) {
            line(0.28, 0.62, 0.2, 0.86);
            line(0.66, 0.22, 0.8, 0.42);
            line(0.74, 0.78, 0.68, 0.95);
            line(0.44, 0.52, 0.4, 0.34);
          }
          if (stage >= 4) {
            line(0.2, 0.86, 0.38, 0.92);
            line(0.8, 0.42, 0.95, 0.5);
            line(0.4, 0.34, 0.22, 0.2);
            line(0.56, 0.68, 0.5, 0.9);
            line(0.3, 0.1, 0.5, 0.3);
          }
          ctx.stroke();
        }
      }
    }

    // 破片パーティクル（壊したブロックの欠片・回収の欠片）
    for (const p of particlesRef.current) {
      const px = (p.x - camX) * tilePx;
      const py = (p.y - camY) * tilePx;
      const s = Math.max(3, tilePx * 0.22);
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      if (p.dust) {
        // 土煙: 柔らかい円が少し膨らんで消える
        const grow = 1 + (1 - p.life / p.maxLife) * 0.9;
        ctx.fillStyle = "rgba(216,208,196,0.55)";
        ctx.beginPath();
        ctx.arc(px, py, s * 0.62 * grow, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.heart) {
        ctx.fillStyle = "#e5484d";
        ctx.fillRect(px, py, s, s);
      } else {
        const texKey = TEXTURE_KEY_BY_BLOCK[p.blockId];
        const tex = texKey ? texturesRef.current?.[texKey] : undefined;
        if (texReady(tex)) {
          ctx.drawImage(tex, px, py, s, s);
        } else {
          const def = BLOCKS[p.blockId];
          ctx.fillStyle = def?.colorDark ?? "#6e6e73";
          ctx.fillRect(px, py, s, s);
          ctx.fillStyle = def?.color ?? "#9a9aa0";
          ctx.fillRect(px, py, s, s * 0.55);
        }
      }
      ctx.restore();
    }

    // プレイヤー（標準AGOキャラ）。無敵時間中は点滅させる
    const invuln = gameTimeRef.current < healthRef.current.invulnUntil;
    if (!invuln || Math.floor(now / 90) % 2 === 0) {
      drawPlayer(ctx, (body.x - camX) * tilePx, (body.y - camY) * tilePx, tilePx, now);
    }

    // 死亡ポフ（倒れた場所で膨らんで消える）
    const dfx = deathFxRef.current;
    if (dfx && now - dfx.at < 380) {
      const pose = poofPose((now - dfx.at) / 380);
      const img = charImgRef.current?.ago;
      const size = tilePx * 1.5 * pose.scale;
      ctx.save();
      ctx.globalAlpha = pose.alpha;
      if (texReady(img)) {
        ctx.drawImage(
          img,
          (dfx.x + PLAYER_W / 2 - camX) * tilePx - size / 2,
          (dfx.y + PLAYER_H - camY) * tilePx - size,
          size,
          size,
        );
      }
      ctx.restore();
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
    const brain = enemyBrainRef.current.get(e.id);
    const phase = brain?.phase ?? e.id * 2;
    const bob = -walkBob(phase) * tilePx * 0.05;
    const feetX = px + (ENEMY_W * tilePx) / 2;
    const feetY = py + ENEMY_H * tilePx;
    if (texReady(img)) {
      // 公式の人狼あごむに（/img/jinrou.png）。プレイヤーと同程度の大きさ、足元アンカー、向き反転
      // 歩行は左右の揺れ、溜めは潰れ、突進は伸び、被弾は凹みバネで表す
      const size = tilePx * 1.5;
      const burning = !isNightPhase(dayRef.current); // 夜明けは燃焼中: 明滅させる
      const hitAgo = now - (enemyHitRef.current.get(e.id) ?? -10000);
      const gt = gameTimeRef.current;
      let squashY = brain?.squash.x ?? 1;
      let stretchX = 1;
      if (brain?.mode === "windup") {
        squashY *= telegraphSquashY(1 - Math.max(0, brain.until - gt) / ENEMY_WINDUP_SEC);
      } else if (brain?.mode === "lunge") {
        stretchX = 1.15;
        squashY *= 0.94;
      }
      ctx.save();
      ctx.translate(feetX, feetY + bob);
      ctx.rotate(enemyRock(e.vx, phase));
      ctx.scale(e.face * stretchX * (1 + (1 - squashY) * 0.7), squashY);
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

  const drawBlock = (ctx: CanvasRenderingContext2D, id: number, tx: number, ty: number, px: number, py: number, s: number, pop = 1, now = 0) => {
    const def = BLOCKS[id];
    if (!def) return;
    if (pop !== 1) {
      const ns = s * pop;
      px -= (ns - s) / 2;
      py -= (ns - s) / 2;
      s = ns;
    }
    if (id === TORCH) {
      // 松明: 棒＋炎。背景は塗らない（非固体）。炎はタイルごとに違う位相でゆらめく
      const seed = tx * 0.731 + ty * 1.317;
      const fl = torchFlameScale(now / 1000, seed);
      ctx.fillStyle = "rgba(255,176,66,0.16)";
      ctx.beginPath();
      ctx.arc(px + s / 2, py + s * 0.36, s * 0.52, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#8a5a2b";
      ctx.fillRect(px + s * 0.44, py + s * 0.42, s * 0.12, s * 0.52);
      ctx.save();
      ctx.globalAlpha = 0.82 + 0.18 * flickerNoise(now / 1700, seed + 2.4);
      ctx.fillStyle = "#ff9d2e";
      ctx.beginPath();
      ctx.ellipse(px + s / 2, py + s * 0.32, s * 0.16 * fl, s * 0.24 * fl, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffd76a";
      ctx.beginPath();
      ctx.ellipse(px + s / 2, py + s * 0.38, s * 0.08 * fl, s * 0.13 * fl, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    if (id === WORKBENCH) {
      // 作業台: 天板＋脚（下は空いた足場として描く）
      ctx.fillStyle = def.colorDark;
      ctx.fillRect(px + s * 0.08, py + s * 0.34, s * 0.1, s * 0.6);
      ctx.fillRect(px + s * 0.82, py + s * 0.34, s * 0.1, s * 0.6);
      ctx.fillStyle = def.color;
      ctx.fillRect(px, py + s * 0.12, s, s * 0.24);
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.fillRect(px, py + s * 0.3, s, s * 0.06);
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.fillRect(px + s * 0.18, py + s * 0.17, s * 0.3, s * 0.07);
      ctx.fillRect(px + s * 0.6, py + s * 0.17, s * 0.2, s * 0.07);
      return;
    }
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

  /**
   * プレイヤー: 公式あごむに画像（/img/nomal.png）を足元アンカーで描く。
   * 歩行の潰れ伸び・前傾・上下動、空中の伸びと傾き、着地バネ、被弾の赤フラッシュと揺れ、
   * 復活の出現フェード、手持ちアイテムのスイングをすべてここで重ねる（曲線は lib/worldbox/anim）。
   */
  const drawPlayer = (ctx: CanvasRenderingContext2D, px: number, py: number, tilePx: number, now: number) => {
    const body = bodyRef.current;
    if (!body) return;
    const size = tilePx * 1.5;
    const feetX = px + (PLAYER_W * tilePx) / 2;
    const feetY = py + PLAYER_H * tilePx;
    const face = body.face;
    const fwdRatio = Math.max(-1, Math.min(1, (body.vx * face) / RUN_SPEED));
    const phase = walkPhaseRef.current;
    const anim = playerAnimRef.current;

    // 姿勢: 地上は歩行サイクル、空中は伸び＋傾き。着地バネは常に乗る
    let squashY: number;
    let lean: number;
    let bob = 0;
    if (body.onGround) {
      const moving = Math.abs(body.vx) > 0.3;
      squashY = moving ? walkSquashY(phase) : 1;
      lean = moveLean(fwdRatio);
      bob = moving ? walkBob(phase) * size * 0.045 : Math.sin(now / 380) * size * 0.012;
    } else {
      const pose = airPose(body.vy, fwdRatio);
      squashY = pose.scaleY;
      lean = pose.tilt;
    }
    squashY *= anim.squash.x;
    const scaleX = 1 + (1 - squashY) * 0.55;

    // 掘り中は体ごと少し前のめりにする
    const digging = digRef.current !== null && pressModeRef.current === "dig";
    if (digging) lean += 0.07;

    // 被弾: 残り時間で揺れと赤みが引く
    const hurtK = Math.max(0, 1 - (now - hurtAtRef.current) / 220);
    const shakeX = hurtK > 0 ? Math.sin(now * 1.9) * hurtK * tilePx * 0.09 : 0;
    // ブロック破砕の反動: 一瞬だけ後ろへ引く
    const recK = Math.max(0, 1 - (now - breakAtRef.current) / 160);
    const recoilX = -face * recK * recK * tilePx * 0.1;
    // 復活直後の出現フェード
    const spawn = respawnPose((now - respawnAtRef.current) / 300);

    const img = charImgRef.current?.ago;
    ctx.save();
    ctx.translate(feetX + shakeX + recoilX, feetY - bob);
    ctx.rotate(lean * face);
    ctx.scale(face * scaleX * spawn.scale, squashY * spawn.scale);
    ctx.globalAlpha = spawn.alpha;
    if (texReady(img)) {
      ctx.drawImage(img, -size / 2, -size, size, size);
      if (hurtK > 0) {
        // 被弾の赤フラッシュ（同画像を赤く重ねる）
        ctx.globalAlpha = spawn.alpha * hurtK * 0.75;
        ctx.filter = "brightness(0.55) sepia(1) saturate(5) hue-rotate(-48deg)";
        ctx.drawImage(img, -size / 2, -size, size, size);
        ctx.filter = "none";
      }
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

    // 手持ちアイテム（選択中スロット）を体の前に描き、掘り/攻撃に同期して振る
    const slot = invRef.current.slots[selectedRef.current];
    if (slot && slot.count > 0) {
      let angle: number;
      if (digging && digRef.current) {
        angle = digSwingAngle(digRef.current.progress);
      } else if (now - attackAtRef.current < 350) {
        angle = attackSwingAngle((now - attackAtRef.current) / 350);
      } else {
        angle = ARM_REST_ANGLE + Math.sin(now / 500) * 0.05;
      }
      ctx.save();
      ctx.translate(feetX + shakeX + recoilX + face * size * 0.3, feetY - size * 0.44 - bob);
      ctx.scale(face, 1);
      ctx.rotate(angle);
      ctx.globalAlpha = spawn.alpha;
      drawHeldItem(ctx, slot.id, tilePx * 0.62, now);
      ctx.restore();
    }
  };

  /** 手持ちアイテムの小描画（ItemIcon と同じ色使い。pivot から前方へ伸ばして描く）。 */
  const drawHeldItem = (ctx: CanvasRenderingContext2D, id: number, s: number, now: number) => {
    if (id === WOODEN_PICKAXE || id === STONE_PICKAXE || id === COPPER_PICKAXE) {
      const head = id === WOODEN_PICKAXE ? "#a9743f" : id === STONE_PICKAXE ? "#9a9aa0" : "#e07f3f";
      ctx.lineCap = "round";
      ctx.strokeStyle = "#7a5230";
      ctx.lineWidth = s * 0.14;
      ctx.beginPath();
      ctx.moveTo(0, s * 0.3);
      ctx.lineTo(s * 0.55, -s * 0.25);
      ctx.stroke();
      ctx.strokeStyle = head;
      ctx.lineWidth = s * 0.16;
      ctx.beginPath();
      ctx.moveTo(s * 0.12, -s * 0.52);
      ctx.quadraticCurveTo(s * 0.6, -s * 0.6, s * 0.98, -s * 0.12);
      ctx.stroke();
      return;
    }
    if (id === SWORD) {
      ctx.lineCap = "round";
      ctx.strokeStyle = "#7a5230";
      ctx.lineWidth = s * 0.15;
      ctx.beginPath();
      ctx.moveTo(-s * 0.12, s * 0.34);
      ctx.lineTo(s * 0.14, s * 0.1);
      ctx.stroke();
      ctx.strokeStyle = "#e07f3f";
      ctx.lineWidth = s * 0.13;
      ctx.beginPath();
      ctx.moveTo(s * 0.02, s * 0.22);
      ctx.lineTo(s * 0.3, -s * 0.06);
      ctx.stroke();
      ctx.strokeStyle = "#e8e8ec";
      ctx.lineWidth = s * 0.14;
      ctx.beginPath();
      ctx.moveTo(s * 0.16, s * 0.02);
      ctx.lineTo(s * 0.95, -s * 0.5);
      ctx.stroke();
      return;
    }
    if (id === TORCH) {
      const fl = torchFlameScale(now / 1000, 0.37);
      ctx.fillStyle = "#8a5a2b";
      ctx.fillRect(s * 0.3, -s * 0.05, s * 0.11, s * 0.5);
      ctx.fillStyle = "#ff9d2e";
      ctx.beginPath();
      ctx.ellipse(s * 0.36, -s * 0.18, s * 0.15 * fl, s * 0.22 * fl, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffd76a";
      ctx.beginPath();
      ctx.ellipse(s * 0.36, -s * 0.13, s * 0.07 * fl, s * 0.11 * fl, 0, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    if (id === COPPER_INGOT) {
      ctx.fillStyle = "#e07f3f";
      ctx.strokeStyle = "#b35a24";
      ctx.lineWidth = Math.max(1, s * 0.05);
      ctx.beginPath();
      ctx.moveTo(s * 0.08, -s * 0.2);
      ctx.lineTo(s * 0.62, -s * 0.2);
      ctx.lineTo(s * 0.78, s * 0.22);
      ctx.lineTo(-s * 0.08, s * 0.22);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      return;
    }
    const texKey = TEXTURE_KEY_BY_BLOCK[id];
    const tex = texKey ? texturesRef.current?.[texKey] : undefined;
    if (texReady(tex)) {
      ctx.drawImage(tex, 0, -s / 2, s, s);
      return;
    }
    const color = BLOCKS[id]?.color ?? itemDef(id)?.color ?? "#888";
    ctx.fillStyle = color;
    ctx.fillRect(0, -s / 2, s, s);
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = Math.max(1, s * 0.05);
    ctx.strokeRect(0, -s / 2, s, s);
  };

  /** 流れる雲（平らな楕円の集まり。丘よりさらに遅く流れ、夜は薄くなる）。 */
  const drawClouds = (ctx: CanvasRenderingContext2D, camX: number, camY: number, vw: number, vh: number, tilePx: number, now: number) => {
    const sky = skyLevelAt(dayRef.current);
    const alpha = 0.10 + 0.65 * sky;
    ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
    const drift = now / 1000;
    const spanTiles = 340; // ワールド幅＋余白（巻き戻し用）
    for (let i = 0; i < 7; i++) {
      const h1 = hash2(i, 77);
      const h2 = hash2(i, 78);
      const worldX = h1 * 300 + drift * (0.14 + h2 * 0.1);
      const cx = ((((worldX % spanTiles) + spanTiles) % spanTiles) - 20 - camX * 0.25) * tilePx;
      if (cx < -tilePx * 12 || cx > vw + tilePx * 4) continue;
      const cy = (2.2 + h2 * 6 - camY * 0.25) * tilePx;
      if (cy < -tilePx * 2 || cy > vh) continue;
      const w = tilePx * (3.4 + h1 * 3.4);
      const hgt = tilePx * (0.55 + h2 * 0.35);
      ctx.beginPath();
      ctx.ellipse(cx, cy, w * 0.5, hgt, 0, 0, Math.PI * 2);
      ctx.ellipse(cx - w * 0.28, cy + hgt * 0.25, w * 0.3, hgt * 0.7, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + w * 0.3, cy + hgt * 0.2, w * 0.32, hgt * 0.75, 0, 0, Math.PI * 2);
      ctx.fill();
    }
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
    const w = worldRef.current;
    // 作業台へのタップ候補（短く離したら「つくる」を開く。長押しは掘って回収）
    benchTapRef.current = w && getTile(w, t.tx, t.ty) === WORKBENCH ? { x: t.tx, y: t.ty, at: performance.now() } : null;
    // 操作モードを押し始めの対象で固定する（この長押しの間は変わらない）
    if (w) {
      const slot = invRef.current.slots[selectedRef.current];
      const hasPlaceable = !!slot && (slot.id === TORCH || !!BLOCKS[slot.id]?.placeable);
      const pt = { x: t.tx + 0.5, y: t.ty + 0.5 };
      const enemyThere = enemiesRef.current.some((o) => pt.x >= o.x - 0.2 && pt.x <= o.x + 1.1 && pt.y >= o.y - 0.2 && pt.y <= o.y + 1.1);
      pressModeRef.current = pressModeFor(getTile(w, t.tx, t.ty), hasPlaceable, enemyThere);
      lastPlaceRef.current = { tx: t.tx, ty: t.ty };
    }
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
      pressModeRef.current = null;
      lastPlaceRef.current = null;
      // 作業台を短くタップしたら「つくる」を開く（掘り切る前の短押しだけ）
      if (benchTapRef.current && performance.now() - benchTapRef.current.at < 260) {
        setCraftOpen(true);
      }
      benchTapRef.current = null;
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
    `深さ ${hud.depth} m ・ ${hud.night ? "夜" : "昼"} ・ 選択中: ${selectedName}` +
    (selectedSlot && !isTool(selectedSlot.id) ? `（所持 ${selectedSlot.count}）` : "") +
    (hud.gate ? ` ・ ${hud.gate}` : "") +
    (sharedMode ? " ・ 共有ワールド" : onlineMode ? " ・ オンライン保存" : "");

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
        <p className="muted">掘って、作って、暗がりで生き延びる2Dサンドボックス。</p>
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
            {holdBtn("置く", (d) => { touchRef.current.place = d; }, "向いている方向に置く")}
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
              const owned = isTool(recipe.output) && countOf(invForPanel, recipe.output) > 0;
              return (
                <div key={recipe.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                  <div style={{ width: 34, flex: "0 0 auto" }}><ItemIcon id={recipe.output} size={30} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>
                      {recipe.name}
                      {(recipe.outputCount ?? 1) > 1 ? ` ×${recipe.outputCount}` : ""}
                    </div>
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
          持ち物がいっぱいです（5枠）
        </p>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 14, flexWrap: "wrap" }}>
        <span className="muted" style={{ fontSize: 13, alignSelf: "center" }}>シード: {seedShown}</span>
        <button type="button" style={btn} onClick={() => { syncHud(); setCraftOpen((v) => !v); }}>つくる（C）</button>
        {!confirmNew ? (
          <button type="button" style={btn} onClick={() => setConfirmNew(true)}>進行をリセット</button>
        ) : (
          <>
            <button
              type="button"
              style={{ ...btn, background: "#c0392b", borderColor: "#c0392b", color: "#fff" }}
              onClick={() => {
                setConfirmNew(false);
                try { localStorage.removeItem(SAVE_KEY); } catch { /* noop */ }
                applyPlayerState(null);
                saveNow();
                putOnlineSave();
              }}
            >
              本当にリセットする
            </button>
            <button type="button" style={btn} onClick={() => setConfirmNew(false)}>やめる</button>
          </>
        )}
      </div>

      <p className="muted" style={{ textAlign: "center", fontSize: 13, maxWidth: 860, margin: "14px auto 0" }}>
        PC: A/D・←/→ 移動、Space/W/↑ ジャンプ、S/↓ 速落下・すり抜け、J 掘る、K 置く、1〜5 枠、C つくる。
        タッチ: 左スティック＋右下ボタン。
        暗い場所に人狼あごむに。松明の周りには出ない。
        原木と葉は上に乗れて、横と下は通り抜ける。作業台は短く触ると「つくる」。
        石は木のツルハシ、鉱石は石のツルハシ、深い石は銅のツルハシ。草・土・砂・葉は崩れる。持ち物5枠。
      </p>
    </div>
  );
}
