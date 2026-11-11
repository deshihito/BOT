// タイピングレース（オンライン対戦）のルールモジュール。
// 基盤契約: import は type のみ（テストが import を剥がして連結する）。
// 状態は JSON 化可能な値だけ。applyAction / tick / onPlayerLeft は純関数。
//
//
// 進行はクライアントが「正しく入力できた文字数（正しい接頭辞の長さ）」を
// { type: "progress", count} で申告する方式。サーバーは
// 「0以上・課題文の長さ以下・単調増加（減らない）」だけを検証し、
// 入力内容そのものは一切扱わない。厳密な不正検出はしない前提の設計。
//
// ルール:
// - 2〜6人、CPUなし。全3ラウンド、各ラウンドは全員共通の課題文。
// - 全員が完走するか制限時間（60秒）で締切。完走した順に得点:
// 1位100点、2位70点、3位50点、4位30点、5位20点、6位10点。
// 完走できなかった人は 0 点。
// - 開示フェーズ（4秒）で順位と得点を見せてから次ラウンドへ。
// - 退出した人は脱落（そのラウンドまでの進捗は固定され、完走扱いには
// ならない）。残りの生存者が1人になったら試合終了。
// - 他人の進捗は「文字数と進捗率」だけが公開情報で、入力内容は存在しない。
import type { OnlineGameModule, Rng, SeatInfo} from "../types";

export const TR_TOTAL_ROUNDS = 3;
export const TR_TIME_LIMIT_MS = 60000;
export const TR_REVEAL_MS = 4000;
/** 完走順の得点（添字0が1位）。 */
export const TR_RANK_POINTS = [100, 70, 50, 30, 20, 10];

/** 課題文バンク（英数字のみの短文。ローマ字表記の日本語文と英語の決まり文句）。 */
export const TR_TEXTS: string[] = [
"sakura ga saku haru no asa",
"the quick brown fox jumps",
"ashita wa hare tokidoki kumori",
"practice makes perfect always",
"umi no mieru oka no ue de",
"typing race is fun for everyone",
"neko wa yane no ue de neru",
"slow and steady wins the race",
"aki no yoru wa tsuki ga kirei",
"knowledge is power and skill",
"densha wa eki ni tomarimasu",
"better late than never at all",
];

export type TypeRacePhase = "racing" | "reveal" | "finished";

export type TypeRaceRoundResult = {
seat: number;
/** 締切時点の進捗（文字数）。 */
progress: number;
completed: boolean;
/** 完走順位（1始まり）。完走していない人は null。 */
rank: number | null;
gained: number;
};

export interface TypeRaceState {
players: { seat: number; name: string}[];
leftSeats: number[];
round: number;
totalRounds: number;
phase: TypeRacePhase;
/** ラウンドごとの課題文（公開情報）。 */
texts: string[];
roundEndsAt: number | null;
revealEndsAt: number | null;
/** 現在ラウンドの進捗（文字数）。公開情報。 */
progress: Record<number, number>;
/** 現在ラウンドの完走順（seat の列）。 */
finishOrder: number[];
scores: Record<number, number>;
history: { round: number; text: string; results: TypeRaceRoundResult[]}[];
/** 直近ラウンドの結果（reveal / finished で表示）。 */
lastResults: TypeRaceRoundResult[] | null;
}

export type TypeRaceAction = { type: "progress"; count: number};

export interface TypeRaceViewPlayer {
seat: number;
name: string;
score: number;
left: boolean;
progress: number;
ratio: number;
completed: boolean;
}

export interface TypeRaceView {
phase: TypeRacePhase;
round: number;
totalRounds: number;
/** 現在ラウンドの課題文（reveal / finished では前ラウンドの文）。 */
text: string;
textLength: number;
roundEndsAt: number | null;
revealEndsAt: number | null;
you: { seat: number; progress: number; completed: boolean; left: boolean};
players: TypeRaceViewPlayer[];
lastResults: TypeRaceRoundResult[] | null;
standings: { seat: number; score: number; rank: number}[] | null;
}

// ---------------------------------------------------------------- utilities

function clone<T>(value: T): T {
return JSON.parse(JSON.stringify(value)) as T;
}

