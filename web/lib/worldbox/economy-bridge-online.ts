// AGO WORLD BOX 経済ブリッジの保存（サーバー専用）。
// オプは bot_kv（名前空間 "worldbox_economy"、キー = オプID）に
// オブジェクトのまま保存する（bg_cutout の結果レコードと同じ流儀。
// Bot 本体のワーカーが dict として読み、結果を同じキーへ書き戻す）。
// 残高の読み取りは Bot API の許可テーブル users への select。
// コインの適用は submitEconomyOp が正: 対応する種別は bot-api 経由で
// その場で適用し（CAS / transfer_coins RPC）、オプ記録と適用台帳
// （worldbox_economy_applied）をワーカーと同じ形で残す。直接適用が
// 使えない・金を動かす前に失敗した場合は従来のキュー経路へ寄せる。
import {
  BotApiError, isBotApiConfigured, kvDelete, kvGet, kvList, kvSet, rpc, tableInsert, tableSelect, tableUpdate,
} from "../bot-api";
import {
  WORLDBOX_ECONOMY_NAMESPACE, parseEconomyOp, recentEconomyOps, type EconomyOp,
} from "./economy-bridge";

export function isEconomyEnabled(): boolean {
  return isBotApiConfigured();
}

/** オプをキューへそのまま積む（直接適用のフォールバック専用）。 */
async function queueEconomyOp(op: EconomyOp): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvSet(WORLDBOX_ECONOMY_NAMESPACE, op.id, op);
    return true;
  } catch {
    return false;
  }
}

/**
 * オプの登録（直接適用が正）。submitEconomyOp へ委譲し、直接適用
 * できた場合はその場で終端する。戻り値は「登録できたか」で、終端
 * 状態そのものではない（必要な呼び出し側は findEconomyOp /
 * waitForOpDone で読む。直接適用後は done/failed が即座に読める）。
 */
export async function enqueueEconomyOp(op: EconomyOp): Promise<boolean> {
  const result = await submitEconomyOp(op);
  return result.state !== "unavailable";
}

/**
 * 冪等なオプ登録（カジノの enqueueSettleOnce と同じ規則、PR #943）。
 * 決定的 ID のオプ専用: 同 ID のオプが既にあれば（pending / done /
 * failed を問わず）作り直さず true を返す。「1つの論理的な支払い =
 * オプ1件」を保証し、再試行や並行リクエストで二重に払われない。
 * submitEconomyOp が既存記録・適用台帳を先に見るため、done 済み
 * オプを pending で上書きして再適用させることもない。
 */
export async function enqueueEconomyOpOnce(op: EconomyOp): Promise<boolean> {
  const result = await submitEconomyOp(op);
  return result.state !== "unavailable";
}

/** 全ユーザーのオプ（カジノ大会の最終精算など、横断的な照合用）。読めなければ空配列。 */
export async function loadAllEconomyOps(): Promise<EconomyOp[]> {
  if (!isBotApiConfigured()) return [];
  try {
    const all = await kvList(WORLDBOX_ECONOMY_NAMESPACE);
    const ops: EconomyOp[] = [];
    for (const raw of all.values()) {
      const op = parseEconomyOp(raw);
      if (op) ops.push(op);
    }
    return ops;
  } catch {
    return [];
  }
}

/** 自分のオプ（新しい順・最大20件）。読めなければ空配列。 */
export async function loadMyEconomyOps(userKey: string): Promise<EconomyOp[]> {
  return recentEconomyOps(await loadAllEconomyOps(), userKey);
}

/** 自分のオプを ID で1件引く（セッション先払いの状態確認用）。無ければ null。 */
export async function findEconomyOp(userKey: string, opId: string): Promise<EconomyOp | null> {
  if (!isBotApiConfigured()) return null;
  try {
    const raw = await kvGet(WORLDBOX_ECONOMY_NAMESPACE, opId);
    if (raw === null) return null;
    const op = parseEconomyOp(raw);
    return op && op.userKey === userKey ? op : null;
  } catch {
    return null;
  }
}

