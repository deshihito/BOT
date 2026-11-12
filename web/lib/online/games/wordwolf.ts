// ワードウルフ（オンライン）のルールモジュール。
// 基盤契約: import は type のみ（テストが import を剥がして連結する）。
// 多数派と少数派（ウルフ1人）に似たお題ペアを配り、議論と投票でウルフを当てる。
// プレイヤー本人にも自分がウルフかどうかは知らされない（お題だけが渡る）。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export type WordwolfPhase = "discuss" | "vote" | "revote" | "finished";
export type WordwolfWinner = "majority" | "wolf";

export interface WordPair {
  majority: string;
  minority: string;
}

/** お題ペア（多数派 / 少数派）。近接した言葉のペア。 */
export const WORDWOLF_PAIRS: WordPair[] = [
  { majority: "りんご", minority: "なし" },
  { majority: "犬", minority: "猫" },
  { majority: "コーヒー", minority: "紅茶" },
  { majority: "電車", minority: "バス" },
  { majority: "サッカー", minority: "野球" },
  { majority: "映画", minority: "ドラマ" },
  { majority: "ラーメン", minority: "うどん" },
  { majority: "山", minority: "海" },
  { majority: "本", minority: "漫画" },
  { majority: "ケーキ", minority: "プリン" },
  { majority: "ピアノ", minority: "ギター" },
  { majority: "夏休み", minority: "冬休み" },
  { majority: "温泉", minority: "銭湯" },
  { majority: "飛行機", minority: "新幹線" },
  { majority: "鉛筆", minority: "シャープペンシル" },
  { majority: "冷蔵庫", minority: "冷凍庫" },
  { majority: "美容院", minority: "理容院" },
  { majority: "図書館", minority: "書店" },
  { majority: "公園", minority: "遊園地" },
  { majority: "誕生日", minority: "クリスマス" },
  { majority: "自転車", minority: "バイク" },
  { majority: "枕", minority: "布団" },
  { majority: "テニス", minority: "バドミントン" },
  { majority: "スキー", minority: "スノーボード" },
  { majority: "寿司", minority: "刺身" },
  { majority: "カレー", minority: "シチュー" },
  { majority: "雪", minority: "雨" },
  { majority: "学校", minority: "塾" },
  { majority: "病院", minority: "薬局" },
  { majority: "傘", minority: "レインコート" },
  { majority: "財布", minority: "小銭入れ" },
  { majority: "洗濯機", minority: "乾燥機" },
  { majority: "船", minority: "ヨット" },
  { majority: "結婚式", minority: "成人式" },
  { majority: "消防車", minority: "救急車" },
  { majority: "眼鏡", minority: "コンタクトレンズ" },
  { majority: "味噌汁", minority: "スープ" },
  { majority: "バナナ", minority: "メロン" },
  { majority: "いちご", minority: "さくらんぼ" },
  { majority: "ハンバーガー", minority: "ピザ" },
  { majority: "そば", minority: "そうめん" },
  { majority: "タクシー", minority: "レンタカー" },
  { majority: "プール", minority: "海水浴場" },
  { majority: "将棋", minority: "囲碁" },
  { majority: "かき氷", minority: "アイスクリーム" },
  { majority: "花火大会", minority: "お祭り" },
  { majority: "金魚", minority: "メダカ" },
  { majority: "エレベーター", minority: "エスカレーター" },
  { majority: "パスポート", minority: "運転免許証" },
  { majority: "扇風機", minority: "エアコン" },
  { majority: "チャーハン", minority: "オムライス" },
  { majority: "窓", minority: "ドア" },
  { majority: "朝ごはん", minority: "夜ごはん" },
  { majority: "サンダル", minority: "スニーカー" },
  { majority: "歯ブラシ", minority: "歯磨き粉" },
  { majority: "正月", minority: "お盆" },
  { majority: "カラオケ", minority: "ボウリング" },
  { majority: "ホテル", minority: "旅館" },
  { majority: "おにぎり", minority: "サンドイッチ" },
  { majority: "牛乳", minority: "ジュース" },
  { majority: "みかん", minority: "ぶどう" },
  { majority: "パン", minority: "トースト" },
  { majority: "テレビ", minority: "ラジオ" },
  { majority: "ノート", minority: "手帳" },
  { majority: "帽子", minority: "マフラー" },
  { majority: "腕時計", minority: "指輪" },
  { majority: "バラ", minority: "チューリップ" },
  { majority: "ペンギン", minority: "あざらし" },
  { majority: "ヨーグルト", minority: "チーズ" },
  { majority: "ベッド", minority: "ソファー" },
  { majority: "神社", minority: "お寺" },
  { majority: "ドーナツ", minority: "ベーグル" },
  { majority: "ネックレス", minority: "ブレスレット" },
  { majority: "クッキー", minority: "クラッカー" },
  { majority: "扇子", minority: "うちわ" },
  { majority: "地下鉄", minority: "モノレール" },
  { majority: "黒板", minority: "ホワイトボード" },
  { majority: "そろばん", minority: "電卓" },
  { majority: "朝日", minority: "夕日" },
  { majority: "クジラ", minority: "イルカ" },
];

