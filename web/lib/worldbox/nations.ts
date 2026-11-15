// AGO WORLD BOX の国家レイヤー（純粋ロジック、DOM 非依存）。
// 1ユーザー = 最大1国まで所属。建国するとマップ中央から渦巻き状（チェビシェフ
// リング）に空き地を探して首都を置き、建国者が王になる。領地は首都を中心と
// するチェビシェフ半径 TERRITORY_RADIUS の正方形で、他国の領地とは重ならない。
// 状態遷移（建国・参加・離脱・解散）はここに集約し、API ルートは保存と認証だけ
// を担う。地形は lib/worldbox/mapgen の決定的マップを参照する。
import {
  MAP_H, MAP_W, T_DIRT, T_GRASS, T_SAND, isSolidMapTile, mapTileAt, type TopDownMap,
} from "./mapgen";
import { presenceIdFor } from "./presence";

/** 領地の半径（チェビシェフ距離）。首都を中心に (2R+1)×(2R+1) が領地。 */
export const TERRITORY_RADIUS = 6;
/** 国名の最大文字数（コードポイント単位）。 */
export const NATION_NAME_MAX = 16;

export type NationRole = "king" | "minister" | "citizen";

export type Nation = {
  id: string;
  name: string;
  /** NATION_PALETTE のいずれか。 */
  color: string;
  /** 建国者の所有者キー（API では表に出さず kingId に変換する）。 */
  kingKey: string;
  /** 首都タイル（整数座標）。 */
  capital: { x: number; y: number };
  createdAt: number;
};

export type Membership = {
  nationId: string;
  role: NationRole;
};

export type NationsState = {
  nations: Record<string, Nation>;
  /** 所有者キー → 所属。未所属はキー自体が無い。 */
  members: Record<string, Membership>;
};

/** 国カラーの固定パレット。空きが多い色から自動で割り当てる。 */
export const NATION_PALETTE = [
  "#e5484d", "#f76b15", "#ffb224", "#46a758", "#12a594",
  "#0091ff", "#6e56cf", "#d6409f", "#8d6e63", "#697177",
] as const;

export function emptyNationsState(): NationsState {
  return { nations: {}, members: {} };
}

function fnvHex(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 国 ID（建国者と時刻から決まる不透明な短い ID）。 */
export function nationIdFor(kingKey: string, createdAt: number): string {
  return fnvHex(`${kingKey}:${createdAt}`);
}

/** 国名の検証。整形済みの名前か、エラーコード "invalid_name" を返す。 */
export function validateNationName(raw: unknown): { ok: true; name: string } | { ok: false; error: "invalid_name" } {
  if (typeof raw !== "string") return { ok: false, error: "invalid_name" };
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, error: "invalid_name" };
  const name = raw.trim();
  const len = Array.from(name).length;
  if (len < 1 || len > NATION_NAME_MAX) return { ok: false, error: "invalid_name" };
  return { ok: true, name };
}

/** 同名の国があるか（前後空白と大小文字の差は同一視する）。 */
export function isNameTaken(state: NationsState, name: string): boolean {
  const key = name.trim().toLowerCase();
  return Object.values(state.nations).some((n) => n.name.trim().toLowerCase() === key);
}

/** 使用数が最も少ないパレット色（同数ならパレット順）。 */
export function pickNationColor(state: NationsState): string {
  const used = new Map<string, number>();
  for (const n of Object.values(state.nations)) used.set(n.color, (used.get(n.color) ?? 0) + 1);
  let best: string = NATION_PALETTE[0];
  let bestCount = Number.POSITIVE_INFINITY;
  for (const color of NATION_PALETTE) {
    const count = used.get(color) ?? 0;
    if (count < bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}

function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/**
 * (x, y) に首都を置けるか: 領地フットプリント全体がマップ内、首都タイルが
 * 固体（水・木・岩）でない、どの国の領地とも重ならない。
 */
export function capitalFits(map: TopDownMap, x: number, y: number, nations: Nation[]): boolean {
  const r = TERRITORY_RADIUS;
  if (x - r < 0 || y - r < 0 || x + r >= map.width || y + r >= map.height) return false;
  if (isSolidMapTile(mapTileAt(map, x, y))) return false;
  for (const n of nations) {
    if (chebyshev(x, y, n.capital.x, n.capital.y) <= r * 2) return false;
  }
  return true;
}

/**
 * 首都候補をマップ中央からチェビシェフリング状に外側へ探す（渦巻き配置）。
 * 置ける最初のタイルを返し、無ければ null。
 */
export function findCapitalTile(map: TopDownMap, nations: Nation[]): { x: number; y: number } | null {
  const cx = Math.floor(map.width / 2);
  const cy = Math.floor(map.height / 2);
  const maxRing = Math.max(map.width, map.height);
  for (let r = 0; r <= maxRing; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
        if (capitalFits(map, x, y, nations)) return { x, y };
      }
    }
  }
  return null;
}

