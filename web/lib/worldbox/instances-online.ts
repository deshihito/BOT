// AGO WORLD BOX のインスタンス枯渇状態の保存（サーバー専用）。
// 保存先は bot_kv（名前空間 "worldbox_instances"、キー = 空間 ID）。
// 値: { veins: { veinKey: 採取時刻 }, chest: 宝箱を開けた時刻 }。
import { isBotApiConfigured, kvDelete, kvGet, kvSet } from "../bot-api";
import { loadProfile } from "./profile-online";
import { masteryRankOf, partyGateSatisfied } from "./roles";
import { DUNGEON_FLOORS } from "./instances";

export const WORLDBOX_INSTANCES_NAMESPACE = "worldbox_instances";

export type InstanceState = {
  veins: Record<string, number>;
  chest: number;
};

export function parseInstanceState(raw: unknown): InstanceState {
  const empty: InstanceState = { veins: {}, chest: 0 };
  if (typeof raw !== "string" || raw === "") return empty;
  try {
    const v = JSON.parse(raw) as { veins?: unknown; chest?: unknown };
    const veins: Record<string, number> = {};
    if (v.veins && typeof v.veins === "object") {
      for (const [k, val] of Object.entries(v.veins as Record<string, unknown>)) {
        if (typeof val === "number" && Number.isFinite(val)) veins[k] = val;
      }
    }
    return { veins, chest: typeof v.chest === "number" && Number.isFinite(v.chest) ? v.chest : 0 };
  } catch {
    return empty;
  }
}

export async function loadInstanceState(space: string): Promise<InstanceState> {
  if (!isBotApiConfigured()) return { veins: {}, chest: 0 };
  try {
    return parseInstanceState(await kvGet(WORLDBOX_INSTANCES_NAMESPACE, space));
  } catch {
    return { veins: {}, chest: 0 };
  }
}

export async function storeInstanceState(space: string, state: InstanceState): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_INSTANCES_NAMESPACE, space, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function isInstancesEnabled(): boolean {
  return isBotApiConfigured();
}

export type RuinsPersonalState = {
  /** 週キー（月曜）。違う週なら宝箱・罠・扉・召喚はリセットされる。 */
  week: string;
  chests: Record<string, boolean>;
  traps: Record<string, boolean>;
  doors: Record<string, boolean>;
  summons: { mobId: string; x: number; y: number }[];
  /** 主宝箱の初回開封（ruins_complete 済み）。週次リセット対象外。 */
  completed: boolean;
};

export function emptyRuinsPersonal(week: string): RuinsPersonalState {
  return { week, chests: {}, traps: {}, doors: {}, summons: [], completed: false };
}

export function parseRuinsPersonal(raw: unknown, week: string): RuinsPersonalState {
  const base = emptyRuinsPersonal(week);
  if (typeof raw !== "string" || raw === "") return base;
  try {
    const v = JSON.parse(raw) as Partial<RuinsPersonalState>;
    const completed = v.completed === true;
    if (v.week !== week) return { ...base, completed };
    const boolMap = (m: unknown): Record<string, boolean> => {
      const out: Record<string, boolean> = {};
      if (m && typeof m === "object") {
        for (const [k, val] of Object.entries(m as Record<string, unknown>)) if (val === true) out[k] = true;
      }
      return out;
    };
    const summons = Array.isArray(v.summons)
      ? v.summons.filter((s): s is { mobId: string; x: number; y: number } =>
          !!s && typeof s === "object" && typeof (s as { mobId?: unknown }).mobId === "string" &&
          typeof (s as { x?: unknown }).x === "number" && typeof (s as { y?: unknown }).y === "number")
      : [];
    return { week, chests: boolMap(v.chests), traps: boolMap(v.traps), doors: boolMap(v.doors), summons, completed };
  } catch {
    return base;
  }
}

function ruinsKey(space: string, ownerKey: string): string {
  return `${space}#${ownerKey}`;
}

export async function loadRuinsPersonal(space: string, ownerKey: string, week: string): Promise<RuinsPersonalState> {
  if (!isBotApiConfigured()) return emptyRuinsPersonal(week);
  try {
    return parseRuinsPersonal(await kvGet(WORLDBOX_INSTANCES_NAMESPACE, ruinsKey(space, ownerKey)), week);
  } catch {
    return emptyRuinsPersonal(week);
  }
}

export async function storeRuinsPersonal(space: string, ownerKey: string, state: RuinsPersonalState): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_INSTANCES_NAMESPACE, ruinsKey(space, ownerKey), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/* ================= ダンジョンのセッション（バッチ5） =================
 * パーティ別インスタンスの進行状態。キーは "<フロア1の空間ID>#<partyKey>"。
 * 全滅・全員離脱で削除する（インスタンスが閉じる）。クリア週の記録は
 * "dungeonclear:<ownerKey>" に週キーを残す（週1回の earn 判定）。
 */

