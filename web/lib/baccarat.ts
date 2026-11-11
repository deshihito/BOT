// バカラの純粋ロジック（UI 非依存・シード決定的）。
// プレイヤー／バンカー／タイの3種の賭け。第3カードのルール表は正式ルールに従う。
// 配当: プレイヤー勝利 1:1、バンカー勝利 1:1 から 5% コミッション（利益は 0.95 倍・切り捨て）、
// タイ勝利 8:1。タイのときプレイヤー／バンカーへの賭けは返金（±0）。
// チップが動くのは配布＝確定の遷移だけ（クライアントはそのタイミングで保存する）。

export type BaccaratBetKind = "player" | "banker" | "tie";
export type BaccaratWinner = "player" | "banker" | "tie";
export type BaccaratPhase = "betting" | "result";

export interface BaccaratCard {
  /** 0=♠ 1=♥ 2=♦ 3=♣ */
  suit: number;
  /** 1(A)〜13(K)。 */
  rank: number;
}

export interface BaccaratState {
  chips: number;
  phase: BaccaratPhase;
  rng: number;
  /** 残りのシュー（末尾から配る）。 */
  deck: BaccaratCard[];
  playerCards: BaccaratCard[];
  bankerCards: BaccaratCard[];
  /** 直近の賭け（result フェーズの表示用）。 */
  lastBet: { kind: BaccaratBetKind; amount: number } | null;
  winner: BaccaratWinner | null;
  /** 直近ラウンドのチップ増減（利益は正、損失は負）。 */
  lastDelta: number;
  /** 勝敗履歴（古い順、最大30件）。 */
  history: BaccaratWinner[];
  round: number;
  seed: number;
}

export const BACCARAT_START_CHIPS = 1000;
export const BACCARAT_MIN_BET = 10;
const RESHUFFLE_AT = 15;
const HISTORY_MAX = 30;

/** mulberry32。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function shuffledDeck(rng: number): { deck: BaccaratCard[]; rng: number } {
  const deck: BaccaratCard[] = [];
  for (let suit = 0; suit < 4; suit++) {
    for (let rank = 1; rank <= 13; rank++) deck.push({ suit, rank });
  }
  let r = rng;
  for (let i = deck.length - 1; i > 0; i--) {
    const n = nextRandom(r);
    r = n.rng;
    const j = Math.floor(n.value * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return { deck, rng: r };
}

/** バカラのカード値: A=1、2〜9はそのまま、10・J・Q・Kは0。 */
export function baccaratCardValue(rank: number): number {
  return rank >= 10 ? 0 : rank;
}

/** 手札の合計（一の位のみ）。 */
export function baccaratHandValue(cards: BaccaratCard[]): number {
  return cards.reduce((sum, c) => sum + baccaratCardValue(c.rank), 0) % 10;
}

/** プレイヤーが3枚目を引くか（0〜5で引く、6〜7は止まる）。 */
export function baccaratPlayerDraws(playerTotal: number): boolean {
  return playerTotal <= 5;
}

/**
 * バンカーが3枚目を引くか。
 * @param bankerTotal バンカーの2枚合計
 * @param playerThird プレイヤーの3枚目のカード値（プレイヤーが止まった場合は null）
 */
export function baccaratBankerDraws(bankerTotal: number, playerThird: number | null): boolean {
  if (playerThird === null) {
    // プレイヤーが止まったら、バンカーはプレイヤーと同じルール（0〜5で引く）。
    return bankerTotal <= 5;
  }
  switch (bankerTotal) {
    case 0:
    case 1:
    case 2:
      return true;
    case 3:
      return playerThird !== 8;
    case 4:
      return playerThird >= 2 && playerThird <= 7;
    case 5:
      return playerThird >= 4 && playerThird <= 7;
    case 6:
      return playerThird === 6 || playerThird === 7;
    default:
      return false;
  }
}

