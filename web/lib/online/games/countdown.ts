// 数字カウントダウン（オンライン対戦）のルールモジュール。
// 基盤契約: import は type のみ（テストが import を剥がして連結する）。
// 状態は JSON 化可能な値だけ。applyAction / tick / onPlayerLeft は純関数。
// 流れ: playing（60秒・全員提出か時間切れで締切）→ reveal（6秒・開示）→ 次のラウンド。全5ラウンド。
// 各ラウンド、目標数字（101〜999）と使える数字6つが全員共通で配られる（createState で全ラウンド分を決定的に生成）。
// 式は「部品列」で提出する: steps の各要素が二項演算で、元の数字は各1回まで、
// 中間結果も各1回までしか使えない。中間結果は正の整数のみ（割り算は割り切れる場合だけ）。
// 採点: 締切時点で目標に最も近い提出者が得点（同距離は先着のみ）。完全一致は 20点、それ以外は 10点。
// 他人の式は締切まで viewFor で秘匿する（提出済みかどうかだけ公開）。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export const CD_TOTAL_ROUNDS = 5;
export const CD_TIME_LIMIT_MS = 60000;
export const CD_REVEAL_MS = 6000;
export const CD_NUMBERS_PER_ROUND = 6;
export const CD_POINTS_CLOSEST = 10;
export const CD_POINTS_EXACT = 20;
/** 中間結果の上限（桁あふれ防止）。 */
export const CD_MAX_VALUE = 1000000;

const CD_LARGE_POOL = [25, 50, 75, 100];
const CD_OPS = ["+", "-", "*", "/"] as const;

export type CdOp = (typeof CD_OPS)[number];

export interface CdRef {
  kind: "num" | "step";
  index: number;
}

export interface CdStep {
  a: CdRef;
  op: CdOp;
  b: CdRef;
}

export interface CdSubmissionInput {
  steps: CdStep[];
  /** steps が空のときだけ使う「数字をそのまま答えにする」指定。 */
  pick: number | null;
}

export type CdPhase = "playing" | "reveal" | "finished";

export interface CdRoundSetup {
  target: number;
  numbers: number[];
}

export interface CdStoredSubmission extends CdSubmissionInput {
  seat: number;
  value: number;
  /** 提出順（同距離のとき先着を決める）。 */
  seq: number;
}

export interface CdHistoryEntry {
  round: number;
  target: number;
  numbers: number[];
  winnerSeat: number | null;
  entries: {
    seat: number;
    value: number | null;
    distance: number | null;
    points: number;
    steps: CdStep[] | null;
    pick: number | null;
  }[];
}

export interface CountdownState {
  players: { seat: number; name: string }[];
  leftSeats: number[];
  round: number;
  totalRounds: number;
  phase: CdPhase;
  roundEndsAt: number | null;
  revealEndsAt: number | null;
  /** 全ラウンド分の配布（createState で決定的に生成）。 */
  setups: CdRoundSetup[];
  /** 現在のラウンドの提出。締切まで viewFor で秘匿する。 */
  submissions: CdStoredSubmission[];
  submitSeq: number;
  scores: Record<number, number>;
  history: CdHistoryEntry[];
}

export type CountdownAction = { type: "submit" } & CdSubmissionInput;

export interface CdViewPlayer {
  seat: number;
  name: string;
  score: number;
  left: boolean;
  submitted: boolean;
  /** reveal / finished（直近ラウンド分）でのみ開示される。 */
  value?: number | null;
  distance?: number | null;
  points?: number;
  steps?: CdStep[] | null;
  pick?: number | null;
}

export interface CountdownView {
  phase: CdPhase;
  round: number;
  totalRounds: number;
  roundEndsAt: number | null;
  revealEndsAt: number | null;
  target: number;
  numbers: number[];
  you: {
    seat: number;
    left: boolean;
    submitted: boolean;
    yourSteps: CdStep[] | null;
    yourPick: number | null;
    yourValue: number | null;
  };
  players: CdViewPlayer[];
  history: CdHistoryEntry[];
  standings: { seat: number; score: number; rank: number }[] | null;
}

// ---------------------------------------------------------------- expression evaluation

export type CdEvalResult =
  | { ok: true; value: number; stepValues: number[] }
  | { ok: false; reason: string };

