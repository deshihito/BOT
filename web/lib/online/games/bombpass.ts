// 爆弾パス（2〜8人）のルールモジュール。モジュール契約は lib/online/types.ts。
// 実行時 import は禁止（テストが import を剥がして連結するため type のみ）。
//
// ルール:
// - 爆弾を持っている人だけが、生存している任意の相手を選んでパスできる。
// - 爆発までの時間は15〜40秒のランダム（内部のシード付き乱数で決定的）。
//   残り時間は全員に一切表示しない（ビューにも含めない）。
// - 爆発した瞬間に持っていた人が1失点。3失点で脱落。
// - 最後の1人が勝ち。退出は脱落扱いで、保持者が抜けたら爆弾は次の生存者へ移る。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export const BOMB_MIN_MS = 15000;
export const BOMB_MAX_MS = 40000;
export const BOMB_LOSE_POINTS = 3;

export type BombEvent =
  | { kind: "pass"; from: number; to: number }
  | { kind: "explode"; seat: number }
  | { kind: "eliminate"; seat: number }
  | { kind: "left"; seat: number };

export interface BombPassState {
  players: SeatInfo[];
  /** 現在の爆弾保持者。 */
  holder: number;
  /** seat → 失点数。 */
  losses: Record<number, number>;
  /** 3失点で脱落した seat。 */
  eliminated: number[];
  /** 退出した seat（脱落扱い）。 */
  leftSeats: number[];
  /** 内部のみ。爆発時刻（epoch ms）。ビューには絶対に含めない。 */
  explodeAt: number;
  /** 内部のみ。爆発間隔を決める乱数状態（mulberry32）。ビューには含めない。 */
  rngState: number;
  round: number;
  finished: boolean;
  winner: number | null;
  lastEvent: BombEvent | null;
}

export type BombPassAction = { type: "pass"; target: number };

export interface BombPlayerView {
  seat: number;
  name: string;
  losses: number;
  alive: boolean;
  left: boolean;
  isHolder: boolean;
}

export interface BombPassView {
  phase: "playing" | "finished";
  holder: number;
  round: number;
  you: { seat: number; alive: boolean; left: boolean; isHolder: boolean };
  players: BombPlayerView[];
  finished: boolean;
  winner: number | null;
  lastEvent: BombEvent | null;
  playersInfo: SeatInfo[];
}

function bombClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** mulberry32。tick には rng が渡らないため、乱数状態を state 内に持つ。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function isAlive(state: BombPassState, seat: number): boolean {
  return !state.eliminated.includes(seat) && !state.leftSeats.includes(seat);
}

function aliveSeats(state: BombPassState): number[] {
  const out: number[] = [];
  for (let s = 0; s < state.players.length; s++) {
    if (isAlive(state, s)) out.push(s);
  }
  return out;
}

/** seat の次に生存している seat（循環）。生存が seat だけなら seat 自身。 */
function nextAlive(state: BombPassState, seat: number): number {
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const s = (seat + step) % n;
    if (isAlive(state, s)) return s;
  }
  return seat;
}

/** 次の爆発時刻を乱数から決める（draft を破壊的に更新）。 */
function armBomb(draft: BombPassState, now: number): void {
  const r = nextRandom(draft.rngState);
  draft.rngState = r.rng;
  const span = BOMB_MAX_MS - BOMB_MIN_MS;
  draft.explodeAt = now + BOMB_MIN_MS + Math.floor(r.value * (span + 1));
}

/** 生存が1人以下なら終局にする。変化があれば true。 */
function settleEnd(draft: BombPassState): boolean {
  const alive = aliveSeats(draft);
  if (alive.length > 1) return false;
  draft.finished = true;
  draft.winner = alive.length === 1 ? alive[0] : null;
  return true;
}

