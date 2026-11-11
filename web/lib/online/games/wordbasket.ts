// ワードバスケット（オンライン対戦）のルールモジュール。
// 基盤契約: import は type のみ（テストが import を剥がして連結する）。
// 状態は JSON 化可能な値だけ。applyAction / tick / onPlayerLeft は純関数。
// 流れ: prompt（20秒・全員が単語を出すか時間切れで締切）→ reveal（4秒・開示）→ 次のラウンド。全8ラウンド。
// 各ラウンド「お題（カテゴリ）＋頭文字」が提示され、条件を満たす単語を最初に出した人が得点する。
// 得点: 100 + 残り秒数（切り捨て）×5。2番目以降の採用単語は0点。
// 検証は形式ルールのみ（頭文字・2文字以上・ひらがな/カタカナのみ・そのラウンドで未使用）で、
// 単語の意味や実在は検証しない（お題に合っているかは形式上判定できない前提）。
// 形式違いの単語を送ると、そのラウンドだけ WB_LOCK_MS のあいだ再送できない。
// 採用された単語は締切まで秘匿し、viewFor では「採用済みかどうか」だけを公開する。
// 退出したプレイヤーは脱落扱いだが、スコアは保持して最終順位の対象に残る。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export type WbPhase = "prompt" | "reveal" | "finished";

export type WbPrompt = { category: string; initial: string };

/** お題プール（カテゴリ＋頭文字）。出題デッキはここから8件をシード決定的に選ぶ。 */
export const WB_PROMPTS: WbPrompt[] = [
  { category: "食べ物", initial: "あ" },
  { category: "食べ物", initial: "か" },
  { category: "食べ物", initial: "さ" },
  { category: "食べ物", initial: "た" },
  { category: "食べ物", initial: "ま" },
  { category: "動物", initial: "い" },
  { category: "動物", initial: "か" },
  { category: "動物", initial: "さ" },
  { category: "動物", initial: "ね" },
  { category: "動物", initial: "ぱ" },
  { category: "乗り物", initial: "で" },
  { category: "乗り物", initial: "ひ" },
  { category: "乗り物", initial: "と" },
  { category: "スポーツ", initial: "さ" },
  { category: "スポーツ", initial: "て" },
  { category: "スポーツ", initial: "や" },
  { category: "国の名前", initial: "あ" },
  { category: "国の名前", initial: "い" },
  { category: "国の名前", initial: "か" },
  { category: "国の名前", initial: "ふ" },
  { category: "家にあるもの", initial: "て" },
  { category: "家にあるもの", initial: "と" },
  { category: "家にあるもの", initial: "れ" },
  { category: "学校で使うもの", initial: "え" },
  { category: "学校で使うもの", initial: "の" },
  { category: "植物", initial: "あ" },
  { category: "植物", initial: "さ" },
  { category: "植物", initial: "ひ" },
  { category: "職業", initial: "い" },
  { category: "職業", initial: "か" },
  { category: "職業", initial: "せ" },
  { category: "色の名前", initial: "あ" },
  { category: "色の名前", initial: "き" },
  { category: "色の名前", initial: "み" },
];

export const WB_TOTAL_ROUNDS = 8;
export const WB_TIME_LIMIT_MS = 20000;
export const WB_REVEAL_MS = 4000;
export const WB_LOCK_MS = 3000;
export const WB_BASE_SCORE = 100;
export const WB_SPEED_BONUS_PER_SEC = 5;
export const WB_MIN_WORD_LENGTH = 2;
export const WB_MAX_WORD_LENGTH = 20;

export type WbSubmission = { seat: number; word: string; atMs: number; gained: number; first: boolean };

export type WbResultEntry = {
  seat: number;
  /** 採用単語なしは null。 */
  word: string | null;
  gained: number;
  first: boolean;
};

export type WbHistoryEntry = {
  roundIndex: number;
  category: string;
  initial: string;
  results: WbResultEntry[];
};

