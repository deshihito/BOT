// お絵かき当て（オンライン対戦）のルールモジュール。
// 基盤契約: import は type のみ（テストが import を剥がして連結する）。
// 状態は JSON 化可能な値だけ。applyAction / tick / onPlayerLeft は純関数。
// 流れ: choosing（描き手が3択からお題を選ぶ・20秒）→ drawing（90秒・描画と回答）
//        → reveal（6秒・お題と正解者を開示）→ 次の描き手へ。全員が1回描くと終了。
// お題は描き手にだけ viewFor で開示し、回答側には文字数だけを見せる。
// 正解した回答の本文はフィードに残さない（答えが漏れるため）。
// 得点: 正解者は正解順に 100/80/60/40/30… 点、描き手は正解者1人につき25点。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export type DgPhase = "choosing" | "drawing" | "reveal" | "finished";

export const DG_WORDS: string[] = [
  "りんご", "バナナ", "みかん", "すいか", "ぶどう", "もも",
  "ねこ", "いぬ", "うさぎ", "ぞう", "きりん", "ライオン",
  "パンダ", "ペンギン", "たこ", "かに", "かえる", "へび",
  "さかな", "とり", "ちょうちょ", "かめ", "くま", "さる",
  "くるま", "でんしゃ", "ひこうき", "ふね", "じてんしゃ", "バス",
  "いえ", "き", "はな", "たいよう", "つき", "ほし",
  "やま", "うみ", "ゆき", "かさ", "めがね", "とけい",
  "ぼうし", "くつ", "かばん", "ほん", "えんぴつ", "はさみ",
  "ギター", "ピアノ", "ケーキ", "アイスクリーム", "サッカー", "ロボット",
  "ふくろう", "きつね", "たぬき", "ひつじ", "うま", "ぶた",
  "にわとり", "いるか", "くじら", "えび", "いか", "くらげ",
  "おにぎり", "サンドイッチ", "ハンバーガー", "ピザ", "カレーライス", "ドーナツ",
  "たいやき", "かきごおり", "ゆきだるま", "すべりだい", "ブランコ", "シーソー",
  "ランドセル", "クレヨン", "ぬいぐるみ", "ボール", "ラケット", "トラック",
  "とら", "こあら", "らくだ", "かば", "わに", "せみ",
  "とんぼ", "てんとうむし", "かたつむり", "すし", "ラーメン", "うどん",
  "そば", "たこやき", "プリン", "ゼリー", "チョコレート", "わたあめ",
  "さくらんぼ", "レモン", "メロン", "でんきゅう", "せんぷうき", "テレビ",
  "れいぞうこ", "かぎ",
  "さくら", "ひまわり", "たんぽぽ", "チューリップ", "ながぐつ", "てぶくろ",
  "マフラー", "サングラス", "いす", "ベッド", "ソファー", "かがみ",
  "はぶらし", "テント", "リュック", "ふうせん", "けんだま", "あひる",
  "かぼちゃ", "たまねぎ",
  "カメラ", "きんぎょ", "ハト", "カラス", "パン", "コーヒー",
  "かんらんしゃ", "ヘリコプター", "ロケット", "つくえ", "ドア", "しんごう",
  "ポスト", "スマホ", "ろうそく", "タオル", "めだまやき", "にじ",
  "マイク", "カブトムシ",
];

export const DG_CHOICE_MS = 20000;
export const DG_ROUND_MS = 90000;
export const DG_REVEAL_MS = 6000;
export const DG_OPTIONS_PER_ROUND = 3;
export const DG_MAX_STROKES = 300;
export const DG_MAX_POINTS_PER_STROKE = 200;
export const DG_MAX_TOTAL_POINTS = 20000;
export const DG_DRAWER_POINTS_PER_CORRECT = 25;
/** 描画に使える色（少数に固定）。 */
export const DG_COLORS: string[] = ["#111827", "#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7", "#ffffff"];
/** 描画に使える太さ（0〜1000 正規化座標系での値）。 */
export const DG_WIDTHS: number[] = [6, 14, 28];

