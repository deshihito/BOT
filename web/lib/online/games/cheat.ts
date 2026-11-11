// ブラフ（チート / BS、3〜6人）のルールモジュール。
// モジュール契約は lib/online/types.ts の OnlineGameModule に従う。
// 実行時 import は禁止（テストが import を剥がして連結するため type のみ）。
//
// カード表現: id 0〜51（suit = floor(id/13)、rank = (id % 13) + 1）。
//
// ルール（この実装の明示仕様）:
// - 全52枚をできるだけ均等に配る。手札は本人にだけ見える。
// - 手番は場のランク順（A→2→…→K→A…）に進む。手番の人は伏せて
//   1〜3枚を出し、今のランクを「そのランクがN枚」と宣言したことになる
//   （宣言ランクは手番で固定。実際のカードは何でもよい＝ブラフ可）。
// - 次の手番の人は、カードを出す前に直前の宣言へチャレンジできる。
//   チャレンジされずに次の人がカードを出したら、直前の宣言は確定し
//   もうチャレンジできない。
// - チャレンジで開示し、宣言どおり（出した全枚が宣言ランク）なら
//   チャレンジャーが、嘘なら出した人が、場の山をすべて引き取る。
//   その後はランクを A に戻し、チャレンジで勝った人から再開する。
// - 手札を出し切った人は「上がり候補」になる。次の人がチャレンジせずに
//   カードを出した時点で上がりが確定する。チャレンジされて嘘なら山を
//   引き取って候補ではなくなり、本当ならチャレンジャーが山を引き取り
//   候補の上がりが即確定する。誰も相手にできない状況（他全員が確定済み
//   か退出）では候補の上がりは自動で確定する。
// - 上がりが確定した順に順位が付く。最後まで残った1人が最下位。
// - 退出した人は脱落（手札は場から除外、順位は付かない）。退出者が
//   出した伏せ札が山に残っている場合、その宣言へのチャレンジで
//   嘘が判明しても、山は引き取り手がおらず破棄される。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export interface CheatPlay {
  seat: number;
  cards: number[];
  rank: number;
}

export interface CheatReveal {
  seat: number;
  cards: number[];
  rank: number;
  honest: boolean;
  challenger: number;
  /** 山を引き取った seat。退出者だった場合は null（山は破棄）。 */
  taker: number | null;
}

export interface CheatLogEntry {
  seat: number;
  kind: "play" | "challenge" | "take" | "finish" | "last" | "left";
  count?: number;
  rank?: number;
  honest?: boolean;
}

export interface CheatState {
  players: SeatInfo[];
  hands: number[][];
  pile: CheatPlay[];
  turn: number;
  expectedRank: number;
  candidate: number | null;
  finishOrder: number[];
  lastPlace: number | null;
  finished: boolean;
  leftSeats: number[];
  lastReveal: CheatReveal | null;
  log: CheatLogEntry[];
}

export type CheatAction =
  | { type: "play"; cards: number[] }
  | { type: "challenge" };

export interface CheatOtherView {
  seat: number;
  name: string;
  count: number;
  rank: number | null;
  left: boolean;
  candidate: boolean;
}

export interface CheatView {
  yourHand: number[];
  others: CheatOtherView[];
  turn: number;
  expectedRank: number;
  candidate: number | null;
  finishOrder: number[];
  yourRank: number | null;
  lastPlace: number | null;
  finished: boolean;
  pileCount: number;
  lastPlay: { seat: number; rank: number; count: number } | null;
  lastReveal: CheatReveal | null;
  log: CheatLogEntry[];
  players: SeatInfo[];
}

function cheatClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** カード id のランク（1=A 〜 13=K）。 */
export function cheatRankOf(id: number): number {
  return (id % 13) + 1;
}

export function cheatSortHand(hand: number[]): number[] {
  return [...hand].sort((a, b) => cheatRankOf(a) - cheatRankOf(b) || a - b);
}

function isInGame(state: CheatState, seat: number): boolean {
  return !state.finishOrder.includes(seat) && !state.leftSeats.includes(seat);
}

function inGameSeats(state: CheatState): number[] {
  const out: number[] = [];
  for (let s = 0; s < state.players.length; s++) {
    if (isInGame(state, s)) out.push(s);
  }
  return out;
}

/** 意思決定できる人（ゲーム内かつ上がり候補でない人）。 */
function deciderSeats(state: CheatState): number[] {
  return inGameSeats(state).filter((s) => s !== state.candidate);
}

function nextDecider(state: CheatState, from: number): number | null {
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const s = (from + step) % n;
    if (isInGame(state, s) && s !== state.candidate) return s;
  }
  return null;
}

