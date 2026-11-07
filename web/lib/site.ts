// サイト共通の定数と、販促計測まわりの純粋ロジック（環境変数・fetch に触れない）
//
// 招待URLはポータルの Install Link として設定済みのものが唯一の正。
// パラメータ（permissions 等）を推測で変えず、ここ1か所だけに置く。

/** サイトの公開オリジン（metadataBase・canonical・sitemap 等の唯一の正）。 */
export const SITE_URL = "https://agobot.app";

export const BOT_INVITE_URL =
  "https://discord.com/oauth2/authorize?client_id=1476636487784337428&permissions=4544817123422033&integration_type=0&scope=bot%20applications.commands";

export const SUPPORT_SERVER_URL = "https://discord.gg/dCAQzJUaa9";

/** 流入計測（/invite?src=）で受け付ける媒体名。これ以外は "direct" として記録する。 */
export const INVITE_SOURCES = [
  "topgg",
  "botsgg",
  "dclist",
  "dissoku",
  "disboard",
  "x",
  "note",
  "website",
] as const;

export const DEFAULT_INVITE_SOURCE = "direct";

export function normalizeInviteSource(raw: string | null | undefined): string {
  if (typeof raw !== "string") return DEFAULT_INVITE_SOURCE;
  const src = raw.trim().toLowerCase();
  if (!/^[a-z0-9-]{1,32}$/.test(src)) return DEFAULT_INVITE_SOURCE;
  return (INVITE_SOURCES as readonly string[]).includes(src) ? src : DEFAULT_INVITE_SOURCE;
}

/** /invite のクリック記録を置く bot_kv の名前空間。 */
export const INVITE_CLICKS_NAMESPACE = "invite_clicks";

/** 公開ランキングのスナップショットを置く bot_kv の名前空間とキー。 */
export const PUBLIC_RANKING_NAMESPACE = "public_ranking";
export const PUBLIC_RANKING_KEY = "snapshot";

export type RankingEntry = {
  name: string;
  value: number;
  level?: number;
};

export type PublicRankingSnapshot = {
  updated_at: string;
  exp: RankingEntry[];
  coin: RankingEntry[];
};

function cleanEntries(raw: unknown, withLevel: boolean): RankingEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: RankingEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.value !== "number" || !Number.isFinite(record.value)) continue;
    const entry: RankingEntry = {
      name: typeof record.name === "string" ? record.name : "",
      value: Math.trunc(record.value),
    };
    if (withLevel && typeof record.level === "number" && Number.isFinite(record.level)) {
      entry.level = Math.trunc(record.level);
    }
    entries.push(entry);
  }
  return entries;
}

/** Bot が書いた生スナップショットを、表示に使える形へ検証して寄せる。 */
export function parseRankingSnapshot(raw: unknown): PublicRankingSnapshot | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.updated_at !== "string" || record.updated_at === "") return null;
  return {
    updated_at: record.updated_at,
    exp: cleanEntries(record.exp, true),
    coin: cleanEntries(record.coin, false),
  };
}
