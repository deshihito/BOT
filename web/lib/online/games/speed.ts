// スピード（トランプ）のルールモジュール。2人専用・同時進行（手番なし）。
// モジュール契約は lib/online/types.ts の OnlineGameModule に従う。
// 実行時 import は禁止（テストが import を剥がして連結するため type のみ）。
//
// カード表現は他のトランプ系と共通: id 0〜51、suit = floor(id/13)、
// rank = (id % 13) + 1（1=A … 13=K）。
// 各プレイヤーは場札4枚（表向き・公開）と山札を持つ。中央の2山のうち、
// ランクが±1つながり（A と K も循環でつながる）場札を出せる。
// 両者とも出せる札が無いときは、両者が「つなぎ札」アクションを行うと、
// 各自の山札（尽きたら場札）から中央の山へ新しい札が置かれる。
// 場札＋山札を先に無くしたプレイヤーの勝ち。相手の山札の中身は秘匿する。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

/** カード id（0〜51）のランク（1=A … 13=K）。 */
export function speedRankOf(id: number): number {
  return (id % 13) + 1;
}

/** card のランクが top のランクと±1（循環）かどうか。 */
export function speedCanPlayOn(card: number, top: number): boolean {
  const diff = (speedRankOf(card) - speedRankOf(top) + 13) % 13;
  return diff === 1 || diff === 12;
}

export interface SpeedLastPlay {
  seat: number;
  card: number;
  center: number;
}

export interface SpeedState {
  players: SeatInfo[];
  /** 場札（表向き・公開）。 */
  hands: number[][];
  /** 山札（中身は秘匿。末尾が一番上）。 */
  stocks: number[][];
  /** 中央の2山（末尾が一番上・公開）。 */
  centers: number[][];
  /** つなぎ札リクエスト（両方 true で発動）。 */
  connectReady: boolean[];
  connectCount: number;
  finished: boolean;
  winner: number | null;
  leftSeats: number[];
  lastPlay: SpeedLastPlay | null;
}

export type SpeedAction =
  | { type: "play"; handIndex: number; center: number }
  | { type: "connect" };

export interface SpeedSideView {
  seat: number;
  name: string;
  hand: number[];
  stockCount: number;
  total: number;
  left: boolean;
}

export interface SpeedView {
  you: SpeedSideView;
  opponent: SpeedSideView;
  centers: { top: number | null; count: number }[];
  connectReady: boolean[];
  /** 自分が出せる手（UI のハイライト用）。 */
  yourPlays: { handIndex: number; center: number }[];
  /** 自分が出せる札が無く、つなぎ札を要求できる状態か。 */
  youCanConnect: boolean;
  finished: boolean;
  winner: number | null;
  connectCount: number;
  lastPlay: SpeedLastPlay | null;
  players: SeatInfo[];
}

/** seat が現在出せる手の一覧。 */
export function speedLegalPlays(state: SpeedState, seat: number): { handIndex: number; center: number }[] {
  const out: { handIndex: number; center: number }[] = [];
  const hand = state.hands[seat];
  if (!hand) return out;
  for (let handIndex = 0; handIndex < hand.length; handIndex++) {
    for (let center = 0; center < 2; center++) {
      const pile = state.centers[center];
      const top = pile[pile.length - 1];
      if (top === undefined) {
        out.push({ handIndex, center });
      } else if (speedCanPlayOn(hand[handIndex], top)) {
        out.push({ handIndex, center });
      }
    }
  }
  return out;
}

function cloneState(state: SpeedState): SpeedState {
  return {
    players: state.players.map((p) => ({ seat: p.seat, name: p.name })),
    hands: state.hands.map((h) => [...h]),
    stocks: state.stocks.map((s) => [...s]),
    centers: state.centers.map((c) => [...c]),
    connectReady: [...state.connectReady],
    connectCount: state.connectCount,
    finished: state.finished,
    winner: state.winner,
    leftSeats: [...state.leftSeats],
    lastPlay: state.lastPlay ? { ...state.lastPlay } : null,
  };
}

function totalOf(state: SpeedState, seat: number): number {
  return state.hands[seat].length + state.stocks[seat].length;
}

function checkWinner(state: SpeedState): SpeedState {
  for (const seat of [0, 1] as const) {
    if (totalOf(state, seat) === 0) {
      return { ...state, finished: true, winner: seat };
    }
  }
  return state;
}

/** 場札が上限未満で山札が残っていれば補充する。 */
function refillHand(state: SpeedState, seat: number): void {
  while (state.hands[seat].length < 4 && state.stocks[seat].length > 0) {
    state.hands[seat].push(state.stocks[seat].pop() as number);
  }
}

/** 両者のつなぎ札リクエストがそろったときの山リセット。 */
function applyConnectReset(state: SpeedState): SpeedState {
  const next = cloneState(state);
  for (const seat of [0, 1] as const) {
    let card: number | undefined;
    if (next.stocks[seat].length > 0) {
      card = next.stocks[seat].pop();
    } else if (next.hands[seat].length > 0) {
      card = next.hands[seat].pop();
    }
    if (card !== undefined) {
      next.centers[seat].push(card);
    }
  }
  next.connectReady = [false, false];
  next.connectCount = state.connectCount + 1;
  return checkWinner(next);
}

