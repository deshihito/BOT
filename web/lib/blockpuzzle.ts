// ブロックスパズル（Blockudoku 風）の純粋ロジック（UI 非依存・シード決定的）。
// 9x9 盤に、提示された3つのブロックを置いていく。回転はできない（提示された向きのまま）。
// 縦・横の列、または 3x3 ブロックが全部埋まると消える。
// 置けるブロックが1つも無くなったら終了。
// スコア: 配置したマス数 + 消去ボーナス（消したライン数 × 10 × ライン数。同時消しほど高い）。

export const BP_SIZE = 9;

/** ブロックの形。[dr, dc] の相対座標リスト（左上を原点に正規化済み）。回転バリエーションは別エントリとして持つ。 */
export type BpShape = { name: string; cells: [number, number][] };

function shape(name: string, rows: string[]): BpShape {
  const cells: [number, number][] = [];
  rows.forEach((line, r) => {
    [...line].forEach((ch, c) => {
      if (ch === "#") cells.push([r, c]);
    });
  });
  return { name, cells };
}

export const BP_SHAPES: BpShape[] = [
  shape("1マス", ["#"]),
  shape("2マス横", ["##"]),
  shape("2マス縦", ["#", "#"]),
  shape("3マス横", ["###"]),
  shape("3マス縦", ["#", "#", "#"]),
  shape("4マス横", ["####"]),
  shape("4マス縦", ["#", "#", "#", "#"]),
  shape("5マス横", ["#####"]),
  shape("5マス縦", ["#", "#", "#", "#", "#"]),
  shape("2x2", ["##", "##"]),
  shape("3x3", ["###", "###", "###"]),
  shape("2x3", ["###", "###"]),
  shape("3x2", ["##", "##", "##"]),
  shape("L小1", ["#.", "##"]),
  shape("L小2", [".#", "##"]),
  shape("L小3", ["##", "#."]),
  shape("L小4", ["##", ".#"]),
  shape("L大1", ["#..", "#..", "###"]),
  shape("L大2", ["..#", "..#", "###"]),
  shape("L大3", ["###", "#..", "#.."]),
  shape("L大4", ["###", "..#", "..#"]),
  shape("T1", ["###", ".#."]),
  shape("T2", [".#.", "###"]),
  shape("T3", ["#.", "##", "#."]),
  shape("T4", [".#", "##", ".#"]),
  shape("角1", ["##", "#."]),
  shape("角2", ["##", ".#"]),
  shape("角3", ["#.", "##"]),
  shape("角4", [".#", "##"]),
];

/** 色の数（盤面のセルとブロックの色付け用）。 */
export const BP_COLORS = 5;

export type BpPiece = {
  /** BP_SHAPES の index。 */
  shape: number;
  color: number;
  used: boolean;
};

export type BpState = {
  /** 81 マス。null は空、数値は色 index。 */
  board: (number | null)[];
  pieces: BpPiece[];
  score: number;
  /** 消したラインの累計。 */
  lines: number;
  /** 配置したマスの累計。 */
  placedCells: number;
  status: "playing" | "over";
  seed: number;
  rng: number;
};

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function drawPieces(rng: number): { pieces: BpPiece[]; rng: number } {
  const pieces: BpPiece[] = [];
  let r = rng;
  for (let i = 0; i < 3; i++) {
    const a = nextRandom(r);
    r = a.rng;
    const b = nextRandom(r);
    r = b.rng;
    pieces.push({
      shape: Math.floor(a.value * BP_SHAPES.length),
      color: Math.floor(b.value * BP_COLORS),
      used: false,
    });
  }
  return { pieces, rng: r };
}

/** 指定位置（shape の原点が board の (row, col) に来る）に置けるか。 */
export function canPlacePiece(
  board: (number | null)[],
  shapeIdx: number,
  row: number,
  col: number,
): boolean {
  const s = BP_SHAPES[shapeIdx];
  if (!s) return false;
  for (const [dr, dc] of s.cells) {
    const r = row + dr;
    const c = col + dc;
    if (r < 0 || c < 0 || r >= BP_SIZE || c >= BP_SIZE) return false;
    if (board[r * BP_SIZE + c] !== null) return false;
  }
  return true;
}

