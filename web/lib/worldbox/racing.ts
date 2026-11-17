// AGO WORLD BOX の競馬（LHA 統合・純粋ロジック、DOM 非依存）。
// 仕様: ~/workspace/your_files/lha-worldbox/SPEC-MVP.md（ユーザー承認済み 2026-11-16）。
// Phase 1: 通常レース（30分間隔の時間制）・単勝/複勝・K=0.85・ダミーなし。
// レースは ID（発走時刻 ms）から決定的に生成する: 同じ ID からは何度計算
// しても同じ出走表・着順になる。確定結果は呼び出し側が保存してよいが、
// 再計算でも一致する。乱数は makeRng（mulberry32）＋文字列シードのハッシュ。
import { makeRng } from "./rng";
import { HORSES, type Horse, type RunningStyle, type Surface, type DistanceBand, DISTANCE_BANDS } from "./racing/horses";

// ---------- 定数（仕様 §5/§7/§8） ----------

/** 通常レースの間隔（30分）。 */
export const RACE_INTERVAL_MS = 30 * 60 * 1000;
/** レース演出の長さ（約90秒）。 */
export const RACE_DURATION_MS = 90 * 1000;
/** 賭け締切は発走の5分前。 */
export const BET_CLOSE_BEFORE_MS = 5 * 60 * 1000;
/** 控除率係数（ユーザー決定: 期待値は全馬・全賭式で常に1未満）。 */
export const ODDS_K = 0.85;
export const ODDS_MIN = 1.1;
export const ODDS_MAX = 999.9;
/** オッズ推定のモンテカルロ回数（レース生成時のみ）。 */
export const ODDS_SIMULATIONS = 2000;
/** 通常レースのクラス中心と帯域（仕様 §6）。 */
export const NORMAL_CLASS_CENTER = 68;
export const NORMAL_CLASS_BAND = 8;
/** 馬券のプリセット額（仕様 §9 の購入フロー）。 */
export const BET_PRESETS: readonly number[] = [100, 500, 1000, 5000];

export type BetType = "win" | "place";
export type Going = "良" | "稍重" | "重" | "不良";
export type Pace = "スロー" | "平均" | "ハイ";

/** 開催場（仕様 §3: 別マップにせず回り・小回りの属性として持つ）。 */
export interface RaceTrack {
  id: string;
  name: string;
  direction: "左" | "右";
  small: boolean;
}
export const RACE_TRACKS: readonly RaceTrack[] = [
  { id: "hiroba", name: "広場", direction: "左", small: false },
  { id: "ago", name: "あご", direction: "右", small: true },
  { id: "same", name: "サメ", direction: "右", small: true },
  { id: "moja", name: "もじゃ", direction: "右", small: false },
  { id: "ryungu", name: "リュング", direction: "右", small: true },
];

/** 距離帯の中心距離（m）。距離補正の「ドンピシャ/守備範囲」の判定に使う。 */
export const BAND_CENTER_M: Record<DistanceBand, number> = {
  "スプリント": 1200,
  "マイル": 1600,
  "中距離": 2000,
  "中長距離": 2400,
  "ステイヤー": 3000,
};

/** 毛色 → 描画色（観戦アニメの馬ドットの色分け、仕様 §9）。 */
export const COAT_COLORS: Record<string, string> = {
  "鹿毛": "#8a5a2b",
  "栗毛": "#c07a30",
  "黒鹿毛": "#4a3220",
  "芦毛": "#b9bcc2",
  "青鹿毛": "#3a2e28",
  "青毛": "#23232b",
  "栃栗毛": "#6e3b16",
  "白毛": "#f2f2ee",
};

// ---------- シード ----------

/** 文字列 → 32bit ハッシュ（FNV-1a）。レース ID から決定的シードを作る。 */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** レース ID（発走時刻 ms）→ 表示用 ID。 */
export function raceLabel(postMs: number): string {
  const d = new Date(postMs);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `R-${mm}${dd}-${hh}${mi}`;
}

// ---------- スケジュール（仕様 §5: 時間制） ----------