/** そのタイルを含む領地の国（領地は重ならないので最大1つ）。 */
export function territoryOwnerAt(nations: Nation[], x: number, y: number): Nation | null {
  for (const n of nations) {
    if (chebyshev(x, y, n.capital.x, n.capital.y) <= TERRITORY_RADIUS) return n;
  }
  return null;
}

/** 国ごとの所属人数。 */
export function memberCounts(state: NationsState): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of Object.values(state.members)) {
    counts[m.nationId] = (counts[m.nationId] ?? 0) + 1;
  }
  return counts;
}

// ---------- 状態遷移 ----------

export type NationActionResult =
  | { ok: true; state: NationsState; nation?: Nation; disbanded?: boolean }
  | { ok: false; error: string };

/** 建国: 空き地を渦巻き探索で決め、建国者が王になる。 */
export function applyFound(
  state: NationsState,
  ownerKey: string,
  rawName: unknown,
  map: TopDownMap,
  now: number,
): NationActionResult {
  if (state.members[ownerKey]) return { ok: false, error: "already_in_nation" };
  const checked = validateNationName(rawName);
  if (!checked.ok) return { ok: false, error: checked.error };
  if (isNameTaken(state, checked.name)) return { ok: false, error: "name_taken" };
  const capital = findCapitalTile(map, Object.values(state.nations));
  if (!capital) return { ok: false, error: "no_free_tile" };
  const nation: Nation = {
    id: nationIdFor(ownerKey, now),
    name: checked.name,
    color: pickNationColor(state),
    kingKey: ownerKey,
    capital,
    createdAt: now,
  };
  const next: NationsState = {
    nations: { ...state.nations, [nation.id]: nation },
    members: { ...state.members, [ownerKey]: { nationId: nation.id, role: "king" } },
  };
  return { ok: true, state: next, nation };
}

/** 参加: 市民として所属する。 */
export function applyJoin(state: NationsState, ownerKey: string, nationId: unknown): NationActionResult {
  if (state.members[ownerKey]) return { ok: false, error: "already_in_nation" };
  if (typeof nationId !== "string" || !state.nations[nationId]) return { ok: false, error: "nation_not_found" };
  const next: NationsState = {
    nations: state.nations,
    members: { ...state.members, [ownerKey]: { nationId, role: "citizen" } },
  };
  return { ok: true, state: next, nation: state.nations[nationId] };
}

/**
 * 離脱: 市民・大臣はそのまま抜ける。王は国民が残っている間は抜けられず、
 * 一人だけなら解散（国と所属を消し、首都を空ける）。
 */
export function applyLeave(state: NationsState, ownerKey: string): NationActionResult {
  const mine = state.members[ownerKey];
  if (!mine) return { ok: false, error: "not_in_nation" };
  const members = { ...state.members };
  if (mine.role === "king") {
    const othersRemain = Object.entries(members).some(
      ([key, m]) => key !== ownerKey && m.nationId === mine.nationId,
    );
    if (othersRemain) return { ok: false, error: "king_must_transfer_or_disband" };
    delete members[ownerKey];
    const nations = { ...state.nations };
    delete nations[mine.nationId];
    return { ok: true, state: { nations, members }, disbanded: true };
  }
  delete members[ownerKey];
  return { ok: true, state: { nations: state.nations, members }, disbanded: false };
}

// ---------- 建物と繁栄度 ----------

export type BuildingType = "house" | "farm" | "tower";

export const BUILDING_TYPES: readonly BuildingType[] = ["house", "farm", "tower"];

/** 建物1棟が繁栄度に与える値。 */
export const BUILDING_PROSPERITY: Record<BuildingType, number> = { house: 3, farm: 2, tower: 2 };
/** 国民1人あたりの繁栄度。 */
export const PROSPERITY_PER_MEMBER = 5;
/** 建築上限の基礎値と、国民1人あたりの追加枠。 */
export const BUILDING_CAP_BASE = 10;
export const BUILDING_CAP_PER_MEMBER = 10;

