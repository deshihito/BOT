"use client";
// AGO WORLD BOX（見下ろし型・共有ワールド）。
// 世界は固定シードから生成される 1024×1024 の1枚マップで、全員が同じ場所を歩く。
// 移動は8方向フリー（スティック＋WASD）、他プレイヤーはプレゼンス API 経由で
// アバター＋名前つきで表示される（同時接続）。セーブは自分の位置だけ（v5）。
// ゲームループと描画は canvas + refs で回し、React state は HUD 表示だけに使う。
// 純粋ロジックは lib/worldbox/ に分離（生成・移動・プレゼンス・保存）。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  MAP_H, MAP_SEED, MAP_W, MINIMAP_SIZE, T_DIRT, T_GRASS, T_ROCK, T_SAND, T_SNOW, T_SNOW_TREE, T_TREE, T_WATER,
  generateMap, mapSpawn, mapTileAt, sampleMinimapTiles, type TopDownMap,
} from "@/lib/worldbox/mapgen";
import { WALK_SPEED, findFreeNear, stepMove } from "@/lib/worldbox/move";
import { nightAmount, phaseAtTime } from "@/lib/worldbox/daynight";
import { advanceWalkPhase, damp, moveLean, walkBob, walkSquashY } from "@/lib/worldbox/anim";
import { SNAP_DISTANCE, predictPosition, type PresenceEntry } from "@/lib/worldbox/presence";
import type { NationRole, NationView, NationsResponse } from "@/lib/worldbox/nations";
import { USER_BUILDING_CAP, isSpawnPlazaTile, type BuildingType, type BuildingView } from "@/lib/worldbox/buildings";
import { parseSave, serializeSave } from "@/lib/worldbox/save";
import { chooseInitialSave } from "@/lib/worldbox/save-source";
import { loadDungeonTiles, loadTextures } from "@/lib/worldbox/textures";
import { useGamesNav } from "../GamesShell";
import WorldBoxEconomyPanel from "./WorldBoxEconomyPanel";

const SAVE_KEY = "ago-worldbox-save-v5";
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

type PlayerState = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  face: 1 | -1;
  phase: number;
};

type OtherRender = {
  entry: PresenceEntry;
  /** 描画位置（デッドレコニング予測へ ease で寄せる）。 */
  rx: number;
  ry: number;
  phase: number;
};

function texReady(img: HTMLImageElement | undefined): img is HTMLImageElement {
  return !!img && img.complete && img.naturalWidth > 0;
}

const ROLE_LABEL: Record<NationRole, string> = { king: "王", minister: "大臣", citizen: "国民" };

/** 建築ツール（建物3種＋取り壊し）。 */
type BuildTool = BuildingType | "demolish";
const BUILD_TOOL_LABEL: Record<BuildTool, string> = { house: "家", farm: "畑", tower: "塔", demolish: "取り壊し" };

const NATION_ERROR_LABEL: Record<string, string> = {
  already_in_nation: "既に国に所属しています",
  name_taken: "その国名は使われています",
  no_free_tile: "首都を置ける空き地がありません",
  invalid_name: "国名は1〜16文字です",
  nation_not_found: "国が見つかりません",
  not_in_nation: "国に所属していません",
  king_must_transfer_or_disband: "国民がいる間、王は離脱できません",
  unauthorized: "ログインが必要です",
  tile_blocked: "そこには建てられません",
  cap_reached: "建築上限に達しています",
  forbidden: "その権限がありません",
  invalid_type: "建物の種類が不正です",
  not_owner: "自分の建物だけ取り壊せます",
  on_capital: "首都には建てられません",
  on_spawn: "スポーン広場には建てられません",
};

const EMPTY_NATIONS: NationsResponse = { nations: [], me: null, playerNations: {}, loggedIn: false };

