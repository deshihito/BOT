// ペントミノの純粋ロジック（UI 非依存）。
// 12種のペントミノ（各5マス）を長方形の盤（6x10 / 5x12 = 60マス）に
// 全部はめるパズル。どちらの盤も解が存在することが知られている。
// 配置は「向き（orientation index）＋ アンカーセルの盤面位置」で表す。
// アンカーセルは、その向きで左上端に来るピース自身のマス（正規化した
// セル一覧の先頭）で、タップしたマスにピースの実マスが乗るようにしている。
// 状態は JSON 化可能な値のみ。遷移関数は状態を破壊せず新しい状態を返す。

export type PentId = "F" | "I" | "L" | "N" | "P" | "T" | "U" | "V" | "W" | "X" | "Y" | "Z";

/** [row, col] の相対座標。 */
export type PentCell = readonly [number, number];

export type PentPieceDef = {
  id: PentId;
  color: string;
  cells: PentCell[];
};

export const PENTOMINOES: PentPieceDef[] = [
  { id: "F", color: "#e07a5f", cells: [[0, 1], [0, 2], [1, 0], [1, 1], [2, 1]] },
  { id: "I", color: "#8d99ae", cells: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]] },
  { id: "L", color: "#f2cc8f", cells: [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1]] },
  { id: "N", color: "#81b29a", cells: [[0, 0], [1, 0], [1, 1], [2, 1], [3, 1]] },
  { id: "P", color: "#e5989b", cells: [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0]] },
  { id: "T", color: "#6d8ea0", cells: [[0, 0], [0, 1], [0, 2], [1, 1], [2, 1]] },
  { id: "U", color: "#b56576", cells: [[0, 0], [0, 2], [1, 0], [1, 1], [1, 2]] },
  { id: "V", color: "#355070", cells: [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]] },
  { id: "W", color: "#6a994e", cells: [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2]] },
  { id: "X", color: "#bc6c25", cells: [[0, 1], [1, 0], [1, 1], [1, 2], [2, 1]] },
  { id: "Y", color: "#5a189a", cells: [[0, 1], [1, 0], [1, 1], [2, 1], [3, 1]] },
  { id: "Z", color: "#0077b6", cells: [[0, 0], [0, 1], [1, 1], [2, 1], [2, 2]] },
];

export type PentBoardKey = "6x10" | "5x12";

export const PENT_BOARDS: Record<PentBoardKey, { rows: number; cols: number; label: string }> = {
  "6x10": { rows: 6, cols: 10, label: "6×10" },
  "5x12": { rows: 5, cols: 12, label: "5×12" },
};

export type PentPlacement = {
  orientation: number;
  /** アンカーセル（向きの先頭セル）が置かれる盤面の行・列。 */
  row: number;
  col: number;
};

export type PentState = {
  board: PentBoardKey;
  rows: number;
  cols: number;
  placements: Partial<Record<PentId, PentPlacement>>;
  moves: number;
  status: "playing" | "won";
};

export function pentPieceDef(id: PentId): PentPieceDef {
  const def = PENTOMINOES.find((p) => p.id === id);
  if (!def) throw new Error(`未知のペントミノです: ${id}`);
  return def;
}