function resolveRef(
  ref: CdRef,
  numbers: number[],
  stepValues: number[],
  usedNums: Set<number>,
  usedSteps: Set<number>,
  currentStep: number,
): { ok: true; value: number } | { ok: false; reason: string } {
  if (ref.kind === "num") {
    if (!Number.isInteger(ref.index) || ref.index < 0 || ref.index >= numbers.length) {
      return { ok: false, reason: "数字の指定が不正です" };
    }
    if (usedNums.has(ref.index)) return { ok: false, reason: "同じ数字は1回までしか使えません" };
    usedNums.add(ref.index);
    return { ok: true, value: numbers[ref.index] };
  }
  if (!Number.isInteger(ref.index) || ref.index < 0 || ref.index >= currentStep) {
    return { ok: false, reason: "計算結果の指定が不正です" };
  }
  if (usedSteps.has(ref.index)) return { ok: false, reason: "同じ計算結果は1回までしか使えません" };
  usedSteps.add(ref.index);
  return { ok: true, value: stepValues[ref.index] };
}

/**
 * 式（部品列）を評価する純関数。クライアントのプレビューとサーバーの検証で共用する。
 * 規則: 元の数字は各1回まで / 中間結果は各1回まで / 中間結果は正の整数のみ /
 * 引き算は結果が正になる場合だけ / 割り算は割り切れる場合だけ。
 */
export function evaluateCountdown(numbers: number[], sub: CdSubmissionInput): CdEvalResult {
  if (!Array.isArray(sub.steps) || sub.steps.length > CD_NUMBERS_PER_ROUND - 1) {
    return { ok: false, reason: "計算の手順が多すぎます" };
  }
  if (sub.steps.length === 0) {
    if (sub.pick === null || !Number.isInteger(sub.pick) || sub.pick < 0 || sub.pick >= numbers.length) {
      return { ok: false, reason: "答えにする数字を選んでください" };
    }
    return { ok: true, value: numbers[sub.pick], stepValues: [] };
  }
  const usedNums = new Set<number>();
  const usedSteps = new Set<number>();
  const stepValues: number[] = [];
  for (let i = 0; i < sub.steps.length; i++) {
    const step = sub.steps[i];
    const ra = resolveRef(step.a, numbers, stepValues, usedNums, usedSteps, i);
    if (!ra.ok) return ra;
    const rb = resolveRef(step.b, numbers, stepValues, usedNums, usedSteps, i);
    if (!rb.ok) return rb;
    let value: number;
    switch (step.op) {
      case "+":
        value = ra.value + rb.value;
        break;
      case "-":
        value = ra.value - rb.value;
        if (value <= 0) return { ok: false, reason: "引き算の結果は正の数でなければなりません" };
        break;
      case "*":
        value = ra.value * rb.value;
        break;
      case "/":
        if (rb.value === 0 || ra.value % rb.value !== 0) {
          return { ok: false, reason: "割り算は割り切れる場合だけ使えます" };
        }
        value = ra.value / rb.value;
        break;
      default:
        return { ok: false, reason: "演算子が不正です" };
    }
    if (!Number.isInteger(value) || value <= 0 || value > CD_MAX_VALUE) {
      return { ok: false, reason: "計算結果が大きすぎます" };
    }
    stepValues.push(value);
  }
  return { ok: true, value: stepValues[stepValues.length - 1], stepValues };
}

// ---------------------------------------------------------------- utilities

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function playerOf(state: CountdownState, seat: number): { seat: number; name: string } | undefined {
  return state.players.find((p) => p.seat === seat);
}

function activeSeats(state: CountdownState): number[] {
  return state.players.filter((p) => !state.leftSeats.includes(p.seat)).map((p) => p.seat);
}

function generateSetups(rng: Rng): CdRoundSetup[] {
  const setups: CdRoundSetup[] = [];
  for (let round = 0; round < CD_TOTAL_ROUNDS; round++) {
    const largeCount = 1 + Math.floor(rng() * 2); // 1〜2個
    const pool = [...CD_LARGE_POOL];
    const numbers: number[] = [];
    for (let i = 0; i < largeCount; i++) {
      const at = Math.floor(rng() * pool.length);
      numbers.push(pool.splice(at, 1)[0]);
    }
    while (numbers.length < CD_NUMBERS_PER_ROUND) {
      numbers.push(1 + Math.floor(rng() * 10));
    }
    // 並びをシャッフル（大きな数字が前に固まらないように）。
    for (let i = numbers.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
    }
    const target = 101 + Math.floor(rng() * 899); // 101〜999
    setups.push({ target, numbers });
  }
  return setups;
}

