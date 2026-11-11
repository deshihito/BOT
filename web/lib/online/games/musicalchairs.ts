// 椅子取り（オンライン対戦）のルールモジュール。3〜8人・ラウンド制。
// 基盤契約: import は type のみ（テストが import を剥がして連結する）。
// 状態は JSON 化可能な値だけ。applyAction / tick / onPlayerLeft は純関数。
// ルール:
// - 生存者 n 人に対して椅子は n-1 個。各ラウンド、音楽がランダムな長さ
//   （3〜9秒）流れて止まる。止まった瞬間から全員が「座る」アクションを競う。
// - 一番遅かった1人が脱落する。締切（停止から5秒）までに座れなかった人は
//   全員「最遅」扱いで、座った人より必ず後れになる。座れなかった人が複数
//   いる場合は seat 番号が大きい人が脱落する（同着の規則）。
// - 反応の速さはサーバーがアクションを受け取った順序で決まる。基盤の
//   ポーリング/SSE 間隔や通信遅延の影響を受けるため、ミリ秒単位の厳密な
//   同時判定はしない（受信順 = 順位、という規則を明示する）。
// - 退出した人はその時点で脱落扱い。生存者が1人になったら優勝で終了。
// - 音楽が止まる時刻（stopAt）は内部情報で、ビューには含めない。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export const MC_REACT_LIMIT_MS = 5000;
export const MC_INTERMISSION_MS = 4000;
export const MC_MUSIC_MIN_MS = 3000;
export const MC_MUSIC_MAX_MS = 9000;

export type McPhase = "playing" | "racing" | "intermission" | "finished";

export interface McSit {
  seat: number;
  /** 受信順（0 が最速）。 */
  order: number;
}

export interface McRoundResult {
  round: number;
  /** 座れた順（速い順）。 */
  sits: McSit[];
  /** 締切までに座れなかった seat。 */
  notSat: number[];
  eliminatedSeat: number;
  /** slowest=一番遅く座った / nosit=座れなかった / left=退出で脱落。 */
  reason: "slowest" | "nosit";
}

export interface McState {
  players: { seat: number; name: string }[];
  leftSeats: number[];
  /** 脱落した seat（脱落順。退出による脱落も含む）。 */
  eliminatedSeats: number[];
  round: number;
  phase: McPhase;
  /** 音楽の長さを決める内部 RNG 状態（ビューに含めない）。 */
  rngState: number;
  roundStartedAt: number;
  /** 音楽が止まる時刻（内部のみ。ビューに含めない）。 */
  stopAt: number;
  stoppedAt: number | null;
  reactEndsAt: number | null;
  sits: McSit[];
  intermissionEndsAt: number | null;
  lastResult: McRoundResult | null;
  winnerSeat: number | null;
}

export type McAction = { type: "sit" };

export interface McViewPlayer {
  seat: number;
  name: string;
  alive: boolean;
  left: boolean;
  /** このラウンドで座れたか。 */
  sat: boolean;
}

export interface McView {
  phase: McPhase;
  round: number;
  /** 残り人数。椅子は aliveCount - 1。 */
  aliveCount: number;
  chairs: number;
  reactEndsAt: number | null;
  intermissionEndsAt: number | null;
  lastResult: McRoundResult | null;
  winnerSeat: number | null;
  you: { seat: number; alive: boolean; left: boolean; sat: boolean };
  players: McViewPlayer[];
  standings: { seat: number; rank: number }[] | null;
}

// ---------------------------------------------------------------- utilities

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** mulberry32。状態を数値で持ち回る。 */
function nextRandom(rngState: number): { value: number; rngState: number } {
  let t = (rngState + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rngState: t | 0 };
}

function playerOf(state: McState, seat: number): { seat: number; name: string } | undefined {
  return state.players.find((p) => p.seat === seat);
}

function aliveSeats(state: McState): number[] {
  return state.players
    .filter((p) => !state.leftSeats.includes(p.seat) && !state.eliminatedSeats.includes(p.seat))
    .map((p) => p.seat);
}

