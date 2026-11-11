// ノノグラム（お絵かきロジック）の純粋ロジック（UI 非依存・シード決定的）。
// 絵柄パターンを内蔵し、回転・反転・色反転のバリエーションで出題する。
// 塗り（1）/×印（2）の2モード。塗りが正解と一致し、間違い塗りが無い状態で完成。

export type NonoSize = 10 | 15;
/** 0=未決定, 1=塗り, 2=×印。 */
export type NonoMark = 0 | 1 | 2;
export type NonoTransform = "none" | "flipH" | "flipV" | "rot90" | "rot180" | "invert";

export interface NonogramPatternDef {
  id: string;
  title: string;
  size: NonoSize;
  /** "#"=塗るマス, "."=空きマス。size 本の文字列（各 size 文字）。 */
  rows: string[];
}

export const NONOGRAM_PATTERNS: NonogramPatternDef[] = [
  {
    id: "heart",
    title: "ハート",
    size: 10,
    rows: [
      ".##....##.",
      "##########",
      "##########",
      "##########",
      ".########.",
      ".########.",
      "..######..",
      "..######..",
      "...####...",
      "....##....",
    ],
  },
  {
    id: "mushroom",
    title: "キノコ",
    size: 10,
    rows: [
      "...####...",
      ".########.",
      "##########",
      "##..##..##",
      "##########",
      ".########.",
      "....##....",
      "....##....",
      "...####...",
      "...####...",
    ],
  },
  {
    id: "house",
    title: "おうち",
    size: 10,
    rows: [
      "....##....",
      "...####...",
      "..######..",
      ".########.",
      "##########",
      "..######..",
      "..##..##..",
      "..##..##..",
      "..##..##..",
      "..######..",
    ],
  },
  {
    id: "star",
    title: "ほし",
    size: 10,
    rows: [
      "....##....",
      "....##....",
      "...####...",
      "##########",
      ".########.",
      "..######..",
      "..######..",
      ".###..###.",
      ".##....##.",
      "##......##",
    ],
  },
  {
    id: "rocket",
    title: "ロケット",
    size: 15,
    rows: [
      ".......#.......",
      "......###......",
      "......###......",
      ".....#####.....",
      ".....##.##.....",
      ".....#####.....",
      ".....#####.....",
      ".....#####.....",
      "....#######....",
      "...#########...",
      "..###########..",
      "..##.#####.##..",
      ".....#####.....",
      "......###......",
      ".......#.......",
    ],
  },
  {
    id: "tree",
    title: "ツリー",
    size: 15,
    rows: [
      ".......#.......",
      "......###......",
      ".....#####.....",
      "......###......",
      ".....#####.....",
      "....#######....",
      "...#########...",
      ".....#####.....",
      "....#######....",
      "...#########...",
      "..###########..",
      ".#############.",
      ".......#.......",
      ".......#.......",
      "......###......",
    ],
  },
  {
    id: "ghost",
    title: "おばけ",
    size: 15,
    rows: [
      ".....#####.....",
      "...#########...",
      "..###########..",
      ".#############.",
      ".##..#####..##.",
      ".##..#####..##.",
      ".#############.",
      ".#############.",
      ".#############.",
      ".#############.",
      ".#############.",
      ".#############.",
      ".#############.",
      ".##.###.###.##.",
      "..#..#...#..#..",
    ],
  },
];

const TRANSFORMS: NonoTransform[] = ["none", "flipH", "flipV", "rot90", "rot180", "invert"];

/** mulberry32（minesweeper 等と同一方式）。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

/** パターン文字列 → フラットな正解配列（index = row*size+col）。 */
export function patternToSolution(rows: string[]): boolean[] {
  const out: boolean[] = [];
  for (const row of rows) {
    for (const ch of row) out.push(ch === "#");
  }
  return out;
}

/** 正解配列に変形を適用する（盤は正方形前提）。 */
export function transformSolution(solution: boolean[], size: number, transform: NonoTransform): boolean[] {
  if (transform === "none") return [...solution];
  if (transform === "invert") return solution.map((v) => !v);
  const out = new Array<boolean>(size * size).fill(false);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      let nr = r;
      let nc = c;
      if (transform === "flipH") {
        nc = size - 1 - c;
      } else if (transform === "flipV") {
        nr = size - 1 - r;
      } else if (transform === "rot90") {
        nr = c;
        nc = size - 1 - r;
      } else if (transform === "rot180") {
        nr = size - 1 - r;
        nc = size - 1 - c;
      }
      out[nr * size + nc] = solution[r * size + c];
    }
  }
  return out;
}