/** 現在のラウンドを締め切り、採点して reveal へ移す（draft を破壊的に更新）。 */
function closeRound(draft: CountdownState, now: number): void {
  const setup = draft.setups[draft.round];
  const active = new Set(activeSeats(draft));
  const candidates = draft.submissions
    .filter((s) => active.has(s.seat))
    .map((s) => ({ ...s, distance: Math.abs(s.value - setup.target) }))
    .sort((a, b) => a.distance - b.distance || a.seq - b.seq);
  const winner = candidates.length > 0 ? candidates[0] : null;
  const winnerPoints = winner ? (winner.distance === 0 ? CD_POINTS_EXACT : CD_POINTS_CLOSEST) : 0;
  if (winner) {
    draft.scores[winner.seat] = (draft.scores[winner.seat] ?? 0) + winnerPoints;
  }
  draft.history.push({
    round: draft.round,
    target: setup.target,
    numbers: [...setup.numbers],
    winnerSeat: winner ? winner.seat : null,
    entries: draft.players.map((p) => {
      const sub = draft.submissions.find((s) => s.seat === p.seat);
      const isWinner = winner !== null && winner.seat === p.seat;
      return {
        seat: p.seat,
        value: sub && active.has(p.seat) ? sub.value : null,
        distance: sub && active.has(p.seat) ? Math.abs(sub.value - setup.target) : null,
        points: isWinner ? winnerPoints : 0,
        steps: sub && active.has(p.seat) ? sub.steps : null,
        pick: sub && active.has(p.seat) ? sub.pick : null,
      };
    }),
  });
  draft.submissions = [];
  draft.phase = "reveal";
  draft.roundEndsAt = null;
  draft.revealEndsAt = now + CD_REVEAL_MS;
}

/** reveal を終えて次のラウンドへ進む（draft を破壊的に更新）。 */
function advance(draft: CountdownState, now: number): void {
  const next = draft.round + 1;
  draft.revealEndsAt = null;
  if (next >= draft.totalRounds) {
    draft.round = next;
    draft.phase = "finished";
    return;
  }
  draft.round = next;
  draft.phase = "playing";
  draft.roundEndsAt = now + CD_TIME_LIMIT_MS;
}

/** 全員（脱落を除く）が提出済みなら即締切する。 */
function closeIfAllSubmitted(draft: CountdownState, now: number): void {
  if (draft.phase !== "playing") return;
  const active = activeSeats(draft);
  if (active.length === 0) return;
  if (active.every((s) => draft.submissions.some((sub) => sub.seat === s))) closeRound(draft, now);
}

// ---------------------------------------------------------------- module

function createState(players: SeatInfo[], rng: Rng, _options: Record<string, unknown>): CountdownState {
  if (!Array.isArray(players) || players.length < 2 || players.length > 6) {
    throw new Error("数字カウントダウンは2〜6人で遊ぶゲームです");
  }
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const scores: Record<number, number> = {};
  for (const p of sorted) scores[p.seat] = 0;
  return {
    players: sorted.map((p) => ({ seat: p.seat, name: p.name })),
    leftSeats: [],
    round: 0,
    totalRounds: CD_TOTAL_ROUNDS,
    phase: "playing",
    roundEndsAt: Date.now() + CD_TIME_LIMIT_MS,
    revealEndsAt: null,
    setups: generateSetups(rng),
    submissions: [],
    submitSeq: 0,
    scores,
    history: [],
  };
}

function applyAction(state: CountdownState, seat: number, action: CountdownAction, _rng: Rng): CountdownState {
  if (!action || typeof action !== "object" || (action as { type?: unknown }).type !== "submit") {
    throw new Error("不明なアクションです");
  }
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished") throw new Error("ゲームは終了しています");
  if (state.phase !== "playing") throw new Error("今は提出できません");
  if (state.leftSeats.includes(seat)) throw new Error("退出したプレイヤーは提出できません");
  if (state.submissions.some((s) => s.seat === seat)) throw new Error("すでに提出しています");
  const now = Date.now();
  if (state.roundEndsAt !== null && now > state.roundEndsAt) {
    throw new Error("制限時間を過ぎています");
  }
  const setup = state.setups[state.round];
  const evaluated = evaluateCountdown(setup.numbers, { steps: action.steps, pick: action.pick });
  if (!evaluated.ok) throw new Error(evaluated.reason);
  const draft = clone(state);
  draft.submissions.push({
    seat,
    steps: clone(action.steps),
    pick: action.pick,
    value: evaluated.value,
    seq: draft.submitSeq++,
  });
  closeIfAllSubmitted(draft, now);
  return draft;
}

