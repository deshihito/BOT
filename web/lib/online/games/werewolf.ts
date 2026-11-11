// 人狼（オンライン対戦）のルールモジュール。
// 基盤契約: import は type のみ（テストが import を剥がして連結する）。
// 状態は JSON 化可能な値だけ。applyAction / tick / onPlayerLeft は純関数。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export type WerewolfRole = "wolf" | "seer" | "hunter" | "villager";
export type WerewolfPhase = "night" | "day" | "vote" | "finished";
export type WerewolfWinner = "village" | "wolf";

export interface WerewolfNightState {
  wolfVotes: { seat: number; target: number }[];
  seerTarget: number | null;
  hunterTarget: number | null;
}

export interface Divination {
  day: number;
  target: number;
  isWolf: boolean;
}

export interface WerewolfState {
  players: { seat: number; name: string }[];
  /** 内部のみ。ビューには公開分しか出さない。 */
  roles: Record<number, WerewolfRole>;
  /** seat 順。 */
  alive: boolean[];
  dayCount: number;
  phase: WerewolfPhase;
  night: WerewolfNightState;
  divinations: Record<number, Divination[]>;
  readySeats: number[];
  votes: { seat: number; target: number }[];
  revoteUsed: boolean;
  lastNightResult: { deadSeat: number | null } | null;
  lastExecution: { deadSeat: number | null; tied: boolean } | null;
  winner: WerewolfWinner | null;
  discussionSec: number;
  dayEndsAt: number | null;
  revealedRoles: Record<number, WerewolfRole>;
  /** 死亡理由（seat -> "attack" | "execute" | "left"）。ビューで死因を区別するため。 */
  deathCauses: Record<number, string>;
}

export type WerewolfAction =
  | { type: "nightAction"; target: number }
  | { type: "ready" }
  | { type: "vote"; target: number };

export interface WerewolfViewPlayer {
  seat: number;
  name: string;
  alive: boolean;
  role?: WerewolfRole;
  deathCause?: string;
}

export interface WerewolfView {
  phase: WerewolfPhase;
  dayCount: number;
  you: { role: WerewolfRole; alive: boolean };
  players: WerewolfViewPlayer[];
  /** 人狼の閲覧者だけに付くキー（味方を含む全人狼 seat）。 */
  wolves?: number[];
  night: { submitted: boolean; seerResults: Divination[] };
  day: { endsAt: number | null; readySeats: number[]; readyCount: number; aliveCount: number };
  vote: { submitted: boolean; votedCount: number; aliveCount: number; revote: boolean };
  lastNightResult: { deadSeat: number | null } | null;
  lastExecution: { deadSeat: number | null; tied: boolean } | null;
  winner: WerewolfWinner | null;
  discussionSec: number;
}

// ---------------------------------------------------------------- utilities

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeDiscussionSec(value: unknown): number {
  if (value === undefined) return 120;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("discussionSecは数値で指定してください");
  }
  return Math.min(600, Math.max(30, Math.round(value)));
}

function roleListFor(count: number): WerewolfRole[] {
  switch (count) {
    case 4:
      return ["wolf", "seer", "villager", "villager"];
    case 5:
      return ["wolf", "seer", "hunter", "villager", "villager"];
    case 6:
      return ["wolf", "wolf", "seer", "hunter", "villager", "villager"];
    case 7:
      return ["wolf", "wolf", "seer", "hunter", "villager", "villager", "villager"];
    case 8:
      return ["wolf", "wolf", "seer", "hunter", "villager", "villager", "villager", "villager"];
    default:
      throw new Error("人狼は4〜8人で遊ぶゲームです");
  }
}

function playerOf(state: WerewolfState, seat: number): { seat: number; name: string } | undefined {
  return state.players.find((p) => p.seat === seat);
}

function aliveSeats(state: WerewolfState): number[] {
  return state.players.filter((p) => state.alive[p.seat]).map((p) => p.seat);
}

function aliveCount(state: WerewolfState): number {
  return aliveSeats(state).length;
}

function computeWinner(state: WerewolfState): WerewolfWinner | null {
  let wolves = 0;
  let others = 0;
  for (const p of state.players) {
    if (!state.alive[p.seat]) continue;
    if (state.roles[p.seat] === "wolf") wolves += 1;
    else others += 1;
  }
  if (wolves === 0) return "village";
  if (wolves >= others) return "wolf";
  return null;
}

/** 勝敗が決まっていれば draft を終了状態にして true。 */
function finishIfWinner(draft: WerewolfState): boolean {
  const winner = computeWinner(draft);
  if (!winner) return false;
  draft.winner = winner;
  draft.phase = "finished";
  draft.dayEndsAt = null;
  for (const p of draft.players) {
    draft.revealedRoles[p.seat] = draft.roles[p.seat];
  }
  return true;
}