/** ラウンドを開始する（draft を破壊的に更新）。音楽の長さは内部 RNG で決める。 */
function startRound(draft: McState, now: number): void {
  const r = nextRandom(draft.rngState);
  draft.rngState = r.rngState;
  const duration = MC_MUSIC_MIN_MS + Math.floor(r.value * (MC_MUSIC_MAX_MS - MC_MUSIC_MIN_MS));
  draft.phase = "playing";
  draft.roundStartedAt = now;
  draft.stopAt = now + duration;
  draft.stoppedAt = null;
  draft.reactEndsAt = null;
  draft.sits = [];
  draft.intermissionEndsAt = null;
}

/** ラウンドを締め切り、一番遅かった1人を脱落させる（draft を破壊的に更新）。 */
function resolveRound(draft: McState, now: number): void {
  const alive = aliveSeats(draft);
  const satSeats = new Set(draft.sits.map((s) => s.seat));
  const notSat = alive.filter((s) => !satSeats.has(s));
  let eliminatedSeat: number;
  let reason: McRoundResult["reason"];
  if (notSat.length > 0) {
    // 座れなかった人が最遅。同着なら seat 番号が大きい人が脱落。
    eliminatedSeat = Math.max(...notSat);
    reason = "nosit";
  } else {
    const slowest = draft.sits.reduce((a, b) => (b.order > a.order ? b : a));
    eliminatedSeat = slowest.seat;
    reason = "slowest";
  }
  draft.eliminatedSeats = [...draft.eliminatedSeats, eliminatedSeat];
  draft.lastResult = {
    round: draft.round,
    sits: [...draft.sits].sort((a, b) => a.order - b.order),
    notSat,
    eliminatedSeat,
    reason,
  };
  draft.reactEndsAt = null;
  const remaining = aliveSeats(draft);
  if (remaining.length <= 1) {
    draft.phase = "finished";
    draft.winnerSeat = remaining.length === 1 ? remaining[0] : null;
    draft.intermissionEndsAt = null;
    return;
  }
  draft.phase = "intermission";
  draft.intermissionEndsAt = now + MC_INTERMISSION_MS;
}

/** 生存者が1人以下になったら終了させる。true なら終了した。 */
function finishIfOneLeft(draft: McState): boolean {
  const remaining = aliveSeats(draft);
  if (remaining.length > 1) return false;
  draft.phase = "finished";
  draft.winnerSeat = remaining.length === 1 ? remaining[0] : null;
  draft.reactEndsAt = null;
  draft.intermissionEndsAt = null;
  return true;
}

// ---------------------------------------------------------------- module

function createState(players: SeatInfo[], rng: Rng, _options: Record<string, unknown>): McState {
  if (!Array.isArray(players) || players.length < 3 || players.length > 8) {
    throw new Error("椅子取りは3〜8人で遊ぶゲームです");
  }
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const state: McState = {
    players: sorted.map((p) => ({ seat: p.seat, name: p.name })),
    leftSeats: [],
    eliminatedSeats: [],
    round: 0,
    phase: "playing",
    rngState: Math.floor(rng() * 0x7fffffff) | 0,
    roundStartedAt: 0,
    stopAt: 0,
    stoppedAt: null,
    reactEndsAt: null,
    sits: [],
    intermissionEndsAt: null,
    lastResult: null,
    winnerSeat: null,
  };
  startRound(state, Date.now());
  return state;
}

function applyAction(state: McState, seat: number, action: McAction, _rng: Rng): McState {
  if (!action || typeof action !== "object") throw new Error("不明なアクションです");
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished") throw new Error("ゲームは終了しています");
  if (state.leftSeats.includes(seat)) throw new Error("退出したプレイヤーは操作できません");
  if (state.eliminatedSeats.includes(seat)) throw new Error("脱落したプレイヤーは操作できません");
  if ((action as { type?: unknown }).type !== "sit") throw new Error("不明なアクションです");
  if (state.phase !== "racing") throw new Error("音楽が止まるまで座れません");
  if (state.sits.some((s) => s.seat === seat)) throw new Error("すでに座っています");
  const now = Date.now();
  if (state.reactEndsAt !== null && now > state.reactEndsAt) throw new Error("制限時間を過ぎています");
  const draft = clone(state);
  draft.sits.push({ seat, order: draft.sits.length });
  // 全員座ったら即締め切る。
  if (aliveSeats(draft).every((s) => draft.sits.some((x) => x.seat === s))) {
    resolveRound(draft, now);
  }
  return draft;
}

