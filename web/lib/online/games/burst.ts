// バースト（オンライン対戦）のルールモジュール。6ニムト系の同時出しカードゲーム。
// 基盤契約: import は type のみ（テストが import を剥がして連結する）。
// 状態は JSON 化可能な値だけ。applyAction / tick / onPlayerLeft は純関数。
// ルール:
// - カードは 1〜104。各カードにバースト値（ペナルティ）がある:
//   55→7点、11の倍数→5点、10の倍数→3点、5の倍数→2点、その他→1点。
// - 全員に10枚配り、場に4つの列（各1枚）を作る。手札は本人のみ見える。
// - 各ラウンド、全員が同時に手札から1枚を伏せて出す（制限30秒、
//   時間切れの未提出者は一番小さい手札が自動で出る）。
// - 開示後、出たカードを小さい順に処理する。各カードは「末尾の数字が
//   自分より小さい列の中で、末尾が最も大きい列」の末尾に置かれる。
// - 置くと列が6枚目になるときは、その列の5枚を全部引き取って
//   （バースト値の合計がペナルティになる）自分のカードを列の先頭にする。
// - どの列の末尾よりも小さいカードを出した人は、自分で列を1つ選んで
//   その列を全部引き取り、自分のカードを置く（処理はここで一時停止し、
//   本人の選択を待つ。制限30秒で、時間切れならペナルティ最小の列を自動選択）。
// - 全10ラウンド（手札を使い切るまで）。ペナルティ最少の人が勝ち、同点は同順位。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export const BU_ROW_COUNT = 4;
export const BU_HAND_SIZE = 10;
export const BU_MAX_IN_ROW = 5;
export const BU_SELECT_LIMIT_MS = 30000;
export const BU_CHOOSE_LIMIT_MS = 30000;

/** カードのバースト値（ペナルティ）。 */
export function burstValue(card: number): number {
  if (!Number.isInteger(card) || card < 1 || card > 104) return 0;
  if (card === 55) return 7;
  if (card % 11 === 0) return 5;
  if (card % 10 === 0) return 3;
  if (card % 5 === 0) return 2;
  return 1;
}

/** 列のカード列のペナルティ合計。 */
export function burstRowPenalty(row: number[]): number {
  return row.reduce((sum, c) => sum + burstValue(c), 0);
}

export type BurstPhase = "selecting" | "choosing" | "finished";

export type BurstPlay = { seat: number; card: number };

export type BurstResolutionStep = {
  seat: number;
  card: number;
  /** 置かれた列。 */
  row: number;
  /** 引き取ったカード（なければ空）。 */
  took: number[];
  tookPenalty: number;
  /** 列を選んで引き取った（強制引き取り）かどうか。 */
  forced: boolean;
};

export type BurstHistoryEntry = {
  round: number;
  /** 小さい順に処理した結果。 */
  steps: BurstResolutionStep[];
};

export interface BurstState {
  players: { seat: number; name: string }[];
  leftSeats: number[];
  round: number;
  totalRounds: number;
  phase: BurstPhase;
  roundEndsAt: number | null;
  hands: Record<number, number[]>;
  /** 場の4列（公開情報）。 */
  rows: number[][];
  penalties: Record<number, number>;
  takenCounts: Record<number, number>;
  /** 現在ラウンドの提出（内部のみ。締切まで viewFor で秘匿）。 */
  plays: BurstPlay[];
  /** 処理待ちのキュー（小さい順）。解決中だけ使う内部情報。 */
  queue: BurstPlay[];
  /** 列の選択待ちの人と、その人のカード。 */
  pending: { seat: number; card: number } | null;
  chooseEndsAt: number | null;
  history: BurstHistoryEntry[];
  /** 現在ラウンドの処理結果（choosing / 次ラウンド開始まで保持）。 */
  currentSteps: BurstResolutionStep[];
}

export type BurstAction = { type: "play"; card: number } | { type: "takeRow"; row: number };

export interface BurstViewPlayer {
  seat: number;
  name: string;
  penalty: number;
  takenCount: number;
  handCount: number;
  left: boolean;
  submitted: boolean;
}

export interface BurstView {
  phase: BurstPhase;
  round: number;
  totalRounds: number;
  roundEndsAt: number | null;
  chooseEndsAt: number | null;
  rows: { cards: number[]; last: number | null; count: number; penalty: number }[];
  you: {
    seat: number;
    hand: number[];
    submitted: boolean;
    yourCard: number | null;
    left: boolean;
    choosing: boolean;
    pendingCard: number | null;
  };
  players: BurstViewPlayer[];
  history: BurstHistoryEntry[];
  lastSteps: BurstResolutionStep[];
  standings: { seat: number; penalty: number; rank: number }[] | null;
}

