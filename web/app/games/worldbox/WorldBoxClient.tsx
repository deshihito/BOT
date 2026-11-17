"use client";
// AGO WORLD BOX（見下ろし型・共有ワールド）。
// 世界は固定シード＋座標の純関数で決まるチャンク式マップで、広さは実質
// 無制限。全員が同じ場所を歩く。初期スポーンはサーバーがランダムに決める。
// 移動は8方向フリー（左下の固定式スティック＋WASD）、他プレイヤーはプレゼンス API 経由で
// アバター＋名前つきで表示される（同時接続）。セーブは空間＋位置（v6）。
// ロビーは別空間（図形の和集合のホール＋ショップ翼2階）で、ワープパッドと
// ≡ メニューで行き来する。ロビーの描画はピクセル固定（整数座標・補間オフ）。
// ゲームループと描画は canvas + refs で回し、React state は HUD 表示だけに使う。
// 純粋ロジックは lib/worldbox/ に分離（生成・移動・プレゼンス・保存）。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  CHUNK_SIZE, MAP_SEED, T_DIRT, T_GRASS, T_ROCK, T_SAND, T_SNOW, T_SNOW_TREE, T_TREE, T_WATER,
  generateChunk, mapTileAt, rectBounds, tileAt, worldBounds, type TopDownMap,
} from "@/lib/worldbox/mapgen";
import { pickRandomSpawn } from "@/lib/worldbox/spawn";
import { DASH_SPEED, PLAYER_RADIUS, SWIM_DASH_SPEED, SWIM_SPEED, WALK_SPEED, circleHitsSolid, findFreeNear, isWaterAt, stepMove } from "@/lib/worldbox/move";
import { isNightPhase, nightAmount, phaseAtTime } from "@/lib/worldbox/daynight";
import { mobById, mobOccupiesTile, type PlacedMob } from "@/lib/worldbox/mobs";
import { PATTERN_DEF, createBehaviorState, isBossMob, locomotionFor, locomotionPose, stepMobBehavior, type BehaviorEvent, type MobBehaviorState, type MobPatternId } from "@/lib/worldbox/mob-behavior";
import {
  MOB_ATTACK_RANGE, MOB_RESPAWN_MS, MOB_SPRITE, MOB_SPRITE_FALLBACK, attackTarget, knockbackTarget, mobBlockedTiles, mobDistance, mobFootprintTiles,
  mobHpNow, mobKeyOf, mobRespawnDelayMs, parseMobState, visibleMobs, type MobState,
} from "@/lib/worldbox/combat";
import { advanceWalkPhase, attackSwingAngle, damp, moveLean, stepBeatIndex, walkBob, walkSquashY } from "@/lib/worldbox/anim";
import {
  HITSTOP_HIT_MS, HITSTOP_HURT_MS, HITSTOP_KILL_MS, WHIFF_ALPHA_SCALE, burstPaletteFor, createFxSystem, createHitstop,
  createShake, fxLifeRatio, hitstopActiveAt, phaseKind, popProgress, popScale, shakeOffsetAt,
  slashAlpha, spawnAmbient, spawnBurst, spawnMobFx, startHitstop, startShake, stepFx, swingProgress, weatherAmbientKind, weatherBlendAt,
  type FxBurstKind, type FxShake, type FxSystem, type HitstopState,
} from "@/lib/worldbox/fx";
import type { SkillFxEffect } from "@/lib/worldbox/fx";
import { skillFxProgress, skillFxStage, spawnSkillFx, thunderBoltPoints } from "@/lib/worldbox/fx";
import {
  activeSkillFor, masteryRankOf, roleById, skillCooldownLeft, SKILLS,
  SCOUT_STAMINA_MULT,
} from "@/lib/worldbox/roles";
import { clockOffsetEstimate, type PresenceEntry } from "@/lib/worldbox/presence";
import { createPollGuard, type PollGuard } from "@/lib/poll-guard";
import { isWsHealthy, presencePollDue } from "@/lib/worldbox/realtime-poll";
import { notifyEconomyApplied } from "@/lib/worldbox/economy-push";
import { notifyGuildBoardChanged, notifyGuildRequestsChanged } from "@/lib/worldbox/guild-board-push";
import { notifyGuildShopChanged } from "@/lib/worldbox/guild-shop-push";
import { GUILD_PLOT_ANCHORS } from "@/lib/worldbox/guild-shop";
import {
  STAMINA_MAX, canDash, createStamina, createTapTracker, isStickDash, registerKeyTap, rescueStamina,
  staminaGaugeVisible, stepStamina, type StaminaState, type StaminaUse, type TapTracker,
} from "@/lib/worldbox/stamina";
import { createRemoteTrack, stepRemoteTrack, updateRemoteTrack, type RemoteTrack } from "@/lib/worldbox/remote";
import type { NationView, NationsResponse } from "@/lib/worldbox/nations";
import {
  L_PLAZA, L_SAND, L_VOID,
  LOBBY_ENTRY, LOBBY_FLOOR_FALLBACK, LOBBY_FLOOR_SPRITE, LOBBY_H, LOBBY_STAIRS_DOWN, LOBBY_STAIRS_UP,
  LOBBY_DOWN_LANDING, LOBBY_UP_LANDING, LOBBY_W, LOBBY_WARP_PAD,
  buildLobby, lobbyTileAt, stationArcadeNear, stationGenreNear, stationNear, RACETRACK, type LobbyData, type LobbyObject, type LobbyStation,
} from "@/lib/worldbox/lobby";
import {
  COAT_COLORS, RACE_DURATION_MS, generateRaceCore, horseTrackPose, scheduleAt, type RaceCore,
} from "@/lib/worldbox/racing";
import {
  LOBBY2_H, LOBBY2_W, LOBBY3_H, LOBBY3_W,
  buildLobby2, buildLobby3, floorWarpAt, lobby2TileAt, lobby3TileAt, type LobbyFloorSpace,
} from "@/lib/worldbox/lobby-floors";
import { genreById, type ShopGenreId } from "@/lib/worldbox/shops";
import { TENT_MAX_TIER, TENT_TIERS, buildTent, tentEntryFor, tentExitFor, tentTileAt } from "@/lib/worldbox/tent";
import {
  buildCaveLayer, buildDungeonFloor, buildRuins, dungeonHpScale, lightRadiusTiles, makeInstanceSpace, parseInstanceSpace,
  placedLightRadiusTiles,
  type CaveLayer, type DungeonFloorData, type RuinsMap,
} from "@/lib/worldbox/instances";
import { EVENT_DUNGEON_ENTRANCE } from "@/lib/worldbox/events";
import { SEASON_NAMES, seasonDaysLeft, seasonOf } from "@/lib/worldbox/seasons";
import { biomeAt, structureById, structuresForChunk, type PlacedStructure } from "@/lib/worldbox/maplogic";
import { nearestEntrances, type CompassTarget } from "@/lib/worldbox/compass";
import {
  objectRespawned, objectsForChunk, specialObjectById, surfaceObjectAt, surfaceSolidTilesInRect,
} from "@/lib/worldbox/objects";
import { fishingSpotAt } from "@/lib/worldbox/fishing";
import { parseBoardPosts, type BoardPost } from "@/lib/worldbox/board";
import { parseSave, serializeSave, type SaveSpace } from "@/lib/worldbox/save";
import { chooseInitialSave } from "@/lib/worldbox/save-source";
import {
  actionForTile, blockHpFraction, cropStage, floorSpeedMultiplier, isFloorItem, isFlowerPotItem, isGateItem, isOverrideActive, isSeatItem, isShelfItem, isSignItem, isWellItem, parseTileOverride, placedBlockSolid, placedStationKinds, terrainHpFraction, tileKey, tileView,
  type TileActionKind, type TileOverridesMap,
} from "@/lib/worldbox/tiles";
import { CROPS, ITEMS, itemById } from "@/lib/worldbox/items";
import { HP_MAX, HUNGER_MAX, countItem, maxHpFor, toolDurabilityFraction, type AdventureRoleId, type ItemSlot, type PlayerProfile, type SlotRef } from "@/lib/worldbox/profile";
import { hazardDamageFor, pvpSpaceAllowed, PVP_ATTACK_MAX_DISTANCE } from "@/lib/worldbox/vitals";
import { isStallItem } from "@/lib/worldbox/stalls";
import {
  containerCapacity, isContainerItem, type ContainerSlotRef,
} from "@/lib/worldbox/containers";
import { isMachineItem } from "@/lib/worldbox/machines";
import { DUNGEON_TILE_SRC, FARM_SPRITE_SRC, LOBBY_SPRITE_SRC, loadDungeonTiles, loadFarmSprites, loadLobbySprites, loadMobSprites, loadTextures } from "@/lib/worldbox/textures";
import { preloadImages, transitionAlpha, transitionDone, transitionSwapDue, SPRITE_PRELOAD_TIMEOUT_MS, TRANSITION_OVERLAY_RGB, type TransitionKind } from "@/lib/worldbox/transition";
import { isStickTouch, stickBase, stickVector } from "@/lib/worldbox/stick";
import { wbHudMetrics, wbLayoutMode } from "@/lib/worldbox/layout";
import {
  AFFORDANCE_RING_RGB, DENIED_RING_RGB, deniedFeedback, isWithinAffordanceRange,
  nudgeBobPx, nudgeRingAlpha, stickKnobRadius,
} from "@/lib/worldbox/affordance";
import {
  bgmSceneFor, footstepMaterialFor, loadWbSoundSettings, playWbSe, playWbStep, saveWbSoundSettings, seForFxBurst, setWbBgmScene,
  setWbBgmTension, stopWbBgm, tensionFor, unlockWbAudio, type WbSoundSettings,
} from "@/lib/worldbox/sound";
import { useGamesNav } from "../GamesShell";
import WorldBoxCasinoPanel from "./WorldBoxCasinoPanel";
import WorldBoxRacingPanel from "./WorldBoxRacingPanel";
import WorldBoxArenaPanel from "./WorldBoxArenaPanel";
import WorldBoxArcadePanel from "./WorldBoxArcadePanel";
import { getWebGame } from "@/lib/games-catalog";
import WorldBoxMachinePanel from "./WorldBoxMachinePanel";
import WorldBoxEconomyPanel from "./WorldBoxEconomyPanel";
import WorldBoxGuildBoardPanel from "./WorldBoxGuildBoardPanel";
import WorldBoxGuildShopPanel from "./WorldBoxGuildShopPanel";
import { ItemSlot as ItemSlotView, ItemSlotGrid } from "./ItemSlotGrid";

const SAVE_KEY = "ago-worldbox-save-v6";
/** 1タイルの表示サイズ（CSS px）。 */
const TILE = 44;
/** アバターの表示幅（タイル比）。 */
const AVATAR_TILES = 1.3;

const TILE_TEXTURE: Record<number, string> = {
  [T_WATER]: "water",
  [T_SAND]: "sand",
};
/** ダンジョン流用タイル（/img/worldbox/*.png、64×64 ピクセルアート）。 */
const TILE_DUNGEON: Record<number, string> = {
  [T_GRASS]: "grass",
  [T_DIRT]: "dirt",
  [T_TREE]: "tree",
  [T_ROCK]: "rock",
  [T_SNOW]: "snow",
  [T_SNOW_TREE]: "snowTree",
};
const TILE_FALLBACK: Record<number, string> = {
  [T_GRASS]: "#57a639",
  [T_WATER]: "#3a7cb4",
  [T_SAND]: "#ddd29a",
  [T_TREE]: "#57a639",
  [T_ROCK]: "#8d8d93",
  [T_DIRT]: "#8a5a2b",
  [T_SNOW]: "#eef3f6",
  [T_SNOW_TREE]: "#eef3f6",
};
/** ミニマップの地形色。 */
const MINIMAP_COLOR: Record<number, string> = {
  [T_GRASS]: "#57a639",
  [T_WATER]: "#3a7cb4",
  [T_SAND]: "#ddd29a",
  [T_TREE]: "#2f6121",
  [T_ROCK]: "#8d8d93",
  [T_DIRT]: "#8a5a2b",
  [T_SNOW]: "#f4f8fa",
  [T_SNOW_TREE]: "#9fc4bb",
};
/** ミニマップ: プレイヤー中心の周辺図。キャンバス解像度と表示範囲（タイル）。 */
const MINIMAP_PX = 256;
const MINIMAP_TILES = 128;
/** ミニマップ上の1タイルの大きさ（256px / 128タイル）。 */
const MINIMAP_SCALE = MINIMAP_PX / MINIMAP_TILES;
/** 開拓のコンパスの対象色（洞窟=橙、ダンジョン=紫）。 */
const COMPASS_CAVE_COLOR = "#e8933a";
const COMPASS_DUNGEON_COLOR = "#b07fe8";

/**
 * 開拓のコンパスの対象をミニマップへ描く: 範囲内なら入口の位置に
 * マーカー、範囲外なら端に方向矢印（対象への向きに回転した三角）。
 */
function drawCompassOnMinimap(
  mctx: CanvasRenderingContext2D,
  target: CompassTarget | null,
  color: string,
  ox: number,
  oy: number,
  px: number,
  py: number,
): void {
  if (!target) return;
  const mx = (target.x - ox) * MINIMAP_SCALE;
  const my = (target.y - oy) * MINIMAP_SCALE;
  if (mx >= 4 && my >= 4 && mx <= MINIMAP_PX - 4 && my <= MINIMAP_PX - 4) {
    mctx.fillStyle = color;
    mctx.strokeStyle = "rgba(255,255,255,0.9)";
    mctx.lineWidth = 1.5;
    mctx.beginPath();
    mctx.arc(mx, my, 3.4, 0, Math.PI * 2);
    mctx.fill();
    mctx.stroke();
    return;
  }
  const dx = target.x - px;
  const dy = target.y - py;
  const m = Math.max(Math.abs(dx), Math.abs(dy)) || 1;
  const ex = MINIMAP_PX / 2 + (dx / m) * (MINIMAP_PX / 2 - 11);
  const ey = MINIMAP_PX / 2 + (dy / m) * (MINIMAP_PX / 2 - 11);
  mctx.save();
  mctx.translate(ex, ey);
  mctx.rotate(Math.atan2(dy, dx));
  mctx.fillStyle = color;
  mctx.strokeStyle = "rgba(0,0,0,0.65)";
  mctx.lineWidth = 1;
  mctx.beginPath();
  mctx.moveTo(6, 0);
  mctx.lineTo(-4, -4);
  mctx.lineTo(-4, 4);
  mctx.closePath();
  mctx.fill();
  mctx.stroke();
  mctx.restore();
}

/** 開拓のコンパスの HUD 1行分（矢印の回転と距離）を直接書き換える。 */
function updateCompassHud(
  arrowEl: HTMLSpanElement | null,
  distEl: HTMLSpanElement | null,
  target: CompassTarget | null,
  px: number,
  py: number,
): void {
  if (arrowEl) {
    if (!target) {
      arrowEl.style.opacity = "0.25";
    } else {
      arrowEl.style.opacity = "1";
      const deg = (Math.atan2(target.y - py, target.x - px) * 180) / Math.PI;
      arrowEl.style.transform = `rotate(${deg.toFixed(1)}deg)`;
    }
  }
  if (distEl) {
    distEl.textContent = target ? String(Math.round(Math.hypot(target.x - px, target.y - py))) : "—";
  }
}

/** マップ表示モード（周辺を大きく見る）のキャンバス解像度と表示範囲。 */
const BIGMAP_SIZE = 512;
const BIGMAP_TILES = 256;
const BIGMAP_SCALE = BIGMAP_SIZE / BIGMAP_TILES;

type PlayerState = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  face: 1 | -1;
  phase: number;
};

type OtherRender = {
  /** 描画位置のトラック（スナップショット予測へバネで寄せる）。 */
  track: RemoteTrack;
  phase: number;
};

/** 移動キー（ダッシュの2度押し判定の対象）。 */
const MOVE_KEYS = new Set(["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"]);

function texReady(img: HTMLImageElement | undefined): img is HTMLImageElement {
  return !!img && img.complete && img.naturalWidth > 0;
}

/** ひび割れの折れ線（タイル内 0..1 の相対座標）。段階ごとに先頭から増える。 */
const BLOCK_CRACK_LINES: readonly (readonly (readonly [number, number])[])[] = [
  [[0.16, 0.08], [0.34, 0.3], [0.29, 0.5], [0.47, 0.68]],
  [[0.86, 0.18], [0.66, 0.38], [0.73, 0.56], [0.56, 0.8]],
  [[0.18, 0.86], [0.42, 0.7], [0.6, 0.88], [0.82, 0.74]],
];

/**
 * 設置ブロックのひび割れ描画（HP制）: 残り HP 割合が下がるほど
 * 線の本数と濃さが増える。形はタイル座標から決定的にずらし、
 * 毎フレーム同じ見た目にする。
 */
function drawBlockCracks(
  ctx: CanvasRenderingContext2D,
  bx: number,
  by: number,
  tx: number,
  ty: number,
  hpFrac: number,
) {
  const dmg = 1 - hpFrac;
  if (dmg <= 0) return;
  const stage = dmg < 0.34 ? 1 : dmg < 0.67 ? 2 : 3;
  const jitter = (Math.abs(Math.sin(tx * 127.1 + ty * 311.7) * 43758.5453) % 1 - 0.5) * 0.07;
  ctx.save();
  ctx.strokeStyle = `rgba(14,10,8,${0.34 + 0.18 * stage})`;
  ctx.lineWidth = 1.3;
  ctx.lineJoin = "round";
  for (let i = 0; i < stage; i++) {
    const line = BLOCK_CRACK_LINES[i];
    ctx.beginPath();
    for (let j = 0; j < line.length; j++) {
      const px = bx + (line[j][0] + jitter) * TILE;
      const py = by + (line[j][1] + jitter) * TILE;
      if (j === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.restore();
}


const NATION_ERROR_LABEL: Record<string, string> = {
  already_in_nation: "既に国に所属しています",
  nation_exists: "そのサーバーの国は既にあります",
  no_free_tile: "首都を置ける空き地がありません",
  not_owner: "建国はサーバーのオーナーのみです",
  not_member: "そのサーバーのメンバーではありません",
  guilds_scope_required: "サーバー情報の取得に再ログインが必要です",
  guilds_unavailable: "サーバー情報を取得できませんでした",
  nation_not_found: "国が見つかりません",
  nation_private: "非公開の国です",
  not_in_nation: "国に所属していません",
  king_must_transfer_or_disband: "国民がいる間、王は離脱できません",
  not_at_guild_board: "ギルドボードの前で操作してください",
  unauthorized: "ログインが必要です",
  forbidden: "その権限がありません",
};

/** タイル行為の失敗ラベル（断片のみ）。 */
/** モブの色（被弾/死亡エフェクト用）。描画本体は素材スプライト（MOB_SPRITE）が正で、これは色だけを持つ。 */
const MOB_STYLE: Record<string, { body: string }> = {
  mouse: { body: "#9a8f85" },
  chicken: { body: "#f2ede2" },
  rabbit: { body: "#e8e2d6" },
  frog: { body: "#69a84f" },
  crab: { body: "#d96b4a" },
  bee: { body: "#e8c33c" },
  slime: { body: "#6fc46a" },
  pig: { body: "#e8a0b4" },
  sheep: { body: "#ddd6c8" },
  cow: { body: "#efe9dd" },
  deer: { body: "#b0824f" },
  horse: { body: "#8a6844" },
  boar: { body: "#7a5c40" },
  wolf: { body: "#8d939e" },
  spider: { body: "#4c4453" },
  skeleton: { body: "#e9e6da" },
  bear: { body: "#6f5138" },
  golem: { body: "#8d9291" },
  treant: { body: "#5d7a3c" },
  sea_serpent: { body: "#3f7f9e" },
  giant_golem: { body: "#7c8382" },
  giant: { body: "#c9a186" },
  ancient_turtle: { body: "#5f7f5a" },
  world_dragon: { body: "#7a4a8c" },
  cat: { body: "#c9a06a" },
  dog: { body: "#a97c50" },
  duck: { body: "#f0ead8" },
  goat: { body: "#d8d2c4" },
  fox: { body: "#d97c3c" },
  tanuki: { body: "#8a6844" },
  bird_blue: { body: "#5a9ec9" },
  crow: { body: "#3a3f4a" },
  owl: { body: "#7a6248" },
  penguin: { body: "#44506a" },
  butterfly: { body: "#c97ab8" },
  ladybug: { body: "#d94a3c" },
  snail: { body: "#b8a86a" },
  fish_blue: { body: "#4a86c9" },
  fish_orange: { body: "#e07c3c" },
  jellyfish: { body: "#d98ac9" },
  octopus: { body: "#b85a7a" },
  mushroom: { body: "#d96a5a" },
  werewolf: { body: "#6a5a8c" },
};
/** モブ被弾/死亡エフェクトの色（本体色に寄せる）。 */
const MOB_FX_COLOR: Record<string, string> = Object.fromEntries(
  Object.entries(MOB_STYLE).map(([id, s]) => [id, s.body]),
);

const TILE_ERROR_LABEL: Record<string, string> = {
  tool_required: "道具が必要",
  tile_blocked: "そこではできない",
  not_owner: "他人のもの",
  not_ready: "まだ育っていない",
  no_crop: "作物がない",
  unknown_seed: "種が不正",
  unknown_block: "ブロックが不正",
  no_block: "ブロックがない",
  on_capital: "首都には置けない",
  not_enough_items: "足りない",
  world_frozen: "いまは変更できない（凍結中）",
  too_far: "遠すぎる",
  depleted: "もう無い",
  needs_pickaxe: "ツルハシが必要",
  needs_golden_key: "金の鍵が必要",
  pickaxe_tier: "ツルハシが弱い",
  not_at_onsen: "温泉が遠い",
  unauthorized: "ログインが必要",
  tiles_unavailable: "いま使えない",
  not_empty: "中身が入っている",
  no_container: "収納がない",
  containers_unavailable: "いま使えない",
};

/** アイテムのドット絵アイコン（無いアイテムは名前ラベルのみで出す）。 */
function ItemIcon({ id, size = 22 }: { id: string; size?: number }) {
  const def = itemById(id);
  if (!def?.icon) return null;
  return (
    <img
      src={def.icon}
      alt=""
      width={size}
      height={size}
      draggable={false}
      style={{ imageRendering: "pixelated", flexShrink: 0, display: "block", margin: "0 auto" }}
    />
  );
}

/**
 * スロットの中身: スプライトのみで出す（名前テキストはスロットに置かない）。
 * アイコンの無いアイテムは枠だけ、個数は右下のバッジ。
 * 親ボタンは position: relative 前提。
 */
function SlotContent({ slot, durFrac }: { slot: ItemSlot; durFrac?: number | null }) {
  if (!slot) return null;
  const def = itemById(slot.id);
  return (
    <>
      {def?.icon ? (
        <img
          src={def.icon}
          alt=""
          width={26}
          height={26}
          draggable={false}
          style={{ imageRendering: "pixelated", display: "block" }}
        />
      ) : (
        <span
          aria-hidden
          style={{ width: 18, height: 18, borderRadius: 4, border: "1px dashed rgba(255,255,255,0.45)", display: "block" }}
        />
      )}
      <span
        aria-hidden
        style={{
          position: "absolute", right: 2, bottom: 1, fontSize: 10, fontWeight: 700,
          lineHeight: 1, color: "#fff", textShadow: "0 1px 2px rgba(0,0,0,0.9)", pointerEvents: "none",
        }}
      >
        {slot.count}
      </span>
      {durFrac !== null && durFrac !== undefined && durFrac < 1 && (
        // 道具の耐久バー（使用中の1本の残量。満タンでは出さない）
        <span
          aria-hidden
          style={{
            position: "absolute", left: 3, right: 3, bottom: 2, height: 3, borderRadius: 2,
            background: "rgba(0,0,0,0.65)", pointerEvents: "none", overflow: "hidden",
          }}
        >
          <span
            style={{
              display: "block", height: "100%",
              width: `${Math.round(Math.max(0, Math.min(1, durFrac)) * 100)}%`,
              background: durFrac > 0.5 ? "#7ed957" : durFrac > 0.25 ? "#f2c53c" : "#e2483a",
            }}
          />
        </span>
      )}
    </>
  );
}

const EMPTY_NATIONS: NationsResponse = {
  nations: [], warMarks: {}, me: null, playerNations: {}, loggedIn: false, myGuilds: [], guildsScopeRequired: false,
};

/** 足元に平置きで描くロビースプライト（上に立てるもの）。 */
const FLAT_LOBBY_SPRITES = new Set(["warp_pad", "stairs", "tapestry"]);

/** 地表オブジェクトの鉱脈の色（洞窟内の描画と同じ色づかい）。 */
const SURFACE_VEIN_COLORS: Record<string, string> = {
  copper_vein: "#c47b4a",
  coal_vein: "#3a3a42",
  rare_vein: "#e8c85a",
  crystal_cluster: "#9fe8ff",
};

/**
 * 地表オブジェクトをタイル内にフラットな形で描く（洞窟の鉱脈・宝箱と
 * 同じ様式: 単色＋簡単な形）。sx/sy はタイル左上、tile は一辺 px。
 * spent=true（一回きりを使い終わった）は薄く描いて「残っているが
 * 恵みは無い」ことを示す。
 */
function drawSurfaceObject(
  ctx: CanvasRenderingContext2D,
  objectId: string,
  sx: number,
  sy: number,
  tile: number,
  spent: boolean,
  now: number,
) {
  const u = tile / 44;
  ctx.save();
  if (spent) ctx.globalAlpha = 0.45;
  const cx = sx + tile / 2;
  const ground = sy + tile * 0.82;
  switch (objectId) {
    case "berry_bush":
    case "herb_patch":
    case "mushroom_patch":
    case "flower_meadow": {
      if (objectId === "flower_meadow") {
        const cols = ["#e87aa8", "#ffd23e", "#ffffff", "#b48ce8"];
        for (let i = 0; i < 7; i++) {
          const fx = sx + tile * (0.18 + 0.64 * ((i * 37) % 10) / 10);
          const fy = sy + tile * (0.3 + 0.5 * ((i * 53) % 10) / 10);
          ctx.fillStyle = "#3e7d2c";
          ctx.fillRect(fx - 1, fy, 2, tile * 0.14);
          ctx.fillStyle = cols[i % cols.length];
          ctx.beginPath();
          ctx.arc(fx, fy - 2, 3 * u, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      if (objectId === "mushroom_patch") {
        ctx.fillStyle = "#e8dcc4";
        ctx.fillRect(cx - 7 * u, ground - 9 * u, 4 * u, 9 * u);
        ctx.fillRect(cx + 3 * u, ground - 7 * u, 4 * u, 7 * u);
        ctx.fillStyle = "#b0483e";
        ctx.beginPath();
        ctx.arc(cx - 5 * u, ground - 9 * u, 6 * u, Math.PI, 0);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx + 5 * u, ground - 7 * u, 5 * u, Math.PI, 0);
        ctx.fill();
        break;
      }
      // 茂み・群生: 緑の塊＋実や葉の差し色
      ctx.fillStyle = objectId === "berry_bush" ? "#2f6121" : "#3e7d2c";
      ctx.beginPath();
      ctx.arc(cx - 8 * u, ground - 6 * u, 8 * u, 0, Math.PI * 2);
      ctx.arc(cx + 8 * u, ground - 6 * u, 8 * u, 0, Math.PI * 2);
      ctx.arc(cx, ground - 12 * u, 9 * u, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = objectId === "berry_bush" ? "#e5484d" : "#a8c256";
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.arc(cx + (i - 2) * 6 * u, ground - (6 + (i % 3) * 4) * u, 2.2 * u, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "beehive": {
      ctx.fillStyle = "#d9a441";
      ctx.beginPath();
      ctx.ellipse(cx, ground - 12 * u, 9 * u, 11 * u, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#a87c2a";
      ctx.lineWidth = 2;
      for (const dy of [-16, -10, -4]) {
        ctx.beginPath();
        ctx.moveTo(cx - 8 * u, ground + dy * u);
        ctx.lineTo(cx + 8 * u, ground + dy * u);
        ctx.stroke();
      }
      ctx.fillStyle = "#5d3a17";
      ctx.beginPath();
      ctx.arc(cx, ground - 6 * u, 2.6 * u, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "bird_nest": {
      ctx.strokeStyle = "#8a5a2b";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(cx, ground - 6 * u, 11 * u, 5 * u, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "#6b4423";
      ctx.beginPath();
      ctx.ellipse(cx, ground - 5 * u, 8 * u, 3.6 * u, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#e8eef2";
      ctx.beginPath();
      ctx.ellipse(cx - 3 * u, ground - 7 * u, 3 * u, 2.4 * u, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + 3.4 * u, ground - 7 * u, 3 * u, 2.4 * u, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "sulfur_vent": {
      ctx.fillStyle = "#8d8d93";
      ctx.beginPath();
      ctx.moveTo(cx - 11 * u, ground);
      ctx.lineTo(cx - 4 * u, ground - 9 * u);
      ctx.lineTo(cx + 4 * u, ground - 9 * u);
      ctx.lineTo(cx + 11 * u, ground);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#ffd23e";
      ctx.beginPath();
      ctx.ellipse(cx, ground - 8 * u, 4 * u, 2 * u, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(240,240,230,0.5)";
      const rise = (now / 900 + cx) % 1;
      ctx.beginPath();
      ctx.arc(cx, ground - (12 + rise * 10) * u, (2 + rise * 3) * u, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "copper_vein":
    case "coal_vein":
    case "rare_vein":
    case "crystal_cluster": {
      ctx.fillStyle = "#55565f";
      ctx.beginPath();
      ctx.moveTo(sx + tile * 0.14, ground);
      ctx.lineTo(sx + tile * 0.3, sy + tile * 0.3);
      ctx.lineTo(sx + tile * 0.58, sy + tile * 0.18);
      ctx.lineTo(sx + tile * 0.86, ground);
      ctx.closePath();
      ctx.fill();
      const mineral = SURFACE_VEIN_COLORS[objectId] ?? "#c9c9cf";
      if (objectId === "crystal_cluster") {
        ctx.fillStyle = mineral;
        for (const [dx, h] of [[0.34, 0.34], [0.5, 0.46], [0.64, 0.3]] as const) {
          ctx.beginPath();
          ctx.moveTo(sx + tile * (dx - 0.06), ground - tile * 0.08);
          ctx.lineTo(sx + tile * dx, ground - tile * h);
          ctx.lineTo(sx + tile * (dx + 0.06), ground - tile * 0.08);
          ctx.closePath();
          ctx.fill();
        }
      } else {
        ctx.fillStyle = mineral;
        for (const [dx, dy, r] of [[0.36, 0.52, 0.07], [0.56, 0.4, 0.06], [0.66, 0.6, 0.05]] as const) {
          ctx.beginPath();
          ctx.arc(sx + tile * dx, sy + tile * dy, tile * r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }
    case "ruins_chest":
    case "cave_chest":
    case "dungeon_chest": {
      const body = spent ? "#5d4020" : objectId === "dungeon_chest" ? "#5e4632" : "#8a5a2b";
      ctx.fillStyle = body;
      ctx.fillRect(sx + tile * 0.2, sy + tile * 0.34, tile * 0.6, tile * 0.44);
      ctx.fillStyle = spent ? "#4a3319" : objectId === "dungeon_chest" ? "#4c3826" : "#77501f";
      ctx.fillRect(sx + tile * 0.2, sy + tile * 0.34, tile * 0.6, tile * 0.14);
      ctx.fillStyle = objectId === "dungeon_chest" ? "#6b6f7a" : "#e8c85a";
      ctx.fillRect(sx + tile * 0.46, sy + tile * 0.34, tile * 0.08, tile * 0.44);
      break;
    }
    case "hot_spring": {
      ctx.fillStyle = "#7cc0e8";
      ctx.beginPath();
      ctx.ellipse(cx, ground - 4 * u, 15 * u, 7 * u, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#a8d4f0";
      ctx.beginPath();
      ctx.ellipse(cx, ground - 4 * u, 10 * u, 4.4 * u, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#8d8d93";
      ctx.beginPath();
      ctx.arc(sx + tile * 0.1, ground - 2 * u, 4 * u, 0, Math.PI * 2);
      ctx.arc(sx + tile * 0.9, ground - 2 * u, 4 * u, 0, Math.PI * 2);
      ctx.fill();
      if (!spent) {
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        const rise = (now / 1100 + cx) % 1;
        ctx.beginPath();
        ctx.arc(cx - 5 * u, ground - (10 + rise * 9) * u, 2.4 * u, 0, Math.PI * 2);
        ctx.arc(cx + 6 * u, ground - (8 + ((rise + 0.5) % 1) * 9) * u, 2 * u, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "ancient_pillar": {
      ctx.fillStyle = "#9aa0a6";
      ctx.fillRect(cx - 5 * u, ground - 26 * u, 10 * u, 26 * u);
      ctx.fillStyle = "#7d838a";
      ctx.fillRect(cx - 7 * u, ground - 29 * u, 14 * u, 4 * u);
      ctx.fillRect(cx - 7 * u, ground - 3 * u, 14 * u, 3 * u);
      ctx.strokeStyle = "#6b7076";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - 5 * u, ground - 18 * u);
      ctx.lineTo(cx + 1 * u, ground - 13 * u);
      ctx.lineTo(cx - 2 * u, ground - 8 * u);
      ctx.stroke();
      break;
    }
    case "fallen_log":
    case "driftwood": {
      ctx.fillStyle = objectId === "fallen_log" ? "#8a5a2b" : "#b59a72";
      ctx.beginPath();
      ctx.ellipse(cx, ground - 5 * u, 16 * u, 5.5 * u, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = objectId === "fallen_log" ? "#c89b62" : "#cdb894";
      ctx.beginPath();
      ctx.ellipse(sx + tile * 0.16, ground - 5 * u, 3.4 * u, 5 * u, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = objectId === "fallen_log" ? "#8a5a2b" : "#a8906a";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(sx + tile * 0.16, ground - 5 * u, 1.8 * u, 3 * u, 0, 0, Math.PI * 2);
      ctx.stroke();
      if (objectId === "fallen_log") {
        ctx.fillStyle = "#3e7d2c";
        ctx.beginPath();
        ctx.arc(cx + 9 * u, ground - 10 * u, 3.4 * u, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    default:
      break;
  }
  ctx.restore();
}

/** ステーションの名前札（近づくと下部チップに出る）。 */
const STATION_LABEL: Record<LobbyStation, string> = {
  board: "掲示板",
  guild: "ギルドボード",
  shop: "ショップ",
  bank: "銀行",
  casino: "カジノ",
  arena: "闘技場",
  smith: "鍛冶屋",
  fountain: "噴水",
  rest: "休憩",
  arcade: "アーケード",
  race: "競馬場",
  sell: "売却専用ショップ",
  telescope: "望遠鏡",
};

export default function WorldBoxClient() {
  const { prefix, embedded, identity, retryIdentity } = useGamesNav();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const minimapRef = useRef<HTMLCanvasElement | null>(null);
  /** 開拓のコンパスの HUD（矢印と距離は描画ループが直接書き換える）。 */
  const compassCaveArrowRef = useRef<HTMLSpanElement | null>(null);
  const compassCaveDistRef = useRef<HTMLSpanElement | null>(null);
  const compassDungeonArrowRef = useRef<HTMLSpanElement | null>(null);
  const compassDungeonDistRef = useRef<HTMLSpanElement | null>(null);
  // ポーリングのガード（S6）: in-flight 重複を抑え、古いレスポンスが新しい
  // 状態を上書きしない。取得ごとに begin → isCurrent → end を使う。
  const chatGuardRef = useRef<PollGuard>(createPollGuard());
  const partyGuardRef = useRef<PollGuard>(createPollGuard());
  const boardGuardRef = useRef<PollGuard>(createPollGuard());
  const nationsGuardRef = useRef<PollGuard>(createPollGuard());
  const guildShopGuardRef = useRef<PollGuard>(createPollGuard());
  // ギルドショップの借り区画（地図のギルド名表示用。借りている区画だけ）
  const guildShopPlotsRef = useRef<{ idx: number; guildName: string }[]>([]);
  const invGuardRef = useRef<PollGuard>(createPollGuard());
  const vitalsGuardRef = useRef<PollGuard>(createPollGuard());
  const deathsGuardRef = useRef<PollGuard>(createPollGuard());
  const instanceGuardRef = useRef<PollGuard>(createPollGuard());
  // WS 中継の接続状態（エンジンが書き、コンポーネント側ポーリングの
  // 間引き判定が読む）。WS push が健全な間は対象ポーリングを止める。
  const rtOpenRef = useRef(false);
  const rtLastMsgRef = useRef(0);
  const wsHealthyNow = () => isWsHealthy(rtOpenRef.current, rtLastMsgRef.current, Date.now());
  /** エンジンから呼ぶ再同期用の橋（各 refresh の最新版を毎レンダーで差す）。 */
  const nationsRefreshRef = useRef<(force?: boolean) => Promise<void>>(async () => {});
  const guildShopRefreshRef = useRef<(force?: boolean) => Promise<void>>(async () => {});
  const boardRefreshRef = useRef<() => Promise<void>>(async () => {});
  const chatReloadRef = useRef<(() => void) | null>(null);
  const invRefreshRef = useRef<() => Promise<void>>(async () => {});
  const [statusText, setStatusText] = useState("読み込み中…");
  const [othersCount, setOthersCount] = useState(0);
  const [showMap, setShowMap] = useState(true);
  // スマホ向けレイアウト分岐（lib/worldbox/layout が正）。初期値は wide で
  // PC 表示を既定にし、マウント後に実寸へ追随する。
  const [viewport, setViewport] = useState({ w: 1280, h: 800 });
  useEffect(() => {
    const update = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  const layoutMode = wbLayoutMode(viewport.w, viewport.h);
  const hud = wbHudMetrics(layoutMode);
  const showMapRef = useRef(true);
  showMapRef.current = showMap;
  // 国家レイヤー（描画ループは ref、パネルは state で同じデータを見る）
  const nationsRef = useRef<NationsResponse>(EMPTY_NATIONS);
  const playerPosRef = useRef({ x: 0.5, y: 0.5 });
  const [nationsUi, setNationsUi] = useState<NationsResponse>(EMPTY_NATIONS);
  const [showEconomy, setShowEconomy] = useState(false);
  // マップ表示モード（周辺マップを大きく見る。描画ループは ref で見る）
  const [mapView, setMapView] = useState(false);
  const mapViewRef = useRef(false);
  mapViewRef.current = mapView;
  const bigMapRef = useRef<HTMLCanvasElement | null>(null);
  // 自ユニオンのポーター（テレポーターが設置した転移点。マップに表示し、選ぶと移動）
  const [porterUi, setPorterUi] = useState<{ x: number; y: number } | null>(null);
  const porterRef = useRef<{ x: number; y: number } | null>(null);
  porterRef.current = porterUi;
  useEffect(() => {
    if (!mapView) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/worldbox/warp", { headers: { Accept: "application/json" } });
        if (!res.ok) return;
        const data = (await res.json()) as { porter?: { x: number; y: number } | null };
        if (alive) setPorterUi(data.porter ?? null);
      } catch { /* 読めなくてもマップは見られる */ }
    };
    void load();
    const timer = window.setInterval(load, 15000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [mapView]);
  // フルスクリーン（ステージ全体を画面いっぱいにする。対応環境でのみボタンを出す）
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [canFullscreen, setCanFullscreen] = useState(false);
  useEffect(() => {
    setCanFullscreen(
      typeof HTMLElement !== "undefined" && "requestFullscreen" in HTMLElement.prototype,
    );
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void stageRef.current?.requestFullscreen().catch(() => {});
    }
  };
  // 座標表示（タイル単位の整数。ループが毎フレーム書く playerPosRef から拾う）
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const [nationMsg, setNationMsg] = useState("");
  /** ワールドの固体タイル（"x,y" の集合）。設置ブロックから作り直す。 */
  const blockedRef = useRef<ReadonlySet<string>>(new Set());

  // 座標表示の更新（250ms 間隔・タイルが変わったときだけ再描画）
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = {
        x: Math.floor(playerPosRef.current.x),
        y: Math.floor(playerPosRef.current.y),
      };
      setCoords((prev) => (prev.x === next.x && prev.y === next.y ? prev : next));
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  // 入場ゲート（Discord ログイン必須。許可されるまでワールドは描画しない）
  const [gate, setGate] = useState<"checking" | "ok" | "denied">("checking");
  const [gateTry, setGateTry] = useState(0);
  // 先読み完了までワールドを出さない（初フレームで平色フォールバックがチラつかないように）。
  const [booted, setBooted] = useState(false);
  const gateOk = gate === "ok" && booted;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/worldbox/gate", { headers: { Accept: "application/json" } });
        const data = res.ok ? ((await res.json()) as { allowed?: boolean }) : { allowed: false };
        if (!cancelled) setGate(data.allowed ? "ok" : "denied");
      } catch {
        if (!cancelled) setGate("denied");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gateTry]);
  // 入場前スプライト先読み: ロビー/農場/モブ/洞窟のファイル素材を温め、
  // 初フレームで平色フォールバックがチラつかないようにする。タイムアウトで
  // 必ず進む（止まらない）。ゲート画面の「読み込み中…」の間に済ませる。
  useEffect(() => {
    if (gate !== "ok" || booted) return;
    let cancelled = false;
    void preloadImages(
      [
        ...Object.values(LOBBY_SPRITE_SRC),
        ...Object.values(FARM_SPRITE_SRC),
        ...Object.values(MOB_SPRITE),
        ...Object.values(DUNGEON_TILE_SRC),
      ],
      { timeoutMs: SPRITE_PRELOAD_TIMEOUT_MS },
    ).then(() => {
      if (!cancelled) setBooted(true);
    });
    return () => {
      cancelled = true;
    };
  }, [gate, booted]);
  // Activity 内では GamesShell の SDK 認証が完了するとセッションが張られる。
  // 本人情報が届いた時点でゲートを引き直す（初回チェックが認証より先に
  // 走って denied になっても、押せないログインリンクで詰まらないように）。
  const identityId = identity?.id;
  useEffect(() => {
    if (identityId) setGateTry((t) => t + 1);
  }, [identityId]);
  // Activity 経由では Discord にログイン済みなのが前提（SDK 認証が本人
  // 確認そのもの）。本人情報が届いたらセッション確認を待たずに通す
  // （ユーザー指示 2026-11-16: Activity では認証はいらないはず）。
  // Activity の iframe ではセッション Cookie が保持されるとは限らず、
  // ゲート判定（Cookie のみ）に委ねると認証済みでも「ログインが必要」で
  // 詰まる。API 側のセッション検証は従来どおり各ルートが担い、
  // games-auth は引き続きセッション Cookie も張る。
  useEffect(() => {
    if (embedded && identityId) setGate("ok");
  }, [embedded, identityId]);
  // 認証完了の通知を取りこぼした場合の保険: Activity 内で denied の間は
  // しばらく自動で引き直す。
  useEffect(() => {
    if (!embedded || gate !== "denied") return;
    let count = 0;
    const timer = window.setInterval(() => {
      count += 1;
      if (count > 24) {
        window.clearInterval(timer);
        return;
      }
      setGateTry((t) => t + 1);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [embedded, gate]);
  // 空間（ワールド / ロビー）とハンバーガーメニュー、ステーション、掲示板
  const [spaceUi, setSpaceUi] = useState<SaveSpace>("world");
  /** spaceUi の ref ミラー（定期精算のタイマーから現在空間を読むため）。 */
  const spaceUiRef = useRef<SaveSpace>("world");
  spaceUiRef.current = spaceUi;
  const [menuOpen, setMenuOpen] = useState(false);
  // ≡ メニュー内の「設定」開閉: BGM・効果音・通報はここへ格納し、
  // メニュー本体はアクションだけに保つ（2026-11-17 ユーザー指示）。
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [collectionSel, setCollectionSel] = useState<string | null>(null);
  const [stationUi, setStationUi] = useState<LobbyStation | null>(null);
  /** ワールドで設置した作業施設の近くにいるときの作業種別（カンマ区切り。経済パネル用）。 */
  const [worldStationKinds, setWorldStationKinds] = useState("");
  /** いま接している店の品目ジャンル（鍛冶屋は "smith"）。経済パネルの品目選別に使う。 */
  const [stationGenre, setStationGenre] = useState<ShopGenreId | null>(null);
  /** いま接しているアーケード筐体のゲーム ID（L4）。筐体パネルの起動に使う。 */
  const [stationArcade, setStationArcade] = useState<string | null>(null);
  const [arcadeOpen, setArcadeOpen] = useState(false);
  /** 筐体で遊んでいる間はワールド側の移動キーを受けない（ゲーム側のキー入力と競合するため）。 */
  const arcadeOpenRef = useRef(false);
  useEffect(() => {
    arcadeOpenRef.current = arcadeOpen;
  }, [arcadeOpen]);
  /** 望遠鏡モード（開いている間はプレイヤーが止まり、視点だけが自由に動く）。 */
  const [telescopeOpen, setTelescopeOpen] = useState(false);
  const telescopeOpenRef = useRef(false);
  useEffect(() => {
    telescopeOpenRef.current = telescopeOpen;
  }, [telescopeOpen]);
  /** 望遠鏡の視点をプレイヤー位置へ戻す合図（増えるたびにループ側が再センタリング）。 */
  const telescopeCenterRef = useRef(0);
  useEffect(() => {
    setTelescopeOpen(false);
  }, [spaceUi]);
  const warpActionRef = useRef<(target: SaveSpace) => void>(() => {});
  const instanceWarpRef = useRef<(target: string, entry: { x: number; y: number }) => void>(() => {});
  /** 開催中イベント（期間ダンジョンの入場導線用）。 */
  const [eventsUi, setEventsUi] = useState<{ id: string; name: string; kind: string; daysLeft: number }[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/worldbox/events", { headers: { Accept: "application/json" } });
        if (!res.ok) return;
        const data = (await res.json()) as { events?: { id: string; name: string; kind: string; daysLeft: number }[] };
        if (alive) setEventsUi(data.events ?? []);
      } catch { /* noop */ }
    };
    void load();
    const timer = window.setInterval(load, 60000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  const enterEventDungeon = () => {
    const r = buildRuins(MAP_SEED, EVENT_DUNGEON_ENTRANCE.x, EVENT_DUNGEON_ENTRANCE.y);
    instanceWarpRef.current(
      makeInstanceSpace("ruins", EVENT_DUNGEON_ENTRANCE.x, EVENT_DUNGEON_ENTRANCE.y, 0),
      { x: r.portal.x + 0.5, y: r.portal.y + 0.5 },
    );
  };
  /** 所属国への移動（ゲームループ側のテレポート実体）。 */
  const teleportActionRef = useRef<(x: number, y: number) => void>(() => {});
  /** 所属国へ移動: 所属の検証と移動先の決定はサーバー側が行う。 */
  const travelToNation = async () => {
    setNationMsg("");
    try {
      const res = await fetch("/api/worldbox/nations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "travel" }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; x?: number; y?: number };
      if (!res.ok || typeof data.x !== "number" || typeof data.y !== "number") {
        setNationMsg(NATION_ERROR_LABEL[data.error ?? ""] ?? "失敗しました");
        return;
      }
      teleportActionRef.current(data.x, data.y);
    } catch {
      setNationMsg("失敗しました");
    }
  };
  /** 自ユニオンのポーターへ移動: 所属と現在空間の検証はサーバー側が行う。 */
  const teleportToPorter = async () => {
    try {
      const res = await fetch("/api/worldbox/warp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "teleport" }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; x?: number; y?: number };
      if (res.ok && typeof data.x === "number" && typeof data.y === "number") {
        setMapView(false);
        teleportActionRef.current(data.x, data.y);
        return;
      }
      setTileMsg(
        data.error === "no_porter" ? "ポーターなし"
        : data.error === "not_in_union" ? "ユニオン未所属"
        : "テレポートできない",
      );
    } catch {
      setTileMsg("テレポートできない");
    }
  };
  const respawnActionRef = useRef<(point: { x: number; y: number }) => void>(() => {});
  const bedKeyRef = useRef<string>("");
  const [casinoOpen, setCasinoOpen] = useState(false);
  const [racingOpen, setRacingOpen] = useState(false);
  const [arenaOpen, setArenaOpen] = useState(false);
  const [plazaMsg, setPlazaMsg] = useState("");
  const staminaBoostRef = useRef(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [guildBoardOpen, setGuildBoardOpen] = useState(false);
  /** 招待リンク（?union=<DiscordサーバーID>）の指定先。 */
  const [inviteGuildId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("union");
  });
  useEffect(() => {
    if (inviteGuildId) setGuildBoardOpen(true);
  }, [inviteGuildId]);
  const [guildShopOpen, setGuildShopOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportText, setReportText] = useState("");
  const sendReport = async () => {
    const text = reportText.trim();
    if (!text) return;
    try {
      const res = await fetch("/api/worldbox/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "report",
          text,
          x: Math.floor(playerPosRef.current.x),
          y: Math.floor(playerPosRef.current.y),
        }),
      });
      setTileMsg(res.ok ? "通報した" : "通報できない");
      if (res.ok) {
        setReportText("");
        setReportOpen(false);
      }
    } catch { /* noop */ }
  };
  const [boardPosts, setBoardPosts] = useState<BoardPost[]>([]);
  const [boardLoggedIn, setBoardLoggedIn] = useState(false);
  const [boardText, setBoardText] = useState("");
  const [boardMsg, setBoardMsg] = useState("");
  // 音響（BGM/SE）: 設定は lib/worldbox/sound が localStorage に持つ。
  // AudioContext は最初のユーザー操作でだけ作れるため、解錠は pointerdown/keydown で行う。
  const [soundSettings, setSoundSettings] = useState<WbSoundSettings>({ bgm: true, se: true });
  // BGM 緊張レイヤー: 描画ループが 500ms ごとに更新し、1秒ごとの場面判定が読む。
  const dangerRef = useRef(false);
  useEffect(() => {
    setSoundSettings(loadWbSoundSettings());
    const unlock = () => unlockWbAudio();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      stopWbBgm();
    };
  }, []);
  // BGM の場面は 1 秒ごとに判定し直す（昼夜は共有時計で勝手に進むため）。
  useEffect(() => {
    const applyScene = () => {
      setWbBgmScene(bgmSceneFor({
        space: spaceUi, night: nightAmount(phaseAtTime(Date.now() / 1000)), casinoOpen,
      }));
      // 緊張レイヤーはフィールド（ワールド/インスタンス）でのみ。ロビー・テントでは切る。
      const inField = spaceUi === "world" || parseInstanceSpace(spaceUi) !== null;
      setWbBgmTension(inField && dangerRef.current);
    };
    applyScene();
    const timer = setInterval(applyScene, 1000);
    return () => clearInterval(timer);
  }, [spaceUi, casinoOpen]);
  const toggleSound = (key: "bgm" | "se") => {
    const next = { ...soundSettings, [key]: !soundSettings[key] };
    setSoundSettings(next);
    saveWbSoundSettings(next);
    if (key === "se" && next.se) playWbSe("click");
  };
  const refreshBoard = async () => {
    // 古いレスポンスが新しい投稿一覧を上書きしない（S6）
    const ticket = boardGuardRef.current.begin();
    if (ticket === null) return;
    try {
      const res = await fetch("/api/worldbox/board", { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = (await res.json()) as { posts?: BoardPost[]; loggedIn?: boolean };
      if (!boardGuardRef.current.isCurrent(ticket)) return;
      setBoardPosts(data.posts ?? []);
      setBoardLoggedIn(!!data.loggedIn);
    } catch { /* 掲示板が読めなくても歩き続けられる */ }
    finally {
      boardGuardRef.current.end(ticket);
    }
  };
  const postBoard = async () => {
    const text = boardText.trim();
    if (!text) return;
    setBoardMsg("");
    try {
      const res = await fetch("/api/worldbox/board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = (await res.json().catch(() => ({}))) as { posts?: BoardPost[]; error?: string };
      if (!res.ok) {
        setBoardMsg(
          data.error === "unauthorized" ? "投稿はログイン後"
          : data.error === "too_fast" ? "少し待ってから投稿してください"
          : "投稿できませんでした",
        );
        return;
      }
      setBoardText("");
      if (data.posts) setBoardPosts(data.posts);
    } catch {
      setBoardMsg("投稿できませんでした");
    }
  };
  useEffect(() => {
    if (!boardOpen) return;
    void refreshBoard();
    // WS push が健全な間は掲示板の差分が push で届くため定期取得しない
    const timer = window.setInterval(() => { if (!wsHealthyNow()) void refreshBoard(); }, 10000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardOpen]);

  // 施設から離れたら、その施設のパネルは閉じる（場所制約の表示側）
  useEffect(() => {
    if (stationUi !== "board") setBoardOpen(false);
    if (stationUi !== "casino") setCasinoOpen(false);
    if (stationUi !== "guild") setGuildBoardOpen(false);
    if (stationUi !== "arena") setArenaOpen(false);
    if (stationUi !== "arcade") setArcadeOpen(false);
    setPlazaMsg("");
  }, [stationUi]);

  // 噴水・休憩の小施設アクション（場所検証はサーバー側、回復はここで適用）
  const plazaAction = async (action: "fountain" | "rest") => {
    try {
      const res = await fetch("/api/worldbox/plaza", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string; item?: string | null; retryAfterSec?: number; profile?: PlayerProfile;
      };
      if (!res.ok) {
        setPlazaMsg(
          data.error === "insufficient_balance" ? "コインが足りません"
          : data.error === "rest_cooldown" ? `まだ休めません（あと ${data.retryAfterSec ?? "?"} 秒）`
          : data.error === "unauthorized" ? "ログインが必要です"
          : "受け付けられませんでした",
        );
        return;
      }
      if (data.profile) setInvProfile(data.profile);
      staminaBoostRef.current = true;
      playWbSe(action === "fountain" ? "coin" : "success");
      if (action === "fountain") {
        const itemName = data.item ? itemById(data.item)?.name ?? data.item : null;
        setPlazaMsg(itemName ? `スタミナが回復した。${itemName} を手に入れた` : "スタミナが回復した");
      } else {
        setPlazaMsg("スタミナが回復した");
      }
    } catch {
      setPlazaMsg("受け付けられませんでした");
    }
  };

  const applyNationsData = (data: NationsResponse) => {
    nationsRef.current = data;
    setNationsUi(data);
  };
  const refreshNations = async (force = false) => {
    // 古いレスポンスが新しい国家状態を上書きしない（S6）。行為直後の再取得は force。
    const ticket = nationsGuardRef.current.begin(force ? { force: true } : undefined);
    if (ticket === null) return;
    try {
      const res = await fetch("/api/worldbox/nations", { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = (await res.json()) as NationsResponse;
      if (!nationsGuardRef.current.isCurrent(ticket)) return;
      applyNationsData(data);
    } catch { /* 国家が読めなくても歩き続けられる */ }
    finally {
      nationsGuardRef.current.end(ticket);
    }
  };
  nationsRefreshRef.current = refreshNations;
  boardRefreshRef.current = refreshBoard;
  // ギルドショップの借り区画（地図のカウンター上にギルド名を出す用）。
  // 応答の本人向け加工は地図では使わず、借り区画の idx とギルド名だけ持つ。
  const refreshGuildShopPlots = async (force = false) => {
    const ticket = guildShopGuardRef.current.begin(force ? { force: true } : undefined);
    if (ticket === null) return;
    try {
      const res = await fetch("/api/worldbox/guild-shop", { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = (await res.json()) as {
        plots?: ({ idx: number; guildName: string } | null)[];
      };
      if (!guildShopGuardRef.current.isCurrent(ticket)) return;
      guildShopPlotsRef.current = (data.plots ?? [])
        .filter((p): p is { idx: number; guildName: string } => p !== null)
        .map((p) => ({ idx: p.idx, guildName: p.guildName }));
    } catch { /* 読めなくても歩き続けられる */ }
    finally {
      guildShopGuardRef.current.end(ticket);
    }
  };
  guildShopRefreshRef.current = refreshGuildShopPlots;
  const nationAction = async (body: Record<string, unknown>) => {
    setNationMsg("");
    try {
      const res = await fetch("/api/worldbox/nations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setNationMsg(NATION_ERROR_LABEL[data.error ?? ""] ?? "失敗しました");
        return;
      }
      await refreshNations(true);
    } catch {
      setNationMsg("失敗しました");
    }
  };
  // インベントリ（ホットバー/ストレージ）とタイル上書き（伐採・畑・作物）
  const [invProfile, setInvProfile] = useState<PlayerProfile | null>(null);
  /** 技チャージゲージの表示時計（クールタイム中だけ 200ms で進める）。 */
  const [gaugeNow, setGaugeNow] = useState(() => Date.now());
  // テレポーターのゲージはポーター設置（activeSkillFor は戦闘技として返さない）
  const gaugeSkill = invProfile && invProfile.role !== "free"
    ? invProfile.role === "teleporter" ? SKILLS.porter : activeSkillFor(invProfile)
    : null;
  useEffect(() => {
    if (!gaugeSkill) return;
    const timer = window.setInterval(() => setGaugeNow(Date.now()), 200);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gaugeSkill?.id, invProfile?.role]);
  const [, setCtTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setCtTick((v) => v + 1), 500);
    return () => window.clearInterval(timer);
  }, []);
  const invRef = useRef<PlayerProfile | null>(null);
  invRef.current = invProfile;
  /** 開拓のコンパスを持っているか（持っている間だけ方向表示が出る）。 */
  const hasCompass = !!invProfile && countItem(invProfile, "explorer_compass") > 0;
  const [selSlot, setSelSlot] = useState(0);
  const selSlotRef = useRef(0);
  selSlotRef.current = selSlot;
  const [storageOpen, setStorageOpen] = useState(false);
  /** インベントリ整理で持ち上げ中のスロット（タップ→タップで移動）。 */
  const [heldSlot, setHeldSlot] = useState<SlotRef | null>(null);
  /** 開いている収納コンテナ（自分の樽・宝箱）とその中身。 */
  const [containerPanel, setContainerPanel] = useState<{ x: number; y: number; itemId: string; space: "world" | "tent" | "lobby" | "lobby2" | "lobby3" } | null>(null);
  const [machinePanel, setMachinePanel] = useState<{ x: number; y: number } | null>(null);
  /** 座っている家具のタイル（ベンチ・椅子・ソファ）。見た目だけの状態で、プレゼンスにも申告する。 */
  const sitTileRef = useRef<{ x: number; y: number } | null>(null);
  const [containerSlots, setContainerSlots] = useState<ItemSlot[] | null>(null);
  /** コンテナパネルで持ち上げ中のスロット（プロフィール側も含む）。 */
  const [heldPanelSlot, setHeldPanelSlot] = useState<ContainerSlotRef | null>(null);
  const [seedPicker, setSeedPicker] = useState<{ x: number; y: number } | null>(null);
  /** 看板テキストの編集対象（自分の看板をタップしたとき）。 */
  const [signEdit, setSignEdit] = useState<{ x: number; y: number; text: string } | null>(null);
  /** 屋台パネル: 対象タイルと、開いた時点で選択していたアイテム（出品候補）と自分の屋台か。 */
  const [stallPanel, setStallPanel] = useState<{ x: number; y: number; selItemId: string | null; mine: boolean } | null>(null);
  /** 屋台の出品（サーバーが正）。undefined は読み込み中。 */
  const [stallInfo, setStallInfo] = useState<{ itemId: string; name: string; price: number; count: number; mine: boolean } | null | undefined>(undefined);
  const [stallPriceText, setStallPriceText] = useState("100");
  const [stallCountText, setStallCountText] = useState("1");
  const [tileMsg, setTileMsg] = useState("");
  /** 別のタブに同じアカウントで引き継がれた（このタブは無効化された）か。 */
  const [tabTaken, setTabTaken] = useState(false);
  // Esc で開いているパネル/メニューを全部閉じる（パネル内に閉じ場所が無い状態への保険）
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      setShowEconomy(false);
      setMapView(false);
      setCasinoOpen(false);
      setBoardOpen(false);
      setGuildBoardOpen(false);
      setStorageOpen(false);
      setHeldSlot(null);
      setSeedPicker(null);
      setContainerPanel(null);
      setHeldPanelSlot(null);
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, []);
  const tilesRef = useRef<TileOverridesMap>({});
  const tilesVersionRef = useRef(0);
  /** 演出イベントの受け渡し（行為の成功/失敗→描画ループでパーティクル/揺れ/ポップに変換）。
   * whiff は空振り（風切りのみ、粒なし）。hit/death/spawn はモブ演出用（sizeTiles/color 任意）。 */
  const fxEventsRef = useRef<{ kind: FxBurstKind | "whiff"; x: number; y: number; sizeTiles?: number; color?: string; colors?: string[]; stop?: number }[]>([]);
  /** 無効操作のフィードバック（赤い輪＋揺れ。タップしたタイルと開始時刻）。 */
  const denyFxRef = useRef<{ x: number; y: number; at: number } | null>(null);
  /** 初回誘導を出した施設（セッション内だけ覚える。キー=施設種別/スプライト）。 */
  const seenAffordanceRef = useRef(new Map<string, number>());
  /** 無効フィードバックの回数（tileMsg ピルの揺れアニメーション再発火用）。 */
  const [denyStamp, setDenyStamp] = useState(0);
  // 冒険役職の技（ダブルタップ発動）: 進行中の演出・前回タップ・死亡地点。
  const skillFxRef = useRef<{ effect: SkillFxEffect; stage: number }[]>([]);
  /** モブの現在タイルのスナップショット（描画ループが毎フレーム差し替える）。 */
  const mobTilesRef = useRef(new Map<string, { mobId: string; x: number; y: number; mx: number; my: number }>());
  const lastTapRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const deathsRef = useRef<{ name: string; x: number; y: number; at: number }[]>([]);

  /** 無効操作の構造的フィードバック: 赤い輪＋揺れ＋ error SE（文言だけに頼らない）。 */
  const denyAtTile = (x: number, y: number) => {
    denyFxRef.current = { x, y, at: performance.now() };
    playWbSe("error");
    setDenyStamp((n) => n + 1);
  };

  /**
   * ダブルタップで技を打つ。発動したら true（通常タップは消費される）。
   * サーバーに弾かれたら "denied"（ジェスチャ自体は技の試みとして消費し、
   * 無言で通常タップに化けさせない）。役職なし等で技にならない場合は false。
   */
  const castSkillAt = async (t: { x: number; y: number }): Promise<boolean | "denied"> => {
    const profile = invRef.current;
    if (!profile || profile.role === "free") return false;
    const pos = playerPosRef.current;
    const space = spaceUi;
    // 薬師: 死亡マーカーへのダブルタップは蘇生
    if (profile.role === "medic") {
      const death = deathsRef.current.find((d) => Math.floor(d.x) === t.x && Math.floor(d.y) === t.y);
      if (death) {
        try {
          const res = await fetch("/api/worldbox/roles", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "revive", space, px: pos.x, py: pos.y }),
          });
          const data = (await res.json().catch(() => ({}))) as { profile?: PlayerProfile };
          if (res.ok && data.profile) {
            setInvProfile(data.profile);
            skillFxRef.current.push({
              effect: { kind: "heal_zone", x: death.x, y: death.y, fromX: pos.x, fromY: pos.y, startedAt: performance.now(), seed: Math.floor(Math.random() * 1e9) },
              stage: -1,
            });
            playWbSe("warp");
            deathsRef.current = deathsRef.current.filter((d) => d !== death);
          }
        } catch { /* 蘇生できなくても通常操作は続く */ }
        return true;
      }
    }
    const ownTile = Math.floor(pos.x) === t.x && Math.floor(pos.y) === t.y;
    // テレポーターはダブルタップ地点へポーターを設置する（戦闘技ではない）
    const skill = profile.role === "teleporter"
      ? SKILLS.porter
      : ownTile && profile.role === "guard" ? SKILLS.taunt : activeSkillFor(profile);
    if (!skill) return false;
    if (skillCooldownLeft(profile, skill.id, Date.now()) > 0) return false;
    // 近くのモブの現在タイルを申告する（サーバーの対象解決を画面に合わせる）
    const mobsReport = [...mobTilesRef.current.values()]
      .filter((m) => Math.abs(m.mx - pos.x) <= 18 && Math.abs(m.my - pos.y) <= 18)
      .slice(0, 32);
    try {
      const res = await fetch("/api/worldbox/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "skill", skill: skill.id, tx: t.x + 0.5, ty: t.y + 0.5,
          space, px: pos.x, py: pos.y, mobs: mobsReport,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        profile?: PlayerProfile; fx?: SkillFxEffect["kind"]; cx?: number; cy?: number; error?: string;
      };
      if (res.ok && data.profile) {
        setInvProfile(data.profile);
        skillFxRef.current.push({
          effect: {
            kind: data.fx ?? skill.fx, x: data.cx ?? t.x + 0.5, y: data.cy ?? t.y + 0.5,
            fromX: pos.x, fromY: pos.y, startedAt: performance.now(), seed: Math.floor(Math.random() * 1e9),
          },
          stage: -1,
        });
        playWbSe(skill.id === "heal_zone" || skill.id === "taunt" || skill.id === "porter" ? "warp" : "hit");
        void refreshMobsRef.current();
        return true;
      }
      if (data.error === "cooldown") {
        void refreshInv();
        return true;
      }
      return "denied";
    } catch {
      return false;
    }
  };
  const castSkillRef = useRef(castSkillAt);
  castSkillRef.current = castSkillAt;
  /** 自分の不透明 ID（プレゼンス ID）。自分のブロック判定に使う。 */
  const selfIdRef = useRef<string | null>(null);
  /** タイル上書きから設置ブロックの固体集合を作り直す（施設は占有のみで固体にしない。柵は固体、門は閉じている間だけ固体、床は固体にしない）。 */
  const syncBlockBlocked = () => {
    const now = Date.now();
    const next = new Set<string>();
    for (const [key, ov] of Object.entries(tilesRef.current)) {
      if (!ov.block || !isOverrideActive(ov, now)) continue;
      if (placedBlockSolid(ov.block.itemId)) next.add(key);
      else if (isGateItem(ov.block.itemId) && ov.gateOpen !== true) next.add(key);
    }
    // 地表の固体オブジェクト（鉱脈・巣・宝箱・石柱・倒木）も歩行を塞ぐ。
    // 読み込み済みタイル窓（中心 ±64）の範囲で決定的配置から合成する
    // （枯渇しても物体そのものは残るため採取状態には依存しない）。
    const center = tilesCenterRef.current
      ?? { x: Math.floor(playerPosRef.current.x), y: Math.floor(playerPosRef.current.y) };
    for (const key of surfaceSolidTilesInRect(
      MAP_SEED, center.x - 64, center.y - 64, center.x + 64, center.y + 64,
    )) {
      next.add(key);
    }
    blockedRef.current = next;
  };

  const refreshInv = async () => {
    // 古いレスポンスが行為後の新しいプロフィール（残高・所持）を巻き戻さない（S6）
    const ticket = invGuardRef.current.begin();
    if (ticket === null) return;
    try {
      const res = await fetch("/api/worldbox/profile", { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = (await res.json()) as { profile?: PlayerProfile };
      if (data.profile && invGuardRef.current.isCurrent(ticket)) setInvProfile(data.profile);
    } catch { /* 読めなくても歩き続けられる */ }
    finally {
      invGuardRef.current.end(ticket);
    }
  };
  invRefreshRef.current = refreshInv;
  /** バイタル API の結果を反映する（死亡時はリスポーン移動まで行う）。 */
  const applyVitalsResult = (data: {
    profile?: PlayerProfile; died?: boolean; respawn?: { x: number; y: number };
    teleport?: { space: string; x: number; y: number };
  }) => {
    if (data.profile) setInvProfile(data.profile);
    if (data.died && data.respawn) {
      respawnActionRef.current(data.respawn);
      setTileMsg("倒れた");
    } else if (data.teleport) {
      // 蘇生のテレポートは死亡した空間へ戻す（洞窟・遺跡・ダンジョン）。
      // 従来は respawnActionRef が space を "world" に固定していたため、
      // インスタンス内で蘇生されるとワールドの同座標へ飛ばされていた（S5）。
      const t = data.teleport;
      if (t.space && parseInstanceSpace(t.space)) {
        instanceWarpRef.current(t.space, { x: t.x, y: t.y });
      } else {
        respawnActionRef.current({ x: t.x, y: t.y });
      }
      playWbSe("warp");
    }
  };
  const postVitals = async (body: Record<string, unknown>, force = false) => {
    // 古い精算レスポンスが行為後の新しいプロフィールを巻き戻さない（S6）。
    // 15s 定期精算はスキップ可、ダメージ・ベッド等の明示呼び出しは force。
    const ticket = vitalsGuardRef.current.begin(force ? { force: true } : undefined);
    if (ticket === null) return;
    try {
      const res = await fetch("/api/worldbox/vitals", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        profile?: PlayerProfile; died?: boolean; respawn?: { x: number; y: number };
        teleport?: { space: string; x: number; y: number };
      };
      if (res.ok && vitalsGuardRef.current.isCurrent(ticket)) applyVitalsResult(data);
    } catch { /* バイタルが届かなくても歩き続けられる（次回同期で精算される） */ }
    finally {
      vitalsGuardRef.current.end(ticket);
    }
  };
  /** モブ接触ダメージ（サーバーが配置・距離・攻撃力を検証する）。 */
  const postMobDamage = (mobId: string, x: number, y: number, mx?: number, my?: number) => {
    void postVitals({
      action: "damage", mobId, x, y,
      px: playerPosRef.current.x, py: playerPosRef.current.y,
      // モブの見た目の現在タイルも申告する（攻撃と同じ）。サーバーは
      // アンカーしか知らないため、これがないと追跡してきたモブの
      // 接触が too_far で無効化される。
      ...(typeof mx === "number" && typeof my === "number" ? { mx, my } : {}),
      ...(parseInstanceSpace(spaceUi) ? { space: spaceUi } : {}),
    }, true);
  };
  /** 環境ハザード（サボテン・マグマ）: 位置は送らない。サーバーが現在位置の足元で判定する。 */
  const postHazard = () => {
    void postVitals({ action: "hazard" }, true);
  };
  /** 遺跡の個人状態（宝箱・罠・扉・召喚）。サーバーが正、ここは表示用キャッシュ。 */
  const ruinsStateRef = useRef<{
    chests: Record<string, boolean>; traps: Record<string, boolean>;
    doors: Record<string, boolean>; summons: { mobId: string; x: number; y: number }[];
  }>({ chests: {}, traps: {}, doors: {}, summons: [] });
  const refreshRuinsState = async (space: string) => {
    // 行為直後の明示再取得。古いレスポンスが新しい状態を上書きしない（S6）。
    const ticket = instanceGuardRef.current.begin({ force: true });
    if (ticket === null) return;
    try {
      const res = await fetch(`/api/worldbox/instances?space=${encodeURIComponent(space)}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        chests?: Record<string, boolean>; traps?: Record<string, boolean>;
        doors?: Record<string, boolean>; summons?: { mobId: string; x: number; y: number }[];
      };
      if (!instanceGuardRef.current.isCurrent(ticket)) return;
      ruinsStateRef.current = {
        chests: data.chests ?? {}, traps: data.traps ?? {},
        doors: data.doors ?? {}, summons: data.summons ?? [],
      };
    } catch { /* 読めなくても歩き続けられる */ }
    finally {
      instanceGuardRef.current.end(ticket);
    }
  };
  const refreshRuinsStateRef = useRef(refreshRuinsState);
  refreshRuinsStateRef.current = refreshRuinsState;
  /** インスタンス内のテレポート（転移罠など）。エフェクト側が placePlayer を差す。 */
  const instanceTeleportRef = useRef<((x: number, y: number) => void) | null>(null);
  /** 洞窟の枯渇状態（鉱脈・宝箱）。サーバーが正、ここは表示用キャッシュ。 */
  const caveStateRef = useRef<{ veins: Record<string, number>; chest: number }>({ veins: {}, chest: 0 });
  const refreshCaveState = async (space: string) => {
    // 行為直後の明示再取得。古いレスポンスが新しい状態を上書きしない（S6）。
    const ticket = instanceGuardRef.current.begin({ force: true });
    if (ticket === null) return;
    try {
      const res = await fetch(`/api/worldbox/instances?space=${encodeURIComponent(space)}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { veins?: Record<string, number>; chest?: number };
      if (!instanceGuardRef.current.isCurrent(ticket)) return;
      caveStateRef.current = { veins: data.veins ?? {}, chest: data.chest ?? 0 };
    } catch { /* 読めなくても歩き続けられる */ }
    finally {
      instanceGuardRef.current.end(ticket);
    }
  };
  const refreshCaveStateRef = useRef(refreshCaveState);
  refreshCaveStateRef.current = refreshCaveState;
  /** ダンジョンのセッション状態（宝箱・扉・ボス進行）。サーバーが正、ここは表示用。 */
  const dungeonStateRef = useRef<{
    opened: Record<string, boolean>; doors: Record<string, boolean>;
    floorBossDead: Record<string, boolean>; bossDead: boolean; size: number;
    gateFloor2: boolean; gateBoss: boolean;
  }>({ opened: {}, doors: {}, floorBossDead: {}, bossDead: false, size: 1, gateFloor2: false, gateBoss: false });
  const refreshDungeonState = async (space: string) => {
    // 行為直後の明示再取得。古いレスポンスが新しい状態を上書きしない（S6）。
    const ticket = instanceGuardRef.current.begin({ force: true });
    if (ticket === null) return;
    try {
      const res = await fetch(`/api/worldbox/instances?space=${encodeURIComponent(space)}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        chests?: Record<string, number>; doors?: Record<string, boolean>;
        floorBossDead?: Record<string, boolean>; bossDead?: boolean; size?: number;
        gateFloor2?: boolean; gateBoss?: boolean;
      };
      if (!instanceGuardRef.current.isCurrent(ticket)) return;
      dungeonStateRef.current = {
        opened: Object.fromEntries(Object.keys(data.chests ?? {}).map((k) => [k, true])), doors: data.doors ?? {},
        floorBossDead: data.floorBossDead ?? {}, bossDead: data.bossDead ?? false,
        size: data.size ?? 1,
        gateFloor2: data.gateFloor2 ?? false, gateBoss: data.gateBoss ?? false,
      };
    } catch { /* 読めなくても歩き続けられる */ }
    finally {
      instanceGuardRef.current.end(ticket);
    }
  };
  const refreshDungeonStateRef = useRef(refreshDungeonState);
  refreshDungeonStateRef.current = refreshDungeonState;
  /** パーティ状態（編成・招待）。サーバーが正、ここは表示と導線用。 */
  type PartyViewClient = {
    id: string; entrance: { x: number; y: number };
    members: { name: string; role: AdventureRoleId; rank: number }[];
  };
  const [partyUi, setPartyUi] = useState<{
    party: PartyViewClient | null; partyKey: string; isLeader: boolean;
    invite: { partyId: string; leaderName: string } | null;
  }>({ party: null, partyKey: "", isLeader: false, invite: null });
  const partyRef = useRef(partyUi);
  partyRef.current = partyUi;
  const myPartyKeyRef = useRef("");
  const [nearDungeonEntrance, setNearDungeonEntrance] = useState(false);
  /** タップで選択した他プレイヤーのプロフィールチップ。 */
  const [playerCard, setPlayerCard] = useState<{
    id: string; name: string; role: AdventureRoleId; rank: number;
  } | null>(null);
  const playerCardTimerRef = useRef<number | null>(null);
  const showPlayerCard = (card: { id: string; name: string; role: AdventureRoleId; rank: number }) => {
    setPlayerCard(card);
    if (playerCardTimerRef.current) window.clearTimeout(playerCardTimerRef.current);
    playerCardTimerRef.current = window.setTimeout(() => setPlayerCard(null), 6000);
  };
  const showPlayerCardRef = useRef(showPlayerCard);
  showPlayerCardRef.current = showPlayerCard;
  /** チャット（近距離/全体/ユニオン）。サーバーが正、ここは表示と送信だけ。 */
  const [chatChannel, setChatChannel] = useState<"proximity" | "global" | "union">("proximity");
  const [chatMsgs, setChatMsgs] = useState<{ name: string; text: string; at: number; source?: string }[]>([]);
  const [chatText, setChatText] = useState("");
  const chatChannelRef = useRef(chatChannel);
  chatChannelRef.current = chatChannel;
  useEffect(() => {
    let disposed = false;
    const load = async (force = false) => {
      // WS push が健全な間は定期取得を止める（変更時は relay の poke で
      // force 取得が走る）。初期表示とチャンネル切替はスナップショット取得。
      if (!force && wsHealthyNow()) return;
      // 古いレスポンスが新しいメッセージ一覧を上書きしない（S6）
      const ticket = chatGuardRef.current.begin();
      if (ticket === null) return;
      try {
        const res = await fetch(
          `/api/worldbox/chat?channel=${chatChannelRef.current}&space=${encodeURIComponent(spaceUi)}`,
          { headers: { Accept: "application/json" } },
        );
        if (!res.ok || disposed) return;
        const data = (await res.json()) as { messages?: { name: string; text: string; at: number; source?: string }[] };
        if (!disposed && chatGuardRef.current.isCurrent(ticket)) setChatMsgs(data.messages ?? []);
      } catch { /* noop */ }
      finally {
        chatGuardRef.current.end(ticket);
      }
    };
    chatReloadRef.current = () => { void load(true); };
    void load(true);
    const timer = window.setInterval(() => { void load(); }, 3000);
    return () => { disposed = true; chatReloadRef.current = null; window.clearInterval(timer); };
  }, [spaceUi, chatChannel]);
  /** 釣り: 魚影タップでキャスト、食いつきの窓でもう一度タップすると釣れる。 */
  const fishingRef = useRef<{ x: number; y: number; biteAt: number } | null>(null);
  /** 闇マスク用のオフスクリーン（設置した明かりの穴あけに使う）。 */
  const darkCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fishCaughtRef = useRef(new Map<string, number>());
  const postCatch = async (x: number, y: number) => {
    try {
      const res = await fetch("/api/worldbox/fishing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x, y }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        gained?: Record<string, number>; profile?: PlayerProfile; error?: string;
      };
      if (res.ok) {
        fishCaughtRef.current.set(`${x},${y}`, Date.now());
        if (data.profile) setInvProfile(data.profile);
        const names = Object.entries(data.gained ?? {})
          .map(([id, n]) => `${itemById(id)?.name ?? id}×${n}`)
          .join(" ");
        setTileMsg(names ? `釣れた: ${names}` : "何も釣れなかった");
      } else {
        setTileMsg(data.error === "tool_required" ? "釣り竿が要る" : data.error === "not_respawned" ? "魚がいない" : "釣れない");
      }
    } catch { /* noop */ }
  };
  const postCatchRef = useRef(postCatch);
  postCatchRef.current = postCatch;
  /** 地表オブジェクトの枯渇状態（サーバー共有が正、ここは表示用キャッシュ）。 */
  const surfaceObjStateRef = useRef(new Map<string, number>());
  /** 地表オブジェクトへの行為: 検証・付与・枯渇記録はサーバーが正。 */
  const postSurfaceObject = async (x: number, y: number, objectId: string) => {
    try {
      const res = await fetch("/api/worldbox/objects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x, y }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        gained?: Record<string, number>; trapped?: boolean; healed?: number;
        profile?: PlayerProfile; error?: string; broke?: string;
      };
      if (res.ok) {
        surfaceObjStateRef.current.set(`${x},${y}`, Date.now());
        if (data.profile) setInvProfile(data.profile);
        const def = specialObjectById(objectId);
        const fxKind = data.trapped ? "hit"
          : def?.interaction === "mine" ? "mine"
          : def?.interaction === "rest" ? "splash"
          : def?.tool === "axe" ? "chop" : "harvest";
        // 破片は対象の素材色で返す（鉱脈・巣・実など）
        fxEventsRef.current.push({ kind: fxKind, x, y, colors: burstPaletteFor(objectId) ?? undefined });
        const names = Object.entries(data.gained ?? {})
          .map(([id, n]) => `${itemById(id)?.name ?? id}×${n}`)
          .join(" ");
        const baseMsg = data.trapped ? "罠だった！"
          : (data.healed ?? 0) > 0 ? `温泉で回復した${names ? `: ${names}` : ""}`
          : names ? `${def?.name ?? "採取"}: ${names}` : "何も無かった";
        setTileMsg(data.broke ? `${baseMsg}（${itemById(data.broke)?.name ?? "道具"}が壊れた）` : baseMsg);
        if (data.broke) playWbSe("debris");
        void refreshSurfaceStatesRef.current();
      } else {
        setTileMsg(TILE_ERROR_LABEL[data.error ?? ""] ?? "できない");
        if (data.error === "depleted") void refreshSurfaceStatesRef.current();
      }
    } catch { /* noop */ }
  };
  const postSurfaceObjectRef = useRef(postSurfaceObject);
  postSurfaceObjectRef.current = postSurfaceObject;
  /**
   * 枯渇状態と釣果時刻をサーバーから取り直す（読み込み済みタイル窓の範囲）。
   * 他プレイヤーの行為は WS の kv 差分でも届くため、これは初期表示と
   * WS 不健全時のフォールバック。マージは新しい時刻を優先する。
   */
  const refreshSurfaceStates = async () => {
    const c = tilesCenterRef.current
      ?? { x: Math.floor(playerPosRef.current.x), y: Math.floor(playerPosRef.current.y) };
    const q = `x0=${c.x - 64}&y0=${c.y - 64}&x1=${c.x + 64}&y1=${c.y + 64}`;
    try {
      const [objRes, fishRes] = await Promise.all([
        fetch(`/api/worldbox/objects?${q}`, { headers: { Accept: "application/json" } }),
        fetch(`/api/worldbox/fishing?${q}`, { headers: { Accept: "application/json" } }),
      ]);
      if (objRes.ok) {
        const data = (await objRes.json()) as { states?: Record<string, number> };
        for (const [k, v] of Object.entries(data.states ?? {})) {
          if (v > (surfaceObjStateRef.current.get(k) ?? 0)) surfaceObjStateRef.current.set(k, v);
        }
      }
      if (fishRes.ok) {
        const data = (await fishRes.json()) as { caught?: Record<string, number> };
        for (const [k, v] of Object.entries(data.caught ?? {})) {
          if (v > (fishCaughtRef.current.get(k) ?? 0)) fishCaughtRef.current.set(k, v);
        }
      }
    } catch { /* 読めなくても歩き続けられる */ }
  };
  const refreshSurfaceStatesRef = useRef(refreshSurfaceStates);
  refreshSurfaceStatesRef.current = refreshSurfaceStates;
  const sendChat = async () => {
    const text = chatText.trim();
    if (!text) return;
    setChatText("");
    try {
      const res = await fetch("/api/worldbox/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: chatChannel, text, space: spaceUi }),
      });
      if (res.ok) {
        const data = (await res.json()) as { message?: { name: string; text: string; at: number; source?: string } };
        if (data.message) setChatMsgs((prev) => [data.message!, ...prev].slice(0, 50));
      } else if (res.status === 429) {
        setTileMsg("少し待って");
      } else if (res.status === 409) {
        setTileMsg("ユニオン未所属");
      }
    } catch { /* noop */ }
  };
  const refreshParty = async (force = false) => {
    // 古いレスポンスが新しいパーティ状態（招待・編成）を巻き戻さない（S6）
    const ticket = partyGuardRef.current.begin(force ? { force: true } : undefined);
    if (ticket === null) return;
    try {
      // ダンジョン内ではセッション要約も一緒に受け取る（?space= を付けないと
      // サーバー側の要約経路が死んだままになる）
      const dungeonSpace = parseInstanceSpace(spaceUi)?.kind === "dungeon" ? spaceUi : null;
      const res = await fetch(
        dungeonSpace ? `/api/worldbox/party?space=${encodeURIComponent(dungeonSpace)}` : "/api/worldbox/party",
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        party?: PartyViewClient | null; partyKey?: string; isLeader?: boolean;
        invite?: { partyId: string; leaderName: string } | null;
        dungeon?: {
          size: number; floorBossDead: Record<string, boolean>; bossDead: boolean;
          gateFloor2?: boolean; gateBoss?: boolean;
        } | null;
      };
      if (!partyGuardRef.current.isCurrent(ticket)) return;
      if (data.dungeon) {
        // ボス進行と人数だけを要約で更新する（宝箱・扉はインスタンス
        // 取得の正のまま残す）。インスタンス watch の poke と二重に
        // 届いても同じ値へ収束する。
        dungeonStateRef.current = {
          ...dungeonStateRef.current,
          size: data.dungeon.size,
          floorBossDead: data.dungeon.floorBossDead,
          bossDead: data.dungeon.bossDead,
          gateFloor2: data.dungeon.gateFloor2 ?? dungeonStateRef.current.gateFloor2,
          gateBoss: data.dungeon.gateBoss ?? dungeonStateRef.current.gateBoss,
        };
      }
      myPartyKeyRef.current = data.partyKey ?? "";
      setPartyUi({
        party: data.party ?? null, partyKey: data.partyKey ?? "",
        isLeader: data.isLeader ?? false, invite: data.invite ?? null,
      });
    } catch { /* noop */ }
    finally {
      partyGuardRef.current.end(ticket);
    }
  };
  const refreshPartyRef = useRef(refreshParty);
  refreshPartyRef.current = refreshParty;
  useEffect(() => {
    void refreshParty();
    // WS push が健全な間はパーティ変更が poke で届くため定期取得しない
    const timer = window.setInterval(() => { if (!wsHealthyNow()) void refreshPartyRef.current(); }, 4000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void refreshSurfaceStates();
    // WS push が健全な間は枯渇・釣果の差分が kv で届くため定期取得しない
    const timer = window.setInterval(() => { if (!wsHealthyNow()) void refreshSurfaceStatesRef.current(); }, 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const postParty = async (action: string, extra: Record<string, unknown> = {}): Promise<{ ok: boolean; space?: string; error?: string }> => {
    try {
      const res = await fetch("/api/worldbox/party", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, px: playerPosRef.current.x, py: playerPosRef.current.y, ...extra }),
      });
      const data = (await res.json().catch(() => ({}))) as { space?: string; error?: string };
      void refreshParty(true);
      return { ok: res.ok, space: data.space, error: data.error };
    } catch {
      return { ok: false, error: "network" };
    }
  };
  const postPartyRef = useRef(postParty);
  postPartyRef.current = postParty;
  /** エンジン側の入場フロー（入口座標→セッション作成→空間遷移）。 */
  const enterDungeonRef = useRef<((ex: number, ey: number) => void) | null>(null);
  /** インスタンス内アクション（洞窟の採掘/宝箱/温泉、遺跡の宝箱/扉/罠）。検証と付与はサーバーが担う。 */
  const postInstance = async (
    action: "mine" | "open_chest" | "onsen" | "open_door" | "trap" | "leave",
    extra?: { veinKey?: string; chestIdx?: number; doorIdx?: number; trapIdx?: number; fxX?: number; fxY?: number; fxObjectId?: string },
  ) => {
    const space = spaceUi;
    const kindNow = parseInstanceSpace(space)?.kind;
    if (kindNow !== "cave" && kindNow !== "ruins" && kindNow !== "dungeon") return;
    try {
      const res = await fetch("/api/worldbox/instances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, space, px: playerPosRef.current.x, py: playerPosRef.current.y, ...extra }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string; gained?: Record<string, number>; trapped?: boolean; profile?: PlayerProfile;
        teleport?: { x: number; y: number } | null; kind?: string; broke?: string;
      };
      if (!res.ok) {
        if (data.error && TILE_ERROR_LABEL[data.error]) setTileMsg(TILE_ERROR_LABEL[data.error]);
        // 失敗理由がサーバー状態とのずれ（他人が先に採って枯渇した等）の
        // ことがあるため、表示キャッシュをサーバーの正へ寄せ直す
        if (kindNow === "cave") void refreshCaveState(space);
        else if (kindNow === "dungeon") void refreshDungeonState(space);
        else void refreshRuinsState(space);
        return;
      }
      if (data.profile) setInvProfile(data.profile);
      if (data.broke) {
        setTileMsg(`${itemById(data.broke)?.name ?? "道具"}が壊れた`);
        playWbSe("debris");
      }
      if (data.teleport) {
        instanceTeleportRef.current?.(data.teleport.x, data.teleport.y);
        playWbSe("warp");
      } else if (data.trapped || data.kind === "damage" || data.kind === "poison") {
        fxEventsRef.current.push({ kind: "hit", x: playerPosRef.current.x, y: playerPosRef.current.y, stop: HITSTOP_HURT_MS });
        playWbSe("hit");
      } else if (data.kind === "alarm") {
        fxEventsRef.current.push({ kind: "hit", x: playerPosRef.current.x, y: playerPosRef.current.y, stop: HITSTOP_HURT_MS });
        playWbSe("error");
        void refreshMobsRef.current();
      } else if (extra?.fxX !== undefined && extra?.fxY !== undefined && (action === "mine" || action === "open_chest" || action === "open_door")) {
        // 対象の位置で素材の粒を返す（従来は全部プレイヤー位置の poof で同じだった）
        fxEventsRef.current.push({
          kind: action === "mine" ? "mine" : action === "open_chest" ? "harvest" : "place",
          x: extra.fxX, y: extra.fxY,
          colors: burstPaletteFor(extra.fxObjectId ?? (action === "open_chest" ? "chest" : undefined)) ?? undefined,
        });
        playWbSe("success");
      } else if (action === "onsen") {
        fxEventsRef.current.push({ kind: "splash", x: playerPosRef.current.x, y: playerPosRef.current.y });
        playWbSe("success");
      } else {
        fxEventsRef.current.push({ kind: "poof", x: playerPosRef.current.x, y: playerPosRef.current.y });
        playWbSe("success");
      }
      if (kindNow === "cave") void refreshCaveState(space);
      else if (kindNow === "dungeon") void refreshDungeonState(space);
      else void refreshRuinsState(space);
    } catch { /* 失敗しても歩き続けられる */ }
  };
  const postInstanceRef = useRef(postInstance);
  postInstanceRef.current = postInstance;
  /** ベッドを踏んだらリスポーン点にする（同じベッドでは1回だけ送る）。 */
  const postBedRespawn = (x: number, y: number) => {
    const key = `${x},${y}`;
    if (bedKeyRef.current === key) return;
    bedKeyRef.current = key;
    void postVitals({ action: "set_bed", x, y }, true);
  };
  // 薬師は近くの死亡地点を定期取得する（蘇生の対象表示）
  useEffect(() => {
    if (invProfile?.role !== "medic") {
      deathsRef.current = [];
      return;
    }
    let disposed = false;
    const tick = async () => {
      // 古いレスポンスが蘇生済みの死亡地点を蘇生対象として復活させない（S6）
      const ticket = deathsGuardRef.current.begin();
      if (ticket === null) return;
      try {
        const pos = playerPosRef.current;
        const res = await fetch(
          `/api/worldbox/roles?space=${encodeURIComponent(spaceUi)}&x=${pos.x}&y=${pos.y}`,
          { headers: { Accept: "application/json" } },
        );
        if (!res.ok || disposed) return;
        const data = (await res.json()) as { deaths?: { name: string; x: number; y: number; at: number }[] };
        if (!disposed && deathsGuardRef.current.isCurrent(ticket)) deathsRef.current = data.deaths ?? [];
      } catch { /* 読めなくても歩き続けられる */ }
      finally {
        deathsGuardRef.current.end(ticket);
      }
    };
    void tick();
    const timer = window.setInterval(tick, 3000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [invProfile?.role, spaceUi]);

  // バイタルの定期精算（空腹・毒・飢えはサーバー側の時刻で進む）。
  // 現在位置と空間も送り、サーバーが前回精算位置との平均速度から
  // 空腹の活動クラス（放置/移動/ダッシュ）を判定する。
  useEffect(() => {
    const timer = window.setInterval(() => void postVitals({
      action: "sync",
      px: playerPosRef.current.x, py: playerPosRef.current.y,
      space: spaceUiRef.current,
    }), 15000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 最後にタイルを取得した中心（タイル座標）。移動で外れたら取り直す。 */
  const tilesCenterRef = useRef<{ x: number; y: number } | null>(null);
  const tilesInFlightRef = useRef(false);
  const tilesQueuedRef = useRef(false);
  const refreshTiles = async () => {
    // 取得中の追加要求は、完了後に最新位置でもう1回だけ取り直す
    if (tilesInFlightRef.current) {
      tilesQueuedRef.current = true;
      return;
    }
    tilesInFlightRef.current = true;
    // 取得開始後にローカル行為（掘る・置く）でタイルが変わったら、その
    // 古いレスポンスは適用せず取り直す（S6）。行為は tilesVersionRef を進める。
    const tilesGen = tilesVersionRef.current;
    try {
      const px = Math.floor(playerPosRef.current.x);
      const py = Math.floor(playerPosRef.current.y);
      const x0 = px - 64;
      const y0 = py - 64;
      const res = await fetch(
        `/api/worldbox/tiles?x0=${x0}&y0=${y0}&x1=${x0 + 127}&y1=${y0 + 127}`,
        { headers: { Accept: "application/json" } },
      );
      if (res.ok && tilesGen !== tilesVersionRef.current) {
        // 取得中にローカル行為でタイルが変わった。古いスナップショットで
        // 上書きせず、完了後に取り直す。
        tilesQueuedRef.current = true;
      } else if (res.ok) {
        const data = (await res.json()) as { overrides?: TileOverridesMap; selfId?: string | null };
        if (data.selfId !== undefined) selfIdRef.current = data.selfId;
        const next: TileOverridesMap = { ...tilesRef.current };
        for (const key of Object.keys(next)) {
          const m = /^(-?\d+),(-?\d+)$/.exec(key);
          if (!m) continue;
          const x = Number(m[1]);
          const y = Number(m[2]);
          if (x >= x0 && x <= x0 + 127 && y >= y0 && y <= y0 + 127) delete next[key];
        }
        Object.assign(next, data.overrides ?? {});
        tilesRef.current = next;
        tilesVersionRef.current += 1;
        tilesCenterRef.current = { x: px, y: py };
        syncBlockBlocked();
        // タイル窓が動いたら地表オブジェクトの枯渇・釣果も同じ窓で取り直す
        void refreshSurfaceStatesRef.current();
      }
    } catch { /* 読めなくても歩き続けられる */ }
    finally {
      tilesInFlightRef.current = false;
    }
    if (tilesQueuedRef.current) {
      tilesQueuedRef.current = false;
      void refreshTiles();
    }
  };
  const refreshTilesRef = useRef(refreshTiles);
  refreshTilesRef.current = refreshTiles;
  const postTileAction = async (action: TileActionKind, x: number, y: number, seedId?: string, itemId?: string, text?: string) => {
    setTileMsg("");
    // 掘る前のブロック素材（応答で上書きが差し替わるため先に控える。破片の色に使う）
    const prevBlockId = action === "mine_block" ? tilesRef.current[tileKey(x, y)]?.block?.itemId : undefined;
    try {
      const res = await fetch("/api/worldbox/tiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, x, y, ...(seedId ? { seedId } : {}), ...(itemId ? { itemId } : {}), ...(text !== undefined ? { text } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string; key?: string; override?: TileOverridesMap[string] | null; profile?: PlayerProfile;
        broke?: string;
      };
      if (!res.ok) {
        setTileMsg(TILE_ERROR_LABEL[data.error ?? ""] ?? "できませんでした");
        // 失敗は空振りで返す（風切りだけ・成功の粒は出さない）
        fxEventsRef.current.push({ kind: "whiff", x, y });
        return;
      }
      // 成功した行為は演出で返す（粒・揺れ・出現ポップは描画ループ側で出す）
      const fxKind: Record<TileActionKind, FxBurstKind> = {
        chop: "chop", mine: "mine", till: "till", plant: "plant", harvest: "harvest",
        place_block: "place", mine_block: "debris",
        plant_flower: "plant", remove_flower: "harvest",
        toggle_gate: "place",
        set_sign: "place", set_display: "place", clear_display: "harvest", draw_water: "splash",
      };
      // ブロック採掘（HP制）: 壊れたら破片（debris）、まだ残るヒットは小さな破片（mine）
      const fxForAction =
        action === "mine_block" && data.override?.block ? "mine" : fxKind[action];
      fxEventsRef.current.push({
        kind: fxForAction, x, y,
        colors: action === "mine_block" ? burstPaletteFor(prevBlockId) ?? undefined : undefined,
      });
      if (data.key) {
        const next = { ...tilesRef.current };
        if (data.override) next[data.key] = data.override;
        else delete next[data.key];
        tilesRef.current = next;
        tilesVersionRef.current += 1;
        syncBlockBlocked();
      }
      if (data.profile) setInvProfile(data.profile);
      if (data.broke) {
        setTileMsg(`${itemById(data.broke)?.name ?? "道具"}が壊れた`);
        playWbSe("debris");
      }
    } catch {
      setTileMsg("できませんでした");
      fxEventsRef.current.push({ kind: "whiff", x, y });
    }
  };
  const postTileActionRef = useRef(postTileAction);
  postTileActionRef.current = postTileAction;
  /** 屋台の操作（出品・取り下げ・購入）。結果の出品とプロフィールで表示を更新する。 */
  const postStallAction = async (action: "list_item" | "unlist" | "buy", x: number, y: number, extra?: { itemId?: string; price?: number; count?: number }) => {
    try {
      const res = await fetch("/api/worldbox/stalls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, x, y, ...(extra ?? {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        stall?: { itemId: string; name: string; price: number; count: number; mine: boolean } | null;
        profile?: PlayerProfile;
      };
      if (!res.ok) {
        setTileMsg(TILE_ERROR_LABEL[data.error ?? ""] ?? "できませんでした");
        return;
      }
      setStallInfo(data.stall ?? null);
      if (data.profile) setInvProfile(data.profile);
    } catch {
      setTileMsg("できませんでした");
    }
  };
  /** モブ個体状態（傷/死亡がある個体だけサーバーから受ける）。 */
  const mobStatesRef = useRef<Record<string, MobState>>({});
  // モブ状態の世代（S6）: 攻撃によるローカル書き込みで進み、取得開始後に
  // 進んでいたら古いレスポンスは適用せず取り直す（倒したモブの生き返り防止）。
  const mobsVersionRef = useRef(0);
  const mobsInFlightRef = useRef(false);
  const mobsQueuedRef = useRef(false);
  const refreshMobs = async () => {
    // 取得中の追加要求は、完了後に最新状態でもう1回だけ取り直す（S6）
    if (mobsInFlightRef.current) {
      mobsQueuedRef.current = true;
      return;
    }
    mobsInFlightRef.current = true;
    const mobsGen = mobsVersionRef.current;
    try {
      const ruinsSpace = parseInstanceSpace(spaceUi)?.kind === "ruins" ? spaceUi : null;
      if (ruinsSpace) {
        const res = await fetch(
          `/api/worldbox/mobs?space=${encodeURIComponent(ruinsSpace)}`,
          { headers: { Accept: "application/json" } },
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          states?: Record<string, MobState>;
          summons?: { mobId: string; x: number; y: number; size: number }[];
        };
        // 取得中に攻撃でモブ状態が変わっていたら古い応答は捨て、取り直す（S6）
        if (mobsGen !== mobsVersionRef.current) { mobsQueuedRef.current = true; return; }
        ruinsStateRef.current = {
          ...ruinsStateRef.current,
          summons: (data.summons ?? []).map((sm) => ({ mobId: sm.mobId, x: sm.x, y: sm.y })),
        };
        const next: Record<string, MobState> = { ...mobStatesRef.current };
        for (const key of Object.keys(next)) {
          if (key.startsWith(`${ruinsSpace}|`)) delete next[key];
        }
        Object.assign(next, data.states ?? {});
        mobStatesRef.current = next;
        return;
      }
      const caveSpace = parseInstanceSpace(spaceUi)?.kind === "cave" ? spaceUi : null;
      if (caveSpace) {
        const res = await fetch(
          `/api/worldbox/mobs?space=${encodeURIComponent(caveSpace)}`,
          { headers: { Accept: "application/json" } },
        );
        if (!res.ok) return;
        const data = (await res.json()) as { states?: Record<string, MobState> };
        if (mobsGen !== mobsVersionRef.current) { mobsQueuedRef.current = true; return; }
        const next: Record<string, MobState> = { ...mobStatesRef.current };
        for (const key of Object.keys(next)) {
          if (key.startsWith(`${caveSpace}|`)) delete next[key];
        }
        Object.assign(next, data.states ?? {});
        mobStatesRef.current = next;
        return;
      }
      // ダンジョンも洞窟・遺跡と同じく空間単位で取り直す（S4）。
      // 無いとダンジョンのモブ状態は倒した時の自作値のまま更新されず、
      // 他者の撃破・復活が画面に反映されない。
      const dungeonSpace = parseInstanceSpace(spaceUi)?.kind === "dungeon" ? spaceUi : null;
      if (dungeonSpace) {
        const res = await fetch(
          `/api/worldbox/mobs?space=${encodeURIComponent(dungeonSpace)}`,
          { headers: { Accept: "application/json" } },
        );
        if (!res.ok) return;
        const data = (await res.json()) as { states?: Record<string, MobState> };
        if (mobsGen !== mobsVersionRef.current) { mobsQueuedRef.current = true; return; }
        const next: Record<string, MobState> = { ...mobStatesRef.current };
        for (const key of Object.keys(next)) {
          if (key.startsWith(`${dungeonSpace}#`)) delete next[key];
        }
        Object.assign(next, data.states ?? {});
        mobStatesRef.current = next;
        return;
      }
      const px = Math.floor(playerPosRef.current.x);
      const py = Math.floor(playerPosRef.current.y);
      const x0 = px - 64;
      const y0 = py - 64;
      const res = await fetch(
        `/api/worldbox/mobs?x0=${x0}&y0=${y0}&x1=${x0 + 127}&y1=${y0 + 127}`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) return;
      const data = (await res.json()) as { states?: Record<string, MobState> };
      if (mobsGen !== mobsVersionRef.current) { mobsQueuedRef.current = true; return; }
      const next: Record<string, MobState> = { ...mobStatesRef.current };
      for (const key of Object.keys(next)) {
        if (key.includes("|")) continue;
        const m = /@(-?\d+),(-?\d+)$/.exec(key);
        if (!m) continue;
        const x = Number(m[1]);
        const y = Number(m[2]);
        if (x >= x0 && x <= x0 + 127 && y >= y0 && y <= y0 + 127) delete next[key];
      }
      Object.assign(next, data.states ?? {});
      mobStatesRef.current = next;
    } catch { /* 読めなくても歩き続けられる */ }
    finally {
      mobsInFlightRef.current = false;
      if (mobsQueuedRef.current) {
        mobsQueuedRef.current = false;
        void refreshMobs();
      }
    }
  };
  /** モブへの攻撃（サーバーが配置・距離・HP の正）。結果は演出で返す。 */
  const attackMob = async (placed: PlacedMob, curTile?: { x: number; y: number }) => {
    let key = mobKeyOf(placed);
    const def = mobById(placed.mobId);
    try {
      const res = await fetch("/api/worldbox/mobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "attack", mobId: placed.mobId, x: placed.x, y: placed.y,
          ...(parseInstanceSpace(spaceUi) ? { space: spaceUi } : {}),
          // サーバー側の位置の正（プレゼンス）が WS 中継中は bot_kv に届かないため、
          // 距離検証のフォールバックとして現在位置を添える（プレゼンスが新鮮ならそちらが優先される）
          px: playerPosRef.current.x, py: playerPosRef.current.y,
          // モブの見た目の現在タイルも申告する。サーバーはアンカーしか
          // 知らないため、これがないと追跡してきたモブに攻撃が通らない。
          ...(curTile ? { mx: curTile.x, my: curTile.y } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string; hp?: number; dead?: boolean; profile?: PlayerProfile; key?: string; deadUntil?: number;
        broke?: string;
      };
      if (data.key) key = data.key;
      if (!res.ok) {
        if (data.error === "too_far") setTileMsg(TILE_ERROR_LABEL.too_far);
        fxEventsRef.current.push({ kind: "whiff", x: placed.x, y: placed.y });
        return;
      }
      const next = { ...mobStatesRef.current };
      // 復活時刻はサーバーの正を使う（S4）。無ければ従来どおり自時計で計算する。
      if (data.dead) next[key] = { hp: 0, deadUntil: typeof data.deadUntil === "number" ? data.deadUntil : Date.now() + MOB_RESPAWN_MS + mobRespawnDelayMs(key) };
      else if (typeof data.hp === "number") next[key] = { hp: data.hp };
      mobStatesRef.current = next;
      // 攻撃でローカル状態が進んだ。取得中の古いモブ応答は適用されない（S6）。
      mobsVersionRef.current += 1;
      fxEventsRef.current.push({
        kind: data.dead ? "death" : "hit",
        x: placed.x, y: placed.y,
        sizeTiles: placed.size,
        color: def ? MOB_FX_COLOR[def.id] : undefined,
        // 命中の一瞬だけ時を止める（自分の攻撃が届いた時だけ）
        stop: data.dead ? HITSTOP_KILL_MS : HITSTOP_HIT_MS,
      });
      if (data.profile) setInvProfile(data.profile);
      if (data.broke) {
        setTileMsg(`${itemById(data.broke)?.name ?? "剣"}が壊れた`);
        playWbSe("debris");
      }
      // ダンジョンで倒したらセッション進行（フロアボス撃破→階段開放、
      // 番人の鍵は profile 側）を取り直す。従来は自分の画面でも階段が
      // 「ボスを倒すと開く」のまま固まっていた。
      if (data.dead && parseInstanceSpace(spaceUi)?.kind === "dungeon") {
        void refreshDungeonState(spaceUi);
      }
    } catch {
      fxEventsRef.current.push({ kind: "whiff", x: placed.x, y: placed.y });
    }
  };
  const attackMobRef = useRef(attackMob);
  attackMobRef.current = attackMob;
  /** プレイヤーへの攻撃（PvP。サーバーが空間・距離・HP の正）。結果は演出で返す。 */
  const attackPlayer = async (targetId: string, tx: number, ty: number) => {
    try {
      const res = await fetch("/api/worldbox/vitals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "pvp", target: targetId,
          px: playerPosRef.current.x, py: playerPosRef.current.y,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string; applied?: boolean; died?: boolean;
      };
      if (!res.ok) {
        if (data.error === "too_far") setTileMsg(TILE_ERROR_LABEL.too_far);
        denyAtTile(tx, ty);
        return;
      }
      if (data.applied) {
        // ヒット/死亡の粒と音は fx イベント経由で描画ループが出す
        fxEventsRef.current.push({ kind: data.died ? "death" : "hit", x: tx, y: ty, stop: data.died ? HITSTOP_KILL_MS : HITSTOP_HIT_MS });
      } else {
        fxEventsRef.current.push({ kind: "whiff", x: tx, y: ty });
      }
    } catch {
      fxEventsRef.current.push({ kind: "whiff", x: tx, y: ty });
    }
  };
  const attackPlayerRef = useRef(attackPlayer);
  attackPlayerRef.current = attackPlayer;
  const refreshMobsRef = useRef(refreshMobs);
  refreshMobsRef.current = refreshMobs;
  /** テント拡張の購入（サーバー側 expand_tent が正）。 */
  const expandTent = async () => {
    try {
      const res = await fetch("/api/worldbox/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "expand_tent" }),
      });
      const data = (await res.json().catch(() => ({}))) as { profile?: PlayerProfile; error?: string };
      if (res.ok && data.profile) {
        setInvProfile(data.profile);
        setTileMsg("テントが広くなった");
      } else {
        setTileMsg(data.error === "insufficient_balance" ? "コインが足りない" : "拡張できない");
      }
    } catch { /* noop */ }
  };
  /** インベントリ整理: 任意スロット間の移動（サーバー側 moveSlot が正）。 */
  const moveItem = async (from: SlotRef, to: SlotRef) => {
    try {
      const res = await fetch("/api/worldbox/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "move", from, to }),
      });
      const data = (await res.json().catch(() => ({}))) as { profile?: PlayerProfile };
      if (res.ok && data.profile) setInvProfile(data.profile);
    } catch { /* noop */ }
  };
  /** スロットのタップ: 持ち上げ → 置く/交換。同じ枠の再タップで解除。 */
  const tapSlot = (zone: SlotRef["zone"], index: number) => {
    if (!invProfile) return;
    const slot = zone === "hotbar" ? invProfile.hotbar[index] : invProfile.storage[index];
    if (!heldSlot) {
      if (slot) setHeldSlot({ zone, index });
      return;
    }
    if (heldSlot.zone === zone && heldSlot.index === index) {
      setHeldSlot(null);
      return;
    }
    const from = heldSlot;
    setHeldSlot(null);
    void moveItem(from, { zone, index });
  };

  /** 自分の収納コンテナ（樽・宝箱）を開く。中身はサーバーが正。
   * space が world 以外のときは室内の備え付け樽・木箱（サーバー側で解決する。
   * ロビーの中身はプレイヤー別）。 */
  const openContainer = async (x: number, y: number, itemId: string, space: "world" | "tent" | "lobby" | "lobby2" | "lobby3" = "world") => {
    setStorageOpen(false);
    setHeldSlot(null);
    setHeldPanelSlot(null);
    setContainerSlots(null);
    setContainerPanel({ x, y, itemId, space });
    try {
      const res = await fetch(`/api/worldbox/containers?x=${x}&y=${y}${space !== "world" ? `&space=${space}` : ""}`, {
        headers: { Accept: "application/json" },
      });
      const data = (await res.json().catch(() => ({}))) as {
        container?: { slots?: ItemSlot[] }; error?: string;
      };
      if (!res.ok) {
        setContainerPanel(null);
        setTileMsg(TILE_ERROR_LABEL[data.error ?? ""] ?? "開けない");
        return;
      }
      setContainerSlots(data.container?.slots ?? null);
    } catch {
      setContainerPanel(null);
      setTileMsg("開けない");
    }
  };
  const openContainerRef = useRef(openContainer);
  openContainerRef.current = openContainer;
  /** コンテナ⇔プロフィール間のスロット移動（サーバー側 moveContainerSlot が正）。 */
  const moveContainerItem = async (from: ContainerSlotRef, to: ContainerSlotRef) => {
    if (!containerPanel) return;
    try {
      const res = await fetch("/api/worldbox/containers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "move", x: containerPanel.x, y: containerPanel.y, from, to,
          ...(containerPanel.space !== "world" ? { space: containerPanel.space } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        profile?: PlayerProfile; container?: { slots?: ItemSlot[] }; error?: string;
      };
      if (!res.ok) {
        setTileMsg(TILE_ERROR_LABEL[data.error ?? ""] ?? "動かせない");
        return;
      }
      if (data.profile) setInvProfile(data.profile);
      if (data.container) setContainerSlots(data.container.slots ?? null);
    } catch { /* noop */ }
  };
  /** コンテナパネルのスロットタップ: 持ち上げ → 置く/交換（インベントリ整理と同じ）。 */
  const tapPanelSlot = (ref: ContainerSlotRef) => {
    const slot = ref.side === "container"
      ? (containerSlots?.[ref.index] ?? null)
      : ref.side === "profile_hotbar"
        ? (invProfile?.hotbar[ref.index] ?? null)
        : (invProfile?.storage[ref.index] ?? null);
    if (!heldPanelSlot) {
      if (slot) setHeldPanelSlot(ref);
      return;
    }
    if (heldPanelSlot.side === ref.side && heldPanelSlot.index === ref.index) {
      setHeldPanelSlot(null);
      return;
    }
    const from = heldPanelSlot;
    setHeldPanelSlot(null);
    void moveContainerItem(from, ref);
  };

  useEffect(() => {
    void refreshNations();
    void refreshGuildShopPlots();
    void refreshInv();
    void refreshTiles();
    void refreshMobs();
    const timer = window.setInterval(() => {
      // WS push が健全な間は nations/tiles/mobs が push（poke 含む）で
      // 届くため取得しない。プロフィールは push 対象外なので従来どおり。
      if (wsHealthyNow()) {
        void refreshInv();
        return;
      }
      void refreshNations();
      void refreshGuildShopPlots();
      void refreshInv();
      void refreshTiles();
      void refreshMobs();
    }, 15000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 歩いて取得範囲（128×128）の端に近づいたら先読みで取り直す
  useEffect(() => {
    const timer = window.setInterval(() => {
      const c = tilesCenterRef.current;
      if (!c) return;
      const dx = Math.abs(Math.floor(playerPosRef.current.x) - c.x);
      const dy = Math.abs(Math.floor(playerPosRef.current.y) - c.y);
      if (Math.max(dx, dy) >= 48) void refreshTilesRef.current();
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const lobby = buildLobby();
    let tentTierSeen = -1;
    let tentData = buildTent(0);
    const tentNow = () => {
      const tier = invRef.current?.tentTier ?? 0;
      if (tier !== tentTierSeen) {
        tentTierSeen = tier;
        tentData = buildTent(tier);
      }
      return tentData;
    };
    /** 現在の室内空間（ロビー/テント）のデータ。ワールドでは lobby を返す（使われない）。 */
    let caveCacheKey = "";
    let caveCache: CaveLayer | null = null;
    const caveLayerNow = (): CaveLayer | null => {
      const inst = parseInstanceSpace(space);
      if (inst?.kind !== "cave") return null;
      if (caveCacheKey !== space) {
        caveCacheKey = space;
        caveCache = buildCaveLayer(MAP_SEED, inst.entranceX, inst.entranceY, inst.layer);
      }
      return caveCache;
    };
    let ruinsCacheKey = "";
    let ruinsCache: RuinsMap | null = null;
    const ruinsNow = (): RuinsMap | null => {
      const inst = parseInstanceSpace(space);
      if (inst?.kind !== "ruins") return null;
      if (ruinsCacheKey !== space) {
        ruinsCacheKey = space;
        ruinsCache = buildRuins(MAP_SEED, inst.entranceX, inst.entranceY);
      }
      return ruinsCache;
    };
    let dungeonCacheKey = "";
    let dungeonCache: DungeonFloorData | null = null;
    const dungeonNow = (): DungeonFloorData | null => {
      const inst = parseInstanceSpace(space);
      if (inst?.kind !== "dungeon") return null;
      if (dungeonCacheKey !== space) {
        dungeonCacheKey = space;
        dungeonCache = buildDungeonFloor(MAP_SEED, inst.entranceX, inst.entranceY, inst.layer);
      }
      return dungeonCache;
    };
    /** モブ状態のキー（インスタンス内は空間 ID で前置し、地表の同座標個体と分ける。
     * ダンジョンはパーティキーでも分ける）。 */
    const mobKeyFor = (placed: PlacedMob): string => {
      const inst = parseInstanceSpace(space);
      if (inst?.kind === "dungeon") return `${space}#${myPartyKeyRef.current}|${mobKeyOf(placed)}`;
      return inst ? `${space}|${mobKeyOf(placed)}` : mobKeyOf(placed);
    };
    /** ダンジョンではモブ HP がパーティ人数で倍率される（サーバーと同じ式）。 */
    const defFor = (def: NonNullable<ReturnType<typeof mobById>>) =>
      parseInstanceSpace(space)?.kind === "dungeon"
        ? { ...def, hp: Math.max(1, Math.round(def.hp * dungeonHpScale(dungeonStateRef.current.size))) }
        : def;
    const indoorData = (): LobbyData => caveLayerNow()?.data ?? ruinsNow()?.data ?? dungeonNow()?.data ?? (space === "tent" ? tentNow() : space === "lobby2" ? buildLobby2() : space === "lobby3" ? buildLobby3() : lobby);
    const textures = loadTextures();
    const dungeon = loadDungeonTiles();
    const lobbySprites = loadLobbySprites();
    const farmSprites = loadFarmSprites();
    const mobSprites = loadMobSprites();
    // アイテムアイコン（設置ブロックの描画用。アイコンの無いアイテムは平色）
    const itemIcons: Record<string, HTMLImageElement> = {};
    for (const item of ITEMS) {
      if (!item.icon) continue;
      const img = new Image();
      img.src = item.icon;
      itemIcons[item.id] = img;
    }
    const avatar = new Image();
    avatar.src = "/img/nomal.png";

    // 地形はチャンク単位で生成してキャッシュする。実効タイル源は
    // 「チャンク地形＋タイル上書き（伐採・採掘の地形置き換え）」で、
    // 移動・描画・行為可否はこちらを見る。全体グリッドは持たない。
    const chunkCache = new Map<string, Uint8Array>();
    const baseTileAt = (x: number, y: number): number => {
      const cx = Math.floor(x / CHUNK_SIZE);
      const cy = Math.floor(y / CHUNK_SIZE);
      const key = `${cx},${cy}`;
      let tiles = chunkCache.get(key);
      if (tiles) {
        chunkCache.delete(key);
        chunkCache.set(key, tiles);
      } else {
        tiles = generateChunk(cx, cy, MAP_SEED).tiles;
        chunkCache.set(key, tiles);
        if (chunkCache.size > 96) {
          const oldest = chunkCache.keys().next().value;
          if (oldest !== undefined) chunkCache.delete(oldest);
        }
      }
      return tiles[(y - cy * CHUNK_SIZE) * CHUNK_SIZE + (x - cx * CHUNK_SIZE)];
    };
    const effTileAt = (x: number, y: number): number => {
      const ov = tilesRef.current[tileKey(x, y)];
      if (ov && ov.tile !== undefined && isOverrideActive(ov, Date.now())) return ov.tile;
      return baseTileAt(x, y);
    };
    /** 素の地形（タイル行為の判定用。上書きは tiles.ts 側で重ねる）。 */
    const terrainMap: TopDownMap = { seed: MAP_SEED, tileAt: (x, y) => tileAt(x, y, MAP_SEED) };
    /** 実効地形（上書き込み）。 */
    const worldMap: TopDownMap = { seed: MAP_SEED, tileAt: effTileAt };

    // 初期スポーンはサーバー（セーブ初回作成時）が決めるのが正。ここでの
    // 値はセーブ読込前の仮置きで、同じ規則でランダムに選ぶ。
    const spawn = pickRandomSpawn(Math.random);
    const player: PlayerState = { x: spawn.x, y: spawn.y, vx: 0, vy: 0, face: 1, phase: 0 };
    const cam = { x: player.x, y: player.y };
    /** 望遠鏡の自由視点（null = 通常追従）。開いた瞬間のプレイヤー位置から始まる。 */
    let telescopeCam: { x: number; y: number } | null = null;
    let telescopeDrag: { pointerId: number; lastX: number; lastY: number } | null = null;
    let telescopeCenterSeen = 0;
    /** 競馬の観戦アニメ用キャッシュ（発走中のレースの中核は1回だけ作る）。 */
    let raceAnimCache: { postMs: number; core: RaceCore } | null = null;
    // 空間（ワールド / ロビー）。ロビーでは国家・ミニマップは扱わない。
    let space: SaveSpace = "world";
    let worldReturn: { x: number; y: number } | null = null;
    // シームレスローディング（B1）: 空間遷移はフェードでつなぐ。切替は
    // フェードアウトの頂点で1回だけ走る。performance.now() ベース。
    let transitionStart = -1; // -1 = 非遷移中
    let transitionKind: TransitionKind = "warp";
    let transitionSwapped = true;
    let transitionPending: (() => void) | null = null;
    const beginTransition = (apply: () => void) => {
      if (transitionStart >= 0 && transitionKind === "warp" && !transitionDone(performance.now() - transitionStart, "warp")) {
        if (!transitionSwapped) {
          // フェードアウト中は最新の切替で上書き（連打で二重ワープしない）。
          transitionPending = apply;
          return;
        }
        // フェードイン中の切替は暗幕の下でそのまま通す。
        apply();
        return;
      }
      transitionKind = "warp";
      transitionSwapped = false;
      transitionPending = apply;
      transitionStart = performance.now();
    };
    const activeMap = (): TopDownMap => (space === "world" ? worldMap : indoorData().moveMap);
    const activeBounds = () => {
      const inst = parseInstanceSpace(space);
      if (inst?.kind === "cave") return rectBounds(64, 64);
      if (inst?.kind === "ruins") return rectBounds(48, 48);
      if (inst?.kind === "dungeon") return rectBounds(52, 52);
      return space === "lobby" ? rectBounds(LOBBY_W, LOBBY_H)
        : space === "lobby2" ? rectBounds(LOBBY2_W, LOBBY2_H)
        : space === "lobby3" ? rectBounds(LOBBY3_W, LOBBY3_H)
        : space === "tent" ? rectBounds(tentNow().width, tentNow().height) : worldBounds();
    };
    // モブ占有を差し引いた今フレームの固体集合（モブの真上に立つ間の救済用）
    let mobFrameBlocked: ReadonlySet<string> | undefined;
    const activeBlocked = (): ReadonlySet<string> | undefined => {
      if (mobFrameBlocked) return mobFrameBlocked;
      if (space === "world") return blockedRef.current;
      const dungeonF = dungeonNow();
      if (dungeonF) {
        const opened = dungeonStateRef.current.doors;
        const instD = parseInstanceSpace(space);
        if (instD && dungeonF.doors.some((d) => opened[`${instD.layer}:${d.idx}`])) {
          const set = new Set(indoorData().blocked);
          for (const d of dungeonF.doors) if (opened[`${instD.layer}:${d.idx}`]) set.delete(`${d.x},${d.y}`);
          return set;
        }
      }
      const ruins = ruinsNow();
      if (ruins) {
        // 開けた金の鍵の扉は通れる（個人状態が正、ここは表示・移動用）
        const opened = ruinsStateRef.current.doors;
        if (ruins.doors.some((d) => opened[String(d.idx)])) {
          const set = new Set(indoorData().blocked);
          for (const d of ruins.doors) if (opened[String(d.idx)]) set.delete(`${d.x},${d.y}`);
          return set;
        }
      }
      return indoorData().blocked;
    };
    const keys = new Set<string>();
    // 固定式スティック: 基点は左下の固定位置（lib/worldbox/stick）。
    // 基点を持ち歩くのは「スティックが起動したか」と倒し量だけ。
    const joy = { active: false, pointerId: -1, dx: 0, dy: 0 };
    const others = new Map<string, OtherRender>();
    /** モブの見た目状態（現在位置・被弾フラッシュ・ノックバック・歩行位相）。
     * 配置と HP/死亡は決定的配置＋サーバー状態が正で、ここは動きの表現だけを持つ。 */
    type MobRender = {
      ax: number; ay: number; wx: number; wy: number;
      tx: number; ty: number; nextThink: number; phase: number; face: 1 | -1;
      flashAt: number; kx: number; ky: number; seenAt: number; fleeUntil: number;
      behavior: MobBehaviorState; provokedUntil: number; lastSpeed: number;
    };
    const mobRenders = new Map<string, MobRender>();
    /** ピアノの打鍵位置（タイルごとの音階ステップ）。 */
    const pianoSteps = new Map<string, number>();
    /** 設置した噴水の水しぶきを最後に出した時刻（スロットル用）。 */
    let lastFountainFxAt = 0;
    /** HP バーを出す個体（自分が攻撃しようとした敵だけ。当てても外しても出す）。 */
    const revealedMobs = new Set<string>();
    /** パターンの予兆マーカー（地面描画）と投射物・糸跡（見た目のみ、ダメージ経路は持たない）。 */
    type MobTelegraph = { pattern: MobPatternId; x: number; y: number; tx: number; ty: number; dirX: number; dirY: number; from: number; until: number; size: number };
    const mobTelegraphs: MobTelegraph[] = [];
    type MobProjectile = { pattern: MobPatternId; x: number; y: number; tx: number; ty: number; from: number; until: number; color: string };
    const mobProjectiles: MobProjectile[] = [];
    const mobWebs: { x: number; y: number; until: number }[] = [];
    let mobCacheKey = "";
    let mobCache: PlacedMob[] = [];
    let lastAttackAt = 0;
    /** 接触中のモブ（個体キー）と、敵対ノックバックを最後に発火した時刻。 */
    let contactMobKeyNow: string | null = null;
    let contactFiredAt = 0;
    /** 環境ハザードの最終送信時刻（サーバーの被弾クールダウンに合わせて間引く）。 */
    let hazardFiredAt = 0;
    /** BGM 緊張レイヤーの最終判定時刻（500ms ごとに更新）。 */
    let dangerCheckedAt = 0;
    /** ノックバックの残り速度（タイル/秒）。接触で初速を与え、stepMove で滑らかに減衰させる（瞬間移動にしない）。 */
    let kbVel = { x: 0, y: 0 };
    /** 氷の上の滑り速度（タイル/秒）。氷上では入力へ即追従せず、加速と弱い摩擦で滑る。 */
    let slideVel = { x: 0, y: 0 };
    // スタミナとダッシュ（キーの2度押し / スティックの強い倒し）
    let stamina: StaminaState = createStamina();
    let tapTracker: TapTracker = createTapTracker();
    let dashKey: string | null = null;
    /** 最後に立っていた陸の位置（水中で力尽きた際の帰還先）。 */
    let lastLand = { x: spawn.x, y: spawn.y };
    let wasSwimming = false;
    /** 今フレームの泳ぎ状態（描画の沈み・波紋用）。 */
    let playerSwimming = false;
    /** 入水/出水時の波紋（中心・発生時刻ミリ秒）。 */
    const splashes: { x: number; y: number; at: number }[] = [];
    // ---- 演出（パーティクル/揺れ/ポップ/スイング）。計算は lib/worldbox/fx.ts ----
    const reducedMotion =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fxSys: FxSystem = createFxSystem((Date.now() % 2147483646) + 1);
    if (reducedMotion) fxSys.intensity = 0.35;
    let shake: FxShake = createShake();
    /** ヒットストップ（命中の一瞬だけ世界の時を止める）。計算は fx.ts。 */
    let hitstop: HitstopState = createHitstop();
    /** 死亡バーストを出したモブのアンカー→時刻（自分の攻撃分との二重出し防止）。 */
    const deathFxAt = new Map<string, number>();
    /** 道具スイング（タップ即時応答）。itemId のアイコンを振る。whiff は空振り（風切りのみ）。 */
    let swing = { startedAt: 0, itemId: null as string | null, face: 1 as 1 | -1, whiff: false };
    /** 出現ポップ中タイル "x,y" → 開始時刻。 */
    const pops = new Map<string, number>();
    let lastBeat = 0;
    let lastDashFxAt = 0;
    let lastSwimFxAt = 0;
    let lastAmbientAt = 0;
    /** 直前フレームの時間帯（切り替わった瞬間に環境粒を足す）。 */
    let lastPhaseKind = "";
    const popScaleFor = (key: string, nowMs: number): number => {
      const started = pops.get(key);
      if (started === undefined) return 1;
      const pr = popProgress(started, nowMs);
      if (pr >= 1) {
        pops.delete(key);
        return 1;
      }
      return popScale(pr);
    };
    let loggedIn = false;
    let disposed = false;
    // タブ世代（同一アカウントの分身防止）: このタブの識別子と開始時刻。
    // サーバーは最新のタブだけを有効とし、旧タブのプレゼンス・セーブは受理しない。
    const tabSession = {
      tab: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `tab-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`,
      tabAt: Date.now(),
    };
    let tabSuperseded = false;
    const markTabSuperseded = () => {
      if (tabSuperseded) return;
      tabSuperseded = true;
      setTabTaken(true);
    };
    let lastSaved = { x: player.x, y: player.y, at: 0 };
    let lastMinimapAt = 0;
    let lastBigMapAt = 0;
    // 開拓のコンパス: 最寄り入口の再計算はスロットルつき
    // （計算した地点から 16 タイル以上動いたら探し直す）。
    let compassCache: { ax: number; ay: number; cave: CompassTarget | null; dungeon: CompassTarget | null } | null = null;

    // ---- 保存（空間＋位置＋ワールド帰還点） ----
    const currentSave = () => serializeSave({ space, x: player.x, y: player.y, worldReturn });
    const saveLocal = () => {
      try {
        localStorage.setItem(SAVE_KEY, currentSave());
      } catch { /* noop */ }
    };
    // オンライン保存は最大で3秒に1回へ間引く（1タイル動くごとの全量PUTが
    // 移動中のラグの主因だった）。間引き中の最新状態はタイマーで追いつく。
    // keepalive（退室・ページ離脱）だけは即時送信する。
    let lastOnlineSaveAt = 0;
    let onlineSaveTimer: number | null = null;
    const sendOnlineSave = (keepalive = false) => {
      lastOnlineSaveAt = performance.now();
      fetch("/api/worldbox/save", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ save: currentSave() }),
        keepalive,
      }).catch(() => { /* 保存できなくても遊び続けられる */ });
    };
    const saveOnline = (keepalive = false) => {
      if (!loggedIn) return;
      // 別のタブに引き継がれた旧タブは、セーブで現行タブの状態を上書きしない。
      if (tabSuperseded) return;
      if (keepalive) {
        if (onlineSaveTimer !== null) {
          window.clearTimeout(onlineSaveTimer);
          onlineSaveTimer = null;
        }
        sendOnlineSave(true);
        return;
      }
      const wait = 3000 - (performance.now() - lastOnlineSaveAt);
      if (wait <= 0) {
        sendOnlineSave();
      } else if (onlineSaveTimer === null) {
        onlineSaveTimer = window.setTimeout(() => {
          onlineSaveTimer = null;
          if (loggedIn) sendOnlineSave();
        }, wait);
      }
    };
    const saveNow = (keepalive = false) => {
      saveLocal();
      saveOnline(keepalive);
      lastSaved = { x: player.x, y: player.y, at: performance.now() };
    };

    // ---- 初期位置の読み込み（オンライン優先、無ければローカル、どちらも無ければ中央） ----
    (async () => {
      let local: ReturnType<typeof parseSave> = null;
      try {
        local = parseSave(localStorage.getItem(SAVE_KEY));
      } catch { /* noop */ }
      let online: ReturnType<typeof parseSave> = null;
      try {
        const res = await fetch("/api/worldbox/save", { headers: { Accept: "application/json" } });
        if (res.ok) {
          loggedIn = true;
          const body = (await res.json()) as { save?: string | null };
          online = parseSave(body.save ?? null);
        }
      } catch { /* オフラインではローカルのみ */ }
      if (disposed) return;
      const choice = chooseInitialSave(online, local, loggedIn);
      if (choice.state) {
        space = choice.state.space;
        worldReturn = choice.state.worldReturn;
        const free = findFreeNear(activeMap(), choice.state.x, choice.state.y, activeBlocked(), { swim: space === "world" });
        player.x = free.x;
        player.y = free.y;
        cam.x = free.x;
        cam.y = free.y;
        setSpaceUi(space);
        // 初期位置が決まった時点で、その周辺の設置ブロックを取り直す
        // （マウント時の取得は初期位置 (0.5, 0.5) 中心で、実際の居場所とずれる）
        void refreshTilesRef.current();
      }
      if (choice.pushLocalToOnline) saveNow();
      else lastSaved = { x: player.x, y: player.y, at: performance.now() };
      setStatusText(space === "lobby" ? "ロビー" : space === "lobby2" ? "ロビー 2F" : space === "lobby3" ? "ロビー 3F" : space === "tent" ? "テント" : "共有ワールド");
    })();

    // ---- プレゼンス（空間ごとに分ける。他空間の者は受け取らない） ----
    // エントリの ts はサーバー時刻。受信側の時計ずれを GET の now で補正してから
    // 外挿に使う（ずれがそのまま描画位置のズレになるため）。
    let clockOffsetMs = 0;
    const presenceNow = () => Date.now() + clockOffsetMs;
    /** ポーリングで連続して見えなかった回数（1回の欠落では消さない）。 */
    const missedPolls = new Map<string, number>();
    /** WS 経由で最後に見た時刻（REST の間引きで見えなくても欠落に数えないため）。 */
    const wsSeenAt = new Map<string, number>();
    /** ダンジョンでは別パーティの者は見せない（ポーリングと WS で同じ規則）。 */
    const isOtherPartyInDungeon = (entry: PresenceEntry) =>
      parseInstanceSpace(space)?.kind === "dungeon" &&
      !!entry.party && !!myPartyKeyRef.current && entry.party !== myPartyKeyRef.current;
    /** 受信したエントリを他プレイヤーのトラックへ反映する（ポーリングと WS で共用）。 */
    const applyPresenceEntry = (entry: PresenceEntry, now: number) => {
      const cur = others.get(entry.id);
      if (!cur) {
        others.set(entry.id, { track: createRemoteTrack(entry, now, activeBounds()), phase: 0 });
      } else {
        cur.track = updateRemoteTrack(cur.track, entry, now, activeBounds());
      }
    };
    /** サーバー時刻とのずれサンプルを取り込む（急な振れを抑えるため平滑化する）。 */
    const absorbClockSample = (serverNow: number, before: number, after: number) => {
      const sample = clockOffsetEstimate(serverNow, before, after);
      clockOffsetMs = clockOffsetMs === 0 ? sample : clockOffsetMs + (sample - clockOffsetMs) * 0.3;
    };
    // ---- リアルタイム中継（WebSocket）。繋がらない間は REST ポーリングが正 ----
    let rtSocket: WebSocket | null = null;
    let rtToken: string | null = null;
    let rtTokenAt = 0;
    let rtRetryAt = 0;
    let rtBackoffMs = 1000;
    let rtReconnectTimer: number | undefined;
    /** WS で最後にメッセージを受けた時刻（生存判定とポーリング間引き用）。 */
    let lastWsMsgAt = 0;
    /** プレゼンス集約が有効か（relay の hello/agg 合図で切り替わる）。 */
    let rtAggOn = false;
    /** プレゼンス REST ポーリングの最終実行時刻（間引き判定用）。 */
    let lastPresencePollAt = 0;
    // 初回接続と再接続の区別（再接続だけ薄い復帰パルスを出す）。
    let rtEverConnected = false;
    /** WS 経由のハートビート送信（中継は REST と同じ整形規則で受ける）。 */
    const sendWsHeartbeat = () => {
      if (tabSuperseded) return;
      if (!rtSocket || rtSocket.readyState !== WebSocket.OPEN) return;
      try {
        rtSocket.send(JSON.stringify({ t: "hb", x: player.x, y: player.y, vx: player.vx, vy: player.vy, face: player.face, space, party: myPartyKeyRef.current || undefined, role: invRef.current?.role ?? "free", rank: invRef.current ? masteryRankOf(invRef.current, invRef.current.role) : 1, sit: sitTileRef.current ? true : undefined }));
      } catch { /* noop */ }
    };
    /** 中継への接続（トークン取得→接続→受信→再接続）。失敗してもポーリングが続く。 */
    const connectRealtime = async () => {
      if (disposed || !loggedIn || rtSocket || tabSuperseded) return;
      try {
        if (!rtToken || Date.now() - rtTokenAt > 8 * 60 * 1000) {
          const res = await fetch("/api/worldbox/realtime-token", { method: "POST", headers: { Accept: "application/json" } });
          if (!res.ok) throw new Error("token");
          const body = (await res.json()) as { token?: string };
          if (!body.token) throw new Error("token");
          rtToken = body.token;
          rtTokenAt = Date.now();
        }
        if (disposed) return;
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${proto}//${location.host}/api/worldbox/realtime?t=${encodeURIComponent(rtToken)}&tab=${encodeURIComponent(tabSession.tab)}&tabAt=${tabSession.tabAt}`);
        rtSocket = ws;
        ws.onopen = () => {
          rtBackoffMs = 1000;
          lastWsMsgAt = Date.now();
          rtOpenRef.current = true;
          rtLastMsgRef.current = lastWsMsgAt;
          const reconnected = rtEverConnected;
          // 再接続の復帰演出: 薄いパルスだけ（暗転しない・入力は止めない）。
          // ワープ遷移中はそちらを優先して上書きしない。
          if (rtEverConnected && transitionStart < 0) {
            transitionKind = "reconnect";
            transitionSwapped = true;
            transitionPending = null;
            transitionStart = performance.now();
          }
          rtEverConnected = true;
          sendWsHeartbeat();
          if (reconnected) {
            // 再接続時は push の取りこぼしを REST スナップショットで
            // 再同期する（取りこぼしが新しい同期バグになるため）。
            void pollOthers();
            void refreshTilesRef.current();
            void refreshMobsRef.current();
            void refreshPartyRef.current(true);
            void nationsRefreshRef.current(true);
            void boardRefreshRef.current();
            chatReloadRef.current?.();
          }
        };
        ws.onmessage = (ev) => {
          const arrivedAt = Date.now();
          lastWsMsgAt = arrivedAt;
          rtLastMsgRef.current = arrivedAt;
          let msg: {
            t?: string; now?: number; p?: PresenceEntry; players?: PresenceEntry[]; id?: string;
            x?: number; y?: number;
            kind?: string; changes?: { key: string; value: unknown }[]; value?: unknown;
            channel?: string; space?: string; guildId?: string;
            agg?: number; on?: boolean;
          };
          try {
            msg = JSON.parse(String(ev.data));
          } catch {
            return;
          }
          if (typeof msg.now === "number") absorbClockSample(msg.now, arrivedAt, arrivedAt);
          const now = presenceNow();
          if (msg.t === "hello" && msg.agg === 1) {
            // プレゼンス集約が有効: 以後の REST ハートビートは止める
            rtAggOn = true;
          } else if (msg.t === "agg") {
            rtAggOn = msg.on === true;
          } else if (msg.t === "jump" && typeof msg.x === "number" && typeof msg.y === "number" && typeof msg.space === "string") {
            // 中継に却下された位置申告: サーバー保管の正規位置へ戻す
            snapBackToServer(msg.x, msg.y, msg.space);
          } else if (msg.t === "snap") {
            for (const entry of msg.players ?? []) {
              if (isOtherPartyInDungeon(entry)) continue;
              missedPolls.delete(entry.id);
              wsSeenAt.set(entry.id, Date.now());
              applyPresenceEntry(entry, now);
            }
            setOthersCount(others.size);
          } else if (msg.t === "up" && msg.p) {
            if (isOtherPartyInDungeon(msg.p)) return;
            missedPolls.delete(msg.p.id);
            wsSeenAt.set(msg.p.id, Date.now());
            applyPresenceEntry(msg.p, now);
            setOthersCount(others.size);
          } else if (msg.t === "bye" && msg.id) {
            others.delete(msg.id);
            missedPolls.delete(msg.id);
            setOthersCount(others.size);
          } else if (msg.t === "kv" && msg.kind === "tiles" && Array.isArray(msg.changes)) {
            // タイル差分（サーバー側 watch が正。ローカル行為と同じ適用経路）
            const nextTiles: TileOverridesMap = { ...tilesRef.current };
            for (const c of msg.changes) {
              if (!c || typeof c.key !== "string") continue;
              const parsed = c.value == null ? null : parseTileOverride(c.value);
              if (parsed) nextTiles[c.key] = parsed;
              else delete nextTiles[c.key];
            }
            tilesRef.current = nextTiles;
            tilesVersionRef.current += 1;
            syncBlockBlocked();
          } else if (msg.t === "kv" && msg.kind === "mobs" && Array.isArray(msg.changes)) {
            // モブ状態の差分（世代を進め、進行中の REST 取得は古い応答を捨てる）
            const nextMobs: Record<string, MobState> = { ...mobStatesRef.current };
            for (const c of msg.changes) {
              if (!c || typeof c.key !== "string") continue;
              const parsed = c.value == null ? null : parseMobState(c.value);
              if (parsed) nextMobs[c.key] = parsed;
              else delete nextMobs[c.key];
            }
            mobStatesRef.current = nextMobs;
            mobsVersionRef.current += 1;
          } else if (msg.t === "kv" && msg.kind === "objects" && Array.isArray(msg.changes)) {
            // 地表オブジェクトの枯渇差分（他人の採取を自分の画面へ即反映）
            for (const c of msg.changes) {
              if (!c || typeof c.key !== "string") continue;
              const n = c.value == null ? NaN : Number(c.value);
              if (Number.isFinite(n) && n > 0) surfaceObjStateRef.current.set(c.key, n);
              else surfaceObjStateRef.current.delete(c.key);
            }
          } else if (msg.t === "kv" && msg.kind === "fishing" && Array.isArray(msg.changes)) {
            // 他人の釣果差分（釣られた魚影を自分の画面からも消す）
            for (const c of msg.changes) {
              if (!c || typeof c.key !== "string") continue;
              const n = c.value == null ? NaN : Number(c.value);
              if (Number.isFinite(n) && n > 0) fishCaughtRef.current.set(c.key, n);
              else fishCaughtRef.current.delete(c.key);
            }
          } else if (msg.t === "kv" && msg.kind === "board") {
            // 掲示板は単一キーなので全文を差し替える（進行中の REST 取得を無効化）
            const ticket = boardGuardRef.current.begin({ force: true });
            if (ticket !== null) {
              setBoardPosts(parseBoardPosts(msg.value ?? null));
              setBoardLoggedIn(true);
              boardGuardRef.current.end(ticket);
            }
          } else if (msg.t === "sync" && msg.kind === "nations") {
            void nationsRefreshRef.current(true);
          } else if (msg.t === "sync" && msg.kind === "party") {
            void refreshPartyRef.current(true);
          } else if (msg.t === "sync" && msg.kind === "instances") {
            // インスタンス状態（洞窟の枯渇・遺跡の個人状態・ダンジョンの
            // ボス進行など）が他人の行為で変わった: 今いる空間の状態を
            // 取り直す（従来は再ワープするまで古い表示のままだった）
            const instNow = parseInstanceSpace(space);
            if (instNow?.kind === "cave") void refreshCaveStateRef.current(space);
            else if (instNow?.kind === "dungeon") void refreshDungeonStateRef.current(space);
            else if (instNow?.kind === "ruins") void refreshRuinsStateRef.current(space);
          } else if (msg.t === "sync" && msg.kind === "economy") {
            // 自分の経済オプが確定した: 残高を取り直し、開いている
            // 経済/カジノ/アリーナパネルへも合図する（金額は push に無い）
            void invRefreshRef.current();
            notifyEconomyApplied();
          } else if (msg.t === "sync" && msg.kind === "requests") {
            // ギルド依頼が他人の操作で変わった: 開いているギルドボード
            // パネルへ合図する（パネル側が REST で取り直す）
            notifyGuildRequestsChanged();
          } else if (msg.t === "sync" && msg.kind === "guildShop") {
            // ギルドショップの区画・出品が変わった: 地図のギルド名表示を
            // 取り直し、開いているパネルへも合図する
            void guildShopRefreshRef.current(true);
            notifyGuildShopChanged();
          } else if (msg.t === "sync" && msg.kind === "chat") {
            // ギルドボードの掲示タブ: HUD の表示チャンネルに関係なく、
            // 自ギルドのユニオン発言が変わったらパネルへ合図する
            if (msg.channel === "union") {
              const myGuild = nationsRef.current.me?.nationId ?? null;
              if (!msg.guildId || !myGuild || msg.guildId === myGuild) notifyGuildBoardChanged();
            }
            // 自分が見ているチャンネル・空間の変更だけ取り直す
            if (msg.channel === chatChannelRef.current) {
              if (msg.channel === "union") {
                const myGuild = nationsRef.current.me?.nationId ?? null;
                if (!msg.guildId || !myGuild || msg.guildId === myGuild) chatReloadRef.current?.();
              } else if (msg.space === space) {
                chatReloadRef.current?.();
              }
            }
          }
        };
        const onGone = () => {
          if (rtSocket === ws) rtSocket = null;
          rtOpenRef.current = false;
          // 切断時は即座に REST ハートビートへ復帰する（過去の凍結実害の再演防止）
          rtAggOn = false;
          if (disposed) return;
          rtRetryAt = Date.now() + rtBackoffMs;
          rtBackoffMs = Math.min(10_000, rtBackoffMs * 2);
          rtReconnectTimer = window.setTimeout(() => void connectRealtime(), rtBackoffMs);
        };
        ws.onclose = (ev) => {
          // 4001 = 別のタブに引き継がれた。再接続せず、このタブは無効化する。
          if (ev.code === 4001) {
            if (rtSocket === ws) rtSocket = null;
            markTabSuperseded();
            return;
          }
          onGone();
        };
        ws.onerror = onGone;
      } catch {
        rtRetryAt = Date.now() + rtBackoffMs;
        rtBackoffMs = Math.min(10_000, rtBackoffMs * 2);
      }
    };
    const sendHeartbeat = () => {
      if (!loggedIn || tabSuperseded) return;
      fetch("/api/worldbox/presence", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
        name: "", x: player.x, y: player.y, vx: player.vx, vy: player.vy, face: player.face, space,
        party: myPartyKeyRef.current || undefined,
        role: invRef.current?.role ?? "free",
        rank: invRef.current ? masteryRankOf(invRef.current, invRef.current.role) : 1,
        sit: sitTileRef.current ? true : undefined,
        tab: tabSession.tab,
        tabAt: tabSession.tabAt,
      }),
      }).then(async (res) => {
        if (res.status !== 409) return;
        try {
          const body = (await res.json()) as { error?: string; x?: number; y?: number; space?: string };
          // 409 tab_superseded = 別のタブがこのアカウントで開かれている（このタブは旧世代）
          if (body.error === "tab_superseded") {
            markTabSuperseded();
            return;
          }
          // 却下（409 position_jump）: サーバー保管の正規位置へ戻す。
          // 応答の保管位置が現在の空間と違う場合は古い却下として無視する。
          if (body.error === "position_jump" && typeof body.x === "number" && typeof body.y === "number" && typeof body.space === "string") {
            snapBackToServer(body.x, body.y, body.space);
          }
        } catch { /* noop */ }
      }).catch(() => { /* noop */ });
    };
    /** サーバーに却下された位置申告の復帰: 保管位置へ直接戻す。
     * findFreeNear を通さない（着地のずれで再却下の連鎖になるため）。
     * 次回ハートビートは保管位置と一致し、受け入れられる。 */
    const snapBackToServer = (x: number, y: number, targetSpace: string) => {
      if (targetSpace !== space) return;
      player.x = x;
      player.y = y;
      player.vx = 0;
      player.vy = 0;
      cam.x = x;
      cam.y = y;
      lastTileKey = `${space}:${Math.floor(x)},${Math.floor(y)}`;
      lastHeartbeatPos = { x, y };
      saveNow();
      sendHeartbeat();
    };
    let nearDungeonShown = false;
    // プレゼンスポーリングのガード（S6）: 1s 間隔で重ねて走らせず、古い
    // レスポンスで他者のゴースト復活・欠落の二重カウントを起こさない。
    const presenceGuard = createPollGuard();
    /** ダンジョン入口の近接判定（ローカル計算のみ。1秒 tick で常時回す）。 */
    const checkNearDungeonEntrance = () => {
      // ダンジョン入口の近接（パーティパネル表示用）
      if (space === "world") {
        const ptx = Math.floor(player.x);
        const pty = Math.floor(player.y);
        let near = false;
        const ccx = Math.floor(ptx / CHUNK_SIZE);
        const ccy = Math.floor(pty / CHUNK_SIZE);
        for (let dy = -1; dy <= 1 && !near; dy++) {
          for (let dx = -1; dx <= 1 && !near; dx++) {
            for (const st of structuresForChunk(MAP_SEED, ccx + dx, ccy + dy)) {
              if (st.structureId === "dungeon_entrance" && Math.hypot(st.x - ptx, st.y - pty) <= 6) { near = true; break; }
            }
          }
        }
        if (near !== nearDungeonShown) {
          nearDungeonShown = near;
          setNearDungeonEntrance(near);
        }
      } else if (nearDungeonShown) {
        nearDungeonShown = false;
        setNearDungeonEntrance(false);
      }
    };
    const pollOthers = async () => {
      const ticket = presenceGuard.begin();
      if (ticket === null) return;
      lastPresencePollAt = Date.now();
      const before = Date.now();
      try {
        const res = await fetch(`/api/worldbox/presence?space=${space}`, { headers: { Accept: "application/json" } });
        if (!res.ok) return;
        const body = (await res.json()) as { players?: PresenceEntry[]; now?: number };
        if (disposed) return;
        if (!presenceGuard.isCurrent(ticket)) return;
        if (typeof body.now === "number") absorbClockSample(body.now, before, Date.now());
        const now = presenceNow();
        const seen = new Set<string>();
        for (const entry of body.players ?? []) {
          if (isOtherPartyInDungeon(entry)) continue;
          seen.add(entry.id);
          missedPolls.delete(entry.id);
          applyPresenceEntry(entry, now);
        }
        for (const id of [...others.keys()]) {
          if (seen.has(id)) continue;
          // WS 経由で最近見えている者は、REST の間引き（ワールド48タイル外）で
          // 見えなくても欠落に数えない。数えると遠くの他者が消えては戻るチラつきになる。
          if (Date.now() - (wsSeenAt.get(id) ?? 0) < 2500) continue;
          const missed = (missedPolls.get(id) ?? 0) + 1;
          if (missed >= 2) {
            others.delete(id);
            missedPolls.delete(id);
          } else {
            missedPolls.set(id, missed);
          }
        }
        setOthersCount(others.size);
      } catch { /* noop */ }
      finally {
        presenceGuard.end(ticket);
      }
    };
    const leavePresence = () => {
      if (!loggedIn) return;
      fetch("/api/worldbox/presence", { method: "DELETE", keepalive: true }).catch(() => { /* noop */ });
    };
    // ハートビートは適応間隔: 移動中は 500ms、静止中は 2s。
    // ワープやノックバック等の大きなジャンプは間隔を待たず即送る。
    let lastHeartbeatAt = 0;
    let lastRestHeartbeatAt = 0;
    let lastHeartbeatPos = { x: player.x, y: player.y };
    const heartbeatTick = () => {
      if (!loggedIn) return;
      // 中継が未接続なら再接続を試みる（再試行時刻を過ぎたときだけ）
      if (!rtSocket && Date.now() >= rtRetryAt) void connectRealtime();
      const now = performance.now();
      const movedDist = Math.hypot(player.x - lastHeartbeatPos.x, player.y - lastHeartbeatPos.y);
      const moving = Math.hypot(player.vx, player.vy) > 0.1 || movedDist > 0.05;
      const wsOpen = rtSocket?.readyState === WebSocket.OPEN;
      // bot_kv プレゼンスはサーバー検証（カジノ・ステーション・ギルドボード・
      // モブ距離）の正。Phase 2 以降は集約合図（hello/agg）がある間だけ
      // relay が WS 受信の位置を bot_kv へ書き、REST ハートビートを止める。
      // 合図が無い・切断した場合は従来どおり REST を併送して鮮度を保つ
      // （WS 接続中でも集約なしに止めると全ゲートが死ぬ: 過去の実害）。
      if (!rtAggOn && (movedDist > 4 || now - lastRestHeartbeatAt >= (moving ? 500 : 2000))) {
        lastRestHeartbeatAt = now;
        lastHeartbeatPos = { x: player.x, y: player.y };
        sendHeartbeat();
      }
      if (!wsOpen) return;
      if (movedDist <= 4 && now - lastHeartbeatAt < (moving ? 100 : 1000)) return;
      lastHeartbeatAt = now;
      lastHeartbeatPos = { x: player.x, y: player.y };
      sendWsHeartbeat();
    };
    const heartbeatTimer = window.setInterval(heartbeatTick, 250);
    // プレゼンスポーリングの間引き（Phase 0）: WS 中継が健全な間は他者の
    // 出現/移動/退室が push で届くため、REST 取得は 15 秒のセーフティに
    // 落とす（WS だけでは拾えない = 中継に繋がっていない相手の回収用）。
    // 切断・無応答なら従来の 1 秒に即戻る。入口近接の判定はローカル計算
    // だけなので 1 秒 tick で常時回す。欠落カウントは取得ごとの回数の
    // まま（セーフティ中は掃除が最大 2×15 秒まで遅れるが、その間も
    // WS の bye/prune と鮮度切れが退室を担う）。
    const pollTick = () => {
      checkNearDungeonEntrance();
      const nowMs = Date.now();
      const healthy = isWsHealthy(rtSocket?.readyState === WebSocket.OPEN, lastWsMsgAt, nowMs);
      if (presencePollDue({ now: nowMs, lastPollAt: lastPresencePollAt, wsHealthy: healthy })) {
        void pollOthers();
      }
    };
    const pollTimer = window.setInterval(pollTick, 1000);
    pollOthers();

    // ---- 入力 ----
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return; // 掲示板の入力中は歩かない
      if (arcadeOpenRef.current) return; // 筐体で遊んでいる間は歩かない（ゲーム側のキー入力を優先）
      const k = e.key.toLowerCase();
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) e.preventDefault();
      keys.add(k);
      // 同じ移動キーの2度押しでダッシュ（長押しのオートリピートは数えない）
      if (!e.repeat && MOVE_KEYS.has(k)) {
        const r = registerKeyTap(tapTracker, k, performance.now());
        tapTracker = r.tracker;
        if (r.doubleTapped) dashKey = k;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      keys.delete(k);
      if (k === dashKey) dashKey = null;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    const canvasPos = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top, w: rect.width, h: rect.height };
    };
    const toTile = (e: PointerEvent) => {
      const p = canvasPos(e);
      return {
        x: Math.floor(cam.x + (p.x - p.w / 2) / TILE),
        y: Math.floor(cam.y + (p.y - p.h / 2) / TILE),
      };
    };
    /** 道具タップ: 選択中の道具/種と隣接タイルの状態で行為が決まる。 */
    /** モブのタップ = 攻撃。タイル行為より優先する（モブがいるマスは殴る）。 */
    const handleMobTap = (t: { x: number; y: number }): boolean => {
      if (!invRef.current) return false;
      const nowMs = Date.now();
      const px = Math.floor(player.x);
      const py = Math.floor(player.y);
      const selSlotItem = invRef.current.hotbar[selSlotRef.current] ?? null;
      const selDef = selSlotItem ? itemById(selSlotItem.id) : null;
      // 剣は照準方式でなく範囲方式: 振ること自体は常に応答し、範囲内のモブに当たる。
      // 狙いはタップ方向へ向け、対象は attackTarget が「タップを含む個体→近い個体」で選ぶ。
      if (selDef?.tool === "sword") {
        if (t.x !== px || t.y !== py) player.face = t.x + 0.5 >= player.x ? 1 : -1;
        swing = { startedAt: performance.now(), itemId: selDef.id, face: player.face, whiff: false };
        playWbSe("swing");
        const candidates: { mobId: string; x: number; y: number; size: number; placed: PlacedMob }[] = [];
        for (const placed of mobCache) {
          const def = mobById(placed.mobId);
          if (!def) continue;
          const key = mobKeyFor(placed);
          if (!mobHpNow(defFor(def), mobStatesRef.current[key] ?? null, nowMs).alive) continue;
          const r = mobRenders.get(key);
          candidates.push({
            mobId: placed.mobId,
            x: r ? Math.floor(r.wx) : placed.x,
            y: r ? Math.floor(r.wy) : placed.y,
            size: placed.size,
            placed,
          });
        }
        const target = attackTarget(px, py, t.x, t.y, candidates);
        if (target) {
          // 攻撃しようとした敵は、外しても HP バーを出す
          revealedMobs.add(mobKeyFor(target.placed));
          if (nowMs - lastAttackAt >= 350) {
            lastAttackAt = nowMs;
            void attackMobRef.current(target.placed, { x: target.x, y: target.y });
          }
          return true;
        }
        return false; // 空振り（スイングは出した。タイル行為は通常どおり続く）
      }
      for (const placed of mobCache) {
        const def = mobById(placed.mobId);
        if (!def) continue;
        const key = mobKeyFor(placed);
        if (!mobHpNow(defFor(def), mobStatesRef.current[key] ?? null, nowMs).alive) continue;
        const r = mobRenders.get(key);
        const cx = r ? Math.floor(r.wx) : placed.x;
        const cy = r ? Math.floor(r.wy) : placed.y;
        if (!mobOccupiesTile(placed.size, cx, cy, t.x, t.y)) continue;
        if (mobDistance(px, py, { x: cx, y: cy, size: placed.size }) > MOB_ATTACK_RANGE) {
          // 届かなくても「攻撃しようとした」ので HP バーは出す
          revealedMobs.add(key);
          setTileMsg(TILE_ERROR_LABEL.too_far);
          denyAtTile(t.x, t.y);
          return true;
        }
        // 向きをモブへ向けて即時に振る（HP と粒はサーバー応答で返す）
        revealedMobs.add(key);
        player.face = cx + 0.5 >= player.x ? 1 : -1;
        const slot = invRef.current.hotbar[selSlotRef.current] ?? null;
        swing = { startedAt: performance.now(), itemId: slot?.id ?? null, face: player.face, whiff: false };
        playWbSe("swing");
        if (nowMs - lastAttackAt >= 350) {
          lastAttackAt = nowMs;
          void attackMobRef.current(placed, { x: cx, y: cy });
        }
        return true;
      }
      return false;
    };
    /** ダンジョン内タップ: 宝箱と鍵扉が対象（検証と付与はサーバー）。 */
    const handleDungeonTap = (t: { x: number; y: number }): boolean => {
      const dfloor = dungeonNow();
      if (!dfloor) return false;
      const inst = parseInstanceSpace(space);
      if (!inst) return false;
      const px = Math.floor(player.x);
      const py = Math.floor(player.y);
      const chest = dfloor.chests.find((c) => c.x === t.x && c.y === t.y);
      if (chest) {
        if (dungeonStateRef.current.opened[`${inst.layer}:${chest.idx}`]) {
          setTileMsg(TILE_ERROR_LABEL.depleted);
          denyAtTile(t.x, t.y);
          return true;
        }
        if (Math.hypot(px - t.x, py - t.y) > 2) {
          setTileMsg(TILE_ERROR_LABEL.too_far);
          denyAtTile(t.x, t.y);
          return true;
        }
        void postInstanceRef.current("open_chest", { chestIdx: chest.idx, fxX: chest.x, fxY: chest.y });
        return true;
      }
      const door = dfloor.doors.find((d) => d.x === t.x && d.y === t.y);
      if (door) {
        if (dungeonStateRef.current.doors[`${inst.layer}:${door.idx}`]) return false;
        if (Math.hypot(px - t.x, py - t.y) > 2) {
          setTileMsg(TILE_ERROR_LABEL.too_far);
          denyAtTile(t.x, t.y);
          return true;
        }
        void postInstanceRef.current("open_door", { doorIdx: door.idx, fxX: door.x, fxY: door.y });
        return true;
      }
      return false;
    };
    /** 遺跡内タップ: 宝箱と金の鍵の扉が対象（検証と付与はサーバー）。 */
    const handleRuinsTap = (t: { x: number; y: number }): boolean => {
      const ruins = ruinsNow();
      if (!ruins) return false;
      const px = Math.floor(player.x);
      const py = Math.floor(player.y);
      const chest = ruins.chests.find((c) => c.x === t.x && c.y === t.y);
      if (chest) {
        if (ruinsStateRef.current.chests[String(chest.idx)]) {
          setTileMsg(TILE_ERROR_LABEL.depleted);
          denyAtTile(t.x, t.y);
          return true;
        }
        if (Math.hypot(px - t.x, py - t.y) > 2) {
          setTileMsg(TILE_ERROR_LABEL.too_far);
          denyAtTile(t.x, t.y);
          return true;
        }
        void postInstanceRef.current("open_chest", { chestIdx: chest.idx, fxX: chest.x, fxY: chest.y });
        return true;
      }
      const door = ruins.doors.find((d) => d.x === t.x && d.y === t.y);
      if (door) {
        if (ruinsStateRef.current.doors[String(door.idx)]) return false;
        if (Math.hypot(px - t.x, py - t.y) > 2) {
          setTileMsg(TILE_ERROR_LABEL.too_far);
          denyAtTile(t.x, t.y);
          return true;
        }
        void postInstanceRef.current("open_door", { doorIdx: door.idx, fxX: door.x, fxY: door.y });
        return true;
      }
      return false;
    };
    /** 洞窟内タップ: 鉱脈と宝箱だけが対象（検証と付与はサーバー）。 */
    const handleCaveTap = (t: { x: number; y: number }): boolean => {
      const cave = caveLayerNow();
      if (!cave) return false;
      const px = Math.floor(player.x);
      const py = Math.floor(player.y);
      const vein = cave.veins.find((v) => v.x === t.x && v.y === t.y);
      if (vein) {
        const def = specialObjectById(vein.objectId);
        const takenAt = caveStateRef.current.veins[vein.key] ?? 0;
        if (def && takenAt > 0 && Date.now() - takenAt < def.respawnMs) {
          setTileMsg(TILE_ERROR_LABEL.depleted);
          denyAtTile(t.x, t.y);
          return true;
        }
        if (Math.hypot(px - t.x, py - t.y) > 2) {
          setTileMsg(TILE_ERROR_LABEL.too_far);
          denyAtTile(t.x, t.y);
          return true;
        }
        void postInstanceRef.current("mine", { veinKey: vein.key, fxX: vein.x, fxY: vein.y, fxObjectId: vein.objectId });
        return true;
      }
      if (cave.chest && cave.chest.x === t.x && cave.chest.y === t.y) {
        if (Math.hypot(px - t.x, py - t.y) > 2) {
          setTileMsg(TILE_ERROR_LABEL.too_far);
          denyAtTile(t.x, t.y);
          return true;
        }
        void postInstanceRef.current("open_chest", { fxX: cave.chest.x, fxY: cave.chest.y });
        return true;
      }
      return false;
    };
    /** 室内（ロビー各階・テント）のタップ: 座席に座る/立つ、テントの備え付け収納を開く。
     * ワールドのタイルタップと違い、室内オブジェクト（LobbyObject）が対象。 */
    const handleIndoorTap = (t: { x: number; y: number }): boolean => {
      const px = Math.floor(player.x);
      const py = Math.floor(player.y);
      if (Math.max(Math.abs(t.x - px), Math.abs(t.y - py)) > 1) return false;
      const obj = indoorData().objects.find(
        (o) => t.x >= o.x && t.x < o.x + o.w && t.y >= o.y && t.y < o.y + o.h,
      );
      if (!obj) return false;
      if (isSeatItem(obj.sprite)) {
        // ベンチ・椅子・ソファ: タップで座る/立つ（ワールドの設置家具と同じ）
        const sitting = sitTileRef.current;
        if (sitting && sitting.x === t.x && sitting.y === t.y) {
          sitTileRef.current = null;
        } else {
          sitTileRef.current = { x: t.x, y: t.y };
          player.x = t.x + 0.5;
          player.y = t.y + 0.5;
          playWbSe("poof");
        }
        return true;
      }
      if (isContainerItem(obj.sprite)) {
        // 備え付け樽・木箱は自分の収納として開ける（ロビーの中身はプレイヤー別）
        void openContainerRef.current(
          t.x, t.y, obj.sprite,
          space as "tent" | "lobby" | "lobby2" | "lobby3",
        );
        return true;
      }
      return false;
    };
    const handleTileTap = (t: { x: number; y: number }): boolean => {
      const prof = invRef.current;
      if (!prof) return false;
      const slot = prof.hotbar[selSlotRef.current] ?? null;
      const selItem = slot ? itemById(slot.id) : null;
      const wantsPlace = !!selItem && (selItem.category === "block" || selItem.facility === true || !!selItem.placesBlock);
      const px = Math.floor(player.x);
      const py = Math.floor(player.y);
      if (Math.max(Math.abs(t.x - px), Math.abs(t.y - py)) > 1) {
        // ブロック選択中の遠いタップは設置のつもりなので、無反応で終わらせない
        if (wantsPlace) {
          setTileMsg(TILE_ERROR_LABEL.too_far);
          denyAtTile(t.x, t.y);
        }
        return false;
      }
      // 魚影タップ: 釣り（キャスト → 食いつきの窓でもう一度タップで引き上げ）
      if (space === "world" && fishingSpotAt(MAP_SEED, t.x, t.y)) {
        const active = fishingRef.current;
        const nowMs = Date.now();
        if (active && active.x === t.x && active.y === t.y) {
          fishingRef.current = null;
          if (nowMs >= active.biteAt && nowMs <= active.biteAt + 1100) {
            void postCatchRef.current(t.x, t.y);
          } else {
            setTileMsg("逃げられた");
            playWbSe("splash");
          }
          return true;
        }
        if ((prof.items["fishing_rod"] ?? 0) <= 0) {
          setTileMsg(TILE_ERROR_LABEL.tool_required);
          denyAtTile(t.x, t.y);
          return true;
        }
        fishingRef.current = { x: t.x, y: t.y, biteAt: nowMs + 1200 + Math.random() * 2500 };
        playWbSe("splash");
        return true;
      }
      // 地表オブジェクト（採取・採掘・宝箱・温泉・探索）: 検証・付与・
      // 枯渇の記録は専用 API が担う。枯渇中は理由を出し、ブロックが
      // 置かれている場合だけ通常のタイル操作へ流す。
      if (space === "world") {
        const sobj = surfaceObjectAt(MAP_SEED, t.x, t.y);
        if (sobj && sobj.objectId !== "fishing_spot") {
          const sdef = specialObjectById(sobj.objectId);
          const harvestedAt = surfaceObjStateRef.current.get(`${t.x},${t.y}`) ?? null;
          if (sdef && objectRespawned(sdef, harvestedAt, Date.now())) {
            if (sdef.tool && !Object.keys(prof.items).some((id) => itemById(id)?.tool === sdef.tool)) {
              setTileMsg(TILE_ERROR_LABEL.tool_required);
              denyAtTile(t.x, t.y);
              return true;
            }
            swing = { startedAt: performance.now(), itemId: selItem?.id ?? null, face: player.face, whiff: false };
            playWbSe("swing");
            void postSurfaceObjectRef.current(t.x, t.y, sobj.objectId);
            return true;
          }
          if (!tilesRef.current[tileKey(t.x, t.y)]?.block) {
            setTileMsg(TILE_ERROR_LABEL.depleted);
            denyAtTile(t.x, t.y);
            return true;
          }
        }
      }
      const view = tileView(terrainMap, tilesRef.current, t.x, t.y, Date.now(), null);
      // 自分のブロックかどうかは、サーバーが返した自分の ID で判定する
      if (view.block) {
        const ov = tilesRef.current[tileKey(t.x, t.y)];
        view.block = {
          ...view.block,
          mine: selfIdRef.current !== null && ov?.block?.ownerId === selfIdRef.current,
        };
      }
      if (view.block && isContainerItem(view.block.itemId)) {
        // 樽・宝箱は採掘ではなく収納を開く。中身は全員共有（誰でも開けて
        // 出し入れできる）。回収もパネルのボタンから誰でもできる。
        void openContainerRef.current(t.x, t.y, view.block.itemId);
        return true;
      }
      if (view.block && isMachineItem(view.block.itemId)) {
        // 自分の装置は採掘ではなくパネルを開く。他人の装置は開けない。
        if (view.block.mine) {
          setMachinePanel({ x: t.x, y: t.y });
        } else {
          setTileMsg(TILE_ERROR_LABEL.not_owner);
        }
        return true;
      }
      if (view.block && isStallItem(view.block.itemId)) {
        // 屋台: タップでパネルを開く（出品の確認・出品・取り下げ・購入）
        setStallInfo(undefined);
        setStallPanel({ x: t.x, y: t.y, selItemId: selItem && !selItem.tool ? selItem.id : null, mine: view.block.mine });
        void (async () => {
          try {
            const res = await fetch(`/api/worldbox/stalls?x=${t.x}&y=${t.y}`, { headers: { Accept: "application/json" } });
            const data = (await res.json().catch(() => ({}))) as { stall?: typeof stallInfo };
            setStallInfo(res.ok ? (data.stall ?? null) : null);
          } catch {
            setStallInfo(null);
          }
        })();
        return true;
      }
      if (view.block && isSignItem(view.block.itemId)) {
        // 看板: 自分のものはタップでテキスト編集。他人の看板は文字を読むだけ（描画に出ている）
        if (view.block.mine) {
          const ovHere = tilesRef.current[tileKey(t.x, t.y)];
          setSignEdit({ x: t.x, y: t.y, text: ovHere?.signText ?? "" });
        }
        return true;
      }
      if (view.block && isShelfItem(view.block.itemId)) {
        // 棚（自分のものだけ）: 展示中なら回収、選択中のアイテムがあれば展示
        if (!view.block.mine) {
          setTileMsg(TILE_ERROR_LABEL.not_owner);
          denyAtTile(t.x, t.y);
          return true;
        }
        const ovHere = tilesRef.current[tileKey(t.x, t.y)];
        if (ovHere?.display) {
          void postTileActionRef.current("clear_display", t.x, t.y);
        } else if (selItem && !selItem.tool) {
          void postTileActionRef.current("set_display", t.x, t.y, undefined, selItem.id);
        } else {
          setTileMsg("かばんの品を選んでタップ");
        }
        return true;
      }
      if (view.block && isWellItem(view.block.itemId)) {
        // 井戸: バケツを持ってタップすると水を汲める（誰の井戸でも可）
        if ((invRef.current?.items.bucket ?? 0) > 0) {
          void postTileActionRef.current("draw_water", t.x, t.y);
        } else {
          setTileMsg("バケツが必要");
        }
        return true;
      }
      if (view.block && view.block.itemId === "piano") {
        // ピアノは誰でも弾ける。タップのたびに音階を一巡する（見た目と音だけ）
        const key = tileKey(t.x, t.y);
        const step = pianoSteps.get(key) ?? 0;
        pianoSteps.set(key, step + 1);
        const scale = [0, 2, 4, 7, 9, 12, 9, 7, 4, 2];
        playWbSe("note", { pitch: Math.pow(2, scale[step % scale.length] / 12) });
        return true;
      }
      if (view.block && isSeatItem(view.block.itemId)) {
        // ベンチ・椅子・ソファ: タップで座る/立つ。座ると家具のマスへ移動する
        const sitting = sitTileRef.current;
        if (sitting && sitting.x === t.x && sitting.y === t.y) {
          sitTileRef.current = null;
        } else {
          sitTileRef.current = { x: t.x, y: t.y };
          player.x = t.x + 0.5;
          player.y = t.y + 0.5;
          playWbSe("poof");
        }
        return true;
      }
      if (view.block && isFlowerPotItem(view.block.itemId) && view.block.mine) {
        // 植木鉢・プランター（自分のものだけ）: 植えてあれば取り除き、
        // 花を持ってタップしたら植える。それ以外は通常の扱いに流す
        const ovHere = tilesRef.current[tileKey(t.x, t.y)];
        if (ovHere?.deco || selItem?.id === "flower") {
          swing = { startedAt: performance.now(), itemId: selItem?.id ?? null, face: player.face, whiff: false };
          playWbSe("swing");
          void postTileActionRef.current(ovHere?.deco ? "remove_flower" : "plant_flower", t.x, t.y);
          return true;
        }
      }
      const act = actionForTile(view, {
        tool: selItem?.tool,
        seedId: selItem && selItem.category === "seed" ? selItem.id : undefined,
        blockId: selItem && (selItem.category === "block" || selItem.facility || selItem.placesBlock) ? selItem.id : undefined,
      });
      if (!act) {
        // 隣接タップで何も起きない場合は理由を出す（素材は置けない・その地形には置けない等）。
        // 剣の空振りは通常の応答なので理由は出さない
        if (selItem && selItem.tool !== "sword") {
          setTileMsg(TILE_ERROR_LABEL.tile_blocked);
          denyAtTile(t.x, t.y);
        }
        return false;
      }
      if (act.action === "plant-picker") {
        setSeedPicker({ x: t.x, y: t.y });
        return true;
      }
      // 入力への即時応答として道具を振る（結果の粒は成功時に別で出す）
      swing = { startedAt: performance.now(), itemId: selItem?.id ?? null, face: player.face, whiff: false };
      playWbSe("swing");
      void postTileActionRef.current(act.action, t.x, t.y, act.seedId, act.itemId);
      return true;
    };
    const onPointerDown = (e: PointerEvent) => {
      const p = canvasPos(e);
      // スティックは固定基点の円の中から始まったタッチだけ。それ以外の
      // タッチはタイル操作に回し、設置・採掘とスティックを干渉させない。
      if (isStickTouch(p.x, p.y, stickBase(p.w, p.h))) {
        joy.active = true;
        joy.pointerId = e.pointerId;
        joy.dx = 0;
        joy.dy = 0;
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (telescopeOpenRef.current) {
        // 望遠鏡中はドラッグで視点を動かす（タイル操作はしない）。
        telescopeDrag = { pointerId: e.pointerId, lastX: p.x, lastY: p.y };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (space === "lobby" || space === "lobby2" || space === "lobby3" || space === "tent") {
        // 室内のタップ: 座席とテント収納だけを扱う（移動はスティック）。
        handleIndoorTap(toTile(e));
        return;
      }
      if (space === "world" || parseInstanceSpace(space)) {
        const t = toTile(e);
        // 他プレイヤーをタップ: PvP 可能な空間（ワールド/洞窟/遺跡）でも
        // 近接範囲内だけが攻撃で、範囲外と PvP 不可空間（ロビー/テント/
        // ダンジョン）ではプロフィールチップを出す（招待導線もここから）。
        // モブ・タイルのタップより優先する。
        if (space === "world" || parseInstanceSpace(space)) {
          for (const [oid, other] of others) {
            if (Math.floor(other.track.rx) === t.x && Math.floor(other.track.ry) === t.y) {
              // 振り分けは距離で分ける: サーバーの検証と同じユークリッド
              // 2.5 タイル以内（両者の補間表示位置で判定）だけが攻撃。
              // 範囲外はカードを開く（パーティ招待の送信導線がカード内
              // UI だけのため、ワールドでも編成導線を壊さない）。
              const inMeleeRange =
                Math.hypot(other.track.rx - player.x, other.track.ry - player.y) <= PVP_ATTACK_MAX_DISTANCE;
              if (pvpSpaceAllowed(space) && inMeleeRange) {
                // モブ攻撃と同じ流れ: 向きを相手へ向けて即時に振り、結果は応答で返す
                player.face = other.track.rx >= player.x ? 1 : -1;
                const slot = invRef.current?.hotbar[selSlotRef.current] ?? null;
                swing = { startedAt: performance.now(), itemId: slot?.id ?? null, face: player.face, whiff: false };
                playWbSe("swing");
                if (Date.now() - lastAttackAt >= 350) {
                  lastAttackAt = Date.now();
                  void attackPlayerRef.current(oid, Math.floor(other.track.rx), Math.floor(other.track.ry));
                }
                return;
              }
              showPlayerCardRef.current({
                id: oid,
                name: other.track.entry.name || "プレイヤー",
                role: (other.track.entry.role ?? "free") as AdventureRoleId,
                rank: other.track.entry.rank ?? 1,
              });
              return;
            }
          }
        }
        // ダブルタップ（450ms 以内・同タイル近傍）は冒険役職の技が消費する。
        // クールタイム中・役職なしでは発動せず通常タップとして処理する。
        const lastTap = lastTapRef.current;
        const nowTap = performance.now();
        if (
          lastTap && nowTap - lastTap.at <= 450 &&
          Math.abs(lastTap.x - t.x) <= 1 && Math.abs(lastTap.y - t.y) <= 1
        ) {
          lastTapRef.current = null;
          void castSkillRef.current(t).then((cast) => {
            if (cast === "denied") {
              denyAtTile(t.x, t.y);
              return;
            }
            if (!cast) {
              if (!handleMobTap(t)) {
                if (space === "world") handleTileTap(t);
                else if (parseInstanceSpace(space)?.kind === "ruins") handleRuinsTap(t);
                else if (parseInstanceSpace(space)?.kind === "dungeon") handleDungeonTap(t);
                else handleCaveTap(t);
              }
            }
          });
          return;
        }
        lastTapRef.current = { x: t.x, y: t.y, at: nowTap };
        if (!handleMobTap(t)) {
          if (space === "world") handleTileTap(t);
          else if (parseInstanceSpace(space)?.kind === "ruins") handleRuinsTap(t);
          else if (parseInstanceSpace(space)?.kind === "dungeon") handleDungeonTap(t);
          else handleCaveTap(t);
        }
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (telescopeDrag && e.pointerId === telescopeDrag.pointerId && telescopeCam) {
        const p = canvasPos(e);
        telescopeCam.x -= (p.x - telescopeDrag.lastX) / TILE;
        telescopeCam.y -= (p.y - telescopeDrag.lastY) / TILE;
        telescopeDrag.lastX = p.x;
        telescopeDrag.lastY = p.y;
        return;
      }
      if (!joy.active || e.pointerId !== joy.pointerId) return;
      const p = canvasPos(e);
      const v = stickVector(p.x, p.y, stickBase(p.w, p.h));
      joy.dx = v.dx;
      joy.dy = v.dy;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (telescopeDrag && e.pointerId === telescopeDrag.pointerId) {
        telescopeDrag = null;
        return;
      }
      if (e.pointerId !== joy.pointerId) return;
      joy.active = false;
      joy.dx = 0;
      joy.dy = 0;
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);

    const onPageHide = () => {
      saveNow(true);
      leavePresence();
    };
    window.addEventListener("pagehide", onPageHide);

    // ---- 周辺マップ地形（プレイヤー中心の周辺図。全体図は持たない） ----
    // 1タイル=1px のオフスクリーンへ範囲分だけ描き、表示キャンバスへ
    // 拡大転写する。範囲の原点（左上のワールド座標）を引数で受け取る。
    const miniTerrainCanvas = document.createElement("canvas");
    miniTerrainCanvas.width = MINIMAP_TILES;
    miniTerrainCanvas.height = MINIMAP_TILES;
    const bigTerrainCanvas = document.createElement("canvas");
    bigTerrainCanvas.width = BIGMAP_TILES;
    bigTerrainCanvas.height = BIGMAP_TILES;
    const paintLocalTerrain = (target: HTMLCanvasElement, ox: number, oy: number, size: number) => {
      const tctx = target.getContext("2d");
      if (!tctx) return;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          tctx.fillStyle = MINIMAP_COLOR[baseTileAt(ox + x, oy + y)] ?? "#57a639";
          tctx.fillRect(x, y, 1, 1);
        }
      }
    };

    // ---- サイズ追従 ----
    const resize = () => {
      // 解像度は最大1.5倍に抑える（2倍だとモバイルで毎フレームの描画画素数が重い）
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
    };
    resize();
    window.addEventListener("resize", resize);

    // ---- 描画ヘルパー（足元 = 位置点） ----
    const drawAvatar = (
      c: CanvasRenderingContext2D,
      sx: number,
      sy: number,
      face: 1 | -1,
      phase: number,
      speedRatio: number,
      name: string | null,
      nationColor: string | null = null,
      swim = false,
      plate: { roleSymbol: string; rank: number } | null = null,
      sit = false,
    ) => {
      const size = TILE * AVATAR_TILES;
      // 泳ぎ中は体を沈め、歩行の上下動をゆるい浮き沈みに替える。座りは浅く沈んで静止する
      const sink = swim ? size * 0.34 : sit ? size * 0.16 : 0;
      const bob = swim ? Math.sin(performance.now() / 280 + phase) * TILE * 0.02 : sit ? 0 : walkBob(phase) * TILE * 0.07 * speedRatio;
      const squash = swim ? 1 : sit ? 0.86 : 1 - (1 - walkSquashY(phase)) * speedRatio;
      const waterline = sy - size * 0.28;
      c.fillStyle = "rgba(20,30,16,0.30)";
      c.beginPath();
      c.ellipse(sx, sy, size * 0.30, size * 0.10, 0, 0, Math.PI * 2);
      c.fill();
      if (texReady(avatar)) {
        const paintSprite = (alpha: number, y0: number, y1: number) => {
          c.save();
          c.beginPath();
          c.rect(sx - size, y0, size * 2, y1 - y0);
          c.clip();
          c.globalAlpha = alpha;
          c.translate(sx, sy - bob + sink);
          c.rotate(moveLean(speedRatio) * face);
          c.scale(face * (1 + (1 - squash) * 0.7), squash);
          c.drawImage(avatar, -size / 2, -size, size, size);
          c.restore();
        };
        if (swim) {
          paintSprite(0.55, waterline, sy + size); // 水中側は水を通して薄く
          paintSprite(1, sy - size * 2, waterline);
        } else {
          paintSprite(1, sy - size * 2, sy + size);
        }
      } else {
        c.fillStyle = "#f4f6f8";
        c.beginPath();
        c.arc(sx, sy - size / 2 - bob + sink, size * 0.36, 0, Math.PI * 2);
        c.fill();
      }
      if (swim) {
        // 水面の波紋（広がって消える輪を2重に）
        const t = performance.now() / 1000;
        for (let i = 0; i < 2; i++) {
          const k = (t * 0.9 + i * 0.5 + phase * 0.13) % 1;
          c.strokeStyle = `rgba(255,255,255,${(0.5 * (1 - k)).toFixed(3)})`;
          c.lineWidth = 1.5;
          c.beginPath();
          c.ellipse(sx, sy + 1, size * (0.30 + 0.22 * k), size * (0.10 + 0.07 * k), 0, 0, Math.PI * 2);
          c.stroke();
        }
      }
      if (name) {
        // ネームプレート: ユニオン色の枠 + Discord マーク + 役職シンボル + 名前 + 熟練ドット
        c.font = "600 11px sans-serif";
        const nameW = c.measureText(name).width;
        const symbolW = plate ? c.measureText(plate.roleSymbol).width : 0;
        const glyphW = 11;
        const plateW = 6 + glyphW + (plate ? 3 + symbolW : 0) + 4 + nameW + 6;
        const plateH = plate && plate.rank > 1 ? 24 : 17;
        const top = sy - size + sink - bob - plateH - 4;
        const left = sx - plateW / 2;
        c.beginPath();
        c.roundRect(left, top, plateW, plateH, 5);
        c.fillStyle = "rgba(8,10,16,0.62)";
        c.fill();
        c.lineWidth = 1.5;
        c.strokeStyle = nationColor ?? "rgba(255,255,255,0.35)";
        c.stroke();
        // Discord マーク（白い角丸＋目2つ）
        const gx = left + 5;
        const gy = top + 4;
        c.fillStyle = "#ffffff";
        c.beginPath();
        c.roundRect(gx, gy, 9, 9, 3);
        c.fill();
        c.fillStyle = "rgba(8,10,16,0.85)";
        c.fillRect(gx + 2, gy + 3.5, 2, 2);
        c.fillRect(gx + 5.5, gy + 3.5, 2, 2);
        let tx = gx + glyphW + 1;
        c.textAlign = "left";
        if (plate) {
          c.fillStyle = "#ffd75e";
          c.fillText(plate.roleSymbol, tx, top + 12.5);
          tx += symbolW + 4;
        }
        c.lineWidth = 3;
        c.strokeStyle = "rgba(10,16,10,0.65)";
        c.strokeText(name, tx, top + 12.5);
        c.fillStyle = "#ffffff";
        c.fillText(name, tx, top + 12.5);
        if (plate && plate.rank > 1) {
          // 熟練ドット（ランク分だけ金の点）
          const dotsW = plate.rank * 6 - 2;
          let dx = sx - dotsW / 2;
          c.fillStyle = "#f2c53c";
          for (let i = 0; i < plate.rank; i++) {
            c.beginPath();
            c.arc(dx + 2, top + 19.5, 2, 0, Math.PI * 2);
            c.fill();
            dx += 6;
          }
        }
        c.textAlign = "center";
      }
    };

    // ---- 首都マーカー（石の櫓＋国の色の旗＋国名） ----
    const drawCapital = (c: CanvasRenderingContext2D, sx: number, sy: number, nation: NationView) => {
      c.fillStyle = "rgba(20,30,16,0.30)";
      c.beginPath();
      c.ellipse(sx, sy, TILE * 0.34, TILE * 0.11, 0, 0, Math.PI * 2);
      c.fill();
      const w = TILE * 0.52;
      const h = TILE * 0.62;
      const x0 = sx - w / 2;
      const y0 = sy - h;
      c.fillStyle = "#9aa0a6";
      c.fillRect(x0, y0, w, h);
      c.strokeStyle = "rgba(30,34,38,0.8)";
      c.lineWidth = 1.5;
      c.strokeRect(x0, y0, w, h);
      // 胸壁
      c.fillStyle = "#878d94";
      const bw = w / 5;
      for (let i = 0; i < 3; i++) c.fillRect(x0 + i * bw * 2, y0 - TILE * 0.10, bw, TILE * 0.10);
      // 旗竿と旗
      c.strokeStyle = "#4c4438";
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(sx, y0 - TILE * 0.08);
      c.lineTo(sx, y0 - TILE * 0.52);
      c.stroke();
      c.fillStyle = nation.color;
      c.beginPath();
      c.moveTo(sx, y0 - TILE * 0.52);
      c.lineTo(sx + TILE * 0.34, y0 - TILE * 0.42);
      c.lineTo(sx, y0 - TILE * 0.32);
      c.closePath();
      c.fill();
      // 国名
      c.font = "600 11px sans-serif";
      c.textAlign = "center";
      c.lineWidth = 3;
      c.strokeStyle = "rgba(10,16,10,0.65)";
      const ly = y0 - TILE * 0.62;
      c.strokeText(nation.name, sx, ly);
      c.fillStyle = "#ffffff";
      c.fillText(nation.name, sx, ly);
      const nw = c.measureText(nation.name).width;
      c.fillStyle = nation.color;
      c.fillRect(sx - nw / 2, ly + 3, nw, 2.5);
      // 戦争中: 櫓に赤い枠（脈動）。防衛側はマーク HP バーも出す
      // （攻撃側は自国マークが削られていないので枠だけ）。
      const warMark = nationsRef.current.warMarks?.[nation.id];
      if (warMark) {
        const pulse = 0.55 + 0.35 * Math.sin(performance.now() / 280);
        c.strokeStyle = `rgba(255,64,48,${pulse})`;
        c.lineWidth = 2;
        c.strokeRect(x0 - 2.5, y0 - 2.5, w + 5, h + 5);
        if (warMark.markHp !== null && warMark.markMax > 0) {
          const bw = Math.max(nw, TILE * 0.9);
          const bx = sx - bw / 2;
          const by = ly + 8;
          c.fillStyle = "rgba(10,10,12,0.7)";
          c.fillRect(bx - 1, by - 1, bw + 2, 5);
          c.fillStyle = "#5a1512";
          c.fillRect(bx, by, bw, 3);
          c.fillStyle = "#ff5040";
          c.fillRect(bx, by, bw * Math.max(0, Math.min(1, warMark.markHp / warMark.markMax)), 3);
        }
      }
    };

    // ---- 空間移動（ワープパッド・階段・ハンバーガーメニュー） ----
    let lastTileKey = "";
    let lastStation: LobbyStation | null = null;
    let lastStationGenre: ShopGenreId | null = null;
    let lastStationArcade: string | null = null;
    let lastWorldStationKinds = "";
    const placePlayer = (x: number, y: number) => {
      const free = findFreeNear(activeMap(), x, y, activeBlocked(), { swim: space === "world" });
      player.x = free.x;
      player.y = free.y;
      player.vx = 0;
      player.vy = 0;
      cam.x = free.x;
      cam.y = free.y;
      others.clear();
      setOthersCount(0);
      lastTileKey = `${space}:${Math.floor(free.x)},${Math.floor(free.y)}`;
      saveNow();
      sendHeartbeat();
      // 移動先エリアの設置ブロックを即時に取り直す（15秒ポーリング待ちにしない）
      void refreshTilesRef.current();
    };
    instanceTeleportRef.current = (x: number, y: number) => beginTransition(() => placePlayer(x, y));
    const doWarp = (target: SaveSpace) => {
      if (target === space) return;
      // ハードカットしない: 暗転の頂点で空間を切り替える。
      beginTransition(() => {
        if (target === "lobby") {
          worldReturn = { x: player.x, y: player.y };
          space = "lobby";
          setSpaceUi("lobby");
          setStatusText("ロビー");
          setBoardOpen(false);
          setGuildBoardOpen(false);
          placePlayer(LOBBY_ENTRY.x, LOBBY_ENTRY.y);
        } else if (target === "tent") {
          worldReturn = { x: player.x, y: player.y };
          space = "tent";
          setSpaceUi("tent");
          setStatusText("テント");
          setBoardOpen(false);
          setGuildBoardOpen(false);
          const entry = tentEntryFor(invRef.current?.tentTier ?? 0);
          placePlayer(entry.x, entry.y);
        } else {
          space = "world";
          setSpaceUi("world");
          setStatusText("共有ワールド");
          lastStation = null;
          setStationUi(null);
          lastStationGenre = null;
          setStationGenre(null);
          lastStationArcade = null;
          setStationArcade(null);
          const dest = worldReturn ?? spawn;
          placePlayer(dest.x, dest.y);
        }
        spawnBurst(fxSys, "warp", player.x, player.y - 0.3);
        playWbSe("warp");
        void pollOthers();
      });
    };
    warpActionRef.current = doWarp;
    /** ロビー内の階移動（1F⇄2F⇄3F、L2b）。階段を踏んだときだけ発火し、
     * ワープと同じフェード（B1）でつなぐ。建物内の移動なので worldReturn は触らない。 */
    const FLOOR_LABEL: Record<LobbyFloorSpace, string> = { lobby: "ロビー", lobby2: "ロビー 2F", lobby3: "ロビー 3F" };
    const doFloorWarp = (target: LobbyFloorSpace, entry: { x: number; y: number }) => {
      if (target === space) return;
      beginTransition(() => {
        space = target;
        setSpaceUi(target);
        setStatusText(FLOOR_LABEL[target]);
        lastStation = null;
        setStationUi(null);
        lastStationGenre = null;
        setStationGenre(null);
        setBoardOpen(false);
        setGuildBoardOpen(false);
        placePlayer(entry.x, entry.y);
        spawnBurst(fxSys, "warp", player.x, player.y - 0.3);
        playWbSe("warp");
        void pollOthers();
      });
    };
    /** インスタンス空間（洞窟など）への遷移。入口の踏破で発火する。 */
    const warpToInstance = (target: string, entry: { x: number; y: number }) => {
      if (target === space) return;
      beginTransition(() => {
        if (space === "world") worldReturn = { x: player.x, y: player.y };
        space = target;
        setSpaceUi(target);
        const inst = parseInstanceSpace(target);
        setStatusText(inst?.kind === "cave" ? `洞窟 B${(inst.layer ?? 0) + 1}` : inst?.kind === "ruins" ? "遺跡" : inst?.kind === "dungeon" ? `ダンジョン ${(inst.layer ?? 0) + 1}F` : "インスタンス");
        lastStation = null;
        setStationUi(null);
        setBoardOpen(false);
        setGuildBoardOpen(false);
        placePlayer(entry.x, entry.y);
        spawnBurst(fxSys, "warp", player.x, player.y - 0.3);
        playWbSe("warp");
        void pollOthers();
        if (inst?.kind === "cave") {
          void refreshCaveStateRef.current(target);
          void refreshMobsRef.current();
        }
        if (inst?.kind === "ruins") {
          void refreshRuinsStateRef.current(target);
          void refreshMobsRef.current();
        }
        if (inst?.kind === "dungeon") {
          void refreshDungeonStateRef.current(target);
          void refreshMobsRef.current();
        }
      });
    };
    instanceWarpRef.current = warpToInstance;
    /** ダンジョン入場フロー: セッション作成（サーバー検証）を待ってから遷移する。 */
    enterDungeonRef.current = (ex: number, ey: number) => {
      void (async () => {
        const result = await postPartyRef.current("enter", { entrance: { x: ex, y: ey } });
        if (!result.ok || !result.space) {
          setTileMsg(result.error === "leader_not_entered" ? "リーダーの入場待ち" : "入れない");
          return;
        }
        const floor = buildDungeonFloor(MAP_SEED, ex, ey, 0);
        warpToInstance(result.space, { x: floor.portal.x + 0.5, y: floor.portal.y + 0.5 });
      })();
    };
    /** 構造物（入口など）をタイル座標で探す（自チャンク+隣接）。 */
    const structureAt = (tx: number, ty: number): PlacedStructure | null => {
      const ccx = Math.floor(tx / CHUNK_SIZE);
      const ccy = Math.floor(ty / CHUNK_SIZE);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const st of structuresForChunk(MAP_SEED, ccx + dx, ccy + dy)) {
            if (st.x === tx && st.y === ty) return st;
          }
        }
      }
      return null;
    };
    /** 所属国への移動: サーバーが決めた移動先へそのままテレポートする。 */
    teleportActionRef.current = (x: number, y: number) => {
      beginTransition(() => {
        if (space !== "world") {
          space = "world";
          setSpaceUi("world");
          setStatusText("共有ワールド");
          lastStation = null;
          setStationUi(null);
          lastStationGenre = null;
          setStationGenre(null);
          lastStationArcade = null;
          setStationArcade(null);
          setBoardOpen(false);
        }
        placePlayer(x, y);
        void pollOthers();
      });
    };
    respawnActionRef.current = (point: { x: number; y: number }) => {
      beginTransition(() => {
        space = "world";
        setSpaceUi("world");
        setStatusText("共有ワールド");
        lastStation = null;
        setStationUi(null);
        placePlayer(point.x, point.y);
        spawnBurst(fxSys, "warp", player.x, player.y - 0.3);
        playWbSe("warp");
        void pollOthers();
      });
    };
    /** タイルへ「踏み込んだ」ときだけ発火する（着地したタイルでは再発火しない）。 */
    const checkTileTriggers = () => {
      const tx = Math.floor(player.x);
      const ty = Math.floor(player.y);
      const key = `${space}:${tx},${ty}`;
      if (lastTileKey === "") {
        lastTileKey = key;
        return;
      }
      if (key === lastTileKey) return;
      lastTileKey = key;
      if (space === "world") {
        // ロビー行きは ≡ メニュー。ワールド側の踏むトリガーはテント入場とベッドのリスポーン設定。
        if (tilesRef.current[tileKey(tx, ty)]?.block?.itemId === "tent") doWarp("tent");
        else if (tilesRef.current[tileKey(tx, ty)]?.block?.itemId === "bed") postBedRespawn(tx, ty);
        else {
          const st = structureAt(tx, ty);
          const stDef = st ? structureById(st.structureId) : null;
          if (stDef?.kind === "entrance" && stDef.targetSpace === "cave") {
            const c = buildCaveLayer(MAP_SEED, tx, ty, 0);
            warpToInstance(makeInstanceSpace("cave", tx, ty, 0), { x: c.portal.x + 0.5, y: c.portal.y + 0.5 });
          } else if (stDef?.kind === "entrance" && stDef.targetSpace === "ruins") {
            const r = buildRuins(MAP_SEED, tx, ty);
            warpToInstance(makeInstanceSpace("ruins", tx, ty, 0), { x: r.portal.x + 0.5, y: r.portal.y + 0.5 });
          } else if (stDef?.kind === "entrance" && stDef.targetSpace === "dungeon") {
            enterDungeonRef.current?.(tx, ty);
          }
        }
        return;
      }
      {
        const inst = parseInstanceSpace(space);
        if (inst?.kind === "cave") {
          const cave = caveLayerNow();
          if (!cave) return;
          if (tx === cave.portal.x && ty === cave.portal.y) {
            doWarp("world");
            return;
          }
          if (cave.stairsDown && tx === cave.stairsDown.x && ty === cave.stairsDown.y) {
            const next = buildCaveLayer(MAP_SEED, inst.entranceX, inst.entranceY, inst.layer + 1);
            const up = next.stairsUp ?? next.portal;
            warpToInstance(makeInstanceSpace("cave", inst.entranceX, inst.entranceY, inst.layer + 1), { x: up.x + 0.5, y: up.y + 0.5 });
            return;
          }
          if (cave.stairsUp && tx === cave.stairsUp.x && ty === cave.stairsUp.y) {
            const prev = buildCaveLayer(MAP_SEED, inst.entranceX, inst.entranceY, inst.layer - 1);
            const down = prev.stairsDown ?? prev.portal;
            warpToInstance(makeInstanceSpace("cave", inst.entranceX, inst.entranceY, inst.layer - 1), { x: down.x + 0.5, y: down.y + 0.5 });
            return;
          }
          if (cave.onsen.some((t) => t.x === tx && t.y === ty)) {
            void postInstanceRef.current("onsen");
          }
          return;
        }
        if (inst?.kind === "dungeon") {
          const dfloor = dungeonNow();
          if (!dfloor) return;
          if (tx === dfloor.portal.x && ty === dfloor.portal.y) {
            if (inst.layer <= 0) {
              void postInstanceRef.current("leave");
              doWarp("world");
            } else {
              const prev = buildDungeonFloor(MAP_SEED, inst.entranceX, inst.entranceY, inst.layer - 1);
              const down = prev.stairsDown ?? prev.portal;
              warpToInstance(makeInstanceSpace("dungeon", inst.entranceX, inst.entranceY, inst.layer - 1), { x: down.x + 0.5, y: down.y + 0.5 });
            }
            return;
          }
          if (dfloor.stairsDown && tx === dfloor.stairsDown.x && ty === dfloor.stairsDown.y) {
            if (!dungeonStateRef.current.floorBossDead[String(inst.layer + 1)]) {
              setTileMsg("ボスを倒すと開く");
              return;
            }
            {
              // 熟練ゲートはサーバー判定（最新ランク）が正。結成時の
              // スナップショットで判定すると、ダンジョン内でランクが
              // 上がってもここだけ「ランク不足」で遮ってしまう。
              const nextFloor = inst.layer + 2;
              const gateOk = nextFloor >= 4
                ? dungeonStateRef.current.gateBoss
                : dungeonStateRef.current.gateFloor2;
              if (!gateOk) {
                setTileMsg("熟練ランクが足りない");
                return;
              }
            }
            const next = buildDungeonFloor(MAP_SEED, inst.entranceX, inst.entranceY, inst.layer + 1);
            warpToInstance(makeInstanceSpace("dungeon", inst.entranceX, inst.entranceY, inst.layer + 1), { x: next.portal.x + 0.5, y: next.portal.y + 0.5 });
            return;
          }
          return;
        }
        if (inst?.kind === "ruins") {
          const ruins = ruinsNow();
          if (!ruins) return;
          if (tx === ruins.portal.x && ty === ruins.portal.y) {
            doWarp("world");
            return;
          }
          const trap = ruins.traps.find((t) => t.x === tx && t.y === ty);
          if (trap && !ruinsStateRef.current.traps[String(trap.idx)]) {
            void postInstanceRef.current("trap", { trapIdx: trap.idx });
          }
          return;
        }
      }
      if (space === "tent") {
        const exit = tentExitFor(invRef.current?.tentTier ?? 0);
        if (tx === exit.x && ty === exit.y) doWarp("world");
        return;
      }
      // ロビーの階移動（1F⇄2F⇄3F、L2b）: 階段タイルを踏んだら対応する階へ。
      // 判定は floorWarpAt（lobby-floors.ts）が正。着地点は行き先の階段の前で、
      // 着地タイルでは再発火しない（placePlayer が lastTileKey を着地先へ進める）。
      const floorWarp = floorWarpAt(space, tx, ty);
      if (floorWarp) {
        doFloorWarp(floorWarp.to, floorWarp.entry);
        return;
      }
      if (space !== "lobby") return;
      if (tx === LOBBY_WARP_PAD.x && ty === LOBBY_WARP_PAD.y) {
        doWarp("world");
        return;
      }
      if (LOBBY_STAIRS_UP.some((t) => t.x === tx && t.y === ty)) {
        placePlayer(LOBBY_UP_LANDING.x, LOBBY_UP_LANDING.y);
        return;
      }
      if (LOBBY_STAIRS_DOWN.some((t) => t.x === tx && t.y === ty)) {
        placePlayer(LOBBY_DOWN_LANDING.x, LOBBY_DOWN_LANDING.y);
      }
    };

    // ---- メインループ ----
    let raf = 0;
    let lastT = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, Math.max(0.001, (now - lastT) / 1000));
      lastT = now;
      // ヒットストップ中はシミュレーション（移動・モブ・粒）だけを止める。
      // 壁時計ベースの処理（遷移・タイマー）は dt のまま進める。
      let sdt = hitstopActiveAt(hitstop, now) ? 0 : dt;

      // 遷移の切替: フェードアウトの頂点で1回だけ走る。
      if (transitionStart >= 0 && transitionKind === "warp" && !transitionSwapped && transitionSwapDue(now - transitionStart)) {
        transitionSwapped = true;
        const apply = transitionPending;
        transitionPending = null;
        apply?.();
      }

      // 入力ベクトル
      let ix = 0;
      let iy = 0;
      if (keys.has("a") || keys.has("arrowleft")) ix -= 1;
      if (keys.has("d") || keys.has("arrowright")) ix += 1;
      if (keys.has("w") || keys.has("arrowup")) iy -= 1;
      if (keys.has("s") || keys.has("arrowdown")) iy += 1;
      if (joy.active) {
        ix += joy.dx;
        iy += joy.dy;
      }
      // ワープ遷移中は入力を止める（暗転の間に歩き出さない）。
      if (transitionStart >= 0 && transitionKind === "warp" && !transitionDone(now - transitionStart, "warp")) {
        ix = 0;
        iy = 0;
      }
      const ilen = Math.hypot(ix, iy);
      if (ilen > 1) {
        ix /= ilen;
        iy /= ilen;
      }
      // 望遠鏡: 開いている間は移動入力を視点へ回し、プレイヤーは止まる。
      // 視点は今いる空間の範囲内だけを自由に動ける（ドラッグでも動く）。
      if (telescopeOpenRef.current) {
        if (!telescopeCam) telescopeCam = { x: player.x, y: player.y };
        if (telescopeCenterSeen !== telescopeCenterRef.current) {
          telescopeCenterSeen = telescopeCenterRef.current;
          telescopeCam = { x: player.x, y: player.y };
        }
        const camSpeed = 14;
        telescopeCam.x += ix * camSpeed * dt;
        telescopeCam.y += iy * camSpeed * dt;
        if (space !== "world") {
          const d = indoorData();
          telescopeCam.x = Math.min(d.width - 0.5, Math.max(0.5, telescopeCam.x));
          telescopeCam.y = Math.min(d.height - 0.5, Math.max(0.5, telescopeCam.y));
        }
        ix = 0;
        iy = 0;
      } else if (telescopeCam) {
        telescopeCam = null;
        telescopeDrag = null;
      }
      // 実効タイルは effTileAt が上書きを都度読むため、タイル配列の同期は不要。
      // モブ占有: 現在位置の footprint を移動の当たり判定へ合成する。
      // 占有の真上に立っている間は、そのモブの占有だけ通す（閉じ込め防止）。
      mobFrameBlocked = undefined;
      if ((space === "world" || parseInstanceSpace(space)) && mobRenders.size > 0) {
        const frameMobs: { key: string; size: number; x: number; y: number }[] = [];
        let standingKey: string | null = null;
        const ptx = Math.floor(player.x);
        const pty = Math.floor(player.y);
        for (const placed of mobCache) {
          const key = mobKeyFor(placed);
          const r = mobRenders.get(key);
          if (!r) continue;
          const cur = { key, size: placed.size, x: Math.floor(r.wx), y: Math.floor(r.wy) };
          frameMobs.push(cur);
          if (mobOccupiesTile(cur.size, cur.x, cur.y, ptx, pty)) standingKey = key;
        }
        if (frameMobs.length > 0) {
          const merged = new Set<string>(blockedRef.current);
          for (const k of mobBlockedTiles(frameMobs)) merged.add(k);
          if (standingKey) {
            const sm = frameMobs.find((m) => m.key === standingKey);
            if (sm) for (const k of mobFootprintTiles(sm.size, sm.x, sm.y)) merged.delete(k);
          }
          mobFrameBlocked = merged;
        }
      }
      // 足元の床ブロック（小道・氷・はちみつ・スライム・橋）。橋の上では水でも泳がない。
      const floorOv = space === "world" ? tilesRef.current[tileKey(Math.floor(player.x), Math.floor(player.y))] : undefined;
      const floorRaw = floorOv?.block && isOverrideActive(floorOv, Date.now()) ? floorOv.block.itemId : null;
      const onFloor = floorRaw !== null && isFloorItem(floorRaw) ? floorRaw : null;
      // ダッシュ（キーの2度押しを持ち続け / スティックの強い倒し）と泳ぎで速さと消費が変わる
      const swimming = space === "world" && onFloor !== "bridge_block" && isWaterAt(worldMap, player.x, player.y);
      const wantDash =
        ilen > 0.01 && ((dashKey !== null && keys.has(dashKey)) || (joy.active && isStickDash(joy.dx, joy.dy)));
      const dashing = wantDash && canDash(stamina);
      let moveSpeed = WALK_SPEED;
      let staminaUse: StaminaUse = "none";
      if (swimming) {
        moveSpeed = dashing ? SWIM_DASH_SPEED : SWIM_SPEED;
        staminaUse = dashing ? "swimDash" : "swim";
      } else if (dashing) {
        moveSpeed = DASH_SPEED;
        staminaUse = "dash";
      }
      // 床の速度倍率（小道は速く、はちみつは遅い。泳ぎには掛けない）
      if (!swimming) moveSpeed *= floorSpeedMultiplier(onFloor);
      // 埋没救済: タイル読み込みの完了で固体が増えた等により、自分の円が
      // 固体へ深く重なっていたら近くの立てる場所へ出す（読み込み後に
      // 壁に埋まるケースの対策）。壁に密着しただけの浅い重なりでは
      // 発火しないよう、半分の半径で重なりを判定する。
      if (circleHitsSolid(activeMap(), player.x, player.y, PLAYER_RADIUS * 0.5, activeBlocked(), { swim: space === "world" })) {
        const free = findFreeNear(activeMap(), player.x, player.y, activeBlocked(), { swim: space === "world" });
        if (free.x !== player.x || free.y !== player.y) {
          player.x = free.x;
          player.y = free.y;
          kbVel = { x: 0, y: 0 };
        }
      }
      // 座っている間は動かない。移動入力が入るか、家具のマスから外れたら立ち上がる
      if (sitTileRef.current) {
        if (ilen > 0.01 || Math.floor(player.x) !== sitTileRef.current.x || Math.floor(player.y) !== sitTileRef.current.y) {
          sitTileRef.current = null;
        }
      }
      // 氷の上: 速度は入力へ即追従せず、加速（14/秒）と弱い摩擦（0.8/秒）で滑る。
      // 氷を離れたら滑り速度を通常の速度へ同期し直す（滑りを持ち出さない）。
      let vel: { x: number; y: number };
      if (sitTileRef.current) {
        vel = { x: 0, y: 0 };
        slideVel = { x: 0, y: 0 };
      } else if (!swimming && onFloor === "ice_block") {
        const accel = 14 * sdt;
        slideVel = {
          x: slideVel.x + Math.max(-accel, Math.min(accel, ix * moveSpeed - slideVel.x)),
          y: slideVel.y + Math.max(-accel, Math.min(accel, iy * moveSpeed - slideVel.y)),
        };
        if (ilen <= 0.01) {
          const fr = Math.max(0, 1 - 0.8 * sdt);
          slideVel = { x: slideVel.x * fr, y: slideVel.y * fr };
        }
        vel = slideVel;
      } else {
        vel = { x: ix * moveSpeed, y: iy * moveSpeed };
        slideVel = vel;
      }
      let prevX = player.x;
      let prevY = player.y;
      const moved = stepMove(activeMap(), player, vel, sdt, activeBlocked(), { swim: space === "world" });
      player.x = moved.x;
      player.y = moved.y;
      // ノックバック: 残り速度を当たり判定つきで適用し、約0.16秒で減衰させる
      if (kbVel.x !== 0 || kbVel.y !== 0) {
        const kbMoved = stepMove(activeMap(), player, kbVel, sdt, activeBlocked(), { swim: space === "world" });
        player.x = kbMoved.x;
        player.y = kbMoved.y;
        const decay = Math.max(0, 1 - sdt / 0.16);
        kbVel = { x: kbVel.x * decay, y: kbVel.y * decay };
        if (Math.hypot(kbVel.x, kbVel.y) < 0.5) kbVel = { x: 0, y: 0 };
      }
      // 環境ハザード（サボテン・マグマに触れている）: ハザードは固体なので足元ではなく
      // 当たり円が触れる範囲のタイルで判定する。サーバーの被弾クールダウン（1秒）に
      // 合わせて間引きながら申告し、ダメージの有無と量はサーバーが決める。
      if (space === "world" && loggedIn && now - hazardFiredAt >= 1100) {
        let nearHazard = false;
        for (let hy = Math.floor(player.y - PLAYER_RADIUS); hy <= Math.floor(player.y + PLAYER_RADIUS) && !nearHazard; hy++) {
          for (let hx = Math.floor(player.x - PLAYER_RADIUS); hx <= Math.floor(player.x + PLAYER_RADIUS); hx++) {
            const hov = tilesRef.current[tileKey(hx, hy)];
            if (hov?.block && hazardDamageFor(hov.block.itemId) > 0) { nearHazard = true; break; }
          }
        }
        if (nearHazard) {
          hazardFiredAt = now;
          postHazard();
        }
      }
      // スタミナ増減・陸の記録・入出水の波紋・水中で力尽きたら陸へ帰還
      const floorOvNow = space === "world" ? tilesRef.current[tileKey(Math.floor(player.x), Math.floor(player.y))] : undefined;
      const onBridgeNow = floorOvNow?.block?.itemId === "bridge_block" && isOverrideActive(floorOvNow, Date.now());
      const inWaterNow = space === "world" && !onBridgeNow && isWaterAt(worldMap, player.x, player.y);
      if (space === "world" && !inWaterNow) lastLand = { x: player.x, y: player.y };
      if (inWaterNow !== wasSwimming) {
        splashes.push({ x: player.x, y: player.y, at: now });
        spawnBurst(fxSys, "splash", player.x, player.y);
        playWbSe("splash");
        wasSwimming = inWaterNow;
      }
      const staminaDt = invRef.current?.role === "scout" && staminaUse !== "none" ? sdt * SCOUT_STAMINA_MULT : sdt;
      stamina = stepStamina(stamina, staminaUse, staminaDt).state;
      if (staminaBoostRef.current) {
        // 噴水・休憩の回復（サーバー許可済み）
        stamina = createStamina();
        staminaBoostRef.current = false;
      }
      playerSwimming = inWaterNow;
      if (inWaterNow && stamina.value <= 0) {
        stamina = rescueStamina(stamina);
        player.x = lastLand.x;
        player.y = lastLand.y;
        prevX = player.x;
        prevY = player.y;
        cam.x = player.x;
        cam.y = player.y;
        wasSwimming = false;
        playerSwimming = false;
        splashes.push({ x: player.x, y: player.y, at: now });
        spawnBurst(fxSys, "warp", player.x, player.y - 0.3);
        playWbSe("warp");
        saveNow();
      }
      // モブ接触: 占有範囲までチェビシェフ距離1以内を接触とする。
      // 敵対は接触開始時（継続中は1秒間隔）だけ軽いノックバック＋hit バーストを出し、
      // ダメージはサーバー（/api/worldbox/vitals）が検証して profile の HP に適用する。
      if (space === "world" || parseInstanceSpace(space)) {
        let contact: { placed: PlacedMob; key: string; dist: number; cx: number; cy: number } | null = null;
        const ptx = Math.floor(player.x);
        const pty = Math.floor(player.y);
        for (const placed of mobCache) {
          const key = mobKeyFor(placed);
          const r = mobRenders.get(key);
          if (!r) continue;
          const cx = Math.floor(r.wx);
          const cy = Math.floor(r.wy);
          const dist = mobDistance(ptx, pty, { x: cx, y: cy, size: placed.size });
          if (dist <= 1 && (!contact || dist < contact.dist)) contact = { placed, key, dist, cx, cy };
        }
        if (!contact) {
          contactMobKeyNow = null;
        } else {
          const isNew = contact.key !== contactMobKeyNow;
          contactMobKeyNow = contact.key;
          const def = mobById(contact.placed.mobId);
          // 敵対は常時、中立は provoked（被弾して敵対化している間）だけ
          // 接触ダメージを送る。サーバーの受け付け条件（passive 以外）と
          // 一致させる（従来は中立が一切ダメージを与えなかった）。
          const contactRender = mobRenders.get(contact.key);
          const provoked = contactRender !== undefined && now < contactRender.provokedUntil;
          if (def && (def.temperament === "hostile" || (def.temperament === "neutral" && provoked)) && (isNew || now - contactFiredAt >= 1000)) {
            contactFiredAt = now;
            // 着地点へ瞬間移動させず、着地点までの方向に初速だけ与える（適用は移動ステップ側）
            postMobDamage(contact.placed.mobId, contact.placed.x, contact.placed.y, contact.cx, contact.cy);
            const target = knockbackTarget({ x: contact.cx, y: contact.cy, size: contact.placed.size }, player);
            kbVel = { x: (target.x - player.x) / 0.16, y: (target.y - player.y) / 0.16 };
            fxEventsRef.current.push({
              kind: "hit",
              x: contact.placed.x, y: contact.placed.y,
              sizeTiles: contact.placed.size,
              color: MOB_FX_COLOR[def.id],
              stop: HITSTOP_HURT_MS,
            });
            shake = startShake(shake, 2, now);
          }
        }
        // BGM 緊張レイヤー: 500ms ごとに敵対モブの接近と HP を見る（曲は変えず心拍だけ重ねる）。
        if (now - dangerCheckedAt >= 500) {
          dangerCheckedAt = now;
          const prof = invRef.current;
          const hpFrac = prof ? prof.hp / maxHpFor(prof) : 1;
          let hostileNear = false;
          if (hpFrac > 0.25) {
            const ptx2 = Math.floor(player.x);
            const pty2 = Math.floor(player.y);
            for (const placed of mobCache) {
              const def = mobById(placed.mobId);
              if (!def || def.temperament !== "hostile") continue;
              const r = mobRenders.get(mobKeyFor(placed));
              if (!r) continue;
              if (mobDistance(ptx2, pty2, { x: Math.floor(r.wx), y: Math.floor(r.wy), size: placed.size }) <= 6) {
                hostileNear = true;
                break;
              }
            }
          }
          dangerRef.current = tensionFor({ hostileNear, hpFrac });
        }
      }
      checkTileTriggers();
      if (space !== "world") {
        const tx = Math.floor(player.x);
        const ty = Math.floor(player.y);
        const st = stationNear(indoorData().objects, tx, ty);
        if (st !== lastStation) {
          lastStation = st;
          setStationUi(st);
        }
        const genre = st === "shop"
          ? stationGenreNear(indoorData().objects, tx, ty)
          : st === "smith" ? "smith" : null;
        if (genre !== lastStationGenre) {
          lastStationGenre = genre;
          setStationGenre(genre);
        }
        const arcade = st === "arcade"
          ? stationArcadeNear(indoorData().objects, tx, ty)
          : null;
        if (arcade !== lastStationArcade) {
          lastStationArcade = arcade;
          setStationArcade(arcade);
        }
      }
      if (space === "world") {
        // 設置した作業施設（作業台・かまど・焚き火・織り機等）の近くでは、
        // その種別の作業ができる（サーバー側でも同じ範囲で検証される）
        const kinds = new Set<string>();
        const px = Math.floor(player.x);
        const py = Math.floor(player.y);
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const ov = tilesRef.current[tileKey(px + dx, py + dy)];
            for (const k of placedStationKinds(ov?.block?.itemId)) kinds.add(k);
          }
        }
        const key = [...kinds].sort().join(",");
        if (key !== lastWorldStationKinds) {
          lastWorldStationKinds = key;
          setWorldStationKinds(key);
        }
      } else if (lastWorldStationKinds !== "") {
        lastWorldStationKinds = "";
        setWorldStationKinds("");
      }
      player.vx = (player.x - prevX) / dt;
      player.vy = (player.y - prevY) / dt;
      const speed = Math.hypot(player.vx, player.vy);
      if (player.vx < -0.2) player.face = -1;
      else if (player.vx > 0.2) player.face = 1;
      player.phase = advanceWalkPhase(player.phase, speed, sdt);
      const speedRatio = Math.min(1, speed / WALK_SPEED);

      // ---- 演出の更新（行為イベントの消化・粒の前進・移動の副産物） ----
      for (const ev of fxEventsRef.current.splice(0)) {
        // ヒットストップ: 自分の命中・撃破・被弾のイベントだけが時を止める
        if (ev.stop && !reducedMotion) hitstop = startHitstop(hitstop, ev.stop, now);
        if (ev.kind === "death") deathFxAt.set(`${ev.x},${ev.y}`, now);
        if (ev.kind === "whiff") {
          // 空振り: 風切りだけのスイングを再生する（粒も道具アイコンも出さない）
          swing = { startedAt: now, itemId: null, face: player.face, whiff: true };
          playWbSe("swing");
          continue;
        }
        if (ev.kind === "hit" || ev.kind === "death" || ev.kind === "spawn") {
          // モブ演出: 大きさに応じて粒をスケール。死亡は小さな揺れ、出現はポップも併用
          // 音はプレイヤーからの距離で減衰させる（B4）
          const evDist = Math.max(Math.abs(ev.x + 0.5 - player.x), Math.abs(ev.y + 0.5 - player.y));
          playWbSe(seForFxBurst(ev.kind), { distance: evDist });
          spawnMobFx(fxSys, ev.kind, ev.x + 0.5, ev.y + 0.5, { sizeTiles: ev.sizeTiles, color: ev.color });
          if (ev.kind === "death") {
            shake = startShake(shake, (ev.sizeTiles ?? 1) >= 4 ? 6 : 3, now);
            if ((ev.sizeTiles ?? 1) >= 4) spawnMobFx(fxSys, "hit", ev.x + 0.5, ev.y + 0.5, { sizeTiles: ev.sizeTiles, color: ev.color });
          }
          if (ev.kind === "spawn") pops.set(`${ev.x},${ev.y}`, now);
          if (ev.kind === "hit") {
            // 被弾した個体は白フラッシュ＋ノックバック。敵対でなければ逃げる
            for (const [mkey, r] of mobRenders) {
              if (r.ax !== ev.x || r.ay !== ev.y) continue;
              r.flashAt = now;
              const dx = r.wx - player.x;
              const dy = r.wy - player.y;
              const len = Math.hypot(dx, dy) || 1;
              r.kx += (dx / len) * TILE * 0.20;
              r.ky += (dy / len) * TILE * 0.20;
              const mdef = mobById(mkey.split("@")[0]);
              if (mdef && mdef.temperament !== "hostile") { r.fleeUntil = now + 900; r.provokedUntil = now + 6000; }
            }
          }
          continue;
        }
        spawnBurst(fxSys, ev.kind, ev.x + 0.5, ev.y + 0.5, { colors: ev.colors });
        playWbSe(seForFxBurst(ev.kind), { distance: Math.max(Math.abs(ev.x + 0.5 - player.x), Math.abs(ev.y + 0.5 - player.y)) });
        if (ev.kind === "chop" || ev.kind === "mine") shake = startShake(shake, 2, now);
        else if (ev.kind === "debris" || ev.kind === "build") shake = startShake(shake, 3, now);
        if (ev.kind === "place" || ev.kind === "build") pops.set(`${ev.x},${ev.y}`, now);
      }
      // イベントで始まったヒットストップはこのフレームの粒・モブから効かせる
      sdt = hitstopActiveAt(hitstop, now) ? 0 : dt;
      stepFx(fxSys, sdt);
      const beat = stepBeatIndex(player.phase);
      if (beat !== lastBeat) {
        lastBeat = beat;
        if (speed > 0.6 && !reducedMotion) {
          if (playerSwimming) {
            spawnBurst(fxSys, "step", player.x, player.y, { color: "#bfe6ff" });
            playWbSe("splash");
          } else {
            spawnBurst(fxSys, "step", player.x, player.y + 0.05);
            // 足音はバイオーム/空間で素材を変える（B4）
            playWbStep(footstepMaterialFor({
              biome: space === "world" ? biomeAt(MAP_SEED, Math.floor(player.x), Math.floor(player.y)) : undefined,
              space,
              swimming: false,
            }));
          }
        }
      }
      if (dashing && speed > 0.6 && now - lastDashFxAt > 45 && !reducedMotion) {
        lastDashFxAt = now;
        spawnBurst(fxSys, "dash", player.x - player.vx * 0.06, player.y - 0.35);
        playWbSe("dash");
      }
      if (playerSwimming && speed > 0.6 && now - lastSwimFxAt > 200) {
        lastSwimFxAt = now;
        spawnBurst(fxSys, "step", player.x, player.y, { color: "#7cc0e8" });
      }
      playerPosRef.current.x = player.x;
      playerPosRef.current.y = player.y;

      // カメラ（向き先読みつきのなめらか追従。望遠鏡中は自由視点へ寄せる）
      const lookX = telescopeCam ? telescopeCam.x : player.x + player.vx * 0.35;
      const lookY = telescopeCam ? telescopeCam.y : player.y + player.vy * 0.35;
      cam.x = damp(cam.x, lookX, telescopeCam ? 14 : 6, dt);
      cam.y = damp(cam.y, lookY, telescopeCam ? 14 : 6, dt);

      // 他プレイヤーの描画位置（スナップショット予測へバネでなめらかに寄せる）
      const nowMs = Date.now();
      const presenceNowMs = presenceNow();
      for (const o of others.values()) {
        o.track = stepRemoteTrack(o.track, presenceNowMs, sdt, activeBounds());
        const ospeed = Math.hypot(o.track.entry.vx, o.track.entry.vy);
        o.phase = advanceWalkPhase(o.phase, ospeed, sdt);
      }

      // 位置の自動保存（1タイル動いた or 5秒経過で少し動いた）
      const distFromSave = Math.hypot(player.x - lastSaved.x, player.y - lastSaved.y);
      if (distFromSave >= 1 || (distFromSave >= 0.25 && now - lastSaved.at > 5000)) {
        saveNow();
      }

      // ---- 描画 ----
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      // 画面の揺れ（ワールドのみ。ロビーはピクセル固定のため揺らさない）
      const shakeOff = space === "world" && !reducedMotion ? shakeOffsetAt(shake, now) : { x: 0, y: 0 };
      const toScreenX = (wx: number) => (wx - cam.x) * TILE + cw / 2 + shakeOff.x;
      const toScreenY = (wy: number) => (wy - cam.y) * TILE + ch / 2 + shakeOff.y;
      // ロビー描画用: カメラを整数ピクセルへスナップした原点（ピクセル固定）
      let lobbyOx = 0;
      let lobbyOy = 0;
      let drawLobbySprite: (o: LobbyObject) => void = () => {};
      if (space === "world") {
      const tx0 = Math.floor(cam.x - cw / TILE / 2 - 1);
      const tx1 = Math.ceil(cam.x + cw / TILE / 2 + 1);
      const ty0 = Math.floor(cam.y - ch / TILE / 2 - 1);
      const ty1 = Math.ceil(cam.y + ch / TILE / 2 + 1);
      // 流用タイルはピクセルアートなので補間を切ってクッキリ描く（アバター側は後で戻す）
      ctx.imageSmoothingEnabled = false;
      // 地形は整数ピクセルへスナップして描く。小数座標のままだとタイルごとに
      // 毎フレーム再サンプルされて重く、滲んで見える（ピクセル固定の原則どおり）。
      const tileOriginX = Math.round(toScreenX(tx0));
      const tileOriginY = Math.round(toScreenY(ty0));
      const tileSx = (tx: number) => tileOriginX + (tx - tx0) * TILE;
      const tileSy = (ty: number) => tileOriginY + (ty - ty0) * TILE;
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const id = mapTileAt(worldMap, tx, ty);
          const sx = tileSx(tx);
          const sy = tileSy(ty);
          const dungeonKey = TILE_DUNGEON[id];
          const baseTex = dungeonKey ? dungeon[dungeonKey] : textures[TILE_TEXTURE[id]];
          if (texReady(baseTex)) ctx.drawImage(baseTex, sx, sy, TILE + 1, TILE + 1);
          else {
            ctx.fillStyle = TILE_FALLBACK[id] ?? "#57a639";
            ctx.fillRect(sx, sy, TILE + 1, TILE + 1);
          }
        }
      }

      // 構造物（入口・遺構）: 決定的配置をそのまま描く。入口は踏むと遷移する。
      {
        const ccx0 = Math.floor(tx0 / CHUNK_SIZE);
        const ccx1 = Math.floor(tx1 / CHUNK_SIZE);
        const ccy0 = Math.floor(ty0 / CHUNK_SIZE);
        const ccy1 = Math.floor(ty1 / CHUNK_SIZE);
        for (let ccy = ccy0; ccy <= ccy1; ccy++) {
          for (let ccx = ccx0; ccx <= ccx1; ccx++) {
            for (const st of structuresForChunk(MAP_SEED, ccx, ccy)) {
              const stDef = structureById(st.structureId);
              const sx = Math.round(toScreenX(st.x));
              const sy = Math.round(toScreenY(st.y));
              if (stDef?.kind === "entrance") {
                ctx.fillStyle = "#4a4a55";
                ctx.fillRect(sx + 2, sy + 4, TILE - 4, TILE - 4);
                ctx.fillStyle = "#0a0a10";
                ctx.beginPath();
                ctx.arc(sx + TILE / 2, sy + TILE - 6, TILE * 0.26, Math.PI, 0);
                ctx.rect(sx + TILE / 2 - TILE * 0.26, sy + TILE - 6, TILE * 0.52, 4);
                ctx.fill();
              } else {
                ctx.fillStyle = "rgba(120,116,100,0.9)";
                ctx.fillRect(sx + 6, sy + 8, TILE - 12, TILE - 10);
                ctx.fillStyle = "rgba(90,86,70,0.9)";
                ctx.fillRect(sx + 4, sy + 5, TILE - 8, 4);
              }
              if (Math.hypot(player.x - (st.x + 0.5), player.y - (st.y + 0.5)) <= 5) {
                ctx.font = "11px sans-serif";
                ctx.textAlign = "center";
                ctx.fillStyle = "rgba(10,10,14,0.65)";
                const label = stDef?.name ?? "";
                const w = ctx.measureText(label).width + 10;
                ctx.fillRect(sx + TILE / 2 - w / 2, sy - 16, w, 14);
                ctx.fillStyle = "#fff";
                ctx.fillText(label, sx + TILE / 2, sy - 5);
              }
            }
          }
        }
      }

      // タイル上書きの重ね描き（畑・切り株・作物の成長段階）。地形と同じスナップ座標で重ねる
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const ov = tilesRef.current[tileKey(tx, ty)];
          if (!isOverrideActive(ov, nowMs)) continue;
          const sx = tileSx(tx);
          const sy = tileSy(ty);
          if (ov!.farmland) {
            const img = farmSprites.farmland;
            if (texReady(img)) ctx.drawImage(img, sx, sy, TILE + 1, TILE + 1);
            else {
              ctx.fillStyle = "#8a5a2b";
              ctx.fillRect(sx, sy, TILE + 1, TILE + 1);
            }
          }
          if (ov!.stump) {
            const img = farmSprites.stump;
            if (texReady(img)) ctx.drawImage(img, sx, sy, TILE, TILE);
          }
          if (ov!.crop) {
            const img = farmSprites[`crop${cropStage(ov!.crop, nowMs)}`];
            if (texReady(img)) ctx.drawImage(img, sx, sy, TILE, TILE);
          }
          if (ov!.hp !== undefined) {
            // 地形（岩・木）の HP 制: 削れた分だけひび割れを重ねる
            const frac = terrainHpFraction(ov!, mapTileAt(worldMap, tx, ty));
            if (frac < 1) drawBlockCracks(ctx, sx, sy, tx, ty, frac);
          }
          if (ov!.block) {
            // 設置ブロックはアイコンをタイル大で描く（ピクセル固定: 整数座標）
            // 設置直後は出現ポップ（小さく生まれて行き過ぎて収まる）
            const img = itemIcons[ov!.block.itemId];
            const bx = Math.round(sx);
            const by = Math.round(sy);
            const isRug = ov!.block.itemId === "rug";
            // 床ブロック（橋以外）も床に敷く物として平たく描く
            const isFlat = isRug || (isFloorItem(ov!.block.itemId) && ov!.block.itemId !== "bridge_block");
            const ps = isFlat ? 1 : popScaleFor(tileKey(tx, ty), now);
            ctx.save();
            if (ps !== 1) {
              ctx.translate(bx + TILE / 2, by + TILE / 2);
              ctx.scale(ps, ps);
              ctx.translate(-(bx + TILE / 2), -(by + TILE / 2));
            }
            if (isFlat) {
              // じゅうたん・床は平たく描く（立体アイコンのままにしない）
              if (texReady(img)) ctx.drawImage(img, bx + 2, Math.round(by + TILE * 0.36), TILE - 4, Math.round(TILE * 0.6));
              else {
                ctx.fillStyle = isRug ? "#8a4a56" : "#7a6a55";
                ctx.fillRect(bx + 2, Math.round(by + TILE * 0.36), TILE - 4, Math.round(TILE * 0.6));
              }
            } else if (isGateItem(ov!.block.itemId) && ov!.gateOpen === true) {
              // 開いている門は端に寄せて細く描く（開いた扉の見た目）
              if (texReady(img)) ctx.drawImage(img, bx, by, Math.round(TILE * 0.28), TILE);
              else {
                ctx.fillStyle = "#8a6a42";
                ctx.fillRect(bx, by + 4, Math.round(TILE * 0.28), TILE - 8);
              }
            } else if (texReady(img)) ctx.drawImage(img, bx, by, TILE, TILE);
            else {
              ctx.fillStyle = "#9a7b4f";
              ctx.fillRect(bx + 5, by + 5, TILE - 10, TILE - 10);
            }
            // HP制: ダメージが入ったブロックにはひび割れを重ねる
            drawBlockCracks(ctx, bx, by, tx, ty, blockHpFraction(ov!.block));
            // 植木鉢・プランターに植えた飾り（花）を上に重ねる
            if (ov!.deco) {
              const decoImg = itemIcons[ov!.deco];
              if (texReady(decoImg)) {
                const ds = Math.round(TILE * 0.55);
                ctx.drawImage(decoImg, Math.round(bx + (TILE - ds) / 2), Math.round(by + TILE * 0.06), ds, ds);
              }
            }
            // 棚の展示品を上に重ねる
            if (ov!.display) {
              const dispImg = itemIcons[ov!.display];
              if (texReady(dispImg)) {
                const ds = Math.round(TILE * 0.6);
                ctx.drawImage(dispImg, Math.round(bx + (TILE - ds) / 2), Math.round(by + TILE * 0.02), ds, ds);
              }
            }
            // 看板のテキストを板の上に描く
            if (ov!.signText) {
              ctx.save();
              ctx.font = "bold 10px sans-serif";
              ctx.textAlign = "center";
              const tw = Math.min(TILE - 2, ctx.measureText(ov!.signText).width + 8);
              ctx.fillStyle = "rgba(20,14,8,0.72)";
              ctx.fillRect(Math.round(bx + (TILE - tw) / 2), Math.round(by + TILE * 0.3), Math.round(tw), 14);
              ctx.fillStyle = "#ffe9b8";
              ctx.fillText(ov!.signText, Math.round(bx + TILE / 2), Math.round(by + TILE * 0.3) + 10, TILE - 4);
              ctx.restore();
            }
            ctx.restore();
          }
        }
      }

      // ブロック/施設を選択中は、置ける隣接タイルを薄く光らせる（置ける場所を構造で示す）
      const prof = invRef.current;
      const slot = prof?.hotbar[selSlotRef.current] ?? null;
      const selDef = slot ? itemById(slot.id) : null;
      if (prof && selDef && (selDef.category === "block" || selDef.facility === true || !!selDef.placesBlock)) {
        const px = Math.floor(player.x);
        const py = Math.floor(player.y);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const vx = px + dx;
            const vy = py + dy;
            const v = tileView(terrainMap, tilesRef.current, vx, vy, nowMs, null);
            if (actionForTile(v, { blockId: selDef.id })?.action !== "place_block") continue;
            ctx.fillStyle = "rgba(140,255,150,0.20)";
            ctx.fillRect(toScreenX(vx), toScreenY(vy), TILE, TILE);
            ctx.strokeStyle = "rgba(225,255,225,0.55)";
            ctx.lineWidth = 1.5;
            ctx.strokeRect(toScreenX(vx) + 1, toScreenY(vy) + 1, TILE - 2, TILE - 2);
          }
        }
      }

      ctx.imageSmoothingEnabled = true;

      // 首都マーカー
      for (const n of nationsRef.current.nations) {
        const csx = toScreenX(n.capital.x + 0.5);
        const csy = toScreenY(n.capital.y + 1);
        if (csx < -TILE * 2 || csy < -TILE * 2 || csx > cw + TILE * 2 || csy > ch + TILE * 2) continue;
        drawCapital(ctx, csx, csy, n);
      }
      } else {
        // ---- ロビー描画（ピクセル固定: 整数原点・整数座標・補間オフ） ----
        ctx.fillStyle = "#14121c";
        ctx.fillRect(0, 0, cw, ch);
        lobbyOx = Math.round(cw / 2 - cam.x * TILE);
        lobbyOy = Math.round(ch / 2 - cam.y * TILE);
        drawLobbySprite = (o: LobbyObject) => {
          const img = lobbySprites[o.sprite];
          const sx = lobbyOx + o.x * TILE;
          const sy = lobbyOy + o.y * TILE;
          ctx.imageSmoothingEnabled = false;
          if (texReady(img)) ctx.drawImage(img, sx, sy, o.w * TILE, o.h * TILE);
          else {
            ctx.fillStyle = "rgba(130,130,140,0.85)";
            ctx.fillRect(sx, sy, o.w * TILE, o.h * TILE);
          }
          ctx.imageSmoothingEnabled = true;
        };
        const indoor = indoorData();
        const lx0 = Math.max(0, Math.floor(cam.x - cw / TILE / 2 - 1));
        const lx1 = Math.min(indoor.width - 1, Math.ceil(cam.x + cw / TILE / 2 + 1));
        const ly0 = Math.max(0, Math.floor(cam.y - ch / TILE / 2 - 1));
        const ly1 = Math.min(indoor.height - 1, Math.ceil(cam.y + ch / TILE / 2 + 1));
        ctx.imageSmoothingEnabled = false;
        for (let ty = ly0; ty <= ly1; ty++) {
          for (let tx = lx0; tx <= lx1; tx++) {
            const id = parseInstanceSpace(space)
              ? indoor.tiles[ty * indoor.width + tx] ?? 0
              : space === "tent" ? tentTileAt(indoor.tiles, indoor.width, indoor.height, tx, ty)
              : space === "lobby2" ? lobby2TileAt(indoor.tiles, tx, ty)
              : space === "lobby3" ? lobby3TileAt(indoor.tiles, tx, ty)
              : lobbyTileAt(indoor.tiles, tx, ty);
            if (id === L_VOID) continue; // 図形の外は背景のまま
            const sx = lobbyOx + tx * TILE;
            const sy = lobbyOy + ty * TILE;
            const key = LOBBY_FLOOR_SPRITE[id];
            const img = key ? lobbySprites[key] : textures[TILE_TEXTURE[T_SAND]];
            if (texReady(img)) ctx.drawImage(img, sx, sy, TILE, TILE);
            else {
              ctx.fillStyle = LOBBY_FLOOR_FALLBACK[id] ?? "#888888";
              ctx.fillRect(sx, sy, TILE, TILE);
            }
            if (id === L_PLAZA) {
              // 広場は大理石より一段明るくする
              ctx.fillStyle = "rgba(255,255,255,0.10)";
              ctx.fillRect(sx, sy, TILE, TILE);
            }
          }
        }
        // 遺跡の床罠は薄いヒビとしてだけ見える（発動済みは消える）。
        // 斥候は 3 タイル以内の罠をはっきり視認できる（専門行為の可視化）。
        {
          const ruinsDraw = ruinsNow();
          if (ruinsDraw) {
            const scoutNear = invRef.current?.role === "scout";
            for (const trap of ruinsDraw.traps) {
              if (ruinsStateRef.current.traps[String(trap.idx)]) continue;
              if (trap.x < lx0 || trap.x > lx1 || trap.y < ly0 || trap.y > ly1) continue;
              const sx = lobbyOx + trap.x * TILE;
              const sy = lobbyOy + trap.y * TILE;
              const near = scoutNear && Math.hypot(trap.x + 0.5 - player.x, trap.y + 0.5 - player.y) <= 3;
              ctx.strokeStyle = near ? "rgba(255,90,60,0.9)" : "rgba(30,26,20,0.35)";
              ctx.lineWidth = near ? 2 : 1;
              ctx.beginPath();
              ctx.moveTo(sx + 6, sy + TILE - 7);
              ctx.lineTo(sx + TILE / 2, sy + TILE / 2 + 3);
              ctx.lineTo(sx + TILE - 8, sy + 9);
              ctx.stroke();
              if (near) ctx.strokeRect(sx + 2.5, sy + 2.5, TILE - 5, TILE - 5);
            }
          }
        }
        // 採掘者は洞窟の鉱脈が脈打って見える（専門行為の可視化）
        {
          const caveDraw2 = caveLayerNow();
          if (caveDraw2 && invRef.current?.role === "miner") {
            const pulse = 0.35 + 0.25 * Math.sin(now / 240);
            ctx.strokeStyle = `rgba(255,210,62,${pulse})`;
            ctx.lineWidth = 2;
            for (const v of caveDraw2.veins) {
              if (caveStateRef.current.veins[`${v.x},${v.y}`]) continue;
              if (v.x < lx0 || v.x > lx1 || v.y < ly0 || v.y > ly1) continue;
              ctx.strokeRect(lobbyOx + v.x * TILE + 2.5, lobbyOy + v.y * TILE + 2.5, TILE - 5, TILE - 5);
            }
          }
        }
        // 平置きオブジェクト（ワープパッド・階段・タペストリー）は足元レイヤー
        for (const o of indoor.objects) {
          if (!FLAT_LOBBY_SPRITES.has(o.sprite)) continue;
          if (o.x + o.w < lx0 || o.x > lx1 || o.y + o.h < ly0 || o.y > ly1) continue;
          drawLobbySprite(o);
        }
        ctx.imageSmoothingEnabled = true;
      }

      // ---- モブ: 配置は決定的、HP/死亡はサーバー状態、動きは見た目だけここで作る ----
      const mobDrawQueue: { placed: PlacedMob; r: MobRender; hpFrac: number; showHp: boolean }[] = [];
      const drawMob = (placed: PlacedMob, r: MobRender, hpFrac: number, showHp: boolean) => {
        const def = mobById(placed.mobId);
        if (!def) return;
        const sizePx = TILE * Math.max(1, placed.size) * 0.94;
        const loco = locomotionFor(def.id);
        const pose = locomotionPose(loco, r.phase, r.lastSpeed > 0.05);
        const bob = pose.bob * TILE;
        const cxp = toScreenX(r.wx) + r.kx + pose.sway * TILE;
        const baseY = toScreenY(r.wy) + r.ky;
        const cy = baseY - bob;
        const flash = now - r.flashAt < 130;
        const pop = popScale(popProgress(r.seenAt, now));
        const w = sizePx;
        const h = sizePx;
        const by = baseY - h;
        ctx.save();
        if (pop !== 1) {
          ctx.translate(cxp, baseY);
          ctx.scale(pop, pop);
          ctx.translate(-cxp, -baseY);
        }
        // locomotion の傾き・つぶれ＋windup の沈み込み（予兆の読みやすさ）
        const windupSquash = r.behavior.mode === "windup" ? 0.84 : 1;
        if (pose.tilt !== 0 || pose.squashY !== 1 || windupSquash !== 1) {
          ctx.translate(cxp, baseY);
          ctx.rotate(pose.tilt * r.face);
          ctx.scale(1, pose.squashY * windupSquash);
          ctx.translate(-cxp, -baseY);
        }
        // 影
        ctx.fillStyle = "rgba(20,26,20,0.25)";
        ctx.beginPath();
        ctx.ellipse(cxp, baseY + sizePx * 0.02, sizePx * 0.34, sizePx * 0.12, 0, 0, Math.PI * 2);
        ctx.fill();
        if (r.behavior.enraged) {
          // 怒り状態: 赤いオーラ（脈動）
          const pulse = 0.16 + 0.08 * Math.sin(now * 0.012);
          ctx.fillStyle = `rgba(226,72,58,${pulse.toFixed(3)})`;
          ctx.beginPath();
          ctx.ellipse(cxp, cy, sizePx * 0.55, sizePx * 0.45, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        // 本体: 素材スプライト（ピクセル固定・足元基準・向き反転）
        const spriteSrc = MOB_SPRITE[def.id];
        const img = spriteSrc ? mobSprites[def.id] : undefined;
        ctx.imageSmoothingEnabled = false;
        if (texReady(img)) {
          const dx = Math.round(cxp - w / 2);
          const dy = Math.round(cy - h / 2);
          const dw = Math.round(w);
          const dh = Math.round(h);
          // 被弾フラッシュは filter で白寄せする（オフスクリーン生成はしない）
          if (flash) ctx.filter = "brightness(2.8) saturate(0.2)";
          if (r.face < 0) {
            ctx.save();
            ctx.translate(dx + dw, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(img, 0, dy, dw, dh);
            ctx.restore();
          } else {
            ctx.drawImage(img, dx, dy, dw, dh);
          }
          if (flash) ctx.filter = "none";
        } else if (MOB_SPRITE_FALLBACK.has(def.id) || spriteSrc) {
          // 明示フォールバック種（素材なし）と、素材の読み込み完了までの間の最小限の図形。
          ctx.fillStyle = flash ? "#ffffff" : (MOB_STYLE[def.id]?.body ?? (def.temperament === "hostile" ? "#a04a4a" : "#b8b0a2"));
          ctx.beginPath();
          ctx.ellipse(cxp, cy, w * 0.38, h * 0.30, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = def.temperament === "hostile" && !flash ? "#c22e2e" : "#26221e";
          for (const s of [-1, 1]) {
            ctx.beginPath();
            ctx.arc(cxp + r.face * w * 0.08 + s * w * 0.11, cy - h * 0.04, Math.max(1.8, sizePx * 0.045), 0, Math.PI * 2);
            ctx.fill();
          }
        }
        // 凍結中は氷色で覆う（アイスランス）
        {
          const key = mobKeyFor(placed);
          const st = mobStatesRef.current[key];
          if (st?.frozenUntil && st.frozenUntil > Date.now()) {
            ctx.fillStyle = "rgba(140,210,255,0.45)";
            ctx.fillRect(Math.round(cxp - w / 2), Math.round(cy - h / 2), Math.round(w), Math.round(h));
            ctx.strokeStyle = "rgba(220,245,255,0.8)";
            ctx.lineWidth = 1;
            ctx.strokeRect(Math.round(cxp - w / 2) + 0.5, Math.round(cy - h / 2) + 0.5, Math.round(w) - 1, Math.round(h) - 1);
          }
        }
        ctx.restore();
        // HP バー（自分が攻撃しようとした個体だけ。当てても外しても出す）
        if (showHp) {
          const bw = Math.min(180, Math.max(26, w * 0.9));
          const bh2 = 4;
          const bxHp = Math.round(cxp - bw / 2);
          const byHp = Math.round(by - 9);
          ctx.fillStyle = "rgba(12,14,12,0.55)";
          ctx.fillRect(bxHp - 1, byHp - 1, bw + 2, bh2 + 2);
          ctx.fillStyle = "rgba(255,255,255,0.22)";
          ctx.fillRect(bxHp, byHp, bw, bh2);
          ctx.fillStyle = hpFrac > 0.5 ? "#7ed957" : hpFrac > 0.25 ? "#f2c53c" : "#e2483a";
          ctx.fillRect(bxHp, byHp, Math.round(bw * Math.min(1, Math.max(0, hpFrac))), bh2);
        }
      };
      if (space === "world" || parseInstanceSpace(space)) {
        const nowMs = Date.now();
        const isNight = isNightPhase(phaseAtTime(nowMs / 1000));
        const vx0 = Math.floor(cam.x - cw / TILE / 2) - 3;
        const vy0 = Math.floor(cam.y - ch / TILE / 2) - 3;
        const vx1 = Math.ceil(cam.x + cw / TILE / 2) + 3;
        const vy1 = Math.ceil(cam.y + ch / TILE / 2) + 3;
        const caveNow = caveLayerNow();
        const ruinsMobNow = ruinsNow();
        const dungeonMobNow = dungeonNow();
        const cacheKey = caveNow ? `cave:${space}` : ruinsMobNow ? `ruins:${space}:${ruinsStateRef.current.summons.length}` : dungeonMobNow ? `dungeon:${space}` : `${vx0 >> 5},${vy0 >> 5},${vx1 >> 5},${vy1 >> 5},${isNight ? 1 : 0}`;
        if (cacheKey !== mobCacheKey) {
          mobCacheKey = cacheKey;
          mobCache = caveNow
            ? [...caveNow.mobs]
            : ruinsMobNow
              ? ruinsStateRef.current.summons.map((sm) => ({
                  mobId: sm.mobId, x: sm.x, y: sm.y, biome: "plains" as const, size: mobById(sm.mobId)?.size ?? 1,
                }))
              : dungeonMobNow
                ? [...dungeonMobNow.mobs]
                : visibleMobs(MAP_SEED, vx0, vy0, vx1, vy1, isNight);
          const keys = new Set(mobCache.map((m) => mobKeyFor(m)));
          for (const k of [...mobRenders.keys()]) if (!keys.has(k)) mobRenders.delete(k);
          for (const k of [...revealedMobs]) if (!keys.has(k)) revealedMobs.delete(k);
        }
        for (const placed of mobCache) {
          const def = mobById(placed.mobId);
          if (!def) continue;
          const key = mobKeyFor(placed);
          const hpNow = mobHpNow(defFor(def), mobStatesRef.current[key] ?? null, nowMs);
          if (!hpNow.alive) {
            // 見えていた個体が状態だけで死んだ（他者の撃破など）場合は、
            // 消えっぱなしにせず死亡の粒を出す。自分の攻撃の結果は
            // attackMob が既に death イベントを積んでいるので二重に出さない。
            if (mobRenders.has(key) && Math.max(Math.abs(placed.x + 0.5 - player.x), Math.abs(placed.y + 0.5 - player.y)) <= 24) {
              const akey = `${placed.x},${placed.y}`;
              if (now - (deathFxAt.get(akey) ?? -Infinity) > 1500) {
                deathFxAt.set(akey, now);
                fxEventsRef.current.push({ kind: "death", x: placed.x, y: placed.y, sizeTiles: placed.size, color: MOB_FX_COLOR[def.id] });
              }
            }
            // 死んでいる間は見た目状態を捨てる（復活時はアンカーでポップして出る）
            mobRenders.delete(key);
            revealedMobs.delete(key);
            continue;
          }
          let r = mobRenders.get(key);
          if (!r) {
            r = {
              ax: placed.x, ay: placed.y, wx: placed.x + 0.5, wy: placed.y + 0.5,
              tx: placed.x + 0.5, ty: placed.y + 0.5, nextThink: 0,
              phase: Math.random() * 6, face: 1, flashAt: 0, kx: 0, ky: 0, seenAt: now, fleeUntil: 0,
              behavior: createBehaviorState(placed.x + 0.5, placed.y + 0.5), provokedUntil: 0, lastSpeed: 0,
            };
            mobRenders.set(key, r);
            fxEventsRef.current.push({ kind: "spawn", x: placed.x, y: placed.y, sizeTiles: placed.size, color: MOB_FX_COLOR[def.id] });
            if (isBossMob(def)) {
              // ボス級の出現は豪華に: 追加バースト＋揺れ
              fxEventsRef.current.push({ kind: "hit", x: placed.x, y: placed.y, sizeTiles: placed.size, color: MOB_FX_COLOR[def.id] });
              shake = startShake(shake, 4, now);
            }
          }
          // 思考: mob-behavior の状態機械（うろつき/追跡/予兆→攻撃→硬直/逃走/帰還）。
          // ダメージは接触経路のみで、ここは動きと演出イベントだけを出す。
          const bout = stepMobBehavior(r.behavior, {
            def, now,
            pos: { x: r.wx, y: r.wy },
            anchor: { x: placed.x + 0.5, y: placed.y + 0.5 },
            player: { x: player.x, y: player.y },
            fleeing: now < r.fleeUntil,
            provoked: now < r.provokedUntil,
            // 凍結中は状態機械ごと止める（見た目だけ氷色にしても
            // 追跡・予兆・突進が進んでしまうため）
            frozen: (mobStatesRef.current[key]?.frozenUntil ?? 0) > Date.now(),
            hpFrac: hpNow.hp / def.hp,
            rng: Math.random,
          });
          r.behavior = bout.state;
          for (const ev of bout.events as BehaviorEvent[]) {
            const pat = ev.pattern;
            if (!pat) {
              // 怒り: 赤いバースト＋揺れ
              fxEventsRef.current.push({ kind: "hit", x: placed.x, y: placed.y, sizeTiles: placed.size, color: "#e2483a" });
              shake = startShake(shake, 4, now);
              continue;
            }
            const pd = PATTERN_DEF[pat];
            if (ev.kind === "telegraph") {
              mobTelegraphs.push({ pattern: pat, x: r.wx, y: r.wy, tx: r.behavior.tx, ty: r.behavior.ty, dirX: ev.dirX, dirY: ev.dirY, from: now, until: r.behavior.until, size: placed.size });
            } else if (ev.kind === "strike") {
              if (pd.kind === "projectile") {
                mobProjectiles.push({ pattern: pat, x: r.wx, y: r.wy, tx: r.behavior.tx, ty: r.behavior.ty, from: now, until: now + 380, color: MOB_FX_COLOR[def.id] ?? "#ffffff" });
              } else if (pd.kind === "burst") {
                fxEventsRef.current.push({ kind: pat === "roar" || pat === "gust" || pat === "leaf_burst" ? "spawn" : "hit", x: placed.x, y: placed.y, sizeTiles: placed.size, color: pat === "breath_cone" ? "#e07c3c" : MOB_FX_COLOR[def.id] });
                if (pat === "slam" || pat === "club_slam" || pat === "slam_big" || pat === "tail_sweep" || pat === "roar") shake = startShake(shake, isBossMob(def) ? 5 : 3, now);
              }
            }
          }
          if (bout.teleport) {
            fxEventsRef.current.push({ kind: "spawn", x: placed.x, y: placed.y, sizeTiles: placed.size, color: MOB_FX_COLOR[def.id] });
            r.wx = bout.teleport.x; r.wy = bout.teleport.y;
          }
          r.tx = bout.target.x; r.ty = bout.target.y;
          const speed = bout.speed;
          const dx = r.tx - r.wx;
          const dy = r.ty - r.wy;
          const distT = Math.hypot(dx, dy);
          // 追跡中はプレイヤーに重ならない（手前で止まる）。strike の突進は止まらない
          const stopAt = r.behavior.mode === "chase" ? 0.85 : 0.03;
          r.lastSpeed = 0;
          if (distT > stopAt && speed > 0) {
            const step = Math.min(distT - stopAt, speed * sdt);
            r.wx += (dx / distT) * step;
            r.wy += (dy / distT) * step;
            r.phase = advanceWalkPhase(r.phase, speed, sdt);
            r.lastSpeed = speed;
            if (dx < -0.02) r.face = -1;
            else if (dx > 0.02) r.face = 1;
          }
          r.kx *= Math.exp(-9 * sdt);
          r.ky *= Math.exp(-9 * sdt);
          mobDrawQueue.push({ placed, r, hpFrac: hpNow.hp / defFor(def).hp, showHp: revealedMobs.has(key) });
        }
        // React 側（攻撃・技の申告）へモブの現在タイルを渡すスナップショット。
        // サーバーはアンカーしか知らないため、見た目の現在位置を申告して
        // 距離検証を画面に合わせる（リーシュ内でのみ採用される）。
        mobTilesRef.current = new Map(
          mobDrawQueue.map(({ placed, r }) => [
            mobKeyFor(placed),
            { mobId: placed.mobId, x: placed.x, y: placed.y, mx: Math.floor(r.wx), my: Math.floor(r.wy) },
          ]),
        );
      }

      // ---- モブの予兆マーカー・投射物・糸跡（地面レイヤー、見た目のみ） ----
      if (space === "world" || parseInstanceSpace(space)) {
        for (let i = mobTelegraphs.length - 1; i >= 0; i--) {
          const t = mobTelegraphs[i];
          if (now > t.until) { mobTelegraphs.splice(i, 1); continue; }
          const pd = PATTERN_DEF[t.pattern];
          const total = Math.max(1, t.until - t.from);
          const frac = Math.min(1, (now - t.from) / total);
          const alpha = 0.16 + 0.20 * frac + 0.05 * Math.sin(now * 0.03);
          ctx.fillStyle = `rgba(255,64,40,${alpha.toFixed(3)})`;
          ctx.strokeStyle = `rgba(255,90,60,${(alpha + 0.25).toFixed(3)})`;
          ctx.lineWidth = 2;
          const gx = pd.kind === "dash" || pd.kind === "teleport" || pd.kind === "projectile" ? t.tx : t.x;
          const gy = pd.kind === "dash" || pd.kind === "teleport" || pd.kind === "projectile" ? t.ty : t.y;
          if (pd.telegraph === "circle") {
            ctx.beginPath();
            ctx.ellipse(toScreenX(gx), toScreenY(gy), pd.radius * TILE * (0.4 + 0.6 * frac), pd.radius * TILE * 0.45 * (0.4 + 0.6 * frac), 0, 0, Math.PI * 2);
            ctx.fill(); ctx.stroke();
          } else if (pd.telegraph === "ring") {
            ctx.beginPath();
            ctx.ellipse(toScreenX(t.x), toScreenY(t.y), pd.radius * TILE * frac, pd.radius * TILE * 0.45 * frac, 0, 0, Math.PI * 2);
            ctx.stroke();
          } else if (pd.telegraph === "line") {
            const ex = t.x + t.dirX * pd.radius;
            const ey = t.y + t.dirY * pd.radius;
            ctx.lineWidth = Math.max(6, TILE * 0.5 * (0.5 + t.size * 0.2));
            ctx.beginPath();
            ctx.moveTo(toScreenX(t.x), toScreenY(t.y));
            ctx.lineTo(toScreenX(ex), toScreenY(ey));
            ctx.stroke();
            ctx.lineWidth = 2;
          } else if (pd.telegraph === "cone") {
            const ang = Math.atan2(t.dirY, t.dirX);
            ctx.beginPath();
            ctx.moveTo(toScreenX(t.x), toScreenY(t.y));
            ctx.arc(toScreenX(t.x), toScreenY(t.y), pd.radius * TILE, ang - 0.6, ang + 0.6);
            ctx.closePath();
            ctx.fill();
          }
        }
        for (let i = mobWebs.length - 1; i >= 0; i--) {
          const w = mobWebs[i];
          if (now > w.until) { mobWebs.splice(i, 1); continue; }
          const sx = toScreenX(w.x); const sy = toScreenY(w.y);
          ctx.strokeStyle = "rgba(240,240,235,0.55)";
          ctx.lineWidth = 1.5;
          for (const [dx, dy] of [[-0.4, -0.2], [0.4, -0.2], [-0.4, 0.2], [0.4, 0.2], [0, -0.35], [0, 0.35]] as const) {
            ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + dx * TILE, sy + dy * TILE); ctx.stroke();
          }
        }
        for (let i = mobProjectiles.length - 1; i >= 0; i--) {
          const pr = mobProjectiles[i];
          if (now > pr.until) {
            mobProjectiles.splice(i, 1);
            if (pr.pattern === "web_shot") mobWebs.push({ x: pr.tx, y: pr.ty, until: now + 2600 });
            continue;
          }
          const f = Math.min(1, (now - pr.from) / Math.max(1, pr.until - pr.from));
          const arc = pr.pattern === "rock_throw" ? Math.sin(f * Math.PI) * TILE * 1.1 : 0;
          const sx = toScreenX(pr.x + (pr.tx - pr.x) * f);
          const sy = toScreenY(pr.y + (pr.ty - pr.y) * f) - arc;
          ctx.fillStyle = pr.pattern === "web_shot" ? "rgba(240,240,235,0.9)" : pr.color;
          ctx.beginPath();
          ctx.arc(sx, sy, Math.max(3, TILE * 0.14), 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // プレイヤー群（y 順で奥行き感）
      const drawList: { y: number; draw: () => void }[] = [];
      for (const o of others.values()) {
        const nationColor = nationsRef.current.playerNations[o.track.entry.id]?.color ?? null;
        const oSwim = space === "world" && isWaterAt(worldMap, o.track.rx, o.track.ry);
        drawList.push({
          y: o.track.ry + PLAYER_RADIUS,
          draw: () =>
            drawAvatar(
              ctx,
              space !== "world" ? Math.round(lobbyOx + o.track.rx * TILE) : toScreenX(o.track.rx),
              // 足元は当たり円の底（中心 + 半径）に合わせる（中心に置くと手前で止まって見える）
              space !== "world" ? Math.round(lobbyOy + o.track.ry * TILE) + TILE * PLAYER_RADIUS : toScreenY(o.track.ry) + TILE * PLAYER_RADIUS,
              o.track.entry.face, o.phase, Math.min(1, Math.hypot(o.track.entry.vx, o.track.entry.vy) / WALK_SPEED), o.track.entry.name || null, nationColor, oSwim,
              { roleSymbol: roleById((o.track.entry.role ?? "free") as AdventureRoleId).symbol, rank: o.track.entry.rank ?? 1 },
              o.track.entry.sit === true,
            ),
        });
      }
      if (space !== "world") {
        const caveDraw = caveLayerNow();
        const ruinsObjDraw = ruinsNow();
        for (const o of indoorData().objects) {
          if (FLAT_LOBBY_SPRITES.has(o.sprite)) continue;
          const sx = lobbyOx + o.x * TILE;
          const sy = lobbyOy + o.y * TILE;
          if (sx < -TILE * 4 || sy < -TILE * 4 || sx > cw + TILE * 4 || sy > ch + TILE * 4) continue;
          if (ruinsObjDraw && (o.sprite === "ruins_chest" || o.sprite === "gold_door")) {
            const isDoor = o.sprite === "gold_door";
            const door = ruinsObjDraw.doors.find((d) => d.x === o.x && d.y === o.y);
            const chest = ruinsObjDraw.chests.find((c) => c.x === o.x && c.y === o.y);
            if (isDoor && door && ruinsStateRef.current.doors[String(door.idx)]) continue;
            const openedChest = !!chest && ruinsStateRef.current.chests[String(chest.idx)];
            drawList.push({
              y: o.y + o.h,
              draw: () => {
                const bx = Math.round(lobbyOx + o.x * TILE);
                const by = Math.round(lobbyOy + o.y * TILE);
                if (isDoor) {
                  ctx.fillStyle = "#7a6420";
                  ctx.fillRect(bx + 3, by + 2, TILE - 6, TILE - 2);
                  ctx.fillStyle = "#e8c85a";
                  ctx.fillRect(bx + 3, by + 2, TILE - 6, 4);
                  ctx.fillRect(bx + TILE / 2 - 2, by + TILE / 2 - 2, 4, 4);
                } else {
                  ctx.fillStyle = openedChest ? "#5d5040" : "#6e5a43";
                  ctx.fillRect(bx + 4, by + 10, TILE - 8, TILE - 14);
                  ctx.fillStyle = chest?.main ? "#e8c85a" : "#b9a888";
                  ctx.fillRect(bx + 4, by + 16, TILE - 8, 3);
                }
              },
            });
            continue;
          }
          if (caveDraw && (o.sprite === "cave_chest" || caveDraw.veins.some((v) => v.objectId === o.sprite && v.x === o.x && v.y === o.y))) {
            // 洞窟の鉱脈・宝箱は色つき図形で描く（枯渇中は鉱脈を出さない）
            const vein = caveDraw.veins.find((v) => v.x === o.x && v.y === o.y);
            const takenAt = vein ? caveStateRef.current.veins[vein.key] ?? 0 : caveStateRef.current.chest;
            const def = specialObjectById(o.sprite);
            const respawnMs = o.sprite === "cave_chest" ? 6 * 60 * 60 * 1000 : def?.respawnMs ?? 0;
            if (vein && takenAt > 0 && Date.now() - takenAt < respawnMs) continue;
            const colors: Record<string, string> = {
              coal_vein: "#3a3a42", copper_vein: "#c47b4a", rare_vein: "#e8c85a",
              crystal_cluster: "#9fe8ff", mithril_vein: "#b9f2d8", cave_chest: "#8a5a2b",
            };
            const color = colors[o.sprite] ?? "#999";
            const opened = o.sprite === "cave_chest" && takenAt > 0 && Date.now() - takenAt < respawnMs;
            drawList.push({
              y: o.y + o.h,
              draw: () => {
                const bx = Math.round(lobbyOx + o.x * TILE);
                const by = Math.round(lobbyOy + o.y * TILE);
                if (o.sprite === "cave_chest") {
                  ctx.fillStyle = opened ? "#5d4020" : color;
                  ctx.fillRect(bx + 4, by + 10, TILE - 8, TILE - 14);
                  ctx.fillStyle = "#e8c85a";
                  ctx.fillRect(bx + 4, by + 16, TILE - 8, 3);
                } else {
                  ctx.fillStyle = "#55565f";
                  ctx.fillRect(bx + 2, by + 2, TILE - 4, TILE - 4);
                  ctx.fillStyle = color;
                  ctx.beginPath();
                  ctx.moveTo(bx + TILE * 0.5, by + 5);
                  ctx.lineTo(bx + TILE - 7, by + TILE * 0.55);
                  ctx.lineTo(bx + TILE * 0.62, by + TILE - 6);
                  ctx.lineTo(bx + 7, by + TILE * 0.6);
                  ctx.closePath();
                  ctx.fill();
                }
              },
            });
            continue;
          }
          drawList.push({ y: o.y + o.h, draw: () => drawLobbySprite(o) });
        }
        // 店員NPC（あごむに。静止・当たり判定なし）
        for (const n of indoorData().npcs) {
          drawList.push({
            y: n.y + 1,
            draw: () => drawAvatar(ctx, Math.round(lobbyOx + (n.x + 0.5) * TILE), Math.round(lobbyOy + (n.y + 1) * TILE), 1, 0, 0, null),
          });
        }
      }
      for (const q of mobDrawQueue) {
        drawList.push({ y: q.r.wy, draw: () => drawMob(q.placed, q.r, q.hpFrac, q.showHp) });
      }
      // スライムブロックの上では弾む（見た目だけの上下動。移動には影響しない）
      const selfFloorOv = space === "world" ? tilesRef.current[tileKey(Math.floor(player.x), Math.floor(player.y))] : undefined;
      const slimeBouncePx = selfFloorOv?.block?.itemId === "slime_block" && isOverrideActive(selfFloorOv, Date.now())
        ? Math.abs(Math.sin(now / 170)) * TILE * 0.16
        : 0;
      drawList.push({
        y: player.y + PLAYER_RADIUS,
        draw: () =>
          drawAvatar(
            ctx,
            space !== "world" ? Math.round(lobbyOx + player.x * TILE) : toScreenX(player.x),
            // 足元は当たり円の底（中心 + 半径）に合わせる（中心に置くと手前で止まって見える）
            (space !== "world" ? Math.round(lobbyOy + player.y * TILE) + TILE * PLAYER_RADIUS : toScreenY(player.y) + TILE * PLAYER_RADIUS) - slimeBouncePx,
            player.face, player.phase, speedRatio, null, null, playerSwimming,
            null, sitTileRef.current !== null,
          ),
      });
      // 競馬: 発走中のレースはトラック上に馬を描く（位置は見せ方専用、
      // 真値はサーバーの着順。pose が脚質の隊列→最終着順へ補間する）。
      if (space === "lobby") {
        const sched = scheduleAt(Date.now());
        if (sched.runningPostMs !== null) {
          if (!raceAnimCache || raceAnimCache.postMs !== sched.runningPostMs) {
            raceAnimCache = { postMs: sched.runningPostMs, core: generateRaceCore(sched.runningPostMs) };
          }
          const core = raceAnimCache.core;
          const progress = Math.min(1, Math.max(0, (Date.now() - sched.runningPostMs) / RACE_DURATION_MS));
          for (const e of core.entries) {
            const pose = horseTrackPose(core, e.horse.id, progress, RACETRACK);
            const coat = COAT_COLORS[e.horse.coat] ?? "#8a5a2b";
            const gate = e.gate;
            drawList.push({
              y: pose.y + 0.3,
              draw: () => {
                const sx = Math.round(lobbyOx + pose.x * TILE);
                const sy = Math.round(lobbyOy + pose.y * TILE);
                ctx.beginPath();
                ctx.arc(sx, sy, TILE * 0.3, 0, Math.PI * 2);
                ctx.fillStyle = coat;
                ctx.fill();
                ctx.lineWidth = 2;
                ctx.strokeStyle = "rgba(0,0,0,0.45)";
                ctx.stroke();
                ctx.fillStyle = e.horse.coat === "芦毛" || e.horse.coat === "白毛" ? "#222" : "#fff";
                ctx.font = `700 ${Math.round(TILE * 0.34)}px sans-serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(String(gate), sx, sy + 1);
              },
            });
          }
        } else {
          raceAnimCache = null;
        }
      }
      drawList.sort((a, b) => a.y - b.y);
      for (const d of drawList) d.draw();

      // ギルドショップ区画: 借りている区画はカウンター上にギルド名を出す
      // （空き区画は汎用カウンターのまま。首都マーカーの国名と同じ流儀）
      if (space === "lobby") {
        for (const plot of guildShopPlotsRef.current) {
          const anchor = GUILD_PLOT_ANCHORS[plot.idx];
          if (!anchor) continue;
          const gx = Math.round(lobbyOx + (anchor.x + 0.5) * TILE);
          const gy = Math.round(lobbyOy + anchor.y * TILE);
          if (gx < -TILE * 4 || gy < -TILE * 2 || gx > cw + TILE * 4 || gy > ch + TILE * 2) continue;
          ctx.font = "600 11px sans-serif";
          ctx.textAlign = "center";
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(10,16,10,0.65)";
          ctx.strokeText(plot.guildName, gx, gy - 5);
          ctx.fillStyle = "#ffffff";
          ctx.fillText(plot.guildName, gx, gy - 5);
        }
      }

      // ---- アフォーダンス（B2）: 近くの「使えるもの」に脈動する輪を出す ----
      // 対象は施設・出入口・宝箱/扉。鉱脈は斥候/採掘者の既存の脈動があるので対象外。
      // 初回だけ誘導バウンス（強めの脈動＋上下の揺れ）。reducedMotion では静止した輪だけ。
      if (space !== "world") {
        const indoor = indoorData();
        const ruinsDraw = ruinsNow();
        const caveDraw = caveLayerNow();
        for (const o of indoor.objects) {
          const key = o.station ?? o.sprite;
          const isTarget =
            !!o.station ||
            FLAT_LOBBY_SPRITES.has(o.sprite) ||
            o.sprite === "ruins_chest" ||
            o.sprite === "gold_door" ||
            o.sprite === "cave_chest";
          if (!isTarget) continue;
          if (ruinsDraw && o.sprite === "ruins_chest") {
            const chest = ruinsDraw.chests.find((c) => c.x === o.x && c.y === o.y);
            if (chest && ruinsStateRef.current.chests[String(chest.idx)]) continue;
          }
          if (ruinsDraw && o.sprite === "gold_door") {
            const door = ruinsDraw.doors.find((d) => d.x === o.x && d.y === o.y);
            if (door && ruinsStateRef.current.doors[String(door.idx)]) continue;
          }
          if (caveDraw && o.sprite === "cave_chest") {
            const takenAt = caveStateRef.current.chest;
            if (takenAt > 0 && Date.now() - takenAt < 6 * 60 * 60 * 1000) continue;
          }
          if (!isWithinAffordanceRange(player.x, player.y, o.x, o.y, o.w, o.h)) continue;
          const sx = Math.round(lobbyOx + o.x * TILE);
          const sy = Math.round(lobbyOy + o.y * TILE);
          if (sx < -TILE * 2 || sy < -TILE * 2 || sx > cw + TILE * 2 || sy > ch + TILE * 2) continue;
          let seenAt = seenAffordanceRef.current.get(key);
          if (seenAt === undefined) {
            seenAt = now;
            seenAffordanceRef.current.set(key, now);
          }
          const age = now - seenAt;
          const alpha = reducedMotion ? 0.35 : nudgeRingAlpha(now, age);
          const bob = reducedMotion ? 0 : nudgeBobPx(age);
          ctx.strokeStyle = `rgba(${AFFORDANCE_RING_RGB},${alpha.toFixed(3)})`;
          ctx.lineWidth = 2;
          ctx.strokeRect(sx + 2.5, sy + 2.5 + bob, o.w * TILE - 5, o.h * TILE - 5);
        }
      }

      // ---- 無効操作のフィードバック（B2）: タップしたタイルに赤い輪＋揺れ ----
      {
        const deny = denyFxRef.current;
        if (deny) {
          const fb = deniedFeedback(now - deny.at);
          if (!fb) denyFxRef.current = null;
          else {
            const dx0 = space !== "world" ? Math.round(lobbyOx + deny.x * TILE) : Math.round(toScreenX(deny.x));
            const dy0 = space !== "world" ? Math.round(lobbyOy + deny.y * TILE) : Math.round(toScreenY(deny.y));
            ctx.strokeStyle = `rgba(${DENIED_RING_RGB},${fb.alpha.toFixed(3)})`;
            ctx.lineWidth = 2;
            ctx.strokeRect(dx0 + 2.5 + (reducedMotion ? 0 : fb.dx), dy0 + 2.5, TILE - 5, TILE - 5);
          }
        }
      }

      // 魚影（釣りスポット）と釣りの演出
      if (space === "world") {
        const activeFish = fishingRef.current;
        if (activeFish && now > activeFish.biteAt + 1100) fishingRef.current = null;
        const fcx0 = Math.floor((cam.x - cw / TILE / 2) / CHUNK_SIZE);
        const fcx1 = Math.ceil((cam.x + cw / TILE / 2) / CHUNK_SIZE);
        const fcy0 = Math.floor((cam.y - ch / TILE / 2) / CHUNK_SIZE);
        const fcy1 = Math.ceil((cam.y + ch / TILE / 2) / CHUNK_SIZE);
        for (let fcy = fcy0; fcy <= fcy1; fcy++) {
          for (let fcx = fcx0; fcx <= fcx1; fcx++) {
            for (const o of objectsForChunk(MAP_SEED, fcx, fcy)) {
              if (o.objectId !== "fishing_spot") continue;
              const caughtAt = fishCaughtRef.current.get(`${o.x},${o.y}`) ?? 0;
              if (caughtAt && now - caughtAt < 10 * 60 * 1000) continue;
              const sx = toScreenX(o.x + 0.5);
              const sy = toScreenY(o.y + 0.55);
              const bob = Math.sin(now / 600 + o.x * 1.7 + o.y) * 2;
              ctx.fillStyle = "rgba(10,30,50,0.55)";
              ctx.beginPath();
              ctx.ellipse(sx, sy + bob, TILE * 0.30, TILE * 0.13, 0, 0, Math.PI * 2);
              ctx.fill();
              ctx.beginPath();
              ctx.moveTo(sx + TILE * 0.28, sy + bob);
              ctx.lineTo(sx + TILE * 0.44, sy - TILE * 0.08 + bob);
              ctx.lineTo(sx + TILE * 0.44, sy + TILE * 0.08 + bob);
              ctx.closePath();
              ctx.fill();
            }
          }
        }
        // 地表オブジェクト（採取・採掘・宝箱・温泉・探索）。再出現する
        // ものは枯渇中は隠し、一回きりは使い終わりの姿で残す。近くの
        // 使えるものにはアフォーダンスの輪（B2 と同じ様式）を出す。
        for (let fcy = fcy0; fcy <= fcy1; fcy++) {
          for (let fcx = fcx0; fcx <= fcx1; fcx++) {
            for (const o of objectsForChunk(MAP_SEED, fcx, fcy)) {
              if (o.objectId === "fishing_spot") continue;
              const odef = specialObjectById(o.objectId);
              if (!odef) continue;
              const harvestedAt = surfaceObjStateRef.current.get(`${o.x},${o.y}`) ?? null;
              const ready = objectRespawned(odef, harvestedAt, now);
              if (!ready && odef.respawnMs > 0) continue;
              drawSurfaceObject(ctx, o.objectId, toScreenX(o.x), toScreenY(o.y), TILE, !ready, now);
              if (ready && Math.max(Math.abs(o.x + 0.5 - player.x), Math.abs(o.y + 0.5 - player.y)) <= 2) {
                const alpha = reducedMotion ? 0.3 : 0.28 + 0.14 * Math.sin(now / 300);
                ctx.strokeStyle = `rgba(${AFFORDANCE_RING_RGB},${alpha.toFixed(3)})`;
                ctx.lineWidth = 2;
                ctx.strokeRect(toScreenX(o.x) + 2.5, toScreenY(o.y) + 2.5, TILE - 5, TILE - 5);
              }
            }
          }
        }
        const f = fishingRef.current;
        if (f) {
          const sx = toScreenX(f.x + 0.5);
          const sy = toScreenY(f.y + 0.5);
          // 糸とウキ
          ctx.strokeStyle = "rgba(255,255,255,0.5)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(toScreenX(player.x + 0.4), toScreenY(player.y - 0.4));
          ctx.lineTo(sx, sy);
          ctx.stroke();
          const biting = now >= f.biteAt;
          ctx.fillStyle = biting ? "#e84a3c" : "#f2f2f2";
          ctx.beginPath();
          ctx.arc(sx, sy + (biting ? 2 : 0), 3, 0, Math.PI * 2);
          ctx.fill();
          if (biting) {
            const age = Math.min(1, (now - f.biteAt) / 1100);
            ctx.strokeStyle = `rgba(255,255,255,${(0.8 * (1 - age)).toFixed(3)})`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.ellipse(sx, sy, TILE * (0.15 + 0.35 * age), TILE * (0.06 + 0.14 * age), 0, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }

      // 洞窟の闇: 明かりの半径の外を暗くする（松明 6 / ランプ 9 タイル）。
      // 設置した明かり（松明/ランプ/焚き火）も実際に周りを照らす:
      // 闇はオフスクリーンに描き、明かりの位置に穴を開けてから重ねる。
      if (parseInstanceSpace(space)?.kind === "cave" || parseInstanceSpace(space)?.kind === "dungeon") {
        if (!darkCanvasRef.current) darkCanvasRef.current = document.createElement("canvas");
        const dark = darkCanvasRef.current;
        if (dark.width !== cw || dark.height !== ch) { dark.width = cw; dark.height = ch; }
        const dctx = dark.getContext("2d");
        if (dctx) {
          dctx.setTransform(1, 0, 0, 1, 0, 0);
          dctx.clearRect(0, 0, cw, ch);
          const radius = lightRadiusTiles(invRef.current?.items) * TILE;
          const cxp = Math.round(lobbyOx + player.x * TILE);
          const cyp = Math.round(lobbyOy + player.y * TILE);
          const grad = dctx.createRadialGradient(cxp, cyp, radius * 0.55, cxp, cyp, radius);
          grad.addColorStop(0, "rgba(5,6,14,0)");
          grad.addColorStop(1, "rgba(5,6,14,0.93)");
          dctx.fillStyle = grad;
          dctx.fillRect(0, 0, cw, ch);
          dctx.globalCompositeOperation = "destination-out";
          for (const [key, ov] of Object.entries(tilesRef.current)) {
            const itemId = ov.block?.itemId;
            const rTiles = placedLightRadiusTiles(itemId);
            if (!rTiles) continue;
            const comma = key.indexOf(",");
            const lx = Number(key.slice(0, comma));
            const ly = Number(key.slice(comma + 1));
            const sx = Math.round(lobbyOx + (lx + 0.5) * TILE);
            const sy = Math.round(lobbyOy + (ly + 0.5) * TILE);
            const r = rTiles * TILE;
            if (sx < -r || sy < -r || sx > cw + r || sy > ch + r) continue;
            const g = dctx.createRadialGradient(sx, sy, r * 0.4, sx, sy, r);
            g.addColorStop(0, "rgba(0,0,0,0.95)");
            g.addColorStop(1, "rgba(0,0,0,0)");
            dctx.fillStyle = g;
            dctx.beginPath();
            dctx.arc(sx, sy, r, 0, Math.PI * 2);
            dctx.fill();
          }
          dctx.globalCompositeOperation = "source-over";
          ctx.drawImage(dark, 0, 0, cw, ch);
        }
      }

      // 入水/出水の波紋（広がって消える輪）
      if (space === "world" && splashes.length > 0) {
        for (let i = splashes.length - 1; i >= 0; i--) {
          const s = splashes[i];
          const age = (now - s.at) / 450;
          if (age >= 1) {
            splashes.splice(i, 1);
            continue;
          }
          ctx.strokeStyle = `rgba(255,255,255,${(0.65 * (1 - age)).toFixed(3)})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.ellipse(toScreenX(s.x), toScreenY(s.y), TILE * (0.25 + 0.45 * age), TILE * (0.09 + 0.16 * age), 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // ---- パーティクル（形は fx.ts の shape、描き分けはここだけ） ----
      const drawParticles = (glowPass: boolean) => {
        for (const p of fxSys.particles) {
          const isGlow = p.shape === "glow";
          if (isGlow !== glowPass) continue;
          const sx = space !== "world" ? Math.round(lobbyOx + p.x * TILE) : toScreenX(p.x);
          const sy = space !== "world" ? Math.round(lobbyOy + p.y * TILE) : toScreenY(p.y);
          if (sx < -TILE || sy < -TILE || sx > cw + TILE || sy > ch + TILE) continue;
          const ratio = fxLifeRatio(p);
          const sizePx = Math.max(1.5, p.size * TILE);
          ctx.fillStyle = p.color;
          ctx.strokeStyle = p.color;
          if (p.shape === "chip" || p.shape === "leaf") {
            ctx.save();
            ctx.globalAlpha = Math.min(1, ratio * 1.6);
            ctx.translate(sx, sy);
            ctx.rotate(p.rot);
            ctx.fillRect(-sizePx / 2, -sizePx / 4, sizePx, sizePx / 2);
            ctx.restore();
          } else if (p.shape === "spark") {
            ctx.save();
            ctx.globalAlpha = Math.min(1, ratio * 1.8);
            ctx.translate(sx, sy);
            ctx.rotate(Math.atan2(p.vy, p.vx));
            ctx.fillRect(-sizePx / 2, -1, sizePx, 2);
            ctx.restore();
          } else if (p.shape === "ring") {
            const prog = 1 - ratio;
            ctx.save();
            ctx.globalAlpha = 0.65 * ratio;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.ellipse(sx, sy, sizePx * (0.6 + 2.2 * prog), sizePx * (0.25 + 0.8 * prog), 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          } else if (p.shape === "puff") {
            ctx.save();
            ctx.globalAlpha = 0.32 * ratio;
            ctx.beginPath();
            ctx.arc(sx, sy, sizePx * (1.15 - 0.35 * ratio), 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          } else if (p.shape === "glow") {
            ctx.save();
            ctx.globalCompositeOperation = "lighter";
            ctx.globalAlpha = 0.75 * ratio;
            ctx.beginPath();
            ctx.arc(sx, sy, sizePx / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          } else {
            // drop / snow: 小さな丸（暗色も混ぜてあるので背景を選ばない）
            ctx.save();
            ctx.globalAlpha = Math.min(1, ratio * 1.7);
            ctx.beginPath();
            ctx.arc(sx, sy, sizePx / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        }
      };
      // 環境パーティクル（雪原=雪、雨天=雨、森=落葉、夜=蛍、それ以外=花粉。ワールドのみ）
      // 天候は fx.ts の決定的サイクルで全員一致。時間帯が切り替わったフレームは数粒追加で出す
      if (space === "world" && now - lastAmbientAt > 150 && !reducedMotion) {
        lastAmbientAt = now;
        const ptile = mapTileAt(worldMap, Math.floor(player.x), Math.floor(player.y));
        const nowSec = nowMs / 1000;
        const phase = phaseAtTime(nowSec);
        const isTreeTile = ptile === T_TREE || ptile === T_SNOW_TREE;
        // 天候は区間境界で混ぜる（雨の強さ 0〜1、fx.ts の weatherBlendAt が正）。
        // 雪バイオームでは従来どおり雪が優先する。
        const blend = weatherBlendAt(nowSec);
        const dryKind = weatherAmbientKind("clear", ptile, isTreeTile, nightAmount(phase));
        const kind = dryKind === "snow" ? "snow" : blend.rainStrength >= 0.5 ? "rain" : dryKind;
        const ax0 = cam.x - cw / TILE / 2 - 1;
        const ax1 = cam.x + cw / TILE / 2 + 1;
        const ay0 = cam.y - ch / TILE / 2 - 1;
        const pk = phaseKind(phase);
        if (lastPhaseKind !== "" && pk !== lastPhaseKind) {
          for (let i = 0; i < 4; i++) spawnAmbient(fxSys, kind, ax0, ax1, ay0);
        }
        lastPhaseKind = pk;
        if (dryKind === "snow") {
          spawnAmbient(fxSys, "snow", ax0, ax1, ay0);
        } else {
          // 雨の粒数は強さに比例させる（満強度で従来どおり3粒/回）。
          // 弱い間は通常の環境粒も続けて、空が徐々に移るようにする
          const rainN = Math.round(3 * blend.rainStrength);
          for (let i = 0; i < rainN; i++) spawnAmbient(fxSys, "rain", ax0, ax1, ay0);
          if (blend.rainStrength < 0.5) spawnAmbient(fxSys, dryKind, ax0, ax1, ay0);
        }
      }
      drawParticles(false);

      // 冒険役職の技演出: 段階遷移で粒を出し、形を描く
      {
        const inCaveFx = space !== "world";
        const sx = (wx: number) => (inCaveFx ? Math.round(lobbyOx + wx * TILE) : toScreenX(wx));
        const sy = (wy: number) => (inCaveFx ? Math.round(lobbyOy + wy * TILE) : toScreenY(wy));
        skillFxRef.current = skillFxRef.current.filter((entry) => skillFxProgress(entry.effect, now) < 1);
        for (const entry of skillFxRef.current) {
          const eff = entry.effect;
          const stage = skillFxStage(eff, now);
          if (stage > entry.stage) {
            entry.stage = stage;
            spawnSkillFx(fxSys, eff, stage);
            if (eff.kind === "meteor" && stage === 2) shake = startShake(shake, 8, now, 260);
            if (eff.kind === "thunder_strike" && stage === 1) shake = startShake(shake, 5, now, 200);
            if ((eff.kind === "sweep" || eff.kind === "whirlwind") && stage === 1) shake = startShake(shake, 3, now, 160);
            if (eff.kind === "fireball" && stage === 1) shake = startShake(shake, 4, now, 180);
          }
          const prog = Math.max(0, skillFxProgress(eff, now));
          const cxp = sx(eff.x);
          const cyp = sy(eff.y);
          ctx.save();
          if (eff.kind === "heal_zone" || eff.kind === "poison_field") {
            const rTiles = eff.kind === "heal_zone" ? 2.25 : 2.0;
            const pulse = 1 + Math.sin(now / 160) * 0.05;
            ctx.globalAlpha = 0.22 * (1 - prog * 0.5);
            ctx.fillStyle = eff.kind === "heal_zone" ? "#7ed957" : "#9be15d";
            ctx.beginPath();
            ctx.ellipse(cxp, cyp, rTiles * TILE * pulse, rTiles * TILE * 0.45 * pulse, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 0.7;
            ctx.strokeStyle = eff.kind === "heal_zone" ? "#b6f26d" : "#7ac74f";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.ellipse(cxp, cyp, rTiles * TILE * pulse, rTiles * TILE * 0.45 * pulse, 0, 0, Math.PI * 2);
            ctx.stroke();
          } else if (eff.kind === "sweep") {
            const a0 = -Math.PI * 0.9 + prog * Math.PI * 1.1;
            ctx.globalAlpha = 0.85 * (1 - prog);
            ctx.strokeStyle = "#e8f4ff";
            ctx.lineWidth = 5;
            for (let k = 0; k < 3; k++) {
              ctx.beginPath();
              ctx.arc(sx(eff.fromX), sy(eff.fromY) - TILE * 0.4, (1.1 + k * 0.28) * TILE, a0 - k * 0.16, a0 + 0.9 - k * 0.16);
              ctx.stroke();
            }
          } else if (eff.kind === "whirlwind") {
            ctx.globalAlpha = 0.8 * (1 - prog * 0.6);
            ctx.strokeStyle = "#dff3ff";
            ctx.lineWidth = 4;
            for (let k = 0; k < 3; k++) {
              const rr = (0.9 + k * 0.5 + prog * 0.5) * TILE;
              const a0 = prog * Math.PI * 6 + k * 0.7;
              ctx.beginPath();
              ctx.arc(sx(eff.fromX), sy(eff.fromY) - TILE * 0.3, rr, a0, a0 + Math.PI * 1.2);
              ctx.stroke();
            }
          } else if (eff.kind === "fireball" || eff.kind === "ice_lance") {
            const t01 = Math.min(1, prog / 0.4);
            const px = eff.fromX + (eff.x - eff.fromX) * t01;
            const py = eff.fromY - 0.4 + (eff.y - 0.4 - (eff.fromY - 0.4)) * t01;
            ctx.globalAlpha = 0.95;
            ctx.fillStyle = eff.kind === "fireball" ? "#ff9a3c" : "#bfe9ff";
            ctx.beginPath();
            ctx.arc(sx(px), sy(py), TILE * 0.22, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 0.5;
            ctx.beginPath();
            ctx.arc(sx(px), sy(py), TILE * 0.36, 0, Math.PI * 2);
            ctx.fill();
          } else if (eff.kind === "thunder_strike") {
            if (stage === 0) {
              ctx.globalAlpha = 0.25 + 0.2 * Math.sin(now / 60);
              ctx.fillStyle = "#cfe8ff";
              ctx.fillRect(cxp - 3, cyp - TILE * 5, 6, TILE * 5);
            } else {
              ctx.globalAlpha = stage === 1 ? 0.95 : 0.4;
              ctx.strokeStyle = "#eaf6ff";
              ctx.lineWidth = 3;
              const pts = thunderBoltPoints(eff.seed, eff.x, eff.y - 5, eff.x, eff.y);
              ctx.beginPath();
              pts.forEach((pt, i) => {
                const X = sx(pt.x);
                const Y = sy(pt.y);
                if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
              });
              ctx.stroke();
            }
          } else if (eff.kind === "meteor") {
            if (stage === 0) {
              ctx.globalAlpha = 0.5 + 0.3 * Math.sin(now / 70);
              ctx.strokeStyle = "#ff6b4a";
              ctx.lineWidth = 3;
              ctx.beginPath();
              ctx.ellipse(cxp, cyp, 2.5 * TILE, 2.5 * TILE * 0.45, 0, 0, Math.PI * 2);
              ctx.stroke();
            } else if (stage === 1) {
              const t01 = (prog - 0.6) / 0.2;
              const px = eff.x + 2.2 * (1 - t01);
              const py = eff.y - 4.5 * (1 - t01);
              ctx.globalAlpha = 0.95;
              ctx.fillStyle = "#8a6f5c";
              ctx.beginPath();
              ctx.arc(sx(px), sy(py), TILE * 0.34, 0, Math.PI * 2);
              ctx.fill();
            }
          } else if (eff.kind === "arrow_rain") {
            ctx.globalAlpha = 0.5;
            ctx.strokeStyle = "#ffd23e";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.ellipse(cxp, cyp, 2.1 * TILE, 2.1 * TILE * 0.45, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 0.85;
            ctx.strokeStyle = "#e8e2d0";
            for (let i = 0; i < 10; i++) {
              const h = ((eff.seed * (i + 3) * 7919) % 100) / 100;
              const ax = eff.x + (((eff.seed >> (i % 8)) % 40) / 10 - 2);
              const ay = eff.y - 2.6 + ((prog * 3 + h) % 1) * 2.6;
              ctx.beginPath();
              ctx.moveTo(sx(ax), sy(ay));
              ctx.lineTo(sx(ax) + 3, sy(ay) + TILE * 0.5);
              ctx.stroke();
            }
          } else if (eff.kind === "taunt") {
            ctx.globalAlpha = 0.7 * (1 - prog);
            ctx.strokeStyle = "#ffd23e";
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.ellipse(sx(eff.fromX), sy(eff.fromY), (0.5 + prog * 3) * TILE, (0.5 + prog * 3) * TILE * 0.45, 0, 0, Math.PI * 2);
            ctx.stroke();
          } else if (eff.kind === "warp") {
            // 立ち上る光柱＋広がるリング（ポーター設置）
            const rise = Math.min(1, prog * 1.5);
            const colW = TILE * 0.55 * (1 - prog * 0.35);
            ctx.globalAlpha = 0.5 * (1 - prog * 0.55);
            ctx.fillStyle = "#ffe9a8";
            ctx.fillRect(cxp - colW / 2, cyp - TILE * 3.4 * rise, colW, TILE * 3.4 * rise);
            ctx.globalAlpha = 0.85 * (1 - prog);
            ctx.strokeStyle = "#ffd23e";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.ellipse(cxp, cyp, (0.3 + prog * 1.2) * TILE, (0.3 + prog * 1.2) * TILE * 0.45, 0, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
        }
        // 薬師向け死亡マーカー
        if (invRef.current?.role === "medic") {
          for (const d of deathsRef.current) {
            const mx = sx(d.x);
            const my = sy(d.y);
            ctx.save();
            ctx.globalAlpha = 0.85;
            ctx.fillStyle = "#ff5a4a";
            ctx.fillRect(mx - 2, my - TILE * 0.7, 4, TILE * 0.5);
            ctx.fillRect(mx - TILE * 0.18, my - TILE * 0.58, TILE * 0.36, 4);
            ctx.restore();
          }
        }
      }

      // 道具スイングと風切り（自分のタップへの応答）
      if (space === "world" || parseInstanceSpace(space)) {
        const sk = swingProgress(swing.startedAt, now);
        if (sk < 1) {
          const inCave = space !== "world";
          const cxp = inCave ? Math.round(lobbyOx + player.x * TILE) : toScreenX(player.x);
          const cyp = (inCave ? Math.round(lobbyOy + player.y * TILE) : toScreenY(player.y)) - TILE * 0.45;
          const ang = attackSwingAngle(sk);
          ctx.save();
          ctx.translate(cxp, cyp);
          ctx.scale(swing.face, 1);
          // 風切り（振り抜きの瞬間だけ出る弧。空振りは薄く・細く）
          ctx.strokeStyle = `rgba(255,255,255,${(slashAlpha(sk) * 0.85 * (swing.whiff ? WHIFF_ALPHA_SCALE : 1)).toFixed(3)})`;
          ctx.lineWidth = swing.whiff ? 1.5 : 3;
          ctx.beginPath();
          ctx.arc(0, 0, TILE * 0.78, ang - 1.15, ang + 0.35);
          ctx.stroke();
          // 道具アイコンを振る（空振りと、無い道具は弧だけ）
          const img = !swing.whiff && swing.itemId ? itemIcons[swing.itemId] : undefined;
          if (texReady(img)) {
            ctx.rotate(ang);
            ctx.drawImage(img, TILE * 0.30, -TILE * 0.30, TILE * 0.62, TILE * 0.62);
          }
          ctx.restore();
        }
      }

      // 設置した噴水は水しぶきを上げる（約0.5秒に1回、近くのものだけ）
      if (space === "world" && nowMs - lastFountainFxAt > 500) {
        lastFountainFxAt = nowMs;
        for (const [key, ov] of Object.entries(tilesRef.current)) {
          if (ov.block?.itemId !== "fountain") continue;
          const comma = key.indexOf(",");
          const fx0 = Number(key.slice(0, comma));
          const fy0 = Number(key.slice(comma + 1));
          if (Math.abs(fx0 + 0.5 - player.x) > 14 || Math.abs(fy0 + 0.5 - player.y) > 10) continue;
          spawnBurst(fxSys, "splash", fx0 + 0.5, fy0 + 0.4);
        }
      }

      // 昼夜の薄い色づけ（共有時計。ロビーは屋内なので付けない）。
      // 夜はオフスクリーンに描いて、自分の明かりと設置した明かりの周りに
      // 穴を開けてから重ねる（明かりが実際に周りを照らす）。
      const night = nightAmount(phaseAtTime(nowMs / 1000));
      if (space === "world" && night > 0.01) {
        if (!darkCanvasRef.current) darkCanvasRef.current = document.createElement("canvas");
        const dark = darkCanvasRef.current;
        if (dark.width !== cw || dark.height !== ch) { dark.width = cw; dark.height = ch; }
        const dctx = dark.getContext("2d");
        if (dctx) {
          dctx.setTransform(1, 0, 0, 1, 0, 0);
          dctx.clearRect(0, 0, cw, ch);
          dctx.fillStyle = `rgba(9,13,42,${(night * 0.36).toFixed(3)})`;
          dctx.fillRect(0, 0, cw, ch);
          dctx.globalCompositeOperation = "destination-out";
          const punch = (sx: number, sy: number, rTiles: number) => {
            const r = rTiles * TILE;
            if (sx < -r || sy < -r || sx > cw + r || sy > ch + r) return;
            const g = dctx.createRadialGradient(sx, sy, r * 0.4, sx, sy, r);
            g.addColorStop(0, "rgba(0,0,0,0.95)");
            g.addColorStop(1, "rgba(0,0,0,0)");
            dctx.fillStyle = g;
            dctx.beginPath();
            dctx.arc(sx, sy, r, 0, Math.PI * 2);
            dctx.fill();
          };
          punch(toScreenX(player.x), toScreenY(player.y), lightRadiusTiles(invRef.current?.items));
          for (const [key, ov] of Object.entries(tilesRef.current)) {
            const rTiles = placedLightRadiusTiles(ov.block?.itemId);
            if (!rTiles) continue;
            const comma = key.indexOf(",");
            const lx = Number(key.slice(0, comma));
            const ly = Number(key.slice(comma + 1));
            punch(toScreenX(lx + 0.5), toScreenY(ly + 0.5), rTiles);
          }
          dctx.globalCompositeOperation = "source-over";
          ctx.drawImage(dark, 0, 0, cw, ch);
        } else {
          ctx.fillStyle = `rgba(9,13,42,${(night * 0.36).toFixed(3)})`;
          ctx.fillRect(0, 0, cw, ch);
        }
      }
      // 光る粒（蛍・ワープの光）は夜の色づけの上に出す
      if (space === "world") drawParticles(true);

      // スティック（固定基点）
      const base = stickBase(cw, ch);
      ctx.fillStyle = joy.active ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.arc(base.x, base.y, 52, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = joy.active ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.22)";
      ctx.beginPath();
      ctx.arc(base.x + joy.dx * 34, base.y + joy.dy * 34, stickKnobRadius(joy.active), 0, Math.PI * 2);
      ctx.fill();

      // スタミナ（ゼルダ式の円形ゲージをキャラの左上に。満タンで放置すると消える）
      if (staminaGaugeVisible(stamina)) {
        const px = space !== "world" ? Math.round(lobbyOx + player.x * TILE) : toScreenX(player.x);
        const py = space !== "world" ? Math.round(lobbyOy + player.y * TILE) : toScreenY(player.y);
        const size = TILE * AVATAR_TILES;
        const gx = px - size * 0.72;
        const gy = py - size * 0.80;
        const gr = 11;
        const frac = stamina.value / STAMINA_MAX;
        ctx.beginPath();
        ctx.arc(gx, gy, gr, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(10,16,10,0.45)";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(gx, gy, gr - 2.5, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.strokeStyle = stamina.exhausted ? "#e5484d" : frac < 0.35 ? "#f5c542" : "#58d158";
        ctx.lineWidth = 3;
        ctx.stroke();
      }

      // 遷移の暗幕（シェル背景と同色。ワープ/入場/再接続の継ぎ目を消す）。
      if (transitionStart >= 0) {
        const overlayAlpha = transitionAlpha(now - transitionStart, transitionKind);
        if (overlayAlpha > 0) {
          ctx.fillStyle = `rgba(${TRANSITION_OVERLAY_RGB},${overlayAlpha.toFixed(3)})`;
          ctx.fillRect(0, 0, cw, ch);
        }
        if (transitionDone(now - transitionStart, transitionKind)) {
          transitionStart = -1;
          transitionKind = "warp";
          transitionSwapped = true;
          transitionPending = null;
        }
      }

      // ミニマップ（プレイヤー中心の周辺図、約5Hz。ロビーでは出さない）
      if (space === "world" && showMapRef.current && now - lastMinimapAt > 200) {
        lastMinimapAt = now;
        const mm = minimapRef.current;
        const mctx = mm?.getContext("2d");
        if (mm && mctx) {
          const ox = Math.floor(player.x) - MINIMAP_TILES / 2;
          const oy = Math.floor(player.y) - MINIMAP_TILES / 2;
          const toMapX = (wx: number) => (wx - ox) * MINIMAP_SCALE;
          const toMapY = (wy: number) => (wy - oy) * MINIMAP_SCALE;
          paintLocalTerrain(miniTerrainCanvas, ox, oy, MINIMAP_TILES);
          mctx.clearRect(0, 0, mm.width, mm.height);
          mctx.imageSmoothingEnabled = false;
          mctx.drawImage(miniTerrainCanvas, 0, 0, mm.width, mm.height);
          mctx.imageSmoothingEnabled = true;
          // 首都（範囲内だけ）
          for (const n of nationsRef.current.nations) {
            const mx = toMapX(n.capital.x);
            const my = toMapY(n.capital.y);
            if (mx < -4 || my < -4 || mx > mm.width + 4 || my > mm.height + 4) continue;
            mctx.fillStyle = n.color;
            mctx.fillRect(mx - 1, my - 1, 3, 3);
          }
          mctx.fillStyle = "#ffffff";
          for (const o of others.values()) {
            mctx.fillRect(Math.floor(toMapX(o.track.rx)) - 1, Math.floor(toMapY(o.track.ry)) - 1, 2, 2);
          }
          mctx.fillStyle = "#ffd23e";
          mctx.strokeStyle = "rgba(0,0,0,0.6)";
          mctx.beginPath();
          mctx.arc(toMapX(player.x), toMapY(player.y), 2.6, 0, Math.PI * 2);
          mctx.fill();
          mctx.stroke();
          // 開拓のコンパス（所持時のみ）: 最寄り入口のマーカー/方向矢印と
          // HUD の矢印・距離。入口の位置は決定的生成から誰でも計算できる
          // 公開情報なので、所持判定だけ本人プロフィールで見る。
          if (invRef.current && countItem(invRef.current, "explorer_compass") > 0) {
            if (!compassCache || Math.hypot(player.x - compassCache.ax, player.y - compassCache.ay) >= 16) {
              const near = nearestEntrances(MAP_SEED, player.x, player.y);
              compassCache = { ax: player.x, ay: player.y, cave: near.cave, dungeon: near.dungeon };
            }
            drawCompassOnMinimap(mctx, compassCache.cave, COMPASS_CAVE_COLOR, ox, oy, player.x, player.y);
            drawCompassOnMinimap(mctx, compassCache.dungeon, COMPASS_DUNGEON_COLOR, ox, oy, player.x, player.y);
            updateCompassHud(compassCaveArrowRef.current, compassCaveDistRef.current, compassCache.cave, player.x, player.y);
            updateCompassHud(compassDungeonArrowRef.current, compassDungeonDistRef.current, compassCache.dungeon, player.x, player.y);
          }
        }
      }

      // マップ表示モード（プレイヤー中心の周辺図を大きく、約5Hz。ロビーでは出さない）
      if (space === "world" && mapViewRef.current && now - lastBigMapAt > 200) {
        lastBigMapAt = now;
        const bm = bigMapRef.current;
        const bctx = bm?.getContext("2d");
        if (bm && bctx) {
          const ox = Math.floor(player.x) - BIGMAP_TILES / 2;
          const oy = Math.floor(player.y) - BIGMAP_TILES / 2;
          const toMapX = (wx: number) => (wx - ox) * BIGMAP_SCALE;
          const toMapY = (wy: number) => (wy - oy) * BIGMAP_SCALE;
          paintLocalTerrain(bigTerrainCanvas, ox, oy, BIGMAP_TILES);
          bctx.clearRect(0, 0, bm.width, bm.height);
          bctx.imageSmoothingEnabled = false;
          bctx.drawImage(bigTerrainCanvas, 0, 0, bm.width, bm.height);
          bctx.imageSmoothingEnabled = true;
          // 首都（国の色の四角＋白枠）
          for (const n of nationsRef.current.nations) {
            const mx = toMapX(n.capital.x);
            const my = toMapY(n.capital.y);
            if (mx < -8 || my < -8 || mx > bm.width + 8 || my > bm.height + 8) continue;
            bctx.fillStyle = n.color;
            bctx.strokeStyle = "rgba(255,255,255,0.85)";
            bctx.fillRect(mx - 3, my - 3, 7, 7);
            bctx.strokeRect(mx - 3, my - 3, 7, 7);
          }
          // 自ユニオンのポーター（金色の菱形＋白枠。タップで移動できる）
          const porter = porterRef.current;
          if (porter) {
            const mx = toMapX(porter.x + 0.5);
            const my = toMapY(porter.y + 0.5);
            if (mx >= -8 && my >= -8 && mx <= bm.width + 8 && my <= bm.height + 8) {
              bctx.fillStyle = "#ffd23e";
              bctx.strokeStyle = "rgba(255,255,255,0.9)";
              bctx.beginPath();
              bctx.moveTo(mx, my - 6);
              bctx.lineTo(mx + 6, my);
              bctx.lineTo(mx, my + 6);
              bctx.lineTo(mx - 6, my);
              bctx.closePath();
              bctx.fill();
              bctx.stroke();
            }
          }
          // 他のプレイヤー
          bctx.fillStyle = "#ffffff";
          for (const o of others.values()) {
            bctx.beginPath();
            bctx.arc(toMapX(o.track.rx), toMapY(o.track.ry), 2.6, 0, Math.PI * 2);
            bctx.fill();
          }
          // 自分
          bctx.fillStyle = "#ffd23e";
          bctx.strokeStyle = "rgba(0,0,0,0.65)";
          bctx.beginPath();
          bctx.arc(toMapX(player.x), toMapY(player.y), 4.4, 0, Math.PI * 2);
          bctx.fill();
          bctx.stroke();
        }
      }
    };
    // 初回入場は暗転から明ける（初フレームのチラつきを消す）。
    transitionKind = "enter";
    transitionSwapped = true;
    transitionPending = null;
    transitionStart = performance.now();
    raf = requestAnimationFrame(loop);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      if (onlineSaveTimer !== null) window.clearTimeout(onlineSaveTimer);
      window.clearInterval(heartbeatTimer);
      window.clearInterval(pollTimer);
      if (rtReconnectTimer !== undefined) window.clearTimeout(rtReconnectTimer);
      try {
        rtSocket?.close();
      } catch { /* noop */ }
      rtSocket = null;
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pagehide", onPageHide);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      saveNow(true);
      leavePresence();
    };
    // ゲートを通過するまでは canvas が無く、ここは空振りする。通過後に起動する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateOk]);

  const btn: React.CSSProperties = {
    minHeight: hud.buttonMinHeight, padding: "6px 14px", borderRadius: 10, cursor: "pointer",
    border: "1px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.06)", color: "inherit",
    touchAction: "manipulation", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none",
  };

  /** パネルは全てゲームステージ内のオーバーレイにする（ページ側へはみ出さない）。 */
  const panelOverlay: React.CSSProperties = {
    position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
    width: "min(600px, calc(100% - 20px))", maxHeight: "calc(100% - 20px)", overflowY: "auto",
    overscrollBehavior: "contain", touchAction: "pan-y",
    padding: 12, borderRadius: 12, zIndex: 6, textAlign: "left",
    border: "1px solid rgba(255,255,255,0.22)", background: "rgba(10,12,18,0.93)", color: "#f2f2f2",
    boxShadow: "0 12px 36px rgba(0,0,0,0.5)",
  };
  /** パネル先頭の固定ヘッダー: パネル内をスクロールしても「閉じる」が
   * 見えなくならないよう、先頭行に重ねて常時表示する（panelOverlay 用）。 */
  const stickyPanelHead: React.CSSProperties = {
    position: "sticky", top: -12, zIndex: 3,
    margin: "-12px -12px 0", padding: "12px 12px 6px",
    background: "rgba(10,12,18,0.98)",
  };
  /** スロット枠（中身はスプライトのみ。SlotContent と対で使う）。
   *  サイズは --slot（ホットバー側で画面幅に合わせて決める）に従い、狭い画面では縮む。 */
  const slotBox: React.CSSProperties = {
    ...btn, position: "relative", boxSizing: "border-box",
    width: "var(--slot, 42px)", height: "var(--slot, 42px)", minHeight: "var(--slot, 42px)", padding: 2,
    display: "flex", alignItems: "center", justifyContent: "center",
    color: "#fff", background: "rgba(255,255,255,0.08)",
  };
  /** 開拓のコンパスの HUD の矢印（右向き三角。回転は描画ループが付ける）。 */
  const compassArrow = (color: string): React.CSSProperties => ({
    width: 9, height: 10, flexShrink: 0, background: color,
    clipPath: "polygon(0 0, 100% 50%, 0 100%)",
  });
  /** インベントリパネルの1枠（持ち上げ中は金枠）。 */
  const renderInvSlot = (zone: SlotRef["zone"], index: number, slot: ItemSlot) => {
    const held = heldSlot?.zone === zone && heldSlot?.index === index;
    return (
      <button
        key={`${zone}-${index}`}
        type="button"
        aria-label={slot ? (itemById(slot.id)?.name ?? slot.id) : "空き枠"}
        aria-pressed={held}
        onClick={() => tapSlot(zone, index)}
        style={{
          ...slotBox, width: "100%", height: 44,
          ...(held ? { background: "rgba(255,210,62,0.30)", borderColor: "rgba(255,210,62,0.85)" } : {}),
        }}
      >
        <SlotContent slot={slot} durFrac={slot && invProfile ? toolDurabilityFraction(invProfile, slot.id) : null} />
      </button>
    );
  };
  /** 持ち上げ中のスタック（パネル見出しの識別表示用）。 */
  const heldStack: ItemSlot = heldSlot && invProfile
    ? (heldSlot.zone === "hotbar" ? invProfile.hotbar[heldSlot.index] : invProfile.storage[heldSlot.index]) ?? null
    : null;
  /** コンテナパネルの1枠（コンテナ側・プロフィール側共通、持ち上げ中は金枠）。 */
  const renderPanelSlot = (side: ContainerSlotRef["side"], index: number, slot: ItemSlot) => {
    const held = heldPanelSlot?.side === side && heldPanelSlot?.index === index;
    return (
      <button
        key={`${side}-${index}`}
        type="button"
        aria-label={slot ? (itemById(slot.id)?.name ?? slot.id) : "空き枠"}
        aria-pressed={held}
        onClick={() => tapPanelSlot({ side, index })}
        style={{
          ...slotBox, width: "100%", height: 44,
          ...(held ? { background: "rgba(255,210,62,0.30)", borderColor: "rgba(255,210,62,0.85)" } : {}),
        }}
      >
        <SlotContent
          slot={slot}
          durFrac={slot && invProfile && side !== "container" ? toolDurabilityFraction(invProfile, slot.id) : null}
        />
      </button>
    );
  };
  /** コンテナパネルで持ち上げ中のスタック（見出しの識別表示用）。 */
  const heldPanelStack: ItemSlot = heldPanelSlot
    ? heldPanelSlot.side === "container"
      ? (containerSlots?.[heldPanelSlot.index] ?? null)
      : heldPanelSlot.side === "profile_hotbar"
        ? (invProfile?.hotbar[heldPanelSlot.index] ?? null)
        : (invProfile?.storage[heldPanelSlot.index] ?? null)
    : null;
  /** コンテナ側グリッドの表示枠（容量ぶん、未読込は空き枠）。 */
  const containerGridSlots: ItemSlot[] = containerPanel
    ? Array.from(
        { length: containerCapacity(containerPanel.itemId) },
        (_, i) => containerSlots?.[i] ?? null,
      )
    : [];
  const containerEmpty = containerPanel !== null
    && containerSlots !== null
    && containerSlots.every((s) => s === null);

  // ハンバーガーはアクションの集約場所。項目はデータ駆動のリストで持ち、
  // アクションの追加はここへ1件足すだけで済む。
  type MenuAction = { id: string; label: string; show: boolean; run: () => void };
  const menuActions: MenuAction[] = [
    {
      id: "warp",
      label: spaceUi === "world" ? "ロビーへ行く" : "ワールドへ戻る",
      show: true,
      run: () => warpActionRef.current(spaceUi === "world" ? "lobby" : "world"),
    },
    {
      id: "expand_tent",
      label: invProfile && invProfile.tentTier < TENT_MAX_TIER
        ? `テント拡張（${TENT_TIERS[invProfile.tentTier + 1].w}×${TENT_TIERS[invProfile.tentTier + 1].h} / ${TENT_TIERS[invProfile.tentTier + 1].price}）`
        : "テント拡張",
      show: spaceUi === "tent" && !!invProfile && invProfile.tentTier < TENT_MAX_TIER,
      run: () => { void expandTent(); },
    },
    {
      id: "event_dungeon",
      label: `${eventsUi.find((e) => e.kind === "limited_dungeon")?.name ?? "期間ダンジョン"}へ行く`,
      show: spaceUi === "world" && eventsUi.some((e) => e.kind === "limited_dungeon"),
      run: () => enterEventDungeon(),
    },
    {
      id: "travel",
      label: "国へ移動",
      show: nationsUi.me !== null,
      run: () => { void travelToNation(); },
    },
    {
      id: "map",
      label: showMap ? "マップを隠す" : "マップを出す",
      show: spaceUi === "world",
      run: () => setShowMap((v) => !v),
    },
    {
      id: "guild_shop",
      label: guildShopOpen ? "ギルドショップを閉じる" : "ギルドショップ",
      show: spaceUi === "lobby",
      run: () => setGuildShopOpen((v) => !v),
    },
    {
      id: "economy",
      label: showEconomy ? "経済を閉じる" : "経済",
      show: true,
      run: () => setShowEconomy((v) => !v),
    },
    {
      id: "mapview",
      label: mapView ? "マップを閉じる" : "マップを見る",
      show: spaceUi === "world",
      run: () => setMapView((v) => !v),
    },
    { id: "close", label: "閉じる", show: true, run: () => {} },
  ];

  // 入場ゲート: Discord ログインが確認できるまではワールドを描画しない。
  // ゲートも独立シェル（100svh・中央寄せ）で完結させる。
  if (!gateOk) {
    return (
      <div
        className="wb-shell"
        style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 14, padding: 20, boxSizing: "border-box", textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: 28, margin: 0 }}>AGO WORLD BOX</h1>
        {gate === "checking" || (gate === "ok" && !booted) ? (
          <p role="status" style={{ margin: 0 }}>
            読み込み中…
          </p>
        ) : (
          <>
            <p role="status" style={{ margin: 0 }}>
              ログインが必要
            </p>
            {embedded ? (
              // Activity 内では通常の OAuth 画面遷移が使えない（押すと白画面で
              // 詰まる）。認証は GamesShell の SDK 認証が担うので、ここは
              // ゲートの引き直しだけを置く。
              <button
                type="button"
                onClick={() => {
                  // ゲートの引き直しだけでは、本人情報そのものが届いて
                  // いない場合は永久に通らない。本人確認も一緒にやり直す。
                  retryIdentity?.();
                  setGateTry((t) => t + 1);
                }}
                style={{
                  ...btn, display: "inline-flex", alignItems: "center",
                }}
              >
                再試行
              </button>
            ) : (
              <a
                href="/api/auth/discord/authorize?next=/games/worldbox"
                style={{
                  ...btn, textDecoration: "none", display: "inline-flex", alignItems: "center",
                }}
              >
                Discordでログイン
              </a>
            )}
            <Link href={`${prefix}/games`} style={{ color: "#9fd8e8", fontSize: 13 }}>
              ゲーム一覧へ
            </Link>
          </>
        )}
      </div>
    );
  }

  return (
    <div
      className="wb-shell"
      onContextMenu={(e) => e.preventDefault()}
      onClickCapture={(e) => {
        // UI クリック SE の一本化: シェル内のボタン押下はここで click を鳴らす。
        // 固有の SE を持つ領域（≡メニュー・経済/カジノ/アーケードのパネル）は
        // data-wb-se="self" で除外し、二重に鳴らさない。
        const t = e.target as HTMLElement | null;
        if (!t || typeof t.closest !== "function") return;
        if (!t.closest("button")) return;
        if (t.closest("[data-wb-se='self']")) return;
        playWbSe("click");
      }}
      style={{
        display: "flex", flexDirection: "column",
        WebkitTouchCallout: "none",
        WebkitUserSelect: "none",
        MozUserSelect: "none",
        msUserSelect: "none",
        userSelect: "none",
      }}
    >
      <div
        ref={stageRef}
        style={{
          position: "relative", touchAction: "none",
          width: "100%", flex: "1 1 auto", minHeight: 0,
          ...(isFullscreen ? { height: "100%", background: "#0b0e14" } : {}),
        }}
      >
        <canvas
          ref={canvasRef}
          onContextMenu={(e) => e.preventDefault()}
          aria-label="AGO WORLD BOX の見下ろしマップ。スティックか WASD で歩けます"
          style={{
            width: "100%", height: "100%", display: "block",
            touchAction: "none", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none", WebkitTapHighlightColor: "transparent",
          }}
        />
        <div
          role="status"
          style={{
            position: "absolute", top: "calc(10px + env(safe-area-inset-top, 0px))", left: "50%", transform: "translateX(-50%)",
            padding: "4px 12px", borderRadius: 10, background: "rgba(0,0,0,0.55)", color: "#fff",
            fontSize: 12, lineHeight: 1.5, whiteSpace: "nowrap", pointerEvents: "none", zIndex: 4,
            maxWidth: "calc(100% - 176px)", boxSizing: "border-box",
            overflow: "hidden", textOverflow: "ellipsis",
          }}
        >
          {statusText}
          {othersCount > 0 ? ` ・ いま ${othersCount} 人が歩いている` : ""}
          {` ・ 座標 X ${coords.x} / Y ${coords.y}`}
        </div>
        <button
          type="button"
          aria-label="メニュー"
          aria-expanded={menuOpen}
          data-wb-se="self"
          onClick={() => { playWbSe(menuOpen ? "close" : "open"); setMenuOpen((v) => !v); }}
          style={{
            ...btn, position: "absolute", left: "calc(10px + env(safe-area-inset-left, 0px))", top: "calc(10px + env(safe-area-inset-top, 0px))", minHeight: hud.buttonMinHeight, minWidth: 44, zIndex: 7,
            padding: "4px 10px", fontSize: 18, lineHeight: 1, background: "rgba(0,0,0,0.55)", color: "#fff",
          }}
        >
          ≡
        </button>
        {canFullscreen && (
          <button
            type="button"
            aria-label={isFullscreen ? "全画面を終わる" : "全画面にする"}
            aria-pressed={isFullscreen}
            onClick={toggleFullscreen}
            style={{
              ...btn, position: "absolute", right: "calc(10px + env(safe-area-inset-right, 0px))", top: "calc(10px + env(safe-area-inset-top, 0px))", minHeight: hud.buttonMinHeight, zIndex: 5,
              padding: "4px 12px", fontSize: 12, lineHeight: 1, background: "rgba(0,0,0,0.55)", color: "#fff",
            }}
          >
            {isFullscreen ? "戻す" : "全画面"}
          </button>
        )}
        {menuOpen && (
          <div
            data-wb-se="self"
            style={{
              position: "absolute", left: "calc(10px + env(safe-area-inset-left, 0px))", top: "calc(58px + env(safe-area-inset-top, 0px))", display: "grid", gap: 6, padding: 8,
              borderRadius: 10, background: "rgba(0,0,0,0.72)", color: "#fff", zIndex: 8,
              // 項目が増えてもステージ下端からはみ出さない（収まらない分はメニュー内スクロール）
              maxHeight: "calc(100% - 68px)", maxWidth: "calc(100% - 20px)", boxSizing: "border-box",
              overflowY: "auto", overscrollBehavior: "contain", touchAction: "pan-y",
            }}
          >
            {menuActions
              .filter((a) => a.show)
              .map((a) => (
                <button
                  key={a.id}
                  type="button"
                  style={{ ...btn, background: "rgba(255,255,255,0.10)", color: "#fff" }}
                  onClick={() => {
                    playWbSe("click");
                    a.run();
                    setMenuOpen(false);
                  }}
                >
                  {a.label}
                </button>
              ))}
            <button
              type="button"
              style={{ ...btn, background: "rgba(255,255,255,0.10)", color: "#fff" }}
              aria-expanded={settingsOpen}
              onClick={() => { playWbSe("click"); setSettingsOpen((v) => !v); }}
            >
              設定
            </button>
            {settingsOpen && (
              <div style={{ display: "grid", gap: 6, paddingLeft: 14 }}>
                <button
                  type="button"
                  style={{ ...btn, background: "rgba(255,255,255,0.10)", color: "#fff" }}
                  onClick={() => toggleSound("bgm")}
                >
                  {soundSettings.bgm ? "BGMを切る" : "BGMを入れる"}
                </button>
                <button
                  type="button"
                  style={{ ...btn, background: "rgba(255,255,255,0.10)", color: "#fff" }}
                  onClick={() => toggleSound("se")}
                >
                  {soundSettings.se ? "効果音を切る" : "効果音を入れる"}
                </button>
                <button
                  type="button"
                  style={{ ...btn, background: "rgba(255,255,255,0.10)", color: "#fff" }}
                  onClick={() => { playWbSe("click"); setReportOpen(true); setMenuOpen(false); }}
                >
                  通報する
                </button>
              </div>
            )}
            <div style={{ borderTop: "1px solid rgba(255,255,255,0.18)", paddingTop: 6 }}>
              <div style={{ fontSize: 12, display: "flex", gap: 6 }}>
                <span style={{ flex: 1 }}>{SEASON_NAMES[seasonOf(Date.now())]}</span>
                <span style={{ opacity: 0.75 }}>あと{seasonDaysLeft(Date.now())}日</span>
              </div>
            </div>
            {eventsUi.length > 0 && (
              <div style={{ borderTop: "1px solid rgba(255,255,255,0.18)", paddingTop: 6 }}>
                {eventsUi.map((e) => (
                  <div key={e.id} style={{ fontSize: 12, display: "flex", gap: 6 }}>
                    <span style={{ flex: 1 }}>{e.name}</span>
                    <span style={{ opacity: 0.75 }}>あと{e.daysLeft}日</span>
                  </div>
                ))}
              </div>
            )}
            {invProfile && (
              <div style={{ borderTop: "1px solid rgba(255,255,255,0.18)", paddingTop: 6 }}>
                <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 4 }}>コレクション</div>
                <ItemSlotGrid>
                  {["ancient_relic", "star_map", "ancient_coin", "dragon_scale", "ghost_tear", "golden_key"].map((id) => {
                    const count = invProfile.items[id] ?? 0;
                    return (
                      <span key={id} style={{ opacity: count > 0 ? 1 : 0.38, display: "inline-flex" }}>
                        <ItemSlotView
                          itemId={id}
                          count={count}
                          selected={collectionSel === id}
                          onClick={() => setCollectionSel(id)}
                        />
                      </span>
                    );
                  })}
                </ItemSlotGrid>
                {collectionSel && (
                  <div style={{ fontSize: 12, marginTop: 6 }}>
                    {itemById(collectionSel)?.name ?? collectionSel} ×{invProfile.items[collectionSel] ?? 0}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {spaceUi !== "world" && stationUi && (
          <div
            key={stationUi}
            style={{
              position: "absolute", left: "50%", bottom: "calc(10px + env(safe-area-inset-bottom, 0px))", transform: "translateX(-50%)",
              display: "flex", gap: 8, alignItems: "center", padding: "6px 8px 6px 14px",
              borderRadius: 10, background: "rgba(0,0,0,0.6)", color: "#fff", fontSize: 13, whiteSpace: "nowrap",
              animation: "wb-chip-pop 240ms ease-out",
            }}
          >
            <span>{stationUi === "shop" && stationGenre ? (genreById(stationGenre)?.name ?? STATION_LABEL[stationUi]) : stationUi === "arcade" && stationArcade ? (getWebGame(stationArcade)?.title ?? STATION_LABEL[stationUi]) : STATION_LABEL[stationUi]}</span>
            {stationUi === "board" && (
              <button
                type="button"
                style={{ ...btn, minHeight: hud.buttonMinHeight, padding: "2px 10px" }}
                onClick={() => setBoardOpen((v) => !v)}
              >
                {boardOpen ? "閉じる" : "開く"}
              </button>
            )}
            {stationUi === "casino" && (
              <button
                type="button"
                style={{ ...btn, minHeight: hud.buttonMinHeight, padding: "2px 10px" }}
                onClick={() => setCasinoOpen((v) => !v)}
              >
                {casinoOpen ? "閉じる" : "遊ぶ"}
              </button>
            )}
            {stationUi === "arcade" && (
              <button
                type="button"
                style={{ ...btn, minHeight: hud.buttonMinHeight, padding: "2px 10px" }}
                onClick={() => setArcadeOpen((v) => !v)}
              >
                {arcadeOpen ? "閉じる" : "遊ぶ"}
              </button>
            )}
            {stationUi === "guild" && (
              <button
                type="button"
                style={{ ...btn, minHeight: hud.buttonMinHeight, padding: "2px 10px" }}
                onClick={() => setGuildBoardOpen((v) => !v)}
              >
                {guildBoardOpen ? "閉じる" : "開く"}
              </button>
            )}
            {(stationUi === "shop" || stationUi === "bank" || stationUi === "smith" || stationUi === "sell") && (
              <button
                type="button"
                style={{ ...btn, minHeight: hud.buttonMinHeight, padding: "2px 10px" }}
                onClick={() => setShowEconomy(true)}
              >
                開く
              </button>
            )}
            {stationUi === "arena" && (
              <button
                type="button"
                style={{ ...btn, minHeight: hud.buttonMinHeight, padding: "2px 10px" }}
                onClick={() => setArenaOpen((v) => !v)}
              >
                {arenaOpen ? "閉じる" : "戦う"}
              </button>
            )}
            {stationUi === "telescope" && (
              <button
                type="button"
                style={{ ...btn, minHeight: hud.buttonMinHeight, padding: "2px 10px" }}
                onClick={() => setTelescopeOpen((v) => !v)}
              >
                {telescopeOpen ? "閉じる" : "覗く"}
              </button>
            )}
            {stationUi === "race" && (
              <button
                type="button"
                style={{ ...btn, minHeight: hud.buttonMinHeight, padding: "2px 10px" }}
                onClick={() => setRacingOpen((v) => !v)}
              >
                {racingOpen ? "閉じる" : "馬券"}
              </button>
            )}
            {stationUi === "fountain" && (
              <button
                type="button"
                style={{ ...btn, minHeight: hud.buttonMinHeight, padding: "2px 10px" }}
                onClick={() => void plazaAction("fountain")}
              >
                コインを投げる（10）
              </button>
            )}
            {stationUi === "rest" && (
              <button
                type="button"
                style={{ ...btn, minHeight: hud.buttonMinHeight, padding: "2px 10px" }}
                onClick={() => void plazaAction("rest")}
              >
                休む
              </button>
            )}
            {plazaMsg && <span role="status">{plazaMsg}</span>}
          </div>
        )}
        {showMap && spaceUi === "world" && (
          <canvas
            ref={minimapRef}
            width={MINIMAP_PX}
            height={MINIMAP_PX}
            aria-label="周辺マップ"
            style={{
              position: "absolute", right: "calc(10px + env(safe-area-inset-right, 0px))", top: "calc(10px + env(safe-area-inset-top, 0px))", width: hud.minimapPx, height: hud.minimapPx,
              borderRadius: 10, border: "1px solid rgba(255,255,255,0.35)",
              background: "rgba(0,0,0,0.25)", pointerEvents: "none",
            }}
          />
        )}
        {showMap && spaceUi === "world" && hasCompass && (
          <div
            aria-label="開拓のコンパス"
            style={{
              position: "absolute", right: "calc(10px + env(safe-area-inset-right, 0px))", top: `calc(${hud.minimapPx + 16}px + env(safe-area-inset-top, 0px))`, width: hud.minimapPx, boxSizing: "border-box",
              display: "flex", flexDirection: "column", gap: 3,
              padding: "5px 8px", borderRadius: 10, background: "rgba(0,0,0,0.6)",
              border: "1px solid rgba(255,255,255,0.25)", pointerEvents: "none", zIndex: 4,
              color: "#fff", fontSize: 11,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span ref={compassCaveArrowRef} style={compassArrow(COMPASS_CAVE_COLOR)} />
              <span>洞窟</span>
              <span ref={compassCaveDistRef} style={{ marginLeft: "auto" }} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span ref={compassDungeonArrowRef} style={compassArrow(COMPASS_DUNGEON_COLOR)} />
              <span>ダンジョン</span>
              <span ref={compassDungeonDistRef} style={{ marginLeft: "auto" }} />
            </div>
          </div>
        )}
        {invProfile && (
          <div
            aria-label="HPと空腹度"
            style={{
              position: "absolute", left: "calc(10px + env(safe-area-inset-left, 0px))", top: "calc(52px + env(safe-area-inset-top, 0px))", display: "flex", flexDirection: "column", gap: 4,
              padding: "6px 8px", borderRadius: 10, background: "rgba(0,0,0,0.6)", zIndex: 4,
              pointerEvents: "none", minWidth: 132,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "#ff8a7a", fontSize: 11, width: 28 }}>HP</span>
              <span style={{ flex: 1, height: 8, borderRadius: 4, background: "rgba(255,255,255,0.18)", overflow: "hidden" }}>
                <span style={{ display: "block", width: `${Math.max(0, Math.min(100, (invProfile.hp / maxHpFor(invProfile)) * 100))}%`, height: "100%", background: invProfile.hp <= 25 ? "#e2483a" : "#7ed957" }} />
              </span>
              <strong style={{ color: "#fff", fontSize: 11 }}>{Math.floor(invProfile.hp)}</strong>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "#ffd23e", fontSize: 11, width: 28 }}>空腹</span>
              <span style={{ flex: 1, height: 8, borderRadius: 4, background: "rgba(255,255,255,0.18)", overflow: "hidden" }}>
                <span style={{ display: "block", width: `${Math.max(0, Math.min(100, (invProfile.hunger / HUNGER_MAX) * 100))}%`, height: "100%", background: invProfile.hunger <= 20 ? "#ff7a59" : "#ffd23e" }} />
              </span>
              <strong style={{ color: "#fff", fontSize: 11 }}>{Math.floor(invProfile.hunger)}</strong>
            </div>
            {invProfile.status.some((e) => e.kind === "poison") && (
              <span style={{ color: "#b6f26d", fontSize: 11 }}>毒</span>
            )}
            {invProfile.status
              .filter((e) => (e.kind === "warm" || e.kind === "alert") && e.until > gaugeNow)
              .map((e) => (
                <span key={e.kind} style={{ color: e.kind === "warm" ? "#ffb37a" : "#9adfff", fontSize: 11 }}>
                  {e.kind === "warm" ? "温かい食事" : "自然回復"} あと{Math.max(1, Math.ceil((e.until - gaugeNow) / 60000))}分
                </span>
              ))}
            {invProfile.role !== "free" && (() => {
              const role = roleById(invProfile.role);
              return (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    aria-label={role.name}
                    style={{
                      position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center",
                      width: 22, height: 22, borderRadius: 6, fontSize: 12, fontWeight: 700, overflow: "hidden",
                      border: "1px solid rgba(255,255,255,0.4)", background: "rgba(255,255,255,0.1)",
                    }}
                  >
                    <span style={{ position: "relative" }}>{role.symbol}</span>
                  </span>
                  <span style={{ color: "#fff", fontSize: 11, letterSpacing: 2 }}>
                    {"●".repeat(masteryRankOf(invProfile, invProfile.role))}
                    <span style={{ opacity: 0.3 }}>{"●".repeat(5 - masteryRankOf(invProfile, invProfile.role))}</span>
                  </span>
                </div>
              );
            })()}
          </div>
        )}
        {invProfile && gaugeSkill && (() => {
          // 左隅の技チャージゲージ: 円の金リングが回復した分だけ満ち、
          // 満タン（発動可能）で光る。クールタイム表示はここに一本化する。
          const role = roleById(invProfile.role);
          const total = SKILLS[gaugeSkill.id].cooldownMs;
          const left = skillCooldownLeft(invProfile, gaugeSkill.id, gaugeNow);
          const charged = total > 0 ? Math.max(0, Math.min(1, 1 - left / total)) : 1;
          const ready = left <= 0;
          return (
            <div
              aria-label={ready ? "技が使える" : "技チャージ中"}
              style={{ position: "absolute", left: "calc(10px + env(safe-area-inset-left, 0px))", top: "calc(168px + env(safe-area-inset-top, 0px))", width: 54, height: 54, zIndex: 4, pointerEvents: "none" }}
            >
              <div
                aria-hidden
                style={{
                  position: "absolute", inset: 0, borderRadius: "50%",
                  background: `conic-gradient(#ffd23e ${charged * 360}deg, rgba(255,255,255,0.16) ${charged * 360}deg)`,
                  boxShadow: ready ? "0 0 14px rgba(255,210,62,0.85)" : "0 0 4px rgba(0,0,0,0.5)",
                }}
              />
              <div
                style={{
                  position: "absolute", inset: 5, borderRadius: "50%", background: "rgba(0,0,0,0.74)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: ready ? "#ffd23e" : "#ffffff", fontSize: 17, fontWeight: 700,
                }}
              >
                {role.symbol}
              </div>
            </div>
          );
        })()}
        {spaceUi === "world" && invProfile && (
          <div
            style={{
              position: "absolute", left: "50%", bottom: "calc(10px + env(safe-area-inset-bottom, 0px))", transform: "translateX(-50%)",
              display: "flex", gap: 4, alignItems: "stretch", padding: 4, borderRadius: 10,
              background: "rgba(0,0,0,0.6)", zIndex: 4, maxWidth: "calc(100% - 16px)",
              boxSizing: "border-box",
              // スロットは画面幅でスケーリングする（縦画面ではみ出さない）
              ...({ "--slot": hud.hotbarSlotCss } as React.CSSProperties),
            }}
          >
            {invProfile.hotbar.map((slot, i) => (
              <button
                key={i}
                type="button"
                aria-pressed={selSlot === i}
                aria-label={slot ? (itemById(slot.id)?.name ?? slot.id) : "空き枠"}
                onClick={() => setSelSlot(i)}
                style={{
                  ...slotBox,
                  ...(selSlot === i
                    ? { background: "rgba(255,210,62,0.30)", borderColor: "rgba(255,210,62,0.85)" }
                    : {}),
                }}
              >
                <SlotContent slot={slot} durFrac={slot ? toolDurabilityFraction(invProfile, slot.id) : null} />
              </button>
            ))}
            <button
              type="button"
              style={{
                ...btn, boxSizing: "border-box", flexShrink: 0, whiteSpace: "nowrap",
                height: "var(--slot, 42px)", minHeight: "var(--slot, 42px)",
                padding: "2px 8px", fontSize: 11, color: "#fff", background: "rgba(255,255,255,0.08)",
              }}
              onClick={() => setStorageOpen((v) => !v)}
              aria-expanded={storageOpen}
            >
              インベントリ
            </button>
          </div>
        )}
        {partyUi.invite && (
          <div
            style={{
              position: "absolute", top: "calc(64px + env(safe-area-inset-top, 0px))", left: "50%", transform: "translateX(-50%)",
              display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
              borderRadius: 10, background: "rgba(10,12,24,0.88)", color: "#fff", fontSize: 13, zIndex: 5,
            }}
          >
            <span>{partyUi.invite.leaderName} のパーティ</span>
            <button
              type="button"
              style={btn}
              onClick={() => { void postParty("accept", { partyId: partyUi.invite?.partyId }); }}
            >
              参加
            </button>
            <button
              type="button"
              style={btn}
              onClick={() => { void postParty("decline", { partyId: partyUi.invite?.partyId }); }}
            >
              断る
            </button>
          </div>
        )}
        {spaceUi === "world" && nearDungeonEntrance && (
          <div
            style={{
              position: "absolute", right: "calc(10px + env(safe-area-inset-right, 0px))", bottom: `calc(${hud.partyCardBottomPx}px + env(safe-area-inset-bottom, 0px))`, width: 168,
              padding: "8px 10px", borderRadius: 10, background: "rgba(10,12,24,0.88)",
              color: "#fff", fontSize: 12, zIndex: 5, display: "flex", flexDirection: "column", gap: 6,
            }}
          >
            {partyUi.party ? (
              <>
                {partyUi.party.members.map((m, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span aria-hidden style={{ fontSize: 14 }}>{roleById(m.role).symbol}</span>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                    <span aria-hidden style={{ color: "#f2c53c", fontSize: 9, letterSpacing: 1 }}>{"●".repeat(m.rank)}</span>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    style={{ ...btn, flex: 1 }}
                    onClick={() => {
                      if (partyUi.party) enterDungeonRef.current?.(partyUi.party.entrance.x, partyUi.party.entrance.y);
                    }}
                  >
                    入場
                  </button>
                  <button type="button" style={btn} onClick={() => { void postParty("leave"); }}>
                    {partyUi.isLeader ? "解散" : "離脱"}
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                style={btn}
                onClick={() => { void postParty("create"); }}
              >
                パーティ編成
              </button>
            )}
          </div>
        )}
        {parseInstanceSpace(spaceUi)?.kind === "dungeon" && partyUi.party && (
          <div
            style={{
              position: "absolute", top: "calc(64px + env(safe-area-inset-top, 0px))", right: "calc(10px + env(safe-area-inset-right, 0px))", display: "flex", gap: 4,
              padding: "4px 6px", borderRadius: 8, background: "rgba(10,12,24,0.7)", zIndex: 5,
            }}
          >
            {partyUi.party.members.map((m, i) => (
              <span key={i} title={m.name} aria-hidden style={{ fontSize: 15, color: "#fff" }}>{roleById(m.role).symbol}</span>
            ))}
          </div>
        )}
        {playerCard && (
          <div
            style={{
              position: "absolute", left: "50%", bottom: `calc(${hud.playerCardBottomPx}px + env(safe-area-inset-bottom, 0px))`, transform: "translateX(-50%)",
              display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
              borderRadius: 10, background: "rgba(10,12,24,0.9)", color: "#fff", fontSize: 13, zIndex: 5,
              maxWidth: "calc(100% - 16px)", boxSizing: "border-box",
            }}
          >
            <span aria-hidden style={{ color: "#ffd75e", fontSize: 15 }}>{roleById(playerCard.role).symbol}</span>
            <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{playerCard.name}</strong>
            <span aria-hidden style={{ color: "#f2c53c", fontSize: 9, letterSpacing: 1 }}>{"●".repeat(playerCard.rank)}</span>
            <span style={{ fontSize: 12, opacity: 0.8 }}>{roleById(playerCard.role).name}</span>
            {partyUi.isLeader && partyUi.party && (
              <button
                type="button"
                style={btn}
                onClick={() => {
                  void postParty("invite", { targetId: playerCard.id }).then((r) => {
                    setTileMsg(r.ok ? "招待した" : "招待できない");
                  });
                  setPlayerCard(null);
                }}
              >
                招待
              </button>
            )}
            <button type="button" style={btn} onClick={() => setPlayerCard(null)}>
              閉じる
            </button>
          </div>
        )}
        <div
          style={{
            position: "absolute", zIndex: 5, flexDirection: "column", gap: 4,
            // スマホでは左下のスティック基点を避けて右下ドック（ホットバーの上）に逃がす。
            // パーティカードが出ている間は同じドックを譲る（同時表示を減らす）。
            display: hud.chatOnRight && nearDungeonEntrance ? "none" : "flex",
            ...(hud.chatOnRight
              ? { right: "calc(10px + env(safe-area-inset-right, 0px))", bottom: `calc(${hud.chatBottomPx}px + env(safe-area-inset-bottom, 0px))`, width: hud.chatWidthCss }
              : { left: "calc(10px + env(safe-area-inset-left, 0px))", bottom: `calc(${hud.chatBottomPx}px + env(safe-area-inset-bottom, 0px))`, width: hud.chatWidthCss }),
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: hud.chatMessagesPx, overflow: "hidden", justifyContent: "flex-end" }}>
            {[...chatMsgs].slice(0, 6).reverse().map((m, i) => (
              <div
                key={`${m.at}-${i}`}
                style={{
                  alignSelf: "flex-start", maxWidth: "100%", padding: "2px 8px", borderRadius: 8,
                  background: "rgba(8,10,16,0.55)", color: "#fff", fontSize: 12, lineHeight: 1.35,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}
              >
                <strong style={{ marginRight: 5 }}>{m.name}</strong>
                {m.source === "discord" && (
                  <span style={{ marginRight: 5, fontSize: 9, padding: "0 4px", borderRadius: 5, border: "1px solid rgba(255,255,255,0.4)" }}>
                    Discord
                  </span>
                )}
                {m.text}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            {(
              [
                ["proximity", "近"],
                ["global", "全"],
                ["union", "ユ"],
              ] as const
            ).map(([ch, label]) => (
              <button
                key={ch}
                type="button"
                aria-pressed={chatChannel === ch}
                onClick={() => setChatChannel(ch)}
                style={{
                  ...btn, minHeight: hud.chatOnRight ? 36 : 30, padding: "2px 8px", fontSize: 12,
                  ...(chatChannel === ch ? { background: "rgba(255,215,94,0.25)", borderColor: "#ffd75e" } : {}),
                }}
              >
                {label}
              </button>
            ))}
            <input
              value={chatText}
              onChange={(e) => setChatText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void sendChat();
                }
                e.stopPropagation();
              }}
              maxLength={120}
              placeholder="チャット"
              style={{
                flex: 1, minWidth: 0, padding: "6px 8px", borderRadius: 8, fontSize: 13,
                border: "1px solid rgba(255,255,255,0.25)", background: "rgba(8,10,16,0.7)", color: "#fff",
              }}
            />
          </div>
        </div>
        {tabTaken && (
          <div
            role="alert"
            style={{
              position: "absolute", left: "50%", bottom: "calc(58px + env(safe-area-inset-bottom, 0px))", transform: "translateX(-50%)",
              padding: "6px 14px", borderRadius: 10, background: "rgba(120,20,20,0.85)",
              color: "#fff", fontSize: 13, whiteSpace: "nowrap", zIndex: 5,
              maxWidth: "calc(100% - 16px)", boxSizing: "border-box", overflow: "hidden", textOverflow: "ellipsis",
            }}
          >
            別のタブで開いています（このタブは無効）
          </div>
        )}
        {tileMsg && (
          <div
            key={denyStamp}
            role="status"
            style={{
              position: "absolute", left: "50%", bottom: "calc(58px + env(safe-area-inset-bottom, 0px))", transform: "translateX(-50%)",
              padding: "4px 12px", borderRadius: 10, background: "rgba(0,0,0,0.6)",
              color: "#fff", fontSize: 13, whiteSpace: "nowrap", zIndex: 4,
              maxWidth: "calc(100% - 16px)", boxSizing: "border-box", overflow: "hidden", textOverflow: "ellipsis",
              animation: denyStamp > 0 ? "wb-deny-shake 260ms ease-out" : undefined,
            }}
          >
            {tileMsg}
          </div>
        )}
      {storageOpen && invProfile && (
        <div className="wb-panel" style={{ ...panelOverlay, width: "min(330px, calc(100% - 20px))" }}>
          <div style={{ ...stickyPanelHead, display: "flex", alignItems: "center", gap: 8 }}>
            <strong>インベントリ</strong>
            {heldStack && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <ItemIcon id={heldStack.id} size={18} />
                {itemById(heldStack.id)?.name ?? heldStack.id}
              </span>
            )}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              style={btn}
              onClick={() => {
                setStorageOpen(false);
                setHeldSlot(null);
              }}
            >
              閉じる
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 4, marginTop: 8 }}>
            {invProfile.storage.map((slot, i) => renderInvSlot("storage", i, slot))}
          </div>
          <div
            style={{
              display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 4,
              marginTop: 6, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,0.18)",
            }}
          >
            {invProfile.hotbar.map((slot, i) => renderInvSlot("hotbar", i, slot))}
          </div>
        </div>
      )}

      {containerPanel && invProfile && (
        <div className="wb-panel" style={{ ...panelOverlay, width: "min(330px, calc(100% - 20px))" }}>
          <div style={{ ...stickyPanelHead, display: "flex", alignItems: "center", gap: 8 }}>
            <strong>{itemById(containerPanel.itemId)?.name ?? "収納"}</strong>
            {heldPanelStack && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <ItemIcon id={heldPanelStack.id} size={18} />
                {itemById(heldPanelStack.id)?.name ?? heldPanelStack.id}
              </span>
            )}
            <span style={{ flex: 1 }} />
            <button
              type="button"
              style={btn}
              onClick={() => {
                setContainerPanel(null);
                setHeldPanelSlot(null);
              }}
            >
              閉じる
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 4, marginTop: 8 }}>
            {containerGridSlots.map((slot, i) => renderPanelSlot("container", i, slot))}
          </div>
          <div
            style={{
              display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 4,
              marginTop: 6, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,0.18)",
            }}
          >
            {invProfile.storage.map((slot, i) => renderPanelSlot("profile_storage", i, slot))}
          </div>
          <div
            style={{
              display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 4,
              marginTop: 6, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,0.18)",
            }}
          >
            {invProfile.hotbar.map((slot, i) => renderPanelSlot("profile_hotbar", i, slot))}
          </div>
          {containerEmpty && (
            <div style={{ marginTop: 8, display: "flex" }}>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                style={btn}
                onClick={() => {
                  const p = containerPanel;
                  setContainerPanel(null);
                  setHeldPanelSlot(null);
                  void postTileAction("mine_block", p.x, p.y);
                }}
              >
                回収
              </button>
            </div>
          )}
        </div>
      )}

      {stallPanel && (
        <div style={panelOverlay} className="wb-panel">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <strong>屋台</strong>
            <span style={{ flex: 1 }} />
            <button type="button" style={btn} onClick={() => setStallPanel(null)}>
              閉じる
            </button>
          </div>
          {stallInfo === undefined ? (
            <div style={{ marginTop: 10, fontSize: 13 }}>…</div>
          ) : stallInfo ? (
            <div style={{ marginTop: 10, fontSize: 13 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <ItemIcon id={stallInfo.itemId} size={20} />
                <span>{stallInfo.name}</span>
                <span>{stallInfo.price} コイン × {stallInfo.count}</span>
              </div>
              <div style={{ marginTop: 10 }}>
                {stallInfo.mine ? (
                  <button
                    type="button"
                    style={btn}
                    onClick={() => void postStallAction("unlist", stallPanel.x, stallPanel.y)}
                  >
                    取り下げる
                  </button>
                ) : (
                  <button
                    type="button"
                    style={btn}
                    onClick={() => void postStallAction("buy", stallPanel.x, stallPanel.y)}
                  >
                    買う
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 10, fontSize: 13 }}>
              {!stallPanel.mine ? (
                <span>出品なし</span>
              ) : stallPanel.selItemId ? (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <ItemIcon id={stallPanel.selItemId} size={20} />
                    <span>{itemById(stallPanel.selItemId)?.name ?? stallPanel.selItemId}</span>
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
                    <input
                      value={stallPriceText}
                      inputMode="numeric"
                      onChange={(e) => setStallPriceText(e.target.value)}
                      style={{
                        width: 80, padding: "6px 8px", borderRadius: 8, fontSize: 13,
                        border: "1px solid rgba(255,255,255,0.25)", background: "rgba(8,10,16,0.7)", color: "#fff",
                      }}
                    />
                    <span>コイン ×</span>
                    <input
                      value={stallCountText}
                      inputMode="numeric"
                      onChange={(e) => setStallCountText(e.target.value)}
                      style={{
                        width: 52, padding: "6px 8px", borderRadius: 8, fontSize: 13,
                        border: "1px solid rgba(255,255,255,0.25)", background: "rgba(8,10,16,0.7)", color: "#fff",
                      }}
                    />
                    <button
                      type="button"
                      style={btn}
                      onClick={() => void postStallAction("list_item", stallPanel.x, stallPanel.y, {
                        itemId: stallPanel.selItemId ?? undefined,
                        price: Number(stallPriceText),
                        count: Number(stallCountText),
                      })}
                    >
                      出す
                    </button>
                  </div>
                </>
              ) : (
                <span>かばんの品を選んでから開くと出品できます</span>
              )}
            </div>
          )}
        </div>
      )}
      {signEdit && (
        <div style={panelOverlay} className="wb-panel">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <strong>看板</strong>
            <span style={{ flex: 1 }} />
            <button type="button" style={btn} onClick={() => setSignEdit(null)}>
              閉じる
            </button>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
            <input
              value={signEdit.text}
              maxLength={40}
              onChange={(e) => setSignEdit({ ...signEdit, text: e.target.value })}
              style={{
                flex: 1, minWidth: 0, padding: "6px 8px", borderRadius: 8, fontSize: 13,
                border: "1px solid rgba(255,255,255,0.25)", background: "rgba(8,10,16,0.7)", color: "#fff",
              }}
            />
            <button
              type="button"
              style={btn}
              onClick={() => {
                void postTileAction("set_sign", signEdit.x, signEdit.y, undefined, undefined, signEdit.text);
                setSignEdit(null);
              }}
            >
              書く
            </button>
          </div>
        </div>
      )}
      {seedPicker && invProfile && (
        <div style={panelOverlay} className="wb-panel">
          <div style={{ ...stickyPanelHead, display: "flex", alignItems: "center", gap: 10 }}>
            <strong>種</strong>
            <span style={{ flex: 1 }} />
            <button type="button" style={btn} onClick={() => setSeedPicker(null)}>
              閉じる
            </button>
          </div>
          <div style={{ marginTop: 10 }}>
            <ItemSlotGrid>
              {CROPS.filter((c) => countItem(invProfile, c.seedId) > 0).map((c) => (
                <ItemSlotView
                  key={c.id}
                  itemId={c.seedId}
                  count={countItem(invProfile, c.seedId)}
                  onClick={() => {
                    void postTileAction("plant", seedPicker.x, seedPicker.y, c.seedId);
                    setSeedPicker(null);
                  }}
                />
              ))}
            </ItemSlotGrid>
            {CROPS.every((c) => countItem(invProfile, c.seedId) === 0) && (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>種がない</p>
            )}
          </div>
        </div>
      )}

      {boardOpen && spaceUi === "lobby" && (
        <div style={panelOverlay} className="wb-panel">
          <div style={{ ...stickyPanelHead, display: "flex", alignItems: "center", gap: 10 }}>
            <strong>グローバル掲示板</strong>
            <span style={{ flex: 1 }} />
            <button type="button" style={btn} onClick={() => setBoardOpen(false)}>
              閉じる
            </button>
          </div>
          {boardPosts.length === 0 ? (
            <p className="muted" style={{ margin: "10px 0 0", fontSize: 13 }}>まだ投稿はありません</p>
          ) : (
            <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0, display: "grid", gap: 8, maxHeight: 260, overflowY: "auto" }}>
              {boardPosts.map((p, i) => (
                <li key={`${p.at}-${i}`} style={{ fontSize: 13 }}>
                  <strong>{p.name}</strong>{" "}
                  <span className="muted">
                    {new Date(p.at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <div>{p.text}</div>
                </li>
              ))}
            </ul>
          )}
          {boardLoggedIn ? (
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <input
                value={boardText}
                onChange={(e) => setBoardText(e.target.value)}
                maxLength={120}
                placeholder="投稿（120文字まで）"
                style={{
                  flex: 1, minHeight: 40, padding: "6px 10px", borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.06)", color: "inherit",
                }}
              />
              <button type="button" style={btn} onClick={() => void postBoard()}>
                投稿
              </button>
            </div>
          ) : (
            <p className="muted" style={{ margin: "10px 0 0", fontSize: 13 }}>投稿はログイン後</p>
          )}
          {boardMsg && (
            <p role="status" style={{ margin: "10px 0 0" }}>{boardMsg}</p>
          )}
        </div>
      )}

      {mapView && (
        <div style={panelOverlay} className="wb-panel">
          <div style={{ ...stickyPanelHead, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <strong>マップ</strong>
            <span className="muted">あなたの座標 X {coords.x} / Y {coords.y}</span>
            {porterUi && (
              <button type="button" style={btn} onClick={() => void teleportToPorter()}>
                ポーター X {porterUi.x} / Y {porterUi.y}
              </button>
            )}
            <span style={{ flex: 1 }} />
            <button type="button" style={btn} onClick={() => setMapView(false)}>
              閉じる
            </button>
          </div>
          <canvas
            ref={bigMapRef}
            width={BIGMAP_SIZE}
            height={BIGMAP_SIZE}
            aria-label="周辺マップ（大きく表示）"
            onClick={(e) => {
              // ポーターのマーカー付近のタップでも移動できる
              const porter = porterUi;
              if (!porter) return;
              const rect = e.currentTarget.getBoundingClientRect();
              if (rect.width <= 0) return;
              const px = (e.clientX - rect.left) * (BIGMAP_SIZE / rect.width);
              const py = (e.clientY - rect.top) * (BIGMAP_SIZE / rect.width);
              const pos = playerPosRef.current;
              const wx = Math.floor(pos.x) - BIGMAP_TILES / 2 + px / BIGMAP_SCALE;
              const wy = Math.floor(pos.y) - BIGMAP_TILES / 2 + py / BIGMAP_SCALE;
              if (Math.max(Math.abs(wx - (porter.x + 0.5)), Math.abs(wy - (porter.y + 0.5))) <= 3) {
                void teleportToPorter();
              }
            }}
            style={{
              width: layoutMode === "landscape" ? "min(100%, calc(100svh - 150px))" : "100%",
              height: "auto", display: "block", marginTop: 10, marginInline: "auto",
              borderRadius: 10, border: "1px solid rgba(255,255,255,0.35)", background: "rgba(0,0,0,0.25)",
            }}
          />
        </div>
      )}

      {/* パネルの開閉は左上の ≡ メニューに統合（ボタン行は置かない） */}

      {showEconomy && <WorldBoxEconomyPanel space={spaceUi} station={stationUi} genre={stationGenre} worldStationKinds={worldStationKinds} onClose={() => setShowEconomy(false)} />}
      {telescopeOpen && (
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 6 }}>
          <div
            aria-hidden
            style={{
              position: "absolute", inset: 0,
              background: "radial-gradient(circle at center, transparent 52%, rgba(4,6,14,0.55) 78%, rgba(2,3,8,0.92) 100%)",
            }}
          />
          <div
            style={{
              position: "absolute", left: "50%", top: "calc(10px + env(safe-area-inset-top, 0px))", transform: "translateX(-50%)",
              display: "flex", gap: 8, alignItems: "center", padding: "6px 8px 6px 14px", pointerEvents: "auto",
              borderRadius: 10, background: "rgba(0,0,0,0.6)", color: "#fff", fontSize: 13, whiteSpace: "nowrap",
            }}
          >
            <span>望遠鏡</span>
            <button
              type="button"
              style={{ ...btn, minHeight: hud.buttonMinHeight, padding: "2px 10px" }}
              onClick={() => { telescopeCenterRef.current += 1; }}
            >
              戻す
            </button>
            <button
              type="button"
              style={{ ...btn, minHeight: hud.buttonMinHeight, padding: "2px 10px" }}
              onClick={() => setTelescopeOpen(false)}
            >
              閉じる
            </button>
          </div>
        </div>
      )}
      {racingOpen && spaceUi === "lobby" && (
        <WorldBoxRacingPanel onClose={() => setRacingOpen(false)} />
      )}
      {casinoOpen && spaceUi === "lobby" && (
        <WorldBoxCasinoPanel onClose={() => setCasinoOpen(false)} />
      )}
      {arenaOpen && spaceUi === "lobby" && (
        <WorldBoxArenaPanel onClose={() => setArenaOpen(false)} />
      )}
      {arcadeOpen && stationArcade && (spaceUi === "lobby2" || spaceUi === "lobby3") && (
        <WorldBoxArcadePanel
          gameId={stationArcade}
          onClose={() => setArcadeOpen(false)}
        />
      )}
      {reportOpen && (
        <div className="wb-panel" style={{ ...panelOverlay, width: "min(330px, calc(100% - 20px))" }}>
          <div style={{ ...stickyPanelHead, display: "flex", alignItems: "center", gap: 8 }}>
            <strong>通報</strong>
            <span style={{ flex: 1 }} />
            <button type="button" style={btn} onClick={() => setReportOpen(false)}>閉じる</button>
          </div>
          <textarea
            value={reportText}
            onChange={(e) => setReportText(e.target.value)}
            rows={3}
            maxLength={300}
            style={{
              width: "100%", marginTop: 8, borderRadius: 8, padding: 8, boxSizing: "border-box",
              border: "1px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.08)", color: "#fff",
            }}
            aria-label="通報内容"
          />
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
            <button type="button" style={btn} disabled={!reportText.trim()} onClick={() => { void sendReport(); }}>
              送る
            </button>
          </div>
        </div>
      )}
      {machinePanel && spaceUi === "world" && (
        <WorldBoxMachinePanel
          x={machinePanel.x}
          y={machinePanel.y}
          onProfileChange={(profile) => setInvProfile(profile)}
          onClose={() => setMachinePanel(null)}
        />
      )}
      {guildShopOpen && spaceUi === "lobby" && (
        <WorldBoxGuildShopPanel
          profile={invProfile}
          onProfileChange={setInvProfile}
          onClose={() => setGuildShopOpen(false)}
        />
      )}
      {guildBoardOpen && spaceUi === "lobby" && (
        <WorldBoxGuildBoardPanel
          inviteGuildId={inviteGuildId}
          nations={nationsUi}
          nationMsg={nationMsg}
          onNationAction={(body) => void nationAction(body)}
          profile={invProfile}
          onProfileChange={setInvProfile}
          getPlayerPos={() => playerPosRef.current}
          onClose={() => setGuildBoardOpen(false)}
        />
      )}
      </div>
    </div>
  );
}
