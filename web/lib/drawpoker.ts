// ドローポーカーの純粋ロジック（UI 非依存・シード決定的）。
// ビデオポーカー式の「役による配当制」: 5枚配って1回だけ交換し、
// 最終手の役に応じて bet × 倍率が払い戻される。CPU との対決にしなかったのは、
// 対決形式だとベットラウンドや AI の降り判断まで要り、この手軽さ
// （配る→交換→配当）の範囲を超えるため。チップは端末内だけの遊び用ポイント。
// 状態は JSON 化可能な値のみ。遷移関数は状態を破壊せず新しい状態を返す。

export type Suit = "spade" | "heart" | "diamond" | "club";

export type DpCard = {
  suit: Suit;
  /** 1=A, 11=J, 12=Q, 13=K。 */
  rank: number;
};

export type DpPhase = "betting" | "draw" | "settled";

export type DpHandInfo = {
  /** 役の強さ（0=役なし 〜 9=ロイヤルストレートフラッシュ）。 */
  category: number;
  name: string;
  /** bet に対する払い戻し倍率。 */
  multiplier: number;
};

export type DpResult = {
  hand: DpHandInfo;
  payout: number;
  /** このラウンドのチップ収支（payout − bet）。 */
  delta: number;
  message: string;
};

export type DpState = {
  chips: number;
  bet: number;
  /** 山札。先頭（index 0）から配る。 */
  deck: DpCard[];
  hand: DpCard[];
  phase: DpPhase;
  result: DpResult | null;
  rng: number;
  round: number;
};

export const DP_INITIAL_CHIPS = 1000;
export const DP_MIN_BET = 10;

const SUITS: Suit[] = ["spade", "heart", "diamond", "club"];

/** 役表（上から強い順）。ワンペアは J 以上（A を含む）のときだけ配当がある。 */
export const DP_HAND_TABLE: { category: number; name: string; multiplier: number }[] = [
  { category: 9, name: "ロイヤルストレートフラッシュ", multiplier: 250 },
  { category: 8, name: "ストレートフラッシュ", multiplier: 50 },
  { category: 7, name: "フォーカード", multiplier: 25 },
  { category: 6, name: "フルハウス", multiplier: 9 },
  { category: 5, name: "フラッシュ", multiplier: 6 },
  { category: 4, name: "ストレート", multiplier: 4 },
  { category: 3, name: "スリーカード", multiplier: 3 },
  { category: 2, name: "ツーペア", multiplier: 2 },
  { category: 1, name: "ワンペア（J以上）", multiplier: 1 },
  { category: 0, name: "役なし", multiplier: 0 },
];

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function createDpDeck(): DpCard[] {
  const deck: DpCard[] = [];
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 13; rank++) deck.push({ suit, rank });
  }
  return deck;
}

