// サイモン対戦（オンライン）のルールモジュール。
// 基盤契約: import は type のみ（テストが import を剥がして連結する）。
// 状態は JSON 化可能な値だけ。applyAction / tick / onPlayerLeft は純関数。
// 流れ: 全員で1つの色の並びを育てる。手番の人は showing（並びが順に光る、
// tick で進行し全員に公開）を見て、input で並びを最初から再現する。
// 再現できたら add で末尾に1色追加して次の人へ。間違えるか時間切れで脱落。
// 並びそのものは showing の間だけ（現在の1色ずつ）公開し、input / add 中は
// 手番の人にも再表示しない。最後まで残った1人が勝ち。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export type SbPhase = "showing" | "input" | "add" | "finished";

/** 色パッドの数（0=みどり, 1=あか, 2=きいろ, 3=あお）。 */
export const SB_PAD_COUNT = 4;
/** 再生で1色を表示する間隔（ms）。 */
export const SB_SHOW_INTERVAL_MS = 650;
/** input の制限時間の基礎（ms）。並びが長いほど少し延びる。 */
export const SB_INPUT_BASE_MS = 8000;
export const SB_INPUT_PER_STEP_MS = 1500;
/** add（末尾に1色追加する）の制限時間（ms）。 */
export const SB_ADD_LIMIT_MS = 10000;

export type SbEventKind = "clear" | "out";

export type SbEvent = {
  seat: number;
  kind: SbEventKind;
  /** clear のとき追加した色。それ以外は null。 */
  addedColor: number | null;
  /** out の理由。clear のときは null。 */
  reason: "wrong" | "timeout" | "left" | null;
};

export interface SimonBattleState {
  players: { seat: number; name: string }[];
  /** 脱落した seat（ミス・時間切れ・退出）。 */
  outSeats: number[];
  /** 退出した seat（outSeats にも含まれる）。 */
  leftSeats: number[];
  /** みんなで育てる色の並び（0〜3）。 */
  sequence: number[];
  turnSeat: number;
  phase: SbPhase;
  /** showing 中に光らせている index。 */
  showIndex: number;
  /** 次の色へ進む／input へ移る時刻（epoch ms）。showing 以外は null。 */
  showEndsAt: number | null;
  /** input で正しく押せた数。 */
  inputIndex: number;
  /** input の締切（epoch ms）。input 以外は null。 */
  inputEndsAt: number | null;
  /** add の締切（epoch ms）。add 以外は null。 */
  addEndsAt: number | null;
  lastEvent: SbEvent | null;
  winnerSeat: number | null;
}

export type SimonBattleAction = { type: "press"; color: number };

export interface SbViewPlayer {
  seat: number;
  name: string;
  out: boolean;
  left: boolean;
  isTurn: boolean;
}

export interface SimonBattleView {
  phase: SbPhase;
  sequenceLength: number;
  /** showing 中に光っている色。それ以外は null（並びは再表示しない）。 */
  flash: number | null;
  /** showing 中の進み具合（0 始まり）。 */
  flashIndex: number;
  turnSeat: number;
  /** input 中に手番の人が正しく押した数。 */
  inputProgress: number;
  showEndsAt: number | null;
  inputEndsAt: number | null;
  addEndsAt: number | null;
  lastEvent: SbEvent | null;
  winnerSeat: number | null;
  /** finished のときだけ並び全体を開示する。それ以外は null。 */
  sequence: number[] | null;
  you: { seat: number; out: boolean; left: boolean; isTurn: boolean };
  players: SbViewPlayer[];
}

// ---------------------------------------------------------------- utilities

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function playerOf(state: SimonBattleState, seat: number): { seat: number; name: string } | undefined {
  return state.players.find((p) => p.seat === seat);
}

function aliveSeats(state: SimonBattleState): number[] {
  return state.players.filter((p) => !state.outSeats.includes(p.seat)).map((p) => p.seat);
}

