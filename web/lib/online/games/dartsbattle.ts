// ダーツ対戦（2〜4人・オンライン）のルールモジュール。
// モジュール契約は lib/online/types.ts の OnlineGameModule に従う。
// 実行時 import は禁止（テストが import を剥がして連結するため type のみ）。
//
// ルール: カウントアップ形式。手番に3投し、全8ラウンドの合計点を競う。
// 投擲はクライアントがタップ位置を 0〜1000 の正規化座標で送り、
// サーバー側がシード決定的な微ブレ（最大半径 0.05、ソロ版 lib/darts.ts と
// 同じ量・同じ条件）を加えて着弾点を決め、エリア判定で得点化する。
// エリア判定の定数（セクター順・半径）はソロ版 lib/darts.ts と同一。
// 投擲結果は全て公開情報。退出者は脱落し、その人の手番は飛ばす。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export const DB_TOTAL_ROUNDS = 8;
export const DB_THROWS_PER_TURN = 3;
export const DB_JITTER_RADIUS = 0.05;

const DB_SECTORS = [
  20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5,
] as const;

export interface DbThrow {
  /** 着弾点（ボード正規化座標。中心 0、ダブル外周が半径 1、y は上向き）。 */
  x: number;
  y: number;
  score: number;
  number: number;
  multiplier: number;
  label: string;
}

export interface DartsBattleState {
  players: SeatInfo[];
  turn: number;
  round: number;
  /** seat ごとの全投擲（投げた順）。 */
  throws: DbThrow[][];
  totals: number[];
  finished: boolean;
  leftSeats: number[];
  lastThrow: { seat: number; hit: DbThrow } | null;
}

export type DartsBattleAction = { type: "throw"; x: number; y: number };

export interface DbPlayerView {
  seat: number;
  name: string;
  total: number;
  throws: DbThrow[];
  left: boolean;
  rank: number | null;
}

export interface DartsBattleView {
  players: DbPlayerView[];
  turn: number;
  round: number;
  totalRounds: number;
  /** 現在の手番プレイヤーがこのターンに投げた本数（0〜2）。 */
  throwsThisTurn: number;
  finished: boolean;
  lastThrow: { seat: number; hit: DbThrow } | null;
  you: { seat: number; left: boolean };
}

/** ボード正規化座標から得点を判定する（lib/darts.ts の scoreDart と同一規則）。 */
export function dbScoreDart(x: number, y: number): Omit<DbThrow, "x" | "y"> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { score: 0, number: 0, multiplier: 0, label: "MISS" };
  }
  const r = Math.hypot(x, y);
  if (r > 1.0) return { score: 0, number: 0, multiplier: 0, label: "MISS" };
  if (r <= 0.07) return { score: 50, number: 25, multiplier: 2, label: "BULL" };
  if (r <= 0.16) return { score: 25, number: 25, multiplier: 1, label: "OUTER BULL" };
  let deg = (Math.atan2(x, y) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  const sectorIndex = Math.floor(((deg + 9) % 360) / 18) % 20;
  const number = DB_SECTORS[sectorIndex];
  if (r >= 0.94) return { score: number * 2, number, multiplier: 2, label: `D${number}` };
  if (r >= 0.53 && r <= 0.58) return { score: number * 3, number, multiplier: 3, label: `T${number}` };
  return { score: number, number, multiplier: 1, label: `${number}` };
}

function dbClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function dbIsActive(state: DartsBattleState, seat: number): boolean {
  return seat >= 0 && seat < state.players.length && !state.leftSeats.includes(seat);
}

function dbActiveSeats(state: DartsBattleState): number[] {
  const out: number[] = [];
  for (let s = 0; s < state.players.length; s++) {
    if (dbIsActive(state, s)) out.push(s);
  }
  return out;
}

/** seat の次に現役の seat（循環）。 */
function dbNextActive(state: DartsBattleState, seat: number): number {
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const s = (seat + step) % n;
    if (dbIsActive(state, s)) return s;
  }
  return seat;
}

/**
 * 手番を次へ進める。現役の最後の1人から先頭へ戻るときにラウンドが進み、
 * 全ラウンドが終われば finished にする。
 */
function dbAdvanceTurn(state: DartsBattleState): void {
  const actives = dbActiveSeats(state);
  if (actives.length === 0) {
    state.finished = true;
    return;
  }
  const idx = actives.indexOf(state.turn);
  if (idx === -1 || idx === actives.length - 1) {
    state.round += 1;
    if (state.round >= DB_TOTAL_ROUNDS) {
      state.finished = true;
      return;
    }
    state.turn = actives[0];
  } else {
    state.turn = actives[idx + 1];
  }
}

function dbCreateState(
  players: SeatInfo[],
  _rng: Rng,
  _options: Record<string, unknown>,
): DartsBattleState {
  if (!Array.isArray(players) || players.length < 2 || players.length > 4) {
    throw new Error("ダーツ対戦は2〜4人で遊びます");
  }
  return {
    players: dbClone(players),
    turn: 0,
    round: 0,
    throws: players.map(() => []),
    totals: players.map(() => 0),
    finished: false,
    leftSeats: [],
    lastThrow: null,
  };
}