/** そのブロックを盤のどこかに置けるか。 */
export function pieceFitsAnywhere(board: (number | null)[], shapeIdx: number): boolean {
  for (let r = 0; r < BP_SIZE; r++) {
    for (let c = 0; c < BP_SIZE; c++) {
      if (canPlacePiece(board, shapeIdx, r, c)) return true;
    }
  }
  return false;
}

/** 埋まっているライン（行 index / 列 index / 3x3 ブロック index）の集合を返す。 */
export function completedUnits(board: (number | null)[]): {
  rows: number[];
  cols: number[];
  boxes: number[];
} {
  const rows: number[] = [];
  const cols: number[] = [];
  const boxes: number[] = [];
  for (let r = 0; r < BP_SIZE; r++) {
    if (board.slice(r * BP_SIZE, r * BP_SIZE + BP_SIZE).every((v) => v !== null)) rows.push(r);
  }
  for (let c = 0; c < BP_SIZE; c++) {
    let full = true;
    for (let r = 0; r < BP_SIZE; r++) {
      if (board[r * BP_SIZE + c] === null) {
        full = false;
        break;
      }
    }
    if (full) cols.push(c);
  }
  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      let full = true;
      for (let dr = 0; dr < 3 && full; dr++) {
        for (let dc = 0; dc < 3; dc++) {
          if (board[(br * 3 + dr) * BP_SIZE + (bc * 3 + dc)] === null) {
            full = false;
            break;
          }
        }
      }
      if (full) boxes.push(br * 3 + bc);
    }
  }
  return { rows, cols, boxes };
}

function applyClears(board: (number | null)[]): { board: (number | null)[]; lines: number } {
  const { rows, cols, boxes } = completedUnits(board);
  const total = rows.length + cols.length + boxes.length;
  if (total === 0) return { board, lines: 0 };
  const next = [...board];
  for (const r of rows) {
    for (let c = 0; c < BP_SIZE; c++) next[r * BP_SIZE + c] = null;
  }
  for (const c of cols) {
    for (let r = 0; r < BP_SIZE; r++) next[r * BP_SIZE + c] = null;
  }
  for (const b of boxes) {
    const br = Math.floor(b / 3) * 3;
    const bc = (b % 3) * 3;
    for (let dr = 0; dr < 3; dr++) {
      for (let dc = 0; dc < 3; dc++) next[(br + dr) * BP_SIZE + (bc + dc)] = null;
    }
  }
  return { board: next, lines: total };
}

function isOver(board: (number | null)[], pieces: BpPiece[]): boolean {
  const rest = pieces.filter((p) => !p.used);
  if (rest.length === 0) return false;
  return rest.every((p) => !pieceFitsAnywhere(board, p.shape));
}

export function createBlockPuzzleGame(seed: number): BpState {
  const { pieces, rng } = drawPieces(seed | 0);
  return {
    board: Array.from({ length: BP_SIZE * BP_SIZE }, () => null),
    pieces,
    score: 0,
    lines: 0,
    placedCells: 0,
    status: "playing",
    seed: seed | 0,
    rng,
  };
}

/**
 * ブロックを配置する。pieceIdx は pieces の位置（0..2）。
 * 置けない場合（終了済み・使用済み・範囲外・重なり）は状態をそのまま返す。
 */
export function placePiece(state: BpState, pieceIdx: number, row: number, col: number): BpState {
  if (state.status !== "playing") return state;
  const piece = state.pieces[pieceIdx];
  if (!piece || piece.used) return state;
  if (!canPlacePiece(state.board, piece.shape, row, col)) return state;

  const shapeDef = BP_SHAPES[piece.shape];
  const board = [...state.board];
  for (const [dr, dc] of shapeDef.cells) {
    board[(row + dr) * BP_SIZE + (col + dc)] = piece.color;
  }
  const cleared = applyClears(board);
  const bonus = cleared.lines === 0 ? 0 : 10 * cleared.lines * cleared.lines;

  let pieces = state.pieces.map((p, i) => (i === pieceIdx ? { ...p, used: true } : p));
  let rng = state.rng;
  if (pieces.every((p) => p.used)) {
    const drawn = drawPieces(rng);
    pieces = drawn.pieces;
    rng = drawn.rng;
  }
  const over = isOver(cleared.board, pieces);
  return {
    ...state,
    board: cleared.board,
    pieces,
    rng,
    score: state.score + shapeDef.cells.length + bonus,
    lines: state.lines + cleared.lines,
    placedCells: state.placedCells + shapeDef.cells.length,
    status: over ? "over" : "playing",
  };
}
