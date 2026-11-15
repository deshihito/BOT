// AGO WORLD BOX のカジノ（純粋ロジック、DOM 非依存）。
// ロビー右翼のカジノルームで実際に賭けて遊ぶための規則:
// - スロット（スロットマシン）: 3リール、絵柄の重み抽選、3つ揃いと
//   ペアで配当。理論 RTP は slotRtp() で算出し、テストで範囲を固定する。
// - ルーレット（カジノテーブル）: 0〜36、赤/黒に賭けて当たれば2倍。
// コインの移動はここでは行わない。1プレイ = ベット額と確定配当を
// 1つの gamble オプとして経済ブリッジ（economy-bridge）へ積み、
// Bot 側ワーカーが原資ルール（Plan A: 利益分はバンクロールから、
// 負けは還流）で原子的に適用する。抽選はサーバー側でのみ行う。
import type { LobbyObject } from "./lobby";

export type CasinoGame = "slot" | "roulette";
export type CasinoMachine = CasinoGame;

/** ベットの選択肢（コイン）。既存カジノ系の最低額（10）に揃えた刻み。 */
export const CASINO_BET_TIERS: readonly number[] = [10, 100, 1000];
export const CASINO_BET_MIN = 10;
/** 上限はブリッジの金額上限（1,000,000）に一致させる。独自上限は作らない。 */
export const CASINO_BET_MAX = 1_000_000;

/** ベット額として通る値（整数・範囲内）なら額、でなければ null。 */
export function validateCasinoBet(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < CASINO_BET_MIN || value > CASINO_BET_MAX) return null;
  return value;
}

// ---------------------------------------------------------------- スロット

export interface SlotSymbol {
  glyph: string;
  color: string;
  weight: number;
  /** 3つ揃いの倍率。 */
  triple: number;
}

/** 絵柄（重み・3つ揃い倍率）。並びは抽選の走査順でもある。 */
export const SLOT_SYMBOLS: readonly SlotSymbol[] = [
  { glyph: "7", color: "#ffd23e", weight: 1, triple: 300 },
  { glyph: "◆", color: "#7ad0ff", weight: 3, triple: 60 },
  { glyph: "★", color: "#ffb3e2", weight: 5, triple: 20 },
  { glyph: "●", color: "#9dff70", weight: 8, triple: 8 },
  { glyph: "▲", color: "#ffa25e", weight: 11, triple: 4 },
  { glyph: "■", color: "#c9c9d6", weight: 14, triple: 3 },
];
/** ペア（2つ揃い）の倍率。 */
export const SLOT_PAIR_MULTIPLIER = 1.2;

const SLOT_TOTAL_WEIGHT = SLOT_SYMBOLS.reduce((sum, s) => sum + s.weight, 0);

export interface SlotResult {
  /** リールの絵柄インデックス（SLOT_SYMBOLS の添字）×3。 */
  reels: [number, number, number];
  /** 配当倍率（0 = はずれ）。 */
  multiplier: number;
  /** 配当（ベット込みの総額。0 = はずれ）。 */
  payout: number;
}

function drawSymbol(rng: () => number): number {
  let roll = rng() * SLOT_TOTAL_WEIGHT;
  for (let i = 0; i < SLOT_SYMBOLS.length; i++) {
    roll -= SLOT_SYMBOLS[i].weight;
    if (roll < 0) return i;
  }
  return SLOT_SYMBOLS.length - 1;
}

/** スロットの配当倍率（絵柄インデックス×3 → 倍率）。 */
export function slotMultiplier(reels: readonly [number, number, number]): number {
  const [a, b, c] = reels;
  if (a === b && b === c) return SLOT_SYMBOLS[a].triple;
  if (a === b || b === c || a === c) return SLOT_PAIR_MULTIPLIER;
  return 0;
}

/** スロットを1回回す。配当は floor(ベット × 倍率)。 */
export function playSlot(bet: number, rng: () => number): SlotResult {
  const reels: [number, number, number] = [drawSymbol(rng), drawSymbol(rng), drawSymbol(rng)];
  const multiplier = slotMultiplier(reels);
  return { reels, multiplier, payout: Math.floor(bet * multiplier) };
}

/** スロットの理論 RTP（配当/ベットの期待値）。 */
export function slotRtp(): number {
  let rtp = 0;
  for (const s of SLOT_SYMBOLS) {
    const p = s.weight / SLOT_TOTAL_WEIGHT;
    rtp += p * p * p * s.triple;
    rtp += 3 * p * p * (1 - p) * SLOT_PAIR_MULTIPLIER;
  }
  return rtp;
}

// ---------------------------------------------------------------- ルーレット

/** 赤の数字（標準ルーレットの配置）。0 は緑、それ以外は黒。 */
export const ROULETTE_RED: ReadonlySet<number> = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

export type RoulettePick = "red" | "black";
export type RouletteColor = RoulettePick | "green";

export function rouletteColor(n: number): RouletteColor {
  if (n === 0) return "green";
  return ROULETTE_RED.has(n) ? "red" : "black";
}

export interface RouletteResult {
  number: number;
  color: RouletteColor;
  /** 配当（ベット込みの総額。当たり 2 倍、はずれ 0）。 */
  payout: number;
}

/** ルーレットを1回回す。pick と色が一致すれば 2 倍。 */
export function playRoulette(bet: number, pick: RoulettePick, rng: () => number): RouletteResult {
  const number = Math.min(36, Math.floor(rng() * 37));
  const color = rouletteColor(number);
  return { number, color, payout: color === pick ? bet * 2 : 0 };
}

/** ルーレット（赤/黒）の理論 RTP。 */
export function rouletteRtp(): number {
  return 36 / 37;
}

// ---------------------------------------------------------------- 施設判定

/**
 * プレイヤーのタイルに隣接するカジノ機器の種別。
 * スロットマシン → "slot"、カジノテーブル → "roulette"。
 * どちらにも隣接していなければ null（カジノ内の椅子やピアノでは遊べない）。
 */
export function casinoMachineNear(
  objectsList: readonly LobbyObject[],
  tx: number,
  ty: number,
): CasinoMachine | null {
  let table = false;
  for (const o of objectsList) {
    if (tx < o.x - 1 || tx > o.x + o.w || ty < o.y - 1 || ty > o.y + o.h) continue;
    if (o.sprite === "slot_machine") return "slot";
    if (o.sprite === "casino_table") table = true;
  }
  return table ? "roulette" : null;
}

/** ゲーム種別 → ブリッジの理由コード。 */
export const CASINO_REASON: Record<CasinoGame, string> = {
  slot: "casino_slot",
  roulette: "casino_roulette",
};