export interface WordBasketState {
  players: { seat: number; name: string }[];
  /** 退出した seat（脱落扱い、スコアは保持）。 */
  leftSeats: number[];
  prompts: WbPrompt[];
  index: number;
  phase: WbPhase;
  promptEndsAt: number | null;
  revealEndsAt: number | null;
  /** 内部のみ。締切まで viewFor で秘匿する（今ラウンドの採用単語）。 */
  submissions: WbSubmission[];
  /** seat → 再送できるようになる時刻（epoch ms）。ラウンドごとにリセット。 */
  lockedUntil: Record<number, number>;
  /** seat → 直近の形式違い通知（本人にだけ viewFor で返す）。 */
  notices: Record<number, { word: string; reason: string; atMs: number }>;
  scores: Record<number, number>;
  history: WbHistoryEntry[];
}

export type WordBasketAction = { type: "submit"; word: string };

export interface WbViewPlayer {
  seat: number;
  name: string;
  score: number;
  left: boolean;
  /** 今ラウンドに採用単語を出したか。 */
  answered: boolean;
  /** reveal / finished でのみ開示される採用単語（なしは null）。それ以外はキー自体なし。 */
  word?: string | null;
  gained?: number;
  first?: boolean;
}

export interface WordBasketView {
  phase: WbPhase;
  index: number;
  totalRounds: number;
  promptEndsAt: number | null;
  revealEndsAt: number | null;
  /** 現在のお題。finished では null。 */
  prompt: WbPrompt | null;
  you: {
    seat: number;
    answered: boolean;
    yourWord: string | null;
    lockedUntil: number | null;
    left: boolean;
    /** 直近の形式違いの理由（本人だけ）。なければ null。 */
    notice: string | null;
  };
  players: WbViewPlayer[];
  standings: { seat: number; score: number; rank: number }[] | null;
}

// ---------------------------------------------------------------- utilities

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 最初の採用単語の得点。残り時間（ms）から秒を切り捨ててボーナスを加える。 */
export function wbScoreFor(remainingMs: number): number {
  const sec = Math.max(0, Math.floor(remainingMs / 1000));
  return WB_BASE_SCORE + sec * WB_SPEED_BONUS_PER_SEC;
}

/** カタカナをひらがなへ寄せる（比較・重複チェック用）。 */
export function toHiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

export type WbValidation = { ok: true } | { ok: false; reason: string };

/**
 * 形式ルールの検証のみを行う（意味・実在は検証しない）。
 * usedWords はそのラウンドで既に採用された単語（原文）。
 */
export function validateBasketWord(word: unknown, prompt: WbPrompt, usedWords: string[]): WbValidation {
  if (typeof word !== "string") return { ok: false, reason: "単語が不正です" };
  const trimmed = word.trim();
  const chars = [...trimmed];
  if (chars.length < WB_MIN_WORD_LENGTH) {
    return { ok: false, reason: `${WB_MIN_WORD_LENGTH}文字以上の単語を送ってください` };
  }
  if (chars.length > WB_MAX_WORD_LENGTH) {
    return { ok: false, reason: `${WB_MAX_WORD_LENGTH}文字以下の単語を送ってください` };
  }
  if (!chars.every((ch) => /^[ぁ-んァ-ヶー]$/.test(ch))) {
    return { ok: false, reason: "ひらがな・カタカナだけの単語を送ってください" };
  }
  if (toHiragana(chars[0]) !== toHiragana(prompt.initial)) {
    return { ok: false, reason: `「${prompt.initial}」で始まる単語を送ってください` };
  }
  const normalized = toHiragana(trimmed);
  if (usedWords.some((w) => toHiragana(w) === normalized)) {
    return { ok: false, reason: "その単語はこのラウンドでもう使われています" };
  }
  return { ok: true };
}

function playerOf(state: WordBasketState, seat: number): { seat: number; name: string } | undefined {
  return state.players.find((p) => p.seat === seat);
}

function activeSeats(state: WordBasketState): number[] {
  return state.players.filter((p) => !state.leftSeats.includes(p.seat)).map((p) => p.seat);
}