/**
 * オプを1件消す。終端した失敗オプだけを対象にする: 金が動いていない
 * 失敗オプが決定的 ID に残っていると、その ID の再試行（テント拡張など）
 * が塞がれてしまうため、消してから積み直す。成功したら true。
 */
export async function deleteEconomyOp(opId: string): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvDelete(WORLDBOX_ECONOMY_NAMESPACE, opId);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * server-side wait の既定値。ワーカーは適応ポーリング（処理がある間は
 * 0.4 秒間隔）で回るため、数秒待てば通常は done に出会える。上限を
 * 超えたら pending のまま返し、呼び出し側は従来どおりクライアントの
 * ポーリングに引き継ぐ（挙動は壊れない）。
 */
export const OP_WAIT_TIMEOUT_MS = 3_000;
export const OP_WAIT_INTERVAL_MS = 200;

export type OpWaitOptions = { timeoutMs?: number; intervalMs?: number };

/**
 * オプが終端（done / failed）になるまでその場で待つ。戻り値は最後に
 * 読めたオプ（タイムアウト時は pending のオプ、読めなければ null）。
 * 「次の処理が done に依存する」経路（カジノの先払い→精算、アリーナ
 * の参加費→対戦開始など）が、クライアントの再ポーリングを待たずに
 * 同一リクエストで最終状態まで進むための共通ヘルパー。
 */
export async function waitForOpDone(
  userKey: string,
  opId: string,
  options: OpWaitOptions = {},
): Promise<EconomyOp | null> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? OP_WAIT_TIMEOUT_MS);
  const intervalMs = Math.max(10, options.intervalMs ?? OP_WAIT_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const op = await findEconomyOp(userKey, opId);
    if (op === null || op.status !== "pending") return op;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return op;
    await sleep(Math.min(intervalMs, remaining));
  }
}

/** 複数オプの done を並行して待つ（PvP の両者参加費など、所有者が違うオプの混在可）。 */
export async function waitForOpsDone(
  targets: readonly { userKey: string; opId: string }[],
  options: OpWaitOptions = {},
): Promise<(EconomyOp | null)[]> {
  return Promise.all(targets.map((t) => waitForOpDone(t.userKey, t.opId, options)));
}

type UserBalanceRow = { balance?: unknown };

/**
 * 残高の読み取り（users テーブルへの select のみ）。
 * 行が無いユーザーは 0（行は作らない）。読めなければ null。
 */
