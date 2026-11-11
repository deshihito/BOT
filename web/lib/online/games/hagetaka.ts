// ハゲタカ（オンライン対戦）のルールモジュール。
// 基盤契約: import は type のみ（テストが import を剥がして連結する）。
// 状態は JSON 化可能な値だけ。applyAction / onPlayerLeft は純関数。
// ルール:
// - 全員が 1〜15 の入札カードを1枚ずつ持つ。得点カードは -5〜-1 と +1〜+10 の15枚。
// - 各ラウンド、得点カード（前ラウンドの同値持ち越し分を含む）をめくり、
//   全員が同時に手札から1枚を伏せて出す。全員が出したら開示して決着する。
// - 場の得点合計がプラスのときは「最も高い入札」が得点カードを全部取る。
//   マイナスのときは「最も低い入札」が引き取る（得点はその分マイナス）。
//   合計0のときは最も高い入札が取る。
// - 同じ数字を出した入札は無効になる。最高（最低）の候補が同値で潰れたら
//   次の数字が繰り上がる。全員の入札が同値で潰れたら決着せず、
//   得点カードは次ラウンドへ持ち越す（最終ラウンドでは破棄）。
// - 出した入札カードは決着・持ち越しにかかわらず捨てられる。
// - 制限時間はない。全員（退出者を除く）が提出したら締め切る。
// - 得点カードの配布列はシード決定的に決まる。入札は締切まで秘匿する。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export const HG_TOTAL_ROUNDS = 15;