function shuffled<T>(items: T[], rng: Rng): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 現在のラウンドを締め切り、結果を history に積んで reveal へ移す（draft を破壊的に更新）。 */
function closeRound(draft: WordBasketState, now: number): void {
  const prompt = draft.prompts[draft.index];
  if (!prompt) return;
  const results: WbResultEntry[] = draft.players.map((p) => {
    const sub = draft.submissions.find((s) => s.seat === p.seat);
    return {
      seat: p.seat,
      word: sub ? sub.word : null,
      gained: sub ? sub.gained : 0,
      first: sub ? sub.first : false,
    };
  });
  draft.history.push({ roundIndex: draft.index, category: prompt.category, initial: prompt.initial, results });
  draft.submissions = [];
  draft.lockedUntil = {};
  draft.phase = "reveal";
  draft.promptEndsAt = null;
  draft.revealEndsAt = now + WB_REVEAL_MS;
}

/** reveal を終えて次のラウンドへ進む（draft を破壊的に更新）。 */
function advance(draft: WordBasketState, now: number): void {
  const next = draft.index + 1;
  draft.revealEndsAt = null;
  draft.notices = {};
  if (next >= draft.prompts.length) {
    draft.index = next;
    draft.phase = "finished";
    return;
  }
  draft.index = next;
  draft.phase = "prompt";
  draft.promptEndsAt = now + WB_TIME_LIMIT_MS;
}

/** 全員（脱落を除く）が採用単語を出し終えたら即締切する。 */
function closeIfAllSubmitted(draft: WordBasketState, now: number): void {
  if (draft.phase !== "prompt") return;
  const active = activeSeats(draft);
  if (active.length === 0) return;
  if (active.every((s) => draft.submissions.some((x) => x.seat === s))) closeRound(draft, now);
}

// ---------------------------------------------------------------- module

function createState(players: SeatInfo[], rng: Rng, _options: Record<string, unknown>): WordBasketState {
  if (!Array.isArray(players) || players.length < 2 || players.length > 6) {
    throw new Error("ワードバスケットは2〜6人で遊ぶゲームです");
  }
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const scores: Record<number, number> = {};
  for (const p of sorted) scores[p.seat] = 0;
  return {
    players: sorted.map((p) => ({ seat: p.seat, name: p.name })),
    leftSeats: [],
    prompts: shuffled(WB_PROMPTS, rng).slice(0, WB_TOTAL_ROUNDS),
    index: 0,
    phase: "prompt",
    promptEndsAt: Date.now() + WB_TIME_LIMIT_MS,
    revealEndsAt: null,
    submissions: [],
    lockedUntil: {},
    notices: {},
    scores,
    history: [],
  };
}

function applyAction(state: WordBasketState, seat: number, action: WordBasketAction, _rng: Rng): WordBasketState {
  if (!action || typeof action !== "object" || (action as { type?: unknown }).type !== "submit") {
    throw new Error("不明なアクションです");
  }
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished") throw new Error("ゲームは終了しています");
  if (state.phase !== "prompt") throw new Error("今は単語を送れません");
  if (state.leftSeats.includes(seat)) throw new Error("退出したプレイヤーは参加できません");
  if (state.submissions.some((s) => s.seat === seat)) throw new Error("このラウンドはもう単語を出しています");

  const now = Date.now();
  if (state.promptEndsAt !== null && now > state.promptEndsAt) {
    throw new Error("制限時間を過ぎています");
  }
  const locked = state.lockedUntil[seat] ?? 0;
  if (locked > now) throw new Error("形式違いのあとは少し待ってから送ってください");

  const prompt = state.prompts[state.index];
  if (!prompt) throw new Error("お題がありません");
  const used = state.submissions.map((s) => s.word);
  const check = validateBasketWord((action as { word?: unknown }).word, prompt, used);

  const draft = clone(state);
  if (!check.ok) {
    // 形式違い: そのラウンドだけロックし、理由を本人向け通知に残す。
    draft.lockedUntil[seat] = now + WB_LOCK_MS;
    draft.notices[seat] = { word: String((action as { word?: unknown }).word ?? ""), reason: check.reason, atMs: now };
    return draft;
  }
  const word = (action.word as string).trim();
  const first = draft.submissions.length === 0;
  const gained = first ? wbScoreFor((state.promptEndsAt ?? now) - now) : 0;
  draft.submissions.push({ seat, word, atMs: now, gained, first });
  draft.scores[seat] = (draft.scores[seat] ?? 0) + gained;
  delete draft.notices[seat];
  closeIfAllSubmitted(draft, now);
  return draft;
}

