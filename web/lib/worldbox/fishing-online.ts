// AGO WORLD BOX の釣りの再出現状態の保存（bot_kv）。
// キーは魚影の座標 "x,y"、値は最後に釣れた時刻。
import { isBotApiConfigured, kvGet, kvList, kvSet } from "../bot-api";
import { parseObjectStates } from "./objects";

export const WORLDBOX_FISHING_NAMESPACE = "worldbox_fishing";

export function isFishingEnabled(): boolean {
  return isBotApiConfigured();
}

export async function loadCaughtAt(x: number, y: number): Promise<number | null> {
  if (!isBotApiConfigured()) return null;
  try {
    const raw = await kvGet(WORLDBOX_FISHING_NAMESPACE, `${x},${y}`);
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export async function storeCaughtAt(x: number, y: number, at: number): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_FISHING_NAMESPACE, `${x},${y}`, String(at));
    if (caughtCache) caughtCache.map[`${x},${y}`] = at;
    return true;
  } catch {
    return false;
  }
}

// 一覧読み（他プレイヤーの釣果を魚影表示へ反映するため）。短TTL
// キャッシュで kvList の頻度を落とす（tiles-online と同じ考え方）。
const CAUGHT_CACHE_TTL_MS = 3_000;
let caughtCache: { at: number; map: Record<string, number> } | null = null;

/** 保存済みの釣果時刻をすべて読む（短TTLキャッシュつき）。 */
export async function loadAllCaughtAt(): Promise<Record<string, number>> {
  if (!isBotApiConfigured()) return {};
  if (caughtCache && Date.now() - caughtCache.at < CAUGHT_CACHE_TTL_MS) {
    return caughtCache.map;
  }
  try {
    const map = parseObjectStates(await kvList(WORLDBOX_FISHING_NAMESPACE));
    caughtCache = { at: Date.now(), map };
    return map;
  } catch {
    return caughtCache?.map ?? {};
  }
}