function dbApplyAction(
  state: DartsBattleState,
  seat: number,
  action: DartsBattleAction,
  rng: Rng,
): DartsBattleState {
  if (state.finished) throw new Error("ゲームは終了しています");
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) {
    throw new Error("不正な席です");
  }
  if (!dbIsActive(state, seat)) throw new Error("既に退出したプレイヤーです");
  if (seat !== state.turn) throw new Error("手番ではありません");
  if (!action || typeof action !== "object" || action.type !== "throw") {
    throw new Error("不正なアクションです");
  }
  const { x, y } = action;
  if (
    !Number.isInteger(x) || !Number.isInteger(y) ||
    x < 0 || x > 1000 || y < 0 || y > 1000
  ) {
    throw new Error("投げる位置が不正です");
  }
  // 0〜1000（画面座標、y は下向き）→ ボード正規化座標（半径 1.2 が画面端）。
  let bx = (x / 1000) * 2.4 - 1.2;
  let by = -((y / 1000) * 2.4 - 1.2);
  // サーバー側の微ブレ（全員同一条件）。
  const angle = rng() * Math.PI * 2;
  const dist = rng() * DB_JITTER_RADIUS;
  bx += Math.cos(angle) * dist;
  by += Math.sin(angle) * dist;
  const hit: DbThrow = { x: bx, y: by, ...dbScoreDart(bx, by) };

  const next = dbClone(state);
  next.throws[seat] = [...next.throws[seat], hit];
  next.totals[seat] += hit.score;
  next.lastThrow = { seat, hit: dbClone(hit) };
  if (next.throws[seat].length % DB_THROWS_PER_TURN === 0) {
    dbAdvanceTurn(next);
  }
  return next;
}

function dbRankOf(state: DartsBattleState, seat: number): number | null {
  if (!state.finished || state.leftSeats.includes(seat)) return null;
  const my = state.totals[seat];
  let rank = 1;
  for (let s = 0; s < state.players.length; s++) {
    if (s === seat || state.leftSeats.includes(s)) continue;
    if (state.totals[s] > my) rank++;
  }
  return rank;
}

function dbViewFor(state: DartsBattleState, seat: number): DartsBattleView {
  const turnThrows = state.throws[state.turn]?.length ?? 0;
  return {
    players: state.players.map((p, s) => ({
      seat: s,
      name: p.name,
      total: state.totals[s],
      throws: dbClone(state.throws[s]),
      left: state.leftSeats.includes(s),
      rank: dbRankOf(state, s),
    })),
    turn: state.turn,
    round: state.round,
    totalRounds: DB_TOTAL_ROUNDS,
    throwsThisTurn: state.finished ? 0 : turnThrows % DB_THROWS_PER_TURN,
    finished: state.finished,
    lastThrow: state.lastThrow ? dbClone(state.lastThrow) : null,
    you: { seat, left: state.leftSeats.includes(seat) },
  };
}

function dbParseAction(raw: unknown): DartsBattleAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== "throw") return null;
  if (typeof r.x !== "number" || typeof r.y !== "number") return null;
  if (!Number.isInteger(r.x) || !Number.isInteger(r.y)) return null;
  if (r.x < 0 || r.x > 1000 || r.y < 0 || r.y > 1000) return null;
  return { type: "throw", x: r.x, y: r.y };
}

function dbOnPlayerLeft(state: DartsBattleState, seat: number): DartsBattleState {
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) {
    throw new Error("不正な席です");
  }
  if (state.finished) return dbClone(state);
  if (!dbIsActive(state, seat)) return dbClone(state);
  const next = dbClone(state);
  const wasTurn = next.turn === seat;
  const activesBefore = dbActiveSeats(next);
  const wasLastInRound = activesBefore[activesBefore.length - 1] === seat;
  next.leftSeats.push(seat);
  if (dbActiveSeats(next).length <= 1) {
    next.finished = true;
    return next;
  }
  if (wasTurn) {
    if (wasLastInRound) {
      next.round += 1;
      if (next.round >= DB_TOTAL_ROUNDS) {
        next.finished = true;
        return next;
      }
      next.turn = dbActiveSeats(next)[0];
    } else {
      next.turn = dbNextActive(next, seat);
    }
  }
  return next;
}

export const gameModule: OnlineGameModule<DartsBattleState, DartsBattleAction, DartsBattleView> = {
  id: "dartsbattle",
  title: "ダーツ対戦",
  minPlayers: 2,
  maxPlayers: 4,
  cpuSupported: false,
  chatEnabled: true,
  createState: dbCreateState,
  applyAction: dbApplyAction,
  viewFor: dbViewFor,
  parseAction: dbParseAction,
  phaseOf: (state) => (state.finished ? "finished" : "playing"),
  isFinished: (state) => state.finished,
  onPlayerLeft: dbOnPlayerLeft,
};
