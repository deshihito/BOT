// テントと木（Tents and Trees）の純粋ロジック（UI 非依存・シード決定的）。
// ルール:
// - 各木には、縦横に隣接するテントがちょうど1つ対応する。
// - テント同士は縦・横・斜めのいずれでも隣接してはいけない。
// - 各行・各列のテント数は、盤の外に示された数と一致する。
// 生成は「解を先に作る」方式: テントを互いに触れないよう配置し、各テントに
// 専用の木を割り当ててから、木の位置と行列の数だけを問題として出す。
// 完成判定はルール検証＋木とテントの完全マッチング存在で行う（別解でもクリア）。

export type TentsSize = 6 | 8;
/** 0=未定, 1=テント, 2=草（テントなしの印）。木のマスは marks の対象外。 */
export type TentsMark = 0 | 1 | 2;

export type TentsViolationType = "tentAdjacent" | "rowOver" | "colOver" | "tentOrphan";

export type TentsViolation = {
  type: TentsViolationType;
  cells: number[];
  message: string;
};

export type TentsState = {
  size: TentsSize;
  seed: number;
  /** 木の位置。 */
  trees: boolean[];
  /** 正解のテント位置（生成の検証用に保持）。 */
  solution: boolean[];
  rowCounts: number[];
  colCounts: number[];
  marks: TentsMark[];
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

export function normalizeTentsSize(size: number): TentsSize {
  return size === 8 ? 8 : 6;
}

/** サイズごとのテント（＝木）の数。 */
export function tentsCountFor(size: TentsSize): number {
  return size === 8 ? 14 : 8;
}

function orthoNeighbors(index: number, size: number): number[] {
  const r = Math.floor(index / size);
  const c = index % size;
  const out: number[] = [];
  if (r > 0) out.push(index - size);
  if (r < size - 1) out.push(index + size);
  if (c > 0) out.push(index - 1);
  if (c < size - 1) out.push(index + 1);
  return out;
}

function allNeighbors(index: number, size: number): number[] {
  const r = Math.floor(index / size);
  const c = index % size;
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < size && nc >= 0 && nc < size) out.push(nr * size + nc);
    }
  }
  return out;
}