export async function readUserBalance(discordId: string): Promise<number | null> {
  if (!isBotApiConfigured()) return null;
  try {
    const rows = await tableSelect<UserBalanceRow>(
      "users",
      "balance",
      [{ column: "user_id", op: "eq", value: discordId }],
      1,
    );
    if (rows.length === 0) return 0;
    const balance = Number(rows[0].balance ?? 0);
    return Number.isFinite(balance) ? Math.trunc(balance) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 直接適用（bot-api 経由でその場でコインを動かす）
//
// ワーカー（core/general/circulation/worldbox_economy.py）と同型の
// 冪等手順を Web 側でも踏む:
//   1. 適用台帳（worldbox_economy_applied）を確認する。applied / failed
//      が残っていれば再適用せず結果だけをオプ記録へ書き直す。
//      applying のままなら成否が曖昧なので触らずキュー側に委ねる
//      （ワーカーが apply_uncertain で終端化する）。
//   2. オプ記録へ claim（トークン+時刻）を書いて再読で勝ちを確認する。
//      ワーカーは新鮮な claim のあるオプを拾わない（90 秒で失効し、
//      その場合はワーカーが台帳から再処理する = 直接側が死んでも安全）。
//   3. 台帳へ applying を書いてから金を動かす。確定失敗は台帳も
//      failed にし、例外（成否曖昧）は台帳を applying のまま残して
//      オプを failed(apply_failed) にする（ワーカーと同じ規則）。
//   4. 成功したら台帳 applied + 計測 + オプ記録 done。
// 金を動かす「前」に失敗したら（台帳/claim の書き込み失敗、対象外の
// 種別）従来のキュー登録へフォールバックする。動かした後にキューへ
// 積み直すことは絶対にしない。
// ---------------------------------------------------------------------------

/** 適用台帳の名前空間（ワーカーの APPLIED_NAMESPACE と同じ）。 */
export const WORLDBOX_ECONOMY_APPLIED_NAMESPACE = "worldbox_economy_applied";
/** 日次経済計測の名前空間（ワーカーの METRICS_NAMESPACE と同じ）。 */
export const WORLDBOX_ECONOMY_METRICS_NAMESPACE = "worldbox_metrics_econ";
/** 取引履歴でシステム側の相手として記録する ID（ワーカーの WORLDBOX_ID）。 */
export const WORLDBOX_HISTORY_ID = "WORLD_BOX";
/** 新規ユーザーの初期残高（Python 側 NEW_USER_BALANCE と同じ）。 */
export const NEW_USER_BALANCE = 10_000;
/** 残高 CAS の再試行回数（Python wallet の BALANCE_UPDATE_ATTEMPTS と同じ）。 */
const BALANCE_UPDATE_ATTEMPTS = 5;

interface AppliedLedgerEntry {
  status: "applying" | "applied" | "failed";
  appliedAmount?: number;
  metricRecorded?: boolean;
  error?: string;
  at: number;
}

function parseAppliedLedger(raw: unknown): AppliedLedgerEntry | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.status !== "applying" && record.status !== "applied" && record.status !== "failed") return null;
  const entry: AppliedLedgerEntry = {
    status: record.status,
    at: typeof record.at === "number" && Number.isFinite(record.at) ? record.at : 0,
  };
  if (typeof record.appliedAmount === "number" && Number.isInteger(record.appliedAmount) && record.appliedAmount >= 0) {
    entry.appliedAmount = record.appliedAmount;
  }
  if (typeof record.metricRecorded === "boolean") entry.metricRecorded = record.metricRecorded;
  if (typeof record.error === "string" && record.error.length > 0) entry.error = record.error;
  return entry;
}

/**
 * 適用台帳の1件を消す。終端 failed のオプを再試行可能にする場合だけ
 * 使う（金が動いていない失敗に限る。オプ記録の削除と対で呼ぶこと）。
 */
export async function deleteEconomyOpLedger(opId: string): Promise<boolean> {
  if (!isBotApiConfigured()) return false;
  try {
    await kvDelete(WORLDBOX_ECONOMY_APPLIED_NAMESPACE, opId);
    return true;
  } catch {
    return false;
  }
}

async function loadAppliedLedger(opId: string): Promise<AppliedLedgerEntry | null> {
  try {
    return parseAppliedLedger(await kvGet(WORLDBOX_ECONOMY_APPLIED_NAMESPACE, opId));
  } catch {
    return null;
  }
}

async function saveAppliedLedger(opId: string, entry: AppliedLedgerEntry): Promise<boolean> {
  try {
    await kvSet(WORLDBOX_ECONOMY_APPLIED_NAMESPACE, opId, entry);
    return true;
  } catch {
    return false;
  }
}

/** オプ記録を終端状態で書き直す（claim は落とす。ワーカーの _write_result と同じ形）。 */
async function writeOpTerminal(
  op: EconomyOp,
  status: "done" | "failed",
  extra: { appliedAmount?: number; error?: string },
): Promise<EconomyOp> {
  const record: EconomyOp = { ...op, status, appliedAt: Date.now() };
  if (extra.appliedAmount !== undefined) record.appliedAmount = extra.appliedAmount;
  if (extra.error !== undefined) record.error = extra.error;
  try {
    await kvSet(WORLDBOX_ECONOMY_NAMESPACE, op.id, record);
  } catch {
    // 記録の書き直し失敗は適用結果を覆さない（台帳が正で、履歴表示は
    // 次回取得時に直る範囲に留める）。
  }
  return record;
}