export const gameModule: OnlineGameModule<SpeedState, SpeedAction, SpeedView> = {
  id: "speed",
  title: "スピード",
  minPlayers: 2,
  maxPlayers: 2,
  cpuSupported: false,
  chatEnabled: true,

  createState(players: SeatInfo[], rng: Rng, _options: Record<string, unknown>): SpeedState {
    if (!Array.isArray(players) || players.length !== 2) {
      throw new Error("スピードは2人専用です");
    }
    const deck: number[] = [];
    for (let i = 0; i < 52; i++) deck.push(i);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const dealt: number[][] = [[], []];
    deck.forEach((card, i) => dealt[i % 2].push(card));
    const hands = dealt.map((cards) => cards.slice(0, 4));
    const stocks = dealt.map((cards) => cards.slice(4));
    // 開始のつなぎ札として、各自の山札の上から1枚を中央へ出す。
    const centers = stocks.map((stock) => [stock.pop() as number]);
    return {
      players: players.map((p) => ({ seat: p.seat, name: p.name })),
      hands,
      stocks,
      centers,
      connectReady: [false, false],
      connectCount: 0,
      finished: false,
      winner: null,
      leftSeats: [],
      lastPlay: null,
    };
  },

  applyAction(state: SpeedState, seat: number, action: SpeedAction, _rng: Rng): SpeedState {
    if (state.finished) throw new Error("対局は終了しています");
    if (seat !== 0 && seat !== 1) throw new Error("参加者ではありません");
    if (state.leftSeats.includes(seat)) throw new Error("退出済みのプレイヤーは操作できません");
    if (!action || typeof action !== "object") throw new Error("不明なアクションです");

    if (action.type === "connect") {
      if (speedLegalPlays(state, seat).length > 0) {
        throw new Error("出せる札があるので、つなぎ札は出せません");
      }
      if (state.connectReady[seat]) return cloneState(state);
      const next = cloneState(state);
      next.connectReady[seat] = true;
      if (next.connectReady[0] && next.connectReady[1]) {
        return applyConnectReset(next);
      }
      return next;
    }

    if (action.type === "play") {
      const { handIndex, center } = action;
      if (!Number.isInteger(handIndex) || handIndex < 0 || handIndex >= state.hands[seat].length) {
        throw new Error("その場札はありません");
      }
      if (center !== 0 && center !== 1) throw new Error("中央の山の指定が不正です");
      const card = state.hands[seat][handIndex];
      const pile = state.centers[center];
      const top = pile[pile.length - 1];
      if (top !== undefined && !speedCanPlayOn(card, top)) {
        throw new Error("場の札と±1つながりの札しか出せません");
      }
      const next = cloneState(state);
      next.hands[seat].splice(handIndex, 1);
      next.centers[center].push(card);
      next.connectReady = [false, false];
      next.lastPlay = { seat, card, center };
      refillHand(next, seat);
      return checkWinner(next);
    }

    throw new Error("不明なアクションです");
  },

  viewFor(state: SpeedState, seat: number): SpeedView {
    const me = seat === 1 ? 1 : 0;
    const opp = me === 0 ? 1 : 0;
    const side = (s: number): SpeedSideView => ({
      seat: s,
      name: state.players[s]?.name ?? `プレイヤー${s + 1}`,
      hand: [...state.hands[s]],
      stockCount: state.stocks[s].length,
      total: totalOf(state, s),
      left: state.leftSeats.includes(s),
    });
    const plays = state.finished ? [] : speedLegalPlays(state, me);
    return {
      you: side(me),
      opponent: side(opp),
      centers: state.centers.map((pile) => ({
        top: pile.length > 0 ? pile[pile.length - 1] : null,
        count: pile.length,
      })),
      connectReady: [...state.connectReady],
      yourPlays: plays,
      youCanConnect: !state.finished && plays.length === 0,
      finished: state.finished,
      winner: state.winner,
      connectCount: state.connectCount,
      lastPlay: state.lastPlay ? { ...state.lastPlay } : null,
      players: state.players.map((p) => ({ seat: p.seat, name: p.name })),
    };
  },

  parseAction(raw: unknown): SpeedAction | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (r.type === "connect") return { type: "connect" };
    if (r.type !== "play") return null;
    if (
      typeof r.handIndex !== "number" ||
      !Number.isInteger(r.handIndex) ||
      r.handIndex < 0 ||
      r.handIndex > 15
    ) {
      return null;
    }
    if (r.center !== 0 && r.center !== 1) return null;
    return { type: "play", handIndex: r.handIndex, center: r.center };
  },

  phaseOf(state: SpeedState): string {
    return state.finished ? "finished" : "playing";
  },

  isFinished(state: SpeedState): boolean {
    return state.finished;
  },

  onPlayerLeft(state: SpeedState, seat: number): SpeedState {
    if (state.finished) return cloneState(state);
    const next = cloneState(state);
    if (!next.leftSeats.includes(seat)) next.leftSeats.push(seat);
    next.finished = true;
    next.winner = seat === 0 ? 1 : 0;
    return next;
  },
};