export interface DgStroke {
  color: string;
  width: number;
  /** [x, y] の点列。各 0〜1000 の整数。 */
  points: [number, number][];
}

export interface DgFeedEntry {
  seat: number;
  /** 正解だった回答は本文を残さない（null）。 */
  text: string | null;
  correct: boolean;
}

export interface DgRound {
  drawer: number;
  options: string[];
}

export interface DrawGuessState {
  players: { seat: number; name: string }[];
  leftSeats: number[];
  rounds: DgRound[];
  roundIndex: number;
  phase: DgPhase;
  /** 内部のみ。drawing 中は描き手にだけ、reveal では全員に viewFor で開示する。 */
  word: string | null;
  strokes: DgStroke[];
  /** このラウンドで正解した seat（正解順）。 */
  correctSeats: number[];
  scores: Record<number, number>;
  feed: DgFeedEntry[];
  /** 現在フェーズの締切（epoch ms）。finished では null。 */
  phaseEndsAt: number | null;
}

export type DrawGuessAction =
  | { type: "choose"; index: number }
  | { type: "stroke"; color: string; width: number; points: [number, number][] }
  | { type: "clear" }
  | { type: "guess"; text: string };

export interface DgViewPlayer {
  seat: number;
  name: string;
  score: number;
  left: boolean;
  isDrawer: boolean;
  /** このラウンドで正解済みか。 */
  correct: boolean;
}

export interface DrawGuessView {
  phase: DgPhase;
  roundIndex: number;
  totalRounds: number;
  drawerSeat: number | null;
  phaseEndsAt: number | null;
  strokes: DgStroke[];
  feed: DgFeedEntry[];
  players: DgViewPlayer[];
  you: { seat: number; isDrawer: boolean; left: boolean; correct: boolean };
  /** choosing 中の描き手にだけ渡す3択。それ以外は null。 */
  wordOptions: string[] | null;
  /** 描き手（drawing/reveal）と全員（reveal）に開示されるお題。それ以外は null。 */
  word: string | null;
  /** 回答側へのヒント: お題の文字数。drawing 中のみ。 */
  wordLength: number | null;
  /** このラウンドの正解者（reveal で得点つきで開示する材料）。 */
  correctSeats: number[];
  standings: { seat: number; score: number; rank: number }[] | null;
}

// ---------------------------------------------------------------- utilities

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 回答の正規化: 空白除去・全角空白除去・カタカナ→ひらがな・英字小文字化。 */
export function normalizeGuess(text: string): string {
  return text
    .trim()
    .replace(/[\s　]+/g, "")
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .toLowerCase();
}

/** 正解順（0始まり）に対する正解者の得点。 */
export function dgGuesserPoints(orderIndex: number): number {
  return Math.max(30, 100 - 20 * Math.max(0, orderIndex));
}

function playerOf(state: DrawGuessState, seat: number): { seat: number; name: string } | undefined {
  return state.players.find((p) => p.seat === seat);
}

function activeSeats(state: DrawGuessState): number[] {
  return state.players.filter((p) => !state.leftSeats.includes(p.seat)).map((p) => p.seat);
}

function currentRound(state: DrawGuessState): DgRound | null {
  return state.rounds[state.roundIndex] ?? null;
}

function shuffled<T>(items: T[], rng: Rng): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function totalPoints(state: DrawGuessState): number {
  return state.strokes.reduce((sum, s) => sum + s.points.length, 0);
}

/** ラウンドを開始する（draft を破壊的に更新）。描き手が退出済みなら次のラウンドへ飛ばす。 */
function startRound(draft: DrawGuessState, now: number): void {
  // アクティブなプレイヤーが2人未満なら対戦を終える
  if (activeSeats(draft).length < 2) {
    draft.phase = "finished";
    draft.phaseEndsAt = null;
    return;
  }
  let round = currentRound(draft);
  while (round && draft.leftSeats.includes(round.drawer)) {
    draft.roundIndex += 1;
    round = currentRound(draft);
  }
  if (!round) {
    draft.phase = "finished";
    draft.phaseEndsAt = null;
    return;
  }
  draft.word = null;
  draft.strokes = [];
  draft.correctSeats = [];
  draft.feed = [];
  draft.phase = "choosing";
  draft.phaseEndsAt = now + DG_CHOICE_MS;
}