type ChangeBalanceResult =
  | { ok: true; newBalance: number }
  | { ok: false; error: "insufficient_funds" | "balance_update_failed" };

/**
 * 残高 CAS（Python wallet._change_balance と同じ規則）: 読んだ残高が
 * 変わっていないときだけ条件付き update で書き、競合したら読み直す。
 * 確定結果（成功 / 残高不足 / 再試行枯渇）だけを戻り値にし、API の
 * 通信例外は「成否曖昧」として呼び出し側へ投げる。ただし update の
 * 応答が失われた場合は残高を読み直し、期待値になっていれば成功扱い
 * にして曖昧さをその場で解消する。
 */
async function changeBalanceDirect(
  discordId: string,
  delta: number,
  options: { requireFunds?: boolean; createWith?: number | null } = {},
): Promise<ChangeBalanceResult> {
  const requireFunds = options.requireFunds === true;
  const createWith = options.createWith ?? null;
  for (let attempt = 0; attempt < BALANCE_UPDATE_ATTEMPTS; attempt++) {
    const rows = await tableSelect<UserBalanceRow>(
      "users",
      "balance",
      [{ column: "user_id", op: "eq", value: discordId }],
      1,
    );
    if (rows.length === 0) {
      if (requireFunds) return { ok: false, error: "insufficient_funds" };
      if (createWith === null) return { ok: false, error: "balance_update_failed" };
      const newBalance = createWith + delta;
      try {
        await tableInsert("users", { user_id: discordId, balance: newBalance, debt: 0 });
        return { ok: true, newBalance };
      } catch {
        continue; // 同時に行が作られた等: 読み直してやり直す
      }
    }
    const oldBalance = Number(rows[0].balance ?? 0);
    if (!Number.isFinite(oldBalance)) return { ok: false, error: "balance_update_failed" };
    const newBalance = Math.trunc(oldBalance) + delta;
    if (requireFunds && newBalance < 0) return { ok: false, error: "insufficient_funds" };
    let updated: unknown[];
    try {
      updated = await tableUpdate(
        "users",
        { balance: newBalance },
        [
          { column: "user_id", op: "eq", value: discordId },
          { column: "balance", op: "eq", value: Math.trunc(oldBalance) },
        ],
      );
    } catch (error) {
      // 応答が失われただけなら残高は既に新しい値になっている。
      const now = await readUserBalance(discordId);
      if (now === newBalance) return { ok: true, newBalance };
      throw error;
    }
    if (updated.length > 0) return { ok: true, newBalance };
  }
  return { ok: false, error: "balance_update_failed" };
}

/** 取引履歴の記録（ベストエフォート: 失敗しても適用は止めない）。 */
async function recordHistoryDirect(
  senderId: string,
  receiverId: string,
  amount: number,
  reason: string,
): Promise<void> {
  try {
    await tableInsert("transaction_history", {
      sender_id: senderId,
      receiver_id: receiverId,
      amount,
      reason,
    });
  } catch {
    // ワーカー側も履歴記録の失敗では適用を止めない
  }
}

interface MetricRecord {
  earn: Record<string, number>;
  spend: Record<string, number>;
  bankroll: number | null;
}

