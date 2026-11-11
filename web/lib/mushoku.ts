// 虫食い算の純粋ロジック（UI 非依存・シード決定的）。
// 掛け算の筆算（2桁×2桁 / 3桁×2桁）を先に作り、一部の数字を隠して問題にする。
// 隠し方によっては答えが一意にならないことがあるため、判定は「元の答えとの一致」ではなく
// 「埋めた数字全体で筆算の式が整合するか」で行う設計:
// A 行と B 行が確定したら部分積と積は一意に決まるので、各行の値がそれと一致すればクリア。
// つまり、整合する別の解を埋めてもクリアになる（チェックはその前提で結果を返す）。

export type MushokuLevel = "2x2" | "3x2";
export type MushokuRowKind = "a" | "b" | "partial" | "product";
export type MushokuStatus = "playing" | "solved";

export interface MushokuCell {
  id: number;
  row: number;
  /** 盤の列（0 が最左）。その行の数字が置かれていない列にはセル自体が存在しない。 */
  col: number;
  /** 生成時の正解の数字（表示には使わない。given セルは input の代わりにこれを表示する）。 */
  answer: number;
  /** 最初から見えている数字か。 */
  given: boolean;
  /** プレイヤーの入力。未入力は null。 */
  input: number | null;
}

export interface MushokuState {
  level: MushokuLevel;
  /** 盤の列数（積の桁数）。 */
  width: number;
  /** 行ごとの種別。上から a, b, partial(1の位), partial(10の位), product。 */
  rowKinds: MushokuRowKind[];
  cells: MushokuCell[];
  status: MushokuStatus;
  seed: number;
}

export interface MushokuEvaluation {
  filledCount: number;
  totalCount: number;
  /** 全セルが埋まっているか。 */
  complete: boolean;
  /** 全セルが埋まり、かつ筆算として整合しているか（= クリア）。 */
  consistent: boolean;
  /** A・B が確定している場合に、期待値と違う数字が入っている入力セルの id。 */
  wrongIds: number[];
}

