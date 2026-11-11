// ケンケン（賢くなるパズル）の純粋ロジック（UI 非依存・シード決定的）。
// ルール: 各行・各列に 1〜N が1つずつ入る。太線で囲まれたケージには目標値と
// 演算（+ − × ÷）が付いていて、ケージ内の数字に演算を適用すると目標値になる
// （− と ÷ は2マスのケージのみ。1マスのケージは数字そのものが目標値）。
// 生成は「解を先に作る」方式: ラテン方陣を生成してからケージ分割をランダムに
// 作り、解の値から目標値を計算するので、必ず解けることが保証される。
// 完成判定は正解との一致ではなくルール検証で行うため、別解でもクリアになる
// （一意解であることは保証しない）。

export type KenkenSize = 4 | 5;
export type KenkenOp = "+" | "-" | "×" | "÷" | "";

export type KenkenCage = {
  id: number;
  cells: number[];
  target: number;
  op: KenkenOp;
};

export type KenkenViolationType = "rowDup" | "colDup" | "cage";

export type KenkenViolation = {
  type: KenkenViolationType;
  cells: number[];
  message: string;
};

export type KenkenState = {
  size: KenkenSize;
  seed: number;
  /** 正解（ラテン方陣、1〜N）。生成の検証用に保持する。 */
  solution: number[];
  cages: KenkenCage[];
  /** 各セルのケージ id。 */
  cageOf: number[];
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

function neighborsOf(index: number, size: number): number[] {
  const r = Math.floor(index / size);
  const c = index % size;
  const out: number[] = [];
  if (r > 0) out.push(index - size);
  if (r < size - 1) out.push(index + size);
  if (c > 0) out.push(index - 1);
  if (c < size - 1) out.push(index + 1);
  return out;
}

/** 循環ラテン方陣に行・列・記号の置換を適用して解を作る。 */
function buildSolution(size: KenkenSize, rng: number): { solution: number[]; rng: number } {
  const base: number[][] = [];
  for (let r = 0; r < size; r++) {
    const row: number[] = [];
    for (let c = 0; c < size; c++) row.push(((r + c) % size) + 1);
    base.push(row);
  }
  let cur = rng;
  const rows = shuffled(
    Array.from({ length: size }, (_, i) => i),
    cur,
  );
  cur = rows.rng;
  const cols = shuffled(
    Array.from({ length: size }, (_, i) => i),
    cur,
  );
  cur = cols.rng;
  const syms = shuffled(
    Array.from({ length: size }, (_, i) => i + 1),
    cur,
  );
  cur = syms.rng;
  const solution = new Array<number>(size * size);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      solution[r * size + c] = syms.items[base[rows.items[r]][cols.items[c]] - 1];
    }
  }
  return { solution, rng: cur };
}

/** ケージ内の値に演算を適用した結果。割り切れない ÷ は null（＝不一致扱い）。 */
export function evaluateCage(values: number[], op: KenkenOp): number | null {
  if (values.length === 0) return null;
  switch (op) {
    case "":
      return values.length === 1 ? values[0] : null;
    case "+":
      return values.reduce((a, b) => a + b, 0);
    case "×":
      return values.reduce((a, b) => a * b, 1);
    case "-":
      return values.length === 2 ? Math.abs(values[0] - values[1]) : null;
    case "÷": {
      if (values.length !== 2) return null;
      const hi = Math.max(values[0], values[1]);
      const lo = Math.min(values[0], values[1]);
      if (lo === 0 || hi % lo !== 0) return null;
      return hi / lo;
    }
    default:
      return null;
  }
}

function pickCageTargetSize(rng: number): { size: number; rng: number } {
  const r = nextRandom(rng);
  const v = r.value;
  const size = v < 0.1 ? 1 : v < 0.55 ? 2 : v < 0.85 ? 3 : 4;
  return { size, rng: r.rng };
}