export type DungeonSession = {
  partyKey: string;
  entrance: { x: number; y: number };
  /** 入場時点のパーティ人数（モブ HP 倍率の基準）。 */
  size: number;
  members: string[];
  departed: string[];
  dead: string[];
  floorBossDead: Record<string, boolean>;
  bossDead: boolean;
  /** 開いた鍵扉: "<floor>:<idx>" → true（パーティ共有）。 */
  doors: Record<string, boolean>;
  /** 宝箱の開封記録: "<ownerKey>:<floor>:<idx>" → 開封時刻。 */
  chests: Record<string, number>;
  startedAt: number;
};

export function dungeonSessionKey(spaceFloor1: string, partyKey: string): string {
  return `${spaceFloor1}#${partyKey}`;
}

function parseDungeonSession(raw: unknown, partyKey: string): DungeonSession | null {
  let data: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (raw && typeof raw === "object") {
    data = raw as Record<string, unknown>;
  }
  if (!data) return null;
  const entrance = data.entrance as { x?: unknown; y?: unknown } | null;
  if (!entrance || typeof entrance.x !== "number" || typeof entrance.y !== "number") return null;
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 8) : [];
  const chests: Record<string, number> = {};
  if (data.chests && typeof data.chests === "object" && !Array.isArray(data.chests)) {
    for (const [k, v] of Object.entries(data.chests as Record<string, unknown>)) {
      if (typeof v === "number") chests[k] = v;
    }
  }
  const floorBossDead: Record<string, boolean> = {};
  if (data.floorBossDead && typeof data.floorBossDead === "object" && !Array.isArray(data.floorBossDead)) {
    for (const [k, v] of Object.entries(data.floorBossDead as Record<string, unknown>)) {
      if (v === true) floorBossDead[k] = true;
    }
  }
  const doors: Record<string, boolean> = {};
  if (data.doors && typeof data.doors === "object" && !Array.isArray(data.doors)) {
    for (const [k, v] of Object.entries(data.doors as Record<string, unknown>)) {
      if (v === true) doors[k] = true;
    }
  }
  return {
    partyKey,
    entrance: { x: entrance.x, y: entrance.y },
    size: typeof data.size === "number" ? Math.max(1, Math.min(4, Math.floor(data.size))) : 1,
    members: strList(data.members),
    departed: strList(data.departed),
    dead: strList(data.dead),
    floorBossDead,
    bossDead: data.bossDead === true,
    doors,
    chests,
    startedAt: typeof data.startedAt === "number" ? data.startedAt : 0,
  };
}

export async function loadDungeonSession(spaceFloor1: string, partyKey: string): Promise<DungeonSession | null> {
  if (!isBotApiConfigured()) return null;
  try {
    const raw = await kvGet(WORLDBOX_INSTANCES_NAMESPACE, dungeonSessionKey(spaceFloor1, partyKey));
    return parseDungeonSession(raw, partyKey);
  } catch {
    return null;
  }
}

export async function storeDungeonSession(spaceFloor1: string, session: DungeonSession): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_INSTANCES_NAMESPACE, dungeonSessionKey(spaceFloor1, session.partyKey), JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

export async function deleteDungeonSession(spaceFloor1: string, partyKey: string): Promise<void> {
  if (!isBotApiConfigured()) return;
  try {
    await kvDelete(WORLDBOX_INSTANCES_NAMESPACE, dungeonSessionKey(spaceFloor1, partyKey));
  } catch { /* ベストエフォート */ }
}

/** 全員が離脱・死亡したらインスタンスは閉じる。 */
export function dungeonSessionClosed(session: DungeonSession): boolean {
  return session.members.every((m) => session.departed.includes(m) || session.dead.includes(m));
}

export async function loadDungeonClearWeek(ownerKey: string): Promise<string | null> {
  if (!isBotApiConfigured()) return null;
  try {
    const raw = await kvGet(WORLDBOX_INSTANCES_NAMESPACE, `dungeonclear:${ownerKey}`);
    if (typeof raw === "string") return raw;
    if (raw && typeof raw === "object") {
      const v = (raw as { week?: unknown }).week;
      return typeof v === "string" ? v : null;
    }
    return null;
  } catch {
    return null;
  }
}

export async function storeDungeonClearWeek(ownerKey: string, week: string): Promise<void> {
  if (!isBotApiConfigured()) return;
  try {
    await kvSet(WORLDBOX_INSTANCES_NAMESPACE, `dungeonclear:${ownerKey}`, JSON.stringify({ week }));
  } catch { /* ベストエフォート */ }
}

/** ダンジョンの熟練ゲート（F2 以降=ランク2+が1人、ボス層=ランク3+が1人）。 */
export async function dungeonGateSatisfied(
  memberKeys: readonly string[],
  floor: number,
): Promise<boolean> {
  if (floor < 2) return true;
  const ranks: number[] = [];
  for (const key of memberKeys) {
    const prof = await loadProfile(key);
    if (prof) ranks.push(masteryRankOf(prof, prof.role));
  }
  return partyGateSatisfied(ranks, floor >= DUNGEON_FLOORS ? "boss" : "floor2");
}
