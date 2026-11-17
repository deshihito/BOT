// AGO WORLD BOX の国家レイヤー（純粋ロジック、DOM 非依存）。
// 国 = Discord サーバーそのもの: 建国できるのはサーバーのオーナーだけ、
// 国名はサーバー名、国民はサーバーのメンバー、役職は Discord 権限から決まる
// （オーナー=王、ADMINISTRATOR=大臣、メンバー=国民。判定は guilds.ts）。
// 国はあくまで所属区分: 1ユーザー = 最大1国まで所属する。建国するとマップ
// 中央から渦巻き状（チェビシェフリング）に空き地を探して首都を置く。首都
// 同士は一定の間隔を空けるが、所属が建築などの行動を制限することはない。
// 状態遷移（建国・参加・離脱・解散）はここに集約し、API ルートは保存・認証・
// Discord 検証だけを担う。地形は lib/worldbox/mapgen の決定的マップを参照する。
import {
  WORLD_COORD_LIMIT, isSolidMapTile, mapTileAt, type TopDownMap,
} from "./mapgen";
import { findFreeNear } from "./move";
import { presenceIdFor } from "./presence";

/** 首都同士の最小間隔の基準（チェビシェフ距離）。首都はこの2倍より離して置く。 */
export const TERRITORY_RADIUS = 6;

/** 保存形式の版。旧（プレイヤー建国）形式は読み込み時に破棄する。 */
export const NATIONS_STATE_VERSION = 2;

export type NationRole = "king" | "minister" | "citizen";

export type Nation = {
  /** 国 = Discord サーバー。ギルド ID がそのまま国の ID。 */
  guildId: string;
  /** サーバー名（建国時点の Discord 側の名前。そのまま使う）。 */
  name: string;
  /** NATION_PALETTE のいずれか。 */
  color: string;
  /** 建国者（サーバーオーナー）の所有者キー（API では表に出さず kingId に変換する）。 */
  kingKey: string;
  /** 首都タイル（整数座標）。 */
  capital: { x: number; y: number };
  createdAt: number;
};

export type Membership = {
  /** 所属先のギルド ID（= 国 ID）。 */
  nationId: string;
  role: NationRole;
};