export interface WordwolfState {
  players: { seat: number; name: string }[];
  pair: WordPair;
  wolfSeat: number;
  /** seat -> その人に配られたお題（内部のみ）。 */
  words: Record<number, string>;
  left: boolean[];
  phase: WordwolfPhase;
  discussionSec: number;
  discussionEndsAt: number | null;
  /** 投票・決選投票フェーズの締切（ms epoch）。それ以外のフェーズは null。 */
  voteEndsAt: number | null;
  readySeats: number[];
  votes: { seat: number; target: number }[];
  revoteUsed: boolean;
  /** 決選投票の候補（revote フェーズのみ有効）。 */
  tiedCandidates: number[];
  winner: WordwolfWinner | null;
  /** 終了時に投票で指名された seat（逃げ切り時は null のことがある）。 */
  caughtSeat: number | null;
  /** 終了時の集計（target -> 票数）。 */
  tally: Record<number, number>;
}

export type WordwolfAction = { type: "ready" } | { type: "vote"; target: number };

export interface WordwolfViewPlayer {
  seat: number;
  name: string;
  left: boolean;
  voted: boolean;
  ready: boolean;
}

export interface WordwolfView {
  phase: WordwolfPhase;
  discussionSec: number;
  discussionEndsAt: number | null;
  /** 投票・決選投票フェーズの締切（ms epoch）。それ以外のフェーズは null。 */
  voteEndsAt: number | null;
  /** 自分のお題だけが見える。他人のお題・ウルフは出さない。 */
  you: { word: string; left: boolean; voted: boolean; ready: boolean };
  players: WordwolfViewPlayer[];
  revote: boolean;
  tiedCandidates: number[];
  result: {
    winner: WordwolfWinner;
    wolfSeat: number;
    majorityWord: string;
    minorityWord: string;
    caughtSeat: number | null;
    tally: Record<number, number>;
  } | null;
}

// ---------------------------------------------------------------- utilities

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const DISCUSSION_CHOICES = [120, 180, 240] as const;
const DEFAULT_DISCUSSION_SEC = 180;
/** 投票・決選投票の制限時間（ms）。締切時点で未投票の人は棄権扱い。 */
export const WW_VOTE_TIME_MS = 60000;

function normalizeDiscussionSec(value: unknown): number {
  if (value === undefined) return DEFAULT_DISCUSSION_SEC;
  if (typeof value !== "number" || !(DISCUSSION_CHOICES as readonly number[]).includes(value)) {
    throw new Error("議論時間は120・180・240秒のいずれかで指定してください");
  }
  return value;
}

function playerOf(state: WordwolfState, seat: number): { seat: number; name: string } | undefined {
  return state.players.find((p) => p.seat === seat);
}

function activeSeats(state: WordwolfState): number[] {
  return state.players.filter((p) => !state.left[p.seat]).map((p) => p.seat);
}

function finish(draft: WordwolfState, winner: WordwolfWinner, caughtSeat: number | null): void {
  draft.winner = winner;
  draft.caughtSeat = caughtSeat;
  draft.phase = "finished";
  draft.discussionEndsAt = null;
  draft.voteEndsAt = null;
  const tally: Record<number, number> = {};
  for (const v of draft.votes) tally[v.target] = (tally[v.target] ?? 0) + 1;
  draft.tally = tally;
}

function enterVote(draft: WordwolfState, now: number): void {
  draft.phase = "vote";
  draft.votes = [];
  draft.revoteUsed = false;
  draft.tiedCandidates = [];
  draft.discussionEndsAt = null;
  draft.voteEndsAt = now + WW_VOTE_TIME_MS;
  draft.readySeats = [];
}

