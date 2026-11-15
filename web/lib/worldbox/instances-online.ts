// AGO WORLD BOX のインスタンス枯渇状態の保存（サーバー専用）。
// 保存先は bot_kv（名前空間 "worldbox_instances"、キー = 空間 ID）。
// 値: { veins: { veinKey: 採取時刻 }, chest: 宝箱を開けた時刻 }。
import { isBotApiConfigured, kvGet, kvSet } from "../bot-api";

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
