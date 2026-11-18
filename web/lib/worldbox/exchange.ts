// AGO WORLD BOX の取引所（純粋ロジック、DOM 非依存）。
// アゴトークン（ago_token）の価格は時刻から決定的に決まる: 5分ごとの
// ティックで、複数の波とティック番号のハッシュを合成する。保存を持た
// ないため、サーバー・クライアント・テストで常に同じ価格になる。
// 売買の状態遷移は economy.ts の buyToken / sellToken が持ち、価格は
// ルートがここから読んで渡す。

/** 価格が変わる間隔（5分）。 */
export const TOKEN_TICK_MS = 300_000;
/** 基準価格（カタログ価格と一致させる）。 */
export const TOKEN_BASE_PRICE = 100;
export const TOKEN_MIN_PRICE = 30;
export const TOKEN_MAX_PRICE = 300;

/** ティック番号 → [0, 1) の決定的ハッシュ。 */
function hash01(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97) >>> 0;
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

/** 時刻 → ティック番号。 */
export function tokenTickOf(now: number): number {
  return Math.floor(now / TOKEN_TICK_MS);
}

/** ティック番号 → そのティックのトークン価格（コイン）。 */
export function tokenPriceAtTick(tick: number): number {
  const wave =
    1 +
    0.32 * Math.sin(tick / 9.7) +
    0.18 * Math.sin(tick / 3.3 + 1.7) +
    0.1 * Math.sin(tick / 1.9 + 0.6);
  const noise = 0.88 + 0.24 * hash01(tick);
  const price = Math.round(TOKEN_BASE_PRICE * wave * noise);
  return Math.min(TOKEN_MAX_PRICE, Math.max(TOKEN_MIN_PRICE, price));
}

/** 時刻 → 現在のトークン価格（コイン）。 */
export function tokenPriceAt(now: number): number {
  return tokenPriceAtTick(tokenTickOf(now));
}

/** 次に価格が変わる時刻（ミリ秒）。 */
export function tokenNextTickAt(now: number): number {
  return (tokenTickOf(now) + 1) * TOKEN_TICK_MS;
}

/** 直近 count ティック分の価格履歴（古い順、最後が現在）。 */
export function tokenPriceHistory(now: number, count: number): { tick: number; price: number }[] {
  const current = tokenTickOf(now);
  const out: { tick: number; price: number }[] = [];
  for (let tick = current - count + 1; tick <= current; tick++) {
    out.push({ tick, price: tokenPriceAtTick(tick) });
  }
  return out;
}