function shuffled<T>(items: T[], rng: number): { items: T[]; rng: number } {
  const arr = [...items];
  let cur = rng;
  for (let i = arr.length - 1; i > 0; i--) {
    const r = nextRandom(cur);
    cur = r.rng;
    const j = Math.floor(r.value * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return { items: arr, rng: cur };
}

type GeneratedPuzzle = {
  trees: boolean[];
  tents: boolean[];
  rowCounts: number[];
  colCounts: number[];
};

/** 解を先に作る生成。失敗したら乱数を進めて作り直す。 */
function generatePuzzle(size: TentsSize, seed: number): GeneratedPuzzle {
  const total = size * size;
  const target = tentsCountFor(size);
  let rng = seed | 0;
  for (let attempt = 0; attempt < 500; attempt++) {
    // テント配置: 8方向に隣接しないようグリーディに置く
    const orderRes = shuffled(
      Array.from({ length: total }, (_, i) => i),
      rng,
    );
    rng = orderRes.rng;
    const tents = new Array<boolean>(total).fill(false);
    let placed = 0;
    for (const idx of orderRes.items) {
      if (placed >= target) break;
      if (allNeighbors(idx, size).some((n) => tents[n])) continue;
      tents[idx] = true;
      placed++;
    }
    if (placed < target) continue;

    // 各テントに専用の木（縦横隣接・テントでなく他の木でもないマス）を割り当てる
    const tentIdx = orderRes.items.filter((i) => tents[i]);
    const tentOrder = shuffled(tentIdx, rng);
    rng = tentOrder.rng;
    const trees = new Array<boolean>(total).fill(false);
    let ok = true;
    for (const t of tentOrder.items) {
      const candidates = orthoNeighbors(t, size).filter((n) => !tents[n] && !trees[n]);
      if (candidates.length === 0) {
        ok = false;
        break;
      }
      const pickRes = nextRandom(rng);
      rng = pickRes.rng;
      trees[candidates[Math.floor(pickRes.value * candidates.length)]] = true;
    }
    if (!ok) continue;

    const rowCounts = new Array<number>(size).fill(0);
    const colCounts = new Array<number>(size).fill(0);
    for (let i = 0; i < total; i++) {
      if (!tents[i]) continue;
      rowCounts[Math.floor(i / size)]++;
      colCounts[i % size]++;
    }
    return { trees, tents, rowCounts, colCounts };
  }
  // 到達しない想定だが、決定的な簡易配置でフォールバックする。
  const tents = new Array<boolean>(total).fill(false);
  const trees = new Array<boolean>(total).fill(false);
  let placed = 0;
  for (let r = 0; r < size && placed < target; r += 2) {
    for (let c = 0; c < size && placed < target; c += 2) {
      const idx = r * size + c;
      tents[idx] = true;
      trees[idx + (c + 1 < size ? 1 : -1)] = true;
      placed++;
    }
  }
  const rowCounts = new Array<number>(size).fill(0);
  const colCounts = new Array<number>(size).fill(0);
  for (let i = 0; i < total; i++) {
    if (!tents[i]) continue;
    rowCounts[Math.floor(i / size)]++;
    colCounts[i % size]++;
  }
  return { trees, tents, rowCounts, colCounts };
}

export function createTentsGame(size: number, seed: number): TentsState {
  const n = normalizeTentsSize(size);
  const puzzle = generatePuzzle(n, seed);
  return {
    size: n,
    seed: seed | 0,
    trees: puzzle.trees,
    solution: puzzle.tents,
    rowCounts: puzzle.rowCounts,
    colCounts: puzzle.colCounts,
    marks: new Array<TentsMark>(n * n).fill(0),
    moves: 0,
    status: "playing",
  };
}

/** 木とテントの完全マッチング（各木に異なるテントを1つずつ）が存在するか。 */
export function tentsMatchingExists(trees: boolean[], tents: boolean[], size: number): boolean {
  const treeIdx: number[] = [];
  const tentIdx: number[] = [];
  for (let i = 0; i < trees.length; i++) {
    if (trees[i]) treeIdx.push(i);
    if (tents[i]) tentIdx.push(i);
  }
  if (treeIdx.length !== tentIdx.length) return false;
  const tentPos = new Map(tentIdx.map((t, i) => [t, i]));
  // 木 -> 隣接テントの添字リスト
  const adj: number[][] = treeIdx.map((tree) =>
    orthoNeighbors(tree, size)
      .filter((n) => tentPos.has(n))
      .map((n) => tentPos.get(n) as number),
  );
  const matchOfTent = new Array<number>(tentIdx.length).fill(-1);
  const tryAssign = (tree: number, seen: boolean[]): boolean => {
    for (const t of adj[tree]) {
      if (seen[t]) continue;
      seen[t] = true;
      if (matchOfTent[t] === -1 || tryAssign(matchOfTent[t], seen)) {
        matchOfTent[t] = tree;
        return true;
      }
    }
    return false;
  };
  for (let tree = 0; tree < treeIdx.length; tree++) {
    if (!tryAssign(tree, new Array<boolean>(tentIdx.length).fill(false))) return false;
  }
  return true;
}

/** 現在の marks に対する違反（プレイ中のチェック用）。 */
export function tentsViolations(state: TentsState): TentsViolation[] {
  const { size, marks, trees, rowCounts, colCounts } = state;
  const violations: TentsViolation[] = [];
  const tentCells: number[] = [];
  for (let i = 0; i < marks.length; i++) if (marks[i] === 1) tentCells.push(i);

  for (const i of tentCells) {
    // テント同士の隣接（8方向）
    const hit = allNeighbors(i, size).filter((n) => marks[n] === 1 && n > i);
    for (const n of hit) {
      violations.push({
        type: "tentAdjacent",
        cells: [i, n],
        message: "テント同士が隣り合っています",
      });
    }
    // 木に1つも接していないテント
    if (!orthoNeighbors(i, size).some((n) => trees[n])) {
      violations.push({
        type: "tentOrphan",
        cells: [i],
        message: "どの木にも接していないテントがあります",
      });
    }
  }
  for (let r = 0; r < size; r++) {
    let count = 0;
    const cells: number[] = [];
    for (let c = 0; c < size; c++) {
      if (marks[r * size + c] === 1) {
        count++;
        cells.push(r * size + c);
      }
    }
    if (count > rowCounts[r]) {
      violations.push({ type: "rowOver", cells, message: `${r + 1}行目のテントが多すぎます` });
    }
  }
  for (let c = 0; c < size; c++) {
    let count = 0;
    const cells: number[] = [];
    for (let r = 0; r < size; r++) {
      if (marks[r * size + c] === 1) {
        count++;
        cells.push(r * size + c);
      }
    }
    if (count > colCounts[c]) {
      violations.push({ type: "colOver", cells, message: `${c + 1}列目のテントが多すぎます` });
    }
  }
  return violations;
}

/** 完成判定: 行列数が一致し、隣接違反がなく、木とテントの完全マッチングがある。 */
export function isTentsComplete(state: TentsState): boolean {
  const { size, marks, trees, rowCounts, colCounts } = state;
  const tentFlags = marks.map((m) => m === 1);
  const treeCount = trees.filter(Boolean).length;
  const tentCount = tentFlags.filter(Boolean).length;
  if (tentCount !== treeCount) return false;
  for (let r = 0; r < size; r++) {
    let count = 0;
    for (let c = 0; c < size; c++) if (tentFlags[r * size + c]) count++;
    if (count !== rowCounts[r]) return false;
  }
  for (let c = 0; c < size; c++) {
    let count = 0;
    for (let r = 0; r < size; r++) if (tentFlags[r * size + c]) count++;
    if (count !== colCounts[c]) return false;
  }
  for (let i = 0; i < tentFlags.length; i++) {
    if (!tentFlags[i]) continue;
    if (allNeighbors(i, size).some((n) => tentFlags[n])) return false;
  }
  return tentsMatchingExists(trees, tentFlags, size);
}

/** マスを 未定→テント→草→未定 と循環させる。木のマス・終了後は同状態を返す。 */
export function cycleTentsMark(state: TentsState, index: number): TentsState {
  if (state.status !== "playing") return state;
  if (!Number.isInteger(index) || index < 0 || index >= state.marks.length) return state;
  if (state.trees[index]) return state;
  const marks = [...state.marks];
  marks[index] = (((marks[index] + 1) % 3) as TentsMark);
  const next: TentsState = { ...state, marks, moves: state.moves + 1 };
  if (isTentsComplete(next)) return { ...next, status: "won" };
  return next;
}
