// ぬりかべの純粋ロジック（UI 非依存・シード決定的）。
// ルール: 数字は島の大きさ。島は1つだけ数字を含み、島同士は斜めのみ接してよい。
// 海（塗り）は全体で1つにつながり、2x2 の海は禁止。
// 生成は「解を先に作る」方式: 海を少しずつ育てて正解盤面を作り、
// 島ごとに代表セル1つへ数字を残す。さらに簡易ソルバで解の一意性を数え、
// 一意でない盤面は作り直す（上限回数を超えたら最後の盤面を使う）。
// 完成判定は正解との一致ではなくルール検証で行うため、別解でもクリアになる。

export type NurikabeSize = 5 | 7;
/** 0=未定, 1=海（塗り）, 2=島。数字セルは常に 2 で固定。 */
export type NurikabeMark = 0 | 1 | 2;

export type NurikabeViolationType =
  | "sea2x2"
  | "islandMerged"
  | "islandTooBig"
  | "islandNoClue"
  | "islandSizeMismatch"
  | "seaSplit";

export type NurikabeViolation = {
  type: NurikabeViolationType;
  /** 関係するセル index の一覧。 */
  cells: number[];
  message: string;
};

export type NurikabeState = {
  size: NurikabeSize;
  seed: number;
  /** 正解盤面（true=海）。生成の検証用に保持する。 */
  solution: boolean[];
  /** 数字セルの値（数字でないセルは null）。 */
  clues: (number | null)[];
  marks: NurikabeMark[];
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

function neighbors(index: number, size: number): number[] {
  const r = Math.floor(index / size);
  const c = index % size;
  const out: number[] = [];
  if (r > 0) out.push(index - size);
  if (r < size - 1) out.push(index + size);
  if (c > 0) out.push(index - 1);
  if (c < size - 1) out.push(index + 1);
  return out;
}

/** pred を満たすセルの連結成分を返す。 */
function componentsWhere(cells: boolean[], size: number): number[][] {
  const seen = new Array<boolean>(cells.length).fill(false);
  const comps: number[][] = [];
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i] || seen[i]) continue;
    const comp: number[] = [];
    const stack = [i];
    seen[i] = true;
    while (stack.length > 0) {
      const cur = stack.pop() as number;
      comp.push(cur);
      for (const n of neighbors(cur, size)) {
        if (cells[n] && !seen[n]) {
          seen[n] = true;
          stack.push(n);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

/** 2x2 の海ブロックが存在するか（sea は boolean 配列）。 */
function hasSeaBlock(sea: boolean[], size: number): boolean {
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const i = r * size + c;
      if (sea[i] && sea[i + 1] && sea[i + size] && sea[i + size + 1]) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- 生成

type GeneratedPuzzle = { solution: boolean[]; clues: (number | null)[] };

/** 海を1セルから育てて正解盤面を1つ作る。失敗したら null。 */
function growSolution(
  size: NurikabeSize,
  rng: number,
): { puzzle: GeneratedPuzzle; rng: number } | null {
  const total = size * size;
  const maxIsland = size === 5 ? 8 : 8;
  const seaTarget = Math.round(total * (size === 5 ? 0.48 : 0.52));
  let cur = rng;
  const rand = () => {
    const r = nextRandom(cur);
    cur = r.rng;
    return r.value;
  };
  const sea = new Array<boolean>(total).fill(false);
  const start = Math.floor(rand() * total);
  sea[start] = true;
  let seaCount = 1;

  // 海に囲まれて確定した島だけ上限を見る（海に接する島はまだ削れる）。
  const islandOk = (): boolean => {
    const land = sea.map((s) => !s);
    for (const comp of componentsWhere(land, size)) {
      const touchesSea = comp.some((i) => neighbors(i, size).some((n) => sea[n]));
      if (!touchesSea && comp.length > maxIsland) return false;
    }
    return true;
  };

  while (seaCount < seaTarget) {
    const frontierSet = new Set<number>();
    for (let i = 0; i < total; i++) {
      if (!sea[i]) continue;
      for (const n of neighbors(i, size)) if (!sea[n]) frontierSet.add(n);
    }
    const frontier = [...frontierSet];
    // シャッフルして順に試す。
    for (let i = frontier.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [frontier[i], frontier[j]] = [frontier[j], frontier[i]];
    }
    let placed = false;
    for (const cand of frontier) {
      sea[cand] = true;
      if (!hasSeaBlock(sea, size) && islandOk()) {
        placed = true;
        seaCount++;
        break;
      }
      sea[cand] = false;
    }
    if (!placed) return null;
  }

  const land = sea.map((s) => !s);
  const islands = componentsWhere(land, size);
  if (islands.length < 3) return null;
  if (islands.some((comp) => comp.length > maxIsland)) return null;
  const clues = new Array<number | null>(total).fill(null);
  for (const comp of islands) {
    const rep = comp[Math.floor(rand() * comp.length)] ?? comp[0];
    clues[rep] = comp.length;
  }
  return { puzzle: { solution: sea, clues }, rng: cur };
}

// ---------------------------------------------------------------- 一意性ソルバ

// セル状態: 0=未定, 1=海, 2=島。islandId は数字セルの index（未割当は -2）。
type SolverGrid = { cell: number[]; islandId: number[] };

function cloneGrid(g: SolverGrid): SolverGrid {
  return { cell: [...g.cell], islandId: [...g.islandId] };
}

/** 伝播と矛盾検出。矛盾なら false、変化があれば grid を更新して true を返す。 */
function propagate(grid: SolverGrid, clues: (number | null)[], size: number): boolean {
  const total = size * size;
  let changed = true;
  while (changed) {
    changed = false;
    // 島の連結成分を調べる。
    const islandCells = grid.cell.map((v) => v === 2);
    const comps = componentsWhere(islandCells, size);
    for (const comp of comps) {
      const clueCells = comp.filter((i) => clues[i] !== null);
      if (clueCells.length >= 2) return false;
      const clueIdx = clueCells[0];
      if (clueIdx !== undefined) {
        const value = clues[clueIdx] as number;
        if (comp.length > value) return false;
        // 成分内の未割当セルへ id を伝える。
        for (const i of comp) {
          if (grid.islandId[i] === -2) {
            grid.islandId[i] = clueIdx;
            changed = true;
          }
        }
        if (comp.length === value) {
          // 完成した島の隣は海にする。
          for (const i of comp) {
            for (const n of neighbors(i, size)) {
              if (grid.cell[n] === 0) {
                grid.cell[n] = 1;
                changed = true;
              } else if (grid.cell[n] === 2 && !comp.includes(n)) {
                return false;
              }
            }
          }
        }
      }
    }
    // 2x2 チェックと強制。
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const idxs = [
          r * size + c,
          r * size + c + 1,
          (r + 1) * size + c,
          (r + 1) * size + c + 1,
        ];
        const seaCount = idxs.filter((i) => grid.cell[i] === 1).length;
        if (seaCount === 4) return false;
        if (seaCount === 3) {
          const unknown = idxs.find((i) => grid.cell[i] === 0);
          if (unknown !== undefined) {
            grid.cell[unknown] = 2;
            changed = true;
          }
        }
      }
    }
    // 海の連結可能性: 海セルは「海∪未定」の中で互いに届かなければ矛盾。
    const seaCells = grid.cell.map((v) => v === 1);
    if (seaCells.some(Boolean)) {
      const passable = grid.cell.map((v) => v !== 2);
      const regions = componentsWhere(passable, size);
      const seaRegions = new Set<number>();
      regions.forEach((region, ri) => {
        if (region.some((i) => grid.cell[i] === 1)) seaRegions.add(ri);
      });
      if (seaRegions.size >= 2) return false;
    }
    // 島の到達可能性: その島になりうるセル（未定セル＋未割当の島セル＋自成分）が
    // 数字の大きさに届かなければ矛盾。未割当の島セルも含めること（隣の未定セルを
    // 介して将来つながる島セルを取りこぼすと、正解を誤って枝刈りしてしまう）。
    for (let i = 0; i < total; i++) {
      if (clues[i] === null) continue;
      if (grid.cell[i] !== 2) return false;
      const value = clues[i] as number;
      const region = grid.cell.map((v, j) => v !== 1 && (grid.islandId[j] === i || grid.islandId[j] === -2));
      const reachable = componentsWhere(region, size).find((comp) => comp.includes(i)) ?? [i];
      if (reachable.length < value) return false;
    }
  }
  return true;
}

function validateFull(grid: SolverGrid, clues: (number | null)[], size: number): boolean {
  const sea = grid.cell.map((v) => v === 1);
  if (hasSeaBlock(sea, size)) return false;
  const seaComps = componentsWhere(sea, size);
  if (seaComps.length !== 1) return false;
  const islandComps = componentsWhere(grid.cell.map((v) => v === 2), size);
  for (const comp of islandComps) {
    const clueCells = comp.filter((i) => clues[i] !== null);
    if (clueCells.length !== 1) return false;
    if (comp.length !== clues[clueCells[0]] ) return false;
  }
  return true;
}

/** 解の数を数える（limit 以上は打ち切り）。予算超過なら -1。 */
export function countNurikabeSolutions(
  clues: (number | null)[],
  size: NurikabeSize,
  limit = 2,
  nodeBudget = 60000,
): number {
  const total = size * size;
  const initial: SolverGrid = {
    cell: new Array<number>(total).fill(0),
    islandId: new Array<number>(total).fill(-2),
  };
  for (let i = 0; i < total; i++) {
    if (clues[i] !== null) {
      initial.cell[i] = 2;
      initial.islandId[i] = i;
    }
  }
  let nodes = 0;
  let count = 0;

  const dfs = (gridIn: SolverGrid): void => {
    if (count >= limit || nodes > nodeBudget) return;
    nodes++;
    const grid = cloneGrid(gridIn);
    if (!propagate(grid, clues, size)) return;
    const unknownIdx = grid.cell.findIndex((v) => v === 0);
    if (unknownIdx === -1) {
      if (validateFull(grid, clues, size)) count++;
      return;
    }
    // 既定セルに隣接する未定セルを優先して分岐する。
    let branch = unknownIdx;
    for (let i = 0; i < total; i++) {
      if (grid.cell[i] !== 0) continue;
      if (neighbors(i, size).some((n) => grid.cell[n] !== 0)) {
        branch = i;
        break;
      }
    }
    for (const choice of [2, 1] as const) {
      const next = cloneGrid(grid);
      next.cell[branch] = choice;
      dfs(next);
      if (count >= limit || nodes > nodeBudget) return;
    }
  };

  dfs(initial);
  if (nodes > nodeBudget) return -1;
  return count;
}

/** シードからパズルを生成する。一意解を優先し、試行上限では最後の候補を採用する。 */
export function generateNurikabePuzzle(seed: number, size: NurikabeSize): GeneratedPuzzle {
  let rng = seed | 0;
  let fallback: GeneratedPuzzle | null = null;
  const maxAttempts = size === 5 ? 30 : 12;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const grown = growSolution(size, rng);
    if (!grown) {
      const r = nextRandom(rng);
      rng = r.rng;
      continue;
    }
    rng = grown.rng;
    fallback = grown.puzzle;
    const count = countNurikabeSolutions(grown.puzzle.clues, size, 2, size === 5 ? 60000 : 15000);
    if (count === 1) return grown.puzzle;
  }
  if (fallback) return fallback;
  // 最終手段: growSolution を緩い条件で再試行する。
  for (let attempt = 0; attempt < 200 && !fallback; attempt++) {
    const grown = growSolution(size, rng);
    if (grown) {
      fallback = grown.puzzle;
      rng = grown.rng;
    } else {
      const r = nextRandom(rng);
      rng = r.rng;
    }
  }
  if (!fallback) throw new Error("ぬりかべの盤面生成に失敗しました");
  return fallback;
}

// ---------------------------------------------------------------- 検証

/**
 * 盤面のルール違反を調べる。
 * full=false（途中経過）: 確定した部分だけを厳しく見る（島が小さい等は不問）。
 * full=true（完成判定）: 全セル確定が前提で、島の大きさ一致まで見る。
 */
export function nurikabeViolations(
  size: NurikabeSize,
  clues: (number | null)[],
  marks: NurikabeMark[],
  full: boolean,
): NurikabeViolation[] {
  const violations: NurikabeViolation[] = [];
  const sea = marks.map((m) => m === 1);
  // 数字セルは marks がどうあれ島として扱う。
  const isIsland = marks.map((m, i) => m === 2 || clues[i] !== null);

  // 2x2 の海。
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const idxs = [r * size + c, r * size + c + 1, (r + 1) * size + c, (r + 1) * size + c + 1];
      if (idxs.every((i) => sea[i])) {
        violations.push({
          type: "sea2x2",
          cells: idxs,
          message: "海が2x2の塊になっています",
        });
      }
    }
  }

  // 島の成分チェック。
  const islandComps = componentsWhere(isIsland, size);
  for (const comp of islandComps) {
    const clueCells = comp.filter((i) => clues[i] !== null);
    if (clueCells.length >= 2) {
      violations.push({
        type: "islandMerged",
        cells: comp,
        message: "2つの数字が同じ島につながっています",
      });
      continue;
    }
    const clueIdx = clueCells[0];
    if (clueIdx !== undefined) {
      const value = clues[clueIdx] as number;
      if (comp.length > value) {
        violations.push({
          type: "islandTooBig",
          cells: comp,
          message: `島が数字（${value}）より大きくなっています`,
        });
      } else if (full && comp.length < value) {
        violations.push({
          type: "islandSizeMismatch",
          cells: comp,
          message: `島の大きさが数字（${value}）と一致しません`,
        });
      }
    } else if (full) {
      violations.push({
        type: "islandNoClue",
        cells: comp,
        message: "数字のない島があります",
      });
    } else {
      // 途中経過: 未定セルをたどっても数字に届かない島は行き詰まり。
      const passable = marks.map((m, i) => m !== 1 || isIsland[i]);
      const reachable = componentsWhere(passable, size).find((region) => region.includes(comp[0])) ?? comp;
      if (!reachable.some((i) => clues[i] !== null)) {
        violations.push({
          type: "islandNoClue",
          cells: comp,
          message: "どの数字にもつながらない島があります",
        });
      }
    }
  }

  // 海の連結。
  if (sea.some(Boolean)) {
    if (full) {
      const seaComps = componentsWhere(sea, size);
      if (seaComps.length >= 2) {
        violations.push({
          type: "seaSplit",
          cells: seaComps.slice(1).flat(),
          message: "海が分断されています",
        });
      }
    } else {
      // 海∪未定の中でつながっていない海同士は、今後も絶対に接続できない。
      const passable = marks.map((m, i) => m === 1 || (m === 0 && clues[i] === null));
      const regions = componentsWhere(passable, size);
      const seaRegions = regions.filter((region) => region.some((i) => sea[i]));
      if (seaRegions.length >= 2) {
        violations.push({
          type: "seaSplit",
          cells: seaRegions.slice(1).flat(),
          message: "海が分断されています",
        });
      }
    }
  }
  return violations;
}