/** お題を確定して drawing へ移す（draft を破壊的に更新）。 */
function beginDrawing(draft: DrawGuessState, word: string, now: number): void {
  draft.word = word;
  draft.phase = "drawing";
  draft.phaseEndsAt = now + DG_ROUND_MS;
}

/** ラウンドを締めて reveal へ移す（draft を破壊的に更新）。 */
function endRound(draft: DrawGuessState, now: number): void {
  draft.phase = "reveal";
  draft.phaseEndsAt = now + DG_REVEAL_MS;
}

/** reveal の次へ: 次のラウンド開始か終了（draft を破壊的に更新）。 */
function advanceRound(draft: DrawGuessState, now: number): void {
  draft.roundIndex += 1;
  if (draft.roundIndex >= draft.rounds.length) {
    draft.phase = "finished";
    draft.phaseEndsAt = null;
    return;
  }
  startRound(draft, now);
}

/** アクティブな回答者全員が正解したら即ラウンドを締める。 */
function closeIfAllCorrect(draft: DrawGuessState, now: number): void {
  if (draft.phase !== "drawing") return;
  const round = currentRound(draft);
  if (!round) return;
  const guessers = activeSeats(draft).filter((s) => s !== round.drawer);
  if (guessers.length === 0) return;
  if (guessers.every((s) => draft.correctSeats.includes(s))) endRound(draft, now);
}

// ---------------------------------------------------------------- module

function createState(players: SeatInfo[], rng: Rng, _options: Record<string, unknown>): DrawGuessState {
  if (!Array.isArray(players) || players.length < 2 || players.length > 6) {
    throw new Error("お絵かき当ては2〜6人で遊ぶゲームです");
  }
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const scores: Record<number, number> = {};
  for (const p of sorted) scores[p.seat] = 0;
  const words = shuffled(DG_WORDS, rng);
  const rounds: DgRound[] = sorted.map((p, i) => ({
    drawer: p.seat,
    options: words.slice(i * DG_OPTIONS_PER_ROUND, i * DG_OPTIONS_PER_ROUND + DG_OPTIONS_PER_ROUND),
  }));
  const state: DrawGuessState = {
    players: sorted.map((p) => ({ seat: p.seat, name: p.name })),
    leftSeats: [],
    rounds,
    roundIndex: 0,
    phase: "choosing",
    word: null,
    strokes: [],
    correctSeats: [],
    scores,
    feed: [],
    phaseEndsAt: Date.now() + DG_CHOICE_MS,
  };
  return state;
}

function applyStroke(state: DrawGuessState, seat: number, action: Extract<DrawGuessAction, { type: "stroke" }>): DrawGuessState {
  const round = currentRound(state);
  if (!round || round.drawer !== seat) throw new Error("描けるのは描き手だけです");
  if (state.phase !== "drawing") throw new Error("今は描けません");
  if (!DG_COLORS.includes(action.color)) throw new Error("使えない色です");
  if (!DG_WIDTHS.includes(action.width)) throw new Error("使えない太さです");
  if (!Array.isArray(action.points) || action.points.length < 1) throw new Error("ストロークが空です");
  if (action.points.length > DG_MAX_POINTS_PER_STROKE) throw new Error("ストロークが長すぎます");
  if (state.strokes.length >= DG_MAX_STROKES) throw new Error("これ以上描けません（上限に達しました）");
  if (totalPoints(state) + action.points.length > DG_MAX_TOTAL_POINTS) throw new Error("これ以上描けません（上限に達しました）");
  const points: [number, number][] = action.points.map((pt) => {
    if (!Array.isArray(pt) || pt.length !== 2) throw new Error("座標が不正です");
    const [x, y] = pt;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("座標が不正です");
    }
    return [Math.max(0, Math.min(1000, Math.round(x))), Math.max(0, Math.min(1000, Math.round(y)))];
  });
  const draft = clone(state);
  draft.strokes.push({ color: action.color, width: action.width, points });
  return draft;
}

