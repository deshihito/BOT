"use client";
// AGO WORLD BOX（見下ろし型・共有ワールド）。
// 世界は固定シードから生成される 1024×1024 の1枚マップで、全員が同じ場所を歩く。
// 移動は8方向フリー（スティック＋WASD）、他プレイヤーはプレゼンス API 経由で
// アバター＋名前つきで表示される（同時接続）。セーブは空間＋位置（v6）。
// ロビーは別空間（図形の和集合のホール＋ショップ翼2階）で、ワープパッドと
// ≡ メニューで行き来する。ロビーの描画はピクセル固定（整数座標・補間オフ）。
// ゲームループと描画は canvas + refs で回し、React state は HUD 表示だけに使う。
// 純粋ロジックは lib/worldbox/ に分離（生成・移動・プレゼンス・保存）。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  MAP_H, MAP_SEED, MAP_W, MINIMAP_SIZE, T_DIRT, T_GRASS, T_ROCK, T_SAND, T_SNOW, T_SNOW_TREE, T_TREE, T_WATER,
  generateMap, mapSpawn, mapTileAt, sampleMinimapTiles, type TopDownMap,
} from "@/lib/worldbox/mapgen";
import { DASH_SPEED, SWIM_DASH_SPEED, SWIM_SPEED, WALK_SPEED, findFreeNear, isWaterAt, stepMove } from "@/lib/worldbox/move";
import { nightAmount, phaseAtTime } from "@/lib/worldbox/daynight";
import { advanceWalkPhase, damp, moveLean, walkBob, walkSquashY } from "@/lib/worldbox/anim";
import type { PresenceEntry } from "@/lib/worldbox/presence";
import {
  STAMINA_MAX, canDash, createStamina, createTapTracker, isStickDash, registerKeyTap, rescueStamina,
  staminaGaugeVisible, stepStamina, type StaminaState, type StaminaUse, type TapTracker,
} from "@/lib/worldbox/stamina";
import { createRemoteTrack, stepRemoteTrack, updateRemoteTrack, type RemoteTrack } from "@/lib/worldbox/remote";
import type { NationRole, NationView, NationsResponse } from "@/lib/worldbox/nations";
import { USER_BUILDING_CAP, isSpawnPlazaTile, type BuildingType, type BuildingView } from "@/lib/worldbox/buildings";
import {
  L_PLAZA, L_SAND, L_VOID,
  LOBBY_ENTRY, LOBBY_FLOOR_FALLBACK, LOBBY_FLOOR_SPRITE, LOBBY_STAIRS_DOWN, LOBBY_STAIRS_UP,
  LOBBY_DOWN_LANDING, LOBBY_UP_LANDING, LOBBY_WARP_PAD, WORLD_WARP_PAD,
  buildLobby, lobbyTileAt, stationNear, type LobbyObject, type LobbyStation,
} from "@/lib/worldbox/lobby";
import type { BoardPost } from "@/lib/worldbox/board";
import { parseSave, serializeSave, type SaveSpace } from "@/lib/worldbox/save";
import { chooseInitialSave } from "@/lib/worldbox/save-source";
import {
  actionForTile, cropStage, isOverrideActive, placedBlockSolid, tileKey, tileView,
  type TileActionKind, type TileOverridesMap,
} from "@/lib/worldbox/tiles";
import { CROPS, ITEMS, itemById } from "@/lib/worldbox/items";
import { countItem, type ItemSlot, type PlayerProfile, type SlotRef } from "@/lib/worldbox/profile";
import { loadDungeonTiles, loadFarmSprites, loadLobbySprites, loadTextures } from "@/lib/worldbox/textures";
import { useGamesNav } from "../GamesShell";
import WorldBoxEconomyPanel from "./WorldBoxEconomyPanel";

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
/** ミニマップ上の1タイルの大きさ（256px / 1024タイル）。 */
const MINIMAP_SCALE = MINIMAP_SIZE / MAP_W;
/** マップ表示モード（全体を大きく見る）のキャンバス解像度と縮尺。 */
const BIGMAP_SIZE = 512;
const BIGMAP_SCALE = BIGMAP_SIZE / MAP_W;

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

const ROLE_LABEL: Record<NationRole, string> = { king: "王", minister: "大臣", citizen: "国民" };

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
  unauthorized: "ログインが必要です",
  tile_blocked: "そこには建てられません",
  cap_reached: "建築上限に達しています",
  forbidden: "その権限がありません",
  invalid_type: "建物の種類が不正です",
  on_capital: "首都には建てられません",
  on_spawn: "スポーン広場には建てられません",
};