export interface RaceSchedule {
  /** 発走済みで演出中（または直近に終了）のレースの発走時刻。 */
  runningPostMs: number | null;
  /** 直近の発走時刻（終了直後の結果表示用）。 */
  lastPostMs: number;
  /** 賭け受付中の次のレースの発走時刻（締切を過ぎていればその次）。 */
  nextPostMs: number;
}

/** 時刻から、演出中レースと賭け対象の次レースを決める（純粋関数）。 */
export function scheduleAt(nowMs: number): RaceSchedule {
  const slotStart = Math.floor(nowMs / RACE_INTERVAL_MS) * RACE_INTERVAL_MS;
  // slotStart は直近の発走時刻。発走前（= 前スロットの末尾）なら発走は slotStart。
  // 発走時刻ちょうどから RACE_DURATION_MS の間だけ「演出中」。
  const runningPostMs = nowMs - slotStart < RACE_DURATION_MS ? slotStart : null;
  // 賭け対象: 締切（発走5分前）がまだ来ていない最初の発走。
  let nextPostMs = slotStart;
  while (nowMs >= nextPostMs - BET_CLOSE_BEFORE_MS) nextPostMs += RACE_INTERVAL_MS;
  return { runningPostMs, lastPostMs: slotStart, nextPostMs };
}

/** その発走時刻のレースへの賭けが開いているか。 */
export function isBettingOpen(postMs: number, nowMs: number): boolean {
  return nowMs < postMs - BET_CLOSE_BEFORE_MS && nowMs >= postMs - RACE_INTERVAL_MS;
}

// ---------- レース生成（決定的） ----------

export interface RaceEntry {
  horse: Horse;
  /** 枠（1始まり、出走順）。 */
  gate: number;
  /** 休み明けか（前レースに出走していない）。鉄砲巧者の判定に使う。 */
  rested: boolean;
}

export interface RaceCore {
  postMs: number;
  track: RaceTrack;
  surface: Surface;
  distanceM: number;
  band: DistanceBand;
  going: Going;
  pace: Pace;
  entries: RaceEntry[];
  /** 着順（horse id の順、1着が先頭）。 */
  placings: number[];
  /** 各馬の最終スコア（horse id → score）。 */
  scores: Record<number, number>;
  /** 着差ラベル（2着以下の各馬について、前の馬との差）。 */
  margins: Record<number, string>;
}

function bandOfDistance(m: number): DistanceBand {
  if (m <= 1400) return "スプリント";
  if (m <= 1800) return "マイル";
  if (m <= 2200) return "中距離";
  if (m <= 2500) return "中長距離";
  return "ステイヤー";
}

function bandIndex(band: DistanceBand): number {
  return DISTANCE_BANDS.indexOf(band);
}

/** 天候・馬場（1d20＋季節補正、仕様 §7）。月は開催月（現実の月）。 */
export function goingForRoll(roll: number, month: number): Going {
  let adj = roll;
  if (month === 6 || month === 10 || month === 11) adj += 2; // 梅雨・秋雨
  if (month === 1 || month === 2) adj -= 2; // 冬の乾燥
  if (adj <= 14) return "良";
  if (adj <= 17) return "稍重";
  if (adj <= 19) return "重";
  return "不良";
}

/** 距離補正: 中心距離との差で4段階（ドンピシャ+2/守備範囲0/1段階相当-2/それ以外-6）。 */
export function distanceCorrection(horse: Horse, distanceM: number): number {
  const diff = Math.abs(BAND_CENTER_M[horse.distance] - distanceM);
  if (diff <= 100) return 2;
  if (diff <= 300) return 0;
  if (diff <= 500) return -2;
  return -6;
}

/** 馬場適性補正: 一致・兼用 0 / 適性外 -6（選定で原則避けるため固定値）。 */
export function surfaceCorrection(horse: Horse, surface: Surface): number {
  if (horse.surface === "兼用" || horse.surface === surface) return 0;
  return -6;
}

/** 天候・馬場補正（道悪巧者のみ恩恵、他は重・不良で減点）。 */
export function goingCorrection(horse: Horse, going: Going): number {
  const muddy = horse.trait === "道悪巧者";
  switch (going) {
    case "良": return 0;
    case "稍重": return muddy ? 2 : 0;
    case "重": return muddy ? 5 : -1;
    case "不良": return muddy ? 6 : -2;
  }
}