/** ワーカーの apply_metric と同じ集計。bankroll は読めたときだけ更新する。 */
function applyMetricRecord(record: unknown, op: EconomyOp, applied: number, bankroll: number | null = null): MetricRecord {
  const out: MetricRecord = { earn: {}, spend: {}, bankroll: null };
  if (typeof record === "object" && record !== null && !Array.isArray(record)) {
    const source = record as Record<string, unknown>;
    if (typeof source.bankroll === "number" && Number.isFinite(source.bankroll)) out.bankroll = Math.trunc(source.bankroll);
    for (const key of ["earn", "spend"] as const) {
      const part = source[key];
      if (typeof part === "object" && part !== null && !Array.isArray(part)) {
        for (const [name, value] of Object.entries(part as Record<string, unknown>)) {
          if (typeof value === "number" && Number.isFinite(value)) out[key][name] = Math.trunc(value);
        }
      }
    }
  }
  if (op.kind === "earn") {
    out.earn[op.reason] = (out.earn[op.reason] ?? 0) + applied;
  } else if (op.kind === "spend") {
    out.spend[op.reason] = (out.spend[op.reason] ?? 0) + applied;
  } else if (op.kind === "gamble") {
    out.spend["casino_bet"] = (out.spend["casino_bet"] ?? 0) + op.amount;
    out.earn["casino_payout"] = (out.earn["casino_payout"] ?? 0) + applied;
  }
  if (bankroll !== null) out.bankroll = bankroll;
  return out;
}

/** 日次経済計測への加算（ベストエフォート）。成功したら true。 */
async function recordMetricDirect(op: EconomyOp, applied: number): Promise<boolean> {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const current = await kvGet(WORLDBOX_ECONOMY_METRICS_NAMESPACE, date);
    const bankroll = await readBankrollDirect();
    await kvSet(WORLDBOX_ECONOMY_METRICS_NAMESPACE, date, applyMetricRecord(current, op, applied, bankroll));
    return true;
  } catch {
    return false;
  }
}

/** 確定失敗（再適用しない）を表す内部エラー。 */
class DirectFailure extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 原資（economy_pool）の RPC 経由アクセス（コイン API 直接化 第2段）
// 原資の正は Postgres の economy_pool_state（単一行）。pay_house 等は
// docs/sql/economy_pool.sql の RPC が原子的に処理する。SQL 未適用の
// 環境ではテーブル自体が無いので、earn / gamble の直接適用は
// テーブルの存在を事前に確認し、無ければ従来キューへ寄せる
// （金を動かす前に判定する。途中まで直接で動かしてから寄せない）。
// ---------------------------------------------------------------------------

interface PayHouseBreakdown {
  paid: number;
  pool: number;
  treasury: number;
}

let poolProbeCache: { at: number; available: boolean } | null = null;
const POOL_PROBE_TTL_MS = 60_000;

/** 原資 DB のプローブ結果を捨てる（SQL 適用直後の回復とテスト用）。 */
export function resetEconomyPoolProbe(): void {
  poolProbeCache = null;
}

/** economy_pool_state テーブルが読めるか（= 第2段の SQL が適用済みか）。 */
async function isPoolDbAvailable(): Promise<boolean> {
  if (poolProbeCache && Date.now() - poolProbeCache.at < POOL_PROBE_TTL_MS) {
    return poolProbeCache.available;
  }
  let available = false;
  try {
    await tableSelect("economy_pool_state", "pool", [{ column: "id", op: "eq", value: 1 }], 1);
    available = true;
  } catch {
    available = false;
  }
  poolProbeCache = { at: Date.now(), available };
  return available;
}

/** 現在のバンクロール（プール＋国庫）。読めなければ null。 */
async function readBankrollDirect(): Promise<number | null> {
  try {
    const rows = await tableSelect<{ pool?: unknown; treasury?: unknown }>(
      "economy_pool_state",
      "pool,treasury",
      [{ column: "id", op: "eq", value: 1 }],
      1,
    );
    if (rows.length === 0) return 0;
    const pool = Number(rows[0].pool ?? 0);
    const treasury = Number(rows[0].treasury ?? 0);
    if (!Number.isFinite(pool) || !Number.isFinite(treasury)) return null;
    return Math.trunc(pool) + Math.trunc(treasury);
  } catch {
    return null;
  }
}