/** from の次に手番になる生存 seat（循環）。生存が from だけなら from 自身。 */
function nextAliveAfter(state: SimonBattleState, from: number): number {
  const seats = state.players.map((p) => p.seat);
  const start = seats.indexOf(from);
  for (let step = 1; step <= seats.length; step++) {
    const cand = seats[(start + step) % seats.length];
    if (!state.outSeats.includes(cand)) return cand;
  }
  return from;
}

function inputLimitMs(sequenceLength: number): number {
  return SB_INPUT_BASE_MS + sequenceLength * SB_INPUT_PER_STEP_MS;
}

/** showing を開始する（draft を破壊的に更新）。 */
function startShowing(draft: SimonBattleState, now: number): void {
  draft.phase = "showing";
  draft.showIndex = 0;
  draft.showEndsAt = now + SB_SHOW_INTERVAL_MS;
  draft.inputIndex = 0;
  draft.inputEndsAt = null;
  draft.addEndsAt = null;
}

/** 終了処理（draft を破壊的に更新）。 */
function finish(draft: SimonBattleState): void {
  const alive = aliveSeats(draft);
  draft.phase = "finished";
  draft.winnerSeat = alive.length === 1 ? alive[0] : null;
  draft.showEndsAt = null;
  draft.inputEndsAt = null;
  draft.addEndsAt = null;
}

/** seat を脱落させ、手番の解決まで進める（draft を破壊的に更新）。 */
function eliminate(draft: SimonBattleState, seat: number, reason: SbEvent["reason"], now: number): void {
  if (!draft.outSeats.includes(seat)) draft.outSeats.push(seat);
  draft.lastEvent = { seat, kind: "out", addedColor: null, reason };
  if (aliveSeats(draft).length <= 1) {
    finish(draft);
    return;
  }
  if (draft.turnSeat === seat) {
    draft.turnSeat = nextAliveAfter(draft, seat);
    startShowing(draft, now);
  }
}

// ---------------------------------------------------------------- module

function createState(players: SeatInfo[], rng: Rng, _options: Record<string, unknown>): SimonBattleState {
  if (!Array.isArray(players) || players.length < 2 || players.length > 6) {
    throw new Error("サイモン対戦は2〜6人で遊ぶゲームです");
  }
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const state: SimonBattleState = {
    players: sorted.map((p) => ({ seat: p.seat, name: p.name })),
    outSeats: [],
    leftSeats: [],
    sequence: [Math.floor(rng() * SB_PAD_COUNT)],
    turnSeat: sorted[0].seat,
    phase: "showing",
    showIndex: 0,
    showEndsAt: null,
    inputIndex: 0,
    inputEndsAt: null,
    addEndsAt: null,
    lastEvent: null,
    winnerSeat: null,
  };
  startShowing(state, Date.now());
  return state;
}

function applyAction(state: SimonBattleState, seat: number, action: SimonBattleAction, _rng: Rng): SimonBattleState {
  if (!action || typeof action !== "object" || (action as { type?: unknown }).type !== "press") {
    throw new Error("不明なアクションです");
  }
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished") throw new Error("ゲームは終了しています");
  if (state.phase === "showing") throw new Error("再生が終わるまで待ってください");
  if (state.outSeats.includes(seat)) throw new Error("脱落したプレイヤーは操作できません");
  if (seat !== state.turnSeat) throw new Error("あなたの手番ではありません");
  const color = (action as { color?: unknown }).color;
  if (typeof color !== "number" || !Number.isInteger(color) || color < 0 || color >= SB_PAD_COUNT) {
    throw new Error("色が不正です");
  }
  const now = Date.now();

  if (state.phase === "input") {
    if (state.inputEndsAt !== null && now > state.inputEndsAt) {
      throw new Error("制限時間を過ぎています");
    }
    const draft = clone(state);
    if (color !== draft.sequence[draft.inputIndex]) {
      eliminate(draft, seat, "wrong", now);
      return draft;
    }
    draft.inputIndex += 1;
    if (draft.inputIndex >= draft.sequence.length) {
      // 並びを全部再現できたので、末尾に1色追加するフェーズへ。
      draft.phase = "add";
      draft.inputEndsAt = null;
      draft.addEndsAt = now + SB_ADD_LIMIT_MS;
    }
    return draft;
  }

  // add フェーズ: 末尾に1色追加して次の人へ。
  if (state.addEndsAt !== null && now > state.addEndsAt) {
    throw new Error("制限時間を過ぎています");
  }
  const draft = clone(state);
  draft.sequence.push(color);
  draft.lastEvent = { seat, kind: "clear", addedColor: color, reason: null };
  draft.turnSeat = nextAliveAfter(draft, seat);
  startShowing(draft, now);
  return draft;
}