/** 個性補正（回り・小回り・鉄砲・季節）。夏馬・冬馬は id 偶数=夏/奇数=冬に割る。 */
export function traitCorrection(horse: Horse, ctx: { track: RaceTrack; rested: boolean; month: number }): number {
  let c = 0;
  if (horse.trait === "左回り巧者" && ctx.track.direction === "左") c += 4;
  if (horse.trait === "右回り・小回り巧者" && (ctx.track.direction === "右" || ctx.track.small)) c += 4;
  if (horse.trait === "鉄砲巧者" && ctx.rested) c += 4;
  if (horse.trait === "夏馬・冬馬") {
    const summer = ctx.month >= 6 && ctx.month <= 8;
    const winter = ctx.month === 12 || ctx.month <= 2;
    if ((horse.id % 2 === 0 && summer) || (horse.id % 2 === 1 && winter)) c += 4;
  }
  return c;
}

/** ペース補正（1d6: 1-2 スロー / 3-4 平均 / 5-6 ハイ）。 */
export function paceForRoll(roll: number): Pace {
  if (roll <= 2) return "スロー";
  if (roll <= 4) return "平均";
  return "ハイ";
}

export function paceCorrection(style: RunningStyle, pace: Pace): number {
  if (pace === "平均") return 0;
  const table: Record<Pace, Partial<Record<RunningStyle, number>>> = {
    "スロー": { "大逃げ": 3, "逃げ": 3, "先行": 2, "差し": -1, "追込": -3, "マクリ": 1 },
    "平均": {},
    "ハイ": { "大逃げ": -3, "逃げ": -3, "先行": -1, "差し": 2, "追込": 3, "マクリ": 1 },
  };
  return table[pace][style] ?? 0;
}

/** 頭数・年齢補正。 */
export function fieldCorrection(horse: Horse, fieldSize: number, hasVeteran: boolean): number {
  let c = 0;
  if (fieldSize <= 8 && (horse.style === "逃げ" || horse.style === "大逃げ" || horse.style === "先行")) c += 1;
  if (fieldSize >= 14 && (horse.style === "差し" || horse.style === "追込")) c += 1;
  if (horse.age === 2 && hasVeteran) c += 2;
  return c;
}

/** スコア差 → 着差ラベル（仕様 §7）。 */
export function marginLabel(scoreDiff: number, rng: () => number): string {
  if (scoreDiff <= 0) {
    const r = Math.floor(rng() * 200) + 1;
    if (r === 1) return "同着";
    if (r <= 86) return "ハナ";
    if (r <= 178) return "アタマ";
    return "クビ";
  }
  if (scoreDiff <= 2) return rng() < 0.5 ? "アタマ" : "1/2馬身";
  if (scoreDiff <= 5) return "1-2 1/2馬身";
  if (scoreDiff <= 8) return "3-4馬身";
  return "大差";
}

