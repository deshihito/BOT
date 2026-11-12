// ルーレット（欧式・37ポケット）の純粋ロジック（UI 非依存・シード決定的）。
// チップは端末内だけの遊び用ポイント。賭けの判定と配当はここで完結させる。

/** ホイール上のポケット順（欧式）。 */
export const ROULETTE_WHEEL = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28,
  12, 35, 3, 26,
] as const;

/** 赤の数字。 */
export const ROULETTE_RED: ReadonlySet<number> = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

export type RouletteColor = "green" | "red" | "black";

export function pocketColor(pocket: number): RouletteColor {
  if (pocket === 0) return "green";
  return ROULETTE_RED.has(pocket) ? "red" : "black";
}

export type RouletteBetKind =
  | "straight"
  | "red"
  | "black"
  | "even"
  | "odd"
  | "low"
  | "high"
  | "dozen"
  | "column";

export type RouletteBet = {
  kind: RouletteBetKind;
  /** straight: 数字 0-36 / dozen・column: 1-3 / その他は未使用。 */
  value?: number;
};

export type PlacedBet = RouletteBet & { amount: number };

/** 利益倍率（賭け金1に対して戻る利益。当たりなら amount × (倍率+1) が払い戻される）。 */
export function betProfitMultiplier(bet: RouletteBet): number {
  switch (bet.kind) {
    case "straight":
      return 35;
    case "dozen":
    case "column":
      return 2;
    default:
      return 1;
  }
}

function isValidBet(bet: RouletteBet): boolean {
  if (!bet || typeof bet !== "object") return false;
  switch (bet.kind) {
    case "straight":
      return Number.isInteger(bet.value) && (bet.value as number) >= 0 && (bet.value as number) <= 36;
    case "dozen":
    case "column":
      return bet.value === 1 || bet.value === 2 || bet.value === 3;
    case "red":
    case "black":
    case "even":
    case "odd":
    case "low":
    case "high":
      return true;
    default:
      return false;
  }
}

/** その賭けがポケットに対して当たっているか。0 は赤黒・偶奇・大小・ダースン・列すべて外れ。 */
export function betWins(bet: RouletteBet, pocket: number): boolean {
  if (!isValidBet(bet)) return false;
  if (!Number.isInteger(pocket) || pocket < 0 || pocket > 36) return false;
  switch (bet.kind) {
    case "straight":
      return pocket === bet.value;
    case "red":
      return pocketColor(pocket) === "red";
    case "black":
      return pocketColor(pocket) === "black";
    case "even":
      return pocket !== 0 && pocket % 2 === 0;
    case "odd":
      return pocket % 2 === 1;
    case "low":
      return pocket >= 1 && pocket <= 18;
    case "high":
      return pocket >= 19 && pocket <= 36;
    case "dozen": {
      if (pocket === 0) return false;
      const d = Math.floor((pocket - 1) / 12) + 1;
      return d === bet.value;
    }
    case "column": {
      if (pocket === 0) return false;
      // 列: 3列は 3,6,...,36 → 列番号は pocket%3（0→3列目）
      const c = pocket % 3 === 0 ? 3 : pocket % 3;
      return c === bet.value;
    }
    default:
      return false;
  }
}

/** 賭け表示名。 */
export function betLabel(bet: RouletteBet): string {
  switch (bet.kind) {
    case "straight":
      return `${bet.value} に単数`;
    case "red":
      return "赤";
    case "black":
      return "黒";
    case "even":
      return "偶数";
    case "odd":
      return "奇数";
    case "low":
      return "小（1-18）";
    case "high":
      return "大（19-36）";
    case "dozen": {
      const d = typeof bet.value === "number" ? bet.value : 1;
      return `ダースン${d}（${(d - 1) * 12 + 1}-${d * 12}）`;
    }
    case "column": {
      const c = typeof bet.value === "number" ? bet.value : 1;
      // 列c は c, c+3, c+6, …, c+33 の12数字（c=1→1,4,…,34 / c=3→3,6,…,36）。
      return `列${c}（${c}・${c + 3}・${c + 6}…${c + 33}）`;
    }
    default:
      return "賭け";
  }
}

/** mulberry32。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export const ROULETTE_START_CHIPS = 1000;

export type RouletteSpinResult = {
  pocket: number;
  color: RouletteColor;
  /** 賭けごとの結果。payout は払い戻し総額（賭け金込み）。 */
  details: { bet: PlacedBet; win: boolean; payout: number }[];
  totalBet: number;
  totalPayout: number;
  /** 純増減（払い戻し - 賭け金）。 */
  delta: number;
};

export type RouletteState = {
  seed: number;
  rng: number;
  chips: number;
  spins: number;
  lastResult: RouletteSpinResult | null;
  history: number[];
};

export function createRoulette(seed: number, chips: number = ROULETTE_START_CHIPS): RouletteState {
  const c = Number.isFinite(chips) && chips > 0 ? Math.floor(chips) : ROULETTE_START_CHIPS;
  return { seed: seed | 0, rng: seed | 0, chips: c, spins: 0, lastResult: null, history: [] };
}

/**
 * スピンする。不正な賭け・金額不足・賭けなしは Error を投げる（UI 側で表示する）。
 * 状態は破壊せず新しい状態を返す。
 */
export function spinRoulette(state: RouletteState, bets: PlacedBet[]): RouletteState {
  if (!Array.isArray(bets) || bets.length === 0) throw new Error("賭けがありません");
  if (bets.length > 20) throw new Error("賭けが多すぎます");
  let totalBet = 0;
  for (const b of bets) {
    if (!isValidBet(b)) throw new Error("賭けの内容が不正です");
    if (!Number.isInteger(b.amount) || b.amount <= 0) throw new Error("賭け金が不正です");
    totalBet += b.amount;
  }
  if (totalBet > state.chips) throw new Error("チップが足りません");
  const r = nextRandom(state.rng);
  const pocket = ROULETTE_WHEEL[Math.floor(r.value * ROULETTE_WHEEL.length) % ROULETTE_WHEEL.length];
  const details = bets.map((bet) => {
    const win = betWins(bet, pocket);
    const payout = win ? bet.amount * (betProfitMultiplier(bet) + 1) : 0;
    return { bet: { ...bet }, win, payout };
  });
  const totalPayout = details.reduce((s, d) => s + d.payout, 0);
  const result: RouletteSpinResult = {
    pocket,
    color: pocketColor(pocket),
    details,
    totalBet,
    totalPayout,
    delta: totalPayout - totalBet,
  };
  return {
    ...state,
    rng: r.rng,
    chips: state.chips + result.delta,
    spins: state.spins + 1,
    lastResult: result,
    history: [...state.history.slice(-49), pocket],
  };
}

/** 破産時の再支給。チップが残っている場合は何もしない。 */
export function refillChips(state: RouletteState): RouletteState {
  if (state.chips > 0) return state;
  return { ...state, chips: ROULETTE_START_CHIPS };
}