function toBreakdown(raw: unknown): PayHouseBreakdown | null {
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;
  const paid = Number(record.paid);
  const pool = Number(record.pool_part);
  const treasury = Number(record.treasury_part);
  if (!Number.isFinite(paid) || !Number.isFinite(pool) || !Number.isFinite(treasury)) return null;
  return { paid: Math.trunc(paid), pool: Math.trunc(pool), treasury: Math.trunc(treasury) };
}

/** pay_house RPC: バンクロールから確保できた分の内訳を返す。 */
async function payHouseDirect(amount: number): Promise<PayHouseBreakdown> {
  const breakdown = toBreakdown(await rpc("economy_pool_pay_house", { p_amount: amount }));
  if (!breakdown) throw new Error("economy_pool_pay_house returned an invalid result");
  return breakdown;
}

/** refund_house RPC（ベストエフォート: 失敗しても呼び出し側の終端は変えない）。 */
async function refundHouseDirect(breakdown: PayHouseBreakdown): Promise<void> {
  try {
    await rpc("economy_pool_refund_house", {
      p_pool_part: breakdown.pool,
      p_treasury_part: breakdown.treasury,
    });
  } catch {
    // ワーカー側も refund_house の失敗は記録のみで適用結果を覆さない
  }
}

/** add_loss RPC（ベストエフォート: 還流の取りこぼしは記録のみ）。 */
async function addLossDirect(amount: number): Promise<void> {
  if (amount <= 0) return;
  try {
    await rpc("economy_pool_add_loss", { p_amount: amount });
  } catch {
    // ワーカー側も add_loss の失敗は適用を止めない
  }
}

/** earn の直接適用（ワーカーの _apply_earn と同じ規則）。戻り値は実際に払えた額。 */
async function applyEarnDirect(op: EconomyOp): Promise<number> {
  const breakdown = await payHouseDirect(op.amount);
  const paid = breakdown.paid;
  if (paid <= 0) return 0;
  let credited: ChangeBalanceResult;
  try {
    credited = await changeBalanceDirect(op.discordId, paid, { createWith: NEW_USER_BALANCE });
  } catch (error) {
    await refundHouseDirect(breakdown);
    throw error;
  }
  if (!credited.ok) {
    // 入金できなかった分は原資へ戻す（発行しない）
    await refundHouseDirect(breakdown);
    throw new DirectFailure("credit_failed");
  }
  await recordHistoryDirect(WORLDBOX_HISTORY_ID, op.discordId, paid, op.reason);
  return paid;
}

/**
 * gamble の直接適用（ワーカーの _apply_gamble と同じ規則）。
 * pay_house が必要なオプは、ベットを引き落とす「前」に原資を確保する
 * （確保の成否が確定してから残高を動かすため、途中失敗でも
 * refund_house で原資を戻せば金はどこにも残らない）。
 */
async function applyGambleDirect(op: EconomyOp): Promise<number> {
  if (op.payout === undefined) throw new DirectFailure("invalid_op");
  const user = op.discordId;
  const bet = op.amount;
  const payout = op.payout;
  const prepaid = op.prepaid === true;

  const profit = Math.max(0, payout - bet);
  let breakdown: PayHouseBreakdown | null = null;
  let housePaid = 0;
  if (profit > 0) {
    breakdown = await payHouseDirect(profit);
    housePaid = breakdown.paid;
  }

  if (!prepaid) {
    const debit = await changeBalanceDirect(user, -bet, { requireFunds: true });
    if (!debit.ok) {
      if (breakdown) await refundHouseDirect(breakdown);
      throw new DirectFailure(debit.error);
    }
    await recordHistoryDirect(user, WORLDBOX_HISTORY_ID, bet, op.reason);
  }

  if (payout <= 0) {
    await addLossDirect(bet);
    return 0;
  }
  if (prepaid && payout < bet) {
    // 先払い精算の部分返し: 戻らなかった分は負けとして還流する。
    await addLossDirect(bet - payout);
  }

  const creditAmount = Math.min(payout, bet) + housePaid;
  let credited: ChangeBalanceResult | null = null;
  try {
    credited = await changeBalanceDirect(user, creditAmount, { createWith: NEW_USER_BALANCE });
  } catch {
    credited = null;
  }
  if (!credited || !credited.ok) {
    if (breakdown) await refundHouseDirect(breakdown);
    if (!prepaid) {
      // ベットを返金する（失敗したらワーカー同様に記録のみで終端する）
      try {
        await changeBalanceDirect(user, bet);
      } catch {
        // 返金の成否は終端コードを変えない
      }
    }
    throw new DirectFailure("credit_failed");
  }
  await recordHistoryDirect(WORLDBOX_HISTORY_ID, user, creditAmount, op.reason);
  return creditAmount;
}