/** 出走選定（仕様 §6）: 適格（馬場）→ 能力帯 → ローテーション（前走馬を後ろへ）。 */
export function selectEntries(
  postMs: number,
  surface: Surface,
  band: DistanceBand,
  fieldSize: number,
  prevHorseIds: ReadonlySet<number>,
): RaceEntry[] {
  const rng = makeRng(hashSeed(`select:${postMs}`));
  const tie = new Map<number, number>();
  for (const h of HORSES) tie.set(h.id, rng());
  // 候補が頭数に満たない薄い区分（ダートの長距離など）では、距離帯→クラス帯の
  // 順に段階的に広げて頭数を確保する（仕様 §6-5 の補充を実在馬の帯拡張で代替）。
  const widenSteps: { bandTol: number; classTol: number }[] = [
    { bandTol: 1, classTol: NORMAL_CLASS_BAND },
    { bandTol: 2, classTol: NORMAL_CLASS_BAND },
    { bandTol: 2, classTol: NORMAL_CLASS_BAND + 4 },
    { bandTol: 4, classTol: 99 },
  ];
  let candidates: Horse[] = [];
  for (const step of widenSteps) {
    candidates = HORSES.filter((h) => {
      if (h.surface !== "兼用" && h.surface !== surface) return false;
      if (Math.abs(bandIndex(h.distance) - bandIndex(band)) > step.bandTol) return false;
      if (Math.abs(h.ability - NORMAL_CLASS_CENTER) > step.classTol) return false;
      return true;
    });
    if (candidates.length >= fieldSize) break;
  }
  candidates.sort((a, b) => {
    const pa = prevHorseIds.has(a.id) ? 1 : 0;
    const pb = prevHorseIds.has(b.id) ? 1 : 0;
    if (pa !== pb) return pa - pb;
    return (tie.get(a.id) ?? 0) - (tie.get(b.id) ?? 0);
  });
  const picked = candidates.slice(0, fieldSize);
  // 枠順は能力順にしない（予想ゲームとして成立させる）: シード順に並べ替える。
  const gateRng = makeRng(hashSeed(`gate:${postMs}`));
  const gateTie = new Map<number, number>();
  for (const h of picked) gateTie.set(h.id, gateRng());
  picked.sort((a, b) => (gateTie.get(a.id) ?? 0) - (gateTie.get(b.id) ?? 0));
  return picked.map((horse, i) => ({ horse, gate: i + 1, rested: !prevHorseIds.has(horse.id) }));
}

/**
 * 前レースの出走馬 ID 集合（ローテーションと休み明け判定用）。
 * 再帰を避けるため「前スロットの形に素の選定（前走情報なし）を適用した集合」
 * と定義する。決定的で、どのレースから計算しても同じ値になる。
 */
export function prevRaceHorseIds(postMs: number): Set<number> {
  const prev = raceShape(postMs - RACE_INTERVAL_MS);
  const entries = selectEntries(postMs - RACE_INTERVAL_MS, prev.surface, prev.band, prev.fieldSize, new Set());
  return new Set(entries.map((e) => e.horse.id));
}

/** レースの形（開催場・馬場・距離・頭数）だけを決める軽量版（選定の前段）。 */
export function raceShape(postMs: number): { track: RaceTrack; surface: Surface; distanceM: number; band: DistanceBand; fieldSize: number } {
  const rng = makeRng(hashSeed(`shape:${postMs}`));
  const track = RACE_TRACKS[Math.floor(rng() * RACE_TRACKS.length)];
  const surface: Surface = rng() < 0.65 ? "芝" : "ダート";
  const bandRoll = rng();
  const band: DistanceBand = bandRoll < 0.2 ? "スプリント" : bandRoll < 0.5 ? "マイル" : bandRoll < 0.8 ? "中距離" : bandRoll < 0.92 ? "中長距離" : "ステイヤー";
  const distanceM = BAND_CENTER_M[band] + Math.floor(rng() * 5 - 2) * 100;
  const sizes = [8, 10, 12];
  const fieldSize = sizes[Math.floor(rng() * sizes.length)];
  return { track, surface, distanceM, band, fieldSize };
}

/** 1頭のスコアを振る（2d10＋補正合計）。補正はレース側で固定して渡す。 */
export function rollScore(ability: number, correction: number, rng: () => number): number {
  const d1 = Math.floor(rng() * 10) + 1;
  const d2 = Math.floor(rng() * 10) + 1;
  // 当日の調子（±6 の一様な振れ）: 仕様付録Aの事前検証が前提にした補正の
  // ばらつきを実測で再現するための項。補正表の各項は天候・ペースなど
  // 全頭共通の出目に寄るため、これが無いと最強馬の勝率が検証帯（15〜25%）を
  // 大きく超える（実測 37%）。本判定とオッズ推定の両方がこの関数を通る。
  const condition = Math.floor(rng() * 13) - 6;
  return ability + d1 + d2 + correction + condition;
}

