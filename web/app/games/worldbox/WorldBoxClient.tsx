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
import { DASH_SPEED, PLAYER_RADIUS, SWIM_DASH_SPEED, SWIM_SPEED, WALK_SPEED, findFreeNear, isWaterAt, stepMove } from "@/lib/worldbox/move";
import { isNightPhase, nightAmount, phaseAtTime } from "@/lib/worldbox/daynight";
import { mobById, mobOccupiesTile, type PlacedMob } from "@/lib/worldbox/mobs";
import {
  MOB_ATTACK_RANGE, MOB_RESPAWN_MS, MOB_SPRITE, MOB_SPRITE_FALLBACK, attackTarget, knockbackTarget, mobBlockedTiles, mobDistance, mobFootprintTiles,
  mobHpNow, mobKeyOf, mobRespawnDelayMs, visibleMobs, type MobState,
} from "@/lib/worldbox/combat";
import { advanceWalkPhase, attackSwingAngle, damp, moveLean, stepBeatIndex, walkBob, walkSquashY } from "@/lib/worldbox/anim";
import {
  WHIFF_ALPHA_SCALE, createFxSystem, createShake, fxLifeRatio, phaseKind, popProgress, popScale, shakeOffsetAt,
  slashAlpha, spawnAmbient, spawnBurst, spawnMobFx, startShake, stepFx, swingProgress, weatherAmbientKind, weatherAt,
  type FxBurstKind, type FxShake, type FxSystem,
} from "@/lib/worldbox/fx";
import { clockOffsetEstimate, type PresenceEntry } from "@/lib/worldbox/presence";
import {
  STAMINA_MAX, canDash, createStamina, createTapTracker, isStickDash, registerKeyTap, rescueStamina,
  staminaGaugeVisible, stepStamina, type StaminaState, type StaminaUse, type TapTracker,
} from "@/lib/worldbox/stamina";
import { createRemoteTrack, stepRemoteTrack, updateRemoteTrack, type RemoteTrack } from "@/lib/worldbox/remote";
import type { NationView, NationsResponse } from "@/lib/worldbox/nations";
import { USER_BUILDING_CAP, type BuildingType, type BuildingView } from "@/lib/worldbox/buildings";
import {
  L_PLAZA, L_SAND, L_VOID,
  LOBBY_ENTRY, LOBBY_FLOOR_FALLBACK, LOBBY_FLOOR_SPRITE, LOBBY_H, LOBBY_STAIRS_DOWN, LOBBY_STAIRS_UP,
  LOBBY_DOWN_LANDING, LOBBY_UP_LANDING, LOBBY_W, LOBBY_WARP_PAD,
  buildLobby, lobbyTileAt, stationGenreNear, stationNear, type LobbyData, type LobbyObject, type LobbyStation,
} from "@/lib/worldbox/lobby";
import { genreById, type ShopGenreId } from "@/lib/worldbox/shops";
import { TENT_ENTRY, TENT_EXIT, TENT_H, TENT_W, buildTent, tentTileAt } from "@/lib/worldbox/tent";
import type { BoardPost } from "@/lib/worldbox/board";
import { parseSave, serializeSave, type SaveSpace } from "@/lib/worldbox/save";
import { chooseInitialSave } from "@/lib/worldbox/save-source";
import {
  actionForTile, cropStage, isOverrideActive, placedBlockSolid, tileKey, tileView,
  type TileActionKind, type TileOverridesMap,
} from "@/lib/worldbox/tiles";
import { CROPS, ITEMS, itemById } from "@/lib/worldbox/items";
import { HP_MAX, HUNGER_MAX, countItem, type ItemSlot, type PlayerProfile, type SlotRef } from "@/lib/worldbox/profile";
import {
  containerCapacity, isContainerItem, type ContainerSlotRef,
} from "@/lib/worldbox/containers";
import { loadDungeonTiles, loadFarmSprites, loadLobbySprites, loadMobSprites, loadTextures } from "@/lib/worldbox/textures";
import { isStickTouch, stickBase, stickVector } from "@/lib/worldbox/stick";
import {
  bgmSceneFor, loadWbSoundSettings, playWbSe, saveWbSoundSettings, seForFxBurst, setWbBgmScene,
  stopWbBgm, unlockWbAudio, type WbSoundSettings,
} from "@/lib/worldbox/sound";
import { useGamesNav } from "../GamesShell";
import WorldBoxCasinoPanel from "./WorldBoxCasinoPanel";
import WorldBoxArenaPanel from "./WorldBoxArenaPanel";
import WorldBoxEconomyPanel from "./WorldBoxEconomyPanel";
import WorldBoxGuildBoardPanel from "./WorldBoxGuildBoardPanel";

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


/** 建築ツール（建物3種＋取り壊し）。 */
type BuildTool = BuildingType | "demolish";
const BUILD_TOOL_LABEL: Record<BuildTool, string> = { house: "家", farm: "畑", tower: "塔", demolish: "取り壊し" };

const NATION_ERROR_LABEL: Record<string, string> = {
  already_in_nation: "既に国に所属しています",
  nation_exists: "そのサーバーの国は既にあります",
  no_free_tile: "首都を置ける空き地がありません",
  not_owner: "建国はサーバーのオーナーのみです",
  not_member: "そのサーバーのメンバーではありません",
  guilds_scope_required: "サーバー情報の取得に再ログインが必要です",
  guilds_unavailable: "サーバー情報を取得できませんでした",
  nation_not_found: "国が見つかりません",
  not_in_nation: "国に所属していません",
  king_must_transfer_or_disband: "国民がいる間、王は離脱できません",
  not_at_guild_board: "ギルドボードの前で操作してください",
  unauthorized: "ログインが必要です",
  tile_blocked: "そこには建てられません",
  cap_reached: "建築上限に達しています",
  forbidden: "その権限がありません",
  invalid_type: "建物の種類が不正です",
  on_capital: "首都には建てられません",
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
  too_far: "遠すぎる",
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
function SlotContent({ slot }: { slot: ItemSlot }) {
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
    </>
  );
}

/** 建物側の文言（not_owner は国家側と意味が違うため上書きする）。 */
const BUILDING_ERROR_LABEL: Record<string, string> = {
  ...NATION_ERROR_LABEL,
  not_owner: "自分の建物だけ取り壊せます",
};

const EMPTY_NATIONS: NationsResponse = {
  nations: [], me: null, playerNations: {}, loggedIn: false, myGuilds: [], guildsScopeRequired: false,
};

/** 建物データ（建物は個人所有で、国家データとは別 API から取る）。 */
type BuildingsData = { buildings: BuildingView[]; loggedIn: boolean };
const EMPTY_BUILDINGS: BuildingsData = { buildings: [], loggedIn: false };

/** 足元に平置きで描くロビースプライト（上に立てるもの）。 */
const FLAT_LOBBY_SPRITES = new Set(["warp_pad", "stairs", "tapestry"]);

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
};

