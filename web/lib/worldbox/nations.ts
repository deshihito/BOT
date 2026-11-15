// AGO WORLD BOX の国家レイヤー（純粋ロジック、DOM 非依存）。
// 国はあくまで所属区分: 1ユーザー = 最大1国まで所属する。建国するとマップ
// 中央から渦巻き状（チェビシェフリング）に空き地を探して首都を置き、建国者
// が王になる。首都同士は一定の間隔を空けるが、所属や「領地」が建築などの
// 行動を制限することはない（建物は lib/worldbox/buildings の個人所有）。
// 状態遷移（建国・参加・離脱・解散）はここに集約し、API ルートは保存と認証だけ
// を担う。地形は lib/worldbox/mapgen の決定的マップを参照する。
import {
  MAP_H, MAP_W, isSolidMapTile, mapTileAt, type TopDownMap,
} from "./mapgen";
import { presenceIdFor } from "./presence";
import { BUILDING_PROSPERITY, emptyBuildings, type BuildingsMap } from "./buildings";

/** 首都同士の最小間隔の基準（チェビシェフ距離）。首都はこの2倍より離して置く。 */
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
 * (x, y) に首都を置けるか: 周囲のフットプリント全体がマップ内、首都タイルが
 * 固体（水・木・岩）でない、どの国の首都とも近すぎない。
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

// ---------- 繁栄度 ----------

/** 国民1人あたりの繁栄度。 */
export const PROSPERITY_PER_MEMBER = 5;

/**
 * 繁栄度（所属の指標）: 国民数 × PROSPERITY_PER_MEMBER + 現在の国民が所有する
 * 建物の合計。建物そのものは個人所有で、所属していない人の建物は算入しない。
 */
export function prosperityOf(state: NationsState, buildings: BuildingsMap, nationId: string): number {
  const memberIds = new Set<string>();
  let memberCount = 0;
  for (const [ownerKey, m] of Object.entries(state.members)) {
    if (m.nationId === nationId) {
      memberCount++;
      memberIds.add(presenceIdFor(ownerKey));
    }
  }
  let score = PROSPERITY_PER_MEMBER * memberCount;
  for (const b of Object.values(buildings)) {
    if (memberIds.has(b.ownerId)) score += BUILDING_PROSPERITY[b.type];
  }
  return score;
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
  /** 繁栄度（国民数 + 国民の建物から算出する所属指標）。 */
  prosperity: number;
  /** 王の不透明 ID（presenceIdFor と同じ方式）。 */
  kingId: string;
  createdAt: number;
};

export type NationsResponse = {
  nations: NationView[];
  me: { nationId: string; role: NationRole } | null;
  /** プレゼンス ID → 所属国の色（他プレイヤーの名前表示に色ドットを付ける用）。 */
  playerNations: Record<string, { nationId: string; color: string }>;
  loggedIn: boolean;
};

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
      prosperity: prosperityOf(state, buildings, n.id),
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
    me: mine ? { nationId: mine.nationId, role: mine.role } : null,
    playerNations: playerNationMap(state),
    loggedIn: selfKey !== null,
  };
}
