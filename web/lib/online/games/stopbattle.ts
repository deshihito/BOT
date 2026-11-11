// ストップウォッチ対戦（オンライン）のルールモジュール。
// 基盤契約: import は type のみ（テストが import を剥がして連結する）。
// 状態は JSON 化可能な値だけ。applyAction / tick / onPlayerLeft は純関数。
// 流れ: 全5ラウンド。各ラウンドは counting（開始後は経過を表示しないブラインドで、
// 各自が「止める」を送る）→ reveal（全員の記録と誤差を開示、6秒）→ 次のラウンド。
// 計測はサーバー側の時刻で行う: 開始時刻はラウンド開始時に state へ記録し、
// 「止める」アクションの受信時刻（Date.now）との差をその人の記録とする。
// 精度は基盤の tick / ポーリング間隔の範囲に限られる（カジュアルな対戦用）。
// 得点: 誤差 = |記録 − 目標|。誤差が最も小さい提出者1人だけが得点する
// （同誤差なら先に止めた方）。得点は sbScoreForError(誤差) で、
// 100点から誤差0.1秒ごとに1点減り、最低でも10点は入る。
// 締切は全員が止めた時点、または開始から「目標 + 10秒」を過ぎた時点。
// 未送信の人は誤差最大（記録なし）として扱い、得点はしない。
// 退出した人は脱落扱いで、送信済みの記録も取り消す。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export type SbPhase = "counting" | "reveal" | "finished";

export const SB_TOTAL_ROUNDS = 5;
/** ラウンドごとの目標タイム（ms）。 */
export const SB_TARGETS_MS: number[] = [7000, 10000, 13000, 8500, 11500];
/** 目標を過ぎても受け付ける猶予（ms）。締切 = 開始 + 目標 + 猶予。 */
export const SB_OVERRUN_MS = 10000;
export const SB_REVEAL_MS = 6000;

export function sbTargetForRound(round: number): number {
  return SB_TARGETS_MS[Math.min(round, SB_TARGETS_MS.length - 1)];
}

/** 誤差から得点を計算する（0.1秒ごとに1点減点、最低10点）。 */
export function sbScoreForError(errorMs: number): number {
  if (!Number.isFinite(errorMs) || errorMs < 0) return 10;
  return Math.max(10, 100 - Math.floor(errorMs / 100));
}

export type SbStop = { seat: number; elapsedMs: number };

export type SbResultEntry = {
  seat: number;
  /** 未送信は null。 */
  elapsedMs: number | null;
  /** 目標との誤差（未送信は null）。 */
  errorMs: number | null;
  gained: number;
  winner: boolean;
};

export type SbHistoryEntry = {
  roundIndex: number;
  targetMs: number;
  results: SbResultEntry[];
};

export interface StopBattleState {
  players: { seat: number; name: string }[];
  /** 退出した seat（脱落扱い）。 */
  leftSeats: number[];
  round: number;
  phase: SbPhase;
  /** ラウンド開始時刻（epoch ms）。counting 以外は null。 */
  roundStartedAt: number | null;
  /** 締切時刻（epoch ms）= 開始 + 目標 + 猶予。counting 以外は null。 */
  roundEndsAt: number | null;
  /** 開示フェーズの終了時刻（epoch ms）。reveal 以外は null。 */
  revealEndsAt: number | null;
  /** 内部のみ。締切まで viewFor で秘匿する（自分の分だけ返す）。 */
  stops: SbStop[];
  scores: Record<number, number>;
  history: SbHistoryEntry[];
}

export type StopBattleAction = { type: "stop" };

export interface SbViewPlayer {
  seat: number;
  name: string;
  score: number;
  left: boolean;
  stopped: boolean;
  /** reveal / finished でのみ開示される記録と誤差（未送信は null）。それ以外はキー自体なし。 */
  elapsedMs?: number | null;
  errorMs?: number | null;
  gained?: number;
  winner?: boolean;
}

export interface StopBattleView {
  phase: SbPhase;
  round: number;
  totalRounds: number;
  /** このラウンドの目標タイム（ms）。 */
  targetMs: number;
  roundEndsAt: number | null;
  revealEndsAt: number | null;
  you: { seat: number; stopped: boolean; yourElapsedMs: number | null; left: boolean };
  players: SbViewPlayer[];
  /** finished 時の順位（同点は同順位）。それ以外は null。 */
  standings: { seat: number; score: number; rank: number }[] | null;
}