/** 投票を集計する（draft を破壊的に更新する内部用）。 */
function resolveVotes(draft: WordwolfState, now: number): void {
  const counts = new Map<number, number>();
  for (const v of draft.votes) counts.set(v.target, (counts.get(v.target) ?? 0) + 1);
  let max = 0;
  for (const c of counts.values()) if (c > max) max = c;
  const tops = [...counts.keys()].filter((t) => counts.get(t) === max).sort((a, b) => a - b);

  if (tops.length === 1) {
    const target = tops[0];
    const caught = target === draft.wolfSeat;
    finish(draft, caught ? "majority" : "wolf", target);
    return;
  }
  // 同票。
  if (draft.phase === "vote" && !draft.revoteUsed) {
    draft.revoteUsed = true;
    draft.tiedCandidates = tops;
    draft.votes = [];
    draft.phase = "revote";
    draft.voteEndsAt = now + WW_VOTE_TIME_MS;
    return;
  }
  // 決選でも同票、または投票なし → ウルフの逃げ切り勝ち。
  finish(draft, "wolf", null);
}

/** 残り人数の異常終了チェック。true なら終了済み。 */
function finishIfBroken(draft: WordwolfState): boolean {
  if (draft.phase === "finished") return true;
  const active = activeSeats(draft);
  // ウルフが抜けたら多数派の勝ち。
  if (draft.left[draft.wolfSeat]) {
    finish(draft, "majority", null);
    return true;
  }
  // 投票が成立しない人数になったらウルフの逃げ切り。
  if (active.length < 3) {
    finish(draft, "wolf", null);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- module

function createState(
  players: SeatInfo[],
  rng: Rng,
  options: Record<string, unknown>,
): WordwolfState {
  if (!Array.isArray(players) || players.length < 3 || players.length > 6) {
    throw new Error("ワードウルフは3〜6人で遊ぶゲームです");
  }
  const discussionSec = normalizeDiscussionSec(options ? options.discussionSec : undefined);
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const pair = WORDWOLF_PAIRS[Math.floor(rng() * WORDWOLF_PAIRS.length) % WORDWOLF_PAIRS.length];
  const wolfSeat = sorted[Math.floor(rng() * sorted.length) % sorted.length].seat;
  const words: Record<number, string> = {};
  const left: boolean[] = [];
  for (const p of sorted) {
    words[p.seat] = p.seat === wolfSeat ? pair.minority : pair.majority;
    left[p.seat] = false;
  }
  return {
    players: sorted.map((p) => ({ seat: p.seat, name: p.name })),
    pair: { ...pair },
    wolfSeat,
    words,
    left,
    phase: "discuss",
    discussionSec,
    discussionEndsAt: Date.now() + discussionSec * 1000,
    voteEndsAt: null,
    readySeats: [],
    votes: [],
    revoteUsed: false,
    tiedCandidates: [],
    winner: null,
    caughtSeat: null,
    tally: {},
  };
}

function applyAction(state: WordwolfState, seat: number, action: WordwolfAction, _rng: Rng): WordwolfState {
  if (!action || typeof action !== "object" || typeof (action as { type?: unknown }).type !== "string") {
    throw new Error("不明なアクションです");
  }
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished") throw new Error("ゲームは終了しています");
  if (state.left[seat]) throw new Error("退出したプレイヤーは行動できません");

  const draft = clone(state);

  if (action.type === "ready") {
    if (draft.phase !== "discuss") throw new Error("今は議論フェーズではありません");
    if (draft.readySeats.includes(seat)) throw new Error("すでに準備完了しています");
    draft.readySeats.push(seat);
    if (activeSeats(draft).every((s) => draft.readySeats.includes(s))) enterVote(draft, Date.now());
    return draft;
  }

  if (action.type === "vote") {
    if (draft.phase !== "vote" && draft.phase !== "revote") throw new Error("今は投票フェーズではありません");
    const target = action.target;
    if (typeof target !== "number" || !Number.isInteger(target) || !playerOf(draft, target)) {
      throw new Error("投票先が不正です");
    }
    if (target === seat) throw new Error("自分には投票できません");
    if (draft.left[target]) throw new Error("退出したプレイヤーには投票できません");
    if (draft.phase === "revote" && !draft.tiedCandidates.includes(target)) {
      throw new Error("決選投票では同票だった候補にだけ投票できます");
    }
    if (draft.votes.some((v) => v.seat === seat)) throw new Error("すでに投票しています");
    draft.votes.push({ seat, target });
    if (activeSeats(draft).every((s) => draft.votes.some((v) => v.seat === s))) resolveVotes(draft, Date.now());
    return draft;
  }

  throw new Error("不明なアクションです");
}

function viewFor(state: WordwolfState, seat: number): WordwolfView {
  const viewer = playerOf(state, seat);
  if (!viewer) throw new Error("プレイヤーが存在しません");
  const finished = state.phase === "finished";
  return {
    phase: state.phase,
    discussionSec: state.discussionSec,
    discussionEndsAt: state.discussionEndsAt,
    voteEndsAt: state.voteEndsAt,
    you: {
      word: state.words[seat],
      left: Boolean(state.left[seat]),
      voted: state.votes.some((v) => v.seat === seat),
      ready: state.readySeats.includes(seat),
    },
    players: state.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      left: Boolean(state.left[p.seat]),
      voted: state.votes.some((v) => v.seat === p.seat),
      ready: state.readySeats.includes(p.seat),
    })),
    revote: state.revoteUsed,
    tiedCandidates: state.phase === "revote" ? [...state.tiedCandidates] : [],
    result: finished
      ? {
          winner: state.winner ?? "wolf",
          wolfSeat: state.wolfSeat,
          majorityWord: state.pair.majority,
          minorityWord: state.pair.minority,
          caughtSeat: state.caughtSeat,
          tally: { ...state.tally },
        }
      : null,
  };
}