function emptyNight(): WerewolfNightState {
  return { wolfVotes: [], seerTarget: null, hunterTarget: null };
}

function kill(draft: WerewolfState, seat: number, cause: string): void {
  draft.alive[seat] = false;
  draft.revealedRoles[seat] = draft.roles[seat];
  draft.deathCauses[seat] = cause;
}

/** 生存している「必要な役職者」が全員 submit 済みか。 */
function nightAllSubmitted(state: WerewolfState): boolean {
  for (const p of state.players) {
    if (!state.alive[p.seat]) continue;
    const role = state.roles[p.seat];
    if (role === "wolf") {
      if (!state.night.wolfVotes.some((v) => v.seat === p.seat)) return false;
    } else if (role === "seer") {
      if (state.night.seerTarget === null) return false;
    } else if (role === "hunter") {
      if (state.night.hunterTarget === null) return false;
    }
  }
  return true;
}

function decideWolfTarget(wolfVotes: { seat: number; target: number }[]): number | null {
  if (wolfVotes.length === 0) return null;
  const counts = new Map<number, number>();
  const firstIndex = new Map<number, number>();
  wolfVotes.forEach((v, i) => {
    counts.set(v.target, (counts.get(v.target) ?? 0) + 1);
    if (!firstIndex.has(v.target)) firstIndex.set(v.target, i);
  });
  let best: number | null = null;
  for (const target of counts.keys()) {
    if (best === null) {
      best = target;
      continue;
    }
    const c = counts.get(target) ?? 0;
    const bc = counts.get(best) ?? 0;
    if (c > bc) best = target;
    else if (c === bc && (firstIndex.get(target) ?? 0) < (firstIndex.get(best) ?? 0)) best = target;
  }
  return best;
}

/** 夜を解決する（draft を破壊的に更新する内部用）。 */
function resolveNight(draft: WerewolfState): void {
  const wolfTarget = decideWolfTarget(draft.night.wolfVotes);
  const hunterTarget = draft.night.hunterTarget;
  let deadSeat: number | null = null;
  if (wolfTarget !== null && wolfTarget !== hunterTarget && draft.alive[wolfTarget]) {
    kill(draft, wolfTarget, "attack");
    deadSeat = wolfTarget;
  }
  draft.lastNightResult = { deadSeat };
  draft.night = emptyNight();
  draft.readySeats = [];
  draft.votes = [];
  draft.revoteUsed = false;
  draft.dayEndsAt = null;
  if (finishIfWinner(draft)) return;
  draft.phase = "day";
  draft.dayEndsAt = Date.now() + draft.discussionSec * 1000;
}

function enterVote(draft: WerewolfState): void {
  draft.phase = "vote";
  draft.votes = [];
  draft.revoteUsed = false;
  draft.dayEndsAt = null;
}

/** 投票を集計する（draft を破壊的に更新する内部用）。 */
function resolveVote(draft: WerewolfState): void {
  const counts = new Map<number, number>();
  const firstIndex = new Map<number, number>();
  draft.votes.forEach((v, i) => {
    counts.set(v.target, (counts.get(v.target) ?? 0) + 1);
    if (!firstIndex.has(v.target)) firstIndex.set(v.target, i);
  });
  let max = 0;
  for (const c of counts.values()) if (c > max) max = c;
  const tops = [...counts.keys()]
    .filter((t) => counts.get(t) === max)
    .sort((a, b) => (firstIndex.get(a) ?? 0) - (firstIndex.get(b) ?? 0));

  if (tops.length > 1) {
    if (!draft.revoteUsed) {
      // 再投票1回だけ。同フェーズで継続する。
      draft.revoteUsed = true;
      draft.votes = [];
      return;
    }
    draft.lastExecution = { deadSeat: null, tied: true };
  } else if (tops.length === 1) {
    const target = tops[0];
    if (draft.alive[target]) kill(draft, target, "execute");
    draft.lastExecution = { deadSeat: target, tied: false };
  } else {
    draft.lastExecution = { deadSeat: null, tied: false };
  }

  draft.votes = [];
  if (finishIfWinner(draft)) return;
  // 次の夜へ。
  draft.phase = "night";
  draft.dayCount += 1;
  draft.night = emptyNight();
  draft.readySeats = [];
  draft.revoteUsed = false;
  draft.dayEndsAt = null;
}

function assertValidTarget(state: WerewolfState, seat: number, target: unknown): number {
  if (typeof target !== "number" || !Number.isInteger(target) || !playerOf(state, target)) {
    throw new Error("対象が不正です");
  }
  if (target === seat) throw new Error("自分は選べません");
  if (!state.alive[target]) throw new Error("死亡しているプレイヤーは選べません");
  return target;
}