function pushLog(state: CheatState, entry: CheatLogEntry): void {
  state.log = [...state.log, entry].slice(-24);
}

function pileCardCount(state: CheatState): number {
  return state.pile.reduce((sum, p) => sum + p.cards.length, 0);
}

/** 上がり候補を確定させる。 */
function confirmCandidate(state: CheatState): void {
  if (state.candidate === null) return;
  const seat = state.candidate;
  state.candidate = null;
  if (isInGame(state, seat)) {
    state.finishOrder.push(seat);
    pushLog(state, { seat, kind: "finish" });
  }
}

/**
 * 終局判定。ゲーム内が1人以下なら終了する。
 * 残った1人が候補なら上がり確定（最下位なし）、そうでなければ最下位。
 * 変化があれば true。
 */
function settleEnd(state: CheatState): boolean {
  if (state.finished) return true;
  const remaining = inGameSeats(state);
  if (remaining.length > 1) return false;
  if (remaining.length === 1) {
    const last = remaining[0];
    if (state.candidate === last) {
      confirmCandidate(state);
    } else {
      state.lastPlace = last;
      pushLog(state, { seat: last, kind: "last" });
    }
  }
  state.finished = true;
  return true;
}

function createState(
  players: SeatInfo[],
  rng: Rng,
  _options: Record<string, unknown>,
): CheatState {
  if (!Array.isArray(players) || players.length < 3 || players.length > 6) {
    throw new Error("ブラフは3〜6人で遊びます");
  }
  const deck: number[] = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  const n = players.length;
  const hands: number[][] = Array.from({ length: n }, () => []);
  deck.forEach((card, i) => {
    hands[i % n].push(card);
  });
  return {
    players: cheatClone(players),
    hands: hands.map((h) => cheatSortHand(h)),
    pile: [],
    turn: 0,
    expectedRank: 1,
    candidate: null,
    finishOrder: [],
    lastPlace: null,
    finished: false,
    leftSeats: [],
    lastReveal: null,
    log: [],
  };
}

function applyPlay(state: CheatState, seat: number, cards: number[]): CheatState {
  if (!Array.isArray(cards) || cards.length < 1 || cards.length > 3) {
    throw new Error("出すカードは1〜3枚です");
  }
  if (new Set(cards).size !== cards.length) {
    throw new Error("同じカードを重ねては出せません");
  }
  for (const c of cards) {
    if (!Number.isInteger(c) || c < 0 || c > 51) throw new Error("不正なカードです");
    if (!state.hands[seat].includes(c)) throw new Error("手札にないカードです");
  }

  const next = cheatClone(state);

  // 直前の上がり候補は、このプレイでチャレンジされなかったため確定する。
  if (next.candidate !== null && next.candidate !== seat) {
    confirmCandidate(next);
    if (settleEnd(next)) return next;
  }

  const rank = next.expectedRank;
  // 正直かどうか（宣言ランクと一致するか）は pile 側で保持し、
  // チャレンジ時に再計算して判定する。
  next.hands[seat] = cheatSortHand(next.hands[seat].filter((c) => !cards.includes(c)));
  next.pile = [...next.pile, { seat, cards: [...cards], rank }];
  next.lastReveal = null;
  pushLog(next, { seat, kind: "play", count: cards.length, rank });

  if (next.hands[seat].length === 0) {
    next.candidate = seat;
  }
  next.expectedRank = (rank % 13) + 1;

  if (next.candidate !== null && deciderSeats(next).length === 0) {
    // 誰もチャレンジもプレイもできないなら候補は自動確定。
    confirmCandidate(next);
    settleEnd(next);
    return next;
  }
  if (settleEnd(next)) return next;
  const nd = nextDecider(next, seat);
  if (nd === null) {
    settleEnd(next);
    return next;
  }
  next.turn = nd;
  return next;
}

function applyChallenge(state: CheatState, seat: number): CheatState {
  const last = state.pile[state.pile.length - 1];
  if (!last) throw new Error("チャレンジできる宣言がありません");
  if (last.seat === seat) throw new Error("自分の宣言にはチャレンジできません");

  const next = cheatClone(state);
  const play = next.pile[next.pile.length - 1];
  const honest = play.cards.every((c) => cheatRankOf(c) === play.rank);
  const takerSeat = honest ? seat : play.seat;
  const takerLeft = next.leftSeats.includes(takerSeat);
  const allCards = next.pile.flatMap((p) => p.cards);
  if (!takerLeft) {
    next.hands[takerSeat] = cheatSortHand([...next.hands[takerSeat], ...allCards]);
  }
  pushLog(next, { seat, kind: "challenge", honest });
  pushLog(next, { seat: takerSeat, kind: "take", count: allCards.length });
  next.lastReveal = {
    seat: play.seat,
    cards: [...play.cards],
    rank: play.rank,
    honest,
    challenger: seat,
    taker: takerLeft ? null : takerSeat,
  };
  next.pile = [];
  next.expectedRank = 1;

  // 候補の扱い: 本当なら候補の上がりが確定、嘘なら候補は山を取って復帰。
  if (next.candidate === play.seat) {
    if (honest) {
      confirmCandidate(next);
    } else {
      next.candidate = null;
    }
  }

  if (settleEnd(next)) return next;
  const winner = honest ? play.seat : seat;
  if (isInGame(next, winner) && next.candidate !== winner) {
    next.turn = winner;
  } else {
    const nd = nextDecider(next, winner);
    if (nd === null) {
      settleEnd(next);
      return next;
    }
    next.turn = nd;
  }
  return next;
}