export type Building = {
  nationId: string;
  type: BuildingType;
  /** 建築者の不透明 ID（presenceIdFor と同じ方式）。 */
  by: string;
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

/** その国の建築上限（基礎値 + 国民数 × 追加枠）。 */
export function buildingCap(memberCount: number): number {
  return BUILDING_CAP_BASE + BUILDING_CAP_PER_MEMBER * Math.max(0, memberCount);
}

/** その国の建物数。 */
export function buildingCount(buildings: BuildingsMap, nationId: string): number {
  let n = 0;
  for (const b of Object.values(buildings)) if (b.nationId === nationId) n++;
  return n;
}

/** 繁栄度: 建物の合計 + 国民数 × PROSPERITY_PER_MEMBER。 */
export function prosperityOf(buildings: BuildingsMap, nationId: string, memberCount: number): number {
  let score = PROSPERITY_PER_MEMBER * Math.max(0, memberCount);
  for (const b of Object.values(buildings)) {
    if (b.nationId === nationId) score += BUILDING_PROSPERITY[b.type];
  }
  return score;
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
 * 建築: 自国の領地内で、歩ける地形（草・土・砂）にだけ建てられる。
 * 首都タイル・既存建物の上には建てられず、国ごとの上限がある。
 */
export function applyBuild(
  state: NationsState,
  buildings: BuildingsMap,
  ownerKey: string,
  map: TopDownMap,
  typeRaw: unknown,
  xRaw: unknown,
  yRaw: unknown,
  now: number,
): BuildResult {
  if (!isBuildingType(typeRaw)) return { ok: false, error: "invalid_type" };
  const mine = state.members[ownerKey];
  if (!mine) return { ok: false, error: "not_in_nation" };
  const tile = checkedTile(xRaw, yRaw);
  if (!tile) return { ok: false, error: "tile_blocked" };
  const owner = territoryOwnerAt(Object.values(state.nations), tile.x, tile.y);
  if (!owner || owner.id !== mine.nationId) return { ok: false, error: "not_your_territory" };
  const nation = state.nations[mine.nationId];
  if (nation && nation.capital.x === tile.x && nation.capital.y === tile.y) {
    return { ok: false, error: "tile_blocked" };
  }
  if (!BUILDABLE_TERRAIN.has(mapTileAt(map, tile.x, tile.y))) return { ok: false, error: "tile_blocked" };
  const key = buildingKey(tile.x, tile.y);
  if (buildings[key]) return { ok: false, error: "tile_blocked" };
  const counts = memberCounts(state);
  if (buildingCount(buildings, mine.nationId) >= buildingCap(counts[mine.nationId] ?? 0)) {
    return { ok: false, error: "cap_reached" };
  }
  const building: Building = { nationId: mine.nationId, type: typeRaw, by: presenceIdFor(ownerKey), at: now };
  return { ok: true, buildings: { ...buildings, [key]: building }, building };
}

/** 取り壊し: 自国の建物のみ、王・大臣だけが行える。 */
export function applyDemolish(
  state: NationsState,
  buildings: BuildingsMap,
  ownerKey: string,
  xRaw: unknown,
  yRaw: unknown,
): BuildResult {
  const mine = state.members[ownerKey];
  if (!mine) return { ok: false, error: "not_in_nation" };
  if (mine.role !== "king" && mine.role !== "minister") return { ok: false, error: "forbidden" };
  const tile = checkedTile(xRaw, yRaw);
  if (!tile) return { ok: false, error: "tile_blocked" };
  const key = buildingKey(tile.x, tile.y);
  const target = buildings[key];
  if (!target) return { ok: false, error: "tile_blocked" };
  if (target.nationId !== mine.nationId) return { ok: false, error: "forbidden" };
  const next = { ...buildings };
  delete next[key];
  return { ok: true, buildings: next, building: target };
}

/** 解散した国の建物をすべて取り除く（カスケード）。 */
export function removeNationBuildings(buildings: BuildingsMap, nationId: string): BuildingsMap {
  const next: BuildingsMap = {};
  for (const [key, b] of Object.entries(buildings)) {
    if (b.nationId !== nationId) next[key] = b;
  }
  return next;
}

function parseBuilding(raw: unknown): Building | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.nationId !== "string" || v.nationId.length === 0) return null;
  if (!isBuildingType(v.type)) return null;
  if (typeof v.at !== "number" || !Number.isFinite(v.at)) return null;
  return { nationId: v.nationId, type: v.type, by: typeof v.by === "string" ? v.by : "", at: v.at };
}

/** bot_kv の "buildings" 値から建物マップを復元する。壊れた要素・存在しない国の建物は落とす。 */
export function parseBuildings(raw: unknown, validNationIds?: ReadonlySet<string>): BuildingsMap {
  const out: BuildingsMap = {};
  const rec = asRecord(raw);
  if (!rec) return out;
  for (const [key, value] of Object.entries(rec)) {
    if (!parseBuildingKey(key)) continue;
    const building = parseBuilding(value);
    if (!building) continue;
    if (validNationIds && !validNationIds.has(building.nationId)) continue;
    out[key] = building;
  }
  return out;
}

// ---------- 保存形式 ----------

