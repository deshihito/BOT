// AGO WORLD BOX の国家設定（純粋ロジック、DOM 非依存）。
// 国ごとの設定（税率・公開/非公開・任命大臣・累計税収）を bot_kv
// `worldbox_nation_settings`（キー = ギルド ID）に持つ。保存は
// nation-settings-online.ts、入口は /api/worldbox/nation-settings。
//
// 税率: ギルドショップの売り手取り分から差し引く割合。国が未設定なら
// 既定 5%。税分は従来どおり積まない（国庫シンク相当）で、累計だけを
// taxCollected に表示用として加算する。
// 大臣: 役職解決は「王 > 明示任命（ministers）∪ Discord ADMINISTRATOR
// 由来 > 国民」。任命は現在の国民にだけ効き、国民でなくなれば自動で
// 落ちる（解決時に所属と突き合わせる）。Discord 由来の大臣はゲーム内
// からは解除できない。
// 公開/非公開: private の国は繁栄ランキングと国一覧（参加先候補）に
// 載らず、参加（join）もできない。所属員には自国だけは見える。
import type { Nation, NationRole, NationsState } from "./nations";

export type NationVisibility = "open" | "private";

export type NationSettings = {
  /** ギルドショップ手数料率（0〜0.10）。 */
  taxRate: number;
  visibility: NationVisibility;
  /** 王が任命した大臣の所有者キー。 */
  ministers: string[];
  /** 累計税収（表示用）。 */
  taxCollected: number;
  updatedAt: number;
};

/** 税率の既定値（未設定国の手数料。旧 GUILD_SHOP_FEE_RATE と同じ 5%）。 */
export const TAX_RATE_DEFAULT = 0.05;
/** 税率の上限。 */
export const TAX_RATE_MAX = 0.1;

export function defaultNationSettings(): NationSettings {
  return { taxRate: TAX_RATE_DEFAULT, visibility: "open", ministers: [], taxCollected: 0, updatedAt: 0 };
}

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

/** 税率として有効な値に丸める（範囲外は既定値、範囲内は 0.1% 単位に整形）。 */
export function normalizeTaxRate(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return TAX_RATE_DEFAULT;
  if (raw < 0 || raw > TAX_RATE_MAX) return TAX_RATE_DEFAULT;
  return Math.round(raw * 1000) / 1000;
}

/** 保存値を検証して復元する。壊れた要素は既定に落とす。 */
export function parseNationSettings(raw: unknown): NationSettings {
  const out = defaultNationSettings();
  const v = asRecord(raw);
  if (!v) return out;
  out.taxRate = normalizeTaxRate(v.taxRate);
  out.visibility = v.visibility === "private" ? "private" : "open";
  if (Array.isArray(v.ministers)) {
    const seen = new Set<string>();
    for (const key of v.ministers) {
      if (typeof key !== "string" || key.length === 0 || key.length > 64 || seen.has(key)) continue;
      seen.add(key);
      out.ministers.push(key);
      if (out.ministers.length >= 200) break;
    }
  }
  if (typeof v.taxCollected === "number" && Number.isFinite(v.taxCollected) && v.taxCollected > 0) {
    out.taxCollected = Math.floor(v.taxCollected);
  }
  if (typeof v.updatedAt === "number" && Number.isFinite(v.updatedAt) && v.updatedAt > 0) {
    out.updatedAt = Math.floor(v.updatedAt);
  }
  return out;
}

/** 国の税率（未設定なら既定 5%）。 */
export function taxRateOf(settings: NationSettings | null | undefined): number {
  return settings ? settings.taxRate : TAX_RATE_DEFAULT;
}

/** 非公開の国か。 */
export function isPrivateNation(settings: NationSettings | null | undefined): boolean {
  return settings?.visibility === "private";
}

/** その国の現在の国民の所有者キー集合。 */
export function memberKeysOf(state: NationsState, guildId: string): Set<string> {
  const keys = new Set<string>();
  for (const [ownerKey, m] of Object.entries(state.members)) {
    if (m.nationId === guildId) keys.add(ownerKey);
  }
  return keys;
}

/** 任命大臣のうち、現在の国民であるものだけ（離脱者は自動で落ちる）。 */
export function effectiveMinisters(
  settings: NationSettings | null | undefined,
  memberKeys: ReadonlySet<string>,
): string[] {
  if (!settings) return [];
  return settings.ministers.filter((key) => memberKeys.has(key));
}

export type ResolvedMemberRole = {
  role: NationRole;
  /** 王に任命された大臣か。 */
  appointed: boolean;
  /** Discord の ADMINISTRATOR 権限由来の大臣か。 */
  discordMinister: boolean;
};

/**
 * 1人の国民の役職を解決する。優先順は 王 > 任命大臣 ∪ Discord 大臣 > 国民。
 * storedRole は nations 側に保存された Discord 由来の役職（呼び出し側が
 * 最新化したもの）。国民でない所有者キーには null。
 */
export function resolveMemberRole(
  nation: Pick<Nation, "kingKey">,
  settings: NationSettings | null | undefined,
  ownerKey: string,
  storedRole: NationRole,
  memberKeys: ReadonlySet<string>,
): ResolvedMemberRole | null {
  if (!memberKeys.has(ownerKey)) return null;
  if (ownerKey === nation.kingKey) return { role: "king", appointed: false, discordMinister: false };
  const appointed = effectiveMinisters(settings, memberKeys).includes(ownerKey);
  const discordMinister = storedRole === "minister";
  if (appointed || discordMinister) return { role: "minister", appointed, discordMinister };
  return { role: "citizen", appointed: false, discordMinister: false };
}

/**
 * 国一覧・ランキングでその国を閲覧者から隠すか。
 * private の国は自国民にだけ見える（自国分のみ）。
 */
export function isNationHiddenFrom(
  settings: NationSettings | null | undefined,
  nationId: string,
  viewerNationId: string | null | undefined,
): boolean {
  if (!isPrivateNation(settings)) return false;
  return viewerNationId !== nationId;
}