function viewFor(state: WordBasketState, seat: number): WordBasketView {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  const finished = state.phase === "finished";
  const revealing = state.phase === "reveal" || finished;
  const lastHistory = state.history[state.history.length - 1];
  const revealForCurrent =
    revealing && lastHistory && lastHistory.roundIndex === (finished ? state.prompts.length - 1 : state.index);

  const players: WbViewPlayer[] = state.players.map((p) => {
    const entry: WbViewPlayer = {
      seat: p.seat,
      name: p.name,
      score: state.scores[p.seat] ?? 0,
      left: state.leftSeats.includes(p.seat),
      answered:
        state.submissions.some((s) => s.seat === p.seat) ||
        (revealing && lastHistory ? lastHistory.results.some((r) => r.seat === p.seat && r.word !== null) : false),
    };
    if (revealForCurrent && lastHistory) {
      const r = lastHistory.results.find((x) => x.seat === p.seat);
      if (r) {
        entry.word = r.word;
        entry.gained = r.gained;
        entry.first = r.first;
      }
    }
    return entry;
  });

  const prompt = !finished ? (state.prompts[state.index] ?? null) : null;
  const mySubmission = state.submissions.find((s) => s.seat === seat);
  let yourWord: string | null = mySubmission ? mySubmission.word : null;
  if (yourWord === null && revealForCurrent && lastHistory) {
    const r = lastHistory.results.find((x) => x.seat === seat);
    if (r) yourWord = r.word;
  }
  const notice = state.notices[seat];

  let standings: WordBasketView["standings"] = null;
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
    index: Math.min(state.index, state.prompts.length - 1),
    totalRounds: state.prompts.length,
    promptEndsAt: state.promptEndsAt,
    revealEndsAt: state.revealEndsAt,
    prompt: prompt ? { category: prompt.category, initial: prompt.initial } : null,
    you: {
      seat,
      answered: players.find((p) => p.seat === seat)?.answered ?? false,
      yourWord,
      lockedUntil: state.lockedUntil[seat] ?? null,
      left: state.leftSeats.includes(seat),
      notice: notice ? notice.reason : null,
    },
    players,
    standings,
  };
}

function parseAction(raw: unknown): WordBasketAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.type !== "submit") return null;
  if (typeof rec.word !== "string") return null;
  const len = [...rec.word.trim()].length;
  if (len < 1 || len > 30) return null;
  return { type: "submit", word: rec.word };
}

function onPlayerLeft(state: WordBasketState, seat: number): WordBasketState {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished" || state.leftSeats.includes(seat)) return state;
  const draft = clone(state);
  draft.leftSeats.push(seat);
  // スコアは保持し、最終順位の対象に残す。
  if (activeSeats(draft).length === 0) {
    draft.phase = "finished";
    draft.promptEndsAt = null;
    draft.revealEndsAt = null;
    return draft;
  }
  // 残り全員が単語を出し終えていたら締め切る。
  closeIfAllSubmitted(draft, Date.now());
  return draft;
}

function tick(state: WordBasketState, now: number): WordBasketState {
  if (state.phase === "prompt" && state.promptEndsAt !== null && now >= state.promptEndsAt) {
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

export const gameModule: OnlineGameModule<WordBasketState, WordBasketAction, WordBasketView> = {
  id: "wordbasket",
  title: "ワードバスケット",
  minPlayers: 2,
  maxPlayers: 6,
  cpuSupported: false,
  chatEnabled: true,
  createState,
  applyAction,
  viewFor,
  parseAction,
  phaseOf: (state: WordBasketState) => state.phase,
  isFinished: (state: WordBasketState) => state.phase === "finished",
  onPlayerLeft,
  tick,
};