// ---------------------------------------------------------------- module

function createState(
  players: SeatInfo[],
  rng: Rng,
  options: Record<string, unknown>,
): WerewolfState {
  if (!Array.isArray(players) || players.length < 4 || players.length > 8) {
    throw new Error("人狼は4〜8人で遊ぶゲームです");
  }
  const discussionSec = normalizeDiscussionSec(options ? options.discussionSec : undefined);
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const deck = roleListFor(sorted.length);
  // rng シャッフル（Fisher-Yates）
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  const roles: Record<number, WerewolfRole> = {};
  sorted.forEach((p, i) => {
    roles[p.seat] = deck[i];
  });
  return {
    players: sorted.map((p) => ({ seat: p.seat, name: p.name })),
    roles,
    alive: sorted.map(() => true),
    dayCount: 1,
    phase: "night",
    night: emptyNight(),
    divinations: {},
    readySeats: [],
    votes: [],
    revoteUsed: false,
    lastNightResult: null,
    lastExecution: null,
    winner: null,
    discussionSec,
    dayEndsAt: null,
    revealedRoles: {},
    deathCauses: {},
  };
}

function applyAction(state: WerewolfState, seat: number, action: WerewolfAction, _rng: Rng): WerewolfState {
  if (!action || typeof action !== "object" || typeof (action as { type?: unknown }).type !== "string") {
    throw new Error("不明なアクションです");
  }
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished") throw new Error("ゲームは終了しています");

  const draft = clone(state);

  if (action.type === "nightAction") {
    if (draft.phase !== "night") throw new Error("今は夜ではありません");
    if (!draft.alive[seat]) throw new Error("死亡しているプレイヤーは行動できません");
    const role = draft.roles[seat];
    if (role === "villager") throw new Error("村人は夜に行動できません");
    const target = assertValidTarget(draft, seat, action.target);
    if (role === "wolf") {
      if (draft.roles[target] === "wolf") throw new Error("人狼は人狼を襲撃できません");
      if (draft.night.wolfVotes.some((v) => v.seat === seat)) throw new Error("すでに提出しています");
      draft.night.wolfVotes.push({ seat, target });
    } else if (role === "seer") {
      if (draft.night.seerTarget !== null) throw new Error("すでに提出しています");
      draft.night.seerTarget = target;
      const list = draft.divinations[seat] ? [...draft.divinations[seat]] : [];
      list.push({ day: draft.dayCount, target, isWolf: draft.roles[target] === "wolf" });
      draft.divinations[seat] = list;
    } else if (role === "hunter") {
      if (draft.night.hunterTarget !== null) throw new Error("すでに提出しています");
      draft.night.hunterTarget = target;
    }
    if (nightAllSubmitted(draft)) resolveNight(draft);
    return draft;
  }

  if (action.type === "ready") {
    if (draft.phase !== "day") throw new Error("今は昼ではありません");
    if (!draft.alive[seat]) throw new Error("死亡しているプレイヤーは行動できません");
    if (draft.readySeats.includes(seat)) throw new Error("すでに進行の意思表示をしています");
    draft.readySeats.push(seat);
    if (aliveSeats(draft).every((s) => draft.readySeats.includes(s))) enterVote(draft);
    return draft;
  }

  if (action.type === "vote") {
    if (draft.phase !== "vote") throw new Error("今は投票フェーズではありません");
    if (!draft.alive[seat]) throw new Error("死亡しているプレイヤーは行動できません");
    const target = assertValidTarget(draft, seat, action.target);
    if (draft.votes.some((v) => v.seat === seat)) throw new Error("すでに投票しています");
    draft.votes.push({ seat, target });
    if (aliveSeats(draft).every((s) => draft.votes.some((v) => v.seat === s))) resolveVote(draft);
    return draft;
  }

  throw new Error("不明なアクションです");
}