/** 賭けと結果からチップ増減（純利益）を返す。 */
export function baccaratPayout(kind: BaccaratBetKind, amount: number, winner: BaccaratWinner): number {
  if (winner === "tie") {
    return kind === "tie" ? amount * 8 : 0;
  }
  if (kind === winner) {
    return kind === "banker" ? Math.floor(amount * 0.95) : amount;
  }
  return -amount;
}

export function createBaccarat(seed: number, chips: number = BACCARAT_START_CHIPS): BaccaratState {
  const { deck, rng } = shuffledDeck(seed | 0);
  return {
    chips,
    phase: "betting",
    rng,
    deck,
    playerCards: [],
    bankerCards: [],
    lastBet: null,
    winner: null,
    lastDelta: 0,
    history: [],
    round: 0,
    seed: seed | 0,
  };
}

/**
 * 賭けて配布し、結果まで確定させる（チップもこの遷移でだけ動く）。
 * 不正な賭けは Error を throw する。
 */
export function placeBaccaratBet(state: BaccaratState, kind: BaccaratBetKind, amount: number): BaccaratState {
  if (state.phase !== "betting") throw new Error("今は賭けられません");
  if (kind !== "player" && kind !== "banker" && kind !== "tie") throw new Error("賭け先が不正です");
  if (!Number.isInteger(amount) || amount < BACCARAT_MIN_BET) {
    throw new Error(`賭け金は${BACCARAT_MIN_BET}以上で指定してください`);
  }
  if (amount > state.chips) throw new Error("チップが足りません");

  let deck = state.deck;
  let rng = state.rng;
  if (deck.length < RESHUFFLE_AT) {
    const s = shuffledDeck(rng);
    deck = s.deck;
    rng = s.rng;
  }
  const pool = [...deck];
  const draw = (): BaccaratCard => pool.pop() as BaccaratCard;

  const playerCards: BaccaratCard[] = [draw(), draw()];
  const bankerCards: BaccaratCard[] = [draw(), draw()];

  const p0 = baccaratHandValue(playerCards);
  const b0 = baccaratHandValue(bankerCards);
  const natural = p0 >= 8 || b0 >= 8;
  if (!natural) {
    let playerThird: number | null = null;
    if (baccaratPlayerDraws(p0)) {
      const third = draw();
      playerCards.push(third);
      playerThird = baccaratCardValue(third.rank);
    }
    if (baccaratBankerDraws(b0, playerThird)) {
      bankerCards.push(draw());
    }
  }

  const pTotal = baccaratHandValue(playerCards);
  const bTotal = baccaratHandValue(bankerCards);
  const winner: BaccaratWinner = pTotal > bTotal ? "player" : bTotal > pTotal ? "banker" : "tie";
  const delta = baccaratPayout(kind, amount, winner);

  return {
    ...state,
    chips: state.chips + delta,
    phase: "result",
    rng,
    deck: pool,
    playerCards,
    bankerCards,
    lastBet: { kind, amount },
    winner,
    lastDelta: delta,
    history: [...state.history, winner].slice(-HISTORY_MAX),
    round: state.round + 1,
  };
}

/** 次のラウンドへ（手札と結果表示を消す。チップと履歴は保持）。 */
export function nextBaccaratRound(state: BaccaratState): BaccaratState {
  if (state.phase !== "result") return state;
  return {
    ...state,
    phase: "betting",
    playerCards: [],
    bankerCards: [],
    lastBet: null,
    winner: null,
    lastDelta: 0,
  };
}

/** チップが尽きたときの再支給。チップが残っている場合は何もしない。 */
export function refillBaccarat(state: BaccaratState): BaccaratState {
  if (state.chips >= BACCARAT_MIN_BET) return state;
  return { ...state, chips: BACCARAT_START_CHIPS };
}

const SUIT_LABELS = ["♠", "♥", "♦", "♣"];
const RANK_LABELS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

export function baccaratCardLabel(card: BaccaratCard): string {
  return `${SUIT_LABELS[card.suit] ?? "?"}${RANK_LABELS[card.rank - 1] ?? "?"}`;
}