// ---------------------------------------------------------------- utilities

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function playerOf(state: StopBattleState, seat: number): { seat: number; name: string } | undefined {
  return state.players.find((p) => p.seat === seat);
}

function activeSeats(state: StopBattleState): number[] {
  return state.players.filter((p) => !state.leftSeats.includes(p.seat)).map((p) => p.seat);
}

/** counting を締め切り、採点して reveal へ移す（draft を破壊的に更新）。 */
function closeRound(draft: StopBattleState, now: number): void {
  const target = sbTargetForRound(draft.round);
  // 誤差が最も小さい提出者（同誤差なら先に止めた方）を1人だけ得点者にする。
  let best: (SbStop & { errorMs: number }) | null = null;
  for (const stop of draft.stops) {
    if (draft.leftSeats.includes(stop.seat)) continue;
    const errorMs = Math.abs(stop.elapsedMs - target);
    if (best === null || errorMs < best.errorMs) best = { ...stop, errorMs };
  }
  const results: SbResultEntry[] = draft.players.map((p) => {
    const stop = draft.stops.find((s) => s.seat === p.seat);
    const elapsedMs = stop && !draft.leftSeats.includes(p.seat) ? stop.elapsedMs : null;
    const errorMs = elapsedMs !== null ? Math.abs(elapsedMs - target) : null;
    const winner = best !== null && best.seat === p.seat;
    const gained = winner && errorMs !== null ? sbScoreForError(errorMs) : 0;
    return { seat: p.seat, elapsedMs, errorMs, gained, winner };
  });
  for (const r of results) {
    draft.scores[r.seat] = (draft.scores[r.seat] ?? 0) + r.gained;
  }
  draft.history.push({ roundIndex: draft.round, targetMs: target, results });
  draft.stops = [];
  draft.phase = "reveal";
  draft.roundStartedAt = null;
  draft.roundEndsAt = null;
  draft.revealEndsAt = now + SB_REVEAL_MS;
}

/** reveal を終えて次のラウンドへ進む（draft を破壊的に更新）。 */
function advance(draft: StopBattleState, now: number): void {
  const next = draft.round + 1;
  draft.revealEndsAt = null;
  if (next >= SB_TOTAL_ROUNDS) {
    draft.round = next;
    draft.phase = "finished";
    return;
  }
  draft.round = next;
  draft.phase = "counting";
  draft.roundStartedAt = now;
  draft.roundEndsAt = now + sbTargetForRound(next) + SB_OVERRUN_MS;
}

/** 全員（脱落を除く）が止めたら即締切する。 */
function closeIfAllStopped(draft: StopBattleState, now: number): void {
  if (draft.phase !== "counting") return;
  const active = activeSeats(draft);
  if (active.length === 0) return;
  if (active.every((s) => draft.stops.some((x) => x.seat === s))) closeRound(draft, now);
}

// ---------------------------------------------------------------- module

function createState(players: SeatInfo[], _rng: Rng, _options: Record<string, unknown>): StopBattleState {
  if (!Array.isArray(players) || players.length < 2 || players.length > 8) {
    throw new Error("ストップウォッチ対戦は2〜8人で遊ぶゲームです");
  }
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const scores: Record<number, number> = {};
  for (const p of sorted) scores[p.seat] = 0;
  const now = Date.now();
  return {
    players: sorted.map((p) => ({ seat: p.seat, name: p.name })),
    leftSeats: [],
    round: 0,
    phase: "counting",
    roundStartedAt: now,
    roundEndsAt: now + sbTargetForRound(0) + SB_OVERRUN_MS,
    revealEndsAt: null,
    stops: [],
    scores,
    history: [],
  };
}

function applyAction(state: StopBattleState, seat: number, action: StopBattleAction, _rng: Rng): StopBattleState {
  if (!action || typeof action !== "object" || (action as { type?: unknown }).type !== "stop") {
    throw new Error("不明なアクションです");
  }
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished") throw new Error("ゲームは終了しています");
  if (state.phase !== "counting") throw new Error("今は止められません");
  if (state.leftSeats.includes(seat)) throw new Error("退出したプレイヤーは参加できません");
  if (state.roundStartedAt === null) throw new Error("ラウンドが始まっていません");
  if (state.stops.some((s) => s.seat === seat)) throw new Error("すでに止めています");

  const now = Date.now();
  if (state.roundEndsAt !== null && now > state.roundEndsAt) {
    throw new Error("制限時間を過ぎています");
  }
  const draft = clone(state);
  draft.stops.push({ seat, elapsedMs: Math.max(0, now - state.roundStartedAt) });
  closeIfAllStopped(draft, now);
  return draft;
}

