// テキサスポーカー簡易版（2〜6人）のルールモジュール。
// モジュール契約は lib/online/types.ts の OnlineGameModule に従う。
// 実行時 import は禁止（テストが import を剥がして連結するため type のみ）。
//
// 簡易版ルール（レイズなし）:
// - 全5ハンド制。各プレイヤーはチップ100点から開始し、チップ0で脱落。
// - 各ハンド、参加者はアンティ10点を払い、手札2枚を受ける。
// - ストリートは プリフロップ→フロップ（共通3枚）→ターン（4枚目）→
//   リバー（5枚目）の4つ。各ストリートでは順番に「参加（固定10点を払う）」
//   か「フォールド」を選ぶだけ。レイズはない。
// - チップが10点未満なら残り全部で参加（オールイン）し、ショーダウンまで残る。
// - 全員フォールドで1人だけ残れば、その人がポットを無条件で得る。
//   最後まで残った人が複数いればショーダウン: 手札2枚＋共通5枚の7枚から
//   最良の5枚で役を比べ、同役はキッカーで比較する。同点はポットを山分けし、
//   端数は席順の早い勝者が受け取る（簡易化のためサイドポットは作らない）。
// - カード表現は id 0〜51（suit = floor(id/13)、rank = (id % 13) + 1、1=A）。
// - 山札は createState で5ハンドぶんを先に切っておく（tick に rng が無いため）。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export const TX_START_CHIPS = 100;
export const TX_ANTE = 10;
export const TX_BET = 10;
export const TX_TOTAL_HANDS = 5;
export const TX_HAND_END_MS = 8000;

export type TexasStreet = "preflop" | "flop" | "turn" | "river";
export const TX_STREETS: TexasStreet[] = ["preflop", "flop", "turn", "river"];
export const TX_BOARD_COUNT: Record<TexasStreet, number> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
};

export interface TexasPlayerState {
  seat: number;
  name: string;
  chips: number;
  hole: number[];
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  /** このハンドでポットへ出した合計。 */
  committed: number;
  left: boolean;
}

export interface TexasLogEntry {
  kind: "hand" | "call" | "fold" | "win" | "left";
  seat?: number;
  amount?: number;
  hand?: number;
  handName?: string;
  showdown?: boolean;
}

export interface TexasLastResult {
  hand: number;
  winners: number[];
  amount: number;
  showdown: boolean;
  /** ショーダウン時のみ: seat -> 手札と役名。 */
  hands: Record<number, { cards: number[]; name: string }> | null;
}

export interface TexasStanding {
  seat: number;
  chips: number;
  rank: number;
}

export interface TexasState {
  players: TexasPlayerState[];
  /** 5ハンドぶんの山札（createState で切る。ビューには含めない）。 */
  decks: number[][];
  handNumber: number;
  phase: "betting" | "handEnd" | "finished";
  street: TexasStreet;
  board: number[];
  pot: number;
  turn: number;
  nextFrom: number;
  acted: number[];
  lastResult: TexasLastResult | null;
  standings: TexasStanding[] | null;
  nextHandAt: number | null;
  log: TexasLogEntry[];
}

export type TexasAction = { type: "act"; move: "call" | "fold" } | { type: "next" };

export interface TexasPlayerView {
  seat: number;
  name: string;
  chips: number;
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  left: boolean;
  committed: number;
  cardCount: number;
  isTurn: boolean;
}

export interface TexasView {
  phase: TexasState["phase"];
  street: TexasStreet;
  handNumber: number;
  totalHands: number;
  pot: number;
  board: number[];
  yourCards: number[];
  turn: number | null;
  yourTurn: boolean;
  callAmount: number;
  players: TexasPlayerView[];
  lastResult: TexasLastResult | null;
  standings: TexasStanding[] | null;
  nextHandAt: number | null;
  log: TexasLogEntry[];
  finished: boolean;
}

function txClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function txSuitOf(id: number): number {
  return Math.floor(id / 13);
}
function txRankOf(id: number): number {
  return (id % 13) + 1;
}
function txRank14(id: number): number {
  const r = txRankOf(id);
  return r === 1 ? 14 : r;
}

// ---------------------------------------------------------------- 役判定

export const TX_HAND_NAMES = [
  "ハイカード",
  "ワンペア",
  "ツーペア",
  "スリーカード",
  "ストレート",
  "フラッシュ",
  "フルハウス",
  "フォーカード",
  "ストレートフラッシュ",
] as const;

export type TexasEval = { category: number; name: string; score: number[] };

