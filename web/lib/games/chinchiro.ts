// チンチロリンの純粋ロジック（UI 非依存・シード決定的）。
// 3つのサイコロの役勝負。親（CPU）が先に役を確定させ、子（プレイヤー）が後から振る。
// 1ラウンドの流れ: 振る → 役が出たら「確定」するか、残り回数があれば「振り直す」か選べる。
// 最大3回まで振れて、3回目が終わればその出目で確定する。目なしは確定できない
// （残り回数があれば必ず振り直し、3回目で目なしなら目なしで確定）。
// ションベン: 各投げで 1/36 の確率でサイコロが器の外に飛び、その投げ手の即負けになる
// （役としては最弱として扱う）。
// 得点は賭け金ではなく点数制: 勝者は 10点 × 勝者の役の倍率 を得て、敗者は同点を失う
// （ゼロサム）。敗者の役がヒフミなら移動する点数は2倍。全10ラウンドの合計点で勝敗。
// 状態は JSON 化可能な値のみ。遷移関数は状態を破壊せず新しい状態を返す。

export type CcDice = [number, number, number];

export type CcHandKind =
  | "pinzoro"
  | "arashi"
  | "shigoro"
  | "normal"
  | "menashi"
  | "hifumi"
  | "shonben";

export type CcHand = {
  kind: CcHandKind;
  /** 通常の目で、ペアになっていない1個の目。それ以外は null。 */
  point: number | null;
  /** アラシの数字（強さ比較用）。それ以外は null。 */
  triple: number | null;
  /** 勝ったときに得点へ掛ける倍率。 */
  multiplier: number;
  label: string;
};

export const CC_TOTAL_ROUNDS = 10;
export const CC_MAX_ROLLS = 3;
export const CC_BASE_POINTS = 10;
/** ションベン（サイコロが器の外に飛ぶ）確率の分母。 */
export const CC_SHONBEN_DENOMINATOR = 36;

const HAND_LABELS: Record<CcHandKind, string> = {
  pinzoro: "ピンゾロ",
  arashi: "アラシ",
  shigoro: "シゴロ",
  normal: "通常の目",
  menashi: "目なし",
  hifumi: "ヒフミ",
  shonben: "ションベン",
};

/** mulberry32（minesweeper 等と同一方式）。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function rollDie(rng: number): { value: number; rng: number } {
  const r = nextRandom(rng);
  return { value: Math.floor(r.value * 6) + 1, rng: r.rng };
}

/** 3個の出目から役を判定する（ションベンは含まない）。 */
export function evaluateHand(dice: CcDice): CcHand {
  const sorted = [...dice].sort((a, b) => a - b);
  const [a, b, c] = sorted;
  if (a === b && b === c) {
    if (a === 1) {
      return { kind: "pinzoro", point: null, triple: 1, multiplier: 5, label: HAND_LABELS.pinzoro };
    }
    return { kind: "arashi", point: null, triple: a, multiplier: 3, label: `${HAND_LABELS.arashi}（${a}）` };
  }
  if (a === 4 && b === 5 && c === 6) {
    return { kind: "shigoro", point: null, triple: null, multiplier: 2, label: HAND_LABELS.shigoro };
  }
  if (a === 1 && b === 2 && c === 3) {
    return { kind: "hifumi", point: null, triple: null, multiplier: 1, label: HAND_LABELS.hifumi };
  }
  if (a === b) return { kind: "normal", point: c, triple: null, multiplier: 1, label: `${c}の目` };
  if (b === c) return { kind: "normal", point: a, triple: null, multiplier: 1, label: `${a}の目` };
  return { kind: "menashi", point: null, triple: null, multiplier: 1, label: HAND_LABELS.menashi };
}

export function shonbenHand(): CcHand {
  return { kind: "shonben", point: null, triple: null, multiplier: 1, label: HAND_LABELS.shonben };
}

/** 役の強さ（大きいほど強い）。ションベン＜ヒフミ＜目なし＜通常の目＜シゴロ＜アラシ＜ピンゾロ。 */
export function handRank(hand: CcHand): number {
  switch (hand.kind) {
    case "shonben":
      return 0;
    case "hifumi":
      return 1;
    case "menashi":
      return 2;
    case "normal":
      return 10 + (hand.point ?? 0);
    case "shigoro":
      return 20;
    case "arashi":
      return 30 + (hand.triple ?? 0);
    case "pinzoro":
      return 40;
  }
}

/** 役の比較。a が強ければ正、弱ければ負、同等なら 0。 */
export function compareHands(a: CcHand, b: CcHand): number {
  return handRank(a) - handRank(b);
}

/** 役が確定しているか（目なしだけは未確定で、振り直しが必要）。 */
export function isDetermined(hand: CcHand): boolean {
  return hand.kind !== "menashi";
}

type RollOutcome = { dice: CcDice; hand: CcHand; rng: number };

/** 1回振る。最初にションベン判定（1/36）、続けて3個の目を引く。 */
function rollOnce(rng: number): RollOutcome {
  const s = nextRandom(rng);
  let cur = s.rng;
  const dice: number[] = [];
  for (let i = 0; i < 3; i++) {
    const d = rollDie(cur);
    cur = d.rng;
    dice.push(d.value);
  }
  const triple = dice as CcDice;
  if (s.value < 1 / CC_SHONBEN_DENOMINATOR) {
    return { dice: triple, hand: shonbenHand(), rng: cur };
  }
  return { dice: triple, hand: evaluateHand(triple), rng: cur };
}

