// AGO WORLD BOX のスタミナとダッシュ/泳ぎ入力判定（純粋ロジック）。
// ゼルダ式: ダッシュと泳ぎで減り、使わなければ自動で戻る。空になると
// ダッシュは一定量回復するまで封じられ、水中で空になると陸へ戻される。
// 状態遷移と入力の2度押し/スティック判定だけを持ち、描画と移動は呼び出し側。

/** スタミナ上限。 */
export const STAMINA_MAX = 100;
/** ダッシュ（陸）の消費（/秒）。満タンで約4.5秒走れる。 */
export const DASH_DRAIN_PER_SEC = 22;
/** 泳ぎの消費（/秒）。満タンで約14秒泳げる。 */
export const SWIM_DRAIN_PER_SEC = 7;
/** ダッシュ泳ぎの消費（/秒）。泳ぎより速く減る。 */
export const SWIM_DASH_DRAIN_PER_SEC = 26;
/** 回復量（/秒）。空から満タンまで約6秒。 */
export const STAMINA_REGEN_PER_SEC = 16;
/** 使い終わってから回復が始まるまでの遅延（秒）。 */
export const STAMINA_REGEN_DELAY_SEC = 0.8;
/** 空になった後、ダッシュが再び使えるようになる回復量。 */
export const DASH_RELOCK_STAMINA = 30;
/** 水中で空になった際、陸へ戻された直後に置かれる下限値。 */
export const SWIM_RESCUE_STAMINA = 20;
/** 満タンでもゲージを出し続ける「最近使った」時間（秒）。 */
export const STAMINA_GAUGE_HOLD_SEC = 1.6;
/** スティックをダッシュとみなす倒し量（0〜1、この値を超えたら）。 */
export const STICK_DASH_THRESHOLD = 0.85;
/** キー2度押しとみなす間隔（ミリ秒）。 */
export const DOUBLE_TAP_MS = 300;

/** スタミナの使い道。 */
export type StaminaUse = "none" | "dash" | "swim" | "swimDash";

export type StaminaState = {
  /** 現在量（0〜STAMINA_MAX）。 */
  value: number;
  /** 空になった（ダッシュ封じ中）。DASH_RELOCK_STAMINA まで回復すると解ける。 */
  exhausted: boolean;
  /** 最後に消費してからの経過（秒）。回復遅延とゲージ表示の判定に使う。 */
  idleSec: number;
};

export function createStamina(): StaminaState {
  return { value: STAMINA_MAX, exhausted: false, idleSec: STAMINA_GAUGE_HOLD_SEC };
}

/** 使い道ごとの消費レート（/秒）。 */
export function staminaDrainRate(use: StaminaUse): number {
  switch (use) {
    case "dash":
      return DASH_DRAIN_PER_SEC;
    case "swim":
      return SWIM_DRAIN_PER_SEC;
    case "swimDash":
      return SWIM_DASH_DRAIN_PER_SEC;
    default:
      return 0;
  }
}

/** ダッシュできるか（残量があり、空封じ中でない）。 */
export function canDash(s: StaminaState): boolean {
  return s.value > 0 && !s.exhausted;
}

/**
 * dt 秒ぶん進める。消費中は減らし、空になった瞬間に emptied=true を返す。
 * 使っていない間は遅延の後に回復し、満タンで止まる。
 */
export function stepStamina(s: StaminaState, use: StaminaUse, dt: number): { state: StaminaState; emptied: boolean } {
  const step = Math.max(0, dt);
  const rate = staminaDrainRate(use);
  if (rate > 0) {
    const value = Math.max(0, s.value - rate * step);
    const emptied = value <= 0 && s.value > 0;
    return {
      state: { value, exhausted: s.exhausted || emptied, idleSec: 0 },
      emptied,
    };
  }
  const idleBefore = s.idleSec;
  const idleSec = idleBefore + step;
  const regenTime = Math.max(0, idleSec - STAMINA_REGEN_DELAY_SEC) - Math.max(0, idleBefore - STAMINA_REGEN_DELAY_SEC);
  const value = Math.min(STAMINA_MAX, s.value + STAMINA_REGEN_PER_SEC * regenTime);
  return {
    state: { value, exhausted: s.exhausted && value < DASH_RELOCK_STAMINA, idleSec },
    emptied: false,
  };
}

/** 水中で空になった際の帰還後スタミナ（下限値を置き、ダッシュ封じは継続）。 */
export function rescueStamina(s: StaminaState): StaminaState {
  return { value: Math.max(s.value, SWIM_RESCUE_STAMINA), exhausted: true, idleSec: 0 };
}

/** 円形ゲージを出すか（満タンかつ十分に放置されていたら隠す）。 */
export function staminaGaugeVisible(s: StaminaState): boolean {
  return s.value < STAMINA_MAX || s.idleSec < STAMINA_GAUGE_HOLD_SEC;
}

/** スティックの倒し量がダッシュ域か。 */
export function isStickDash(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > STICK_DASH_THRESHOLD;
}

// ---- キー2度押し（ダッシュ） ----

export type TapTracker = {
  /** 最後に押されたキー（移動キー以外は null に倒す）。 */
  key: string | null;
  /** 最後に押された時刻（ミリ秒）。 */
  at: number;
};

export function createTapTracker(): TapTracker {
  return { key: null, at: 0 };
}

/**
 * キーを押したことを記録し、同じキーが DOUBLE_TAP_MS 以内に
 * 再び押されていたら doubleTapped=true を返す。
 */
export function registerKeyTap(t: TapTracker, key: string, nowMs: number): { tracker: TapTracker; doubleTapped: boolean } {
  const doubleTapped = t.key === key && nowMs >= t.at && nowMs - t.at <= DOUBLE_TAP_MS;
  return { tracker: { key, at: nowMs }, doubleTapped };
}
