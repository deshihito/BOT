// AGO WORLD BOX の経済ブリッジ（純粋ロジック）。
// Web は残高を直接触らない。経済操作は「オプ」として bot_kv
// （名前空間 "worldbox_economy"、キー = オプID）に積み、Bot 本体の
// ワーカーが既存の経済機構（pay_house / wallet / transfer_coins）で
// 適用して結果を書き戻す（設計: ago-coin-connection-design.md 案B）。
// ここはオプの形・検証・解釈だけを持ち、保存は economy-bridge-online.ts。
// steal は一旦廃止（2026-11-16）: buildEconomyOp は steal を作らず、
// Bot 側ワーカーも steal オプを failed(steal_disabled) で終端化する。
// 型と解釈（parseEconomyOp）は既存レコードの表示のために残す。
// 労働も廃止（2026-11-16）: earn の許可リストから "work" を外し、
// 新規の work オプは作れない（過去オプの parse は壊さない）。
// なお lib/worldbox/economy.ts はプロフィール側の状態遷移（かばん・
// 空腹度などコイン以外の検証）で、コインの移動はすべてこのブリッジの
// オプとして表現される。
export const WORLDBOX_ECONOMY_NAMESPACE = "worldbox_economy";

export type EconomyOpKind = "spend" | "earn" | "transfer" | "steal" | "gamble";
export type EconomyOpStatus = "pending" | "done" | "failed";

export interface EconomyOp {
  id: string;
  kind: EconomyOpKind;
  /** 所有者キー（"discord:<id>"）。自分のオプの抽出に使う。 */
  userKey: string;
  /** 適用先の Discord ユーザーID（送金・steal では受け手）。 */
  discordId: string;
  amount: number;
  reason: string;
  /** 送金の受け手（transfer のみ）。 */
  toDiscordId?: string;
  /** steal の奪い元（steal のみ）。ワーカーがこのユーザーから受け手へ移す。 */
  fromDiscordId?: string;
  /** gamble の確定配当（ベット込みの総額、0 = はずれ。gamble のみ必須）。
   * ワーカーはベットを引き落としてから、ベット分＋バンクロールで
   * 確保できた利益分を上限にこの額まで払う（Plan A）。 */
  payout?: number;
  /** gamble のベットが spend オプで先払い済みか（セッション型カジノ）。
   * true のときワーカーはベットを引き落とさず、配当の払いと負けの
   * 還流だけを行う。 */
  prepaid?: boolean;
  status: EconomyOpStatus;
  /** 失敗コード（failed のみ）。 */
  error?: string;
  /** 実際に動いた額（earn の部分払いなどで amount とずれる）。 */
  appliedAmount?: number;
  createdAt: number;
  appliedAt?: number;
}

export const ECONOMY_AMOUNT_MIN = 1;
export const ECONOMY_AMOUNT_MAX = 1_000_000;
export const ECONOMY_REASON_MAX = 40;
/** GET で返す自分のオプの件数。 */
export const ECONOMY_RECENT_OPS = 20;

/** earn の理由ホワイトリスト（サーバー側でのみ積む。Bot 側でも同じ集合で検証する）。 */
export const EARN_REASONS: ReadonlySet<string> = new Set([
  "harvest",
  "guild_shop_sale",
  "arena_prize",
  "arena_pvp_prize",
  "arena_pvp_fee_refund",
  "arena_tournament_prize",
  "arena_tournament_refund",
  "casino_tournament_prize",
  "casino_tournament_refund",
  "shop_sale",
  "guild_request_reward",
  "guild_request_refund",
  "ruins_complete",
  "dungeon_clear",
]);

/** gamble の理由ホワイトリスト（Bot 側でも同じ集合で検証する）。 */
export const GAMBLE_REASONS: ReadonlySet<string> = new Set([
  "casino_slot",
  "casino_roulette",
  "casino_dice",
  "casino_slot7",
  "casino_blackjack",
  "casino_double",
  "horse_racing",
]);

/** gamble の配当上限（ベット最大 1,000,000 × スロット最大倍率 300）。 */
export const GAMBLE_PAYOUT_MAX = 300_000_000;

/** gamble の配当: 整数 0..GAMBLE_PAYOUT_MAX のときだけ通す。 */
export function validateGamblePayout(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 0 || value > GAMBLE_PAYOUT_MAX) return null;
  return value;
}

const DISCORD_ID_RE = /^\d{5,25}$/;
const OP_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** 金額: 整数 1..1,000,000 のときだけ通す。 */
export function validateEconomyAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < ECONOMY_AMOUNT_MIN || value > ECONOMY_AMOUNT_MAX) return null;
  return value;
}