function shuffle(deck: DpCard[], rng: number): { deck: DpCard[]; rng: number } {
  const out = [...deck];
  let r = rng;
  for (let i = out.length - 1; i > 0; i--) {
    const n = nextRandom(r);
    r = n.rng;
    const j = Math.floor(n.value * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return { deck: out, rng: r };
}

/** ストレート判定。戻り値はストレートの最高位ランク（ホイール A-2-3-4-5 は 5）。該当なしは null。 */
function straightHigh(ranks: number[]): number | null {
  const uniq = [...new Set(ranks)].sort((a, b) => a - b);
  if (uniq.length !== 5) return null;
  if (uniq[4] - uniq[0] === 4) return uniq[4];
  // ホイール: A(1),2,3,4,5
  if (uniq[0] === 1 && uniq[1] === 2 && uniq[2] === 3 && uniq[3] === 4 && uniq[4] === 5) return 5;
  // ブロードウェイ: 10,J,Q,K,A
  if (uniq[0] === 1 && uniq[1] === 10 && uniq[2] === 11 && uniq[3] === 12 && uniq[4] === 13) return 14;
  return null;
}

/** 5枚の手札の役を判定する。 */
export function evaluateHand(hand: DpCard[]): DpHandInfo {
  const info = (category: number): DpHandInfo => {
    const row = DP_HAND_TABLE.find((r) => r.category === category) ?? DP_HAND_TABLE[DP_HAND_TABLE.length - 1];
    return { category: row.category, name: row.name, multiplier: row.multiplier };
  };
  if (!Array.isArray(hand) || hand.length !== 5) return info(0);
  const ranks = hand.map((c) => c.rank);
  const flush = hand.every((c) => c.suit === hand[0].suit);
  const sHigh = straightHigh(ranks);
  if (flush && sHigh === 14) return info(9);
  if (flush && sHigh !== null) return info(8);
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const pattern = groups.map((g) => g[1]).join(",");
  if (pattern === "4,1") return info(7);
  if (pattern === "3,2") return info(6);
  if (flush) return info(5);
  if (sHigh !== null) return info(4);
  if (pattern === "3,1,1") return info(3);
  if (pattern === "2,2,1") return info(2);
  if (pattern === "2,1,1,1") {
    const pairRank = groups[0][0];
    // J(11) 以上、または A(1) のペアだけが配当対象。
    if (pairRank === 1 || pairRank >= 11) return info(1);
    return { category: 0, name: "ワンペア（配当なし）", multiplier: 0 };
  }
  return info(0);
}

/**
 * 残すべき札の index（簡易戦略。UI の初期選択に使う）。
 * 役ができていれば関係札を全部残し、フラッシュ/ストレートの4枚ドローは4枚を残し、
 * そうでなければ J 以上の札だけ残す。
 */
export function suggestHolds(hand: DpCard[]): number[] {
  if (!Array.isArray(hand) || hand.length !== 5) return [];
  const evald = evaluateHand(hand);
  const ranks = hand.map((c) => c.rank);
  if (evald.category >= 3) {
    if (evald.category >= 4) return [0, 1, 2, 3, 4];
    // スリーカード/ツーペアはグループ札だけ残す。
    const counts = new Map<number, number>();
    for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
    return hand.map((c, i) => ((counts.get(c.rank) ?? 0) >= 2 ? i : -1)).filter((i) => i >= 0);
  }
  if (evald.category >= 1 || (evald.category === 0 && evald.name.startsWith("ワンペア"))) {
    const counts = new Map<number, number>();
    for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
    const pairRank = [...counts.entries()].find(([, n]) => n === 2)?.[0];
    if (pairRank !== undefined) return hand.map((c, i) => (c.rank === pairRank ? i : -1)).filter((i) => i >= 0);
  }
  // 4枚フラッシュドロー
  const bySuit = new Map<Suit, number[]>();
  hand.forEach((c, i) => {
    if (!bySuit.has(c.suit)) bySuit.set(c.suit, []);
    (bySuit.get(c.suit) as number[]).push(i);
  });
  for (const idxs of bySuit.values()) if (idxs.length === 4) return [...idxs];
  // 4枚ストレートドロー（1枚補えばストレートになる4枚組）
  const idxAll = [0, 1, 2, 3, 4];
  for (const drop of idxAll) {
    const keep = idxAll.filter((i) => i !== drop);
    const keepRanks = keep.map((i) => ranks[i]);
    if (new Set(keepRanks).size !== 4) continue;
    for (let add = 1; add <= 13; add++) {
      if (straightHigh([...keepRanks, add]) !== null) return keep;
    }
  }
  // ハイカードだけ残す。
  return hand.map((c, i) => (c.rank === 1 || c.rank >= 11 ? i : -1)).filter((i) => i >= 0);
}

export function createDrawPokerGame(seed: number, chips: number = DP_INITIAL_CHIPS): DpState {
  return {
    chips: Math.max(0, Math.floor(chips)),
    bet: 0,
    deck: [],
    hand: [],
    phase: "betting",
    result: null,
    rng: seed | 0,
    round: 0,
  };
}

/** ラウンド開始: 新しい山札を切って5枚配り、bet を差し引く。 */
export function startRound(state: DpState, bet: number): DpState {
  if (state.phase === "draw") return state;
  const amount = Math.floor(bet);
  if (!Number.isFinite(amount) || amount < DP_MIN_BET) return state;
  if (amount > state.chips) return state;
  const { deck, rng } = shuffle(createDpDeck(), state.rng);
  return {
    ...state,
    chips: state.chips - amount,
    bet: amount,
    deck: deck.slice(5),
    hand: deck.slice(0, 5),
    phase: "draw",
    result: null,
    rng,
    round: state.round + 1,
  };
}

/**
 * 交換してラウンドを確定させる。discards は捨てる札の index（重複・範囲外は無視）。
 * 配当は bet × 役倍率で、チップはこの確定時点でのみ動く。
 */
export function drawCards(state: DpState, discards: number[]): DpState {
  if (state.phase !== "draw") return state;
  const drop = new Set(
    (Array.isArray(discards) ? discards : []).filter(
      (i) => Number.isInteger(i) && i >= 0 && i < state.hand.length,
    ),
  );
  const deck = [...state.deck];
  const hand = state.hand.map((card, i) => (drop.has(i) ? (deck.shift() as DpCard) : card));
  const handInfo = evaluateHand(hand);
  const payout = state.bet * handInfo.multiplier;
  const delta = payout - state.bet;
  const message =
    payout > 0
      ? `${handInfo.name}！ 配当 ${handInfo.multiplier} 倍で ${payout} チップです。`
      : `${handInfo.name}。配当はありませんでした。`;
  return {
    ...state,
    chips: state.chips + payout,
    deck,
    hand,
    phase: "settled",
    result: { hand: handInfo, payout, delta, message },
  };
}

/** チップ再支給（チップが尽きたときだけ有効）。 */
export function refillDpChips(state: DpState): DpState {
  if (state.chips >= DP_MIN_BET) return state;
  return { ...state, chips: DP_INITIAL_CHIPS };
}