/** spend の直接適用。戻り値は実際に動いた額。 */
async function applySpendDirect(op: EconomyOp): Promise<number> {
  const result = await changeBalanceDirect(op.discordId, -op.amount, { requireFunds: true });
  if (!result.ok) throw new DirectFailure(result.error);
  await recordHistoryDirect(op.discordId, WORLDBOX_HISTORY_ID, op.amount, op.reason);
  return op.amount;
}

/** transfer の直接適用（transfer_coins RPC は DB 内で原子的）。 */
async function applyTransferDirect(op: EconomyOp): Promise<number> {
  if (!op.toDiscordId) throw new DirectFailure("invalid_op");
  try {
    await rpc<number>("transfer_coins", {
      p_sender_id: op.discordId,
      p_receiver_id: op.toDiscordId,
      p_amount: op.amount,
      p_new_user_balance: NEW_USER_BALANCE,
    });
  } catch (error) {
    // RPC は API 側のトランザクション内で実行されるため、400 は
    // 「適用されなかった」確定失敗（残高不足など）。それ以外は
    // 成否曖昧として呼び出し側の例外規則に委ねる。
    if (error instanceof BotApiError && error.status === 400) {
      throw new DirectFailure("insufficient_funds");
    }
    throw error;
  }
  await recordHistoryDirect(op.discordId, op.toDiscordId, op.amount, op.reason);
  return op.amount;
}

/**
 * 直接適用の対象種別か。spend / transfer は常時。earn / gamble は
 * 原資（economy_pool_state）が DB 化されている環境でのみ対象にし、
 * 使えない環境では従来キューへ寄せる（判定は金を動かす前に行う）。
 */
async function isDirectKind(op: EconomyOp): Promise<boolean> {
  if (op.kind === "spend" || op.kind === "transfer") return true;
  if (op.kind === "earn" || op.kind === "gamble") return isPoolDbAvailable();
  return false;
}

async function applyDirectByKind(op: EconomyOp): Promise<number> {
  if (op.kind === "spend") return applySpendDirect(op);
  if (op.kind === "transfer") return applyTransferDirect(op);
  if (op.kind === "earn") return applyEarnDirect(op);
  if (op.kind === "gamble") return applyGambleDirect(op);
  throw new DirectFailure("invalid_op");
}

export type SubmitEconomyOpResult =
  | { state: "done" | "failed" | "pending"; op: EconomyOp }
  | { state: "unavailable" };

/**
 * オプの提出（直接適用が正、キューはフォールバック）。
 * - done / failed: その場で終端した（または台帳・既存記録から終端が確定した）
 * - pending: キューに積んだ（または既に提出済み）。従来どおり
 *   waitForOpDone やクライアントのポーリングで追うこと
 * - unavailable: 直接もキューも使えなかった
 * 決定的 ID のオプは既存記録・台帳を先に見るため、二重適用にならない。
 */
