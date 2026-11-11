// スロットの純粋ロジック（UI 非依存・シード決定的）。
// チップは端末内だけの遊び用ポイントで、実在の通貨とは無関係。
// 状態は JSON 化可能な値のみ。遷移関数は状態を破壊せず新しい状態を返す。
//
// 確率表（各リール共通・独立抽選）:
//   シンボルは SLOT_SYMBOLS の weight（重み）で抽選される。全リールの合計 weight は
//   SLOT_TOTAL_WEIGHT = 100 なので、出現確率は weight / 100 そのもの。
//   3つ揃いの確率は (weight/100)^3、配当は bet × three（倍率）。
//   先頭2リールのチェリー揃いは bet × SLOT_CHERRY_PAIR_MULT。
//   理論還元率（RTP）は expectedReturnRate() で計算でき、約0.82（胴元有利）になる。

export type SlotSymbolId = "cherry" | "lemon" | "bell" | "grape" | "star" | "seven";

export type SlotSymbol = {
  id: SlotSymbolId;
  glyph: string;
  label: string;
  /** 抽選の重み。出現確率 = weight / SLOT_TOTAL_WEIGHT。 */
  weight: number;
  /** 3つ揃いの配当倍率（bet × three が払い戻し）。 */
  three: number;
};

export const SLOT_SYMBOLS: SlotSymbol[] = [
  { id: "cherry", glyph: "🍒", label: "チェリー", weight: 30, three: 8 },
  { id: "lemon", glyph: "🍋", label: "レモン", weight: 25, three: 12 },
  { id: "bell", glyph: "🔔", label: "ベル", weight: 20, three: 20 },
  { id: "grape", glyph: "🍇", label: "ぶどう", weight: 12, three: 30 },
  { id: "star", glyph: "⭐", label: "ほし", weight: 8, three: 80 },
  { id: "seven", glyph: "7️⃣", label: "セブン", weight: 5, three: 300 },
];

export const SLOT_TOTAL_WEIGHT = SLOT_SYMBOLS.reduce((sum, s) => sum + s.weight, 0);

/** 先頭2リールが両方チェリーのときの配当倍率。 */
export const SLOT_CHERRY_PAIR_MULT = 2;

export const SLOT_INITIAL_CHIPS = 1000;
export const SLOT_MIN_BET = 10;

export type SlotResultKind = "three" | "cherryPair" | "none";

export type SlotResult = {
  kind: SlotResultKind;
  /** three のときに揃ったシンボル。 */
  symbol: SlotSymbolId | null;
  /** 払い戻し倍率（bet に対する倍率）。 */
  multiplier: number;
  /** 払い戻し額。 */
  payout: number;
  /** このスピンのチップ収支（payout − bet）。 */
  delta: number;
  message: string;
};

export type SlotState = {
  chips: number;
  /** 直近のベット額（未スピンなら 0）。 */
  bet: number;
  /** 直近のリール結果（未スピンなら null）。 */
  reels: SlotSymbolId[] | null;
  result: SlotResult | null;
  spins: number;
  rng: number;
};

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function slotSymbol(id: SlotSymbolId): SlotSymbol {
  return SLOT_SYMBOLS.find((s) => s.id === id) ?? SLOT_SYMBOLS[0];
}

/** そのシンボルが1リールに出現する確率。 */
export function symbolProbability(id: SlotSymbolId): number {
  return slotSymbol(id).weight / SLOT_TOTAL_WEIGHT;
}

function drawSymbol(rng: number): { symbol: SlotSymbolId; rng: number } {
  const r = nextRandom(rng);
  let rest = r.value * SLOT_TOTAL_WEIGHT;
  for (const s of SLOT_SYMBOLS) {
    rest -= s.weight;
    if (rest < 0) return { symbol: s.id, rng: r.rng };
  }
  return { symbol: SLOT_SYMBOLS[SLOT_SYMBOLS.length - 1].id, rng: r.rng };
}

/** リール3つの結果から配当を判定する（純粋関数）。 */
export function evaluateReels(reels: SlotSymbolId[], bet: number): SlotResult {
  const amount = Math.max(0, Math.floor(bet));
  if (reels.length === 3 && reels[0] === reels[1] && reels[1] === reels[2]) {
    const sym = slotSymbol(reels[0]);
    const payout = amount * sym.three;
    return {
      kind: "three",
      symbol: sym.id,
      multiplier: sym.three,
      payout,
      delta: payout - amount,
      message: `${sym.label}が3つ揃いました！ 配当 ${sym.three} 倍です。`,
    };
  }
  if (reels.length === 3 && reels[0] === "cherry" && reels[1] === "cherry") {
    const payout = amount * SLOT_CHERRY_PAIR_MULT;
    return {
      kind: "cherryPair",
      symbol: "cherry",
      multiplier: SLOT_CHERRY_PAIR_MULT,
      payout,
      delta: payout - amount,
      message: `チェリーが2つ並びました。配当 ${SLOT_CHERRY_PAIR_MULT} 倍です。`,
    };
  }
  return {
    kind: "none",
    symbol: null,
    multiplier: 0,
    payout: 0,
    delta: -amount,
    message: "はずれです。",
  };
}

/** 理論還元率（長期的にベット総額の何割が払い戻されるかの期待値）。 */
export function expectedReturnRate(): number {
  let rate = 0;
  for (const s of SLOT_SYMBOLS) {
    const p = s.weight / SLOT_TOTAL_WEIGHT;
    rate += p * p * p * s.three;
  }
  const cherry = symbolProbability("cherry");
  // 先頭2つがチェリーで3つ目がチェリー以外（3揃いは上の項で数えている）。
  rate += cherry * cherry * (1 - cherry) * SLOT_CHERRY_PAIR_MULT;
  return rate;
}

export function createSlotGame(seed: number, chips: number = SLOT_INITIAL_CHIPS): SlotState {
  return {
    chips: Math.max(0, Math.floor(chips)),
    bet: 0,
    reels: null,
    result: null,
    spins: 0,
    rng: seed | 0,
  };
}

/** 1回スピンする。bet が不正・チップ不足なら状態をそのまま返す。 */
export function spin(state: SlotState, bet: number): SlotState {
  const amount = Math.floor(bet);
  if (!Number.isFinite(amount) || amount < SLOT_MIN_BET) return state;
  if (amount > state.chips) return state;
  let rng = state.rng;
  const reels: SlotSymbolId[] = [];
  for (let i = 0; i < 3; i++) {
    const d = drawSymbol(rng);
    rng = d.rng;
    reels.push(d.symbol);
  }
  const result = evaluateReels(reels, amount);
  return {
    ...state,
    chips: state.chips - amount + result.payout,
    bet: amount,
    reels,
    result,
    spins: state.spins + 1,
    rng,
  };
}

/** チップ再支給（チップが尽きたときだけ有効）。 */
export function refillChips(state: SlotState): SlotState {
  if (state.chips >= SLOT_MIN_BET) return state;
  return { ...state, chips: SLOT_INITIAL_CHIPS };
}
