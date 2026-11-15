// AGO WORLD BOX の釣りの再出現状態の保存（bot_kv）。
// キーは魚影の座標 "x,y"、値は最後に釣れた時刻。
import { isBotApiConfigured, kvGet, kvSet } from "../bot-api";

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
    return true;
  } catch {
    return false;
  }
}