/** セル集合を (0,0) 起点へ正規化し、辞書順に並べる。 */
function normalizeCells(cells: readonly (readonly [number, number])[]): [number, number][] {
  const minR = Math.min(...cells.map((c) => c[0]));
  const minC = Math.min(...cells.map((c) => c[1]));
  return cells
    .map(([r, c]) => [r - minR, c - minC] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function cellsKey(cells: readonly (readonly [number, number])[]): string {
  return cells.map(([r, c]) => `${r},${c}`).join("|");
}

function rotateCells(cells: readonly (readonly [number, number])[]): [number, number][] {
  // 90度時計回り: (r, c) -> (c, -r)
  return normalizeCells(cells.map(([r, c]) => [c, -r] as const));
}

function flipCells(cells: readonly (readonly [number, number])[]): [number, number][] {
  // 左右反転: (r, c) -> (r, -c)
  return normalizeCells(cells.map(([r, c]) => [r, -c] as const));
}

const orientationCache = new Map<PentId, [number, number][][]>();

/** そのピースの相異なる向きすべて（回転×反転）。各向きは正規化済みセル一覧。 */
export function pentOrientations(id: PentId): [number, number][][] {
  const cached = orientationCache.get(id);
  if (cached) return cached;
  const base = normalizeCells(pentPieceDef(id).cells);
  const seen = new Map<string, [number, number][]>();
  for (let flip = 0; flip < 2; flip++) {
    let rotated = flip === 0 ? base : flipCells(base);
    for (let rot = 0; rot < 4; rot++) {
      const key = cellsKey(rotated);
      if (!seen.has(key)) seen.set(key, rotated);
      rotated = rotateCells(rotated);
    }
  }
  const list = [...seen.values()];
  orientationCache.set(id, list);
  return list;
}

/** 向き index のセル一覧。範囲外は null。 */
export function pentOrientationCells(id: PentId, orientation: number): [number, number][] | null {
  const list = pentOrientations(id);
  if (!Number.isInteger(orientation) || orientation < 0 || orientation >= list.length) return null;
  return list[orientation];
}

function findOrientation(id: PentId, cells: [number, number][]): number {
  const key = cellsKey(cells);
  const idx = pentOrientations(id).findIndex((o) => cellsKey(o) === key);
  return idx >= 0 ? idx : 0;
}

/** 現在の向きを90度時計回りに回した向きの index。 */
export function rotatePentOrientation(id: PentId, orientation: number): number {
  const cells = pentOrientationCells(id, orientation);
  if (!cells) return 0;
  return findOrientation(id, rotateCells(cells));
}

/** 現在の向きを左右反転した向きの index。 */
export function flipPentOrientation(id: PentId, orientation: number): number {
  const cells = pentOrientationCells(id, orientation);
  if (!cells) return 0;
  return findOrientation(id, flipCells(cells));
}

/** 配置から、そのピースが占める盤面セル index の一覧を返す。 */
export function pentPlacementCells(
  rows: number,
  cols: number,
  id: PentId,
  placement: PentPlacement,
): number[] {
  const cells = pentOrientationCells(id, placement.orientation);
  if (!cells) return [];
  const [anchorR, anchorC] = cells[0];
  return cells.map(([r, c]) => (placement.row + (r - anchorR)) * cols + (placement.col + (c - anchorC)));
}

/** 全ピースぶんの占有マップ（セル index -> ピース id）。 */
export function pentOccupancy(state: PentState): (PentId | null)[] {
  const occ: (PentId | null)[] = new Array<PentId | null>(state.rows * state.cols).fill(null);
  for (const def of PENTOMINOES) {
    const placement = state.placements[def.id];
    if (!placement) continue;
    for (const idx of pentPlacementCells(state.rows, state.cols, def.id, placement)) {
      if (idx >= 0 && idx < occ.length) occ[idx] = def.id;
    }
  }
  return occ;
}

/** その配置ができるか（盤内・他のピースと重ならない）。 */
export function canPlacePent(
  state: PentState,
  id: PentId,
  orientation: number,
  row: number,
  col: number,
): boolean {
  if (state.status === "won") return false;
  const cells = pentOrientationCells(id, orientation);
  if (!cells) return false;
  if (!Number.isInteger(row) || !Number.isInteger(col)) return false;
  const [anchorR, anchorC] = cells[0];
  const occ = pentOccupancy(state);
  for (const [r, c] of cells) {
    const br = row + (r - anchorR);
    const bc = col + (c - anchorC);
    if (br < 0 || bc < 0 || br >= state.rows || bc >= state.cols) return false;
    const occupant = occ[br * state.cols + bc];
    if (occupant !== null && occupant !== id) return false;
  }
  return true;
}

/** 完成判定: 12ピース全部が置かれている（重なりなし・60マスなので全面が埋まる）。 */
export function isPentComplete(state: PentState): boolean {
  return PENTOMINOES.every((def) => state.placements[def.id] !== undefined);
}

export function createPentGame(board: PentBoardKey = "6x10"): PentState {
  const def = PENT_BOARDS[board] ?? PENT_BOARDS["6x10"];
  return {
    board: PENT_BOARDS[board] ? board : "6x10",
    rows: def.rows,
    cols: def.cols,
    placements: {},
    moves: 0,
    status: "playing",
  };
}

/** ピースを置く（同じピースの再配置も可）。置けない場合は同じ状態を返す。 */
export function placePent(
  state: PentState,
  id: PentId,
  orientation: number,
  row: number,
  col: number,
): PentState {
  if (!canPlacePent(state, id, orientation, row, col)) return state;
  const placements = { ...state.placements, [id]: { orientation, row, col } };
  const next: PentState = { ...state, placements, moves: state.moves + 1 };
  return isPentComplete(next) ? { ...next, status: "won" } : next;
}

/** ピースを盤から外す。 */
export function removePent(state: PentState, id: PentId): PentState {
  if (state.status === "won") return state;
  if (!state.placements[id]) return state;
  const placements = { ...state.placements };
  delete placements[id];
  return { ...state, placements, moves: state.moves + 1 };
}

/** 置かれていないピースの一覧。 */
export function pentRemaining(state: PentState): PentId[] {
  return PENTOMINOES.filter((def) => !state.placements[def.id]).map((def) => def.id);
}
