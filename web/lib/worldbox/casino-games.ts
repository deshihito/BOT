// WORLD BOX カジノのセッション型ゲームの純粋ロジック。
// Bot 側ギャンブル（core/game/gambling/gambling.py）の slot7 / ダブルアップ /
// ダイスの状態遷移を、原典パラメータのまま Web へ移行したもの。
// 乱数は引数で受け取る（テストで差し替え可能）。状態は JSON 化可能な値のみ。
//
// WORLD BOX 版の適応（ブリッジ制約による）:
// - slot7 の 66666 全額没収は採用しない（ブリッジに残高全額を引く手段がない）。
//   イベント自体は発生し、そのスピンの報酬が 0 になるだけ。
// - slot7 のベットは固定 1000 でなく選択中の階梯（報酬はベット比例）。

// ---------------------------------------------------------------- 共通の内部状態
// slot7 とダブルアップで共有するユーザー内部状態（原典 _empty_user と同じ）。
export type CasinoUserState = {
  kakuhen: number;
  sixCounter: number;
  loseStreak: number;
  winStreak: number;
  internalMode: "NORMAL" | "HELL" | "CHARGE" | "FEVER";
};

export function emptyCasinoUserState(): CasinoUserState {
  return { kakuhen: 0, sixCounter: 0, loseStreak: 0, winStreak: 0, internalMode: "NORMAL" };
}

const INTERNAL_MODES = ["NORMAL", "HELL", "CHARGE", "FEVER"] as const;

export function cleanCasinoUserState(raw: unknown): CasinoUserState {
  const out = emptyCasinoUserState();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  for (const key of ["kakuhen", "sixCounter", "loseStreak", "winStreak"] as const) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[key] = Math.floor(v);
  }
  if ((INTERNAL_MODES as readonly string[]).includes(String(r.internalMode))) {
    out.internalMode = r.internalMode as CasinoUserState["internalMode"];
  }
  return out;
}

// ---------------------------------------------------------------- slot7
// 回数指定は廃止済み（2026-11-17）: セッションは常に1回分（route.ts の slot7_start）。
/** 揃った個数 → 基本倍率（原典 SLOT_BASE_MULTIPLIERS）。 */
export const SLOT7_BASE_MULTIPLIERS: Record<number, number> = { 2: 1.1, 3: 6, 4: 25, 5: 120, 6: 500, 7: 2000 };
export const SLOT7_PITY_STREAK = 3;
export const SLOT7_PITY_MULTIPLIER = 50;
export const SLOT7_SEVEN_BONUS = 5;
export const SLOT7_KAKUHEN_SPINS = 7;
export const SLOT7_KAKUHEN_MULTIPLIER = 3;
export const SLOT7_SUPER_JACKPOT_MULTIPLIER = 100000;
export const SLOT7_SIX_PENALTY_MULTIPLIER = 9;
const WEIGHT_SIX_NORMAL = 16;
const WEIGHT_SIX_KAKUHEN = 14;
const WEIGHT_SEVEN = 5;
const WEIGHT_OTHER = 8;
const SIX_COUNTER_RATE = 0.01;
const FORCE_SIX_PROBABILITY = 0.5;

/** 数字0〜9のリール重み（原典 _reel_weights、お祓い棒なし）。 */
export function slot7ReelWeights(kakuhen: boolean): number[] {
  const six = kakuhen ? WEIGHT_SIX_KAKUHEN : WEIGHT_SIX_NORMAL;
  return [WEIGHT_OTHER, WEIGHT_OTHER, WEIGHT_OTHER, WEIGHT_OTHER, WEIGHT_OTHER, WEIGHT_OTHER, six, WEIGHT_SEVEN, WEIGHT_OTHER, WEIGHT_OTHER];
}

export type Slot7SpinResult = {
  reels: number[];
  maxMatch: number;
  matchedNumber: number;
  /** このスピンの払い戻し（ベット比例の総額。ペナルティ時は 0）。 */
  reward: number;
  /** 6ペナルティの追加引き落とし額（なければ 0）。 */
  penalty: number;
  /** 66666 イベント（WORLD BOX 版では没収なし・報酬0のみ）。 */
  sixEvent: boolean;
  events: string[];
  kakuhen: number;
};

function pickWeighted(weights: number[], rng: () => number): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i];
    if (x < 0) return i;
  }
  return weights.length - 1;
}