function createState(players: SeatInfo[], rng: Rng, _options: Record<string, unknown>): BombPassState {
  if (!Array.isArray(players) || players.length < 2 || players.length > 8) {
    throw new Error("爆弾パスは2〜8人で遊びます");
  }
  const sorted = bombClone(players).sort((a, b) => a.seat - b.seat);
  const losses: Record<number, number> = {};
  for (const p of sorted) losses[p.seat] = 0;
  const state: BombPassState = {
    players: sorted,
    holder: sorted[0].seat,
    losses,
    eliminated: [],
    leftSeats: [],
    explodeAt: 0,
    rngState: Math.floor(rng() * 2147483647) | 0,
    round: 1,
    finished: false,
    winner: null,
    lastEvent: null,
  };
  // 最初の保持者はランダムに決める。
  const pick = nextRandom(state.rngState);
  state.rngState = pick.rng;
  state.holder = sorted[Math.floor(pick.value * sorted.length)].seat;
  armBomb(state, Date.now());
  return state;
}

function applyAction(state: BombPassState, seat: number, action: BombPassAction, _rng: Rng): BombPassState {
  if (state.finished) throw new Error("ゲームは終了しています");
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) {
    throw new Error("不正な席です");
  }
  if (!action || typeof action !== "object" || action.type !== "pass") {
    throw new Error("不正なアクションです");
  }
  if (seat !== state.holder) throw new Error("爆弾を持っている人だけがパスできます");
  if (!isAlive(state, seat)) throw new Error("既に脱落しています");
  const target = action.target;
  if (!Number.isInteger(target) || target < 0 || target >= state.players.length) {
    throw new Error("パス先が不正です");
  }
  if (target === seat) throw new Error("自分にはパスできません");
  if (!isAlive(state, target)) throw new Error("脱落した人にはパスできません");
  const next = bombClone(state);
  next.holder = target;
  next.lastEvent = { kind: "pass", from: seat, to: target };
  return next;
}

function viewFor(state: BombPassState, seat: number): BombPassView {
  return {
    phase: state.finished ? "finished" : "playing",
    holder: state.holder,
    round: state.round,
    you: {
      seat,
      alive: isAlive(state, seat),
      left: state.leftSeats.includes(seat),
      isHolder: state.holder === seat,
    },
    players: state.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      losses: state.losses[p.seat] ?? 0,
      alive: isAlive(state, p.seat),
      left: state.leftSeats.includes(p.seat),
      isHolder: state.holder === p.seat,
    })),
    finished: state.finished,
    winner: state.winner,
    lastEvent: state.lastEvent ? bombClone(state.lastEvent) : null,
    playersInfo: bombClone(state.players),
  };
}

function parseAction(raw: unknown): BombPassAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== "pass") return null;
  if (typeof r.target !== "number" || !Number.isInteger(r.target) || r.target < 0) return null;
  return { type: "pass", target: r.target };
}

function onPlayerLeft(state: BombPassState, seat: number): BombPassState {
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) {
    throw new Error("不正な席です");
  }
  if (state.finished) return bombClone(state);
  if (!isAlive(state, seat)) return bombClone(state);
  const next = bombClone(state);
  next.leftSeats.push(seat);
  next.lastEvent = { kind: "left", seat };
  if (!settleEnd(next) && next.holder === seat) {
    // 保持者が抜けたら、爆弾はタイマーを引き継いだまま次の生存者へ移る。
    next.holder = nextAlive(next, seat);
  }
  return next;
}

function tick(state: BombPassState, now: number): BombPassState {
  if (state.finished) return state;
  if (now < state.explodeAt) return state;
  const next = bombClone(state);
  const victim = next.holder;
  next.losses[victim] = (next.losses[victim] ?? 0) + 1;
  next.lastEvent = { kind: "explode", seat: victim };
  if ((next.losses[victim] ?? 0) >= BOMB_LOSE_POINTS) {
    next.eliminated.push(victim);
    next.lastEvent = { kind: "eliminate", seat: victim };
  }
  if (!settleEnd(next)) {
    // 爆発した人の次の生存者から新しい爆弾が始まる。
    next.holder = nextAlive(next, victim);
    next.round += 1;
    armBomb(next, now);
  }
  return next;
}

export const gameModule: OnlineGameModule<BombPassState, BombPassAction, BombPassView> = {
  id: "bombpass",
  title: "爆弾パス",
  minPlayers: 2,
  maxPlayers: 8,
  cpuSupported: false,
  chatEnabled: true,
  createState,
  applyAction,
  viewFor,
  parseAction,
  phaseOf: (state) => (state.finished ? "finished" : "playing"),
  isFinished: (state) => state.finished,
  onPlayerLeft,
  tick,
};
