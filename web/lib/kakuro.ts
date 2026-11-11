// カックロの純粋ロジック（UI 非依存・シード決定的）。
// ルール: 黒マスには右方向（across）と下方向（down）の合計ヒントが付く。
// 白マスの連なり（ラン）にはヒントの合計になるよう 1〜9 の数字を入れ、
// 同じランの中で数字は重複しない。
// 生成は「完成盤を先に作る」方式: 白マスの配置（マスク）を作り、
// ラン内の重複禁止を満たす数字をバックトラックで埋めてから
// ヒント合計を計算するので、必ず解けることが保証される。
// 完成判定は正解との一致ではなくルール検証で行うため、別解でもクリアになる
// （一意解であることは保証しない）。一部の白マスは「与え数字」として固定表示する。

export const KAKURO_SIZE = 9;

export type KakuroCell =
  | { kind: "black"; down: number | null; across: number | null }
  | { kind: "white"; given: boolean };

export type KakuroRun = {
  dir: "across" | "down";
  cells: number[];
  sum: number;
  /** ヒントが書かれている黒マスの index。 */
  clue: number;
};

export type KakuroViolationType = "runDup" | "runSum";

export type KakuroViolation = {
  type: KakuroViolationType;
  cells: number[];
  message: string;
};

export type KakuroState = {
  size: number;
  seed: number;
  cells: KakuroCell[];
  runs: KakuroRun[];
  /** 正解（白マスは 1〜9、黒マスは 0）。生成の検証用に保持する。 */
  solution: number[];
  /** 現在の盤面（0 = 空き）。与え数字のマスは solution と同じ値で初期化される。 */
  values: number[];
  moves: number;
  status: "playing" | "won";
};

/** mulberry32（minesweeper 等と同一方式）。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

/**
 * 白マスの配置（マスク）を作る。幅2〜4・高さ2〜3の白ブロックを、
 * 周囲1マスの堀（黒マス）と重ならないように配置する構成法。
 * ブロック内では横ラン=幅・縦ラン=高さになり、どちらのランも
 * 必ず2以上になることが構造的に保証される。
 * 失敗したら null（呼び出し側で再試行）。
 */
function buildMask(rng: number): { mask: boolean[]; rng: number } | null {
  const size = KAKURO_SIZE;
  const mask = new Array<boolean>(size * size).fill(false);
  let cur = rng;
  let whites = 0;
  let attempts = 0;
  while (whites < 34 && attempts < 80) {
    attempts++;
    const wPick = nextRandom(cur);
    cur = wPick.rng;
    const hPick = nextRandom(cur);
    cur = hPick.rng;
    const w = 2 + Math.floor(wPick.value * 3); // 2〜4
    const h = 2 + Math.floor(hPick.value * 2); // 2〜3
    const rPick = nextRandom(cur);
    cur = rPick.rng;
    const cPick = nextRandom(cur);
    cur = cPick.rng;
    // 0 行目・0 列目はヒント専用に黒のままにする。
    const r0 = 1 + Math.floor(rPick.value * (size - h));
    const c0 = 1 + Math.floor(cPick.value * (size - w));
    let ok = true;
    for (let r = r0 - 1; r <= r0 + h && ok; r++) {
      for (let c = c0 - 1; c <= c0 + w; c++) {
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        if (mask[r * size + c]) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) continue;
    for (let r = r0; r < r0 + h; r++) {
      for (let c = c0; c < c0 + w; c++) {
        mask[r * size + c] = true;
        whites++;
      }
    }
  }
  if (whites < 30) return null;
  return { mask, rng: cur };
}

type RunSkeleton = { dir: "across" | "down"; cells: number[]; clue: number };

function collectRuns(mask: boolean[]): RunSkeleton[] {
  const size = KAKURO_SIZE;
  const runs: RunSkeleton[] = [];
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (!mask[r * size + c]) {
        c++;
        continue;
      }
      const cells: number[] = [];
      while (c < size && mask[r * size + c]) {
        cells.push(r * size + c);
        c++;
      }
      if (cells.length >= 2) runs.push({ dir: "across", cells, clue: cells[0] - 1 });
    }
  }
  for (let c = 0; c < size; c++) {
    let r = 0;
    while (r < size) {
      if (!mask[r * size + c]) {
        r++;
        continue;
      }
      const cells: number[] = [];
      while (r < size && mask[r * size + c]) {
        cells.push(r * size + c);
        r++;
      }
      if (cells.length >= 2) runs.push({ dir: "down", cells, clue: cells[0] - size });
    }
  }
  return runs;
}

