// テリトリオ（2人）: ポリオミノを角接触だけで広げる陣取りボードゲーム。
// モジュール契約は lib/online/types.ts の OnlineGameModule に従う。
// 実行時 import は禁止（テストが import を剥がして連結するため type のみ）。
//
// 盤面: 10×10、index = row*10+col。0=空, 1=seat0, 2=seat1。
// seat0 は左上 (0,0)、seat1 は右下 (9,9) の角から開始する。
// 置き方の規則（自分のピースについて）:
//   - 最初のピースは自分の角のマスを含まなければならない
//   - 2手目以降は自分のピースと「角（斜め）」でのみ接してよい
//   - 自分のピースと「辺（上下左右）」で接してはいけない
//   - 空マスにしか置けない（相手と辺/角で接するのは自由）
// 置ける手が無い手番はパスしかできない。両者連続パスで終了し、
// 盤を多く埋めた方（マス数）が勝ち。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export const TERRITORY_SIZE = 10;

export interface TerritoryPieceDef {
  name: string;
  cells: [number, number][];
}

/** 両プレイヤー共通のピース構成（全12種、各1個）。 */
export const TERRITORY_PIECES: TerritoryPieceDef[] = [
  { name: "ミニ", cells: [[0, 0]] },
  { name: "ドミノ", cells: [[0, 0], [0, 1]] },
  { name: "トリオミノ I", cells: [[0, 0], [0, 1], [0, 2]] },
  { name: "トリオミノ L", cells: [[0, 0], [1, 0], [1, 1]] },
  { name: "テトロミノ I", cells: [[0, 0], [0, 1], [0, 2], [0, 3]] },
  { name: "スクエア", cells: [[0, 0], [0, 1], [1, 0], [1, 1]] },
  { name: "テトロミノ T", cells: [[0, 0], [0, 1], [0, 2], [1, 1]] },
  { name: "テトロミノ L", cells: [[0, 0], [1, 0], [2, 0], [2, 1]] },
  { name: "テトロミノ S", cells: [[0, 1], [0, 2], [1, 0], [1, 1]] },
  { name: "ペントミノ P", cells: [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0]] },
  { name: "ペントミノ T", cells: [[0, 0], [0, 1], [0, 2], [1, 1], [2, 1]] },
  { name: "ペントミノ V", cells: [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]] },
];

export interface TerritoryState {
  players: SeatInfo[];
  board: number[];
  used: boolean[][];
  turn: number;
  passStreak: number;
  finished: boolean;
  winner: number | "draw" | null;
  lastMove: { seat: number; piece: number; cells: number[] } | null;
  lastPassSeat: number | null;
}

export type TerritoryAction =
  | { type: "place"; piece: number; cells: number[] }
  | { type: "pass" };

export interface TerritoryView {
  board: number[];
  used: boolean[][];
  turn: number;
  passStreak: number;
  scores: [number, number];
  finished: boolean;
  winner: number | "draw" | null;
  lastMove: { seat: number; piece: number; cells: number[] } | null;
  lastPassSeat: number | null;
  players: SeatInfo[];
}

function terClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function terNormalizeCells(cells: [number, number][]): [number, number][] {
  let minR = Infinity;
  let minC = Infinity;
  for (const [r, c] of cells) {
    if (r < minR) minR = r;
    if (c < minC) minC = c;
  }
  return cells
    .map(([r, c]) => [r - minR, c - minC] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function terCellsKey(cells: [number, number][]): string {
  return cells.map(([r, c]) => `${r},${c}`).join(";");
}

/** ピースを反転（flip: 左右反転）→回転（rotation: 時計回り90度×n）した正規化済み形状。 */
export function transformTerritoryPiece(
  pieceIndex: number,
  rotation: number,
  flip: boolean,
): [number, number][] {
  const def = TERRITORY_PIECES[pieceIndex];
  if (!def) return [];
  let cells: [number, number][] = def.cells.map(([r, c]) => [r, flip ? -c : c] as [number, number]);
  const turns = ((rotation % 4) + 4) % 4;
  for (let t = 0; t < turns; t++) {
    cells = cells.map(([r, c]) => [c, -r] as [number, number]);
  }
  return terNormalizeCells(cells);
}

/** ピースの全ての異なる向き（回転4×反転2から重複を除いたもの）。 */
export function territoryTransforms(pieceIndex: number): [number, number][][] {
  const seen = new Set<string>();
  const out: [number, number][][] = [];
  for (const flip of [false, true]) {
    for (let rotation = 0; rotation < 4; rotation++) {
      const shape = transformTerritoryPiece(pieceIndex, rotation, flip);
      const key = terCellsKey(shape);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(shape);
    }
  }
  return out;
}

/**
 * (row, col) を形状の左上として置いたときの盤面 index 一覧。
 * 盤外にはみ出す場合は null。
 */
export function placementCells(
  pieceIndex: number,
  rotation: number,
  flip: boolean,
  row: number,
  col: number,
): number[] | null {
  const shape = transformTerritoryPiece(pieceIndex, rotation, flip);
  if (shape.length === 0) return null;
  const out: number[] = [];
  for (const [dr, dc] of shape) {
    const r = row + dr;
    const c = col + dc;
    if (r < 0 || r >= TERRITORY_SIZE || c < 0 || c >= TERRITORY_SIZE) return null;
    out.push(r * TERRITORY_SIZE + c);
  }
  return out.sort((a, b) => a - b);
}

export function terStartCorner(seat: number): number {
  return seat === 0 ? 0 : TERRITORY_SIZE * TERRITORY_SIZE - 1;
}

export function territoryScores(board: number[]): [number, number] {
  let n0 = 0;
  let n1 = 0;
  for (const v of board) {
    if (v === 1) n0++;
    else if (v === 2) n1++;
  }
  return [n0, n1];
}

type TerLegality = { ok: true } | { ok: false; reason: string };

function terLegality(board: number[], seat: number, cells: number[]): TerLegality {
  const own = seat + 1;
  if (!Array.isArray(cells) || cells.length === 0) {
    return { ok: false, reason: "置くマスが指定されていません" };
  }
  if (new Set(cells).size !== cells.length) {
    return { ok: false, reason: "マスが重複しています" };
  }
  for (const idx of cells) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= TERRITORY_SIZE * TERRITORY_SIZE) {
      return { ok: false, reason: "盤外のマスが含まれています" };
    }
    if (board[idx] !== 0) {
      return { ok: false, reason: "既に埋まっているマスがあります" };
    }
  }
  const cellSet = new Set(cells);
  const firstMove = !board.includes(own);
  if (firstMove) {
    if (!cellSet.has(terStartCorner(seat))) {
      return { ok: false, reason: "最初のピースは自分の角のマスを含めてください" };
    }
    return { ok: true };
  }
  let touchesCorner = false;
  for (const idx of cells) {
    const r = Math.floor(idx / TERRITORY_SIZE);
    const c = idx % TERRITORY_SIZE;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= TERRITORY_SIZE || nc < 0 || nc >= TERRITORY_SIZE) continue;
      if (board[nr * TERRITORY_SIZE + nc] === own) {
        return { ok: false, reason: "自分のピースと辺で接する置き方はできません" };
      }
    }
    for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= TERRITORY_SIZE || nc < 0 || nc >= TERRITORY_SIZE) continue;
      if (board[nr * TERRITORY_SIZE + nc] === own) touchesCorner = true;
    }
  }
  if (!touchesCorner) {
    return { ok: false, reason: "自分のピースと角で接するように置いてください" };
  }
  return { ok: true };
}

