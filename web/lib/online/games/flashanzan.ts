// フラッシュ暗算（オンライン対戦）のルールモジュール。
// 基盤契約: import は type のみ（テストが import を剥がして連結する）。
// 状態は JSON 化可能な値だけ。applyAction / tick / onPlayerLeft は純関数。
// 流れ: 全5ラウンド。各ラウンドは showing（数字を1つずつ表示、tick で進行）
// → answer（合計を提出、15秒・全員提出か時間切れで締切）→ reveal（5秒・開示）。
// 数字列は createState でシード決定的に生成し、全員が同じ列を見る。
// 得点: 正解に最も近い提出者が 100 点（完全一致は +50 点ボーナス）。
// 同じ距離の提出者が複数いる場合は、提出が早い方だけが得点する。
// 回答は締切まで秘匿し、viewFor では「提出済みかどうか」だけを公開する。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export type FaPhase = "showing" | "answer" | "reveal" | "finished";

export const FA_TOTAL_ROUNDS = 5;
/** 数字1つを表示する間隔（ms）。 */
export const FA_SHOW_INTERVAL_MS = 1200;
export const FA_ANSWER_LIMIT_MS = 15000;
export const FA_REVEAL_MS = 5000;
export const FA_BASE_SCORE = 100;
export const FA_EXACT_BONUS = 50;

/** ラウンドごとの出題仕様（個数と桁数が増えていく）。 */
export const FA_ROUND_SPECS: { count: number; digits: number }[] = [
  { count: 5, digits: 1 },
  { count: 6, digits: 1 },
  { count: 6, digits: 2 },
  { count: 8, digits: 2 },
  { count: 10, digits: 2 },
];

export type FaRound = {
  numbers: number[];
  answer: number;
};

export type FaAnswer = { seat: number; value: number; atMs: number };

export type FaResultEntry = {
  seat: number;
  /** 未提出は null。 */
  value: number | null;
  /** 正解との差（未提出は null）。 */
  diff: number | null;
  gained: number;
  /** このラウンドの得点者かどうか。 */
  winner: boolean;
};

export type FaHistoryEntry = {
  roundIndex: number;
  answer: number;
  results: FaResultEntry[];
};

export interface FlashAnzanState {
  players: { seat: number; name: string }[];
  /** 退出した seat（脱落扱い）。 */
  leftSeats: number[];
  rounds: FaRound[];
  round: number;
  phase: FaPhase;
  /** showing 中に表示している数字の index。 */
  currentIndex: number;
  /** 次の数字へ進む時刻（epoch ms）。showing 以外は null。 */
  showEndsAt: number | null;
  /** 回答の締切（epoch ms）。answer 以外は null。 */
  answerEndsAt: number | null;
  /** 開示フェーズの終了時刻（epoch ms）。reveal 以外は null。 */
  revealEndsAt: number | null;
  /** 内部のみ。締切まで viewFor で秘匿する。 */
  answers: FaAnswer[];
  scores: Record<number, number>;
  history: FaHistoryEntry[];
}

export type FlashAnzanAction = { type: "answer"; value: number };

export interface FaViewPlayer {
  seat: number;
  name: string;
  score: number;
  left: boolean;
  answered: boolean;
  /** reveal / finished でのみ開示される回答（未提出は null）。それ以外はキー自体なし。 */
  value?: number | null;
  diff?: number | null;
  gained?: number;
  winner?: boolean;
}

export interface FlashAnzanView {
  phase: FaPhase;
  round: number;
  totalRounds: number;
  /** showing 中に全員へ表示する現在の数字。それ以外は null。 */
  currentNumber: number | null;
  /** showing 中の進み具合（表示済み個数 / 全個数）。 */
  shownCount: number;
  totalNumbers: number;
  showEndsAt: number | null;
  answerEndsAt: number | null;
  revealEndsAt: number | null;
  /** reveal / finished で開示される正解。それ以外は null。 */
  correctAnswer: number | null;
  you: { seat: number; answered: boolean; yourValue: number | null; left: boolean };
  players: FaViewPlayer[];
  /** finished 時の順位（同点は同順位）。それ以外は null。 */
  standings: { seat: number; score: number; rank: number }[] | null;
}

// ---------------------------------------------------------------- utilities

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function playerOf(state: FlashAnzanState, seat: number): { seat: number; name: string } | undefined {
  return state.players.find((p) => p.seat === seat);
}

function activeSeats(state: FlashAnzanState): number[] {
  return state.players.filter((p) => !state.leftSeats.includes(p.seat)).map((p) => p.seat);
}

