// AGO WORLD BOX の国家設定の保存（bot_kv、サーバー専用）。
// 名前空間 `worldbox_nation_settings`、キーはギルド ID（= 国 ID）。
// 書き込みは国単位のロックで直列化する（王の設定変更とギルドショップの
// 税収加算が同時に走っても互いを上書きしない）。
import { isBotApiConfigured, kvGet, kvList, kvSet } from "../bot-api";
import {
  defaultNationSettings, parseNationSettings, type NationSettings,
} from "./nation-settings";
import { withUserLock } from "./user-lock";

export const WORLDBOX_NATION_SETTINGS_NAMESPACE = "worldbox_nation_settings";

export function isNationSettingsEnabled(): boolean {
  return isBotApiConfigured();
}

/** 1国分の設定を読む。無い・読めない・未設定なら既定値。 */
export async function loadNationSettings(guildId: string): Promise<NationSettings> {
  if (!isBotApiConfigured()) return defaultNationSettings();
  try {
    return parseNationSettings(await kvGet(WORLDBOX_NATION_SETTINGS_NAMESPACE, guildId));
  } catch {
    return defaultNationSettings();
  }
}

/** 全国家分設定をまとめて読む（一覧・ランキングの公開フィルタ用）。 */
export async function loadNationSettingsMap(): Promise<Map<string, NationSettings>> {
  const out = new Map<string, NationSettings>();
  if (!isBotApiConfigured()) return out;
  try {
    const all = await kvList(WORLDBOX_NATION_SETTINGS_NAMESPACE);
    for (const [guildId, raw] of all) out.set(guildId, parseNationSettings(raw));
  } catch {
    // 読めなければ全て既定（= 公開・税率5%）として扱う
  }
  return out;
}

/** 1国分の設定を保存する。成功したら true。 */
export async function storeNationSettings(guildId: string, settings: NationSettings): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_NATION_SETTINGS_NAMESPACE, guildId, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/**
 * 設定をロック内で読み→変換→保存する。fn が null を返したら保存しない。
 * 保存後の設定（保存しなかった場合は現在の設定）を返す。保存失敗は null。
 */
export async function updateNationSettings(
  guildId: string,
  fn: (current: NationSettings) => NationSettings | null,
): Promise<NationSettings | null> {
  return withUserLock(`nation-settings:${guildId}`, async () => {
    const current = await loadNationSettings(guildId);
    const next = fn(current);
    if (!next) return current;
    if (!(await storeNationSettings(guildId, next))) return null;
    return next;
  });
}
