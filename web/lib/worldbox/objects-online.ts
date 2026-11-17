// AGO WORLD BOX の地表オブジェクト枯渇状態の保存（bot_kv）。
// 名前空間 "worldbox_objects"、キー = "x,y"、値 = 最後に採取した時刻。
// 枯渇は全プレイヤー共有（洞窟の鉱脈と同じ性格）で、再出現は
// objects.ts の objectRespawned（定義の respawnMs）が正。
// 一覧読みは tiles-online と同じ短TTLキャッシュ＋世代ガードで
// kvList の頻度を落とす。書き込みはキャッシュへ即時反映する。
import { isBotApiConfigured, kvGet, kvList, kvSet } from "../bot-api";
import { parseObjectStates } from "./objects";

export const WORLDBOX_OBJECTS_NAMESPACE = "worldbox_objects";

export function isObjectsEnabled(): boolean {
  return isBotApiConfigured();
}

const STATES_CACHE_TTL_MS = 3_000;
let statesCache: { at: number; map: Record<string, number> } | null = null;
let statesEpoch = 0;

/** 保存済みの枯渇状態をすべて読む（短TTLキャッシュつき）。 */
export async function loadObjectStates(): Promise<Record<string, number>> {
  if (!isBotApiConfigured()) return {};
  if (statesCache && Date.now() - statesCache.at < STATES_CACHE_TTL_MS) {
    return statesCache.map;
  }
  const epochBefore = statesEpoch;
  let scanned: Record<string, number> = {};
  try {
    scanned = parseObjectStates(await kvList(WORLDBOX_OBJECTS_NAMESPACE));
  } catch {
    return statesCache?.map ?? {};
  }
  if (statesEpoch !== epochBefore) {
    // スキャン中に書き込みが入った: 書き込み分はキャッシュへ反映済み
    // なので、古いスナップショットで上書きせず重ねて返す。
    if (!statesCache) return scanned;
    const merged = { ...scanned, ...statesCache.map };
    statesCache = { at: Date.now(), map: merged };
    return merged;
  }
  statesCache = { at: Date.now(), map: scanned };
  return scanned;
}

/** 1オブジェクトの最終採取時刻を読む。無ければ null。 */
export async function loadHarvestedAt(x: number, y: number): Promise<number | null> {
  if (!isBotApiConfigured()) return null;
  try {
    const raw = await kvGet(WORLDBOX_OBJECTS_NAMESPACE, `${x},${y}`);
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** 採取時刻を保存する（キャッシュへも即時反映）。成功したら true。 */
export async function storeHarvestedAt(x: number, y: number, at: number): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_OBJECTS_NAMESPACE, `${x},${y}`, String(at));
    statesEpoch += 1;
    if (statesCache) statesCache.map[`${x},${y}`] = at;
    return true;
  } catch {
    return false;
  }
}
