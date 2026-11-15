// AGO WORLD BOX の計測の保存（bot_kv）と記録ヘルパー（サーバー専用）。
// 名前空間: worldbox_metrics（キー = 日付）/ worldbox_metrics_users
// （キー = 所有者キー）。記録はベストエフォート: 失敗しても呼び出し元の
// ゲーム処理は止めない。read-modify-write はプロセス内ロックで直列化する
// （Web は Pi 上の単一プロセス前提、他の状態と同じ）。
import { isBotApiConfigured, kvGet, kvSet } from "../bot-api";
import {
  dayKeyOf, emptyDayMetrics, parseDayMetrics, parseUserFirstSteps,
  type DayMetrics, type UserFirstSteps,
} from "./metrics";
import { withUserLock } from "./user-lock";

export const WORLDBOX_METRICS_NAMESPACE = "worldbox_metrics";
export const WORLDBOX_METRICS_USERS_NAMESPACE = "worldbox_metrics_users";
export const WORLDBOX_METRICS_ECON_NAMESPACE = "worldbox_metrics_econ";

export async function loadDayMetrics(date: string): Promise<DayMetrics> {
  if (!isBotApiConfigured()) return emptyDayMetrics(date);
  try {
    return parseDayMetrics(await kvGet(WORLDBOX_METRICS_NAMESPACE, date), date);
  } catch {
    return emptyDayMetrics(date);
  }
}

async function updateDay(now: number, fn: (day: DayMetrics) => void): Promise<void> {
  if (!isBotApiConfigured()) return;
  const date = dayKeyOf(now);
  try {
    await withUserLock("metrics:day", async () => {
      const day = parseDayMetrics(await kvGet(WORLDBOX_METRICS_NAMESPACE, date), date);
      fn(day);
      await kvSet(WORLDBOX_METRICS_NAMESPACE, date, JSON.stringify(day));
    });
  } catch {
    /* 計測はベストエフォート */
  }
}

/** プレゼンスのハートビートから DAU・同時接続ピークを記録する。 */
export async function recordPresenceMetric(
  ownerKey: string,
  onlineCount: number,
  now: number,
): Promise<void> {
  await updateDay(now, (day) => {
    if (!day.dau.includes(ownerKey) && day.dau.length < 2000) day.dau.push(ownerKey);
    if (onlineCount > day.peak) day.peak = onlineCount;
  });
  await recordFirstStep(ownerKey, "seen", now);
}

export async function bumpMetric(
  field: "blocksPlaced" | "harvests" | "chatsNear" | "chatsGlobal" | "chatsUnion" | "guildShopVolume",
  by: number,
  now: number,
): Promise<void> {
  if (by <= 0) return;
  await updateDay(now, (day) => {
    day[field] += by;
  });
}

/** 初回ステップ（seen/gather/place/lobby）を記録する。既存は上書きしない。 */
export async function recordFirstStep(
  ownerKey: string,
  step: "seen" | "gather" | "place" | "lobby",
  now: number,
): Promise<void> {
  if (!isBotApiConfigured()) return;
  try {
    await withUserLock(`metrics:user:${ownerKey}`, async () => {
      const current = parseUserFirstSteps(await kvGet(WORLDBOX_METRICS_USERS_NAMESPACE, ownerKey));
      const next: UserFirstSteps = current ?? { firstAt: now };
      if (step === "gather" && !next.gatherAt) next.gatherAt = now;
      if (step === "place" && !next.placeAt) next.placeAt = now;
      if (step === "lobby" && !next.lobbyAt) next.lobbyAt = now;
      if (!current || JSON.stringify(next) !== JSON.stringify(current)) {
        await kvSet(WORLDBOX_METRICS_USERS_NAMESPACE, ownerKey, JSON.stringify(next));
      }
    });
  } catch {
    /* ベストエフォート */
  }
}

export async function loadUserFirstSteps(ownerKey: string): Promise<UserFirstSteps | null> {
  if (!isBotApiConfigured()) return null;
  try {
    return parseUserFirstSteps(await kvGet(WORLDBOX_METRICS_USERS_NAMESPACE, ownerKey));
  } catch {
    return null;
  }
}

export async function loadEconDay(date: string): Promise<Record<string, unknown> | null> {
  if (!isBotApiConfigured()) return null;
  try {
    const raw = await kvGet(WORLDBOX_METRICS_ECON_NAMESPACE, date);
    if (typeof raw === "string") return JSON.parse(raw) as Record<string, unknown>;
    if (raw && typeof raw === "object") return raw as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}