function viewFor(state: McState, seat: number): McView {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  const alive = aliveSeats(state);
  const finished = state.phase === "finished";
  let standings: McView["standings"] = null;
  if (finished) {
    // 勝者が1位、脱落が新しい順に2位、3位…。
    const elimDesc = [...state.eliminatedSeats].reverse();
    standings = state.players.map((p) => ({
      seat: p.seat,
      rank:
        p.seat === state.winnerSeat
          ? 1
          : 2 + Math.max(0, elimDesc.indexOf(p.seat)),
    }));
  }
  return {
    phase: state.phase,
    round: state.round,
    aliveCount: alive.length,
    chairs: Math.max(0, alive.length - 1),
    reactEndsAt: state.phase === "racing" ? state.reactEndsAt : null,
    intermissionEndsAt: state.phase === "intermission" ? state.intermissionEndsAt : null,
    lastResult: state.lastResult,
    winnerSeat: state.winnerSeat,
    you: {
      seat,
      alive: alive.includes(seat),
      left: state.leftSeats.includes(seat),
      sat: state.sits.some((s) => s.seat === seat),
    },
    players: state.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      alive: alive.includes(p.seat),
      left: state.leftSeats.includes(p.seat),
      sat: state.sits.some((s) => s.seat === p.seat),
    })),
    standings,
  };
}

function parseAction(raw: unknown): McAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.type === "sit") return { type: "sit" };
  return null;
}

function onPlayerLeft(state: McState, seat: number): McState {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished" || state.leftSeats.includes(seat)) return state;
  const draft = clone(state);
  draft.leftSeats.push(seat);
  // 退出はその時点で脱落扱い（このラウンドの座席争いからも外れる）。
  if (!draft.eliminatedSeats.includes(seat)) draft.eliminatedSeats.push(seat);
  draft.sits = draft.sits.filter((s) => s.seat !== seat);
  if (finishIfOneLeft(draft)) return draft;
  // レース中に残り全員が座り終えていたら締め切る。
  if (
    draft.phase === "racing" &&
    aliveSeats(draft).length > 0 &&
    aliveSeats(draft).every((s) => draft.sits.some((x) => x.seat === s))
  ) {
    resolveRound(draft, Date.now());
  }
  return draft;
}

function tick(state: McState, now: number): McState {
  if (state.phase === "playing" && now >= state.stopAt) {
    const draft = clone(state);
    draft.phase = "racing";
    draft.stoppedAt = draft.stopAt;
    draft.reactEndsAt = draft.stopAt + MC_REACT_LIMIT_MS;
    return draft;
  }
  if (state.phase === "racing" && state.reactEndsAt !== null && now >= state.reactEndsAt) {
    const draft = clone(state);
    resolveRound(draft, now);
    return draft;
  }
  if (state.phase === "intermission" && state.intermissionEndsAt !== null && now >= state.intermissionEndsAt) {
    const draft = clone(state);
    draft.round += 1;
    startRound(draft, now);
    return draft;
  }
  return state;
}

export const gameModule: OnlineGameModule<McState, McAction, McView> = {
  id: "musicalchairs",
  title: "椅子取り",
  minPlayers: 3,
  maxPlayers: 8,
  cpuSupported: false,
  chatEnabled: true,
  createState,
  applyAction,
  viewFor,
  parseAction,
  phaseOf: (state: McState) => state.phase,
  isFinished: (state: McState) => state.phase === "finished",
  onPlayerLeft,
  tick,
};