function applyAction(state: DrawGuessState, seat: number, action: DrawGuessAction, _rng: Rng): DrawGuessState {
  if (!action || typeof action !== "object" || typeof (action as { type?: unknown }).type !== "string") {
    throw new Error("不明なアクションです");
  }
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished") throw new Error("ゲームは終了しています");
  if (state.leftSeats.includes(seat)) throw new Error("退出したプレイヤーは操作できません");
  const round = currentRound(state);
  if (!round) throw new Error("ラウンドが存在しません");
  const now = Date.now();

  switch (action.type) {
    case "choose": {
      if (state.phase !== "choosing") throw new Error("今はお題を選べません");
      if (round.drawer !== seat) throw new Error("お題を選べるのは描き手だけです");
      if (!Number.isInteger(action.index) || action.index < 0 || action.index >= round.options.length) {
        throw new Error("お題の選択が不正です");
      }
      if (state.phaseEndsAt !== null && now > state.phaseEndsAt) throw new Error("選択の制限時間を過ぎています");
      const draft = clone(state);
      beginDrawing(draft, round.options[action.index], now);
      return draft;
    }
    case "stroke":
      return applyStroke(state, seat, action);
    case "clear": {
      if (state.phase !== "drawing") throw new Error("今は消せません");
      if (round.drawer !== seat) throw new Error("消せるのは描き手だけです");
      const draft = clone(state);
      draft.strokes = [];
      return draft;
    }
    case "guess": {
      if (state.phase !== "drawing") throw new Error("今は回答できません");
      if (round.drawer === seat) throw new Error("描き手は回答できません");
      if (state.correctSeats.includes(seat)) throw new Error("すでに正解しています");
      if (typeof action.text !== "string") throw new Error("回答が不正です");
      const text = action.text.trim();
      if (text.length === 0) throw new Error("回答が空です");
      if (text.length > 50) throw new Error("回答が長すぎます");
      if (state.phaseEndsAt !== null && now > state.phaseEndsAt) throw new Error("制限時間を過ぎています");
      if (!state.word) throw new Error("お題が決まっていません");
      const correct = normalizeGuess(text) === normalizeGuess(state.word);
      const draft = clone(state);
      if (correct) {
        const order = draft.correctSeats.length;
        draft.correctSeats.push(seat);
        draft.scores[seat] = (draft.scores[seat] ?? 0) + dgGuesserPoints(order);
        draft.scores[round.drawer] = (draft.scores[round.drawer] ?? 0) + DG_DRAWER_POINTS_PER_CORRECT;
        // 正解の本文は漏洩防止のためフィードに残さない
        draft.feed.push({ seat, text: null, correct: true });
        closeIfAllCorrect(draft, now);
      } else {
        draft.feed.push({ seat, text, correct: false });
      }
      if (draft.feed.length > 100) draft.feed = draft.feed.slice(-100);
      return draft;
    }
    default:
      throw new Error("不明なアクションです");
  }
}

function viewFor(state: DrawGuessState, seat: number): DrawGuessView {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  const round = currentRound(state);
  const drawerSeat = state.phase === "finished" ? null : (round?.drawer ?? null);
  const isDrawer = drawerSeat !== null && drawerSeat === seat;
  const revealing = state.phase === "reveal";

  const word: string | null =
    state.word !== null && (revealing || state.phase === "finished" || (state.phase === "drawing" && isDrawer))
      ? state.word
      : null;

  let standings: DrawGuessView["standings"] = null;
  if (state.phase === "finished") {
    const sorted = [...state.players].sort((a, b) => (state.scores[b.seat] ?? 0) - (state.scores[a.seat] ?? 0));
    standings = sorted.map((p) => ({
      seat: p.seat,
      score: state.scores[p.seat] ?? 0,
      rank: 1 + sorted.filter((o) => (state.scores[o.seat] ?? 0) > (state.scores[p.seat] ?? 0)).length,
    }));
  }

  return {
    phase: state.phase,
    roundIndex: Math.min(state.roundIndex, Math.max(0, state.rounds.length - 1)),
    totalRounds: state.rounds.length,
    drawerSeat,
    phaseEndsAt: state.phaseEndsAt,
    strokes: clone(state.strokes),
    feed: clone(state.feed),
    players: state.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      score: state.scores[p.seat] ?? 0,
      left: state.leftSeats.includes(p.seat),
      isDrawer: drawerSeat === p.seat,
      correct: state.correctSeats.includes(p.seat),
    })),
    you: {
      seat,
      isDrawer,
      left: state.leftSeats.includes(seat),
      correct: state.correctSeats.includes(seat),
    },
    wordOptions: state.phase === "choosing" && isDrawer && round ? [...round.options] : null,
    word,
    wordLength: state.phase === "drawing" && !isDrawer && state.word ? [...normalizeGuess(state.word)].length : null,
    correctSeats: [...state.correctSeats],
    standings,
  };
}