/** ラン内の重複禁止だけを制約として数字を埋める（合計は後から計算する）。 */
function fillNumbers(
  mask: boolean[],
  runs: RunSkeleton[],
  rng: number,
): { solution: number[]; rng: number } | null {
  const size = KAKURO_SIZE;
  const solution = new Array<number>(size * size).fill(0);
  const whites: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) whites.push(i);
  // 各白マスが属するラン（最大で across / down の2つ）。
  const runsOf = new Map<number, RunSkeleton[]>();
  for (const run of runs) {
    for (const cell of run.cells) {
      const list = runsOf.get(cell) ?? [];
      list.push(run);
      runsOf.set(cell, list);
    }
  }
  let cur = rng;
  let steps = 0;
  const solveFrom = (pos: number): boolean => {
    if (pos >= whites.length) return true;
    if (++steps > 60000) return false;
    const cell = whites[pos];
    const used = new Set<number>();
    for (const run of runsOf.get(cell) ?? []) {
      for (const other of run.cells) {
        if (other !== cell && solution[other] !== 0) used.add(solution[other]);
      }
    }
    const candidates: number[] = [];
    for (let d = 1; d <= 9; d++) if (!used.has(d)) candidates.push(d);
    // 候補の順序をシャッフルして盤面に多様性を持たせる。
    for (let i = candidates.length - 1; i > 0; i--) {
      const n = nextRandom(cur);
      cur = n.rng;
      const j = Math.floor(n.value * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    for (const d of candidates) {
      solution[cell] = d;
      if (solveFrom(pos + 1)) return true;
      solution[cell] = 0;
      if (steps > 60000) return false;
    }
    return false;
  };
  if (!solveFrom(0)) return null;
  return { solution, rng: cur };
}

export function createKakuroGame(seed: number): KakuroState {
  let rng = seed | 0;
  let built: {
    cells: KakuroCell[];
    runs: KakuroRun[];
    solution: number[];
    values: number[];
  } | null = null;
  for (let attempt = 0; attempt < 300 && built === null; attempt++) {
    const maskRes = buildMask(rng);
    if (maskRes === null) {
      // buildMask が rng を返さなかった場合はシードを進めて再試行する。
      const n = nextRandom(rng);
      rng = n.rng;
      continue;
    }
    rng = maskRes.rng;
    const skeletons = collectRuns(maskRes.mask);
    const filled = fillNumbers(maskRes.mask, skeletons, rng);
    if (filled === null) {
      const n = nextRandom(rng);
      rng = n.rng;
      continue;
    }
    rng = filled.rng;
    const solution = filled.solution;
    const runs: KakuroRun[] = skeletons.map((run) => ({
      dir: run.dir,
      cells: [...run.cells],
      sum: run.cells.reduce((acc, i) => acc + solution[i], 0),
      clue: run.clue,
    }));
    // ヒントを黒マスへ割り当てる。
    const downHint = new Map<number, number>();
    const acrossHint = new Map<number, number>();
    for (const run of runs) {
      if (run.dir === "down") downHint.set(run.clue, run.sum);
      else acrossHint.set(run.clue, run.sum);
    }
    // 与え数字（約1割の白マスを固定表示する）。
    const values = new Array<number>(KAKURO_SIZE * KAKURO_SIZE).fill(0);
    const cells: KakuroCell[] = maskRes.mask.map((white, i) => {
      if (!white) {
        return {
          kind: "black" as const,
          down: downHint.get(i) ?? null,
          across: acrossHint.get(i) ?? null,
        };
      }
      const n = nextRandom(rng);
      rng = n.rng;
      const given = n.value < 0.1;
      if (given) values[i] = solution[i];
      return { kind: "white" as const, given };
    });
    built = { cells, runs, solution, values };
  }
  if (built === null) {
    // ここには通常到達しないが、型と実行時安全のためのフォールバック。
    throw new Error("カックロの生成に失敗しました");
  }
  return {
    size: KAKURO_SIZE,
    seed: seed | 0,
    cells: built.cells,
    runs: built.runs,
    solution: built.solution,
    values: built.values,
    moves: 0,
    status: "playing",
  };
}

/** ルール違反を列挙する（空きマス自体は違反にしない）。 */
export function kakuroViolations(state: KakuroState): KakuroViolation[] {
  const out: KakuroViolation[] = [];
  for (const run of state.runs) {
    const seen = new Map<number, number[]>();
    let filledCount = 0;
    let sum = 0;
    for (const idx of run.cells) {
      const v = state.values[idx];
      if (v === 0) continue;
      filledCount++;
      sum += v;
      const list = seen.get(v) ?? [];
      list.push(idx);
      seen.set(v, list);
    }
    for (const [v, cells] of seen) {
      if (cells.length > 1) {
        out.push({
          type: "runDup",
          cells,
          message: `${run.dir === "across" ? "横" : "縦"}の列に ${v} が重なっています`,
        });
      }
    }
    if (filledCount === run.cells.length && sum !== run.sum) {
      out.push({
        type: "runSum",
        cells: [...run.cells],
        message: `合計が ${run.sum} になっていません（いま ${sum}）`,
      });
    }
  }
  return out;
}

export function checkKakuro(state: KakuroState): { complete: boolean; violations: KakuroViolation[] } {
  const violations = kakuroViolations(state);
  const complete =
    state.cells.every((cell, i) => cell.kind === "black" || state.values[i] !== 0) &&
    violations.length === 0;
  return { complete, violations };
}

export function setKakuroValue(state: KakuroState, index: number, value: number): KakuroState {
  if (state.status === "won") return state;
  if (!Number.isInteger(index) || index < 0 || index >= state.cells.length) return state;
  if (!Number.isInteger(value) || value < 0 || value > 9) return state;
  const cell = state.cells[index];
  if (cell.kind !== "white" || cell.given) return state;
  if (state.values[index] === value) return state;
  const values = [...state.values];
  values[index] = value;
  const next: KakuroState = { ...state, values, moves: state.moves + 1 };
  if (checkKakuro(next).complete) next.status = "won";
  return next;
}