export async function submitEconomyOp(op: EconomyOp): Promise<SubmitEconomyOpResult> {
  if (!isBotApiConfigured()) return { state: "unavailable" };

  // 既存のオプ記録: 終端していればそれが結果。pending なら提出済み。
  let existingRaw: unknown = null;
  try {
    existingRaw = await kvGet(WORLDBOX_ECONOMY_NAMESPACE, op.id);
  } catch {
    existingRaw = null;
  }
  const existing = parseEconomyOp(existingRaw);
  if (existing) {
    if (existing.status === "done") return { state: "done", op: existing };
    if (existing.status === "failed") return { state: "failed", op: existing };
    return { state: "pending", op: existing };
  }

  // 適用台帳: オプ記録が無いのに台帳だけ残っている場合の整合。
  const ledger = await loadAppliedLedger(op.id);
  if (ledger?.status === "applied") {
    const record = await writeOpTerminal(op, "done", { appliedAmount: ledger.appliedAmount ?? 0 });
    return { state: "done", op: record };
  }
  if (ledger?.status === "failed") {
    const record = await writeOpTerminal(op, "failed", { error: ledger.error ?? "apply_failed" });
    return { state: "failed", op: record };
  }
  if (ledger?.status === "applying") {
    // 成否曖昧な適用が進行中/中断している。触らずキュー側の
    // 再処理（台帳から終端化）に委ねる。
    if (await queueEconomyOp(op)) return { state: "pending", op };
    return { state: "unavailable" };
  }

  // 対象外の種別は従来のキューへ。
  if (!(await isDirectKind(op))) {
    if (await queueEconomyOp(op)) return { state: "pending", op };
    return { state: "unavailable" };
  }

  // claim: ワーカーに拾われないよう目印を書いて再読で勝ちを確認する。
  const token = crypto.randomUUID();
  const claimed: EconomyOp & { claim: { token: string; at: number } } = {
    ...op,
    claim: { token, at: Date.now() },
  };
  try {
    await kvSet(WORLDBOX_ECONOMY_NAMESPACE, op.id, claimed);
    const current = await kvGet(WORLDBOX_ECONOMY_NAMESPACE, op.id);
    const currentClaim =
      typeof current === "object" && current !== null
        ? (current as { claim?: { token?: unknown } }).claim
        : undefined;
    if (!currentClaim || currentClaim.token !== token) {
      const currentOp = parseEconomyOp(current);
      if (currentOp) return { state: "pending", op: currentOp };
      return { state: "unavailable" };
    }
  } catch {
    // claim を書く前に失敗: 金は動いていないのでキューへ寄せる。
    if (await queueEconomyOp(op)) return { state: "pending", op };
    return { state: "unavailable" };
  }

  // 台帳へ applying。書けなければ適用しない（claim を外してキューへ）。
  if (!(await saveAppliedLedger(op.id, { status: "applying", at: Date.now() }))) {
    if (await queueEconomyOp(op)) return { state: "pending", op };
    return { state: "unavailable" };
  }

  let applied: number;
  try {
    applied = await applyDirectByKind(op);
  } catch (error) {
    if (error instanceof DirectFailure) {
      await saveAppliedLedger(op.id, { status: "failed", error: error.code, at: Date.now() });
      const record = await writeOpTerminal(op, "failed", { error: error.code });
      return { state: "failed", op: record };
    }
    // 成否曖昧: 台帳は applying のまま残し、オプは failed にする
    // （ワーカーの例外時と同じ。キューへ積み直すことはしない）。
    const record = await writeOpTerminal(op, "failed", { error: "apply_failed" });
    return { state: "failed", op: record };
  }

  const metricRecorded = await recordMetricDirect(op, applied);
  await saveAppliedLedger(op.id, {
    status: "applied",
    appliedAmount: applied,
    metricRecorded,
    at: Date.now(),
  });
  const record = await writeOpTerminal(op, "done", { appliedAmount: applied });
  return { state: "done", op: record };
}