function parseAction(raw: unknown): WordwolfAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
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

function onPlayerLeft(state: WordwolfState, seat: number): WordwolfState {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished" || state.left[seat]) return state;
  const draft = clone(state);
  draft.left[seat] = true;
  // 退出者の投票・準備は取り消し、退出者への投票も無効化する。
  draft.readySeats = draft.readySeats.filter((s) => s !== seat);
  draft.votes = draft.votes.filter((v) => v.seat !== seat && v.target !== seat);
  // 決選候補から退出者が抜け、候補が1人になればその人を指名して決着。
  if (draft.phase === "revote") {
    draft.tiedCandidates = draft.tiedCandidates.filter((s) => s !== seat);
    if (draft.tiedCandidates.length === 1) {
      const target = draft.tiedCandidates[0];
      draft.votes = [];
      finish(draft, target === draft.wolfSeat ? "majority" : "wolf", target);
      return draft;
    }
    if (draft.tiedCandidates.length === 0) {
      finish(draft, "wolf", null);
      return draft;
    }
  }
  if (finishIfBroken(draft)) return draft;
  if (draft.phase === "discuss") {
    const active = activeSeats(draft);
    if (active.length > 0 && active.every((s) => draft.readySeats.includes(s))) enterVote(draft, Date.now());
  } else if (draft.phase === "vote" || draft.phase === "revote") {
    const active = activeSeats(draft);
    if (active.length > 0 && active.every((s) => draft.votes.some((v) => v.seat === s))) resolveVotes(draft, Date.now());
  }
  return draft;
}

function tick(state: WordwolfState, now: number): WordwolfState {
  if (state.phase === "discuss" && state.discussionEndsAt !== null && now >= state.discussionEndsAt) {
    const draft = clone(state);
    enterVote(draft, now);
    return draft;
  }
  if (
    (state.phase === "vote" || state.phase === "revote") &&
    state.voteEndsAt !== null &&
    now >= state.voteEndsAt
  ) {
    // 締切: 未投票者は棄権扱いとし、入っている票だけで集計する。
    // 1票も入っていなければ誰も指名されず、ウルフの逃げ切り勝ち。
    const draft = clone(state);
    if (draft.votes.length === 0) {
      finish(draft, "wolf", null);
    } else {
      resolveVotes(draft, now);
    }
    return draft;
  }
  return state;
}

export const gameModule: OnlineGameModule<WordwolfState, WordwolfAction, WordwolfView> = {
  id: "wordwolf",
  title: "ワードウルフ",
  minPlayers: 3,
  maxPlayers: 6,
  cpuSupported: false,
  chatEnabled: true,
  createState,
  applyAction,
  viewFor,
  parseAction,
  parseOptions,
  phaseOf: (state: WordwolfState) => state.phase,
  isFinished: (state: WordwolfState) => state.phase === "finished",
  onPlayerLeft,
  tick,
};