function viewFor(state: CountdownState, seat: number): CountdownView {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  const finished = state.phase === "finished";
  const revealing = state.phase === "reveal" || finished;
  const roundIndex = Math.min(state.round, state.totalRounds - 1);
  const setup = state.setups[roundIndex];
  const lastHistory = state.history[state.history.length - 1];
  const revealForCurrent = revealing && lastHistory && lastHistory.round === roundIndex;

  const players: CdViewPlayer[] = state.players.map((p) => {
    const entry: CdViewPlayer = {
      seat: p.seat,
      name: p.name,
      score: state.scores[p.seat] ?? 0,
      left: state.leftSeats.includes(p.seat),
      submitted:
        state.submissions.some((s) => s.seat === p.seat) ||
        (revealForCurrent && lastHistory
          ? lastHistory.entries.some((e) => e.seat === p.seat && e.value !== null)
          : false),
    };
    if (revealForCurrent && lastHistory) {
      const e = lastHistory.entries.find((x) => x.seat === p.seat);
      if (e) {
        entry.value = e.value;
        entry.distance = e.distance;
        entry.points = e.points;
        entry.steps = e.steps;
        entry.pick = e.pick;
      }
    }
    return entry;
  });

  const mySub = state.submissions.find((s) => s.seat === seat);
  let yourSteps: CdStep[] | null = mySub ? mySub.steps : null;
  let yourPick: number | null = mySub ? mySub.pick : null;
  let yourValue: number | null = mySub ? mySub.value : null;
  if (!mySub && revealForCurrent && lastHistory) {
    const e = lastHistory.entries.find((x) => x.seat === seat);
    if (e) {
      yourSteps = e.steps;
      yourPick = e.pick;
      yourValue = e.value;
    }
  }

  let standings: CountdownView["standings"] = null;
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
    round: roundIndex,
    totalRounds: state.totalRounds,
    roundEndsAt: state.roundEndsAt,
    revealEndsAt: state.revealEndsAt,
    target: setup.target,
    numbers: [...setup.numbers],
    you: {
      seat,
      left: state.leftSeats.includes(seat),
      submitted: players.find((p) => p.seat === seat)?.submitted ?? false,
      yourSteps,
      yourPick,
      yourValue,
    },
    players,
    history: state.history,
    standings,
  };
}

function isCdRef(value: unknown): value is CdRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return (
    (rec.kind === "num" || rec.kind === "step") &&
    Number.isInteger(rec.index) &&
    (rec.index as number) >= 0 &&
    (rec.index as number) < 100
  );
}

function parseAction(raw: unknown): CountdownAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.type !== "submit") return null;
  if (!Array.isArray(rec.steps) || rec.steps.length > CD_NUMBERS_PER_ROUND - 1) return null;
  const steps: CdStep[] = [];
  for (const rawStep of rec.steps) {
    if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) return null;
    const s = rawStep as Record<string, unknown>;
    if (!isCdRef(s.a) || !isCdRef(s.b)) return null;
    if (typeof s.op !== "string" || !(CD_OPS as readonly string[]).includes(s.op)) return null;
    steps.push({
      a: { kind: s.a.kind, index: s.a.index },
      op: s.op as CdOp,
      b: { kind: s.b.kind, index: s.b.index },
    });
  }
  let pick: number | null = null;
  if (rec.pick !== null && rec.pick !== undefined) {
    if (!Number.isInteger(rec.pick) || (rec.pick as number) < 0 || (rec.pick as number) >= CD_NUMBERS_PER_ROUND) {
      return null;
    }
    pick = rec.pick as number;
  }
  if (steps.length > 0) pick = null;
  return { type: "submit", steps, pick };
}

function onPlayerLeft(state: CountdownState, seat: number): CountdownState {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished" || state.leftSeats.includes(seat)) return state;
  const draft = clone(state);
  draft.leftSeats.push(seat);
  // 退出者は未提出扱い（そのラウンドの提出を取り消す）。
  draft.submissions = draft.submissions.filter((s) => s.seat !== seat);
  if (activeSeats(draft).length < 2) {
    draft.phase = "finished";
    draft.roundEndsAt = null;
    draft.revealEndsAt = null;
    return draft;
  }
  closeIfAllSubmitted(draft, Date.now());
  return draft;
}

function tick(state: CountdownState, now: number): CountdownState {
  if (state.phase === "playing" && state.roundEndsAt !== null && now >= state.roundEndsAt) {
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

export const gameModule: OnlineGameModule<CountdownState, CountdownAction, CountdownView> = {
  id: "countdown",
  title: "数字カウントダウン",
  minPlayers: 2,
  maxPlayers: 6,
  cpuSupported: false,
  chatEnabled: true,
  createState,
  applyAction,
  viewFor,
  parseAction,
  phaseOf: (state: CountdownState) => state.phase,
  isFinished: (state: CountdownState) => state.phase === "finished",
  onPlayerLeft,
  tick,
};