function viewFor(state: StopBattleState, seat: number): StopBattleView {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  const finished = state.phase === "finished";
  const revealing = state.phase === "reveal" || finished;
  const lastHistory = state.history[state.history.length - 1];
  const revealRoundIndex = finished ? SB_TOTAL_ROUNDS - 1 : state.round;
  const revealForCurrent = revealing && lastHistory && lastHistory.roundIndex === revealRoundIndex;

  const players: SbViewPlayer[] = state.players.map((p) => {
    const entry: SbViewPlayer = {
      seat: p.seat,
      name: p.name,
      score: state.scores[p.seat] ?? 0,
      left: state.leftSeats.includes(p.seat),
      stopped:
        state.stops.some((s) => s.seat === p.seat) ||
        (revealing && lastHistory
          ? lastHistory.results.some((r) => r.seat === p.seat && r.elapsedMs !== null)
          : false),
    };
    if (revealForCurrent && lastHistory) {
      const r = lastHistory.results.find((x) => x.seat === p.seat);
      if (r) {
        entry.elapsedMs = r.elapsedMs;
        entry.errorMs = r.errorMs;
        entry.gained = r.gained;
        entry.winner = r.winner;
      }
    }
    return entry;
  });

  const myStop = state.stops.find((s) => s.seat === seat);
  let yourElapsedMs: number | null = myStop ? myStop.elapsedMs : null;
  if (yourElapsedMs === null && revealForCurrent && lastHistory) {
    const r = lastHistory.results.find((x) => x.seat === seat);
    if (r) yourElapsedMs = r.elapsedMs;
  }

  let standings: StopBattleView["standings"] = null;
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
    round: Math.min(state.round, SB_TOTAL_ROUNDS - 1),
    totalRounds: SB_TOTAL_ROUNDS,
    targetMs: sbTargetForRound(Math.min(state.round, SB_TOTAL_ROUNDS - 1)),
    roundEndsAt: state.roundEndsAt,
    revealEndsAt: state.revealEndsAt,
    you: {
      seat,
      stopped: players.find((p) => p.seat === seat)?.stopped ?? false,
      yourElapsedMs,
      left: state.leftSeats.includes(seat),
    },
    players,
    standings,
  };
}

function parseAction(raw: unknown): StopBattleAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.type !== "stop") return null;
  return { type: "stop" };
}

function onPlayerLeft(state: StopBattleState, seat: number): StopBattleState {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished" || state.leftSeats.includes(seat)) return state;
  const draft = clone(state);
  draft.leftSeats.push(seat);
  // 退出者は未送信扱いにする（送信済みの記録も取り消す）。
  draft.stops = draft.stops.filter((s) => s.seat !== seat);
  if (activeSeats(draft).length === 0) {
    draft.phase = "finished";
    draft.roundStartedAt = null;
    draft.roundEndsAt = null;
    draft.revealEndsAt = null;
    return draft;
  }
  // 残り全員が止めていたら締め切る。
  closeIfAllStopped(draft, Date.now());
  return draft;
}

function tick(state: StopBattleState, now: number): StopBattleState {
  if (state.phase === "counting" && state.roundEndsAt !== null && now >= state.roundEndsAt) {
    const draft = clone(state);
    closeRound(draft, now);
    return draft;
  }
  if (state.phase === "reveal" && state.revealEndsAt !== null && now >= state.revealEndsAt) {
    const draft = clone(state);
    advance(draft, now);
    return draft;
  }
  return state;
}

export const gameModule: OnlineGameModule<StopBattleState, StopBattleAction, StopBattleView> = {
  id: "stopbattle",
  title: "ストップウォッチ対戦",
  minPlayers: 2,
  maxPlayers: 8,
  cpuSupported: false,
  chatEnabled: true,
  createState,
  applyAction,
  viewFor,
  parseAction,
  phaseOf: (state: StopBattleState) => state.phase,
  isFinished: (state: StopBattleState) => state.phase === "finished",
  onPlayerLeft,
  tick,
};