function parseAction(raw: unknown): DrawGuessAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  switch (rec.type) {
    case "choose":
      if (typeof rec.index !== "number" || !Number.isInteger(rec.index) || rec.index < 0 || rec.index > 2) return null;
      return { type: "choose", index: rec.index };
    case "clear":
      return { type: "clear" };
    case "guess":
      if (typeof rec.text !== "string" || rec.text.trim().length === 0 || rec.text.length > 50) return null;
      return { type: "guess", text: rec.text };
    case "stroke": {
      if (typeof rec.color !== "string" || typeof rec.width !== "number") return null;
      if (!Array.isArray(rec.points) || rec.points.length < 1 || rec.points.length > DG_MAX_POINTS_PER_STROKE) return null;
      const points: [number, number][] = [];
      for (const pt of rec.points) {
        if (!Array.isArray(pt) || pt.length !== 2) return null;
        const [x, y] = pt as unknown[];
        if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
        points.push([x, y]);
      }
      return { type: "stroke", color: rec.color, width: rec.width, points };
    }
    default:
      return null;
  }
}

function onPlayerLeft(state: DrawGuessState, seat: number): DrawGuessState {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished" || state.leftSeats.includes(seat)) return state;
  const draft = clone(state);
  draft.leftSeats.push(seat);
  const now = Date.now();
  if (activeSeats(draft).length < 2) {
    draft.phase = "finished";
    draft.phaseEndsAt = null;
    return draft;
  }
  const round = currentRound(draft);
  if (round && round.drawer === seat && draft.phase !== "reveal") {
    // 描き手が抜けたらラウンドを飛ばす
    advanceRound(draft, now);
    return draft;
  }
  if (draft.phase === "reveal" && round && round.drawer === seat) {
    advanceRound(draft, now);
    return draft;
  }
  // 回答者が抜けて残り全員が正解済みなら締める
  closeIfAllCorrect(draft, now);
  return draft;
}

function tick(state: DrawGuessState, now: number): DrawGuessState {
  if (state.phase === "finished" || state.phaseEndsAt === null || now < state.phaseEndsAt) return state;
  const round = currentRound(state);
  if (!round) return state;
  const draft = clone(state);
  if (state.phase === "choosing") {
    // 時間切れなら先頭のお題で自動的に始める
    beginDrawing(draft, round.options[0], now);
    return draft;
  }
  if (state.phase === "drawing") {
    endRound(draft, now);
    return draft;
  }
  if (state.phase === "reveal") {
    advanceRound(draft, now);
    return draft;
  }
  return state;
}

export const gameModule: OnlineGameModule<DrawGuessState, DrawGuessAction, DrawGuessView> = {
  id: "drawguess",
  title: "お絵かき当て",
  minPlayers: 2,
  maxPlayers: 6,
  cpuSupported: false,
  chatEnabled: true,
  createState,
  applyAction,
  viewFor,
  parseAction,
  phaseOf: (state: DrawGuessState) => state.phase,
  isFinished: (state: DrawGuessState) => state.phase === "finished",
  onPlayerLeft,
  tick,
};