/** 配置 cells が、そのピースの回転/反転のいずれかと一致するか。 */
function terShapeMatches(pieceIndex: number, cells: number[]): boolean {
  const def = TERRITORY_PIECES[pieceIndex];
  if (!def || cells.length !== def.cells.length) return false;
  const local = terNormalizeCells(
    cells.map((idx) => [Math.floor(idx / TERRITORY_SIZE), idx % TERRITORY_SIZE] as [number, number]),
  );
  const key = terCellsKey(local);
  return territoryTransforms(pieceIndex).some((shape) => terCellsKey(shape) === key);
}

export function isLegalTerritoryPlacement(board: number[], seat: number, cells: number[]): boolean {
  return terLegality(board, seat, cells).ok;
}

/** seat が現在置ける全ての手（ピース×向き×位置）を列挙する。 */
export function enumerateTerritoryPlacements(
  board: number[],
  seat: number,
  usedPieces: boolean[],
): { piece: number; cells: number[] }[] {
  const out: { piece: number; cells: number[] }[] = [];
  for (let piece = 0; piece < TERRITORY_PIECES.length; piece++) {
    if (usedPieces[piece]) continue;
    for (const shape of territoryTransforms(piece)) {
      for (let row = 0; row < TERRITORY_SIZE; row++) {
        for (let col = 0; col < TERRITORY_SIZE; col++) {
          const cells: number[] = [];
          let inBounds = true;
          for (const [dr, dc] of shape) {
            const r = row + dr;
            const c = col + dc;
            if (r >= TERRITORY_SIZE || c >= TERRITORY_SIZE) {
              inBounds = false;
              break;
            }
            cells.push(r * TERRITORY_SIZE + c);
          }
          if (!inBounds) continue;
          cells.sort((a, b) => a - b);
          if (terLegality(board, seat, cells).ok) out.push({ piece, cells });
        }
      }
    }
  }
  return out;
}

function terWinnerByScores(board: number[]): number | "draw" {
  const [n0, n1] = territoryScores(board);
  if (n0 === n1) return "draw";
  return n0 > n1 ? 0 : 1;
}

function terCreateState(
  players: SeatInfo[],
  _rng: Rng,
  _options: Record<string, unknown>,
): TerritoryState {
  if (!Array.isArray(players) || players.length !== 2) {
    throw new Error("テリトリオは2人専用です");
  }
  return {
    players: terClone(players),
    board: new Array<number>(TERRITORY_SIZE * TERRITORY_SIZE).fill(0),
    used: [
      new Array<boolean>(TERRITORY_PIECES.length).fill(false),
      new Array<boolean>(TERRITORY_PIECES.length).fill(false),
    ],
    turn: 0,
    passStreak: 0,
    finished: false,
    winner: null,
    lastMove: null,
    lastPassSeat: null,
  };
}

function terApplyAction(
  state: TerritoryState,
  seat: number,
  action: TerritoryAction,
  _rng: Rng,
): TerritoryState {
  if (state.finished) throw new Error("対局は終了しています");
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) {
    throw new Error("不正な席です");
  }
  if (seat !== state.turn) throw new Error("あなたの手番ではありません");
  if (!action || typeof action !== "object") throw new Error("不明なアクションです");

  if (action.type === "pass") {
    if (enumerateTerritoryPlacements(state.board, seat, state.used[seat]).length > 0) {
      throw new Error("置けるピースがあるのでパスできません");
    }
    const next = terClone(state);
    next.passStreak = state.passStreak + 1;
    next.lastPassSeat = seat;
    next.lastMove = null;
    if (next.passStreak >= 2) {
      next.finished = true;
      next.winner = terWinnerByScores(next.board);
    } else {
      next.turn = 1 - seat;
    }
    return next;
  }

  if (action.type === "place") {
    const piece = action.piece;
    if (!Number.isInteger(piece) || piece < 0 || piece >= TERRITORY_PIECES.length) {
      throw new Error("ピースが不正です");
    }
    if (state.used[seat][piece]) throw new Error("そのピースは既に使っています");
    const cells = action.cells;
    if (!Array.isArray(cells) || cells.some((v) => !Number.isInteger(v))) {
      throw new Error("置くマスが不正です");
    }
    if (!terShapeMatches(piece, cells)) {
      throw new Error("ピースの形と一致しない置き方です");
    }
    const legality = terLegality(state.board, seat, cells);
    if (!legality.ok) throw new Error(legality.reason);
    const next = terClone(state);
    const own = seat + 1;
    for (const idx of cells) next.board[idx] = own;
    next.used[seat][piece] = true;
    next.passStreak = 0;
    next.lastPassSeat = null;
    next.lastMove = { seat, piece, cells: [...cells].sort((a, b) => a - b) };
    next.turn = 1 - seat;
    return next;
  }

  throw new Error("不明なアクションです");
}