export default function WorldBoxClient() {
  const { prefix } = useGamesNav();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const minimapRef = useRef<HTMLCanvasElement | null>(null);
  const [statusText, setStatusText] = useState("読み込み中…");
  const [othersCount, setOthersCount] = useState(0);
  const [showMap, setShowMap] = useState(true);
  const showMapRef = useRef(true);
  showMapRef.current = showMap;
  // 国家レイヤー（描画ループは ref、パネルは state で同じデータを見る）
  const nationsRef = useRef<NationsResponse>(EMPTY_NATIONS);
  const playerPosRef = useRef({ x: 0.5, y: 0.5 });
  const [nationsUi, setNationsUi] = useState<NationsResponse>(EMPTY_NATIONS);
  const [showNations, setShowNations] = useState(false);
  const [showEconomy, setShowEconomy] = useState(false);
  // マップ表示モード（周辺マップを大きく見る。描画ループは ref で見る）
  const [mapView, setMapView] = useState(false);
  const mapViewRef = useRef(false);
  mapViewRef.current = mapView;
  const bigMapRef = useRef<HTMLCanvasElement | null>(null);
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
  // 建築モード（描画・入力ループは ref、パネルは state で見る）
  const [buildMode, setBuildMode] = useState(false);
  const [buildTool, setBuildTool] = useState<BuildTool>("house");
  const buildRef = useRef<{ active: boolean; tool: BuildTool }>({ active: false, tool: "house" });
  /** 建物の当たり判定（"x,y" の集合）。建物データの更新に合わせて作り直す。 */
  const blockedRef = useRef<ReadonlySet<string>>(new Set());
  /** 建物レイヤー分の固体タイル。 */
  const buildingBlockedRef = useRef<ReadonlySet<string>>(new Set());
  /** 設置ブロック分の固体タイル（タイル上書きから作る）。 */
  const blockBlockedRef = useRef<ReadonlySet<string>>(new Set());
  /** ワールドの固体タイル = 建物 ∪ 設置ブロック。 */
  const syncWorldBlocked = () => {
    const merged = new Set<string>(buildingBlockedRef.current);
    for (const k of blockBlockedRef.current) merged.add(k);
    blockedRef.current = merged;
  };
  const buildActionRef = useRef<(tool: BuildTool, x: number, y: number) => void>(() => {});

  const chooseBuildTool = (tool: BuildTool) => {
    setBuildTool(tool);
    setBuildMode(true);
    buildRef.current = { active: true, tool };
  };
  const endBuildMode = () => {
    setBuildMode(false);
    buildRef.current.active = false;
  };

  // 建物レイヤー（描画ループは ref、パネルは state で同じデータを見る）
  const buildingsRef = useRef<BuildingsData>(EMPTY_BUILDINGS);
  const [buildingsUi, setBuildingsUi] = useState<BuildingsData>(EMPTY_BUILDINGS);

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
  const gateOk = gate === "ok";
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
  }, []);
  // 空間（ワールド / ロビー）とハンバーガーメニュー、ステーション、掲示板
  const [spaceUi, setSpaceUi] = useState<SaveSpace>("world");
  const [menuOpen, setMenuOpen] = useState(false);
  const [stationUi, setStationUi] = useState<LobbyStation | null>(null);
  /** いま接している店の品目ジャンル（鍛冶屋は "smith"）。経済パネルの品目選別に使う。 */
  const [stationGenre, setStationGenre] = useState<ShopGenreId | null>(null);
  const warpActionRef = useRef<(target: SaveSpace) => void>(() => {});
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
  const respawnActionRef = useRef<(point: { x: number; y: number }) => void>(() => {});
  const bedKeyRef = useRef<string>("");
  const [casinoOpen, setCasinoOpen] = useState(false);
  const [arenaOpen, setArenaOpen] = useState(false);
  const [plazaMsg, setPlazaMsg] = useState("");
  const staminaBoostRef = useRef(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [guildBoardOpen, setGuildBoardOpen] = useState(false);
  const [boardPosts, setBoardPosts] = useState<BoardPost[]>([]);
  const [boardLoggedIn, setBoardLoggedIn] = useState(false);
  const [boardText, setBoardText] = useState("");
  const [boardMsg, setBoardMsg] = useState("");
  // 音響（BGM/SE）: 設定は lib/worldbox/sound が localStorage に持つ。
  // AudioContext は最初のユーザー操作でだけ作れるため、解錠は pointerdown/keydown で行う。
  const [soundSettings, setSoundSettings] = useState<WbSoundSettings>({ bgm: true, se: true });
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
    const applyScene = () =>
      setWbBgmScene(bgmSceneFor({
        space: spaceUi, night: nightAmount(phaseAtTime(Date.now() / 1000)), casinoOpen,
      }));
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
    try {
      const res = await fetch("/api/worldbox/board", { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = (await res.json()) as { posts?: BoardPost[]; loggedIn?: boolean };
      setBoardPosts(data.posts ?? []);
      setBoardLoggedIn(!!data.loggedIn);
    } catch { /* 掲示板が読めなくても歩き続けられる */ }
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
        setBoardMsg(data.error === "unauthorized" ? "投稿はログイン後" : "投稿できませんでした");
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
    const timer = window.setInterval(() => void refreshBoard(), 10000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardOpen]);

  // 施設から離れたら、その施設のパネルは閉じる（場所制約の表示側）
  useEffect(() => {
    if (stationUi !== "board") setBoardOpen(false);
    if (stationUi !== "casino") setCasinoOpen(false);
    if (stationUi !== "guild") setGuildBoardOpen(false);
    if (stationUi !== "arena") setArenaOpen(false);
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
  const refreshNations = async () => {
    try {
      const res = await fetch("/api/worldbox/nations", { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      applyNationsData((await res.json()) as NationsResponse);
    } catch { /* 国家が読めなくても歩き続けられる */ }
  };
  const applyBuildingsData = (data: BuildingsData) => {
    buildingsRef.current = data;
    buildingBlockedRef.current = new Set(data.buildings.map((b) => `${b.x},${b.y}`));
    syncWorldBlocked();
    if (!data.loggedIn && buildRef.current.active) endBuildMode();
    setBuildingsUi(data);
  };
  const refreshBuildings = async () => {
    try {
      const res = await fetch("/api/worldbox/buildings", { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      applyBuildingsData((await res.json()) as BuildingsData);
    } catch { /* 建物が読めなくても歩き続けられる */ }
  };
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
      await refreshNations();
    } catch {
      setNationMsg("失敗しました");
    }
  };
  const buildingAction = async (body: Record<string, unknown>) => {
    setNationMsg("");
    try {
      const res = await fetch("/api/worldbox/buildings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setNationMsg(BUILDING_ERROR_LABEL[data.error ?? ""] ?? "失敗しました");
        // 失敗は空振りで返す（風切りだけ・成功の粒は出さない）
        fxEventsRef.current.push({
          kind: "whiff",
          x: typeof body.x === "number" ? body.x : Math.floor(playerPosRef.current.x),
          y: typeof body.y === "number" ? body.y : Math.floor(playerPosRef.current.y),
        });
        return;
      }
      if (typeof body.x === "number" && typeof body.y === "number") {
        fxEventsRef.current.push({ kind: body.action === "demolish" ? "debris" : "build", x: body.x, y: body.y });
      }
      await refreshBuildings();
    } catch {
      setNationMsg("失敗しました");
    }
  };
  const buildAction = (tool: BuildTool, x: number, y: number) => {
    if (tool === "demolish") void buildingAction({ action: "demolish", x, y });
    else void buildingAction({ action: "build", type: tool, x, y });
  };
  buildActionRef.current = buildAction;

  // インベントリ（ホットバー/ストレージ）とタイル上書き（伐採・畑・作物）
  const [invProfile, setInvProfile] = useState<PlayerProfile | null>(null);
  const invRef = useRef<PlayerProfile | null>(null);
  invRef.current = invProfile;
  const [selSlot, setSelSlot] = useState(0);
  const selSlotRef = useRef(0);
  selSlotRef.current = selSlot;
  const [storageOpen, setStorageOpen] = useState(false);
  /** インベントリ整理で持ち上げ中のスロット（タップ→タップで移動）。 */
  const [heldSlot, setHeldSlot] = useState<SlotRef | null>(null);
  /** 開いている収納コンテナ（自分の樽・宝箱）とその中身。 */
  const [containerPanel, setContainerPanel] = useState<{ x: number; y: number; itemId: string } | null>(null);
  const [containerSlots, setContainerSlots] = useState<ItemSlot[] | null>(null);
  /** コンテナパネルで持ち上げ中のスロット（プロフィール側も含む）。 */
  const [heldPanelSlot, setHeldPanelSlot] = useState<ContainerSlotRef | null>(null);
  const [seedPicker, setSeedPicker] = useState<{ x: number; y: number } | null>(null);
  const [tileMsg, setTileMsg] = useState("");
  // Esc で開いているパネル/メニューを全部閉じる（パネル内に閉じ場所が無い状態への保険）
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      setShowNations(false);
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
  const fxEventsRef = useRef<{ kind: FxBurstKind | "whiff"; x: number; y: number; sizeTiles?: number; color?: string }[]>([]);
  /** 自分の不透明 ID（プレゼンス ID）。自分のブロック判定に使う。 */
  const selfIdRef = useRef<string | null>(null);
  /** タイル上書きから設置ブロックの固体集合を作り直す（施設は占有のみで固体にしない）。 */
  const syncBlockBlocked = () => {
    const now = Date.now();
    const next = new Set<string>();
    for (const [key, ov] of Object.entries(tilesRef.current)) {
      if (ov.block && placedBlockSolid(ov.block.itemId) && isOverrideActive(ov, now)) next.add(key);
    }
    blockBlockedRef.current = next;
    syncWorldBlocked();
  };

  const refreshInv = async () => {
    try {
      const res = await fetch("/api/worldbox/profile", { headers: { Accept: "application/json" } });
      if (!res.ok) return;
      const data = (await res.json()) as { profile?: PlayerProfile };
      if (data.profile) setInvProfile(data.profile);
    } catch { /* 読めなくても歩き続けられる */ }
  };
  /** バイタル API の結果を反映する（死亡時はリスポーン移動まで行う）。 */
  const applyVitalsResult = (data: {
    profile?: PlayerProfile; died?: boolean; respawn?: { x: number; y: number };
  }) => {
    if (data.profile) setInvProfile(data.profile);
    if (data.died && data.respawn) {
      respawnActionRef.current(data.respawn);
      setTileMsg("倒れた");
    }
  };
  const postVitals = async (body: Record<string, unknown>) => {
    try {
      const res = await fetch("/api/worldbox/vitals", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        profile?: PlayerProfile; died?: boolean; respawn?: { x: number; y: number };
      };
      if (res.ok) applyVitalsResult(data);
    } catch { /* バイタルが届かなくても歩き続けられる（次回同期で精算される） */ }
  };
  /** モブ接触ダメージ（サーバーが配置・距離・攻撃力を検証する）。 */
  const postMobDamage = (mobId: string, x: number, y: number) => {
    void postVitals({
      action: "damage", mobId, x, y,
      px: playerPosRef.current.x, py: playerPosRef.current.y,
    });
  };
  /** ベッドを踏んだらリスポーン点にする（同じベッドでは1回だけ送る）。 */
  const postBedRespawn = (x: number, y: number) => {
    const key = `${x},${y}`;
    if (bedKeyRef.current === key) return;
    bedKeyRef.current = key;
    void postVitals({ action: "set_bed", x, y });
  };
  // バイタルの定期精算（空腹・毒・飢えはサーバー側の時刻で進む）
  useEffect(() => {
    const timer = window.setInterval(() => void postVitals({ action: "sync" }), 15000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshTiles = async () => {
    try {
      const px = Math.floor(playerPosRef.current.x);
      const py = Math.floor(playerPosRef.current.y);
      const x0 = px - 64;
      const y0 = py - 64;
      const res = await fetch(
        `/api/worldbox/tiles?x0=${x0}&y0=${y0}&x1=${x0 + 127}&y1=${y0 + 127}`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) return;
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
      syncBlockBlocked();
    } catch { /* 読めなくても歩き続けられる */ }
  };
  const postTileAction = async (action: TileActionKind, x: number, y: number, seedId?: string, itemId?: string) => {
    setTileMsg("");
    try {
      const res = await fetch("/api/worldbox/tiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, x, y, ...(seedId ? { seedId } : {}), ...(itemId ? { itemId } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string; key?: string; override?: TileOverridesMap[string] | null; profile?: PlayerProfile;
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
      };
      fxEventsRef.current.push({ kind: fxKind[action], x, y });
      if (data.key) {
        const next = { ...tilesRef.current };
        if (data.override) next[data.key] = data.override;
        else delete next[data.key];
        tilesRef.current = next;
        tilesVersionRef.current += 1;
        syncBlockBlocked();
      }
      if (data.profile) setInvProfile(data.profile);
    } catch {
      setTileMsg("できませんでした");
      fxEventsRef.current.push({ kind: "whiff", x, y });
    }
  };
  const postTileActionRef = useRef(postTileAction);
  postTileActionRef.current = postTileAction;
  /** モブ個体状態（傷/死亡がある個体だけサーバーから受ける）。 */
  const mobStatesRef = useRef<Record<string, MobState>>({});
  const refreshMobs = async () => {
    try {
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
      const next: Record<string, MobState> = { ...mobStatesRef.current };
      for (const key of Object.keys(next)) {
        const m = /@(-?\d+),(-?\d+)$/.exec(key);
        if (!m) continue;
        const x = Number(m[1]);
        const y = Number(m[2]);
        if (x >= x0 && x <= x0 + 127 && y >= y0 && y <= y0 + 127) delete next[key];
      }
      Object.assign(next, data.states ?? {});
      mobStatesRef.current = next;
    } catch { /* 読めなくても歩き続けられる */ }
  };
  /** モブへの攻撃（サーバーが配置・距離・HP の正）。結果は演出で返す。 */
  const attackMob = async (placed: PlacedMob) => {
    const key = mobKeyOf(placed);
    const def = mobById(placed.mobId);
    try {
      const res = await fetch("/api/worldbox/mobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "attack", mobId: placed.mobId, x: placed.x, y: placed.y,
          // サーバー側の位置の正（プレゼンス）が WS 中継中は bot_kv に届かないため、
          // 距離検証のフォールバックとして現在位置を添える（プレゼンスが新鮮ならそちらが優先される）
          px: playerPosRef.current.x, py: playerPosRef.current.y,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string; hp?: number; dead?: boolean; profile?: PlayerProfile;
      };
      if (!res.ok) {
        if (data.error === "too_far") setTileMsg(TILE_ERROR_LABEL.too_far);
        fxEventsRef.current.push({ kind: "whiff", x: placed.x, y: placed.y });
        return;
      }
      const next = { ...mobStatesRef.current };
      if (data.dead) next[key] = { hp: 0, deadUntil: Date.now() + MOB_RESPAWN_MS + mobRespawnDelayMs(key) };
      else if (typeof data.hp === "number") next[key] = { hp: data.hp };
      mobStatesRef.current = next;
      fxEventsRef.current.push({
        kind: data.dead ? "death" : "hit",
        x: placed.x, y: placed.y,
        sizeTiles: placed.size,
        color: def ? MOB_FX_COLOR[def.id] : undefined,
      });
      if (data.profile) setInvProfile(data.profile);
    } catch {
      fxEventsRef.current.push({ kind: "whiff", x: placed.x, y: placed.y });
    }
  };
  const attackMobRef = useRef(attackMob);
  attackMobRef.current = attackMob;
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

  /** 自分の収納コンテナ（樽・宝箱）を開く。中身はサーバーが正。 */
  const openContainer = async (x: number, y: number, itemId: string) => {
    setStorageOpen(false);
    setHeldSlot(null);
    setHeldPanelSlot(null);
    setContainerSlots(null);
    setContainerPanel({ x, y, itemId });
    try {
      const res = await fetch(`/api/worldbox/containers?x=${x}&y=${y}`, {
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
    void refreshBuildings();
    void refreshInv();
    void refreshTiles();
    void refreshMobs();
    const timer = window.setInterval(() => {
      void refreshNations();
      void refreshBuildings();
      void refreshInv();
      void refreshTiles();
      void refreshMobs();
    }, 15000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const lobby = buildLobby();
    const tent = buildTent();
    /** 現在の室内空間（ロビー/テント）のデータ。ワールドでは lobby を返す（使われない）。 */
    const indoorData = (): LobbyData => (space === "tent" ? tent : lobby);
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
    // 移動・描画・建築可否はこちらを見る。全体グリッドは持たない。
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
    // 空間（ワールド / ロビー）。ロビーでは建物・国家・ミニマップは扱わない。
    let space: SaveSpace = "world";
    let worldReturn: { x: number; y: number } | null = null;
    const activeMap = (): TopDownMap => (space === "world" ? worldMap : indoorData().moveMap);
    const activeBounds = () => (space === "lobby" ? rectBounds(LOBBY_W, LOBBY_H) : space === "tent" ? rectBounds(TENT_W, TENT_H) : worldBounds());
    // モブ占有を差し引いた今フレームの固体集合（モブの真上に立つ間の救済用）
    let mobFrameBlocked: ReadonlySet<string> | undefined;
    const activeBlocked = (): ReadonlySet<string> | undefined =>
      mobFrameBlocked ?? (space === "world" ? blockedRef.current : indoorData().blocked);
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
    };
    const mobRenders = new Map<string, MobRender>();
    let mobCacheKey = "";
    let mobCache: PlacedMob[] = [];
    let lastAttackAt = 0;
    /** 接触中のモブ（個体キー）と、敵対ノックバックを最後に発火した時刻。 */
    let contactMobKeyNow: string | null = null;
    let contactFiredAt = 0;
    /** ノックバックの残り速度（タイル/秒）。接触で初速を与え、stepMove で滑らかに減衰させる（瞬間移動にしない）。 */
    let kbVel = { x: 0, y: 0 };
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
    let lastSaved = { x: player.x, y: player.y, at: 0 };
    let lastMinimapAt = 0;
    let lastBigMapAt = 0;

    // ---- 保存（空間＋位置＋ワールド帰還点） ----
    const currentSave = () => serializeSave({ space, x: player.x, y: player.y, worldReturn });
    const saveLocal = () => {
      try {
        localStorage.setItem(SAVE_KEY, currentSave());
      } catch { /* noop */ }
    };
    const saveOnline = (keepalive = false) => {
      if (!loggedIn) return;
      fetch("/api/worldbox/save", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ save: currentSave() }),
        keepalive,
      }).catch(() => { /* 保存できなくても遊び続けられる */ });
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
      }
      if (choice.pushLocalToOnline) saveNow();
      else lastSaved = { x: player.x, y: player.y, at: performance.now() };
      setStatusText(space === "lobby" ? "ロビー" : space === "tent" ? "テント" : "共有ワールド");
    })();

    // ---- プレゼンス（空間ごとに分ける。他空間の者は受け取らない） ----
    // エントリの ts はサーバー時刻。受信側の時計ずれを GET の now で補正してから
    // 外挿に使う（ずれがそのまま描画位置のズレになるため）。
    let clockOffsetMs = 0;
    const presenceNow = () => Date.now() + clockOffsetMs;
    /** ポーリングで連続して見えなかった回数（1回の欠落では消さない）。 */
    const missedPolls = new Map<string, number>();
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
    /** WS 経由のハートビート送信（中継は REST と同じ整形規則で受ける）。 */
    const sendWsHeartbeat = () => {
      if (!rtSocket || rtSocket.readyState !== WebSocket.OPEN) return;
      try {
        rtSocket.send(JSON.stringify({ t: "hb", x: player.x, y: player.y, vx: player.vx, vy: player.vy, face: player.face, space }));
      } catch { /* noop */ }
    };
    /** 中継への接続（トークン取得→接続→受信→再接続）。失敗してもポーリングが続く。 */
    const connectRealtime = async () => {
      if (disposed || !loggedIn || rtSocket) return;
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
        const ws = new WebSocket(`${proto}//${location.host}/api/worldbox/realtime?t=${encodeURIComponent(rtToken)}`);
        rtSocket = ws;
        ws.onopen = () => {
          rtBackoffMs = 1000;
          sendWsHeartbeat();
        };
        ws.onmessage = (ev) => {
          const arrivedAt = Date.now();
          let msg: { t?: string; now?: number; p?: PresenceEntry; players?: PresenceEntry[]; id?: string };
          try {
            msg = JSON.parse(String(ev.data));
          } catch {
            return;
          }
          if (typeof msg.now === "number") absorbClockSample(msg.now, arrivedAt, arrivedAt);
          const now = presenceNow();
          if (msg.t === "snap") {
            for (const entry of msg.players ?? []) {
              missedPolls.delete(entry.id);
              applyPresenceEntry(entry, now);
            }
            setOthersCount(others.size);
          } else if (msg.t === "up" && msg.p) {
            missedPolls.delete(msg.p.id);
            applyPresenceEntry(msg.p, now);
            setOthersCount(others.size);
          } else if (msg.t === "bye" && msg.id) {
            others.delete(msg.id);
            missedPolls.delete(msg.id);
            setOthersCount(others.size);
          }
        };
        const onGone = () => {
          if (rtSocket === ws) rtSocket = null;
          if (disposed) return;
          rtRetryAt = Date.now() + rtBackoffMs;
          rtBackoffMs = Math.min(10_000, rtBackoffMs * 2);
          rtReconnectTimer = window.setTimeout(() => void connectRealtime(), rtBackoffMs);
        };
        ws.onclose = onGone;
        ws.onerror = onGone;
      } catch {
        rtRetryAt = Date.now() + rtBackoffMs;
        rtBackoffMs = Math.min(10_000, rtBackoffMs * 2);
      }
    };
    const sendHeartbeat = () => {
      if (!loggedIn) return;
      fetch("/api/worldbox/presence", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "", x: player.x, y: player.y, vx: player.vx, vy: player.vy, face: player.face, space }),
      }).catch(() => { /* noop */ });
    };
    const pollOthers = async () => {
      const before = Date.now();
      try {
        const res = await fetch(`/api/worldbox/presence?space=${space}`, { headers: { Accept: "application/json" } });
        if (!res.ok) return;
        const body = (await res.json()) as { players?: PresenceEntry[]; now?: number };
        if (disposed) return;
        if (typeof body.now === "number") absorbClockSample(body.now, before, Date.now());
        const now = presenceNow();
        const seen = new Set<string>();
        for (const entry of body.players ?? []) {
          seen.add(entry.id);
          missedPolls.delete(entry.id);
          applyPresenceEntry(entry, now);
        }
        for (const id of [...others.keys()]) {
          if (seen.has(id)) continue;
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
      // モブ距離）の正だが、WS 中継は bot_kv に書かない。REST ハートビートを
      // WS の有無と独立に併送し、bot_kv 側の鮮度を保つ（止めると全ゲートが死ぬ）。
      if (movedDist > 4 || now - lastRestHeartbeatAt >= (moving ? 500 : 2000)) {
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
    const pollTimer = window.setInterval(pollOthers, 1000);
    pollOthers();

    // ---- 入力 ----
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return; // 掲示板の入力中は歩かない
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
    /** 建築モードで狙っているタイル（ハイライト用）。 */
    let hoverTile: { x: number; y: number } | null = null;
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
          const key = mobKeyOf(placed);
          if (!mobHpNow(def, mobStatesRef.current[key] ?? null, nowMs).alive) continue;
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
          if (nowMs - lastAttackAt >= 350) {
            lastAttackAt = nowMs;
            void attackMobRef.current(target.placed);
          }
          return true;
        }
        return false; // 空振り（スイングは出した。タイル行為は通常どおり続く）
      }
      for (const placed of mobCache) {
        const def = mobById(placed.mobId);
        if (!def) continue;
        const key = mobKeyOf(placed);
        if (!mobHpNow(def, mobStatesRef.current[key] ?? null, nowMs).alive) continue;
        const r = mobRenders.get(key);
        const cx = r ? Math.floor(r.wx) : placed.x;
        const cy = r ? Math.floor(r.wy) : placed.y;
        if (!mobOccupiesTile(placed.size, cx, cy, t.x, t.y)) continue;
        if (mobDistance(px, py, { x: cx, y: cy, size: placed.size }) > MOB_ATTACK_RANGE) {
          setTileMsg(TILE_ERROR_LABEL.too_far);
          return true;
        }
        // 向きをモブへ向けて即時に振る（HP と粒はサーバー応答で返す）
        player.face = cx + 0.5 >= player.x ? 1 : -1;
        const slot = invRef.current.hotbar[selSlotRef.current] ?? null;
        swing = { startedAt: performance.now(), itemId: slot?.id ?? null, face: player.face, whiff: false };
        playWbSe("swing");
        if (nowMs - lastAttackAt >= 350) {
          lastAttackAt = nowMs;
          void attackMobRef.current(placed);
        }
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
        if (wantsPlace) setTileMsg(TILE_ERROR_LABEL.too_far);
        return false;
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
        // 自分の樽・宝箱は採掘ではなく収納を開く。他人の収納は開けない。
        if (view.block.mine) {
          void openContainerRef.current(t.x, t.y, view.block.itemId);
        } else {
          setTileMsg(TILE_ERROR_LABEL.not_owner);
        }
        return true;
      }
      const act = actionForTile(view, {
        tool: selItem?.tool,
        seedId: selItem && selItem.category === "seed" ? selItem.id : undefined,
        blockId: selItem && (selItem.category === "block" || selItem.facility || selItem.placesBlock) ? selItem.id : undefined,
      });
      if (!act) {
        // 隣接タップで何も起きない場合は理由を出す（素材は置けない・その地形には置けない等）。
        // 剣の空振りは通常の応答なので理由は出さない
        if (selItem && selItem.tool !== "sword") setTileMsg(TILE_ERROR_LABEL.tile_blocked);
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
      if (buildRef.current.active && space === "world") {
        // 建築モードではタップそのものが確定（スティックは無効）
        const t = toTile(e);
        hoverTile = t;
        buildActionRef.current(buildRef.current.tool, t.x, t.y);
        return;
      }
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
      if (space === "world") {
        const t = toTile(e);
        if (!handleMobTap(t)) handleTileTap(t);
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (buildRef.current.active && space === "world") {
        hoverTile = toTile(e);
        return;
      }
      if (!joy.active || e.pointerId !== joy.pointerId) return;
      const p = canvasPos(e);
      const v = stickVector(p.x, p.y, stickBase(p.w, p.h));
      joy.dx = v.dx;
      joy.dy = v.dy;
    };
    const onPointerUp = (e: PointerEvent) => {
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
      const dpr = Math.min(2, window.devicePixelRatio || 1);
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
    ) => {
      const size = TILE * AVATAR_TILES;
      // 泳ぎ中は体を沈め、歩行の上下動をゆるい浮き沈みに替える
      const sink = swim ? size * 0.34 : 0;
      const bob = swim ? Math.sin(performance.now() / 280 + phase) * TILE * 0.02 : walkBob(phase) * TILE * 0.07 * speedRatio;
      const squash = swim ? 1 : 1 - (1 - walkSquashY(phase)) * speedRatio;
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
        c.font = "600 11px sans-serif";
        c.textAlign = "center";
        c.lineWidth = 3;
        c.strokeStyle = "rgba(10,16,10,0.65)";
        const ly = sy - size + sink - 6 - bob;
        c.strokeText(name, sx, ly);
        c.fillStyle = "#ffffff";
        c.fillText(name, sx, ly);
        if (nationColor) {
          const w = c.measureText(name).width;
          c.fillStyle = nationColor;
          c.fillRect(sx - w / 2, ly + 3, w, 2.5);
        }
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
    };

    // ---- 建物（平たい紙風。家=壁+三角屋根、畑=畝と作物、塔=石積み+所属色の旗） ----
    const drawBuilding = (c: CanvasRenderingContext2D, sx: number, sy: number, type: BuildingType, color: string) => {
      c.fillStyle = "rgba(20,30,16,0.28)";
      c.beginPath();
      c.ellipse(sx + TILE / 2, sy + TILE * 0.93, TILE * 0.34, TILE * 0.10, 0, 0, Math.PI * 2);
      c.fill();
      c.lineWidth = 1.5;
      c.strokeStyle = "rgba(40,36,28,0.75)";
      if (type === "house") {
        c.fillStyle = "#f0e4c6";
        c.fillRect(sx + TILE * 0.18, sy + TILE * 0.42, TILE * 0.64, TILE * 0.52);
        c.strokeRect(sx + TILE * 0.18, sy + TILE * 0.42, TILE * 0.64, TILE * 0.52);
        c.fillStyle = color;
        c.beginPath();
        c.moveTo(sx + TILE * 0.09, sy + TILE * 0.45);
        c.lineTo(sx + TILE * 0.5, sy + TILE * 0.09);
        c.lineTo(sx + TILE * 0.91, sy + TILE * 0.45);
        c.closePath();
        c.fill();
        c.stroke();
        c.fillStyle = "#7a5a38";
        c.fillRect(sx + TILE * 0.44, sy + TILE * 0.68, TILE * 0.13, TILE * 0.26);
      } else if (type === "farm") {
        c.fillStyle = "#8a5a2b";
        c.fillRect(sx + TILE * 0.07, sy + TILE * 0.15, TILE * 0.86, TILE * 0.74);
        c.strokeRect(sx + TILE * 0.07, sy + TILE * 0.15, TILE * 0.86, TILE * 0.74);
        c.strokeStyle = "rgba(56,34,14,0.85)";
        c.lineWidth = 2;
        for (const fy of [0.33, 0.52, 0.71]) {
          c.beginPath();
          c.moveTo(sx + TILE * 0.10, sy + TILE * fy);
          c.lineTo(sx + TILE * 0.90, sy + TILE * fy);
          c.stroke();
        }
        c.fillStyle = "#69b84a";
        for (const fy of [0.24, 0.43, 0.62, 0.81]) {
          for (const fx of [0.22, 0.42, 0.62, 0.82]) {
            c.beginPath();
            c.arc(sx + TILE * fx, sy + TILE * fy, TILE * 0.045, 0, Math.PI * 2);
            c.fill();
          }
        }
      } else {
        // tower: 背の高い石積み＋胸壁＋国色の小さな旗
        const tw = TILE * 0.46;
        const tx0 = sx + (TILE - tw) / 2;
        const topY = sy - TILE * 0.22;
        c.fillStyle = "#9aa0a6";
        c.fillRect(tx0, topY + TILE * 0.12, tw, TILE * 1.04);
        c.strokeRect(tx0, topY + TILE * 0.12, tw, TILE * 1.04);
        c.fillStyle = "#878d94";
        const bw = tw / 5;
        for (let i = 0; i < 3; i++) c.fillRect(tx0 + i * bw * 2, topY, bw, TILE * 0.12);
        c.fillStyle = "#3c4147";
        c.fillRect(sx + TILE * 0.44, sy + TILE * 0.28, TILE * 0.12, TILE * 0.18);
        c.strokeStyle = "#4c4438";
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(sx + TILE / 2, topY);
        c.lineTo(sx + TILE / 2, topY - TILE * 0.30);
        c.stroke();
        c.fillStyle = color;
        c.beginPath();
        c.moveTo(sx + TILE / 2, topY - TILE * 0.30);
        c.lineTo(sx + TILE / 2 + TILE * 0.24, topY - TILE * 0.22);
        c.lineTo(sx + TILE / 2, topY - TILE * 0.14);
        c.closePath();
        c.fill();
      }
    };

    /** 建築モードの可否プレビュー（サーバー判定の鏡像。最終判定はサーバー）。 */
    const buildValidity = (tx: number, ty: number): boolean => {
      const data = buildingsRef.current;
      if (!data.loggedIn) return false;
      if (buildRef.current.tool === "demolish") {
        const b = data.buildings.find((v) => v.x === tx && v.y === ty);
        return !!b && b.mine;
      }
      if (nationsRef.current.nations.some((n) => n.capital.x === tx && n.capital.y === ty)) return false;
      const t = mapTileAt(worldMap, tx, ty);
      if (t !== T_GRASS && t !== T_DIRT && t !== T_SAND) return false;
      if (data.buildings.some((v) => v.x === tx && v.y === ty)) return false;
      if (data.buildings.filter((v) => v.mine).length >= USER_BUILDING_CAP) return false;
      return true;
    };

    // ---- 空間移動（ワープパッド・階段・ハンバーガーメニュー） ----
    let lastTileKey = "";
    let lastStation: LobbyStation | null = null;
    let lastStationGenre: ShopGenreId | null = null;
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
    };
    const doWarp = (target: SaveSpace) => {
      if (target === space) return;
      if (target === "lobby") {
        worldReturn = { x: player.x, y: player.y };
        space = "lobby";
        setSpaceUi("lobby");
        setStatusText("ロビー");
        if (buildRef.current.active) {
          buildRef.current.active = false;
          setBuildMode(false);
        }
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
        placePlayer(TENT_ENTRY.x, TENT_ENTRY.y);
      } else {
        space = "world";
        setSpaceUi("world");
        setStatusText("共有ワールド");
        lastStation = null;
        setStationUi(null);
        lastStationGenre = null;
        setStationGenre(null);
        const dest = worldReturn ?? spawn;
        placePlayer(dest.x, dest.y);
      }
      spawnBurst(fxSys, "warp", player.x, player.y - 0.3);
      playWbSe("warp");
      void pollOthers();
    };
    warpActionRef.current = doWarp;
    /** 所属国への移動: サーバーが決めた移動先へそのままテレポートする。 */
    teleportActionRef.current = (x: number, y: number) => {
      if (space !== "world") {
        space = "world";
        setSpaceUi("world");
        setStatusText("共有ワールド");
        lastStation = null;
        setStationUi(null);
        lastStationGenre = null;
        setStationGenre(null);
        setBoardOpen(false);
        if (buildRef.current.active) {
          buildRef.current.active = false;
          setBuildMode(false);
        }
      }
      placePlayer(x, y);
      void pollOthers();
    };
    respawnActionRef.current = (point: { x: number; y: number }) => {
      space = "world";
      setSpaceUi("world");
      setStatusText("共有ワールド");
      lastStation = null;
      setStationUi(null);
      placePlayer(point.x, point.y);
      spawnBurst(fxSys, "warp", player.x, player.y - 0.3);
      playWbSe("warp");
      void pollOthers();
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
        return;
      }
      if (space === "tent") {
        if (tx === TENT_EXIT.x && ty === TENT_EXIT.y) doWarp("world");
        return;
      }
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
      const ilen = Math.hypot(ix, iy);
      if (ilen > 1) {
        ix /= ilen;
        iy /= ilen;
      }
      // 実効タイルは effTileAt が上書きを都度読むため、タイル配列の同期は不要。
      // モブ占有: 現在位置の footprint を移動の当たり判定へ合成する。
      // 占有の真上に立っている間は、そのモブの占有だけ通す（閉じ込め防止）。
      mobFrameBlocked = undefined;
      if (space === "world" && mobRenders.size > 0) {
        const frameMobs: { key: string; size: number; x: number; y: number }[] = [];
        let standingKey: string | null = null;
        const ptx = Math.floor(player.x);
        const pty = Math.floor(player.y);
        for (const placed of mobCache) {
          const key = mobKeyOf(placed);
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
      // ダッシュ（キーの2度押しを持ち続け / スティックの強い倒し）と泳ぎで速さと消費が変わる
      const swimming = space === "world" && isWaterAt(worldMap, player.x, player.y);
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
      const vel = { x: ix * moveSpeed, y: iy * moveSpeed };
      let prevX = player.x;
      let prevY = player.y;
      const moved = stepMove(activeMap(), player, vel, dt, activeBlocked(), { swim: space === "world" });
      player.x = moved.x;
      player.y = moved.y;
      // ノックバック: 残り速度を当たり判定つきで適用し、約0.16秒で減衰させる
      if (kbVel.x !== 0 || kbVel.y !== 0) {
        const kbMoved = stepMove(activeMap(), player, kbVel, dt, activeBlocked(), { swim: space === "world" });
        player.x = kbMoved.x;
        player.y = kbMoved.y;
        const decay = Math.max(0, 1 - dt / 0.16);
        kbVel = { x: kbVel.x * decay, y: kbVel.y * decay };
        if (Math.hypot(kbVel.x, kbVel.y) < 0.5) kbVel = { x: 0, y: 0 };
      }
      // スタミナ増減・陸の記録・入出水の波紋・水中で力尽きたら陸へ帰還
      const inWaterNow = space === "world" && isWaterAt(worldMap, player.x, player.y);
      if (space === "world" && !inWaterNow) lastLand = { x: player.x, y: player.y };
      if (inWaterNow !== wasSwimming) {
        splashes.push({ x: player.x, y: player.y, at: now });
        spawnBurst(fxSys, "splash", player.x, player.y);
        playWbSe("splash");
        wasSwimming = inWaterNow;
      }
      stamina = stepStamina(stamina, staminaUse, dt).state;
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
      if (space === "world") {
        let contact: { placed: PlacedMob; key: string; dist: number; cx: number; cy: number } | null = null;
        const ptx = Math.floor(player.x);
        const pty = Math.floor(player.y);
        for (const placed of mobCache) {
          const key = mobKeyOf(placed);
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
          if (def?.temperament === "hostile" && (isNew || now - contactFiredAt >= 1000)) {
            contactFiredAt = now;
            // 着地点へ瞬間移動させず、着地点までの方向に初速だけ与える（適用は移動ステップ側）
            postMobDamage(contact.placed.mobId, contact.placed.x, contact.placed.y);
            const target = knockbackTarget({ x: contact.cx, y: contact.cy, size: contact.placed.size }, player);
            kbVel = { x: (target.x - player.x) / 0.16, y: (target.y - player.y) / 0.16 };
            fxEventsRef.current.push({
              kind: "hit",
              x: contact.placed.x, y: contact.placed.y,
              sizeTiles: contact.placed.size,
              color: MOB_FX_COLOR[def.id],
            });
            shake = startShake(shake, 2, now);
          }
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
      }
      player.vx = (player.x - prevX) / dt;
      player.vy = (player.y - prevY) / dt;
      const speed = Math.hypot(player.vx, player.vy);
      if (player.vx < -0.2) player.face = -1;
      else if (player.vx > 0.2) player.face = 1;
      player.phase = advanceWalkPhase(player.phase, speed, dt);
      const speedRatio = Math.min(1, speed / WALK_SPEED);

      // ---- 演出の更新（行為イベントの消化・粒の前進・移動の副産物） ----
      for (const ev of fxEventsRef.current.splice(0)) {
        if (ev.kind === "whiff") {
          // 空振り: 風切りだけのスイングを再生する（粒も道具アイコンも出さない）
          swing = { startedAt: now, itemId: null, face: player.face, whiff: true };
          playWbSe("swing");
          continue;
        }
        if (ev.kind === "hit" || ev.kind === "death" || ev.kind === "spawn") {
          // モブ演出: 大きさに応じて粒をスケール。死亡は小さな揺れ、出現はポップも併用
          playWbSe(seForFxBurst(ev.kind));
          spawnMobFx(fxSys, ev.kind, ev.x + 0.5, ev.y + 0.5, { sizeTiles: ev.sizeTiles, color: ev.color });
          if (ev.kind === "death") shake = startShake(shake, 3, now);
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
              if (mdef && mdef.temperament !== "hostile") r.fleeUntil = now + 900;
            }
          }
          continue;
        }
        spawnBurst(fxSys, ev.kind, ev.x + 0.5, ev.y + 0.5);
        playWbSe(seForFxBurst(ev.kind));
        if (ev.kind === "chop" || ev.kind === "mine") shake = startShake(shake, 2, now);
        else if (ev.kind === "debris" || ev.kind === "build") shake = startShake(shake, 3, now);
        if (ev.kind === "place" || ev.kind === "build") pops.set(`${ev.x},${ev.y}`, now);
      }
      stepFx(fxSys, dt);
      const beat = stepBeatIndex(player.phase);
      if (beat !== lastBeat) {
        lastBeat = beat;
        if (speed > 0.6 && !reducedMotion) {
          if (playerSwimming) {
            spawnBurst(fxSys, "step", player.x, player.y, { color: "#bfe6ff" });
            playWbSe("splash");
          } else {
            spawnBurst(fxSys, "step", player.x, player.y + 0.05);
            playWbSe("step");
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

      // カメラ（向き先読みつきのなめらか追従）
      const lookX = player.x + player.vx * 0.35;
      const lookY = player.y + player.vy * 0.35;
      cam.x = damp(cam.x, lookX, 6, dt);
      cam.y = damp(cam.y, lookY, 6, dt);

      // 他プレイヤーの描画位置（スナップショット予測へバネでなめらかに寄せる）
      const nowMs = Date.now();
      const presenceNowMs = presenceNow();
      for (const o of others.values()) {
        o.track = stepRemoteTrack(o.track, presenceNowMs, dt, activeBounds());
        const ospeed = Math.hypot(o.track.entry.vx, o.track.entry.vy);
        o.phase = advanceWalkPhase(o.phase, ospeed, dt);
      }

      // 位置の自動保存（1タイル動いた or 5秒経過で少し動いた）
      const distFromSave = Math.hypot(player.x - lastSaved.x, player.y - lastSaved.y);
      if (distFromSave >= 1 || (distFromSave >= 0.25 && now - lastSaved.at > 5000)) {
        saveNow();
      }

      // ---- 描画 ----
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
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
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const id = mapTileAt(worldMap, tx, ty);
          const sx = toScreenX(tx);
          const sy = toScreenY(ty);
          const dungeonKey = TILE_DUNGEON[id];
          const baseTex = dungeonKey ? dungeon[dungeonKey] : textures[TILE_TEXTURE[id]];
          if (texReady(baseTex)) ctx.drawImage(baseTex, sx, sy, TILE + 1, TILE + 1);
          else {
            ctx.fillStyle = TILE_FALLBACK[id] ?? "#57a639";
            ctx.fillRect(sx, sy, TILE + 1, TILE + 1);
          }
        }
      }

      // タイル上書きの重ね描き（畑・切り株・作物の成長段階）
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const ov = tilesRef.current[tileKey(tx, ty)];
          if (!isOverrideActive(ov, nowMs)) continue;
          const sx = toScreenX(tx);
          const sy = toScreenY(ty);
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
          if (ov!.block) {
            // 設置ブロックはアイコンをタイル大で描く（ピクセル固定: 整数座標）
            // 設置直後は出現ポップ（小さく生まれて行き過ぎて収まる）
            const img = itemIcons[ov!.block.itemId];
            const bx = Math.round(sx);
            const by = Math.round(sy);
            const ps = popScaleFor(tileKey(tx, ty), now);
            ctx.save();
            if (ps !== 1) {
              ctx.translate(bx + TILE / 2, by + TILE / 2);
              ctx.scale(ps, ps);
              ctx.translate(-(bx + TILE / 2), -(by + TILE / 2));
            }
            if (texReady(img)) ctx.drawImage(img, bx, by, TILE, TILE);
            else {
              ctx.fillStyle = "#9a7b4f";
              ctx.fillRect(bx + 5, by + 5, TILE - 10, TILE - 10);
            }
            ctx.restore();
          }
        }
      }

      // ブロック/施設を選択中は、置ける隣接タイルを薄く光らせる（置ける場所を構造で示す）
      if (!buildRef.current.active) {
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
      }

      ctx.imageSmoothingEnabled = true;

      // 建築モード: 狙っているタイルの可否ハイライト
      if (buildRef.current.active && hoverTile) {
        const hx = toScreenX(hoverTile.x);
        const hy = toScreenY(hoverTile.y);
        const okTile = buildValidity(hoverTile.x, hoverTile.y);
        ctx.fillStyle = okTile ? "rgba(140,255,150,0.32)" : "rgba(255,90,90,0.32)";
        ctx.fillRect(hx, hy, TILE, TILE);
        ctx.strokeStyle = okTile ? "rgba(225,255,225,0.9)" : "rgba(255,205,205,0.9)";
        ctx.lineWidth = 2;
        ctx.strokeRect(hx + 1, hy + 1, TILE - 2, TILE - 2);
      }

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
            const id = space === "tent" ? tentTileAt(indoor.tiles, tx, ty) : lobbyTileAt(indoor.tiles, tx, ty);
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
        // 平置きオブジェクト（ワープパッド・階段・タペストリー）は足元レイヤー
        for (const o of indoor.objects) {
          if (!FLAT_LOBBY_SPRITES.has(o.sprite)) continue;
          if (o.x + o.w < lx0 || o.x > lx1 || o.y + o.h < ly0 || o.y > ly1) continue;
          drawLobbySprite(o);
        }
        ctx.imageSmoothingEnabled = true;
      }

      // ---- モブ: 配置は決定的、HP/死亡はサーバー状態、動きは見た目だけここで作る ----
      const mobDrawQueue: { placed: PlacedMob; r: MobRender; hpFrac: number }[] = [];
      const drawMob = (placed: PlacedMob, r: MobRender, hpFrac: number) => {
        const def = mobById(placed.mobId);
        if (!def) return;
        const sizePx = TILE * Math.max(1, placed.size) * 0.94;
        const bob = walkBob(r.phase) * TILE * 0.045;
        const cxp = toScreenX(r.wx) + r.kx;
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
        // 影
        ctx.fillStyle = "rgba(20,26,20,0.25)";
        ctx.beginPath();
        ctx.ellipse(cxp, baseY + sizePx * 0.02, sizePx * 0.34, sizePx * 0.12, 0, 0, Math.PI * 2);
        ctx.fill();
        // 本体: 素材スプライト（16×16、ピクセル固定・足元基準・向き反転）
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
        ctx.restore();
        // HP バー（傷ついた個体だけ）
        if (hpFrac < 1) {
          const bw = Math.max(26, w * 0.9);
          const bh2 = 4;
          const bxHp = cxp - bw / 2;
          const byHp = by - 9;
          ctx.fillStyle = "rgba(12,14,12,0.55)";
          ctx.fillRect(bxHp - 1, byHp - 1, bw + 2, bh2 + 2);
          ctx.fillStyle = hpFrac > 0.5 ? "#7ed957" : hpFrac > 0.25 ? "#f2c53c" : "#e2483a";
          ctx.fillRect(bxHp, byHp, bw * Math.max(0, hpFrac), bh2);
        }
      };
      if (space === "world") {
        const nowMs = Date.now();
        const isNight = isNightPhase(phaseAtTime(nowMs / 1000));
        const vx0 = Math.floor(cam.x - cw / TILE / 2) - 3;
        const vy0 = Math.floor(cam.y - ch / TILE / 2) - 3;
        const vx1 = Math.ceil(cam.x + cw / TILE / 2) + 3;
        const vy1 = Math.ceil(cam.y + ch / TILE / 2) + 3;
        const cacheKey = `${vx0 >> 5},${vy0 >> 5},${vx1 >> 5},${vy1 >> 5},${isNight ? 1 : 0}`;
        if (cacheKey !== mobCacheKey) {
          mobCacheKey = cacheKey;
          mobCache = visibleMobs(MAP_SEED, vx0, vy0, vx1, vy1, isNight);
          const keys = new Set(mobCache.map((m) => mobKeyOf(m)));
          for (const k of [...mobRenders.keys()]) if (!keys.has(k)) mobRenders.delete(k);
        }
        for (const placed of mobCache) {
          const def = mobById(placed.mobId);
          if (!def) continue;
          const key = mobKeyOf(placed);
          const hpNow = mobHpNow(def, mobStatesRef.current[key] ?? null, nowMs);
          if (!hpNow.alive) {
            // 死んでいる間は見た目状態を捨てる（復活時はアンカーでポップして出る）
            mobRenders.delete(key);
            continue;
          }
          let r = mobRenders.get(key);
          if (!r) {
            r = {
              ax: placed.x, ay: placed.y, wx: placed.x + 0.5, wy: placed.y + 0.5,
              tx: placed.x + 0.5, ty: placed.y + 0.5, nextThink: 0,
              phase: Math.random() * 6, face: 1, flashAt: 0, kx: 0, ky: 0, seenAt: now, fleeUntil: 0,
            };
            mobRenders.set(key, r);
            fxEventsRef.current.push({ kind: "spawn", x: placed.x, y: placed.y, sizeTiles: placed.size, color: MOB_FX_COLOR[def.id] });
          }
          // 思考: うろつき / 敵対は接近 / 被弾直後の非敵対は逃げる
          if (now >= r.nextThink) {
            r.nextThink = now + 1400 + Math.random() * 1800;
            const fleeing = now < r.fleeUntil;
            const distP = Math.hypot(player.x - r.wx, player.y - r.wy);
            if (fleeing) {
              const dx = r.wx - player.x;
              const dy = r.wy - player.y;
              const len = Math.hypot(dx, dy) || 1;
              r.tx = placed.x + 0.5 + (dx / len) * 2;
              r.ty = placed.y + 0.5 + (dy / len) * 2;
            } else if (def.temperament === "hostile" && distP < 5 && placed.size < 4) {
              r.tx = player.x;
              r.ty = player.y;
            } else if (placed.size < 4) {
              const ang = Math.random() * Math.PI * 2;
              const rad = Math.random() * 1.3;
              r.tx = placed.x + 0.5 + Math.cos(ang) * rad;
              r.ty = placed.y + 0.5 + Math.sin(ang) * rad;
            } else {
              r.tx = placed.x + 0.5;
              r.ty = placed.y + 0.5;
            }
          }
          const fleeing = now < r.fleeUntil;
          const chasing = def.temperament === "hostile" && Math.hypot(player.x - r.wx, player.y - r.wy) < 5;
          const speed = fleeing ? 1.7 : chasing ? 1.12 : 0.55;
          const dx = r.tx - r.wx;
          const dy = r.ty - r.wy;
          const distT = Math.hypot(dx, dy);
          // 敵対はプレイヤーに重ならない（手前で止まる）
          const stopAt = chasing && !fleeing ? 0.85 : 0.05;
          if (distT > stopAt) {
            const step = Math.min(distT - (chasing && !fleeing ? stopAt : 0), speed * dt);
            r.wx += (dx / distT) * step;
            r.wy += (dy / distT) * step;
            r.phase = advanceWalkPhase(r.phase, speed, dt);
            if (dx < -0.02) r.face = -1;
            else if (dx > 0.02) r.face = 1;
          }
          r.kx *= Math.exp(-9 * dt);
          r.ky *= Math.exp(-9 * dt);
          mobDrawQueue.push({ placed, r, hpFrac: hpNow.hp / def.hp });
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
            ),
        });
      }
      if (space === "world") {
        for (const b of buildingsRef.current.buildings) {
          const color = nationsRef.current.playerNations[b.ownerId]?.color ?? "#888888";
          drawList.push({
            y: b.y + 1,
            draw: () => {
              const ps = popScaleFor(`${b.x},${b.y}`, now);
              if (ps === 1) {
                drawBuilding(ctx, toScreenX(b.x), toScreenY(b.y), b.type, color);
                return;
              }
              ctx.save();
              const cxp = toScreenX(b.x) + TILE / 2;
              const cyp = toScreenY(b.y) + TILE;
              ctx.translate(cxp, cyp);
              ctx.scale(ps, ps);
              ctx.translate(-cxp, -cyp);
              drawBuilding(ctx, toScreenX(b.x), toScreenY(b.y), b.type, color);
              ctx.restore();
            },
          });
        }
      }
      if (space !== "world") {
        for (const o of indoorData().objects) {
          if (FLAT_LOBBY_SPRITES.has(o.sprite)) continue;
          const sx = lobbyOx + o.x * TILE;
          const sy = lobbyOy + o.y * TILE;
          if (sx < -TILE * 4 || sy < -TILE * 4 || sx > cw + TILE * 4 || sy > ch + TILE * 4) continue;
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
        drawList.push({ y: q.r.wy, draw: () => drawMob(q.placed, q.r, q.hpFrac) });
      }
      drawList.push({
        y: player.y + PLAYER_RADIUS,
        draw: () =>
          drawAvatar(
            ctx,
            space !== "world" ? Math.round(lobbyOx + player.x * TILE) : toScreenX(player.x),
            // 足元は当たり円の底（中心 + 半径）に合わせる（中心に置くと手前で止まって見える）
            space !== "world" ? Math.round(lobbyOy + player.y * TILE) + TILE * PLAYER_RADIUS : toScreenY(player.y) + TILE * PLAYER_RADIUS,
            player.face, player.phase, speedRatio, null, null, playerSwimming,
          ),
      });
      drawList.sort((a, b) => a.y - b.y);
      for (const d of drawList) d.draw();

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
        const kind = weatherAmbientKind(weatherAt(nowSec), ptile, ptile === T_TREE || ptile === T_SNOW_TREE, nightAmount(phase));
        const ax0 = cam.x - cw / TILE / 2 - 1;
        const ax1 = cam.x + cw / TILE / 2 + 1;
        const ay0 = cam.y - ch / TILE / 2 - 1;
        const pk = phaseKind(phase);
        if (lastPhaseKind !== "" && pk !== lastPhaseKind) {
          for (let i = 0; i < 4; i++) spawnAmbient(fxSys, kind, ax0, ax1, ay0);
        }
        lastPhaseKind = pk;
        spawnAmbient(fxSys, kind, ax0, ax1, ay0);
        if (kind === "rain") {
          // 雨は密度を上げる（速く落ちるので数を足しても上限に触れない）
          spawnAmbient(fxSys, kind, ax0, ax1, ay0);
          spawnAmbient(fxSys, kind, ax0, ax1, ay0);
        }
      }
      drawParticles(false);

      // 道具スイングと風切り（自分のタップへの応答。ワールドのみ）
      if (space === "world") {
        const sk = swingProgress(swing.startedAt, now);
        if (sk < 1) {
          const cxp = toScreenX(player.x);
          const cyp = toScreenY(player.y) - TILE * 0.45;
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

      // 昼夜の薄い色づけ（共有時計。ロビーは屋内なので付けない）
      const night = nightAmount(phaseAtTime(nowMs / 1000));
      if (space === "world" && night > 0.01) {
        ctx.fillStyle = `rgba(9,13,42,${(night * 0.36).toFixed(3)})`;
        ctx.fillRect(0, 0, cw, ch);
      }
      // 光る粒（蛍・ワープの光）は夜の色づけの上に出す
      if (space === "world") drawParticles(true);

      // スティック（固定基点。建築モードでは入力ごと無効なので描かない）
      if (!buildRef.current.active) {
        const base = stickBase(cw, ch);
        ctx.fillStyle = joy.active ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.08)";
        ctx.beginPath();
        ctx.arc(base.x, base.y, 52, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = joy.active ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.22)";
        ctx.beginPath();
        ctx.arc(base.x + joy.dx * 34, base.y + joy.dy * 34, 22, 0, Math.PI * 2);
        ctx.fill();
      }

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
          // 建物は所有者の所属色（無所属は灰色）の小ドット
          for (const b of buildingsRef.current.buildings) {
            const mx = toMapX(b.x);
            const my = toMapY(b.y);
            if (mx < -2 || my < -2 || mx > mm.width + 2 || my > mm.height + 2) continue;
            mctx.fillStyle = nationsRef.current.playerNations[b.ownerId]?.color ?? "#d8d8d8";
            mctx.fillRect(mx, my, 2, 2);
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
          // 建物は所有者の所属色（無所属は灰色）の小ドット
          for (const b of buildingsRef.current.buildings) {
            const mx = toMapX(b.x);
            const my = toMapY(b.y);
            if (mx < -4 || my < -4 || mx > bm.width + 4 || my > bm.height + 4) continue;
            bctx.fillStyle = nationsRef.current.playerNations[b.ownerId]?.color ?? "#d8d8d8";
            bctx.fillRect(mx - 1, my - 1, 2.5, 2.5);
          }
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
    raf = requestAnimationFrame(loop);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
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
    minHeight: 40, padding: "6px 14px", borderRadius: 10, cursor: "pointer",
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
  /** スロット枠（中身はスプライトのみ。SlotContent と対で使う）。
   *  サイズは --slot（ホットバー側で画面幅に合わせて決める）に従い、狭い画面では縮む。 */
  const slotBox: React.CSSProperties = {
    ...btn, position: "relative", boxSizing: "border-box",
    width: "var(--slot, 42px)", height: "var(--slot, 42px)", minHeight: "var(--slot, 42px)", padding: 2,
    display: "flex", alignItems: "center", justifyContent: "center",
    color: "#fff", background: "rgba(255,255,255,0.08)",
  };
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
        <SlotContent slot={slot} />
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
        <SlotContent slot={slot} />
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
      id: "nations",
      label: showNations ? "建築を閉じる" : "建築",
      show: spaceUi === "world",
      run: () => setShowNations((v) => !v),
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
        {gate === "checking" ? (
          <p role="status" style={{ margin: 0 }}>
            読み込み中…
          </p>
        ) : (
          <>
            <p role="status" style={{ margin: 0 }}>
              ログインが必要
            </p>
            <a
              href="/api/auth/discord/authorize?next=/games/worldbox"
              style={{
                ...btn, textDecoration: "none", display: "inline-flex", alignItems: "center",
              }}
            >
              Discordでログイン
            </a>
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
            position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)",
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
          onClick={() => setMenuOpen((v) => !v)}
          style={{
            ...btn, position: "absolute", left: 10, top: 10, minHeight: 40, minWidth: 44, zIndex: 7,
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
              ...btn, position: "absolute", right: 10, top: 10, minHeight: 40, zIndex: 5,
              padding: "4px 12px", fontSize: 12, lineHeight: 1, background: "rgba(0,0,0,0.55)", color: "#fff",
            }}
          >
            {isFullscreen ? "戻す" : "全画面"}
          </button>
        )}
        {menuOpen && (
          <div
            style={{
              position: "absolute", left: 10, top: 58, display: "grid", gap: 6, padding: 8,
              borderRadius: 10, background: "rgba(0,0,0,0.72)", color: "#fff", zIndex: 8,
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
            <Link
              href={`${prefix}/games`}
              style={{
                ...btn, background: "rgba(255,255,255,0.10)", color: "#fff",
                textDecoration: "none", textAlign: "center",
              }}
            >
              ゲーム一覧へ
            </Link>
          </div>
        )}
        {spaceUi !== "world" && stationUi && (
          <div
            style={{
              position: "absolute", left: "50%", bottom: 10, transform: "translateX(-50%)",
              display: "flex", gap: 8, alignItems: "center", padding: "6px 8px 6px 14px",
              borderRadius: 10, background: "rgba(0,0,0,0.6)", color: "#fff", fontSize: 13, whiteSpace: "nowrap",
            }}
          >
            <span>{stationUi === "shop" && stationGenre ? (genreById(stationGenre)?.name ?? STATION_LABEL[stationUi]) : STATION_LABEL[stationUi]}</span>
            {stationUi === "board" && (
              <button
                type="button"
                style={{ ...btn, minHeight: 32, padding: "2px 10px" }}
                onClick={() => setBoardOpen((v) => !v)}
              >
                {boardOpen ? "閉じる" : "開く"}
              </button>
            )}
            {stationUi === "casino" && (
              <button
                type="button"
                style={{ ...btn, minHeight: 32, padding: "2px 10px" }}
                onClick={() => setCasinoOpen((v) => !v)}
              >
                {casinoOpen ? "閉じる" : "遊ぶ"}
              </button>
            )}
            {stationUi === "guild" && (
              <button
                type="button"
                style={{ ...btn, minHeight: 32, padding: "2px 10px" }}
                onClick={() => setGuildBoardOpen((v) => !v)}
              >
                {guildBoardOpen ? "閉じる" : "開く"}
              </button>
            )}
            {(stationUi === "shop" || stationUi === "bank" || stationUi === "smith") && (
              <button
                type="button"
                style={{ ...btn, minHeight: 32, padding: "2px 10px" }}
                onClick={() => setShowEconomy(true)}
              >
                開く
              </button>
            )}
            {stationUi === "arena" && (
              <button
                type="button"
                style={{ ...btn, minHeight: 32, padding: "2px 10px" }}
                onClick={() => setArenaOpen((v) => !v)}
              >
                {arenaOpen ? "閉じる" : "戦う"}
              </button>
            )}
            {stationUi === "fountain" && (
              <button
                type="button"
                style={{ ...btn, minHeight: 32, padding: "2px 10px" }}
                onClick={() => void plazaAction("fountain")}
              >
                コインを投げる（10）
              </button>
            )}
            {stationUi === "rest" && (
              <button
                type="button"
                style={{ ...btn, minHeight: 32, padding: "2px 10px" }}
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
              position: "absolute", right: 10, top: 10, width: 112, height: 112,
              borderRadius: 10, border: "1px solid rgba(255,255,255,0.35)",
              background: "rgba(0,0,0,0.25)", pointerEvents: "none",
            }}
          />
        )}
        {buildMode && (
          <div
            style={{
              position: "absolute", left: 10, bottom: 10, display: "flex", gap: 8, alignItems: "center",
              padding: "6px 8px 6px 12px", borderRadius: 10, background: "rgba(0,0,0,0.6)",
              color: "#fff", fontSize: 13, maxWidth: "calc(100% - 20px)", boxSizing: "border-box",
            }}
          >
            <span>
              {buildTool === "demolish" ? "取り壊し：建物をタップ" : `建築：${BUILD_TOOL_LABEL[buildTool]}を置く場所をタップ`}
            </span>
            <button type="button" style={{ ...btn, minHeight: 32, padding: "2px 10px" }} onClick={endBuildMode}>
              終了
            </button>
          </div>
        )}
        {invProfile && (
          <div
            aria-label="HPと空腹度"
            style={{
              position: "absolute", left: 10, top: 52, display: "flex", flexDirection: "column", gap: 4,
              padding: "6px 8px", borderRadius: 10, background: "rgba(0,0,0,0.6)", zIndex: 4,
              pointerEvents: "none", minWidth: 132,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "#ff8a7a", fontSize: 11, width: 28 }}>HP</span>
              <span style={{ flex: 1, height: 8, borderRadius: 4, background: "rgba(255,255,255,0.18)", overflow: "hidden" }}>
                <span style={{ display: "block", width: `${Math.max(0, Math.min(100, (invProfile.hp / HP_MAX) * 100))}%`, height: "100%", background: invProfile.hp <= 25 ? "#e2483a" : "#7ed957" }} />
              </span>
              <strong style={{ color: "#fff", fontSize: 11 }}>{invProfile.hp}</strong>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "#ffd23e", fontSize: 11, width: 28 }}>空腹</span>
              <span style={{ flex: 1, height: 8, borderRadius: 4, background: "rgba(255,255,255,0.18)", overflow: "hidden" }}>
                <span style={{ display: "block", width: `${Math.max(0, Math.min(100, (invProfile.hunger / HUNGER_MAX) * 100))}%`, height: "100%", background: invProfile.hunger <= 20 ? "#ff7a59" : "#ffd23e" }} />
              </span>
              <strong style={{ color: "#fff", fontSize: 11 }}>{invProfile.hunger}</strong>
            </div>
            {invProfile.status.some((e) => e.kind === "poison") && (
              <span style={{ color: "#b6f26d", fontSize: 11 }}>毒</span>
            )}
          </div>
        )}
        {spaceUi === "world" && invProfile && (
          <div
            style={{
              position: "absolute", left: "50%", bottom: 10, transform: "translateX(-50%)",
              display: "flex", gap: 4, alignItems: "stretch", padding: 4, borderRadius: 10,
              background: "rgba(0,0,0,0.6)", zIndex: 4, maxWidth: "calc(100% - 16px)",
              boxSizing: "border-box",
              // スロットは画面幅でスケーリングする（縦画面ではみ出さない）
              ...({ "--slot": "clamp(30px, 10.5vw, 42px)" } as React.CSSProperties),
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
                <SlotContent slot={slot} />
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
        {tileMsg && (
          <div
            role="status"
            style={{
              position: "absolute", left: "50%", bottom: 58, transform: "translateX(-50%)",
              padding: "4px 12px", borderRadius: 10, background: "rgba(0,0,0,0.6)",
              color: "#fff", fontSize: 13, whiteSpace: "nowrap", zIndex: 4,
              maxWidth: "calc(100% - 16px)", boxSizing: "border-box", overflow: "hidden", textOverflow: "ellipsis",
            }}
          >
            {tileMsg}
          </div>
        )}
      {storageOpen && invProfile && (
        <div style={{ ...panelOverlay, width: "min(330px, calc(100% - 20px))" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
        <div style={{ ...panelOverlay, width: "min(330px, calc(100% - 20px))" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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

      {seedPicker && invProfile && (
        <div style={panelOverlay}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <strong>種</strong>
            <span style={{ flex: 1 }} />
            <button type="button" style={btn} onClick={() => setSeedPicker(null)}>
              閉じる
            </button>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
            {CROPS.filter((c) => countItem(invProfile, c.seedId) > 0).map((c) => (
              <button
                key={c.id}
                type="button"
                style={btn}
                onClick={() => {
                  void postTileAction("plant", seedPicker.x, seedPicker.y, c.seedId);
                  setSeedPicker(null);
                }}
              >
                <ItemIcon id={c.seedId} size={20} />
                {itemById(c.seedId)?.name ?? c.seedId} ×{countItem(invProfile, c.seedId)}
              </button>
            ))}
            {CROPS.every((c) => countItem(invProfile, c.seedId) === 0) && (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>種がない</p>
            )}
          </div>
        </div>
      )}

      {boardOpen && spaceUi === "lobby" && (
        <div style={panelOverlay}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
        <div style={panelOverlay}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <strong>マップ</strong>
            <span className="muted">あなたの座標 X {coords.x} / Y {coords.y}</span>
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
            style={{
              width: "100%", height: "auto", display: "block", marginTop: 10,
              borderRadius: 10, border: "1px solid rgba(255,255,255,0.35)", background: "rgba(0,0,0,0.25)",
            }}
          />
        </div>
      )}

      {/* パネルの開閉は左上の ≡ メニューに統合（ボタン行は置かない） */}

      {showNations && (
        <div style={panelOverlay}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <strong>建築</strong>
            <span style={{ flex: 1 }} />
            <button type="button" style={btn} onClick={() => setShowNations(false)}>
              閉じる
            </button>
          </div>
          {buildingsUi.loggedIn && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              <span className="muted" style={{ fontSize: 13 }}>建築</span>
              <span className="muted" style={{ fontSize: 13 }}>
                建物 {buildingsUi.buildings.filter((b) => b.mine).length}/{USER_BUILDING_CAP}
              </span>
              {(["house", "farm", "tower", "demolish"] as const).map((tool) => (
                <button
                  key={tool}
                  type="button"
                  style={{
                    ...btn,
                    ...(buildMode && buildTool === tool
                      ? { background: "rgba(255,210,62,0.25)", border: "1px solid rgba(255,210,62,0.7)" }
                      : {}),
                  }}
                  onClick={() => chooseBuildTool(tool)}
                >
                  {BUILD_TOOL_LABEL[tool]}
                </button>
              ))}
              {buildMode && (
                <button type="button" style={btn} onClick={endBuildMode}>
                  建築を終わる
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {showEconomy && <WorldBoxEconomyPanel space={spaceUi} station={stationUi} genre={stationGenre} onClose={() => setShowEconomy(false)} />}
      {casinoOpen && spaceUi === "lobby" && (
        <WorldBoxCasinoPanel onClose={() => setCasinoOpen(false)} />
      )}
      {arenaOpen && spaceUi === "lobby" && (
        <WorldBoxArenaPanel onClose={() => setArenaOpen(false)} />
      )}
      {guildBoardOpen && spaceUi === "lobby" && (
        <WorldBoxGuildBoardPanel
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