/** 5枚の役を [カテゴリ, キッカー...] の比較可能なスコアで返す。 */
function txEvalFive(cards: number[]): number[] {
  const ranks = cards.map(txRank14);
  const flush = cards.every((c) => txSuitOf(c) === txSuitOf(cards[0]));
  const uniq = [...new Set(ranks)].sort((a, b) => b - a);
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) {
      straightHigh = 5; // ホイール A-2-3-4-5
    }
  }
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]); // [rank, count]
  const pattern = groups.map((g) => g[1]).join(",");
  const ranksDesc = [...ranks].sort((a, b) => b - a);
  if (flush && straightHigh > 0) return [8, straightHigh];
  if (pattern === "4,1") return [7, groups[0][0], groups[1][0]];
  if (pattern === "3,2") return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...ranksDesc];
  if (straightHigh > 0) return [4, straightHigh];
  if (pattern === "3,1,1") {
    return [3, groups[0][0], ...groups.slice(1).map((g) => g[0]).sort((a, b) => b - a)];
  }
  if (pattern === "2,2,1") {
    const pairs = groups
      .slice(0, 2)
      .map((g) => g[0])
      .sort((a, b) => b - a);
    return [2, pairs[0], pairs[1], groups[2][0]];
  }
  if (pattern === "2,1,1,1") {
    return [1, groups[0][0], ...groups.slice(1).map((g) => g[0]).sort((a, b) => b - a)];
  }
  return [0, ...ranksDesc];
}

/** スコア配列の比較（正なら a が強い）。 */
export function compareTexasScores(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 5〜7枚から最良の5枚を選んで役を評価する。 */
export function evaluateTexasHand(cards: number[]): TexasEval {
  if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7) {
    throw new Error("役判定には5〜7枚のカードが必要です");
  }
  let best: number[] | null = null;
  const n = cards.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    let bits = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) bits++;
    if (bits !== 5) continue;
    const five = cards.filter((_, i) => (mask & (1 << i)) !== 0);
    const score = txEvalFive(five);
    if (!best || compareTexasScores(score, best) > 0) best = score;
  }
  const finalScore = best as number[];
  const category = finalScore[0];
  return { category, name: TX_HAND_NAMES[category], score: finalScore };
}

// ---------------------------------------------------------------- 内部進行

function txPushLog(state: TexasState, entry: TexasLogEntry): void {
  state.log = [...state.log, entry].slice(-30);
}

function txContenders(state: TexasState): TexasPlayerState[] {
  return state.players.filter((p) => p.inHand && !p.folded);
}

function txEnterHandEnd(state: TexasState): void {
  state.phase = "handEnd";
  state.nextHandAt = null;
}

function txSettleFoldWin(state: TexasState): void {
  const contenders = txContenders(state);
  if (contenders.length === 1) {
    const winner = contenders[0];
    const amount = state.pot;
    winner.chips += amount;
    state.lastResult = {
      hand: state.handNumber,
      winners: [winner.seat],
      amount,
      showdown: false,
      hands: null,
    };
    txPushLog(state, { kind: "win", seat: winner.seat, amount, showdown: false });
  } else {
    // 全員退出など勝者なし。ポットは消滅する。
    state.lastResult = {
      hand: state.handNumber,
      winners: [],
      amount: 0,
      showdown: false,
      hands: null,
    };
  }
  state.pot = 0;
  txEnterHandEnd(state);
}

function txShowdown(state: TexasState): void {
  const contenders = txContenders(state);
  const evals = new Map<number, TexasEval>();
  let bestScore: number[] | null = null;
  for (const p of contenders) {
    const ev = evaluateTexasHand([...p.hole, ...state.board]);
    evals.set(p.seat, ev);
    if (!bestScore || compareTexasScores(ev.score, bestScore) > 0) bestScore = ev.score;
  }
  const winners = contenders
    .filter((p) => compareTexasScores((evals.get(p.seat) as TexasEval).score, bestScore as number[]) === 0)
    .map((p) => p.seat)
    .sort((a, b) => a - b);
  const amount = state.pot;
  const share = Math.floor(amount / winners.length);
  let remainder = amount - share * winners.length;
  for (const seat of winners) {
    let gain = share;
    if (remainder > 0) {
      gain += 1; // 端数は席順の早い勝者から1点ずつ
      remainder -= 1;
    }
    const player = state.players[seat];
    player.chips += gain;
    txPushLog(state, {
      kind: "win",
      seat,
      amount: gain,
      showdown: true,
      handName: (evals.get(seat) as TexasEval).name,
    });
  }
  const hands: Record<number, { cards: number[]; name: string }> = {};
  for (const p of contenders) {
    hands[p.seat] = { cards: [...p.hole], name: (evals.get(p.seat) as TexasEval).name };
  }
  state.lastResult = { hand: state.handNumber, winners, amount, showdown: true, hands };
  state.pot = 0;
  txEnterHandEnd(state);
}