function buildCages(
  size: KenkenSize,
  solution: number[],
  rng: number,
): { cages: KenkenCage[]; cageOf: number[]; rng: number } {
  const total = size * size;
  const cageOf = new Array<number>(total).fill(-1);
  const cages: KenkenCage[] = [];
  let cur = rng;
  let remaining = total;
  while (remaining > 0) {
    // 未割当セルから開始点をランダムに選ぶ。
    const unassigned: number[] = [];
    for (let i = 0; i < total; i++) if (cageOf[i] === -1) unassigned.push(i);
    const pick = nextRandom(cur);
    cur = pick.rng;
    const start = unassigned[Math.floor(pick.value * unassigned.length)];
    const targetPick = pickCageTargetSize(cur);
    cur = targetPick.rng;
    const targetSize = Math.min(targetPick.size, remaining);

    const cells = [start];
    cageOf[start] = cages.length;
    while (cells.length < targetSize) {
      const frontier: number[] = [];
      for (const cell of cells) {
        for (const n of neighborsOf(cell, size)) {
          if (cageOf[n] === -1 && !cells.includes(n) && !frontier.includes(n)) frontier.push(n);
        }
      }
      if (frontier.length === 0) break;
      const p = nextRandom(cur);
      cur = p.rng;
      const next = frontier[Math.floor(p.value * frontier.length)];
      cells.push(next);
      cageOf[next] = cages.length;
    }

    const vals = cells.map((i) => solution[i]);
    let op: KenkenOp = "";
    let target = vals[0];
    if (cells.length === 2) {
      const candidates: { op: KenkenOp; value: number }[] = [
        { op: "+", value: vals[0] + vals[1] },
        { op: "×", value: vals[0] * vals[1] },
      ];
      if (vals[0] !== vals[1]) candidates.push({ op: "-", value: Math.abs(vals[0] - vals[1]) });
      const hi = Math.max(vals[0], vals[1]);
      const lo = Math.min(vals[0], vals[1]);
      if (hi % lo === 0) candidates.push({ op: "÷", value: hi / lo });
      const p = nextRandom(cur);
      cur = p.rng;
      const chosen = candidates[Math.floor(p.value * candidates.length)];
      op = chosen.op;
      target = chosen.value;
    } else if (cells.length > 2) {
      const p = nextRandom(cur);
      cur = p.rng;
      op = p.value < 0.5 ? "+" : "×";
      target = evaluateCage(vals, op) as number;
    }
    cages.push({ id: cages.length, cells, target, op });
    remaining -= cells.length;
  }
  return { cages, cageOf, rng: cur };
}

export function createKenkenGame(size: KenkenSize, seed: number): KenkenState {
  const n: KenkenSize = size === 5 ? 5 : 4;
  let rng = seed | 0;
  const sol = buildSolution(n, rng);
  rng = sol.rng;
  const built = buildCages(n, sol.solution, rng);
  return {
    size: n,
    seed: seed | 0,
    solution: sol.solution,
    cages: built.cages,
    cageOf: built.cageOf,
    values: new Array<number>(n * n).fill(0),
    moves: 0,
    status: "playing",
  };
}

/** ルール違反を列挙する（空きマス自体は違反にしない）。 */
export function kenkenViolations(state: KenkenState): KenkenViolation[] {
  const { size, values } = state;
  const out: KenkenViolation[] = [];
  // 行の重複。
  for (let r = 0; r < size; r++) {
    const seen = new Map<number, number[]>();
    for (let c = 0; c < size; c++) {
      const idx = r * size + c;
      const v = values[idx];
      if (v === 0) continue;
      const list = seen.get(v) ?? [];
      list.push(idx);
      seen.set(v, list);
    }
    for (const [v, cells] of seen) {
      if (cells.length > 1) {
        out.push({ type: "rowDup", cells, message: `${r + 1}行目に ${v} が重なっています` });
      }
    }
  }
  // 列の重複。
  for (let c = 0; c < size; c++) {
    const seen = new Map<number, number[]>();
    for (let r = 0; r < size; r++) {
      const idx = r * size + c;
      const v = values[idx];
      if (v === 0) continue;
      const list = seen.get(v) ?? [];
      list.push(idx);
      seen.set(v, list);
    }
    for (const [v, cells] of seen) {
      if (cells.length > 1) {
        out.push({ type: "colDup", cells, message: `${c + 1}列目に ${v} が重なっています` });
      }
    }
  }
  // ケージ（全部埋まったケージだけ判定する）。
  for (const cage of state.cages) {
    const vals = cage.cells.map((i) => values[i]);
    if (vals.some((v) => v === 0)) continue;
    if (evaluateCage(vals, cage.op) !== cage.target) {
      out.push({
        type: "cage",
        cells: [...cage.cells],
        message: `ケージの目標 ${cage.target}${cage.op} になっていません`,
      });
    }
  }
  return out;
}

export function checkKenken(state: KenkenState): { complete: boolean; violations: KenkenViolation[] } {
  const violations = kenkenViolations(state);
  const complete = state.values.every((v) => v !== 0) && violations.length === 0;
  return { complete, violations };
}

export function setKenkenValue(state: KenkenState, index: number, value: number): KenkenState {
  if (state.status === "won") return state;
  if (!Number.isInteger(index) || index < 0 || index >= state.values.length) return state;
  if (!Number.isInteger(value) || value < 0 || value > state.size) return state;
  if (state.values[index] === value) return state;
  const values = [...state.values];
  values[index] = value;
  const next: KenkenState = { ...state, values, moves: state.moves + 1 };
  if (checkKenken(next).complete) next.status = "won";
  return next;
}
