// AGO WORLD BOX の建物（純粋ロジック、DOM 非依存）。
// 建物はユーザー個人の所有物で、国への所属とは無関係に建てられる。
// 国はあくまで所属区分であり、領地や所属が建築を制限することはない。
// （国の繁栄度には国民の建物が算入される。集計は nations.ts 側。）
import {
  MAP_H, MAP_W, T_DIRT, T_GRASS, T_SAND, mapSpawn, mapTileAt, type TopDownMap,
} from "./mapgen";
import { presenceIdFor } from "./presence";

/** スポーン広場の二乗距離（mapgen が生成時に草地へ均す範囲と一致させる）。 */
const SPAWN_PLAZA_R2 = 20;

/** そのタイルがスポーン広場（マップ中央の保護範囲）かどうか。 */
export function isSpawnPlazaTile(map: TopDownMap, x: number, y: number): boolean {
  const spawn = mapSpawn(map);
  const sx = Math.floor(spawn.x);
  const sy = Math.floor(spawn.y);
  return (x - sx) * (x - sx) + (y - sy) * (y - sy) <= SPAWN_PLAZA_R2;
}

export type BuildingType = "house" | "farm" | "tower";

export const BUILDING_TYPES: readonly BuildingType[] = ["house", "farm", "tower"];

/** 建物1棟が国の繁栄度に与える値（所有者がその国民のときだけ算入）。 */
export const BUILDING_PROSPERITY: Record<BuildingType, number> = { house: 3, farm: 2, tower: 2 };
/** 1ユーザーあたりの建築上限。コインコスト導入までの暫定措置（荒らし対策）。 */
export const USER_BUILDING_CAP = 20;

export type Building = {
  /** 所有者の不透明 ID（presenceIdFor と同じ方式）。 */
  ownerId: string;
  type: BuildingType;
  at: number;
};

/** "x,y" → 建物。キーが座標を兼ねる。 */
export type BuildingsMap = Record<string, Building>;

/** 建てられる地形（草・土・砂。水・岩・木には建てられない）。 */
const BUILDABLE_TERRAIN: ReadonlySet<number> = new Set([T_GRASS, T_DIRT, T_SAND]);

export function emptyBuildings(): BuildingsMap {
  return {};
}

export function buildingKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function parseBuildingKey(key: string): { x: number; y: number } | null {
  const m = /^(-?\d+),(-?\d+)$/.exec(key);
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return null;
  return { x, y };
}

export function isBuildingType(raw: unknown): raw is BuildingType {
  return raw === "house" || raw === "farm" || raw === "tower";
}

/** そのユーザーの建物数。 */
export function buildingCountByOwner(buildings: BuildingsMap, ownerId: string): number {
  let n = 0;
  for (const b of Object.values(buildings)) if (b.ownerId === ownerId) n++;
  return n;
}

export type BuildResult =
  | { ok: true; buildings: BuildingsMap; building: Building }
  | { ok: false; error: string };

function checkedTile(xRaw: unknown, yRaw: unknown): { x: number; y: number } | null {
  if (typeof xRaw !== "number" || typeof yRaw !== "number") return null;
  if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) return null;
  const x = Math.floor(xRaw);
  const y = Math.floor(yRaw);
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return null;
  return { x, y };
}

/**
 * 建築: ログインしていれば誰でも（所属は不問）、歩ける地形（草・土・砂）の
 * 空きタイルに建てられる。どの国の首都タイルとスポーン広場は保護される。
 */
export function applyBuild(
  buildings: BuildingsMap,
  ownerKey: string,
  capitals: readonly { x: number; y: number }[],
  map: TopDownMap,
  typeRaw: unknown,
  xRaw: unknown,
  yRaw: unknown,
  now: number,
): BuildResult {
  if (!isBuildingType(typeRaw)) return { ok: false, error: "invalid_type" };
  const tile = checkedTile(xRaw, yRaw);
  if (!tile) return { ok: false, error: "tile_blocked" };
  if (capitals.some((c) => c.x === tile.x && c.y === tile.y)) return { ok: false, error: "on_capital" };
  if (isSpawnPlazaTile(map, tile.x, tile.y)) return { ok: false, error: "on_spawn" };
  if (!BUILDABLE_TERRAIN.has(mapTileAt(map, tile.x, tile.y))) return { ok: false, error: "tile_blocked" };
  const key = buildingKey(tile.x, tile.y);
  if (buildings[key]) return { ok: false, error: "tile_blocked" };
  const ownerId = presenceIdFor(ownerKey);
  if (buildingCountByOwner(buildings, ownerId) >= USER_BUILDING_CAP) {
    return { ok: false, error: "cap_reached" };
  }
  const building: Building = { ownerId, type: typeRaw, at: now };
  return { ok: true, buildings: { ...buildings, [key]: building }, building };
}

/** 取り壊し: 建物の所有者だけが行える。 */
export function applyDemolish(
  buildings: BuildingsMap,
  ownerKey: string,
  xRaw: unknown,
  yRaw: unknown,
): BuildResult {
  const tile = checkedTile(xRaw, yRaw);
  if (!tile) return { ok: false, error: "tile_blocked" };
  const key = buildingKey(tile.x, tile.y);
  const target = buildings[key];
  if (!target) return { ok: false, error: "tile_blocked" };
  if (target.ownerId !== presenceIdFor(ownerKey)) return { ok: false, error: "not_owner" };
  const next = { ...buildings };
  delete next[key];
  return { ok: true, buildings: next, building: target };
}

function toRecord(raw: unknown): Record<string, unknown> | null {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

function parseBuilding(raw: unknown): Building | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (!isBuildingType(v.type)) return null;
  if (typeof v.at !== "number" || !Number.isFinite(v.at)) return null;
  // 旧形式（{ nationId, by }）からの移行: 所有者は by（不透明 ID）をそのまま引き継ぐ。
  const ownerId =
    typeof v.ownerId === "string" && v.ownerId.length > 0 ? v.ownerId
    : typeof v.by === "string" && v.by.length > 0 ? v.by
    : null;
  if (!ownerId) return null;
  return { ownerId, type: v.type, at: v.at };
}

/** bot_kv の "buildings" 値から建物マップを復元する。壊れた要素は落とす。 */
export function parseBuildings(raw: unknown): BuildingsMap {
  const out: BuildingsMap = {};
  const rec = toRecord(raw);
  if (!rec) return out;
  for (const [key, value] of Object.entries(rec)) {
    if (!parseBuildingKey(key)) continue;
    const building = parseBuilding(value);
    if (!building) continue;
    out[key] = building;
  }
  return out;
}

// ---------- API 表示用 ----------

/** クライアント描画・当たり判定用の建物（建築時刻は出さない）。 */
export type BuildingView = {
  x: number;
  y: number;
  /** 所有者の不透明 ID（presenceIdFor と同じ方式）。 */
  ownerId: string;
  type: BuildingType;
  /** リクエストした本人の建物かどうか（未ログインは常に false）。 */
  mine: boolean;
};

export function buildingViews(buildings: BuildingsMap, selfKey: string | null): BuildingView[] {
  const selfId = selfKey ? presenceIdFor(selfKey) : null;
  const out: BuildingView[] = [];
  for (const [key, b] of Object.entries(buildings)) {
    const pos = parseBuildingKey(key);
    if (pos) out.push({ x: pos.x, y: pos.y, ownerId: b.ownerId, type: b.type, mine: selfId !== null && b.ownerId === selfId });
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}
