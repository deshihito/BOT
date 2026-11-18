// AGO WORLD BOX の取引所（純粋ロジック、DOM 非依存）。
// 取引対象は /general のアゴトークン市場（Bot 本体 core/general/market）
// そのもので、WorldBox 専用の価格や残高は持たない。レート・保有量は
// Bot が bot_kv へ公開するスナップショット（market-online.ts）が正で、
// ここはその解釈と、Bot 側 quote と同じ式の表示用見積もりだけを持つ。
// 売買の確定は必ず Bot 側（検証・手数料・プール・コイン移動）が行う。

/** 売買手数料（Bot 側 FEE_RATE と一致）。 */
export const MARKET_FEE_RATE = 0.01;

/** Bot が公開する市場スナップショット。 */
export type MarketSnapshot = {
  rate: number;
  history: { t: string; rate: number }[];
  halted: boolean;
  haltReason: string;
  tradeCapAga: number;
  balances: Record<string, number>;
  updatedAt: string;
};

/** トークン量を 0.01 単位へ切り捨てる（Bot 側 quantize_tokens と同じ）。 */
export function quantizeTokens(amount: number): number {
  return Math.floor(amount * 100) / 100;
}

/** スナップショットの解釈。不正なら null。 */
export function parseMarketSnapshot(raw: unknown): MarketSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const data = raw as Record<string, unknown>;
  const rate = data.rate;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  const history: { t: string; rate: number }[] = [];
  if (Array.isArray(data.history)) {
    for (const entry of data.history) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.rate === "number" && Number.isFinite(e.rate)) {
        history.push({ t: typeof e.t === "string" ? e.t : "", rate: e.rate });
      }
    }
  }
  const balances: Record<string, number> = {};
  if (typeof data.balances === "object" && data.balances !== null) {
    for (const [userId, amount] of Object.entries(data.balances as Record<string, unknown>)) {
      if (typeof amount === "number" && Number.isFinite(amount)) balances[userId] = amount;
    }
  }
  return {
    rate,
    history,
    halted: data.halted === true,
    haltReason: typeof data.haltReason === "string" ? data.haltReason : "",
    tradeCapAga:
      typeof data.tradeCapAga === "number" && Number.isFinite(data.tradeCapAga) ? data.tradeCapAga : 0,
    balances,
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
  };
}

/** スナップショットから本人のトークン保有量を引く。 */
export function marketBalanceOf(snapshot: MarketSnapshot, userId: string): number {
  return snapshot.balances[userId] ?? 0;
}

/** 買い見積もり（Bot 側 quote_buy と同じ式。表示用で、確定は Bot）。 */
export function quoteBuyTokens(
  agaAmount: number,
  rate: number,
): { fee: number; netAga: number; tokens: number } {
  const fee = Math.trunc(agaAmount * MARKET_FEE_RATE);
  const netAga = agaAmount - fee;
  const tokens = rate > 0 ? quantizeTokens(netAga / rate) : 0;
  return { fee, netAga, tokens };
}

/** 売り見積もり（Bot 側 quote_sell と同じ式。表示用で、確定は Bot）。 */
export function quoteSellAga(
  tokenAmount: number,
  rate: number,
): { grossAga: number; fee: number; netAga: number } {
  const grossAga = Math.trunc(tokenAmount * rate);
  const fee = Math.trunc(grossAga * MARKET_FEE_RATE);
  return { grossAga, fee, netAga: grossAga - fee };
}
