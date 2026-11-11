// 計算レース（オンライン対戦）のルールモジュール。
// 基盤契約: import は type のみ（テストが import を剥がして連結する）。
// 状態は JSON 化可能な値だけ。applyAction / tick / onPlayerLeft は純関数。
// 流れ: question（20秒）→ reveal（3.5秒・開示）→ 次の問題。全10問。
// 問題はラウンドが進むほど桁数と演算が増える。全員に同時出題され、
// 間違えた人はその問題だけ 3 秒ロックされる（ロック明けに再挑戦可）。
// 得点は各問題で「最初に正解した1人」だけが得る:
//   得点 = 100 + 残り秒数（切り捨て）× 5
// 他の人が正解しても得点は入らないが、その問題は正解済みになる。
// 全員（退出者を除く）が正解するか、時間切れで締め切る。
// 提出した値は viewFor では一切公開しない（正解したかどうかだけを出す）。
// 退出者は脱落扱いだが、スコアは保持され最終順位の対象に残る。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export type CrPhase = "question" | "reveal" | "finished";

export type CrQuestion = {
  /** 表示する式（例 "24 + 35"）。 */
  text: string;
  answer: number;
};

export const CR_TOTAL_QUESTIONS = 10;
export const CR_TIME_LIMIT_MS = 20000;
export const CR_REVEAL_MS = 3500;
export const CR_BASE_SCORE = 100;
export const CR_SPEED_BONUS_PER_SEC = 5;
export const CR_LOCK_MS = 3000;

export type CrAnswer = { seat: number; value: number; atMs: number; correct: boolean };

export type CrResultEntry = {
  seat: number;
  /** その問題を正解したか。 */
  solved: boolean;
  /** 得点したのは各問題で最初の正解者1人だけ。 */
  gained: number;
  winner: boolean;
};

export type CrHistoryEntry = {
  questionIndex: number;
  correctAnswer: number;
  winnerSeat: number | null;
  results: CrResultEntry[];
};

export interface CalcRaceState {
  players: { seat: number; name: string }[];
  /** 退出した seat（脱落扱い。スコアは保持され順位対象に残る）。 */
  leftSeats: number[];
  questions: CrQuestion[];
  index: number;
  phase: CrPhase;
  /** 現在の問題の締切（epoch ms）。question フェーズ以外は null。 */
  questionEndsAt: number | null;
  /** 開示フェーズの終了時刻（epoch ms）。reveal 以外は null。 */
  revealEndsAt: number | null;
  /** 内部のみ。提出値は viewFor で一切公開しない。 */
  answers: CrAnswer[];
  /** 現在の問題を正解済みの seat。 */
  solvedSeats: number[];
  /** 現在の問題で最初に正解した seat（得点者）。未定は null。 */
  winnerSeat: number | null;
  /** 現在の問題で得点者が獲得した点数（締切時に履歴へ移す）。 */
  pendingGain: number;
  /** seat → ロック解除時刻（epoch ms）。 */
  lockedUntil: Record<number, number>;
  scores: Record<number, number>;
  history: CrHistoryEntry[];
}

export type CalcRaceAction = { type: "answer"; value: number };

export interface CrViewPlayer {
  seat: number;
  name: string;
  score: number;
  left: boolean;
  /** 現在の問題を正解済みか。 */
  solved: boolean;
  /** reveal / finished でのみ開示される、その問題の結果。 */
  gained?: number;
  winner?: boolean;
}

export interface CalcRaceView {
  phase: CrPhase;
  index: number;
  totalQuestions: number;
  questionEndsAt: number | null;
  revealEndsAt: number | null;
  /** 現在の問題の式（答えは含まない）。finished では null。 */
  questionText: string | null;
  /** reveal / finished で開示される答え。 */
  correctAnswer: number | null;
  you: {
    seat: number;
    solved: boolean;
    /** 自分がロック中なら解除時刻（epoch ms）。それ以外は null。 */
    lockedUntil: number | null;
    left: boolean;
  };
  players: CrViewPlayer[];
  /** finished 時の順位（同点は同順位、退出者も含む）。それ以外は null。 */
  standings: { seat: number; score: number; rank: number }[] | null;
}

// ---------------------------------------------------------------- utilities

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 最初の正解者の得点。残り時間（ms）から秒を切り捨ててボーナスを加える。 */
export function crScoreFor(remainingMs: number): number {
  const sec = Math.max(0, Math.floor(remainingMs / 1000));
  return CR_BASE_SCORE + sec * CR_SPEED_BONUS_PER_SEC;
}

function playerOf(state: CalcRaceState, seat: number): { seat: number; name: string } | undefined {
  return state.players.find((p) => p.seat === seat);
}

function activeSeats(state: CalcRaceState): number[] {
  return state.players.filter((p) => !state.leftSeats.includes(p.seat)).map((p) => p.seat);
}