function viewFor(state: WerewolfState, seat: number): WerewolfView {
  const viewer = playerOf(state, seat);
  if (!viewer) throw new Error("プレイヤーが存在しません");
  const myRole = state.roles[seat];
  const finished = state.phase === "finished";
  const players: WerewolfViewPlayer[] = state.players.map((p) => {
    const entry: WerewolfViewPlayer = { seat: p.seat, name: p.name, alive: state.alive[p.seat] };
    if (finished || state.revealedRoles[p.seat] !== undefined) {
      entry.role = state.roles[p.seat];
    }
    if (!state.alive[p.seat] && state.deathCauses[p.seat] !== undefined) {
      entry.deathCause = state.deathCauses[p.seat];
    }
    return entry;
  });

  let nightSubmitted = false;
  if (myRole === "wolf") nightSubmitted = state.night.wolfVotes.some((v) => v.seat === seat);
  else if (myRole === "seer") nightSubmitted = state.night.seerTarget !== null;
  else if (myRole === "hunter") nightSubmitted = state.night.hunterTarget !== null;

  const view: WerewolfView = {
    phase: state.phase,
    dayCount: state.dayCount,
    you: { role: myRole, alive: state.alive[seat] },
    players,
    night: {
      submitted: nightSubmitted,
      // 占い履歴は占い師本人にだけ渡す（他人には空配列）。
      seerResults: myRole === "seer" ? clone(state.divinations[seat] ?? []) : [],
    },
    day: {
      endsAt: state.dayEndsAt,
      readySeats: [...state.readySeats],
      readyCount: state.readySeats.length,
      aliveCount: aliveCount(state),
    },
    vote: {
      submitted: state.votes.some((v) => v.seat === seat),
      votedCount: state.votes.length,
      aliveCount: aliveCount(state),
      revote: state.revoteUsed,
    },
    lastNightResult: state.lastNightResult ? { ...state.lastNightResult } : null,
    lastExecution: state.lastExecution ? { ...state.lastExecution } : null,
    winner: state.winner,
    discussionSec: state.discussionSec,
  };
  if (myRole === "wolf") {
    view.wolves = state.players.filter((p) => state.roles[p.seat] === "wolf").map((p) => p.seat);
  }
  return view;
}

function parseAction(raw: unknown): WerewolfAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.type === "nightAction") {
    if (typeof rec.target !== "number" || !Number.isInteger(rec.target) || rec.target < 0) return null;
    return { type: "nightAction", target: rec.target };
  }
  if (rec.type === "ready") return { type: "ready" };
  if (rec.type === "vote") {
    if (typeof rec.target !== "number" || !Number.isInteger(rec.target) || rec.target < 0) return null;
    return { type: "vote", target: rec.target };
  }
  return null;
}

function parseOptions(raw: Record<string, unknown>): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("オプションが不正です");
  }
  return { discussionSec: normalizeDiscussionSec(raw.discussionSec) };
}

function onPlayerLeft(state: WerewolfState, seat: number): WerewolfState {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished" || !state.alive[seat]) return state;

  const draft = clone(state);
  const role = draft.roles[seat];
  kill(draft, seat, "left");

  // 退出者の提出は取り消す。退出者を狙った襲撃・投票も無効化し、選び直せるようにする。
  draft.readySeats = draft.readySeats.filter((s) => s !== seat);
  draft.night.wolfVotes = draft.night.wolfVotes.filter((v) => v.seat !== seat && v.target !== seat);
  if (role === "seer") draft.night.seerTarget = null;
  if (role === "hunter") draft.night.hunterTarget = null;
  // 護衛先が退出した場合は選び直せる（占いは結果取得済みなので提出済みのまま）。
  if (draft.night.hunterTarget === seat) draft.night.hunterTarget = null;
  draft.votes = draft.votes.filter((v) => v.seat !== seat && v.target !== seat);

  if (finishIfWinner(draft)) return draft;

  // 未提出待ちで詰まらないよう、現在フェーズの進行判定を再評価する。
  if (draft.phase === "night") {
    if (nightAllSubmitted(draft) && draft.night.wolfVotes.length > 0) resolveNight(draft);
  } else if (draft.phase === "day") {
    const alive = aliveSeats(draft);
    if (alive.length > 0 && alive.every((s) => draft.readySeats.includes(s))) enterVote(draft);
  } else if (draft.phase === "vote") {
    const alive = aliveSeats(draft);
    if (alive.length > 0 && alive.every((s) => draft.votes.some((v) => v.seat === s))) resolveVote(draft);
  }
  return draft;
}

function tick(state: WerewolfState, now: number): WerewolfState {
  if (state.phase === "day" && state.dayEndsAt !== null && now >= state.dayEndsAt) {
    const draft = clone(state);
    enterVote(draft);
    return draft;
  }
  return state;
}

export const gameModule: OnlineGameModule<WerewolfState, WerewolfAction, WerewolfView> = {
  id: "werewolf",
  title: "人狼",
  minPlayers: 4,
  maxPlayers: 8,
  cpuSupported: false,
  chatEnabled: false,
  createState,
  applyAction,
  viewFor,
  parseAction,
  parseOptions,
  phaseOf: (state: WerewolfState) => state.phase,
  isFinished: (state: WerewolfState) => state.phase === "finished",
  onPlayerLeft,
  tick,
};