function buildRounds(rng: Rng): FaRound[] {
  return FA_ROUND_SPECS.map((spec) => {
    const lo = spec.digits === 1 ? 1 : 10;
    const hi = spec.digits === 1 ? 9 : 99;
    const numbers: number[] = [];
    for (let i = 0; i < spec.count; i++) {
      numbers.push(lo + Math.floor(rng() * (hi - lo + 1)));
    }
    return { numbers, answer: numbers.reduce((a, b) => a + b, 0) };
  });
}

/** 回答フェーズを締め切り、採点して reveal へ移す（draft を破壊的に更新）。 */
function closeRound(draft: FlashAnzanState, now: number): void {
  const round = draft.rounds[draft.round];
  if (!round) return;
  // 最も正解に近い提出者（同距離なら提出が早い方）を1人だけ得点者にする。
  let best: FaAnswer | null = null;
  for (const ans of draft.answers) {
    if (draft.leftSeats.includes(ans.seat)) continue;
    if (best === null) {
      best = ans;
      continue;
    }
    const d = Math.abs(ans.value - round.answer);
    const bd = Math.abs(best.value - round.answer);
    if (d < bd || (d === bd && ans.atMs < best.atMs)) best = ans;
  }
  const results: FaResultEntry[] = draft.players.map((p) => {
    const ans = draft.answers.find((a) => a.seat === p.seat);
    const value = ans ? ans.value : null;
    const diff = value !== null ? Math.abs(value - round.answer) : null;
    const winner = best !== null && best.seat === p.seat && !draft.leftSeats.includes(p.seat);
    const gained = winner ? FA_BASE_SCORE + (value === round.answer ? FA_EXACT_BONUS : 0) : 0;
    return { seat: p.seat, value, diff, gained, winner };
  });
  for (const r of results) {
    draft.scores[r.seat] = (draft.scores[r.seat] ?? 0) + r.gained;
  }
  draft.history.push({ roundIndex: draft.round, answer: round.answer, results });
  draft.answers = [];
  draft.phase = "reveal";
  draft.answerEndsAt = null;
  draft.revealEndsAt = now + FA_REVEAL_MS;
}

/** reveal を終えて次のラウンドへ進む（draft を破壊的に更新）。 */
function advance(draft: FlashAnzanState, now: number): void {
  const next = draft.round + 1;
  draft.revealEndsAt = null;
  if (next >= draft.rounds.length) {
    draft.round = next;
    draft.phase = "finished";
    draft.currentIndex = 0;
    return;
  }
  draft.round = next;
  draft.phase = "showing";
  draft.currentIndex = 0;
  draft.showEndsAt = now + FA_SHOW_INTERVAL_MS;
}

/** 全員（脱落を除く）が提出済みなら即締切する。 */
function closeIfAllAnswered(draft: FlashAnzanState, now: number): void {
  if (draft.phase !== "answer") return;
  const active = activeSeats(draft);
  if (active.length === 0) return;
  if (active.every((s) => draft.answers.some((a) => a.seat === s))) closeRound(draft, now);
}

// ---------------------------------------------------------------- module

function createState(players: SeatInfo[], rng: Rng, _options: Record<string, unknown>): FlashAnzanState {
  if (!Array.isArray(players) || players.length < 2 || players.length > 6) {
    throw new Error("フラッシュ暗算は2〜6人で遊ぶゲームです");
  }
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const scores: Record<number, number> = {};
  for (const p of sorted) scores[p.seat] = 0;
  return {
    players: sorted.map((p) => ({ seat: p.seat, name: p.name })),
    leftSeats: [],
    rounds: buildRounds(rng),
    round: 0,
    phase: "showing",
    currentIndex: 0,
    showEndsAt: Date.now() + FA_SHOW_INTERVAL_MS,
    answerEndsAt: null,
    revealEndsAt: null,
    answers: [],
    scores,
    history: [],
  };
}

function applyAction(state: FlashAnzanState, seat: number, action: FlashAnzanAction, _rng: Rng): FlashAnzanState {
  if (!action || typeof action !== "object" || (action as { type?: unknown }).type !== "answer") {
    throw new Error("不明なアクションです");
  }
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished") throw new Error("ゲームは終了しています");
  if (state.phase !== "answer") throw new Error("今は回答できません");
  if (state.leftSeats.includes(seat)) throw new Error("退出したプレイヤーは回答できません");
  const value = (action as { value?: unknown }).value;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 99999) {
    throw new Error("回答が不正です");
  }
  if (state.answers.some((a) => a.seat === seat)) throw new Error("すでに回答しています");

  const now = Date.now();
  if (state.answerEndsAt !== null && now > state.answerEndsAt) {
    throw new Error("制限時間を過ぎています");
  }
  const draft = clone(state);
  draft.answers.push({ seat, value, atMs: now });
  closeIfAllAnswered(draft, now);
  return draft;
}

