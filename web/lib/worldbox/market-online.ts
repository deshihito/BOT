// AGO WORLD BOX の取引所と Bot 本体のアゴトークン市場の橋渡し（サーバー側）。
// 市場状態の正は Bot 本体（core/general/market、market.json）で、Web は
// bot_kv の名前空間 worldbox_market を経由する:
// - スナップショット（キー "snapshot"）: Bot が定期公開するレート・
//   履歴・停止状態・保有量。表示と残高参照はここから読む。
// - オプ（キー = オプ ID）: Web が status "pending" で書き、Bot の
//   MarketCog が市場の正規経路で適用して done / failed を返す。
// 売買のコイン移動とトークン増減はすべて Bot 側で行い、Web は
// プロフィール（WorldBox のかばん）を一切触らない。
import { kvGet, kvSet } from "@/lib/bot-api";
import { parseMarketSnapshot, type MarketSnapshot } from "./market";

export const WORLDBOX_MARKET_NAMESPACE = "worldbox_market";
export const MARKET_SNAPSHOT_KEY = "snapshot";

export type MarketOpKind = "buy" | "sell" | "convert";

export type MarketOpRequest = {
  id: string;
  kind: MarketOpKind;
  userId: string;
  amountAga?: number;
  tokenAmount?: number;
  count?: number;
};

export type MarketOpResult = {
  ok: boolean;
  amountAga?: number;
  tokenAmount?: number;
  count?: number;
  tokens?: number;
  netAga?: number;
  grossAga?: number;
  fee?: number;
  rate?: number;
  tokenBalance?: number;
  coinBalance?: number;
};

export type MarketOpRecord = MarketOpRequest & {
  status: "pending" | "processing" | "done" | "failed";
  result?: MarketOpResult;
  error?: string;
};

/** Bot が公開した市場スナップショットを読む。無ければ null。 */
export async function loadMarketSnapshot(): Promise<MarketSnapshot | null> {
  try {
    return parseMarketSnapshot(await kvGet(WORLDBOX_MARKET_NAMESPACE, MARKET_SNAPSHOT_KEY));
  } catch {
    return null;
  }
}

/** 売買オプを登録する（Bot の MarketCog が拾って適用する）。 */
export async function submitMarketOp(op: MarketOpRequest): Promise<void> {
  const record: MarketOpRecord = { ...op, status: "pending" };
  await kvSet(WORLDBOX_MARKET_NAMESPACE, op.id, record);
}

/** 登録済みのオプを1件読む（変換の冪等マーカー用）。無ければ null。 */
export async function loadMarketOp(opId: string): Promise<MarketOpRecord | null> {
  try {
    return parseMarketOpRecord(await kvGet(WORLDBOX_MARKET_NAMESPACE, opId));
  } catch {
    return null;
  }
}

function parseMarketOpRecord(raw: unknown): MarketOpRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.id !== "string" || typeof data.kind !== "string" || typeof data.userId !== "string") {
    return null;
  }
  if (data.status !== "pending" && data.status !== "processing" && data.status !== "done" && data.status !== "failed") {
    return null;
  }
  return data as MarketOpRecord;
}

/** 登録したオプの結果を待つ。時間内に確定しなければ最後の状態を返す。 */
export async function waitForMarketOp(
  opId: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<MarketOpRecord | null> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 400;
  const deadline = Date.now() + timeoutMs;
  let last: MarketOpRecord | null = null;
  for (;;) {
    try {
      last = parseMarketOpRecord(await kvGet(WORLDBOX_MARKET_NAMESPACE, opId));
    } catch {
      last = null;
    }
    if (last && (last.status === "done" || last.status === "failed")) return last;
    if (Date.now() >= deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
