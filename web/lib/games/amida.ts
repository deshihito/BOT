// あみだくじの純粋ロジック（UI 非依存・シード決定的）。
// 縦線が count 本、横線は levels 段。各段では隣り合う縦線の間に最大で
// 非重複に横線を引く（同じ段で1本の横線が共有する縦線は2本まで）。
// 状態は JSON 化可能な値のみ。遷移関数は状態を破壊せず新しい状態を返す。

export const AMIDA_MIN_PLAYERS = 2;
export const AMIDA_MAX_PLAYERS = 8;
export const AMIDA_DEFAULT_LEVELS = 10;

export type AmidaState = {
  /** 参加者数（縦線の本数）。 */
  count: number;
  /** 段数。 */
  levels: number;
  /**
   * 横線。bars[level][i] が true なら、その段で縦線 i と i+1 の間に横線がある。
   * 各行の長さは count - 1。同じ段で隣り合う要素が両方 true になることはない。
   */
  bars: boolean[][];
  seed: number;
};

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function clampCount(count: number): number {
  if (!Number.isFinite(count)) return AMIDA_MIN_PLAYERS;
  return Math.min(AMIDA_MAX_PLAYERS, Math.max(AMIDA_MIN_PLAYERS, Math.floor(count)));
}

export function createAmida(
  count: number,
  seed: number,
  levels: number = AMIDA_DEFAULT_LEVELS,
): AmidaState {
  const n = clampCount(count);
  const lv = Math.min(30, Math.max(1, Math.floor(levels) || AMIDA_DEFAULT_LEVELS));
  let rng = seed | 0;
  const bars: boolean[][] = [];
  for (let level = 0; level < lv; level++) {
    const row = new Array<boolean>(n - 1).fill(false);
    let i = 0;
    while (i < n - 1) {
      const r = nextRandom(rng);
      rng = r.rng;
      if (r.value < 0.45) {
        row[i] = true;
        i += 2; // 横線の右端の縦線は次の横線と共有しない
      } else {
        i += 1;
      }
    }
    bars.push(row);
  }
  return { count: n, levels: lv, bars, seed: seed | 0 };
}

/** あみだの構造が正しいか（段数・行長・同段非重複）を検証する。 */
export function isValidAmida(state: AmidaState): boolean {
  if (!state || state.count < AMIDA_MIN_PLAYERS || state.count > AMIDA_MAX_PLAYERS) return false;
  if (!Array.isArray(state.bars) || state.bars.length !== state.levels) return false;
  for (const row of state.bars) {
    if (!Array.isArray(row) || row.length !== state.count - 1) return false;
    for (let i = 0; i < row.length; i++) {
      if (typeof row[i] !== "boolean") return false;
      if (row[i] && row[i + 1]) return false;
    }
  }
  return true;
}

/**
 * 参加者 start の経路をたどる。
 * path[0] = start、path[level+1] = その段を通過した後の縦線 index。
 * 返り値の end が最終到達先。
 */
export function tracePath(state: AmidaState, start: number): { path: number[]; end: number } {
  if (!Number.isInteger(start) || start < 0 || start >= state.count) {
    return { path: [], end: -1 };
  }
  const path = [start];
  let x = start;
  for (let level = 0; level < state.levels; level++) {
    const row = state.bars[level];
    if (x > 0 && row[x - 1]) {
      x -= 1;
    } else if (x < state.count - 1 && row[x]) {
      x += 1;
    }
    path.push(x);
  }
  return { path, end: x };
}

/** 全参加者の到達先。results[start] = 到達先 index（置換になる）。 */
export function computeResults(state: AmidaState): number[] {
  return Array.from({ length: state.count }, (_, start) => tracePath(state, start).end);
}