/** 得点カードの全種（-5〜-1, +1〜+10）。 */
export const HG_PRIZE_VALUES: number[] = [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** 入札カードの全種（1〜15）。 */
export const HG_BID_VALUES: number[] = Array.from({ length: 15 }, (_, i) => i + 1);

export type HagetakaPhase = "bidding" | "finished";

export type HagetakaBid = { seat: number; card: number };

export type HagetakaHistoryEntry = {
  round: number;
  /** そのラウンドで場に出ていた得点カード（持ち越し含む）。 */
  prizes: number[];
  prizeTotal: number;
  /** 全プレイヤー分。未提出・退出済みは null。 */
  bids: { seat: number; card: number | null }[];
  /** 得点カードを取った seat。持ち越し・破棄は null。 */
  taker: number | null;
  carried: boolean;
};

export interface HagetakaState {
  players: { seat: number; name: string }[];
  leftSeats: number[];
  round: number;
  totalRounds: number;
  phase: HagetakaPhase;
  /** 得点カードの配布列（未公開分を含む内部情報）。 */
  prizeDeck: number[];
  /** 現在場に出ている得点カード（持ち越し＋今回分）。 */
  table: number[];
  /** 残りの手札。 */
  hands: Record<number, number[]>;
  scores: Record<number, number>;
  /** 現在ラウンドの入札（内部のみ。締切まで viewFor で秘匿）。 */
  bids: HagetakaBid[];
  history: HagetakaHistoryEntry[];
}

export type HagetakaAction = { type: "bid"; card: number };

export interface HagetakaViewPlayer {
  seat: number;
  name: string;
  score: number;
  left: boolean;
  submitted: boolean;
  handCount: number;
}

export interface HagetakaView {
  phase: HagetakaPhase;
  round: number;
  totalRounds: number;
  table: number[];
  tableTotal: number;
  prizesLeft: number;
  you: {
    seat: number;
    hand: number[];
    submitted: boolean;
    yourCard: number | null;
    left: boolean;
  };
  players: HagetakaViewPlayer[];
  history: HagetakaHistoryEntry[];
  lastResult: HagetakaHistoryEntry | null;
  standings: { seat: number; score: number; rank: number }[] | null;
}

// ---------------------------------------------------------------- utilities

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function playerOf(state: HagetakaState, seat: number): { seat: number; name: string } | undefined {
  return state.players.find((p) => p.seat === seat);
}

function activeSeats(state: HagetakaState): number[] {
  return state.players.filter((p) => !state.leftSeats.includes(p.seat)).map((p) => p.seat);
}

/**
 * 入札の決着を決める純関数。
 * bids から同値の入札を無効化し、残りの中で最高（total>=0）または
 * 最低（total<0）の入札者を返す。残りが無ければ null（持ち越し）。
 */
export function hagetakaTaker(bids: HagetakaBid[], prizeTotal: number): number | null {
  const counts = new Map<number, number>();
  for (const b of bids) counts.set(b.card, (counts.get(b.card) ?? 0) + 1);
  const valid = bids.filter((b) => counts.get(b.card) === 1);
  if (valid.length === 0) return null;
  const sorted = [...valid].sort((a, b) => a.card - b.card);
  return prizeTotal < 0 ? sorted[0].seat : sorted[sorted.length - 1].seat;
}

/** 現在のラウンドを締め切り、決着して次へ進める（draft を破壊的に更新）。 */
function closeRound(draft: HagetakaState): void {
  const prizes = [...draft.table];
  const prizeTotal = prizes.reduce((a, b) => a + b, 0);
  const entry: HagetakaHistoryEntry = {
    round: draft.round,
    prizes,
    prizeTotal,
    bids: draft.players.map((p) => {
      const b = draft.bids.find((x) => x.seat === p.seat);
      return { seat: p.seat, card: b && !draft.leftSeats.includes(p.seat) ? b.card : null };
    }),
    taker: null,
    carried: false,
  };
  const taker = hagetakaTaker(draft.bids, prizeTotal);
  const isLast = draft.round + 1 >= draft.totalRounds;
  if (taker !== null) {
    entry.taker = taker;
    draft.scores[taker] = (draft.scores[taker] ?? 0) + prizeTotal;
    draft.table = [];
  } else if (isLast) {
    // 最終ラウンドの持ち越しは破棄する。
    draft.table = [];
  } else {
    entry.carried = true;
    // table はそのまま次ラウンドへ持ち越す。
  }
  // 出した入札カードは全員分捨てる。
  for (const b of draft.bids) {
    const hand = draft.hands[b.seat];
    if (hand) draft.hands[b.seat] = hand.filter((c) => c !== b.card);
  }
  draft.bids = [];
  draft.history.push(entry);
  draft.round += 1;
  if (draft.round >= draft.totalRounds) {
    draft.phase = "finished";
    return;
  }
  // 次の得点カードをめくる。
  const nextPrize = draft.prizeDeck[draft.round];
  if (nextPrize !== undefined) draft.table = [...draft.table, nextPrize];
}

/** 全員（脱落を除く）が提出済みなら即締切する。 */
function closeIfAllBid(draft: HagetakaState): void {
  if (draft.phase !== "bidding") return;
  const active = activeSeats(draft);
  if (active.length === 0) return;
  if (active.every((s) => draft.bids.some((b) => b.seat === s))) closeRound(draft);
}

// ---------------------------------------------------------------- module

function createState(players: SeatInfo[], rng: Rng, _options: Record<string, unknown>): HagetakaState {
  if (!Array.isArray(players) || players.length < 2 || players.length > 6) {
    throw new Error("ハゲタカは2〜6人で遊ぶゲームです");
  }
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const prizeDeck = [...HG_PRIZE_VALUES];
  for (let i = prizeDeck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [prizeDeck[i], prizeDeck[j]] = [prizeDeck[j], prizeDeck[i]];
  }
  const hands: Record<number, number[]> = {};
  const scores: Record<number, number> = {};
  for (const p of sorted) {
    hands[p.seat] = [...HG_BID_VALUES];
    scores[p.seat] = 0;
  }
  return {
    players: sorted.map((p) => ({ seat: p.seat, name: p.name })),
    leftSeats: [],
    round: 0,
    totalRounds: HG_TOTAL_ROUNDS,
    phase: "bidding",
    prizeDeck,
    table: [prizeDeck[0]],
    hands,
    scores,
    bids: [],
    history: [],
  };
}

function applyAction(state: HagetakaState, seat: number, action: HagetakaAction, _rng: Rng): HagetakaState {
  if (!action || typeof action !== "object" || (action as { type?: unknown }).type !== "bid") {
    throw new Error("不明なアクションです");
  }
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished") throw new Error("ゲームは終了しています");
  if (state.leftSeats.includes(seat)) throw new Error("退出したプレイヤーは入札できません");
  const card = (action as { card?: unknown }).card;
  if (!Number.isInteger(card) || (card as number) < 1 || (card as number) > 15) {
    throw new Error("入札カードが不正です");
  }
  if (!(state.hands[seat] ?? []).includes(card as number)) throw new Error("そのカードは手札にありません");
  if (state.bids.some((b) => b.seat === seat)) throw new Error("すでに出しています");

  const draft = clone(state);
  draft.bids.push({ seat, card: card as number });
  closeIfAllBid(draft);
  return draft;
}

function viewFor(state: HagetakaState, seat: number): HagetakaView {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  const finished = state.phase === "finished";
  const myBid = state.bids.find((b) => b.seat === seat);

  let standings: HagetakaView["standings"] = null;
  if (finished) {
    const sorted = [...state.players].sort((a, b) => (state.scores[b.seat] ?? 0) - (state.scores[a.seat] ?? 0));
    standings = sorted.map((p) => ({
      seat: p.seat,
      score: state.scores[p.seat] ?? 0,
      rank: 1 + sorted.filter((o) => (state.scores[o.seat] ?? 0) > (state.scores[p.seat] ?? 0)).length,
    }));
  }

  return {
    phase: state.phase,
    round: Math.min(state.round, state.totalRounds - 1),
    totalRounds: state.totalRounds,
    table: [...state.table],
    tableTotal: state.table.reduce((a, b) => a + b, 0),
    prizesLeft: state.totalRounds - state.round,
    you: {
      seat,
      hand: [...(state.hands[seat] ?? [])],
      submitted: Boolean(myBid),
      yourCard: myBid ? myBid.card : null,
      left: state.leftSeats.includes(seat),
    },
    players: state.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      score: state.scores[p.seat] ?? 0,
      left: state.leftSeats.includes(p.seat),
      submitted: state.bids.some((b) => b.seat === p.seat),
      handCount: (state.hands[p.seat] ?? []).length,
    })),
    history: state.history,
    lastResult: state.history[state.history.length - 1] ?? null,
    standings,
  };
}

function parseAction(raw: unknown): HagetakaAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.type !== "bid") return null;
  if (!Number.isInteger(rec.card) || (rec.card as number) < 1 || (rec.card as number) > 15) return null;
  return { type: "bid", card: rec.card as number };
}

function onPlayerLeft(state: HagetakaState, seat: number): HagetakaState {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished" || state.leftSeats.includes(seat)) return state;
  const draft = clone(state);
  draft.leftSeats.push(seat);
  // 退出者の入札は未提出扱いにする。
  draft.bids = draft.bids.filter((b) => b.seat !== seat);
  if (activeSeats(draft).length < 2) {
    draft.phase = "finished";
    return draft;
  }
  closeIfAllBid(draft);
  return draft;
}

export const gameModule: OnlineGameModule<HagetakaState, HagetakaAction, HagetakaView> = {
  id: "hagetaka",
  title: "ハゲタカ",
  minPlayers: 2,
  maxPlayers: 6,
  cpuSupported: false,
  chatEnabled: true,
  createState,
  applyAction,
  viewFor,
  parseAction,
  phaseOf: (state: HagetakaState) => state.phase,
  isFinished: (state: HagetakaState) => state.phase === "finished",
  onPlayerLeft,
};
