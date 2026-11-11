// ビルディング（Skyscrapers）の純粋ロジック（UI 非依存・シード決定的）。
// ルール: N×N（N=4 または 5）の各マスに 1〜N の高さのビルを1つずつ置く。
// - 各行・各列に 1〜N が1つずつ入る。
// - 外周のヒント数字は「その方向から見えるビルの数」。高いビルがあると
//   後ろの低いビルは隠れる（見える数 = 左から走査したときの最大値の更新回数）。
// 生成は「解を先に作る」方式: ラテン方陣を作ってから外周ヒントを計算するので、
// 必ず解けることが保証される。難易度として一部のヒントを隠すことができるが、
// その場合（隠さなくても）解の一意性は保証しない。完成判定は正解との一致では
// なくルール検証で行うため、ルールを満たす別解でもクリアになる。
// 隠したヒント（0）はルール検証の対象外。

export type SkyscrapersSize = 4 | 5;

export type SkyClues = {
  /** 上から見たときの、列ごとの見える数（0 = 非表示）。 */
  top: number[];
  /** 下から見たときの、列ごとの見える数（0 = 非表示）。 */
  bottom: number[];
  /** 左から見たときの、行ごとの見える数（0 = 非表示）。 */
  left: number[];
  /** 右から見たときの、行ごとの見える数（0 = 非表示）。 */
  right: number[];
};

export type SkyViolationType = "rowDup" | "colDup" | "clue";

export type SkyViolation = {
  type: SkyViolationType;
  cells: number[];
  message: string;
};