/** 理由: 前後の空白を落として 1..40 文字のときだけ通す。 */
export function validateEconomyReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  if (reason.length === 0 || reason.length > ECONOMY_REASON_MAX) return null;
  return reason;
}

/** Discord ユーザーIDの形（数字のみ）。 */
export function validateDiscordId(value: unknown): string | null {
  if (typeof value !== "string" || !DISCORD_ID_RE.test(value)) return null;
  return value;
}

export interface BuildEconomyOpInput {
  kind: EconomyOpKind;
  userKey: string;
  discordId: string;
  amount: unknown;
  reason: unknown;
  toDiscordId?: unknown;
  fromDiscordId?: unknown;
  payout?: unknown;
  prepaid?: unknown;
}

/**
 * オプを組み立てる。検証を通らなければ null。
 * earn はホワイトリストの理由だけ、transfer は受け手が必須で自分宛ては不可、
 * steal は奪い元が必須で自分自身からは不可。
 */
export function buildEconomyOp(input: BuildEconomyOpInput, id: string, now: number): EconomyOp | null {
  if (!OP_ID_RE.test(id)) return null;
  if (typeof input.userKey !== "string" || input.userKey.length === 0) return null;
  const discordId = validateDiscordId(input.discordId);
  if (discordId === null) return null;
  const amount = validateEconomyAmount(input.amount);
  if (amount === null) return null;
  const reason = validateEconomyReason(input.reason);
  if (reason === null) return null;
  if (input.kind === "earn" && !EARN_REASONS.has(reason)) return null;
  if (input.kind === "gamble" && !GAMBLE_REASONS.has(reason)) return null;
  // steal は一旦廃止（2026-11-16 ユーザー指示）。新規オプはどの経路からも作れない
  // （保存済みオプの解釈は parseEconomyOp 側に残し、ワーカーが終端化する）。
  if (input.kind === "steal") return null;
  const op: EconomyOp = {
    id,
    kind: input.kind,
    userKey: input.userKey,
    discordId,
    amount,
    reason,
    status: "pending",
    createdAt: now,
  };
  if (input.kind === "transfer") {
    const to = validateDiscordId(input.toDiscordId);
    if (to === null || to === discordId) return null;
    op.toDiscordId = to;
  }
  if (input.kind === "gamble") {
    const payout = validateGamblePayout(input.payout);
    if (payout === null) return null;
    op.payout = payout;
    if (input.prepaid === true) op.prepaid = true;
  }
  return op;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 保存済みの値（オブジェクト、または JSON 文字列）をオプとして解釈する。
 * 形が壊れていれば null。未知の追加フィールド（Bot 側の claim 等）は捨てる。
 */
export function parseEconomyOp(raw: unknown): EconomyOp | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  const { id, kind, userKey, discordId, status } = value;
  if (typeof id !== "string" || !OP_ID_RE.test(id)) return null;
  if (kind !== "spend" && kind !== "earn" && kind !== "transfer" && kind !== "steal" && kind !== "gamble") return null;
  if (typeof userKey !== "string" || userKey.length === 0) return null;
  if (validateDiscordId(discordId) === null) return null;
  if (status !== "pending" && status !== "done" && status !== "failed") return null;
  const amount = validateEconomyAmount(value.amount);
  if (amount === null) return null;
  const reason = validateEconomyReason(value.reason);
  if (reason === null) return null;
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return null;
  const op: EconomyOp = {
    id,
    kind,
    userKey,
    discordId: discordId as string,
    amount,
    reason,
    status,
    createdAt: value.createdAt,
  };
  if (kind === "transfer") {
    const to = validateDiscordId(value.toDiscordId);
    if (to === null) return null;
    op.toDiscordId = to;
  }
  if (kind === "steal") {
    const from = validateDiscordId(value.fromDiscordId);
    if (from === null) return null;
    op.fromDiscordId = from;
  }
  if (kind === "gamble") {
    const payout = validateGamblePayout(value.payout);
    if (payout === null) return null;
    op.payout = payout;
    if (value.prepaid === true) op.prepaid = true;
  }
  if (typeof value.error === "string" && value.error.length > 0) op.error = value.error;
  if (typeof value.appliedAmount === "number" && Number.isInteger(value.appliedAmount) && value.appliedAmount >= 0) {
    op.appliedAmount = value.appliedAmount;
  }
  if (typeof value.appliedAt === "number" && Number.isFinite(value.appliedAt)) op.appliedAt = value.appliedAt;
  return op;
}

/** 自分のオプを新しい順に最大 limit 件。 */
export function recentEconomyOps(ops: readonly EconomyOp[], userKey: string, limit = ECONOMY_RECENT_OPS): EconomyOp[] {
  return ops
    .filter((op) => op.userKey === userKey)
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
    .slice(0, Math.max(0, limit));
}