/** 建物データ（建物は個人所有で、国家データとは別 API から取る）。 */
type BuildingsData = { buildings: BuildingView[]; loggedIn: boolean };
const EMPTY_BUILDINGS: BuildingsData = { buildings: [], loggedIn: false };

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
  const [nationName, setNationName] = useState("");
  const [nationMsg, setNationMsg] = useState("");
  // 建築モード（描画・入力ループは ref、パネルは state で見る）
  const [buildMode, setBuildMode] = useState(false);
  const [buildTool, setBuildTool] = useState<BuildTool>("house");
  const buildRef = useRef<{ active: boolean; tool: BuildTool }>({ active: false, tool: "house" });
  /** 建物の当たり判定（"x,y" の集合）。建物データの更新に合わせて作り直す。 */
  const blockedRef = useRef<ReadonlySet<string>>(new Set());
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
    blockedRef.current = new Set(data.buildings.map((b) => `${b.x},${b.y}`));
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
      setNationName("");
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
        setNationMsg(NATION_ERROR_LABEL[data.error ?? ""] ?? "失敗しました");
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

  useEffect(() => {
    void refreshNations();
    void refreshBuildings();
    const timer = window.setInterval(() => {
      void refreshNations();
      void refreshBuildings();
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
    const textures = loadTextures();
    const dungeon = loadDungeonTiles();
    const avatar = new Image();
    avatar.src = "/img/nomal.png";

    const spawn = mapSpawn(map);
    const player: PlayerState = { x: spawn.x, y: spawn.y, vx: 0, vy: 0, face: 1, phase: 0 };
    const cam = { x: player.x, y: player.y };
    const keys = new Set<string>();
    const joy = { active: false, pointerId: -1, baseX: 0, baseY: 0, dx: 0, dy: 0 };
    const others = new Map<string, OtherRender>();
    let loggedIn = false;
    let disposed = false;
    let lastSaved = { x: player.x, y: player.y, at: 0 };
    let lastMinimapAt = 0;

    // ---- 保存（位置のみ） ----
    const saveLocal = () => {
      try {
        localStorage.setItem(SAVE_KEY, serializeSave({ x: player.x, y: player.y }));
      } catch { /* noop */ }
    };
    const saveOnline = (keepalive = false) => {
      if (!loggedIn) return;
      fetch("/api/worldbox/save", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ save: serializeSave({ x: player.x, y: player.y }) }),
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
      let local: { x: number; y: number } | null = null;
      try {
        local = parseSave(localStorage.getItem(SAVE_KEY));
      } catch { /* noop */ }
      let online: { x: number; y: number } | null = null;
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
        const free = findFreeNear(map, choice.state.x, choice.state.y, blockedRef.current);
        player.x = free.x;
        player.y = free.y;
        cam.x = free.x;
        cam.y = free.y;
      }
      if (choice.pushLocalToOnline) saveNow();
      else lastSaved = { x: player.x, y: player.y, at: performance.now() };
      setStatusText(loggedIn ? "共有ワールド" : "共有ワールド（ゲスト）");
    })();

    // ---- プレゼンス ----
    const sendHeartbeat = () => {
      if (!loggedIn) return;
      fetch("/api/worldbox/presence", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "", x: player.x, y: player.y, vx: player.vx, vy: player.vy, face: player.face }),
      }).catch(() => { /* noop */ });
    };
    const pollOthers = async () => {
      try {
        const res = await fetch("/api/worldbox/presence", { headers: { Accept: "application/json" } });
        if (!res.ok) return;
        const body = (await res.json()) as { players?: PresenceEntry[] };
        if (disposed) return;
        const seen = new Set<string>();
        for (const entry of body.players ?? []) {
          seen.add(entry.id);
          const cur = others.get(entry.id);
          if (!cur) {
            const p = predictPosition(entry, Date.now(), map);
            others.set(entry.id, { entry, rx: p.x, ry: p.y, phase: 0 });
          } else {
            cur.entry = entry;
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
      const k = e.key.toLowerCase();
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) e.preventDefault();
      keys.add(k);
    };
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
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
    const onPointerDown = (e: PointerEvent) => {
      if (buildRef.current.active) {
        // 建築モードではタップそのものが確定（スティックは無効）
        const t = toTile(e);
        hoverTile = t;
        if (t.x >= 0 && t.y >= 0 && t.x < MAP_W && t.y < MAP_H) {
          buildActionRef.current(buildRef.current.tool, t.x, t.y);
        }
        return;
      }
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
      if (buildRef.current.active) {
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
    ) => {
      const size = TILE * AVATAR_TILES;
      const bob = walkBob(phase) * TILE * 0.07 * speedRatio;
      const squash = 1 - (1 - walkSquashY(phase)) * speedRatio;
      c.fillStyle = "rgba(20,30,16,0.30)";
      c.beginPath();
      c.ellipse(sx, sy, size * 0.30, size * 0.10, 0, 0, Math.PI * 2);
      c.fill();
      if (texReady(avatar)) {
        c.save();
        c.translate(sx, sy - bob);
        c.rotate(moveLean(speedRatio) * face);
        c.scale(face * (1 + (1 - squash) * 0.7), squash);
        c.drawImage(avatar, -size / 2, -size, size, size);
        c.restore();
      } else {
        c.fillStyle = "#f4f6f8";
        c.beginPath();
        c.arc(sx, sy - size / 2 - bob, size * 0.36, 0, Math.PI * 2);
        c.fill();
      }
      if (name) {
        c.font = "600 11px sans-serif";
        c.textAlign = "center";
        c.lineWidth = 3;
        c.strokeStyle = "rgba(10,16,10,0.65)";
        const ly = sy - size - 6 - bob;
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
      const t = mapTileAt(map, tx, ty);
      if (t !== T_GRASS && t !== T_DIRT && t !== T_SAND) return false;
      if (data.buildings.some((v) => v.x === tx && v.y === ty)) return false;
      if (data.buildings.filter((v) => v.mine).length >= USER_BUILDING_CAP) return false;
      return true;
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
      const vel = { x: ix * WALK_SPEED, y: iy * WALK_SPEED };
      const prevX = player.x;
      const prevY = player.y;
      const moved = stepMove(map, player, vel, dt, blockedRef.current);
      player.x = moved.x;
      player.y = moved.y;
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

      // 他プレイヤーの描画位置（デッドレコニング予測へ寄せる）
      const nowMs = Date.now();
      for (const o of others.values()) {
        const target = predictPosition(o.entry, nowMs, map);
        const dist = Math.hypot(target.x - o.rx, target.y - o.ry);
        if (dist > SNAP_DISTANCE) {
          o.rx = target.x;
          o.ry = target.y;
        } else {
          o.rx = damp(o.rx, target.x, 8, dt);
          o.ry = damp(o.ry, target.y, 8, dt);
        }
        const ospeed = Math.hypot(o.entry.vx, o.entry.vy);
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
      const tx0 = Math.max(0, Math.floor(cam.x - cw / TILE / 2 - 1));
      const tx1 = Math.min(MAP_W - 1, Math.ceil(cam.x + cw / TILE / 2 + 1));
      const ty0 = Math.max(0, Math.floor(cam.y - ch / TILE / 2 - 1));
      const ty1 = Math.min(MAP_H - 1, Math.ceil(cam.y + ch / TILE / 2 + 1));
      // 流用タイルはピクセルアートなので補間を切ってクッキリ描く（アバター側は後で戻す）
      ctx.imageSmoothingEnabled = false;
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const id = mapTileAt(map, tx, ty);
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

      // プレイヤー群（y 順で奥行き感）
      const drawList: { y: number; draw: () => void }[] = [];
      for (const o of others.values()) {
        const nationColor = nationsRef.current.playerNations[o.entry.id]?.color ?? null;
        drawList.push({
          y: o.ry,
          draw: () =>
            drawAvatar(ctx, toScreenX(o.rx), toScreenY(o.ry), o.entry.face, o.phase, Math.min(1, Math.hypot(o.entry.vx, o.entry.vy) / WALK_SPEED), o.entry.name || null, nationColor),
        });
      }
      for (const b of buildingsRef.current.buildings) {
        const color = nationsRef.current.playerNations[b.ownerId]?.color ?? "#888888";
        drawList.push({
          y: b.y + 1,
          draw: () => drawBuilding(ctx, toScreenX(b.x), toScreenY(b.y), b.type, color),
        });
      }
      drawList.push({
        y: player.y,
        draw: () => drawAvatar(ctx, toScreenX(player.x), toScreenY(player.y), player.face, player.phase, speedRatio, null),
      });
      drawList.sort((a, b) => a.y - b.y);
      for (const d of drawList) d.draw();

      // 昼夜の薄い色づけ（共有時計）
      const night = nightAmount(phaseAtTime(nowMs / 1000));
      if (night > 0.01) {
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

      // ミニマップ（約5Hz）
      if (showMapRef.current && now - lastMinimapAt > 200) {
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
            mctx.fillRect(Math.floor(o.rx * MINIMAP_SCALE) - 1, Math.floor(o.ry * MINIMAP_SCALE) - 1, 2, 2);
          }
          mctx.fillStyle = "#ffd23e";
          mctx.strokeStyle = "rgba(0,0,0,0.6)";
          mctx.beginPath();
          mctx.arc(player.x * MINIMAP_SCALE, player.y * MINIMAP_SCALE, 2.6, 0, Math.PI * 2);
          mctx.fill();
          mctx.stroke();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const btn: React.CSSProperties = {
    minHeight: 40, padding: "6px 14px", borderRadius: 10, cursor: "pointer",
    border: "1px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.06)", color: "inherit",
    touchAction: "manipulation", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none",
  };

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
        <p className="muted">見下ろしの共有ワールド。みんなで同じ世界を歩く。</p>
      </div>

      <p className="classic-status" role="status">
        {statusText}
        {othersCount > 0 ? ` ・ いま ${othersCount} 人が歩いている` : ""}
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
        {showMap && (
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
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 14, flexWrap: "wrap" }}>
        <button type="button" style={btn} onClick={() => setShowMap((v) => !v)} aria-pressed={showMap}>
          マップ{showMap ? "を隠す" : "を出す"}
        </button>
        <button type="button" style={btn} onClick={() => setShowNations((v) => !v)} aria-pressed={showNations}>
          国{showNations ? "を閉じる" : ""}
        </button>
        <button type="button" style={btn} onClick={() => setShowEconomy((v) => !v)} aria-pressed={showEconomy}>
          経済{showEconomy ? "を閉じる" : ""}
        </button>
      </div>

      {showNations && (
        <div
          style={{
            maxWidth: 640, margin: "12px auto 0", padding: 14, borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.04)", textAlign: "left",
          }}
        >
          {(() => {
            const me = nationsUi.me;
            const myNation = me ? nationsUi.nations.find((n) => n.id === me.nationId) ?? null : null;
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
                {nationsUi.loggedIn && (
                  <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                    <input
                      value={nationName}
                      onChange={(e) => setNationName(e.target.value)}
                      maxLength={24}
                      placeholder="国名"
                      aria-label="国名"
                      style={{
                        flex: 1, minHeight: 40, padding: "6px 10px", borderRadius: 10,
                        border: "1px solid rgba(255,255,255,0.25)", background: "rgba(255,255,255,0.06)", color: "inherit",
                      }}
                    />
                    <button
                      type="button"
                      style={btn}
                      disabled={!nationName.trim()}
                      onClick={() => void nationAction({ action: "found", name: nationName })}
                    >
                      建国
                    </button>
                  </div>
                )}
                {nationsUi.nations.length === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>まだ国はありません</p>
                ) : (
                  <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
                    {[...nationsUi.nations].sort((a, b) => b.prosperity - a.prosperity).map((n) => {
                      const dist = Math.round(Math.hypot(
                        n.capital.x + 0.5 - playerPosRef.current.x,
                        n.capital.y + 0.5 - playerPosRef.current.y,
                      ));
                      return (
                        <li key={n.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                          <span aria-hidden style={{ width: 12, height: 12, borderRadius: 3, background: n.color, display: "inline-block" }} />
                          <strong>{n.name}</strong>
                          <span className="muted">{n.members}人 ・ 繁栄度 {n.prosperity} ・ {dist}タイル</span>
                          <span style={{ flex: 1 }} />
                          {nationsUi.loggedIn && (
                            <button type="button" style={btn} onClick={() => void nationAction({ action: "join", nationId: n.id })}>
                              参加
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
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

      {showEconomy && <WorldBoxEconomyPanel />}

      <p className="muted" style={{ textAlign: "center", fontSize: 13, maxWidth: 860, margin: "14px auto 0" }}>
        PC: WASD・矢印キーで移動。タッチ: 画面左側のスティックで移動。
        水・木・岩には入れません。歩いた場所は保存され、みんなと同じ世界にいます。
        ログインすると、好きな場所に家・畑・塔を建てられます。建てた建物は、所属する国の繁栄度にも数えられます。
        経済パネルでは、働いてコインを稼ぎ、買い物・合成・steal ができます。
      </p>
    </div>
  );
}