// ---------------------------------------------------------------- utilities

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function playerOf(state: BurstState, seat: number): { seat: number; name: string } | undefined {
  return state.players.find((p) => p.seat === seat);
}

function activeSeats(state: BurstState): number[] {
  return state.players.filter((p) => !state.leftSeats.includes(p.seat)).map((p) => p.seat);
}

/**
 * カードを置くべき列を返す純関数。
 * 「末尾が自分より小さい列の中で末尾が最大の列」の添字。無い場合は -1。
 */
export function burstTargetRow(rows: number[][], card: number): number {
  let best = -1;
  let bestLast = -Infinity;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.length === 0) continue;
    const last = row[row.length - 1];
    if (last < card && last > bestLast) {
      bestLast = last;
      best = i;
    }
  }
  return best;
}

/** 強制引き取りの自動選択: ペナルティ最小（同点なら枚数少→末尾小）の列。 */
export function burstAutoRow(rows: number[][]): number {
  let best = 0;
  for (let i = 1; i < rows.length; i++) {
    const p = burstRowPenalty(rows[i]);
    const bp = burstRowPenalty(rows[best]);
    if (
      p < bp ||
      (p === bp && rows[i].length < rows[best].length) ||
      (p === bp &&
        rows[i].length === rows[best].length &&
        (rows[i][rows[i].length - 1] ?? 0) < (rows[best][rows[best].length - 1] ?? 0))
    ) {
      best = i;
    }
  }
  return best;
}

/** 指定の列を引き取って pending カードを置く（draft を破壊的に更新）。 */
function takeRowAndPlace(draft: BurstState, seat: number, card: number, rowIdx: number, forced: boolean): void {
  const row = draft.rows[rowIdx];
  const took = [...row];
  const penalty = burstRowPenalty(took);
  draft.penalties[seat] = (draft.penalties[seat] ?? 0) + penalty;
  draft.takenCounts[seat] = (draft.takenCounts[seat] ?? 0) + took.length;
  draft.rows[rowIdx] = [card];
  draft.currentSteps.push({ seat, card, row: rowIdx, took, tookPenalty: penalty, forced });
}

/** 次の処理対象を進める（draft を破壊的に更新）。止まる条件は finishResolve を参照。 */
function processQueue(draft: BurstState, now: number): void {
  while (draft.queue.length > 0) {
    const play = draft.queue[0];
    // 退出済みの人のカードは処理せず捨てる。
    if (draft.leftSeats.includes(play.seat)) {
      draft.queue.shift();
      continue;
    }
    const target = burstTargetRow(draft.rows, play.card);
    if (target === -1) {
      // 列の選択が必要。ここで停止して本人の入力を待つ。
      draft.queue.shift();
      draft.pending = { seat: play.seat, card: play.card };
      draft.phase = "choosing";
      draft.chooseEndsAt = now + BU_CHOOSE_LIMIT_MS;
      return;
    }
    draft.queue.shift();
    if (draft.rows[target].length >= BU_MAX_IN_ROW) {
      takeRowAndPlace(draft, play.seat, play.card, target, false);
    } else {
      draft.rows[target] = [...draft.rows[target], play.card];
      draft.currentSteps.push({ seat: play.seat, card: play.card, row: target, took: [], tookPenalty: 0, forced: false });
    }
  }
  finishResolve(draft, now);
}

/** 1ラウンドの処理を終え、次ラウンドへ進めるか終了する（draft を破壊的に更新）。 */
function finishResolve(draft: BurstState, now: number): void {
  draft.pending = null;
  draft.chooseEndsAt = null;
  draft.history.push({ round: draft.round, steps: draft.currentSteps });
  draft.currentSteps = [];
  draft.plays = [];
  draft.round += 1;
  if (draft.round >= draft.totalRounds || activeSeats(draft).length < 2) {
    draft.phase = "finished";
    draft.roundEndsAt = null;
    return;
  }
  draft.phase = "selecting";
  draft.roundEndsAt = now + BU_SELECT_LIMIT_MS;
}