/** 次に行動すべき seat。いなければ null（ストリート終了）。 */
function txNextActor(state: TexasState): number | null {
  const n = state.players.length;
  for (let step = 0; step < n; step++) {
    const seat = (state.nextFrom + step) % n;
    const p = state.players[seat];
    if (p.inHand && !p.folded && p.chips > 0 && !state.acted.includes(seat)) return seat;
  }
  return null;
}

/** アクション後の進行（ストリート送り・決着・ショーダウン）を回す。 */
function txAdvance(state: TexasState): void {
  while (state.phase === "betting") {
    const contenders = txContenders(state);
    if (contenders.length <= 1) {
      txSettleFoldWin(state);
      return;
    }
    const actor = txNextActor(state);
    if (actor !== null) {
      state.turn = actor;
      return;
    }
    const streetIdx = TX_STREETS.indexOf(state.street);
    if (streetIdx >= TX_STREETS.length - 1) {
      txShowdown(state);
      return;
    }
    state.street = TX_STREETS[streetIdx + 1];
    state.acted = [];
    state.nextFrom = 0;
  }
}

function txStartHand(state: TexasState): void {
  state.handNumber += 1;
  state.lastResult = null;
  state.phase = "betting";
  state.street = "preflop";
  state.acted = [];
  state.nextFrom = 0;
  state.nextHandAt = null;
  for (const p of state.players) {
    p.hole = [];
    p.inHand = false;
    p.folded = false;
    p.allIn = false;
    p.committed = 0;
  }
  const deck = [...(state.decks[state.handNumber - 1] ?? [])];
  const participants = state.players.filter((p) => !p.left && p.chips > 0);
  let di = 0;
  for (const p of participants) {
    p.inHand = true;
    p.hole = [deck[di], deck[di + 1]];
    di += 2;
  }
  state.board = deck.slice(di, di + 5);
  state.pot = 0;
  for (const p of participants) {
    const pay = Math.min(TX_ANTE, p.chips);
    p.chips -= pay;
    p.committed += pay;
    state.pot += pay;
    if (p.chips === 0) p.allIn = true;
  }
  txPushLog(state, { kind: "hand", hand: state.handNumber });
  txAdvance(state);
}

function txFinishMatch(state: TexasState): void {
  state.phase = "finished";
  state.standings = state.players.map((p) => ({
    seat: p.seat,
    chips: p.chips,
    rank: 1 + state.players.filter((q) => q.chips > p.chips).length,
  }));
}

/** handEnd から次へ進む（次のハンド or 終了）。 */
function txProceed(state: TexasState): void {
  const remaining = state.players.filter((p) => !p.left && p.chips > 0);
  if (state.handNumber >= TX_TOTAL_HANDS || remaining.length < 2) {
    txFinishMatch(state);
    return;
  }
  txStartHand(state);
}

// ---------------------------------------------------------------- モジュール

function txCreateState(
  players: SeatInfo[],
  rng: Rng,
  _options: Record<string, unknown>,
): TexasState {
  if (!Array.isArray(players) || players.length < 2 || players.length > 6) {
    throw new Error("テキサスポーカーは2〜6人で遊びます");
  }
  const decks: number[][] = [];
  for (let h = 0; h < TX_TOTAL_HANDS; h++) {
    const deck = Array.from({ length: 52 }, (_, i) => i);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = deck[i];
      deck[i] = deck[j];
      deck[j] = tmp;
    }
    decks.push(deck);
  }
  const state: TexasState = {
    players: players.map((p) => ({
      seat: p.seat,
      name: p.name,
      chips: TX_START_CHIPS,
      hole: [],
      inHand: false,
      folded: false,
      allIn: false,
      committed: 0,
      left: false,
    })),
    decks,
    handNumber: 0,
    phase: "betting",
    street: "preflop",
    board: [],
    pot: 0,
    turn: 0,
    nextFrom: 0,
    acted: [],
    lastResult: null,
    standings: null,
    nextHandAt: null,
    log: [],
  };
  txStartHand(state);
  return state;
}