/** 1行（列）のヒント: 連続する塗りマスの長さの列。塗りが無ければ [0]。 */
export function lineHints(line: boolean[]): number[] {
  const hints: number[] = [];
  let run = 0;
  for (const cell of line) {
    if (cell) {
      run++;
    } else if (run > 0) {
      hints.push(run);
      run = 0;
    }
  }
  if (run > 0) hints.push(run);
  return hints.length > 0 ? hints : [0];
}

export function computeRowHints(solution: boolean[], size: number): number[][] {
  const rows: number[][] = [];
  for (let r = 0; r < size; r++) {
    rows.push(lineHints(solution.slice(r * size, r * size + size)));
  }
  return rows;
}

export function computeColHints(solution: boolean[], size: number): number[][] {
  const cols: number[][] = [];
  for (let c = 0; c < size; c++) {
    const line: boolean[] = [];
    for (let r = 0; r < size; r++) line.push(solution[r * size + c]);
    cols.push(lineHints(line));
  }
  return cols;
}

/** 完成判定: 正解マスが全て塗られ、間違い塗りが1つも無いこと。 */
export function isNonogramComplete(solution: boolean[], marks: NonoMark[]): boolean {
  for (let i = 0; i < solution.length; i++) {
    if (solution[i] && marks[i] !== 1) return false;
    if (!solution[i] && marks[i] === 1) return false;
  }
  return true;
}

export type NonoState = {
  size: NonoSize;
  patternId: string;
  /** 絵柄の名前（完成後に見せる想定）。 */
  patternTitle: string;
  transform: NonoTransform;
  solution: boolean[];
  rowHints: number[][];
  colHints: number[][];
  marks: NonoMark[];
  /** 現在「塗りだが正解ではない」マスの index 一覧。 */
  errors: number[];
  /** 間違い塗りをした累計回数。 */
  mistakes: number;
  moves: number;
  status: "playing" | "won";
  seed: number;
};

export function createNonogramGame(seed: number, size: NonoSize = 10): NonoState {
  const patterns = NONOGRAM_PATTERNS.filter((p) => p.size === size);
  const pool = patterns.length > 0 ? patterns : NONOGRAM_PATTERNS;
  const actualSize = (pool[0]?.size ?? 10) as NonoSize;
  let rng = seed | 0;
  const r1 = nextRandom(rng);
  rng = r1.rng;
  const pattern = pool[Math.floor(r1.value * pool.length)] ?? pool[0];
  const r2 = nextRandom(rng);
  rng = r2.rng;
  const transform = TRANSFORMS[Math.floor(r2.value * TRANSFORMS.length)] ?? "none";
  const solution = transformSolution(patternToSolution(pattern.rows), pattern.size, transform);
  return {
    size: actualSize,
    patternId: pattern.id,
    patternTitle: pattern.title,
    transform,
    solution,
    rowHints: computeRowHints(solution, actualSize),
    colHints: computeColHints(solution, actualSize),
    marks: new Array<NonoMark>(actualSize * actualSize).fill(0),
    errors: [],
    mistakes: 0,
    moves: 0,
    status: "playing",
    seed,
  };
}

/**
 * マスに印を付ける（mark は 0/1/2）。同じ印の再設定や完成後の操作は無効。
 * 正解でないマスを塗ると mistakes が増え、errors に載る（塗りを消すと下りる）。
 */
export function setNonoMark(state: NonoState, index: number, mark: NonoMark): NonoState {
  if (state.status === "won") return state;
  if (!Number.isInteger(index) || index < 0 || index >= state.marks.length) return state;
  if (mark !== 0 && mark !== 1 && mark !== 2) return state;
  const prev = state.marks[index];
  if (prev === mark) return state;
  const marks = [...state.marks];
  marks[index] = mark;
  const isWrongFill = mark === 1 && !state.solution[index];
  const wasWrongFill = prev === 1 && !state.solution[index];
  const errors = state.errors.filter((i) => i !== index);
  if (isWrongFill) errors.push(index);
  errors.sort((a, b) => a - b);
  const won = isNonogramComplete(state.solution, marks);
  return {
    ...state,
    marks,
    errors,
    mistakes: state.mistakes + (isWrongFill && !wasWrongFill ? 1 : 0),
    moves: state.moves + 1,
    status: won ? "won" : "playing",
  };
}

/** 正解マスのうち塗れた数 / 正解マス総数（進捗表示用）。 */
export function nonogramProgress(state: NonoState): { filled: number; total: number } {
  let filled = 0;
  let total = 0;
  for (let i = 0; i < state.solution.length; i++) {
    if (!state.solution[i]) continue;
    total++;
    if (state.marks[i] === 1) filled++;
  }
  return { filled, total };
}