/** レース中核（出走表・着順・着差）を決定的に生成する。オッズ推定は含まない。 */
export function generateRaceCore(postMs: number): RaceCore {
  const shape = raceShape(postMs);
  const prevIds = prevRaceHorseIds(postMs);
  const entries = selectEntries(postMs, shape.surface, shape.band, shape.fieldSize, prevIds);
  const month = new Date(postMs).getMonth() + 1;
  const weatherRng = makeRng(hashSeed(`weather:${postMs}`));
  const going = goingForRoll(Math.floor(weatherRng() * 20) + 1, month);
  const pace = paceForRoll(Math.floor(weatherRng() * 6) + 1);
  const hasVeteran = entries.some((e) => e.horse.age >= 4);
  const rng = makeRng(hashSeed(`race:${postMs}`));
  const scores: Record<number, number> = {};
  for (const e of entries) {
    const correction =
      distanceCorrection(e.horse, shape.distanceM) +
      surfaceCorrection(e.horse, shape.surface) +
      goingCorrection(e.horse, going) +
      traitCorrection(e.horse, { track: shape.track, rested: e.rested, month }) +
      paceCorrection(e.horse.style, pace) +
      fieldCorrection(e.horse, entries.length, hasVeteran);
    scores[e.horse.id] = rollScore(e.horse.ability, correction, rng);
  }
  // 同点は 1d100 の振り合い（高い方が先着）: 先に全頭分を振ってから並べる。
  const tieRolls = new Map<number, number>();
  for (const e of entries) tieRolls.set(e.horse.id, Math.floor(rng() * 100) + 1);
  const order = [...entries].sort((a, b) => {
    const diff = scores[b.horse.id] - scores[a.horse.id];
    if (diff !== 0) return diff;
    return (tieRolls.get(b.horse.id) ?? 0) - (tieRolls.get(a.horse.id) ?? 0);
  });
  const placings = order.map((e) => e.horse.id);
  const marginRng = makeRng(hashSeed(`margin:${postMs}`));
  const margins: Record<number, string> = {};
  for (let i = 1; i < order.length; i++) {
    const diff = scores[order[i - 1].horse.id] - scores[order[i].horse.id];
    margins[order[i].horse.id] = marginLabel(Math.max(0, diff), marginRng);
  }
  return { postMs, track: shape.track, surface: shape.surface, distanceM: shape.distanceM, band: shape.band, going, pace, entries, placings, scores, margins };
}

// ---------- オッズ（仕様 §8: モンテカルロ推定 × K、固定オッズ） ----------

export interface HorseOdds { win: number; place: number }

/** 複勝の的中範囲（8頭以上=3着以内、7頭以下=2着以内）。 */
export function placeCut(fieldSize: number): number {
  return fieldSize >= 8 ? 3 : 2;
}

function oddsFromProb(p: number): number {
  if (p <= 0) return ODDS_MAX;
  const raw = Math.floor((ODDS_K / p) * 10) / 10;
  return Math.min(ODDS_MAX, Math.max(ODDS_MIN, raw));
}

/** モンテカルロで勝率・複勝率を推定してオッズ化する（生成時のみ・重い）。 */
export function estimateOdds(core: RaceCore): Record<number, HorseOdds> {
  const month = new Date(core.postMs).getMonth() + 1;
  const hasVeteran = core.entries.some((e) => e.horse.age >= 4);
  const corrections = new Map<number, number>();
  for (const e of core.entries) {
    corrections.set(e.horse.id,
      distanceCorrection(e.horse, core.distanceM) +
      surfaceCorrection(e.horse, core.surface) +
      goingCorrection(e.horse, core.going) +
      traitCorrection(e.horse, { track: core.track, rested: e.rested, month }) +
      paceCorrection(e.horse.style, core.pace) +
      fieldCorrection(e.horse, core.entries.length, hasVeteran));
  }
  const wins = new Map<number, number>();
  const places = new Map<number, number>();
  const cut = placeCut(core.entries.length);
  const rng = makeRng(hashSeed(`odds:${core.postMs}`));
  for (let sim = 0; sim < ODDS_SIMULATIONS; sim++) {
    const scored = core.entries.map((e) => ({ id: e.horse.id, s: rollScore(e.horse.ability, corrections.get(e.horse.id) ?? 0, rng) }));
    scored.sort((a, b) => b.s - a.s);
    wins.set(scored[0].id, (wins.get(scored[0].id) ?? 0) + 1);
    for (let i = 0; i < Math.min(cut, scored.length); i++) {
      places.set(scored[i].id, (places.get(scored[i].id) ?? 0) + 1);
    }
  }
  const out: Record<number, HorseOdds> = {};
  for (const e of core.entries) {
    out[e.horse.id] = {
      win: oddsFromProb((wins.get(e.horse.id) ?? 0) / ODDS_SIMULATIONS),
      place: oddsFromProb((places.get(e.horse.id) ?? 0) / ODDS_SIMULATIONS),
    };
  }
  return out;
}