/** mulberry32。状態を持ち回さず、生成専用に局所で使う。 */
function makeRng(seed: number): () => number {
  let t = seed | 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function shuffled<T>(rng: () => number, arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 行の右端の列。部分積 i 行目（0 = B の1の位）はその分だけ左にずれる。 */
function rightEdgeOf(state: Pick<MushokuState, "width" | "rowKinds">, row: number): number {
  const kind = state.rowKinds[row];
  if (kind === "partial") {
    const partialIndex = state.rowKinds.slice(0, row + 1).filter((k) => k === "partial").length - 1;
    return state.width - 1 - partialIndex;
  }
  return state.width - 1;
}

export function createMushoku(level: MushokuLevel, seed: number): MushokuState {
  const rng = makeRng(seed);
  const a = level === "2x2" ? randInt(rng, 12, 99) : randInt(rng, 112, 999);
  // B の各桁は 2〜9（0 や 1 だと部分積が自明になるため）。
  const bOnes = randInt(rng, 2, 9);
  const bTens = randInt(rng, 2, 9);
  const b = bTens * 10 + bOnes;
  const product = a * b;

  const rowValues: { kind: MushokuRowKind; value: number }[] = [
    { kind: "a", value: a },
    { kind: "b", value: b },
    { kind: "partial", value: a * bOnes },
    { kind: "partial", value: a * bTens },
    { kind: "product", value: product },
  ];
  const width = String(product).length;
  const probe: Pick<MushokuState, "width" | "rowKinds"> = {
    width,
    rowKinds: rowValues.map((r) => r.kind),
  };

  const cells: MushokuCell[] = [];
  let nextId = 0;
  rowValues.forEach(({ value }, row) => {
    const digits = String(value).split("").map((ch) => Number(ch));
    const rightEdge = rightEdgeOf(probe, row);
    const startCol = rightEdge - digits.length + 1;
    digits.forEach((digit, i) => {
      cells.push({
        id: nextId++,
        row,
        col: startCol + i,
        answer: digit,
        given: true,
        input: null,
      });
    });
  });

  // 行ごとに約45%（最低1つ・全隠しはしない）を隠す。
  const byRow = new Map<number, MushokuCell[]>();
  for (const cell of cells) {
    const list = byRow.get(cell.row) ?? [];
    list.push(cell);
    byRow.set(cell.row, list);
  }
  for (const list of byRow.values()) {
    if (list.length < 2) continue;
    const hideCount = Math.min(list.length - 1, Math.max(1, Math.round(list.length * 0.45)));
    const order = shuffled(rng, list);
    for (let i = 0; i < hideCount; i++) {
      order[i].given = false;
    }
  }

  return {
    level,
    width,
    rowKinds: probe.rowKinds,
    cells,
    status: "playing",
    seed: seed | 0,
  };
}

/** セルに数字を入力する（null で消去）。与えられた数字のセルと終了後は変更できない。 */
export function setMushokuInput(
  state: MushokuState,
  cellId: number,
  digit: number | null,
): MushokuState {
  if (state.status !== "playing") return state;
  if (digit !== null && (!Number.isInteger(digit) || digit < 0 || digit > 9)) return state;
  const target = state.cells.find((c) => c.id === cellId);
  if (!target || target.given || target.input === digit) return state;
  return {
    ...state,
    cells: state.cells.map((c) => (c.id === cellId ? { ...c, input: digit } : c)),
  };
}

function cellValue(cell: MushokuCell): number | null {
  return cell.given ? cell.answer : cell.input;
}

/** 行の値を組み立てる。未入力があれば null。 */
function rowValue(state: MushokuState, row: number): number | null {
  const rowCells = state.cells.filter((c) => c.row === row).sort((x, y) => x.col - y.col);
  let value = 0;
  for (const cell of rowCells) {
    const v = cellValue(cell);
    if (v === null) return null;
    value = value * 10 + v;
  }
  return value;
}

/** A・B が確定したときの各行の期待値。確定していなければ null。 */
function expectedRowValues(state: MushokuState): number[] | null {
  const a = rowValue(state, 0);
  const b = rowValue(state, 1);
  if (a === null || b === null) return null;
  const bOnes = b % 10;
  const bTens = Math.floor(b / 10) % 10;
  return state.rowKinds.map((kind, row) => {
    if (kind === "a") return a;
    if (kind === "b") return b;
    if (kind === "product") return a * b;
    const partialIndex = state.rowKinds.slice(0, row + 1).filter((k) => k === "partial").length - 1;
    return a * (partialIndex === 0 ? bOnes : bTens);
  });
}

/** 期待値における (row, col) の数字。その列に数字が無い場合は null。 */
function expectedDigit(state: MushokuState, expected: number, row: number, col: number): number | null {
  const rightEdge = rightEdgeOf(state, row);
  const digits = String(expected);
  const startCol = rightEdge - digits.length + 1;
  if (col < startCol || col > rightEdge) return null;
  return Number(digits[col - startCol]);
}

export function evaluateMushoku(state: MushokuState): MushokuEvaluation {
  const totalCount = state.cells.length;
  const filledCount = state.cells.filter((c) => cellValue(c) !== null).length;
  const complete = filledCount === totalCount;
  const expected = expectedRowValues(state);
  const wrongIds: number[] = [];
  let consistent = false;
  if (expected !== null) {
    for (const cell of state.cells) {
      if (cell.given) continue;
      const v = cell.input;
      if (v === null) continue;
      if (expectedDigit(state, expected[cell.row], cell.row, cell.col) !== v) {
        wrongIds.push(cell.id);
      }
    }
    if (complete) {
      consistent = state.rowKinds.every((_, row) => rowValue(state, row) === expected[row]);
    }
  }
  return { filledCount, totalCount, complete, consistent, wrongIds };
}

/** チェックを実行し、整合していれば status を solved に進めた状態を返す。 */
export function checkMushoku(state: MushokuState): { state: MushokuState; evaluation: MushokuEvaluation } {
  const evaluation = evaluateMushoku(state);
  if (state.status === "playing" && evaluation.complete && evaluation.consistent) {
    return { state: { ...state, status: "solved" }, evaluation };
  }
  return { state, evaluation };
}
