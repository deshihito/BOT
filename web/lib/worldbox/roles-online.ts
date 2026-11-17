// AGO WORLD BOX の死亡地点記録（サーバー専用。薬師の蘇生用）。
// 保存先は bot_kv（名前空間 "worldbox_deaths"、キー = 所有者キー）。
import { isBotApiConfigured, kvDelete, kvList, kvSet } from "../bot-api";

export const WORLDBOX_DEATHS_NAMESPACE = "worldbox_deaths";
/** 蘇生できる死亡記録の寿命。 */
export const DEATH_RECORD_TTL_MS = 90_000;

export type DeathRecord = {
  ownerKey: string;
  name: string;
  space: string;
  x: number;
  y: number;
  at: number;
};

export async function recordDeath(rec: Omit<DeathRecord, "ownerKey"> & { ownerKey: string }): Promise<void> {
  if (!isBotApiConfigured()) return;
  try {
    await kvSet(WORLDBOX_DEATHS_NAMESPACE, rec.ownerKey, JSON.stringify({
      name: rec.name, space: rec.space, x: rec.x, y: rec.y, at: rec.at,
    }));
  } catch { /* 記録できなくても死亡処理は続ける */ }
}

export async function listDeaths(now: number): Promise<DeathRecord[]> {
  if (!isBotApiConfigured()) return [];
  try {
    const rows = await kvList(WORLDBOX_DEATHS_NAMESPACE);
    const out: DeathRecord[] = [];
    for (const [key, raw] of rows) {
      try {
        const v = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as Partial<DeathRecord>;
        if (typeof v.space !== "string" || typeof v.x !== "number" || typeof v.y !== "number" || typeof v.at !== "number") continue;
        if (now - v.at > DEATH_RECORD_TTL_MS) continue;
        out.push({ ownerKey: key, name: typeof v.name === "string" ? v.name : "", space: v.space, x: v.x, y: v.y, at: v.at });
      } catch { /* 壊れた記録は無視 */ }
    }
    return out;
  } catch {
    return [];
  }
}

export async function clearDeath(ownerKey: string): Promise<void> {
  if (!isBotApiConfigured()) return;
  try {
    await kvDelete(WORLDBOX_DEATHS_NAMESPACE, ownerKey);
  } catch { /* ベストエフォート */ }
}