function playerOf(state: TypeRaceState, seat: number): { seat: number; name: string} | undefined {
return state.players.find((p) => p.seat === seat);
}

function activeSeats(state: TypeRaceState): number[] {
return state.players.filter((p) =>!state.leftSeats.includes(p.seat)).map((p) => p.seat);
}

function currentText(state: TypeRaceState): string {
return state.texts[Math.min(state.round, state.texts.length - 1)]?? "";
}

/** ラウンドを締め切り、完走順に得点を付けて開示フェーズへ（draft を破壊的に更新）。 */
function closeRound(draft: TypeRaceState, now: number): void {
const results: TypeRaceRoundResult[] = draft.players.map((p) => {
const orderIndex = draft.finishOrder.indexOf(p.seat);
const completed = orderIndex >= 0;
const gained = completed? (TR_RANK_POINTS[orderIndex]?? 0): 0;
return {
seat: p.seat,
progress: draft.progress[p.seat]?? 0,
completed,
rank: completed? orderIndex + 1: null,
gained,
};
});
for (const r of results) draft.scores[r.seat] = (draft.scores[r.seat]?? 0) + r.gained;
draft.lastResults = results;
draft.history.push({ round: draft.round, text: currentText(draft), results});
draft.phase = "reveal";
draft.roundEndsAt = null;
draft.revealEndsAt = now + TR_REVEAL_MS;
}

/** 開示を終えて次ラウンドへ、または終了する（draft を破壊的に更新）。 */
function advance(draft: TypeRaceState, now: number): void {
draft.revealEndsAt = null;
draft.round += 1;
if (draft.round >= draft.totalRounds || activeSeats(draft).length < 2) {
draft.phase = "finished";
return;
}
draft.progress = {};
for (const p of draft.players) draft.progress[p.seat] = 0;
draft.finishOrder = [];
draft.phase = "racing";
draft.roundEndsAt = now + TR_TIME_LIMIT_MS;
}

/** 生存者全員が完走したら即締切する。 */
function closeIfAllCompleted(draft: TypeRaceState, now: number): void {
if (draft.phase!== "racing") return;
const active = activeSeats(draft);
if (active.length === 0) return;
if (active.every((s) => draft.finishOrder.includes(s))) closeRound(draft, now);
}

// ---------------------------------------------------------------- module

function createState(players: SeatInfo[], rng: Rng, _options: Record<string, unknown>): TypeRaceState {
if (!Array.isArray(players) || players.length < 2 || players.length > 6) {
throw new Error("タイピングレースは2〜6人で遊ぶゲームです");
}
const sorted = [...players].sort((a, b) => a.seat - b.seat);
const pool = [...TR_TEXTS];
for (let i = pool.length - 1; i > 0; i--) {
const j = Math.floor(rng() * (i + 1));
[pool[i], pool[j]] = [pool[j], pool[i]];
}
const texts = pool.slice(0, TR_TOTAL_ROUNDS);
const progress: Record<number, number> = {};
const scores: Record<number, number> = {};
for (const p of sorted) {
progress[p.seat] = 0;
scores[p.seat] = 0;
}
return {
players: sorted.map((p) => ({ seat: p.seat, name: p.name})),
leftSeats: [],
round: 0,
totalRounds: TR_TOTAL_ROUNDS,
phase: "racing",
texts,
roundEndsAt: Date.now() + TR_TIME_LIMIT_MS,
revealEndsAt: null,
progress,
finishOrder: [],
scores,
history: [],
lastResults: null,
};
}