function txApplyAction(
  state: TexasState,
  seat: number,
  action: TexasAction,
  _rng: Rng,
): TexasState {
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) {
    throw new Error("不正な席です");
  }
  if (!action || typeof action !== "object") throw new Error("不正なアクションです");
  if (state.phase === "finished") throw new Error("ゲームは終了しています");

  if (action.type === "next") {
    if (state.phase !== "handEnd") throw new Error("ハンドの終了待ちではありません");
    const next = txClone(state);
    txProceed(next);
    return next;
  }
  if (action.type !== "act") throw new Error("不正なアクションです");
  if (state.phase !== "betting") throw new Error("今はアクションできません");
  if (seat !== state.turn) throw new Error("手番ではありません");
  const me = state.players[seat];
  if (!me.inHand || me.folded) throw new Error("このハンドには参加していません");
  if (me.left) throw new Error("退出済みです");

  const next = txClone(state);
  const player = next.players[seat];
  if (action.move === "fold") {
    player.folded = true;
    txPushLog(next, { kind: "fold", seat });
  } else if (action.move === "call") {
    const pay = Math.min(TX_BET, player.chips);
    if (pay <= 0) throw new Error("チップがありません");
    player.chips -= pay;
    player.committed += pay;
    next.pot += pay;
    if (player.chips === 0) player.allIn = true;
    txPushLog(next, { kind: "call", seat, amount: pay });
  } else {
    throw new Error("不正なアクションです");
  }
  next.acted = [...next.acted, seat];
  next.nextFrom = seat + 1;
  txAdvance(next);
  return next;
}

function txViewFor(state: TexasState, seat: number): TexasView {
  const me = state.players[seat] as TexasPlayerState | undefined;
  const betting = state.phase === "betting";
  return {
    phase: state.phase,
    street: state.street,
    handNumber: state.handNumber,
    totalHands: TX_TOTAL_HANDS,
    pot: state.pot,
    board: betting ? state.board.slice(0, TX_BOARD_COUNT[state.street]) : [...state.board],
    yourCards: me ? [...me.hole] : [],
    turn: betting ? state.turn : null,
    yourTurn: betting && !!me && state.turn === seat && me.inHand && !me.folded,
    callAmount:
      betting && me && state.turn === seat ? Math.min(TX_BET, me.chips) : 0,
    players: state.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      chips: p.chips,
      inHand: p.inHand,
      folded: p.folded,
      allIn: p.allIn,
      left: p.left,
      committed: p.committed,
      cardCount: p.inHand ? p.hole.length : 0,
      isTurn: betting && state.turn === p.seat && p.inHand && !p.folded,
    })),
    lastResult: txClone(state.lastResult),
    standings: txClone(state.standings),
    nextHandAt: state.nextHandAt,
    log: txClone(state.log),
    finished: state.phase === "finished",
  };
}

function txParseAction(raw: unknown): TexasAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.type === "next") return { type: "next" };
  if (r.type === "act" && (r.move === "call" || r.move === "fold")) {
    return { type: "act", move: r.move };
  }
  return null;
}

function txOnPlayerLeft(state: TexasState, seat: number): TexasState {
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) {
    throw new Error("不正な席です");
  }
  if (state.phase === "finished") return txClone(state);
  const next = txClone(state);
  const player = next.players[seat];
  if (player.left) return next;
  player.left = true;
  txPushLog(next, { kind: "left", seat });
  if (next.phase === "betting" && player.inHand && !player.folded) {
    // 退出はフォールド扱い。手番だった場合も含め、進行は txAdvance が
    // 「フォールド済みは候補から外す」ことで正しく回す。
    player.folded = true;
    txAdvance(next);
  }
  return next;
}

function txTick(state: TexasState, now: number): TexasState {
  if (state.phase !== "handEnd") return state;
  if (state.nextHandAt === null) {
    return { ...state, nextHandAt: now + TX_HAND_END_MS };
  }
  if (now >= state.nextHandAt) {
    const next = txClone(state);
    txProceed(next);
    return next;
  }
  return state;
}

export const gameModule: OnlineGameModule<TexasState, TexasAction, TexasView> = {
  id: "texas",
  title: "テキサスポーカー",
  minPlayers: 2,
  maxPlayers: 6,
  cpuSupported: false,
  chatEnabled: true,
  createState: txCreateState,
  applyAction: txApplyAction,
  viewFor: txViewFor,
  parseAction: txParseAction,
  phaseOf: (state) => (state.phase === "betting" ? state.street : state.phase),
  isFinished: (state) => state.phase === "finished",
  onPlayerLeft: txOnPlayerLeft,
  tick: txTick,
};