function asRecord(raw: unknown): Record<string, unknown> | null {
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

function parseNation(raw: unknown): Nation | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const cap = v.capital as Record<string, unknown> | null;
  if (typeof v.id !== "string" || v.id.length === 0) return null;
  if (typeof v.name !== "string" || v.name.length === 0) return null;
  if (typeof v.color !== "string" || !(NATION_PALETTE as readonly string[]).includes(v.color)) return null;
  if (typeof v.kingKey !== "string" || v.kingKey.length === 0) return null;
  if (!cap || typeof cap.x !== "number" || typeof cap.y !== "number") return null;
  if (!Number.isFinite(cap.x) || !Number.isFinite(cap.y)) return null;
  const x = Math.floor(cap.x);
  const y = Math.floor(cap.y);
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return null;
  if (typeof v.createdAt !== "number" || !Number.isFinite(v.createdAt)) return null;
  return { id: v.id, name: v.name, color: v.color, kingKey: v.kingKey, capital: { x, y }, createdAt: v.createdAt };
}

/** bot_kv の2値（nations マップと members マップ）から状態を復元する。壊れた要素は落とす。 */
export function parseNationsState(rawNations: unknown, rawMembers: unknown): NationsState {
  const state = emptyNationsState();
  const nationsRaw = asRecord(rawNations);
  if (nationsRaw) {
    for (const raw of Object.values(nationsRaw)) {
      const nation = parseNation(raw);
      if (nation) state.nations[nation.id] = nation;
    }
  }
  const membersRaw = asRecord(rawMembers);
  if (membersRaw) {
    for (const [ownerKey, raw] of Object.entries(membersRaw)) {
      if (!raw || typeof raw !== "object") continue;
      const v = raw as Record<string, unknown>;
      if (typeof v.nationId !== "string" || !state.nations[v.nationId]) continue;
      if (v.role !== "king" && v.role !== "minister" && v.role !== "citizen") continue;
      state.members[ownerKey] = { nationId: v.nationId, role: v.role };
    }
  }
  return state;
}

// ---------- API 表示用 ----------

export type NationView = {
  id: string;
  name: string;
  color: string;
  capital: { x: number; y: number };
  members: number;
  /** 繁栄度（建物 + 国民数から算出）。 */
  prosperity: number;
  /** 王の不透明 ID（presenceIdFor と同じ方式）。 */
  kingId: string;
  createdAt: number;
};

/** クライアント描画・当たり判定用の建物（建築者と時刻は出さない）。 */
export type BuildingView = {
  x: number;
  y: number;
  nationId: string;
  type: BuildingType;
};

export type NationsResponse = {
  nations: NationView[];
  /** 全建物（描画・当たり判定用）。 */
  buildings: BuildingView[];
  me: { nationId: string; role: NationRole } | null;
  /** プレゼンス ID → 所属国の色（他プレイヤーの名前表示に色ドットを付ける用）。 */
  playerNations: Record<string, { nationId: string; color: string }>;
  loggedIn: boolean;
};

export function buildingViews(buildings: BuildingsMap): BuildingView[] {
  const out: BuildingView[] = [];
  for (const [key, b] of Object.entries(buildings)) {
    const pos = parseBuildingKey(key);
    if (pos) out.push({ x: pos.x, y: pos.y, nationId: b.nationId, type: b.type });
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

export function nationViews(state: NationsState, buildings: BuildingsMap = emptyBuildings()): NationView[] {
  const counts = memberCounts(state);
  return Object.values(state.nations)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((n) => ({
      id: n.id,
      name: n.name,
      color: n.color,
      capital: { ...n.capital },
      members: counts[n.id] ?? 0,
      prosperity: prosperityOf(buildings, n.id, counts[n.id] ?? 0),
      kingId: presenceIdFor(n.kingKey),
      createdAt: n.createdAt,
    }));
}

export function playerNationMap(state: NationsState): Record<string, { nationId: string; color: string }> {
  const out: Record<string, { nationId: string; color: string }> = {};
  for (const [ownerKey, m] of Object.entries(state.members)) {
    const nation = state.nations[m.nationId];
    if (nation) out[presenceIdFor(ownerKey)] = { nationId: nation.id, color: nation.color };
  }
  return out;
}

export function buildNationsResponse(
  state: NationsState,
  selfKey: string | null,
  buildings: BuildingsMap = emptyBuildings(),
): NationsResponse {
  const mine = selfKey ? state.members[selfKey] : undefined;
  return {
    nations: nationViews(state, buildings),
    buildings: buildingViews(buildings),
    me: mine ? { nationId: mine.nationId, role: mine.role } : null,
    playerNations: playerNationMap(state),
    loggedIn: selfKey !== null,
  };
}
