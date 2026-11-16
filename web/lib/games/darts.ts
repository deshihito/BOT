// ダーツ（カウントアップ）の純粋ロジック（UI 非依存・シード決定的）。
// 座標はボード中心を (0,0)、ダブルリング外周を半径 1 とする正規化座標（y は上向き）。
// 3投を1ラウンドとして既定8ラウンド、合計点を競う。

/** 上（12時方向）から時計回りのセクター番号列。 */
export const DART_SECTORS = [
  20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5,
] as const;

/** 半径の境界（正規化）。 */
export const DART_RADII = {
  bullInner: 0.07, // インブル（50点）
  bullOuter: 0.16, // アウターブル（25点）
  tripleInner: 0.53,
  tripleOuter: 0.58,
  doubleInner: 0.94,
  doubleOuter: 1.0,
} as const;

export type DartHit = {
  /** 得点。 */
  score: number;
  /** セクター番号（ブルは 25、ミスは 0）。 */
  number: number;
  /** 倍率（0=ミス、1=シングル、2=ダブル、3=トリプル、ブルは 50点で2 / 25点で1）。 */
  multiplier: number;
  /** 表示用ラベル（例: "20", "T20", "D16", "BULL", "OUTER BULL", "MISS"）。 */
  label: string;
  isBull: boolean;
};

export type DartsThrow = DartHit & { x: number; y: number };

export type DartsState = {
  seed: number;
  rng: number;
  /** 全ラウンド数。 */
  totalRounds: number;
  /** 投擲済み（ラウンドごとの配列）。 */
  rounds: DartsThrow[][];
  status: "playing" | "finished";
  /** 微ブレを有効にするか（作成時に固定）。 */
  jitter: boolean;
  totalScore: number;
};

/** mulberry32。状態を数値で持ち回る。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

/** 座標から当たったエリアと得点を判定する。 */
export function scoreDart(x: number, y: number): DartHit {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { score: 0, number: 0, multiplier: 0, label: "MISS", isBull: false };
  }
  const r = Math.hypot(x, y);
  if (r > DART_RADII.doubleOuter) {
    return { score: 0, number: 0, multiplier: 0, label: "MISS", isBull: false };
  }
  if (r <= DART_RADII.bullInner) {
    return { score: 50, number: 25, multiplier: 2, label: "BULL", isBull: true };
  }
  if (r <= DART_RADII.bullOuter) {
    return { score: 25, number: 25, multiplier: 1, label: "OUTER BULL", isBull: true };
  }
  // 上方向（+y）を 0 度として時計回りの角度。
  let deg = (Math.atan2(x, y) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  const sectorIndex = Math.floor(((deg + 9) % 360) / 18) % 20;
  const number = DART_SECTORS[sectorIndex];
  if (r >= DART_RADII.doubleInner) {
    return { score: number * 2, number, multiplier: 2, label: `D${number}`, isBull: false };
  }
  if (r >= DART_RADII.tripleInner && r <= DART_RADII.tripleOuter) {
    return { score: number * 3, number, multiplier: 3, label: `T${number}`, isBull: false };
  }
  return { score: number, number, multiplier: 1, label: `${number}`, isBull: false };
}

export function createDartsGame(seed: number, totalRounds: number = 8, jitter: boolean = true): DartsState {
  const rounds = Number.isInteger(totalRounds) ? Math.min(20, Math.max(1, totalRounds)) : 8;
  return {
    seed: seed | 0,
    rng: seed | 0,
    totalRounds: rounds,
    rounds: [],
    status: "playing",
    jitter: Boolean(jitter),
    totalScore: 0,
  };
}

/** 現在のラウンド番号（0始まり）。終了時は totalRounds。 */
export function currentRound(state: DartsState): number {
  return state.rounds.length;
}

/** 現在ラウンドの投擲数（0〜2、次に投げるのはこの本数+1投目）。 */
export function throwsInCurrentRound(state: DartsState): number {
  if (state.status === "finished") return 0;
  const last = state.rounds[state.rounds.length - 1];
  if (!last) return 0;
  return last.length >= 3 ? 0 : last.length;
}

/**
 * 1投する。jitter が有効ならクリック点に小さなブレ（最大半径0.05）を加えてから判定する。
 * 有効範囲外の座標や終了後の投擲は状態を変えない。
 */
export function throwDart(state: DartsState, x: number, y: number): DartsState {
  if (state.status !== "playing") return state;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return state;
  if (Math.abs(x) > 1.3 || Math.abs(y) > 1.3) return state;
  let rng = state.rng;
  let tx = x;
  let ty = y;
  if (state.jitter) {
    const a = nextRandom(rng);
    rng = a.rng;
    const b = nextRandom(rng);
    rng = b.rng;
    const angle = a.value * Math.PI * 2;
    const dist = b.value * 0.05;
    tx = x + Math.cos(angle) * dist;
    ty = y + Math.sin(angle) * dist;
  }
  const hit = scoreDart(tx, ty);
  const entry: DartsThrow = { ...hit, x: tx, y: ty };
  const rounds = state.rounds.map((r) => [...r]);
  const last = rounds[rounds.length - 1];
  if (!last || last.length >= 3) {
    rounds.push([entry]);
  } else {
    last.push(entry);
  }
  const finished = rounds.length >= state.totalRounds && rounds[rounds.length - 1].length >= 3;
  return {
    ...state,
    rng,
    rounds,
    totalScore: state.totalScore + hit.score,
    status: finished ? "finished" : "playing",
  };
}

/** ラウンドごとの小計。 */
export function roundScores(state: DartsState): number[] {
  return state.rounds.map((r) => r.reduce((sum, t) => sum + t.score, 0));
}