function ri(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * 10問を生成する。序盤は2桁の足し算・引き算、中盤は掛け算と3数の計算、
 * 終盤は割り算・混合計算と、少しずつ難しくなる。答えは常に 0 以上の整数。
 */
export function buildCrQuestions(rng: Rng): CrQuestion[] {
  const out: CrQuestion[] = [];
  for (let i = 0; i < CR_TOTAL_QUESTIONS; i++) {
    if (i <= 1) {
      const a = ri(rng, 12, 99);
      const b = ri(rng, 12, 99);
      out.push({ text: `${a} + ${b}`, answer: a + b });
    } else if (i === 2) {
      const a = ri(rng, 41, 99);
      const b = ri(rng, 11, a - 1);
      out.push({ text: `${a} − ${b}`, answer: a - b });
    } else if (i === 3) {
      const a = ri(rng, 3, 9);
      const b = ri(rng, 12, 29);
      out.push({ text: `${a} × ${b}`, answer: a * b });
    } else if (i === 4) {
      const a = ri(rng, 11, 49);
      const b = ri(rng, 11, 49);
      const c = ri(rng, 11, 49);
      out.push({ text: `${a} + ${b} + ${c}`, answer: a + b + c });
    } else if (i === 5) {
      const a = ri(rng, 120, 499);
      const b = ri(rng, 31, 119);
      out.push({ text: `${a} − ${b}`, answer: a - b });
    } else if (i === 6) {
      const b = ri(rng, 3, 12);
      const q = ri(rng, 3, 12);
      out.push({ text: `${b * q} ÷ ${b}`, answer: q });
    } else if (i === 7) {
      const a = ri(rng, 12, 19);
      const b = ri(rng, 3, 9);
      out.push({ text: `${a} × ${b}`, answer: a * b });
    } else if (i === 8) {
      const a = ri(rng, 21, 79);
      const b = ri(rng, 21, 79);
      const c = ri(rng, 11, Math.min(69, a + b - 1));
      out.push({ text: `${a} + ${b} − ${c}`, answer: a + b - c });
    } else {
      const a = ri(rng, 6, 29);
      const b = ri(rng, 3, 9);
      const c = ri(rng, 4, 39);
      out.push({ text: `${a} + ${b} × ${c}`, answer: a + b * c });
    }
  }
  return out;
}

/** 現在の問題を締め切り、履歴に記録して reveal へ移す（draft を破壊的に更新）。 */
function closeQuestion(draft: CalcRaceState, now: number): void {
  const q = draft.questions[draft.index];
  if (!q) return;
  const results: CrResultEntry[] = draft.players.map((p) => {
    const win = draft.winnerSeat === p.seat;
    return {
      seat: p.seat,
      solved: draft.solvedSeats.includes(p.seat),
      gained: win ? (draft.pendingGain ?? 0) : 0,
      winner: win,
    };
  });
  draft.history.push({
    questionIndex: draft.index,
    correctAnswer: q.answer,
    winnerSeat: draft.winnerSeat,
    results,
  });
  draft.answers = [];
  draft.solvedSeats = [];
  draft.winnerSeat = null;
  draft.pendingGain = 0;
  draft.lockedUntil = {};
  draft.phase = "reveal";
  draft.questionEndsAt = null;
  draft.revealEndsAt = now + CR_REVEAL_MS;
}

/** reveal を終えて次の問題へ進む（draft を破壊的に更新）。 */
function advance(draft: CalcRaceState, now: number): void {
  const next = draft.index + 1;
  draft.revealEndsAt = null;
  if (next >= draft.questions.length) {
    draft.index = next;
    draft.phase = "finished";
    return;
  }
  draft.index = next;
  draft.phase = "question";
  draft.questionEndsAt = now + CR_TIME_LIMIT_MS;
}

/** 全員（脱落を除く）が正解済みなら即締切する。 */
function closeIfAllSolved(draft: CalcRaceState, now: number): void {
  if (draft.phase !== "question") return;
  const active = activeSeats(draft);
  if (active.length === 0) return;
  if (active.every((s) => draft.solvedSeats.includes(s))) closeQuestion(draft, now);
}

// ---------------------------------------------------------------- module

function createState(players: SeatInfo[], rng: Rng, _options: Record<string, unknown>): CalcRaceState {
  if (!Array.isArray(players) || players.length < 2 || players.length > 8) {
    throw new Error("計算レースは2〜8人で遊ぶゲームです");
  }
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const scores: Record<number, number> = {};
  for (const p of sorted) scores[p.seat] = 0;
  return {
    players: sorted.map((p) => ({ seat: p.seat, name: p.name })),
    leftSeats: [],
    questions: buildCrQuestions(rng),
    index: 0,
    phase: "question",
    questionEndsAt: Date.now() + CR_TIME_LIMIT_MS,
    revealEndsAt: null,
    answers: [],
    solvedSeats: [],
    winnerSeat: null,
    pendingGain: 0,
    lockedUntil: {},
    scores,
    history: [],
  };
}

function applyAction(state: CalcRaceState, seat: number, action: CalcRaceAction, _rng: Rng): CalcRaceState {
  if (!action || typeof action !== "object" || (action as { type?: unknown }).type !== "answer") {
    throw new Error("不明なアクションです");
  }
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished") throw new Error("ゲームは終了しています");
  if (state.phase !== "question") throw new Error("今は回答できません");
  if (state.leftSeats.includes(seat)) throw new Error("退出したプレイヤーは回答できません");
  const value = (action as { value?: unknown }).value;
  if (typeof value !== "number" || !Number.isInteger(value) || Math.abs(value) > 999999) {
    throw new Error("回答が不正です");
  }
  const q = state.questions[state.index];
  if (!q) throw new Error("問題が存在しません");
  if (state.solvedSeats.includes(seat)) throw new Error("この問題はすでに正解しています");

  const now = Date.now();
  if (state.questionEndsAt !== null && now > state.questionEndsAt) {
    throw new Error("制限時間を過ぎています");
  }
  const locked = state.lockedUntil[seat] ?? 0;
  if (now < locked) {
    const sec = Math.ceil((locked - now) / 1000);
    throw new Error(`不正解のロック中です。あと約${sec}秒待ってください`);
  }

  const draft = clone(state);
  const correct = value === q.answer;
  draft.answers.push({ seat, value, atMs: now, correct });
  if (correct) {
    draft.solvedSeats.push(seat);
    delete draft.lockedUntil[seat];
    if (draft.winnerSeat === null) {
      const gained = crScoreFor((draft.questionEndsAt ?? now) - now);
      draft.winnerSeat = seat;
      draft.pendingGain = gained;
      draft.scores[seat] = (draft.scores[seat] ?? 0) + gained;
    }
    closeIfAllSolved(draft, now);
  } else {
    draft.lockedUntil[seat] = now + CR_LOCK_MS;
  }
  return draft;
}

function viewFor(state: CalcRaceState, seat: number): CalcRaceView {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  const finished = state.phase === "finished";
  const revealing = state.phase === "reveal" || finished;
  const lastHistory = state.history[state.history.length - 1];
  const revealForCurrent =
    revealing && lastHistory && lastHistory.questionIndex === (finished ? state.questions.length - 1 : state.index);

  const players: CrViewPlayer[] = state.players.map((p) => {
    const entry: CrViewPlayer = {
      seat: p.seat,
      name: p.name,
      score: state.scores[p.seat] ?? 0,
      left: state.leftSeats.includes(p.seat),
      solved: state.solvedSeats.includes(p.seat) ||
        (revealing && lastHistory ? lastHistory.results.some((r) => r.seat === p.seat && r.solved) : false),
    };
    if (revealForCurrent && lastHistory) {
      const r = lastHistory.results.find((x) => x.seat === p.seat);
      if (r) {
        entry.gained = r.gained;
        entry.winner = r.winner;
      }
    }
    return entry;
  });

  const q = state.questions[state.index];
  let standings: CalcRaceView["standings"] = null;
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
    index: Math.min(state.index, state.questions.length - 1),
    totalQuestions: state.questions.length,
    questionEndsAt: state.questionEndsAt,
    revealEndsAt: state.revealEndsAt,
    questionText: !finished && q ? q.text : null,
    correctAnswer: revealForCurrent && lastHistory ? lastHistory.correctAnswer : null,
    you: {
      seat,
      solved: state.solvedSeats.includes(seat),
      lockedUntil: state.phase === "question" ? (state.lockedUntil[seat] ?? null) : null,
      left: state.leftSeats.includes(seat),
    },
    players,
    standings,
  };
}