function terViewFor(state: TerritoryState, _seat: number): TerritoryView {
  return {
    board: [...state.board],
    used: state.used.map((row) => [...row]),
    turn: state.turn,
    passStreak: state.passStreak,
    scores: territoryScores(state.board),
    finished: state.finished,
    winner: state.winner,
    lastMove: state.lastMove
      ? { seat: state.lastMove.seat, piece: state.lastMove.piece, cells: [...state.lastMove.cells] }
      : null,
    lastPassSeat: state.lastPassSeat,
    players: terClone(state.players),
  };
}

function terParseAction(raw: unknown): TerritoryAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.type === "pass") return { type: "pass" };
  if (r.type === "place") {
    if (typeof r.piece !== "number" || !Number.isInteger(r.piece)) return null;
    if (!Array.isArray(r.cells) || r.cells.length === 0) return null;
    const cells: number[] = [];
    for (const v of r.cells) {
      if (typeof v !== "number" || !Number.isInteger(v)) return null;
      cells.push(v);
    }
    return { type: "place", piece: r.piece, cells };
  }
  return null;
}

function terOnPlayerLeft(state: TerritoryState, seat: number): TerritoryState {
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) {
    throw new Error("不正な席です");
  }
  if (state.finished) return terClone(state);
  const next = terClone(state);
  next.finished = true;
  next.winner = seat === 0 ? 1 : 0;
  return next;
}

function terCpuAction(state: TerritoryState, seat: number, rng: Rng): TerritoryAction | null {
  if (state.finished || seat !== state.turn) return null;
  const placements = enumerateTerritoryPlacements(state.board, seat, state.used[seat]);
  if (placements.length === 0) return { type: "pass" };
  const own = seat + 1;
  let best: { piece: number; cells: number[] } | null = null;
  let bestScore = -Infinity;
  for (const cand of placements) {
    // 貪欲: 大きいピース優先。次点で、置いた後に自分の角に接する
    // 空きマス（次の展開先）が多い手を選ぶ。
    const placed = new Set(cand.cells);
    const frontier = new Set<number>();
    for (const idx of cand.cells) {
      const r = Math.floor(idx / TERRITORY_SIZE);
      const c = idx % TERRITORY_SIZE;
      for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= TERRITORY_SIZE || nc < 0 || nc >= TERRITORY_SIZE) continue;
        const nIdx = nr * TERRITORY_SIZE + nc;
        if (state.board[nIdx] === 0 && !placed.has(nIdx)) frontier.add(nIdx);
      }
    }
    void own;
    const score = cand.cells.length * 1000 + frontier.size + rng() * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  if (!best) return { type: "pass" };
  return { type: "place", piece: best.piece, cells: [...best.cells] };
}

export const gameModule: OnlineGameModule<TerritoryState, TerritoryAction, TerritoryView> = {
  id: "territory",
  title: "テリトリオ",
  minPlayers: 2,
  maxPlayers: 2,
  cpuSupported: true,
  chatEnabled: true,
  createState: terCreateState,
  applyAction: terApplyAction,
  viewFor: terViewFor,
  parseAction: terParseAction,
  phaseOf: (state) => (state.finished ? "finished" : "playing"),
  isFinished: (state) => state.finished,
  onPlayerLeft: terOnPlayerLeft,
  cpuAction: terCpuAction,
};