/** 完成判定: 全セル確定＋ルール違反なし。 */
export function isNurikabeComplete(state: NurikabeState): boolean {
  if (state.marks.some((m, i) => m === 0 && state.clues[i] === null)) return false;
  return nurikabeViolations(state.size, state.clues, state.marks, true).length === 0;
}

// ---------------------------------------------------------------- 状態遷移

export function createNurikabeGame(seed: number, size: NurikabeSize = 5): NurikabeState {
  const puzzle = generateNurikabePuzzle(seed, size);
  const marks = puzzle.clues.map((clue) => (clue !== null ? (2 as NurikabeMark) : (0 as NurikabeMark)));
  return {
    size,
    seed,
    solution: puzzle.solution,
    clues: puzzle.clues,
    marks,
    moves: 0,
    status: "playing",
  };
}

/** マスへ印を設定する。数字セルと完成後の操作は無効（同じ状態を返す）。 */
export function setNurikabeMark(state: NurikabeState, index: number, mark: NurikabeMark): NurikabeState {
  if (state.status === "won") return state;
  if (!Number.isInteger(index) || index < 0 || index >= state.marks.length) return state;
  if (mark !== 0 && mark !== 1 && mark !== 2) return state;
  if (state.clues[index] !== null) return state;
  if (state.marks[index] === mark) return state;
  const marks = [...state.marks];
  marks[index] = mark;
  const next: NurikabeState = { ...state, marks, moves: state.moves + 1 };
  return isNurikabeComplete(next) ? { ...next, status: "won" } : next;
}

/** タップで 未定→海→島→未定 と切り替える。 */
export function cycleNurikabeMark(state: NurikabeState, index: number): NurikabeState {
  if (!Number.isInteger(index) || index < 0 || index >= state.marks.length) return state;
  const cur = state.marks[index];
  const nextMark = (cur === 0 ? 1 : cur === 1 ? 2 : 0) as NurikabeMark;
  return setNurikabeMark(state, index, nextMark);
}

/** 途中経過の違反チェック（チェックボタン用）。 */
export function checkNurikabe(state: NurikabeState): NurikabeViolation[] {
  return nurikabeViolations(state.size, state.clues, state.marks, false);
}