function parseAction(raw: unknown): CalcRaceAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.type !== "answer") return null;
  if (typeof rec.value !== "number" || !Number.isInteger(rec.value) || Math.abs(rec.value) > 999999) return null;
  return { type: "answer", value: rec.value };
}

function onPlayerLeft(state: CalcRaceState, seat: number): CalcRaceState {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished" || state.leftSeats.includes(seat)) return state;
  const draft = clone(state);
  draft.leftSeats.push(seat);
  // スコアは保持し、順位対象に残す。残り全員が正解済みなら締め切る。
  if (activeSeats(draft).length === 0) {
    draft.phase = "finished";
    draft.questionEndsAt = null;
    draft.revealEndsAt = null;
    return draft;
  }
  closeIfAllSolved(draft, Date.now());
  return draft;
}

function tick(state: CalcRaceState, now: number): CalcRaceState {
  if (state.phase === "question" && state.questionEndsAt !== null && now >= state.questionEndsAt) {
    const draft = clone(state);
    closeQuestion(draft, now);
    return draft;
  }
  if (state.phase === "reveal" && state.revealEndsAt !== null && now >= state.revealEndsAt) {
    const draft = clone(state);
    advance(draft, now);
    return draft;
  }
  return state;
}

export const gameModule: OnlineGameModule<CalcRaceState, CalcRaceAction, CalcRaceView> = {
  id: "calcrace",
  title: "計算レース",
  minPlayers: 2,
  maxPlayers: 8,
  cpuSupported: false,
  chatEnabled: true,
  createState,
  applyAction,
  viewFor,
  parseAction,
  phaseOf: (state: CalcRaceState) => state.phase,
  isFinished: (state: CalcRaceState) => state.phase === "finished",
  onPlayerLeft,
  tick,
};