function applyAction(state: TypeRaceState, seat: number, action: TypeRaceAction, _rng: Rng): TypeRaceState {
if (!action || typeof action!== "object") throw new Error("不明なアクションです");
if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
if (state.phase === "finished") throw new Error("ゲームは終了しています");
if (state.leftSeats.includes(seat)) throw new Error("退出したプレイヤーは操作できません");
if ((action as { type?: unknown}).type!== "progress") throw new Error("不明なアクションです");
if (state.phase!== "racing") throw new Error("今は入力できません");
const now = Date.now();
if (state.roundEndsAt!== null && now > state.roundEndsAt) throw new Error("制限時間を過ぎています");

// 申告制: 範囲と単調増加だけを検証する。
const count = (action as { count?: unknown}).count;
if (!Number.isInteger(count)) throw new Error("進捗が不正です");
const textLength = currentText(state).length;
const current = state.progress[seat]?? 0;
if ((count as number) < 0 || (count as number) > textLength) throw new Error("進捗が範囲外です");
if ((count as number) < current) throw new Error("進捗は減らせません");
if ((count as number) === current) return state;

const draft = clone(state);
draft.progress[seat] = count as number;
if ((count as number) >= textLength &&!draft.finishOrder.includes(seat)) {
draft.finishOrder.push(seat);
}
closeIfAllCompleted(draft, now);
return draft;
}

function viewFor(state: TypeRaceState, seat: number): TypeRaceView {
if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
const finished = state.phase === "finished";
const text = currentText(state);
let standings: TypeRaceView["standings"] = null;
if (finished) {
const sorted = [...state.players].sort((a, b) => (state.scores[b.seat]?? 0) - (state.scores[a.seat]?? 0));
standings = sorted.map((p) => ({
seat: p.seat,
score: state.scores[p.seat]?? 0,
rank: 1 + sorted.filter((o) => (state.scores[o.seat]?? 0) > (state.scores[p.seat]?? 0)).length,
}));
}
return {
phase: state.phase,
round: Math.min(state.round, state.totalRounds - 1),
totalRounds: state.totalRounds,
text,
textLength: text.length,
roundEndsAt: state.roundEndsAt,
revealEndsAt: state.revealEndsAt,
you: {
seat,
progress: state.progress[seat]?? 0,
completed: state.finishOrder.includes(seat),
left: state.leftSeats.includes(seat),
},
players: state.players.map((p) => {
const progress = state.progress[p.seat]?? 0;
return {
seat: p.seat,
name: p.name,
score: state.scores[p.seat]?? 0,
left: state.leftSeats.includes(p.seat),
progress,
ratio: text.length > 0? progress / text.length: 0,
completed: state.finishOrder.includes(p.seat),
};
}),
lastResults: state.lastResults,
standings,
};
}

function parseAction(raw: unknown): TypeRaceAction | null {
if (!raw || typeof raw!== "object" || Array.isArray(raw)) return null;
const rec = raw as Record<string, unknown>;
if (rec.type!== "progress") return null;
if (!Number.isInteger(rec.count) || (rec.count as number) < 0 || (rec.count as number) > 1000) return null;
return { type: "progress", count: rec.count as number};
}

function onPlayerLeft(state: TypeRaceState, seat: number): TypeRaceState {
if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
if (state.phase === "finished" || state.leftSeats.includes(seat)) return state;
const draft = clone(state);
draft.leftSeats.push(seat);
// 進捗は固定される。完走扱いにはしない。
draft.finishOrder = draft.finishOrder.filter((s) => s!== seat);
const now = Date.now();
if (activeSeats(draft).length < 2) {
draft.phase = "finished";
draft.roundEndsAt = null;
draft.revealEndsAt = null;
return draft;
}
if (draft.phase === "racing") closeIfAllCompleted(draft, now);
return draft;
}

function tick(state: TypeRaceState, now: number): TypeRaceState {
if (state.phase === "racing" && state.roundEndsAt!== null && now >= state.roundEndsAt) {
const draft = clone(state);
closeRound(draft, now);
return draft;
}
if (state.phase === "reveal" && state.revealEndsAt!== null && now >= state.revealEndsAt) {
const draft = clone(state);
advance(draft, now);
return draft;
}
return state;
}

export const gameModule: OnlineGameModule<TypeRaceState, TypeRaceAction, TypeRaceView> = {
id: "typerace",
title: "タイピングレース",
minPlayers: 2,
maxPlayers: 6,
cpuSupported: false,
chatEnabled: true,
createState,
applyAction,
viewFor,
parseAction,
phaseOf: (state: TypeRaceState) => state.phase,
isFinished: (state: TypeRaceState) => state.phase === "finished",
onPlayerLeft,
tick,
};