/** 提出を締め切り、開示して処理キューを回す（draft を破壊的に更新）。 */
function closeRound(draft: BurstState, now: number): void {
  // 未提出の生存者は一番小さい手札を自動提出する。
  for (const seat of activeSeats(draft)) {
    if (!draft.plays.some((p) => p.seat === seat)) {
      const hand = draft.hands[seat] ?? [];
      if (hand.length > 0) {
        draft.plays.push({ seat, card: hand[0] });
      }
    }
  }
  // 手札から提出カードを取り除く。
  for (const p of draft.plays) {
    const hand = draft.hands[p.seat];
    if (hand) draft.hands[p.seat] = hand.filter((c) => c !== p.card);
  }
  draft.queue = [...draft.plays].sort((a, b) => a.card - b.card);
  draft.roundEndsAt = null;
  draft.phase = "selecting"; // processQueue が必要に応じて choosing へ変える
  processQueue(draft, now);
}

/** 全員（脱落を除く）が提出済みなら即締切する。 */
function closeIfAllPlayed(draft: BurstState, now: number): void {
  if (draft.phase !== "selecting" || draft.queue.length > 0 || draft.pending) return;
  const active = activeSeats(draft);
  if (active.length === 0) return;
  if (active.every((s) => draft.plays.some((p) => p.seat === s))) closeRound(draft, now);
}

// ---------------------------------------------------------------- module

function createState(players: SeatInfo[], rng: Rng, _options: Record<string, unknown>): BurstState {
  if (!Array.isArray(players) || players.length < 2 || players.length > 8) {
    throw new Error("バーストは2〜8人で遊ぶゲームです");
  }
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const deck = Array.from({ length: 104 }, (_, i) => i + 1);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const hands: Record<number, number[]> = {};
  const penalties: Record<number, number> = {};
  const takenCounts: Record<number, number> = {};
  for (const p of sorted) {
    hands[p.seat] = deck.splice(0, BU_HAND_SIZE).sort((a, b) => a - b);
    penalties[p.seat] = 0;
    takenCounts[p.seat] = 0;
  }
  const rows: number[][] = [];
  for (let i = 0; i < BU_ROW_COUNT; i++) rows.push([deck.splice(0, 1)[0]]);
  return {
    players: sorted.map((p) => ({ seat: p.seat, name: p.name })),
    leftSeats: [],
    round: 0,
    totalRounds: BU_HAND_SIZE,
    phase: "selecting",
    roundEndsAt: Date.now() + BU_SELECT_LIMIT_MS,
    hands,
    rows,
    penalties,
    takenCounts,
    plays: [],
    queue: [],
    pending: null,
    chooseEndsAt: null,
    history: [],
    currentSteps: [],
  };
}

function applyAction(state: BurstState, seat: number, action: BurstAction, _rng: Rng): BurstState {
  if (!action || typeof action !== "object") throw new Error("不明なアクションです");
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished") throw new Error("ゲームは終了しています");
  if (state.leftSeats.includes(seat)) throw new Error("退出したプレイヤーは操作できません");
  const type = (action as { type?: unknown }).type;

  if (type === "play") {
    if (state.phase !== "selecting" || state.pending) throw new Error("今はカードを出せません");
    const card = (action as { card?: unknown }).card;
    if (!Number.isInteger(card)) throw new Error("カードが不正です");
    if (!(state.hands[seat] ?? []).includes(card as number)) throw new Error("そのカードは手札にありません");
    if (state.plays.some((p) => p.seat === seat)) throw new Error("すでに出しています");
    const now = Date.now();
    if (state.roundEndsAt !== null && now > state.roundEndsAt) throw new Error("制限時間を過ぎています");
    const draft = clone(state);
    draft.plays.push({ seat, card: card as number });
    closeIfAllPlayed(draft, now);
    return draft;
  }

  if (type === "takeRow") {
    if (state.phase !== "choosing" || !state.pending) throw new Error("今は列を選べません");
    if (state.pending.seat !== seat) throw new Error("列を選ぶのはあなたの番ではありません");
    const row = (action as { row?: unknown }).row;
    if (!Number.isInteger(row) || (row as number) < 0 || (row as number) >= BU_ROW_COUNT) {
      throw new Error("列が不正です");
    }
    const now = Date.now();
    const draft = clone(state);
    const pending = draft.pending as { seat: number; card: number };
    draft.pending = null;
    draft.chooseEndsAt = null;
    draft.phase = "selecting";
    takeRowAndPlace(draft, pending.seat, pending.card, row as number, true);
    processQueue(draft, now);
    return draft;
  }

  throw new Error("不明なアクションです");
}