export type NationsState = {
  /** ギルド ID → 国。 */
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
 * (x, y) に首都を置けるか: 首都タイルが固体（水・木・岩）でなく、
 * どの国の首都とも近すぎない。ワールドに境界は無いため範囲は問わない
 * （座標の健全上限だけは守る）。
 */
export function capitalFits(map: TopDownMap, x: number, y: number, nations: Nation[]): boolean {
  const r = TERRITORY_RADIUS;
  if (Math.abs(x) > WORLD_COORD_LIMIT - r || Math.abs(y) > WORLD_COORD_LIMIT - r) return false;
  if (isSolidMapTile(mapTileAt(map, x, y))) return false;
  for (const n of nations) {
    if (chebyshev(x, y, n.capital.x, n.capital.y) <= r * 2) return false;
  }
  return true;
}

/** 首都探索の中心（既存の首都が集まる原点近傍の基準点）。 */
export const CAPITAL_SEARCH_CENTER = { x: 512, y: 512 };
/** 首都探索の最大リング。これ以上は「空き地なし」とする。 */
const CAPITAL_SEARCH_MAX_RING = 1024;

/**
 * 首都候補を探索中心からチェビシェフリング状に外側へ探す（渦巻き配置）。
 * 置ける最初のタイルを返し、無ければ null。
 */
export function findCapitalTile(
  map: TopDownMap,
  nations: Nation[],
  center: { x: number; y: number } = CAPITAL_SEARCH_CENTER,
): { x: number; y: number } | null {
  for (let r = 0; r <= CAPITAL_SEARCH_MAX_RING; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = center.x + dx;
        const y = center.y + dy;
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

/** 建国に使うギルドの最小情報（Discord 検証済みのものだけが渡ってくる）。 */
export type FoundGuild = { id: string; name: string };

/**
 * 建国: サーバーオーナーが自分のサーバーを国にする。国名はサーバー名を
 * そのまま使い、首都は渦巻き探索で決める。建国者は王として所属する。
 * オーナー検証そのものは呼び出し側（API ルート）が guilds で行う。
 */
export function applyFound(
  state: NationsState,
  ownerKey: string,
  guild: FoundGuild,
  map: TopDownMap,
  now: number,
): NationActionResult {
  if (typeof guild?.id !== "string" || !/^\d+$/.test(guild.id)) return { ok: false, error: "invalid_request" };
  if (state.nations[guild.id]) return { ok: false, error: "nation_exists" };
  if (state.members[ownerKey]) return { ok: false, error: "already_in_nation" };
  const capital = findCapitalTile(map, Object.values(state.nations));
  if (!capital) return { ok: false, error: "no_free_tile" };
  const name = (typeof guild.name === "string" ? guild.name.trim() : "") || "サーバー";
  const nation: Nation = {
    guildId: guild.id,
    name: Array.from(name).slice(0, 100).join(""),
    color: pickNationColor(state),
    kingKey: ownerKey,
    capital,
    createdAt: now,
  };
  const next: NationsState = {
    nations: { ...state.nations, [nation.guildId]: nation },
    members: { ...state.members, [ownerKey]: { nationId: nation.guildId, role: "king" } },
  };
  return { ok: true, state: next, nation };
}

/** 参加: 役職は Discord 権限から導いたものを呼び出し側が渡す。 */
export function applyJoin(
  state: NationsState,
  ownerKey: string,
  guildId: unknown,
  role: NationRole,
): NationActionResult {
  if (state.members[ownerKey]) return { ok: false, error: "already_in_nation" };
  if (typeof guildId !== "string" || !state.nations[guildId]) return { ok: false, error: "nation_not_found" };
  const next: NationsState = {
    nations: state.nations,
    members: { ...state.members, [ownerKey]: { nationId: guildId, role } },
  };
  return { ok: true, state: next, nation: state.nations[guildId] };
}

/**
 * 離脱: 市民・大臣はそのまま抜ける。王（サーバーオーナー）は国民が残っている
 * 間は抜けられず、一人だけなら解散（国と所属を消し、首都を空ける）。
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

// ---------- ファストトラベル ----------

/** 所属国への移動料金（アゴコイン）。当面は無料。 */
export const FAST_TRAVEL_COST = 0;
/** 所属国への移動のクールダウン（ミリ秒）。当面はなし。 */
export const FAST_TRAVEL_COOLDOWN_MS = 0;

export type FastTravelResult =
  | { ok: true; nationId: string; x: number; y: number }
  | { ok: false; error: string };

/**
 * 所属国へのファストトラベル先: 自分の国のユニオンマーク（首都）タイルの
 * 中心。所属の検証はこの関数が正（状態に所属が無ければ not_in_nation）。
 * 首都タイルは建国時点で固体でないことが保証されるが、周囲の変化に備えて
 * 立てる場所へ寄せる。料金・クールダウンは定数（現状どちらも 0）で、
 * 課金・制限を入れる場合はここを起点にする。
 */
export function fastTravelDestination(
  state: NationsState,
  ownerKey: string,
  map: TopDownMap,
): FastTravelResult {
  const mine = state.members[ownerKey];
  if (!mine) return { ok: false, error: "not_in_nation" };
  const nation = state.nations[mine.nationId];
  if (!nation) return { ok: false, error: "not_in_nation" };
  const free = findFreeNear(map, nation.capital.x + 0.5, nation.capital.y + 0.5, undefined, { swim: true });
  return { ok: true, nationId: nation.guildId, x: free.x, y: free.y };
}

// ---------- 繁栄度 ----------

/** 国民1人あたりの繁栄度。 */
export const PROSPERITY_PER_MEMBER = 5;

/**
 * 繁栄度（所属の指標）: 国民数 × PROSPERITY_PER_MEMBER のみ。
 * 旧プレハブ建物（家・畑・塔）の算入は建物システムの廃止に伴い撤去した。
 */
export function prosperityOf(state: NationsState, nationId: string): number {
  return PROSPERITY_PER_MEMBER * (memberCounts(state)[nationId] ?? 0);
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
  if (typeof v.guildId !== "string" || !/^\d+$/.test(v.guildId)) return null;
  if (typeof v.name !== "string" || v.name.length === 0) return null;
  if (typeof v.color !== "string" || !(NATION_PALETTE as readonly string[]).includes(v.color)) return null;
  if (typeof v.kingKey !== "string" || v.kingKey.length === 0) return null;
  if (!cap || typeof cap.x !== "number" || typeof cap.y !== "number") return null;
  if (!Number.isFinite(cap.x) || !Number.isFinite(cap.y)) return null;
  const x = Math.floor(cap.x);
  const y = Math.floor(cap.y);
  if (Math.abs(x) > WORLD_COORD_LIMIT || Math.abs(y) > WORLD_COORD_LIMIT) return null;
  if (typeof v.createdAt !== "number" || !Number.isFinite(v.createdAt)) return null;
  return { guildId: v.guildId, name: v.name, color: v.color, kingKey: v.kingKey, capital: { x, y }, createdAt: v.createdAt };
}

/**
 * bot_kv の2値（nations マップと members マップ）から状態を復元する。
 * nations 側は { v: NATIONS_STATE_VERSION, nations } の包みが必須で、版が
 * 合わない保存（旧プレイヤー建国形式を含む）は丸ごと破棄する（首都は空く）。
 * 壊れた要素は落とす。
 */
export function parseNationsState(rawNations: unknown, rawMembers: unknown): NationsState {
  const state = emptyNationsState();
  const wrapped = asRecord(rawNations);
  if (!wrapped || wrapped.v !== NATIONS_STATE_VERSION) return state;
  const nationsRaw = asRecord(wrapped.nations);
  if (nationsRaw) {
    for (const raw of Object.values(nationsRaw)) {
      const nation = parseNation(raw);
      if (nation) state.nations[nation.guildId] = nation;
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
  /** 国 ID = ギルド ID。 */
  id: string;
  guildId: string;
  name: string;
  color: string;
  capital: { x: number; y: number };
  members: number;
  /** 繁栄度（国民数から算出する所属指標）。 */
  prosperity: number;
  /** 王の不透明 ID（presenceIdFor と同じ方式）。 */
  kingId: string;
  createdAt: number;
};

/** 自分が参加しているサーバー1件分の表示（建国・参加の入口）。 */
export type MyGuildView = {
  guildId: string;
  name: string;
  /** サーバーのオーナーか（= 建国できるか）。 */
  owner: boolean;
  /** そのサーバーの国が既にあるか。 */
  hasNation: boolean;
  /** Discord 権限から導いた、そのサーバーでの自分の役職。 */
  myRole: NationRole;
};

export type NationsResponse = {
  nations: NationView[];
  /** 戦争中の国のマーク表示（war.ts の warMarksByNation）。国 ID → 状態。 */
  warMarks: Record<string, { markHp: number | null; markMax: number }>;
  me: { nationId: string; role: NationRole } | null;
  /** プレゼンス ID → 所属国の色（他プレイヤーの名前表示に色ドットを付ける用）。 */
  playerNations: Record<string, { nationId: string; color: string }>;
  loggedIn: boolean;
  /** ログイン中ユーザーの参加サーバー（建国・参加の候補）。ゲストは空。 */
  myGuilds: MyGuildView[];
  /** セッションに Discord トークンが無く、サーバー一覧を引けない（再ログインが必要）。 */
  guildsScopeRequired: boolean;
};

export function nationViews(state: NationsState): NationView[] {
  const counts = memberCounts(state);
  return Object.values(state.nations)
    .sort((a, b) => a.createdAt - b.createdAt || a.guildId.localeCompare(b.guildId))
    .map((n) => ({
      id: n.guildId,
      guildId: n.guildId,
      name: n.name,
      color: n.color,
      capital: { ...n.capital },
      members: counts[n.guildId] ?? 0,
      prosperity: prosperityOf(state, n.guildId),
      kingId: presenceIdFor(n.kingKey),
      createdAt: n.createdAt,
    }));
}

export function playerNationMap(state: NationsState): Record<string, { nationId: string; color: string }> {
  const out: Record<string, { nationId: string; color: string }> = {};
  for (const [ownerKey, m] of Object.entries(state.members)) {
    const nation = state.nations[m.nationId];
    if (nation) out[presenceIdFor(ownerKey)] = { nationId: nation.guildId, color: nation.color };
  }
  return out;
}

export function buildNationsResponse(
  state: NationsState,
  selfKey: string | null,
  extra: { myGuilds?: MyGuildView[]; guildsScopeRequired?: boolean } = {},
): NationsResponse {
  const mine = selfKey ? state.members[selfKey] : undefined;
  return {
    nations: nationViews(state),
    warMarks: {},
    me: mine ? { nationId: mine.nationId, role: mine.role } : null,
    playerNations: playerNationMap(state),
    loggedIn: selfKey !== null,
    myGuilds: extra.myGuilds ?? [],
    guildsScopeRequired: extra.guildsScopeRequired ?? false,
  };
}