function applyAction(
  state: CheatState,
  seat: number,
  action: CheatAction,
  _rng: Rng,
): CheatState {
  if (state.finished) throw new Error("ゲームは終了しています");
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) {
    throw new Error("不正な席です");
  }
  if (!isInGame(state, seat)) throw new Error("既に終了したプレイヤーです");
  if (state.candidate === seat) throw new Error("上がり候補は操作できません");
  if (seat !== state.turn) throw new Error("手番ではありません");
  if (!action || typeof action !== "object") throw new Error("不正なアクションです");
  if (action.type === "play") return applyPlay(state, seat, action.cards);
  if (action.type === "challenge") return applyChallenge(state, seat);
  throw new Error("不正なアクションです");
}

function rankOfSeat(state: CheatState, seat: number): number | null {
  const idx = state.finishOrder.indexOf(seat);
  if (idx >= 0) return idx + 1;
  if (state.finished && state.lastPlace === seat) return state.finishOrder.length + 1;
  return null;
}

function viewFor(state: CheatState, seat: number): CheatView {
  const last = state.pile[state.pile.length - 1];
  return {
    yourHand: [...(state.hands[seat] ?? [])],
    others: state.players
      .map((p, s) => ({
        seat: s,
        name: p.name,
        count: state.hands[s]?.length ?? 0,
        rank: rankOfSeat(state, s),
        left: state.leftSeats.includes(s),
        candidate: state.candidate === s,
      }))
      .filter((o) => o.seat !== seat),
    turn: state.turn,
    expectedRank: state.expectedRank,
    candidate: state.candidate,
    finishOrder: [...state.finishOrder],
    yourRank: rankOfSeat(state, seat),
    lastPlace: state.lastPlace,
    finished: state.finished,
    pileCount: pileCardCount(state),
    lastPlay: last ? { seat: last.seat, rank: last.rank, count: last.cards.length } : null,
    lastReveal: state.lastReveal ? cheatClone(state.lastReveal) : null,
    log: cheatClone(state.log),
    players: cheatClone(state.players),
  };
}

function parseAction(raw: unknown): CheatAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.type === "challenge") return { type: "challenge" };
  if (r.type === "play") {
    if (!Array.isArray(r.cards) || r.cards.length < 1 || r.cards.length > 3) return null;
    const cards: number[] = [];
    for (const c of r.cards) {
      if (typeof c !== "number" || !Number.isInteger(c) || c < 0 || c > 51) return null;
      cards.push(c);
    }
    if (new Set(cards).size !== cards.length) return null;
    return { type: "play", cards };
  }
  return null;
}

function onPlayerLeft(state: CheatState, seat: number): CheatState {
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) {
    throw new Error("不正な席です");
  }
  if (state.finished) return cheatClone(state);
  if (!isInGame(state, seat)) return cheatClone(state);
  const next = cheatClone(state);
  next.hands[seat] = [];
  next.leftSeats.push(seat);
  if (next.candidate === seat) next.candidate = null;
  pushLog(next, { seat, kind: "left" });

  if (next.candidate !== null && deciderSeats(next).length === 0) {
    confirmCandidate(next);
  }
  if (settleEnd(next)) return next;
  if (next.turn === seat || !deciderSeats(next).includes(next.turn)) {
    const nd = nextDecider(next, seat);
    if (nd === null) {
      settleEnd(next);
      return next;
    }
    next.turn = nd;
  }
  return next;
}

export const gameModule: OnlineGameModule<CheatState, CheatAction, CheatView> = {
  id: "cheat",
  title: "ブラフ",
  minPlayers: 3,
  maxPlayers: 6,
  cpuSupported: false,
  chatEnabled: true,
  createState,
  applyAction,
  viewFor,
  parseAction,
  phaseOf: (state) => (state.finished ? "finished" : "playing"),
  isFinished: (state) => state.finished,
  onPlayerLeft,
};