/** 1スピン。原典 spin_slot の状態遷移を再現し、userState を更新する。 */
export function spinSlot7(
  userState: CasinoUserState,
  bet: number,
  rng: () => number,
): Slot7SpinResult {
  const st = userState;
  const kakuhenActive = st.kakuhen > 0;
  const streak = st.loseStreak;
  if (kakuhenActive) st.sixCounter += 1;
  let forceSix = false;
  if (!kakuhenActive) {
    const counter = st.sixCounter;
    if (rng() < counter * SIX_COUNTER_RATE) {
      st.sixCounter = 0;
      forceSix = rng() < FORCE_SIX_PROBABILITY;
    }
  }
  const weights = slot7ReelWeights(kakuhenActive);
  const reels: number[] = [];
  if (forceSix) {
    for (let i = 0; i < 5; i++) reels.push(6);
    reels.push(pickWeighted([1, 1, 1, 1, 1, 1, 1, 1, 1, 1], rng));
    reels.push(pickWeighted([1, 1, 1, 1, 1, 1, 1, 1, 1, 1], rng));
  } else {
    for (let i = 0; i < 7; i++) reels.push(pickWeighted(weights, rng));
  }
  const counts = new Map<number, number>();
  for (const d of reels) counts.set(d, (counts.get(d) ?? 0) + 1);
  const maxMatch = Math.max(...counts.values());
  const matched = reels.find((d) => counts.get(d) === maxMatch) ?? reels[0];
  const events: string[] = [];
  let reward = 0;
  let penalty = 0;
  let sixEvent = false;
  if (streak >= SLOT7_PITY_STREAK) {
    reward = bet * SLOT7_PITY_MULTIPLIER;
    st.loseStreak = 0;
    events.push("pity");
  } else if (maxMatch >= 2) {
    reward = Math.floor(bet * (SLOT7_BASE_MULTIPLIERS[maxMatch] ?? 0));
    if (matched === 7) {
      reward *= SLOT7_SEVEN_BONUS;
      events.push("seven_bonus");
      if (maxMatch >= 3) {
        st.kakuhen = SLOT7_KAKUHEN_SPINS;
        events.push("kakuhen_start");
      }
    } else if (matched === 6 && !kakuhenActive) {
      if (maxMatch >= 5) {
        sixEvent = true;
        reward = 0;
        events.push("six_confiscate");
      } else {
        penalty = Math.floor(bet * SLOT7_SIX_PENALTY_MULTIPLIER);
        reward = 0;
        events.push("six_penalty");
      }
    }
    if (kakuhenActive) {
      if (maxMatch >= 3 && matched === 6) {
        st.kakuhen -= 1;
        events.push("kakuhen_decrease");
      } else {
        reward = Math.floor(reward * SLOT7_KAKUHEN_MULTIPLIER);
        events.push("kakuhen_multiplier");
      }
      if ((counts.get(7) ?? 0) >= 2) {
        st.kakuhen += 1;
        events.push("kakuhen_extend");
      }
      if (reels.every((d) => d === 7)) {
        reward = bet * SLOT7_SUPER_JACKPOT_MULTIPLIER;
        sixEvent = false;
        events.push("super_jackpot");
      }
    }
    st.loseStreak = 0;
  } else {
    st.loseStreak = streak + 1;
  }
  if (kakuhenActive) {
    st.kakuhen -= 1;
    if (st.kakuhen <= 0) {
      st.kakuhen = 0;
      events.push("kakuhen_end");
    }
  }
  return {
    reels,
    maxMatch,
    matchedNumber: matched,
    reward,
    penalty,
    sixEvent,
    events,
    kakuhen: st.kakuhen,
  };
}

// ---------------------------------------------------------------- ダブルアップ
export const DOUBLE_MULTIPLIER_STEP = 1.6;
export const DOUBLE_RATE_NORMAL = 0.6;
export const DOUBLE_RATE_FEVER = 0.75;
export const DOUBLE_HELL_LOSE_STREAK = 3;
export const DOUBLE_CHARGE_LOSE_STREAK = 6;
export const DOUBLE_FEVER_EXIT_WIN_STREAK = 3;
export const DOUBLE_HELL_PAYOUT_THRESHOLD = 500;

export type DoubleSessionState = { bet: number; multiplier: number; streak: number };

export type DoubleGoResult = {
  win: boolean;
  multiplier: number;
  streak: number;
  currentValue: number;
  finished: boolean;
};

/** GO を1回引く（原典 double_go）。負けたらセッション終了。 */
export function doubleGo(
  session: DoubleSessionState,
  userState: CasinoUserState,
  rng: () => number,
): DoubleGoResult {
  const st = userState;
  const rate = st.internalMode === "FEVER" ? DOUBLE_RATE_FEVER : DOUBLE_RATE_NORMAL;
  const win = rng() < rate;
  if (win) {
    session.streak += 1;
    session.multiplier *= DOUBLE_MULTIPLIER_STEP;
    st.winStreak += 1;
    st.loseStreak = 0;
    if (st.internalMode === "CHARGE") st.internalMode = "FEVER";
    if (st.internalMode === "FEVER" && st.winStreak >= DOUBLE_FEVER_EXIT_WIN_STREAK) {
      st.internalMode = "NORMAL";
      st.winStreak = 0;
    }
    return {
      win,
      multiplier: session.multiplier,
      streak: session.streak,
      currentValue: Math.floor(session.bet * session.multiplier),
      finished: false,
    };
  }
  st.loseStreak += 1;
  st.winStreak = 0;
  if (st.loseStreak >= DOUBLE_CHARGE_LOSE_STREAK) st.internalMode = "CHARGE";
  else if (st.loseStreak >= DOUBLE_HELL_LOSE_STREAK) st.internalMode = "HELL";
  return {
    win,
    multiplier: session.multiplier,
    streak: session.streak,
    currentValue: Math.floor(session.bet * session.multiplier),
    finished: true,
  };
}

/** キャッシュアウト額（原典 double_cashout。閾値超えで HELL 落ちも適用）。 */
export function doubleCashout(session: DoubleSessionState, userState: CasinoUserState): number {
  const payout = Math.floor(session.bet * session.multiplier);
  if (payout > DOUBLE_HELL_PAYOUT_THRESHOLD) userState.internalMode = "HELL";
  return payout;
}

// ---------------------------------------------------------------- ダイス
export const DICE_MIN_MAX = 5;
export const DICE_MAX_MAX = 10000;
/** パネルが提示する範囲の選択肢。 */
export const DICE_RANGES = [6, 20, 100] as const;

export function validateDice(maxValue: number, number: number): string | null {
  if (!Number.isInteger(maxValue) || maxValue < DICE_MIN_MAX || maxValue > DICE_MAX_MAX) {
    return "invalid_dice_range";
  }
  if (!Number.isInteger(number) || number < 1 || number > maxValue) return "invalid_dice_number";
  return null;
}

/** 数字当て抽選（原典 play_dice。当たれば bet × max の払い戻し）。 */
export function rollDice(maxValue: number, rng: () => number): number {
  return Math.floor(rng() * maxValue) + 1;
}