// ---------- 近走（過去レースの実績を決定的に再計算する） ----------

/** その馬の直近 n 走（新しい順）。過去レースを遡って実着順を拾う。 */
export function recentForm(horseId: number, beforePostMs: number, count = 3): { postMs: number; placing: number; fieldSize: number }[] {
  const out: { postMs: number; placing: number; fieldSize: number }[] = [];
  let cursor = beforePostMs - RACE_INTERVAL_MS;
  // 最大で過去 24 レースまで遡る（出走間隔が空く馬でも 3 走拾えるように）。
  for (let i = 0; i < 24 && out.length < count; i++, cursor -= RACE_INTERVAL_MS) {
    const core = generateRaceCore(cursor);
    const idx = core.placings.indexOf(horseId);
    if (idx >= 0) out.push({ postMs: cursor, placing: idx + 1, fieldSize: core.entries.length });
  }
  return out;
}

// ---------- 観戦アニメ（展開は見せ方専用、真値は着順） ----------

const STYLE_EARLY: Record<RunningStyle, number> = {
  "大逃げ": 0.0, "逃げ": 0.08, "先行": 0.25, "マクリ": 0.5, "差し": 0.65, "追込": 0.85,
};

/**
 * レース経過 0..1 における馬のトラック上の位置（楕円の角度とレーン）。
 * 序盤は脚質の位置取り、終盤は確定着順へ収束する（仕様 §7 の展開生成）。
 * track は lobby.ts の RACETRACK と同じ中心・半径を呼び出し側が渡す。
 */
export function horseTrackPose(
  core: RaceCore,
  horseId: number,
  progress: number,
  track: { cx: number; cy: number; rx: number; ry: number; innerRx: number; innerRy: number },
): { x: number; y: number } {
  const entry = core.entries.find((e) => e.horse.id === horseId);
  if (!entry) return { x: track.cx, y: track.cy };
  const rankIdx = core.placings.indexOf(horseId);
  const n = core.entries.length;
  const early = STYLE_EARLY[entry.horse.style] + (entry.gate / n) * 0.1;
  const finalPos = n <= 1 ? 0 : rankIdx / (n - 1);
  const t = Math.min(1, Math.max(0, progress));
  const converge = t * t * (3 - 2 * t); // smoothstep
  const posNorm = early * (1 - converge) + finalPos * converge;
  // 集団の広がり: 先頭から最後尾まで角度で約 0.5 ラジアン分に収める。
  const spread = 0.5;
  const baseAngle = Math.PI + t * Math.PI * 2 * (core.track.direction === "左" ? 1 : -1);
  const angle = baseAngle - posNorm * spread * (core.track.direction === "左" ? 1 : -1);
  const lane = n <= 1 ? 0.5 : (entry.gate - 1) / (n - 1); // 0=内, 1=外
  const rx = track.innerRx + (track.rx - track.innerRx) * (0.25 + lane * 0.5);
  const ry = track.innerRy + (track.ry - track.innerRy) * (0.25 + lane * 0.5);
  return { x: track.cx + Math.cos(angle) * rx, y: track.cy + Math.sin(angle) * ry };
}

// ---------- 馬券の検証・精算（純粋部分） ----------

export function validateBetAmount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return BET_PRESETS.includes(value) ? value : null;
}

/** 的中時の払戻（固定オッズ × 金額、切り捨て）。外れは 0。 */
export function payoutFor(betType: BetType, horseId: number, amount: number, odds: HorseOdds, core: RaceCore): number {
  const rankIdx = core.placings.indexOf(horseId);
  if (rankIdx < 0) return 0;
  if (betType === "win") return rankIdx === 0 ? Math.floor(amount * odds.win) : 0;
  return rankIdx < placeCut(core.entries.length) ? Math.floor(amount * odds.place) : 0;
}