function viewFor(state: BurstState, seat: number): BurstView {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  const finished = state.phase === "finished";
  const myPlay = state.plays.find((p) => p.seat === seat);

  let standings: BurstView["standings"] = null;
  if (finished) {
    const sorted = [...state.players].sort((a, b) => (state.penalties[a.seat] ?? 0) - (state.penalties[b.seat] ?? 0));
    standings = sorted.map((p) => ({
      seat: p.seat,
      penalty: state.penalties[p.seat] ?? 0,
      rank: 1 + sorted.filter((o) => (state.penalties[o.seat] ?? 0) < (state.penalties[p.seat] ?? 0)).length,
    }));
  }
  const lastHistory = state.history[state.history.length - 1];

  return {
    phase: state.phase,
    round: Math.min(state.round, state.totalRounds - 1),
    totalRounds: state.totalRounds,
    roundEndsAt: state.roundEndsAt,
    chooseEndsAt: state.chooseEndsAt,
    rows: state.rows.map((row) => ({
      cards: [...row],
      last: row.length > 0 ? row[row.length - 1] : null,
      count: row.length,
      penalty: burstRowPenalty(row),
    })),
    you: {
      seat,
      hand: [...(state.hands[seat] ?? [])],
      submitted: Boolean(myPlay) || state.queue.some((p) => p.seat === seat) || state.pending?.seat === seat,
      yourCard: myPlay ? myPlay.card : null,
      left: state.leftSeats.includes(seat),
      choosing: state.pending?.seat === seat,
      pendingCard: state.pending?.seat === seat ? state.pending.card : null,
    },
    players: state.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      penalty: state.penalties[p.seat] ?? 0,
      takenCount: state.takenCounts[p.seat] ?? 0,
      handCount: (state.hands[p.seat] ?? []).length,
      left: state.leftSeats.includes(p.seat),
      submitted: state.plays.some((pl) => pl.seat === p.seat),
    })),
    history: state.history,
    lastSteps: state.currentSteps.length > 0 ? state.currentSteps : (lastHistory?.steps ?? []),
    standings,
  };
}

function parseAction(raw: unknown): BurstAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.type === "play") {
    if (!Number.isInteger(rec.card) || (rec.card as number) < 1 || (rec.card as number) > 104) return null;
    return { type: "play", card: rec.card as number };
  }
  if (rec.type === "takeRow") {
    if (!Number.isInteger(rec.row) || (rec.row as number) < 0 || (rec.row as number) >= BU_ROW_COUNT) return null;
    return { type: "takeRow", row: rec.row as number };
  }
  return null;
}

function onPlayerLeft(state: BurstState, seat: number): BurstState {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished" || state.leftSeats.includes(seat)) return state;
  const draft = clone(state);
  draft.leftSeats.push(seat);
  draft.plays = draft.plays.filter((p) => p.seat !== seat);
  draft.queue = draft.queue.filter((p) => p.seat !== seat);
  const now = Date.now();
  if (activeSeats(draft).length < 2) {
    draft.phase = "finished";
    draft.pending = null;
    draft.roundEndsAt = null;
    draft.chooseEndsAt = null;
    return draft;
  }
  // 選択待ち本人が退出したら自動選択で処理を続ける。
  if (draft.pending && draft.pending.seat === seat) {
    const pending = draft.pending;
    draft.pending = null;
    draft.chooseEndsAt = null;
    draft.phase = "selecting";
    takeRowAndPlace(draft, pending.seat, pending.card, burstAutoRow(draft.rows), true);
    processQueue(draft, now);
    return draft;
  }
  if (draft.phase === "selecting" && draft.queue.length === 0 && !draft.pending) {
    closeIfAllPlayed(draft, now);
  }
  return draft;
}

function tick(state: BurstState, now: number): BurstState {
  if (state.phase === "selecting" && !state.pending && state.queue.length === 0 && state.roundEndsAt !== null && now >= state.roundEndsAt) {
    const draft = clone(state);
    closeRound(draft, now);
    return draft;
  }
  if (state.phase === "choosing" && state.pending && state.chooseEndsAt !== null && now >= state.chooseEndsAt) {
    const draft = clone(state);
    const pending = draft.pending as { seat: number; card: number };
    draft.pending = null;
    draft.chooseEndsAt = null;
    draft.phase = "selecting";
    takeRowAndPlace(draft, pending.seat, pending.card, burstAutoRow(draft.rows), true);
    processQueue(draft, now);
    return draft;
  }
  return state;
}

export const gameModule: OnlineGameModule<BurstState, BurstAction, BurstView> = {
  id: "burst",
  title: "バースト",
  minPlayers: 2,
  maxPlayers: 8,
  cpuSupported: false,
  chatEnabled: true,
  createState,
  applyAction,
  viewFor,
  parseAction,
  phaseOf: (state: BurstState) => state.phase,
  isFinished: (state: BurstState) => state.phase === "finished",
  onPlayerLeft,
  tick,
};