/** CPU がそのまま確定する役の基準（これより弱ければ、残り回数の範囲で振り直す）。 */
function cpuKeeps(hand: CcHand): boolean {
  if (hand.kind === "pinzoro" || hand.kind === "arashi" || hand.kind === "shigoro") return true;
  if (hand.kind === "normal") return (hand.point ?? 0) >= 3;
  return false; // ヒフミは振り直す
}

/** CPU（親）の投げを最後まで解決する。 */
function cpuTakeTurn(rng: number): { dice: CcDice; hand: CcHand; rng: number } {
  let cur = rng;
  let last: RollOutcome | null = null;
  for (let i = 0; i < CC_MAX_ROLLS; i++) {
    last = rollOnce(cur);
    cur = last.rng;
    if (last.hand.kind === "shonben") break;
    if (isDetermined(last.hand) && cpuKeeps(last.hand)) break;
    // 目なしか、弱い役なら振り直す（最終投げはそのまま確定）
  }
  return { dice: (last as RollOutcome).dice, hand: (last as RollOutcome).hand, rng: cur };
}

export type CcPhase = "roll" | "decide" | "roundEnd" | "finished";

export type CcRoundResult = {
  round: number;
  cpuDice: CcDice;
  cpuHand: CcHand;
  playerDice: CcDice;
  playerHand: CcHand;
  winner: "player" | "cpu" | "draw";
  /** 移動した点数（勝者が得た分。引き分けは 0）。 */
  points: number;
};

export type CcState = {
  seed: number;
  rng: number;
  /** 現在のラウンド（1 始まり）。 */
  round: number;
  phase: CcPhase;
  /** このラウンドで親（CPU）が確定させた出目と役。 */
  cpuDice: CcDice;
  cpuHand: CcHand;
  /** プレイヤーの現在の出目と役（まだ振っていなければ null）。 */
  playerDice: CcDice | null;
  playerHand: CcHand | null;
  /** このラウンドでプレイヤーが振った回数。 */
  playerRolls: number;
  playerScore: number;
  cpuScore: number;
  history: CcRoundResult[];
};

function startRound(seed: number, rng: number, round: number, playerScore: number, cpuScore: number, history: CcRoundResult[]): CcState {
  const cpu = cpuTakeTurn(rng);
  return {
    seed,
    rng: cpu.rng,
    round,
    phase: "roll",
    cpuDice: cpu.dice,
    cpuHand: cpu.hand,
    playerDice: null,
    playerHand: null,
    playerRolls: 0,
    playerScore,
    cpuScore,
    history,
  };
}

export function createChinchiroGame(seed: number): CcState {
  return startRound(seed | 0, seed | 0, 1, 0, 0, []);
}

/** ラウンドを締めて得点を移動させる。 */
function resolveRound(state: CcState, playerDice: CcDice, playerHand: CcHand): CcState {
  const cmp = compareHands(playerHand, state.cpuHand);
  const winner: CcRoundResult["winner"] = cmp > 0 ? "player" : cmp < 0 ? "cpu" : "draw";
  let points = 0;
  if (winner !== "draw") {
    const winnerHand = winner === "player" ? playerHand : state.cpuHand;
    const loserHand = winner === "player" ? state.cpuHand : playerHand;
    points = CC_BASE_POINTS * winnerHand.multiplier;
    if (loserHand.kind === "hifumi") points *= 2;
  }
  const result: CcRoundResult = {
    round: state.round,
    cpuDice: state.cpuDice,
    cpuHand: state.cpuHand,
    playerDice,
    playerHand,
    winner,
    points,
  };
  return {
    ...state,
    playerDice,
    playerHand,
    playerScore: state.playerScore + (winner === "player" ? points : winner === "cpu" ? -points : 0),
    cpuScore: state.cpuScore + (winner === "cpu" ? points : winner === "player" ? -points : 0),
    history: [...state.history, result],
    phase: state.round >= CC_TOTAL_ROUNDS ? "finished" : "roundEnd",
  };
}

/**
 * プレイヤーがサイコロを振る（初投げと振り直しの両方）。
 * 3回目の投げが終われば、その出目で自動的にラウンドが締まる。
 */
export function rollCc(state: CcState): CcState {
  if (state.phase !== "roll" && state.phase !== "decide") return state;
  if (state.playerRolls >= CC_MAX_ROLLS) return state;
  const outcome = rollOnce(state.rng);
  const rolls = state.playerRolls + 1;
  const rolled: CcState = {
    ...state,
    rng: outcome.rng,
    playerDice: outcome.dice,
    playerHand: outcome.hand,
    playerRolls: rolls,
  };
  if (rolls >= CC_MAX_ROLLS || outcome.hand.kind === "shonben") {
    return resolveRound(rolled, outcome.dice, outcome.hand);
  }
  return { ...rolled, phase: isDetermined(outcome.hand) ? "decide" : "roll" };
}

/** 現在の役で確定する（decide フェーズのみ）。 */
export function keepCcHand(state: CcState): CcState {
  if (state.phase !== "decide" || !state.playerDice || !state.playerHand) return state;
  return resolveRound(state, state.playerDice, state.playerHand);
}

/** 次のラウンドへ進む（roundEnd フェーズのみ）。親（CPU）が先に役を確定させる。 */
export function nextCcRound(state: CcState): CcState {
  if (state.phase !== "roundEnd") return state;
  return startRound(state.seed, state.rng, state.round + 1, state.playerScore, state.cpuScore, state.history);
}

/** ゲーム全体の勝者（finished のときのみ意味がある）。 */
export function ccWinner(state: CcState): "player" | "cpu" | "draw" {
  if (state.playerScore > state.cpuScore) return "player";
  if (state.playerScore < state.cpuScore) return "cpu";
  return "draw";
}
