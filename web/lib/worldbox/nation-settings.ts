// AGO WORLD BOX の国家設定（純粋ロジック、DOM 非依存）。
// 国ごとの設定（税率・公開/非公開・任命大臣・累計税収）を bot_kv
// `worldbox_nation_settings`（キー = ギルド ID）に持つ。保存は
// nation-settings-online.ts、入口は /api/worldbox/nation-settings。
//
// 税率: ギルドショップの売り手取り分から差し引く割合。国が未設定なら
// 既定 5%。税分は国庫（treasury）へ積む（2026-11-17 バッチE4で
// シンクから仕様書 §3 の国庫へ変更。ユーザー指示「積まずに消える
// 部分だけ仕様書に変更」— 税率上限・対象は従来どおり）。累計税収は
// taxCollected に表示用として併せて加算する。
// 大臣: 役職解決は「王 > 明示任命（ministers）∪ Discord ADMINISTRATOR
// 由来 > 国民」。任命は現在の国民にだけ効き、国民でなくなれば自動で
// 落ちる（解決時に所属と突き合わせる）。Discord 由来の大臣はゲーム内
// からは解除できない。
// 公開/非公開: private の国は繁栄ランキングと国一覧（参加先候補）に
// 載らず、参加（join）もできない。所属員には自国だけは見える。
// 移民コントロール（2026-11-17、経済仕様書 §7.2）: 入国料（参加時に
// 徴収する固定額）と出金料率（離脱時に所持金へ掛ける割合）を王が
// 設定できる。徴収分は国庫（treasury）へ積み、累計を feesCollected
// に表示用として併せて加算する（バッチE4）。
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
  /** 入国料（コイン、0〜100,000。参加時に徴収。経済仕様書 §7.2）。 */
  entryFee: number;
  /** 出金料率（0〜0.80。離脱時に所持金へ掛けて徴収。経済仕様書 §7.2）。 */
  exitFeeRate: number;
  /** 累計の入国料・出金料収入（表示用。税収とは別枠）。 */
  feesCollected: number;
  /**
   * 国庫残高（経済仕様書 §3 の treasury_coins）。税・入国料・出金料の
   * 受け皿で、徴収のたびに増える。引き出し等の使い道は未実装。
   */
  treasury: number;
  updatedAt: number;
};

/** 税率の既定値（未設定国の手数料。旧 GUILD_SHOP_FEE_RATE と同じ 5%）。 */
export const TAX_RATE_DEFAULT = 0.05;
/** 税率の上限。 */
export const TAX_RATE_MAX = 0.1;
/** 入国料の上限（コイン）。 */
export const ENTRY_FEE_MAX = 100_000;
/** 出金料率の上限（仕様書 §7.2 の最大 80%）。 */
export const EXIT_FEE_RATE_MAX = 0.8;

export function defaultNationSettings(): NationSettings {
  return {
    taxRate: TAX_RATE_DEFAULT, visibility: "open", ministers: [], taxCollected: 0,
    entryFee: 0, exitFeeRate: 0, feesCollected: 0, treasury: 0, updatedAt: 0,
  };
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

/** 入国料として有効な値に丸める（整数コイン、範囲外は 0 = 無料）。 */
export function normalizeEntryFee(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  if (raw < 0 || raw > ENTRY_FEE_MAX) return 0;
  return Math.floor(raw);
}

/** 出金料率として有効な値に丸める（0〜0.80、0.1% 単位。範囲外は 0）。 */
export function normalizeExitFeeRate(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  if (raw < 0 || raw > EXIT_FEE_RATE_MAX) return 0;
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
  out.entryFee = normalizeEntryFee(v.entryFee);
  out.exitFeeRate = normalizeExitFeeRate(v.exitFeeRate);
  if (typeof v.feesCollected === "number" && Number.isFinite(v.feesCollected) && v.feesCollected > 0) {
    out.feesCollected = Math.floor(v.feesCollected);
  }
  if (typeof v.treasury === "number" && Number.isFinite(v.treasury) && v.treasury > 0) {
    out.treasury = Math.floor(v.treasury);
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

/** 国の入国料（未設定なら 0 = 無料）。 */
export function entryFeeOf(settings: NationSettings | null | undefined): number {
  return settings ? settings.entryFee : 0;
}

/** 国の出金料率（未設定なら 0）。 */
export function exitFeeRateOf(settings: NationSettings | null | undefined): number {
  return settings ? settings.exitFeeRate : 0;
}

/** 国庫残高（未設定なら 0）。 */
export function treasuryOf(settings: NationSettings | null | undefined): number {
  return settings ? settings.treasury : 0;
}

/** 出金料の金額: 所持金 × 出金料率（切り捨て）。残高が負なら 0。 */
export function exitFeeAmount(balance: number, rate: number): number {
  if (!Number.isFinite(balance) || balance <= 0) return 0;
  const r = normalizeExitFeeRate(rate);
  return Math.floor(balance * r);
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