function viewFor(state: SimonBattleState, seat: number): SimonBattleView {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  const finished = state.phase === "finished";
  return {
    phase: state.phase,
    sequenceLength: state.sequence.length,
    flash: state.phase === "showing" ? state.sequence[state.showIndex] ?? null : null,
    flashIndex: state.phase === "showing" ? state.showIndex : 0,
    turnSeat: state.turnSeat,
    inputProgress: state.phase === "input" ? state.inputIndex : 0,
    showEndsAt: state.showEndsAt,
    inputEndsAt: state.inputEndsAt,
    addEndsAt: state.addEndsAt,
    lastEvent: state.lastEvent,
    winnerSeat: finished ? state.winnerSeat : null,
    sequence: finished ? [...state.sequence] : null,
    you: {
      seat,
      out: state.outSeats.includes(seat),
      left: state.leftSeats.includes(seat),
      isTurn: !finished && state.turnSeat === seat,
    },
    players: state.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      out: state.outSeats.includes(p.seat),
      left: state.leftSeats.includes(p.seat),
      isTurn: !finished && state.turnSeat === p.seat,
    })),
  };
}

function parseAction(raw: unknown): SimonBattleAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.type !== "press") return null;
  if (typeof rec.color !== "number" || !Number.isInteger(rec.color) || rec.color < 0 || rec.color >= SB_PAD_COUNT) {
    return null;
  }
  return { type: "press", color: rec.color };
}

function onPlayerLeft(state: SimonBattleState, seat: number): SimonBattleState {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished" || state.outSeats.includes(seat)) return state;
  const draft = clone(state);
  if (!draft.leftSeats.includes(seat)) draft.leftSeats.push(seat);
  eliminate(draft, seat, "left", Date.now());
  return draft;
}

function tick(state: SimonBattleState, now: number): SimonBattleState {
  if (state.phase === "showing" && state.showEndsAt !== null && now >= state.showEndsAt) {
    const draft = clone(state);
    if (draft.showIndex + 1 >= draft.sequence.length) {
      // 最後の色まで光らせたので input へ。
      draft.phase = "input";
      draft.showEndsAt = null;
      draft.inputIndex = 0;
      draft.inputEndsAt = now + inputLimitMs(draft.sequence.length);
    } else {
      draft.showIndex += 1;
      draft.showEndsAt = now + SB_SHOW_INTERVAL_MS;
    }
    return draft;
  }
  if (state.phase === "input" && state.inputEndsAt !== null && now >= state.inputEndsAt) {
    const draft = clone(state);
    eliminate(draft, draft.turnSeat, "timeout", now);
    return draft;
  }
  if (state.phase === "add" && state.addEndsAt !== null && now >= state.addEndsAt) {
    const draft = clone(state);
    eliminate(draft, draft.turnSeat, "timeout", now);
    return draft;
  }
  return state;
}

export const gameModule: OnlineGameModule<SimonBattleState, SimonBattleAction, SimonBattleView> = {
  id: "simonbattle",
  title: "サイモン対戦",
  minPlayers: 2,
  maxPlayers: 6,
  cpuSupported: false,
  chatEnabled: true,
  createState,
  applyAction,
  viewFor,
  parseAction,
  phaseOf: (state: SimonBattleState) => state.phase,
  isFinished: (state: SimonBattleState) => state.phase === "finished",
  onPlayerLeft,
  tick,
};