/** タイル行為の失敗ラベル（断片のみ）。 */
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
  on_spawn: "広場には置けない",
  not_enough_items: "足りない",
  too_far: "遠すぎる",
  unauthorized: "ログインが必要",
  tiles_unavailable: "いま使えない",
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
  shop: "ショップ",
  bank: "銀行",
  casino: "カジノ",
  arena: "闘技場",
  smith: "鍛冶屋",
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
  const playerPosRef = useRef({ x: MAP_W / 2 + 0.5, y: MAP_H / 2 + 0.5 });
  const [nationsUi, setNationsUi] = useState<NationsResponse>(EMPTY_NATIONS);
  const [showNations, setShowNations] = useState(false);
  const [showEconomy, setShowEconomy] = useState(false);
  // マップ表示モード（全体マップを大きく見る。描画ループは ref で見る）
  const [mapView, setMapView] = useState(false);
  const mapViewRef = useRef(false);
  mapViewRef.current = mapView;
  const bigMapRef = useRef<HTMLCanvasElement | null>(null);
  // 座標表示（タイル単位の整数。ループが毎フレーム書く playerPosRef から拾う）
  const [coords, setCoords] = useState({ x: Math.floor(MAP_W / 2), y: Math.floor(MAP_H / 2) });
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
  const [craftOpen, setCraftOpen] = useState(false);

  // 空間（ワールド / ロビー）とハンバーガーメニュー、ステーション、掲示板
  const [spaceUi, setSpaceUi] = useState<SaveSpace>("world");
  const [menuOpen, setMenuOpen] = useState(false);
  const [stationUi, setStationUi] = useState<LobbyStation | null>(null);
  const warpActionRef = useRef<(target: SaveSpace) => void>(() => {});
  const [boardOpen, setBoardOpen] = useState(false);
  const [boardPosts, setBoardPosts] = useState<BoardPost[]>([]);
  const [boardLoggedIn, setBoardLoggedIn] = useState(false);
  const [boardText, setBoardText] = useState("");
  const [boardMsg, setBoardMsg] = useState("");
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
        return;
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
  const [seedPicker, setSeedPicker] = useState<{ x: number; y: number } | null>(null);
  const [tileMsg, setTileMsg] = useState("");
  const tilesRef = useRef<TileOverridesMap>({});
  const tilesVersionRef = useRef(0);
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
  const refreshTiles = async () => {
    try {
      const px = Math.floor(playerPosRef.current.x);
      const py = Math.floor(playerPosRef.current.y);
      const x0 = Math.max(0, Math.min(MAP_W - 128, px - 64));
      const y0 = Math.max(0, Math.min(MAP_H - 128, py - 64));
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
        return;
      }
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
    }
  };
  const postTileActionRef = useRef(postTileAction);
  postTileActionRef.current = postTileAction;
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

  useEffect(() => {
    void refreshNations();
    void refreshBuildings();
    void refreshInv();
    void refreshTiles();
    const timer = window.setInterval(() => {
      void refreshNations();
      void refreshBuildings();
      void refreshInv();
      void refreshTiles();
    }, 15000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const map: TopDownMap = generateMap(MAP_SEED);
    const lobby = buildLobby();
    const textures = loadTextures();
    const dungeon = loadDungeonTiles();
    const lobbySprites = loadLobbySprites();
    const farmSprites = loadFarmSprites();
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

    // 実効マップ: 生成地形へタイル上書き（伐採・採掘の地形置き換え）を
    // 適用したもの。移動・描画・建築可否はこちらを見る。
    const effTiles = new Uint8Array(map.tiles);
    const effMap: TopDownMap = { seed: map.seed, width: map.width, height: map.height, tiles: effTiles };
    let effVersion = -1;
    const syncEffMap = () => {
      if (effVersion === tilesVersionRef.current) return;
      effVersion = tilesVersionRef.current;
      effTiles.set(map.tiles);
      const now = Date.now();
      for (const [key, ov] of Object.entries(tilesRef.current)) {
        if (!isOverrideActive(ov, now) || ov.tile === undefined) continue;
        const m = /^(-?\d+),(-?\d+)$/.exec(key);
        if (!m) continue;
        const x = Number(m[1]);
        const y = Number(m[2]);
        if (x >= 0 && y >= 0 && x < MAP_W && y < MAP_H) effTiles[y * MAP_W + x] = ov.tile;
      }
    };

    const spawn = mapSpawn(map);
    const player: PlayerState = { x: spawn.x, y: spawn.y, vx: 0, vy: 0, face: 1, phase: 0 };
    const cam = { x: player.x, y: player.y };
    // 空間（ワールド / ロビー）。ロビーでは建物・国家・ミニマップは扱わない。
    let space: SaveSpace = "world";
    let worldReturn: { x: number; y: number } | null = null;
    const activeMap = (): TopDownMap => (space === "lobby" ? lobby.moveMap : effMap);
    const activeBlocked = (): ReadonlySet<string> | undefined =>
      space === "lobby" ? lobby.blocked : blockedRef.current;
    const keys = new Set<string>();
    const joy = { active: false, pointerId: -1, baseX: 0, baseY: 0, dx: 0, dy: 0 };
    const others = new Map<string, OtherRender>();
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
      setStatusText(space === "lobby" ? "ロビー" : "共有ワールド");
    })();

    // ---- プレゼンス（空間ごとに分ける。他空間の者は受け取らない） ----
    const sendHeartbeat = () => {
      if (!loggedIn) return;
      fetch("/api/worldbox/presence", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "", x: player.x, y: player.y, vx: player.vx, vy: player.vy, face: player.face, space }),
      }).catch(() => { /* noop */ });
    };
    const pollOthers = async () => {
      try {
        const res = await fetch(`/api/worldbox/presence?space=${space}`, { headers: { Accept: "application/json" } });
        if (!res.ok) return;
        const body = (await res.json()) as { players?: PresenceEntry[] };
        if (disposed) return;
        const seen = new Set<string>();
        for (const entry of body.players ?? []) {
          seen.add(entry.id);
          const cur = others.get(entry.id);
          if (!cur) {
            others.set(entry.id, { track: createRemoteTrack(entry, Date.now(), activeMap()), phase: 0 });
          } else {
            cur.track = updateRemoteTrack(cur.track, entry, Date.now(), activeMap());
          }
        }
        for (const id of [...others.keys()]) {
          if (!seen.has(id)) others.delete(id);
        }
        setOthersCount(others.size);
      } catch { /* noop */ }
    };
    const leavePresence = () => {
      if (!loggedIn) return;
      fetch("/api/worldbox/presence", { method: "DELETE", keepalive: true }).catch(() => { /* noop */ });
    };
    const heartbeatTimer = window.setInterval(sendHeartbeat, 1000);
    const pollTimer = window.setInterval(pollOthers, 2000);
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
    const handleTileTap = (t: { x: number; y: number }): boolean => {
      const prof = invRef.current;
      if (!prof) return false;
      const px = Math.floor(player.x);
      const py = Math.floor(player.y);
      if (Math.max(Math.abs(t.x - px), Math.abs(t.y - py)) > 1) return false;
      const view = tileView(map, tilesRef.current, t.x, t.y, Date.now(), null);
      // 自分のブロックかどうかは、サーバーが返した自分の ID で判定する
      if (view.block) {
        const ov = tilesRef.current[tileKey(t.x, t.y)];
        view.block = {
          ...view.block,
          mine: selfIdRef.current !== null && ov?.block?.ownerId === selfIdRef.current,
        };
      }
      const slot = prof.hotbar[selSlotRef.current] ?? null;
      const selItem = slot ? itemById(slot.id) : null;
      const act = actionForTile(view, {
        tool: selItem?.tool,
        seedId: selItem && selItem.category === "seed" ? selItem.id : undefined,
        blockId: selItem && (selItem.category === "block" || selItem.facility) ? selItem.id : undefined,
      });
      if (!act) return false;
      if (act.action === "plant-picker") {
        setSeedPicker({ x: t.x, y: t.y });
        return true;
      }
      void postTileActionRef.current(act.action, t.x, t.y, act.seedId, act.itemId);
      return true;
    };
    const onPointerDown = (e: PointerEvent) => {
      if (buildRef.current.active && space === "world") {
        // 建築モードではタップそのものが確定（スティックは無効）
        const t = toTile(e);
        hoverTile = t;
        if (t.x >= 0 && t.y >= 0 && t.x < MAP_W && t.y < MAP_H) {
          buildActionRef.current(buildRef.current.tool, t.x, t.y);
        }
        return;
      }
      if (space === "world" && handleTileTap(toTile(e))) return;
      const p = canvasPos(e);
      if (p.x > p.w * 0.62) return; // スティックは左寄りだけ
      joy.active = true;
      joy.pointerId = e.pointerId;
      joy.baseX = p.x;
      joy.baseY = p.y;
      joy.dx = 0;
      joy.dy = 0;
      canvas.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (buildRef.current.active && space === "world") {
        hoverTile = toTile(e);
        return;
      }
      if (!joy.active || e.pointerId !== joy.pointerId) return;
      const p = canvasPos(e);
      const R = 52;
      let dx = (p.x - joy.baseX) / R;
      let dy = (p.y - joy.baseY) / R;
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        dx /= len;
        dy /= len;
      }
      joy.dx = dx;
      joy.dy = dy;
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

    // ---- ミニマップ地形（1回だけ描く。1024×1024 を 256×256 へ間引いた
    // オフスクリーンに描き、毎フレームはこれを転写するだけにする） ----
    const terrainCanvas = document.createElement("canvas");
    terrainCanvas.width = MINIMAP_SIZE;
    terrainCanvas.height = MINIMAP_SIZE;
    {
      const tctx = terrainCanvas.getContext("2d");
      if (tctx) {
        const sampled = sampleMinimapTiles(map);
        for (let y = 0; y < MINIMAP_SIZE; y++) {
          for (let x = 0; x < MINIMAP_SIZE; x++) {
            tctx.fillStyle = MINIMAP_COLOR[sampled[y * MINIMAP_SIZE + x]] ?? "#57a639";
            tctx.fillRect(x, y, 1, 1);
          }
        }
      }
    }

    // ---- マップ表示モード用地形（512×512 へ間引いて1回だけ描く） ----
    const bigTerrainCanvas = document.createElement("canvas");
    bigTerrainCanvas.width = BIGMAP_SIZE;
    bigTerrainCanvas.height = BIGMAP_SIZE;
    {
      const tctx = bigTerrainCanvas.getContext("2d");
      if (tctx) {
        const sampled = sampleMinimapTiles(map, BIGMAP_SIZE);
        for (let y = 0; y < BIGMAP_SIZE; y++) {
          for (let x = 0; x < BIGMAP_SIZE; x++) {
            tctx.fillStyle = MINIMAP_COLOR[sampled[y * BIGMAP_SIZE + x]] ?? "#57a639";
            tctx.fillRect(x, y, 1, 1);
          }
        }
      }
    }

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
      if (isSpawnPlazaTile(map, tx, ty)) return false;
      const t = mapTileAt(effMap, tx, ty);
      if (t !== T_GRASS && t !== T_DIRT && t !== T_SAND) return false;
      if (data.buildings.some((v) => v.x === tx && v.y === ty)) return false;
      if (data.buildings.filter((v) => v.mine).length >= USER_BUILDING_CAP) return false;
      return true;
    };

    // ---- 空間移動（ワープパッド・階段・ハンバーガーメニュー） ----
    let lastTileKey = "";
    let lastStation: LobbyStation | null = null;
    const placePlayer = (x: number, y: number) => {
      syncEffMap();
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
        placePlayer(LOBBY_ENTRY.x, LOBBY_ENTRY.y);
      } else {
        space = "world";
        setSpaceUi("world");
        setStatusText("共有ワールド");
        lastStation = null;
        setStationUi(null);
        const dest = worldReturn ?? spawn;
        placePlayer(dest.x, dest.y);
      }
      void pollOthers();
    };
    warpActionRef.current = doWarp;
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
        if (tx === WORLD_WARP_PAD.x && ty === WORLD_WARP_PAD.y) doWarp("lobby");
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
      syncEffMap();
      // ダッシュ（キーの2度押しを持ち続け / スティックの強い倒し）と泳ぎで速さと消費が変わる
      const swimming = space === "world" && isWaterAt(effMap, player.x, player.y);
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
      // スタミナ増減・陸の記録・入出水の波紋・水中で力尽きたら陸へ帰還
      const inWaterNow = space === "world" && isWaterAt(effMap, player.x, player.y);
      if (space === "world" && !inWaterNow) lastLand = { x: player.x, y: player.y };
      if (inWaterNow !== wasSwimming) {
        splashes.push({ x: player.x, y: player.y, at: now });
        wasSwimming = inWaterNow;
      }
      stamina = stepStamina(stamina, staminaUse, dt).state;
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
        saveNow();
      }
      checkTileTriggers();
      if (space === "lobby") {
        const st = stationNear(lobby.objects, Math.floor(player.x), Math.floor(player.y));
        if (st !== lastStation) {
          lastStation = st;
          setStationUi(st);
        }
      }
      player.vx = (player.x - prevX) / dt;
      player.vy = (player.y - prevY) / dt;
      const speed = Math.hypot(player.vx, player.vy);
      if (player.vx < -0.2) player.face = -1;
      else if (player.vx > 0.2) player.face = 1;
      player.phase = advanceWalkPhase(player.phase, speed, dt);
      const speedRatio = Math.min(1, speed / WALK_SPEED);
      playerPosRef.current.x = player.x;
      playerPosRef.current.y = player.y;

      // カメラ（向き先読みつきのなめらか追従）
      const lookX = player.x + player.vx * 0.35;
      const lookY = player.y + player.vy * 0.35;
      cam.x = damp(cam.x, lookX, 6, dt);
      cam.y = damp(cam.y, lookY, 6, dt);

      // 他プレイヤーの描画位置（スナップショット予測へバネでなめらかに寄せる）
      const nowMs = Date.now();
      for (const o of others.values()) {
        o.track = stepRemoteTrack(o.track, nowMs, dt, activeMap());
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
      const toScreenX = (wx: number) => (wx - cam.x) * TILE + cw / 2;
      const toScreenY = (wy: number) => (wy - cam.y) * TILE + ch / 2;
      // ロビー描画用: カメラを整数ピクセルへスナップした原点（ピクセル固定）
      let lobbyOx = 0;
      let lobbyOy = 0;
      let drawLobbySprite: (o: LobbyObject) => void = () => {};
      if (space === "world") {
      const tx0 = Math.max(0, Math.floor(cam.x - cw / TILE / 2 - 1));
      const tx1 = Math.min(MAP_W - 1, Math.ceil(cam.x + cw / TILE / 2 + 1));
      const ty0 = Math.max(0, Math.floor(cam.y - ch / TILE / 2 - 1));
      const ty1 = Math.min(MAP_H - 1, Math.ceil(cam.y + ch / TILE / 2 + 1));
      // 流用タイルはピクセルアートなので補間を切ってクッキリ描く（アバター側は後で戻す）
      ctx.imageSmoothingEnabled = false;
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const id = mapTileAt(effMap, tx, ty);
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
            const img = itemIcons[ov!.block.itemId];
            const bx = Math.round(sx);
            const by = Math.round(sy);
            if (texReady(img)) ctx.drawImage(img, bx, by, TILE, TILE);
            else {
              ctx.fillStyle = "#9a7b4f";
              ctx.fillRect(bx + 5, by + 5, TILE - 10, TILE - 10);
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
        const lx0 = Math.max(0, Math.floor(cam.x - cw / TILE / 2 - 1));
        const lx1 = Math.min(lobby.width - 1, Math.ceil(cam.x + cw / TILE / 2 + 1));
        const ly0 = Math.max(0, Math.floor(cam.y - ch / TILE / 2 - 1));
        const ly1 = Math.min(lobby.height - 1, Math.ceil(cam.y + ch / TILE / 2 + 1));
        ctx.imageSmoothingEnabled = false;
        for (let ty = ly0; ty <= ly1; ty++) {
          for (let tx = lx0; tx <= lx1; tx++) {
            const id = lobbyTileAt(lobby.tiles, tx, ty);
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
        for (const o of lobby.objects) {
          if (!FLAT_LOBBY_SPRITES.has(o.sprite)) continue;
          if (o.x + o.w < lx0 || o.x > lx1 || o.y + o.h < ly0 || o.y > ly1) continue;
          drawLobbySprite(o);
        }
        ctx.imageSmoothingEnabled = true;
      }

      // プレイヤー群（y 順で奥行き感）
      const drawList: { y: number; draw: () => void }[] = [];
      for (const o of others.values()) {
        const nationColor = nationsRef.current.playerNations[o.track.entry.id]?.color ?? null;
        const oSwim = space === "world" && isWaterAt(effMap, o.track.rx, o.track.ry);
        drawList.push({
          y: o.track.ry,
          draw: () =>
            drawAvatar(
              ctx,
              space === "lobby" ? Math.round(lobbyOx + o.track.rx * TILE) : toScreenX(o.track.rx),
              space === "lobby" ? Math.round(lobbyOy + o.track.ry * TILE) : toScreenY(o.track.ry),
              o.track.entry.face, o.phase, Math.min(1, Math.hypot(o.track.entry.vx, o.track.entry.vy) / WALK_SPEED), o.track.entry.name || null, nationColor, oSwim,
            ),
        });
      }
      if (space === "world") {
        for (const b of buildingsRef.current.buildings) {
          const color = nationsRef.current.playerNations[b.ownerId]?.color ?? "#888888";
          drawList.push({
            y: b.y + 1,
            draw: () => drawBuilding(ctx, toScreenX(b.x), toScreenY(b.y), b.type, color),
          });
        }
      }
      if (space === "lobby") {
        for (const o of lobby.objects) {
          if (FLAT_LOBBY_SPRITES.has(o.sprite)) continue;
          const sx = lobbyOx + o.x * TILE;
          const sy = lobbyOy + o.y * TILE;
          if (sx < -TILE * 4 || sy < -TILE * 4 || sx > cw + TILE * 4 || sy > ch + TILE * 4) continue;
          drawList.push({ y: o.y + o.h, draw: () => drawLobbySprite(o) });
        }
        // 店員NPC（あごむに。静止・当たり判定なし）
        for (const n of lobby.npcs) {
          drawList.push({
            y: n.y + 1,
            draw: () => drawAvatar(ctx, Math.round(lobbyOx + (n.x + 0.5) * TILE), Math.round(lobbyOy + (n.y + 1) * TILE), 1, 0, 0, null),
          });
        }
      }
      drawList.push({
        y: player.y,
        draw: () =>
          drawAvatar(
            ctx,
            space === "lobby" ? Math.round(lobbyOx + player.x * TILE) : toScreenX(player.x),
            space === "lobby" ? Math.round(lobbyOy + player.y * TILE) : toScreenY(player.y),
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

      // 昼夜の薄い色づけ（共有時計。ロビーは屋内なので付けない）
      const night = nightAmount(phaseAtTime(nowMs / 1000));
      if (space === "world" && night > 0.01) {
        ctx.fillStyle = `rgba(9,13,42,${(night * 0.36).toFixed(3)})`;
        ctx.fillRect(0, 0, cw, ch);
      }

      // スティック
      if (joy.active) {
        ctx.fillStyle = "rgba(255,255,255,0.16)";
        ctx.beginPath();
        ctx.arc(joy.baseX, joy.baseY, 52, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.beginPath();
        ctx.arc(joy.baseX + joy.dx * 34, joy.baseY + joy.dy * 34, 22, 0, Math.PI * 2);
        ctx.fill();
      }

      // スタミナ（ゼルダ式の円形ゲージをキャラの左上に。満タンで放置すると消える）
      if (staminaGaugeVisible(stamina)) {
        const px = space === "lobby" ? Math.round(lobbyOx + player.x * TILE) : toScreenX(player.x);
        const py = space === "lobby" ? Math.round(lobbyOy + player.y * TILE) : toScreenY(player.y);
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

      // ミニマップ（約5Hz。ロビーでは出さない）
      if (space === "world" && showMapRef.current && now - lastMinimapAt > 200) {
        lastMinimapAt = now;
        const mm = minimapRef.current;
        const mctx = mm?.getContext("2d");
        if (mm && mctx) {
          mctx.clearRect(0, 0, mm.width, mm.height);
          mctx.drawImage(terrainCanvas, 0, 0);
          // 首都
          for (const n of nationsRef.current.nations) {
            mctx.fillStyle = n.color;
            mctx.fillRect(n.capital.x * MINIMAP_SCALE - 1, n.capital.y * MINIMAP_SCALE - 1, 3, 3);
          }
          // 建物は所有者の所属色（無所属は灰色）の小ドット
          for (const b of buildingsRef.current.buildings) {
            mctx.fillStyle = nationsRef.current.playerNations[b.ownerId]?.color ?? "#d8d8d8";
            mctx.fillRect(b.x * MINIMAP_SCALE, b.y * MINIMAP_SCALE, 2, 2);
          }
          mctx.fillStyle = "#ffffff";
          for (const o of others.values()) {
            mctx.fillRect(Math.floor(o.track.rx * MINIMAP_SCALE) - 1, Math.floor(o.track.ry * MINIMAP_SCALE) - 1, 2, 2);
          }
          mctx.fillStyle = "#ffd23e";
          mctx.strokeStyle = "rgba(0,0,0,0.6)";
          mctx.beginPath();
          mctx.arc(player.x * MINIMAP_SCALE, player.y * MINIMAP_SCALE, 2.6, 0, Math.PI * 2);
          mctx.fill();
          mctx.stroke();
        }
      }

      // マップ表示モード（全体を大きく、約5Hz。ロビーでは出さない）
      if (space === "world" && mapViewRef.current && now - lastBigMapAt > 200) {
        lastBigMapAt = now;
        const bm = bigMapRef.current;
        const bctx = bm?.getContext("2d");
        if (bm && bctx) {
          bctx.clearRect(0, 0, bm.width, bm.height);
          bctx.drawImage(bigTerrainCanvas, 0, 0);
          // 建物は所有者の所属色（無所属は灰色）の小ドット
          for (const b of buildingsRef.current.buildings) {
            bctx.fillStyle = nationsRef.current.playerNations[b.ownerId]?.color ?? "#d8d8d8";
            bctx.fillRect(b.x * BIGMAP_SCALE - 1, b.y * BIGMAP_SCALE - 1, 2.5, 2.5);
          }
          // 首都（国の色の四角＋白枠）
          for (const n of nationsRef.current.nations) {
            bctx.fillStyle = n.color;
            bctx.strokeStyle = "rgba(255,255,255,0.85)";
            bctx.fillRect(n.capital.x * BIGMAP_SCALE - 3, n.capital.y * BIGMAP_SCALE - 3, 7, 7);
            bctx.strokeRect(n.capital.x * BIGMAP_SCALE - 3, n.capital.y * BIGMAP_SCALE - 3, 7, 7);
          }
          // 他のプレイヤー
          bctx.fillStyle = "#ffffff";
          for (const o of others.values()) {
            bctx.beginPath();
            bctx.arc(o.track.rx * BIGMAP_SCALE, o.track.ry * BIGMAP_SCALE, 2.6, 0, Math.PI * 2);
            bctx.fill();
          }
          // 自分
          bctx.fillStyle = "#ffd23e";
          bctx.strokeStyle = "rgba(0,0,0,0.65)";
          bctx.beginPath();
          bctx.arc(player.x * BIGMAP_SCALE, player.y * BIGMAP_SCALE, 4.4, 0, Math.PI * 2);
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
  /** スロット枠（中身はスプライトのみ。SlotContent と対で使う）。 */
  const slotBox: React.CSSProperties = {
    ...btn, position: "relative", width: 42, height: 42, minHeight: 42, padding: 2,
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
    { id: "craft", label: "クラフト", show: true, run: () => setCraftOpen(true) },
    {
      id: "map",
      label: showMap ? "マップを隠す" : "マップを出す",
      show: spaceUi === "world",
      run: () => setShowMap((v) => !v),
    },
    {
      id: "nations",
      label: showNations ? "国を閉じる" : "国",
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
  if (!gateOk) {
    return (
      <div>
        <nav className="breadcrumbs" aria-label="パンくず">
          <Link href={`${prefix}/games`}>ゲーム</Link>
          <span> / </span>
          <span>AGO WORLD BOX</span>
        </nav>
        <div className="page-heading compact-heading">
          <h1>AGO WORLD BOX</h1>
        </div>
        {gate === "checking" ? (
          <p className="classic-status" role="status">
            読み込み中…
          </p>
        ) : (
          <div style={{ textAlign: "center", marginTop: 24 }}>
            <p className="classic-status" role="status">
              ログインが必要
            </p>
            <a
              href="/api/auth/discord/authorize?next=/games/worldbox"
              style={{
                ...btn, textDecoration: "none", display: "inline-flex", alignItems: "center", marginTop: 12,
              }}
            >
              Discordでログイン
            </a>
          </div>
        )}
      </div>
    );
  }

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
      </div>

      <p className="classic-status" role="status">
        {statusText}
        {othersCount > 0 ? ` ・ いま ${othersCount} 人が歩いている` : ""}
        {` ・ 座標 X ${coords.x} / Y ${coords.y}`}
      </p>

      <div style={{ position: "relative", maxWidth: 960, margin: "0 auto", touchAction: "none" }}>
        <canvas
          ref={canvasRef}
          onContextMenu={(e) => e.preventDefault()}
          aria-label="AGO WORLD BOX の見下ろしマップ。スティックか WASD で歩けます"
          style={{
            width: "100%", height: "min(62vh, 560px)", minHeight: 340, display: "block",
            borderRadius: 16, border: "2px solid rgba(255,255,255,0.15)",
            touchAction: "none", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none", WebkitTapHighlightColor: "transparent",
          }}
        />
        <button
          type="button"
          aria-label="メニュー"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
          style={{
            ...btn, position: "absolute", left: 10, top: 10, minHeight: 40, minWidth: 44,
            padding: "4px 10px", fontSize: 18, lineHeight: 1, background: "rgba(0,0,0,0.55)", color: "#fff",
          }}
        >
          ≡
        </button>
        {menuOpen && (
          <div
            style={{
              position: "absolute", left: 10, top: 58, display: "grid", gap: 6, padding: 8,
              borderRadius: 10, background: "rgba(0,0,0,0.72)", color: "#fff", zIndex: 5,
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
          </div>
        )}
        {spaceUi === "lobby" && stationUi && (
          <div
            style={{
              position: "absolute", left: "50%", bottom: 10, transform: "translateX(-50%)",
              display: "flex", gap: 8, alignItems: "center", padding: "6px 8px 6px 14px",
              borderRadius: 10, background: "rgba(0,0,0,0.6)", color: "#fff", fontSize: 13, whiteSpace: "nowrap",
            }}
          >
            <span>{STATION_LABEL[stationUi]}</span>
            {stationUi === "board" && (
              <button
                type="button"
                style={{ ...btn, minHeight: 32, padding: "2px 10px" }}
                onClick={() => setBoardOpen((v) => !v)}
              >
                {boardOpen ? "閉じる" : "開く"}
              </button>
            )}
          </div>
        )}
        {showMap && spaceUi === "world" && (
          <canvas
            ref={minimapRef}
            width={MINIMAP_SIZE}
            height={MINIMAP_SIZE}
            aria-label="全体マップ"
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
              color: "#fff", fontSize: 13,
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
        {spaceUi === "world" && invProfile && (
          <div
            style={{
              position: "absolute", left: "50%", bottom: 10, transform: "translateX(-50%)",
              display: "flex", gap: 4, alignItems: "stretch", padding: 4, borderRadius: 10,
              background: "rgba(0,0,0,0.6)", zIndex: 4, maxWidth: "calc(100% - 16px)",
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
              style={{ ...btn, height: 42, minHeight: 42, padding: "2px 8px", fontSize: 11, color: "#fff", background: "rgba(255,255,255,0.08)" }}
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

      {craftOpen && (
        <div style={panelOverlay}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <strong>クラフト</strong>
            <span style={{ flex: 1 }} />
            <button type="button" style={btn} onClick={() => setCraftOpen(false)}>
              閉じる
            </button>
          </div>
          {/* 作れるものの一覧はアイテム基盤フェーズでここに並ぶ（今は器だけ） */}
          <p className="muted" style={{ margin: "10px 0 0", fontSize: 13 }}>作れるものはまだない</p>
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
            aria-label="全体マップ（大きく表示）"
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
          {(() => {
            const me = nationsUi.me;
            const myNation = me ? nationsUi.nations.find((n) => n.id === me.nationId) ?? null : null;
            const foundable = nationsUi.myGuilds.filter((g) => g.owner && !g.hasNation);
            const joinable = nationsUi.myGuilds.filter((g) => g.hasNation);
            const myGuildIds = new Set(nationsUi.myGuilds.map((g) => g.guildId));
            const others = [...nationsUi.nations]
              .filter((n) => !myGuildIds.has(n.guildId))
              .sort((a, b) => b.prosperity - a.prosperity);
            if (me && myNation) {
              return (
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <span aria-hidden style={{ width: 12, height: 12, borderRadius: 3, background: myNation.color, display: "inline-block" }} />
                    <strong>{myNation.name}</strong>
                    <span>{ROLE_LABEL[me.role]}</span>
                    <span className="muted">国民 {myNation.members}人</span>
                    <span className="muted">繁栄度 {myNation.prosperity}</span>
                    <span style={{ flex: 1 }} />
                    <button
                      type="button"
                      style={btn}
                      onClick={() => void nationAction({ action: "leave" })}
                    >
                      {me.role === "king" && myNation.members <= 1 ? "解散" : "離脱"}
                    </button>
                  </div>
                </div>
              );
            }
            return (
              <div>
                {nationsUi.loggedIn && nationsUi.guildsScopeRequired && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
                    <span className="muted" style={{ fontSize: 13 }}>サーバー一覧の取得に再ログインが必要</span>
                    <a
                      href="/api/auth/discord/authorize?next=/games/worldbox"
                      style={{ ...btn, textDecoration: "none", display: "inline-flex", alignItems: "center" }}
                    >
                      Discordで再ログイン
                    </a>
                  </div>
                )}
                {nationsUi.loggedIn && !nationsUi.guildsScopeRequired && foundable.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <p style={{ margin: "0 0 6px", fontSize: 13 }}>建国できるサーバー</p>
                    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
                      {foundable.map((g) => (
                        <li key={g.guildId} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                          <strong>{g.name}</strong>
                          <span style={{ flex: 1 }} />
                          <button type="button" style={btn} onClick={() => void nationAction({ action: "found", guildId: g.guildId })}>
                            建国
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {nationsUi.loggedIn && !nationsUi.guildsScopeRequired && joinable.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <p style={{ margin: "0 0 6px", fontSize: 13 }}>国があるサーバー</p>
                    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
                      {joinable.map((g) => {
                        const n = nationsUi.nations.find((x) => x.guildId === g.guildId);
                        return (
                          <li key={g.guildId} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                            {n && (
                              <span aria-hidden style={{ width: 12, height: 12, borderRadius: 3, background: n.color, display: "inline-block" }} />
                            )}
                            <strong>{g.name}</strong>
                            <span className="muted">{ROLE_LABEL[g.myRole]}{n ? ` ・ ${n.members}人` : ""}</span>
                            <span style={{ flex: 1 }} />
                            <button type="button" style={btn} onClick={() => void nationAction({ action: "join", guildId: g.guildId })}>
                              参加
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
                {others.length === 0 && joinable.length === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>まだ国はありません</p>
                ) : others.length > 0 ? (
                  <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
                    {others.map((n) => {
                      const dist = Math.round(Math.hypot(
                        n.capital.x + 0.5 - playerPosRef.current.x,
                        n.capital.y + 0.5 - playerPosRef.current.y,
                      ));
                      return (
                        <li key={n.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", opacity: 0.55 }}>
                          <span aria-hidden style={{ width: 12, height: 12, borderRadius: 3, background: n.color, display: "inline-block" }} />
                          <strong>{n.name}</strong>
                          <span className="muted">{n.members}人 ・ 繁栄度 {n.prosperity} ・ {dist}タイル</span>
                          <span style={{ flex: 1 }} />
                          {nationsUi.loggedIn && (
                            <button type="button" style={btn} disabled>
                              参加
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {!nationsUi.loggedIn && (
                  <p className="muted" style={{ margin: "10px 0 0", fontSize: 13 }}>建国・参加はログイン後</p>
                )}
              </div>
            );
          })()}
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
          {nationMsg && (
            <p role="status" style={{ margin: "10px 0 0" }}>{nationMsg}</p>
          )}
        </div>
      )}

      {showEconomy && <WorldBoxEconomyPanel space={spaceUi} />}
      </div>
    </div>
  );
}