function viewFor(state: FlashAnzanState, seat: number): FlashAnzanView {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  const finished = state.phase === "finished";
  const revealing = state.phase === "reveal" || finished;
  const lastHistory = state.history[state.history.length - 1];
  const revealRoundIndex = finished ? state.rounds.length - 1 : state.round;
  const revealForCurrent = revealing && lastHistory && lastHistory.roundIndex === revealRoundIndex;

  const players: FaViewPlayer[] = state.players.map((p) => {
    const entry: FaViewPlayer = {
      seat: p.seat,
      name: p.name,
      score: state.scores[p.seat] ?? 0,
      left: state.leftSeats.includes(p.seat),
      answered:
        state.answers.some((a) => a.seat === p.seat) ||
        (revealing && lastHistory
          ? lastHistory.results.some((r) => r.seat === p.seat && r.value !== null)
          : false),
    };
    if (revealForCurrent && lastHistory) {
      const r = lastHistory.results.find((x) => x.seat === p.seat);
      if (r) {
        entry.value = r.value;
        entry.diff = r.diff;
        entry.gained = r.gained;
        entry.winner = r.winner;
      }
    }
    return entry;
  });

  const round = state.rounds[state.round];
  const showing = state.phase === "showing" && round;
  const myAnswer = state.answers.find((a) => a.seat === seat);
  let yourValue: number | null = myAnswer ? myAnswer.value : null;
  if (yourValue === null && revealForCurrent && lastHistory) {
    const r = lastHistory.results.find((x) => x.seat === seat);
    if (r) yourValue = r.value;
  }

  let standings: FlashAnzanView["standings"] = null;
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
    round: Math.min(state.round, state.rounds.length - 1),
    totalRounds: state.rounds.length,
    currentNumber: showing ? round.numbers[state.currentIndex] ?? null : null,
    shownCount: state.phase === "showing" ? state.currentIndex + 1 : round ? round.numbers.length : 0,
    totalNumbers: round ? round.numbers.length : 0,
    showEndsAt: state.showEndsAt,
    answerEndsAt: state.answerEndsAt,
    revealEndsAt: state.revealEndsAt,
    correctAnswer: revealForCurrent && lastHistory ? lastHistory.answer : null,
    you: {
      seat,
      answered: players.find((p) => p.seat === seat)?.answered ?? false,
      yourValue,
      left: state.leftSeats.includes(seat),
    },
    players,
    standings,
  };
}

function parseAction(raw: unknown): FlashAnzanAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.type !== "answer") return null;
  if (typeof rec.value !== "number" || !Number.isInteger(rec.value) || rec.value < 0 || rec.value > 99999) {
    return null;
  }
  return { type: "answer", value: rec.value };
}

function onPlayerLeft(state: FlashAnzanState, seat: number): FlashAnzanState {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished" || state.leftSeats.includes(seat)) return state;
  const draft = clone(state);
  draft.leftSeats.push(seat);
  // 退出者は未提出扱いにする（提出済みの回答も取り消す）。
  draft.answers = draft.answers.filter((a) => a.seat !== seat);
  if (activeSeats(draft).length === 0) {
    draft.phase = "finished";
    draft.showEndsAt = null;
    draft.answerEndsAt = null;
    draft.revealEndsAt = null;
    return draft;
  }
  // 残り全員が提出済みなら締め切る。
  closeIfAllAnswered(draft, Date.now());
  return draft;
}

function tick(state: FlashAnzanState, now: number): FlashAnzanState {
  if (state.phase === "showing" && state.showEndsAt !== null && now >= state.showEndsAt) {
    const draft = clone(state);
    const round = draft.rounds[draft.round];
    if (!round) return state;
    if (draft.currentIndex + 1 >= round.numbers.length) {
      // 最後の数字まで表示したので回答フェーズへ。
      draft.phase = "answer";
      draft.showEndsAt = null;
      draft.answerEndsAt = now + FA_ANSWER_LIMIT_MS;
    } else {
      draft.currentIndex += 1;
      draft.showEndsAt = now + FA_SHOW_INTERVAL_MS;
    }
    return draft;
  }
  if (state.phase === "answer" && state.answerEndsAt !== null && now >= state.answerEndsAt) {
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

export const gameModule: OnlineGameModule<FlashAnzanState, FlashAnzanAction, FlashAnzanView> = {
  id: "flashanzan",
  title: "フラッシュ暗算",
  minPlayers: 2,
  maxPlayers: 6,
  cpuSupported: false,
  chatEnabled: true,
  createState,
  applyAction,
  viewFor,
  parseAction,
  phaseOf: (state: FlashAnzanState) => state.phase,
  isFinished: (state: FlashAnzanState) => state.phase === "finished",
  onPlayerLeft,
  tick,
};