export type SkyscrapersState = {
  size: SkyscrapersSize;
  seed: number;
  /** 正解（ラテン方陣、1〜N）。生成の検証用に保持する。 */
  solution: number[];
  clues: SkyClues;
  /** 現在の盤面（0 = 空き、1〜N = 入力）。 */
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

function shuffled<T>(items: T[], rng: number): { items: T[]; rng: number } {
  const arr = [...items];
  let r = rng;
  for (let i = arr.length - 1; i > 0; i--) {
    const n = nextRandom(r);
    r = n.rng;
    const j = Math.floor(n.value * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return { items: arr, rng: r };
}

/** 一方向から見えるビルの数（最大値の更新回数）。 */
export function visibleCount(line: number[]): number {
  let max = 0;
  let count = 0;
  for (const v of line) {
    if (v > max) {
      max = v;
      count++;
    }
  }
  return count;
}

/** 循環ラテン方陣に行・列・記号の置換を適用して解を作る。 */
function buildSolution(size: SkyscrapersSize, rng: number): { solution: number[]; rng: number } {
  const base: number[][] = [];
  for (let r = 0; r < size; r++) {
    const row: number[] = [];
    for (let c = 0; c < size; c++) row.push(((r + c) % size) + 1);
    base.push(row);
  }
  let cur = rng;
  const rowPerm = shuffled(
    Array.from({ length: size }, (_, i) => i),
    cur,
  );
  cur = rowPerm.rng;
  const colPerm = shuffled(
    Array.from({ length: size }, (_, i) => i),
    cur,
  );
  cur = colPerm.rng;
  const symPerm = shuffled(
    Array.from({ length: size }, (_, i) => i + 1),
    cur,
  );
  cur = symPerm.rng;
  const solution: number[] = new Array(size * size).fill(0);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      solution[r * size + c] = symPerm.items[base[rowPerm.items[r]][colPerm.items[c]] - 1];
    }
  }
  return { solution, rng: cur };
}

function cluesFromSolution(size: SkyscrapersSize, solution: number[]): SkyClues {
  const top: number[] = [];
  const bottom: number[] = [];
  const left: number[] = [];
  const right: number[] = [];
  for (let c = 0; c < size; c++) {
    const col = Array.from({ length: size }, (_, r) => solution[r * size + c]);
    top.push(visibleCount(col));
    bottom.push(visibleCount([...col].reverse()));
  }
  for (let r = 0; r < size; r++) {
    const row = solution.slice(r * size, r * size + size);
    left.push(visibleCount(row));
    right.push(visibleCount([...row].reverse()));
  }
  return { top, bottom, left, right };
}

/**
 * 問題を生成する。hideCount > 0 のときは外周ヒントの一部を隠す（難易度調整）。
 * 隠したヒントは 0 になり、ルール検証の対象からも外れる。
 */
export function createSkyscrapersGame(
  size: SkyscrapersSize,
  seed: number,
  hideCount = 0,
): SkyscrapersState {
  const n: SkyscrapersSize = size === 5 ? 5 : 4;
  let rng = seed | 0;
  const built = buildSolution(n, rng);
  rng = built.rng;
  const clues = cluesFromSolution(n, built.solution);
  const hide = Math.max(0, Math.min(hideCount, 4 * n - 4));
  if (hide > 0) {
    // 4辺ぶんのヒント位置（辺 0=top 1=bottom 2=left 3=right）をシャッフルして隠す。
    const slots: { side: keyof SkyClues; index: number }[] = [];
    (Object.keys(clues) as (keyof SkyClues)[]).forEach((side) => {
      clues[side].forEach((_, index) => slots.push({ side, index }));
    });
    const order = shuffled(slots, rng);
    rng = order.rng;
    for (const slot of order.items.slice(0, hide)) {
      clues[slot.side][slot.index] = 0;
    }
  }
  return {
    size: n,
    seed: seed | 0,
    solution: built.solution,
    clues,
    values: new Array(n * n).fill(0),
    moves: 0,
    status: "playing",
  };
}

/** ルール違反を列挙する（空きマス自体は違反にしない）。 */
export function skyViolations(state: SkyscrapersState): SkyViolation[] {
  const { size, values, clues } = state;
  const out: SkyViolation[] = [];
  const at = (r: number, c: number): number => values[r * size + c];

  // 行・列の重複（入力済みの数字同士）。
  for (let r = 0; r < size; r++) {
    const seen = new Map<number, number[]>();
    for (let c = 0; c < size; c++) {
      const v = at(r, c);
      if (v === 0) continue;
      const list = seen.get(v) ?? [];
      list.push(r * size + c);
      seen.set(v, list);
    }
    for (const [v, cells] of seen) {
      if (cells.length > 1) {
        out.push({ type: "rowDup", cells, message: `${r + 1}行目で ${v} が重なっています` });
      }
    }
  }
  for (let c = 0; c < size; c++) {
    const seen = new Map<number, number[]>();
    for (let r = 0; r < size; r++) {
      const v = at(r, c);
      if (v === 0) continue;
      const list = seen.get(v) ?? [];
      list.push(r * size + c);
      seen.set(v, list);
    }
    for (const [v, cells] of seen) {
      if (cells.length > 1) {
        out.push({ type: "colDup", cells, message: `${c + 1}列目で ${v} が重なっています` });
      }
    }
  }

  // ヒントとの不一致（その行・列が全部埋まっていて、ヒントが表示されている場合のみ）。
  const checkLine = (cells: number[], clue: number, label: string) => {
    if (clue === 0) return;
    const line = cells.map((i) => values[i]);
    if (line.some((v) => v === 0)) return;
    const seen = visibleCount(line);
    if (seen !== clue) {
      out.push({
        type: "clue",
        cells,
        message: `${label}から見えるビルは ${seen} つですが、ヒントは ${clue} です`,
      });
    }
  };
  for (let c = 0; c < size; c++) {
    const colCells = Array.from({ length: size }, (_, r) => r * size + c);
    checkLine(colCells, clues.top[c], `上`);
    checkLine([...colCells].reverse(), clues.bottom[c], `下`);
  }
  for (let r = 0; r < size; r++) {
    const rowCells = Array.from({ length: size }, (_, c) => r * size + c);
    checkLine(rowCells, clues.left[r], `左`);
    checkLine([...rowCells].reverse(), clues.right[r], `右`);
  }
  return out;
}

export function checkSky(state: SkyscrapersState): { complete: boolean; violations: SkyViolation[] } {
  const violations = skyViolations(state);
  const complete = state.values.every((v) => v !== 0) && violations.length === 0;
  return { complete, violations };
}

/** マスに 0（消去）〜N を入力する。不正な入力は無視する。 */
export function setSkyValue(state: SkyscrapersState, index: number, value: number): SkyscrapersState {
  if (state.status === "won") return state;
  if (!Number.isInteger(index) || index < 0 || index >= state.values.length) return state;
  if (!Number.isInteger(value) || value < 0 || value > state.size) return state;
  if (state.values[index] === value) return state;
  const values = [...state.values];
  values[index] = value;
  const next: SkyscrapersState = { ...state, values, moves: state.moves + 1 };
  if (checkSky(next).complete) next.status = "won";
  return next;
}
