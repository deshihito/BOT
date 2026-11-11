// チェッカー（英式ドラフト）のルールモジュール。8×8、濃色マスのみ使用。
// コマ: 0=空, 1=seat0の通常コマ, 2=seat1の通常コマ, 3=seat0のキング, 4=seat1のキング。
// index = row*8+col、row0=最上段。seat0 は下段（row5〜7）から上へ、seat1 は上段（row0〜2）から下へ進む。
// ルール要旨:
// - 取れる手がある場合は取り手のみ合法（強制取り）。
// - 取ったあと同コマで続けて取れる場合は手番を継続し、そのコマの取り手のみ合法（連続取り）。
// - 通常コマは前進のみ（移動も取りも前方のみ）、キングは全方向に1マス移動／取りが可能。
// - 通常コマが最奥列に到達したらキングに昇格し、その手番はそこで終わる。
// - 相手のコマが無くなるか、相手に合法手が無くなれば勝ち。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export type CheckersState = {
  players: SeatInfo[];
  board: number[];
  turn: number;
  /** 連続取りの途中なら、続けなければならないコマの index。そうでなければ null。 */
  mustCaptureFrom: number | null;
  lastMove: { from: number; to: number } | null;
  finished: boolean;
  winner: number | "draw" | null;
};

export type CheckersAction = { type: "move"; from: number; to: number };

export type CheckersMove = {
  from: number;
  to: number;
  /** 取るコマの index。取らない手では null。 */
  captured: number | null;
  /** この手でキングに昇格するか。 */
  promote: boolean;
};

export type CheckersView = {
  board: number[];
  turn: number;
  mustCaptureFrom: number | null;
  /** 閲覧者が手番のときだけ、そのプレイヤーの合法手一覧。 */
  yourMoves: CheckersMove[];
  counts: [number, number];
  lastMove: { from: number; to: number } | null;
  finished: boolean;
  winner: number | "draw" | null;
  players: SeatInfo[];
};

const CK_SIZE = 8;
const CK_CELLS = 64;

function ckClonePlayers(players: SeatInfo[]): SeatInfo[] {
  return players.map((p) => ({ seat: p.seat, name: p.name }));
}

export function checkersOwnerOf(value: number): number {
  if (value === 1 || value === 3) return 0;
  if (value === 2 || value === 4) return 1;
  return -1;
}

export function checkersIsKing(value: number): boolean {
  return value === 3 || value === 4;
}

function ckRow(index: number): number {
  return Math.floor(index / CK_SIZE);
}

function ckCol(index: number): number {
  return index % CK_SIZE;
}

function ckInBoard(row: number, col: number): boolean {
  return row >= 0 && row < CK_SIZE && col >= 0 && col < CK_SIZE;
}

function ckDirsFor(value: number): ReadonlyArray<readonly [number, number]> {
  if (checkersIsKing(value)) {
    return [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ];
  }
  // 通常コマは前方のみ。seat0 は上（-1）、seat1 は下（+1）。
  return checkersOwnerOf(value) === 0
    ? [
        [-1, -1],
        [-1, 1],
      ]
    : [
        [1, -1],
        [1, 1],
      ];
}

function ckPromotes(value: number, to: number): boolean {
  if (checkersIsKing(value)) return false;
  const row = ckRow(to);
  return checkersOwnerOf(value) === 0 ? row === 0 : row === CK_SIZE - 1;
}

function ckPieceMoves(board: number[], from: number): { steps: CheckersMove[]; captures: CheckersMove[] } {
  const steps: CheckersMove[] = [];
  const captures: CheckersMove[] = [];
  const value = board[from];
  const seat = checkersOwnerOf(value);
  if (seat < 0) return { steps, captures };
  const row = ckRow(from);
  const col = ckCol(from);
  for (const [dr, dc] of ckDirsFor(value)) {
    const midRow = row + dr;
    const midCol = col + dc;
    if (!ckInBoard(midRow, midCol)) continue;
    const mid = midRow * CK_SIZE + midCol;
    if (board[mid] === 0) {
      steps.push({ from, to: mid, captured: null, promote: ckPromotes(value, mid) });
      continue;
    }
    // 隣が相手コマなら、その先が空いていれば取り手。
    if (checkersOwnerOf(board[mid]) === 1 - seat) {
      const landRow = row + dr * 2;
      const landCol = col + dc * 2;
      if (!ckInBoard(landRow, landCol)) continue;
      const land = landRow * CK_SIZE + landCol;
      if (board[land] === 0) {
        captures.push({ from, to: land, captured: mid, promote: ckPromotes(value, land) });
      }
    }
  }
  return { steps, captures };
}

/** 合法手列挙（強制取り・連続取りを反映した正確な一覧）。 */
export function checkersLegalMoves(board: number[], seat: number, mustCaptureFrom: number | null): CheckersMove[] {
  if (mustCaptureFrom !== null) {
    if (checkersOwnerOf(board[mustCaptureFrom]) !== seat) return [];
    return ckPieceMoves(board, mustCaptureFrom).captures;
  }
  const captures: CheckersMove[] = [];
  const steps: CheckersMove[] = [];
  for (let i = 0; i < CK_CELLS; i++) {
    if (checkersOwnerOf(board[i]) !== seat) continue;
    const moves = ckPieceMoves(board, i);
    captures.push(...moves.captures);
    steps.push(...moves.steps);
  }
  return captures.length > 0 ? captures : steps;
}

function ckCounts(board: number[]): [number, number] {
  let n0 = 0;
  let n1 = 0;
  for (const v of board) {
    const owner = checkersOwnerOf(v);
    if (owner === 0) n0++;
    else if (owner === 1) n1++;
  }
  return [n0, n1];
}

function ckInitialBoard(): number[] {
  const board = new Array<number>(CK_CELLS).fill(0);
  for (let row = 0; row < CK_SIZE; row++) {
    for (let col = 0; col < CK_SIZE; col++) {
      if ((row + col) % 2 !== 1) continue;
      const index = row * CK_SIZE + col;
      if (row <= 2) board[index] = 2;
      else if (row >= 5) board[index] = 1;
    }
  }
  return board;
}

function ckKingValue(seat: number): number {
  return seat === 0 ? 3 : 4;
}

/** 手を適用した盤面を返す（合法性は検証しない内部用）。 */
function ckApplyMove(board: number[], move: CheckersMove): number[] {
  const next = [...board];
  const value = next[move.from];
  next[move.from] = 0;
  if (move.captured !== null) next[move.captured] = 0;
  next[move.to] = move.promote ? ckKingValue(checkersOwnerOf(value)) : value;
  return next;
}

export const gameModule: OnlineGameModule<CheckersState, CheckersAction, CheckersView> = {
  id: "checkers",
  title: "チェッカー",
  minPlayers: 2,
  maxPlayers: 2,
  cpuSupported: true,
  chatEnabled: true,

  createState(players: SeatInfo[], _rng: Rng, _options: Record<string, unknown>): CheckersState {
    if (!Array.isArray(players) || players.length !== 2) {
      throw new Error("チェッカーは2人専用です");
    }
    return {
      players: ckClonePlayers(players),
      board: ckInitialBoard(),
      turn: 0,
      mustCaptureFrom: null,
      lastMove: null,
      finished: false,
      winner: null,
    };
  },

  applyAction(state: CheckersState, seat: number, action: CheckersAction, _rng: Rng): CheckersState {
    if (state.finished) throw new Error("対局は終了しています");
    if (seat !== state.turn) throw new Error("あなたの手番ではありません");
    if (!action || typeof action !== "object" || action.type !== "move") {
      throw new Error("不明なアクションです");
    }
    const { from, to } = action;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= CK_CELLS || to < 0 || to >= CK_CELLS) {
      throw new Error("マスが範囲外です");
    }
    if (checkersOwnerOf(state.board[from]) !== seat) {
      throw new Error("自分のコマを選んでください");
    }
    if (state.mustCaptureFrom !== null && from !== state.mustCaptureFrom) {
      throw new Error("連続取り中は同じコマを動かしてください");
    }
    const legal = checkersLegalMoves(state.board, seat, state.mustCaptureFrom);
    const move = legal.find((m) => m.from === from && m.to === to);
    if (!move) {
      const anyCapture = legal.some((m) => m.captured !== null);
      if (state.mustCaptureFrom !== null) {
        throw new Error("連続取りできるので、そのコマで取らなければなりません");
      }
      if (anyCapture) throw new Error("取れるコマがあるので、取らなければなりません");
      throw new Error("そのマスへは動けません");
    }

    const board = ckApplyMove(state.board, move);
    const lastMove = { from: move.from, to: move.to };

    // 連続取り: 取った直後、同コマでさらに取れて、かつ昇格していない場合のみ継続。
    if (move.captured !== null && !move.promote) {
      const followUps = ckPieceMoves(board, move.to).captures;
      if (followUps.length > 0) {
        return {
          players: ckClonePlayers(state.players),
          board,
          turn: seat,
          mustCaptureFrom: move.to,
          lastMove,
          finished: false,
          winner: null,
        };
      }
    }

    const opponent = 1 - seat;
    const [n0, n1] = ckCounts(board);
    const oppCount = opponent === 0 ? n0 : n1;
    const oppMoves = checkersLegalMoves(board, opponent, null);
    if (oppCount === 0 || oppMoves.length === 0) {
      return {
        players: ckClonePlayers(state.players),
        board,
        turn: seat,
        mustCaptureFrom: null,
        lastMove,
        finished: true,
        winner: seat,
      };
    }
    return {
      players: ckClonePlayers(state.players),
      board,
      turn: opponent,
      mustCaptureFrom: null,
      lastMove,
      finished: false,
      winner: null,
    };
  },

  viewFor(state: CheckersState, seat: number): CheckersView {
    const yourMoves =
      !state.finished && seat === state.turn ? checkersLegalMoves(state.board, seat, state.mustCaptureFrom) : [];
    return {
      board: [...state.board],
      turn: state.turn,
      mustCaptureFrom: state.mustCaptureFrom,
      yourMoves,
      counts: ckCounts(state.board),
      lastMove: state.lastMove ? { ...state.lastMove } : null,
      finished: state.finished,
      winner: state.winner,
      players: ckClonePlayers(state.players),
    };
  },

  parseAction(raw: unknown): CheckersAction | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (r.type !== "move") return null;
    if (
      typeof r.from !== "number" ||
      typeof r.to !== "number" ||
      !Number.isInteger(r.from) ||
      !Number.isInteger(r.to) ||
      r.from < 0 ||
      r.from >= CK_CELLS ||
      r.to < 0 ||
      r.to >= CK_CELLS
    ) {
      return null;
    }
    return { type: "move", from: r.from, to: r.to };
  },

  phaseOf(state: CheckersState): string {
    return state.finished ? "finished" : "playing";
  },

  isFinished(state: CheckersState): boolean {
    return state.finished;
  },

  onPlayerLeft(state: CheckersState, seat: number): CheckersState {
    if (state.finished) {
      return {
        ...state,
        players: ckClonePlayers(state.players),
        board: [...state.board],
        lastMove: state.lastMove ? { ...state.lastMove } : null,
      };
    }
    return {
      players: ckClonePlayers(state.players),
      board: [...state.board],
      turn: state.turn,
      mustCaptureFrom: state.mustCaptureFrom,
      lastMove: state.lastMove ? { ...state.lastMove } : null,
      finished: true,
      winner: seat === 0 ? 1 : 0,
    };
  },

  cpuAction(state: CheckersState, seat: number, rng: Rng): CheckersAction | null {
    if (state.finished || seat !== state.turn) return null;
    const legal = checkersLegalMoves(state.board, seat, state.mustCaptureFrom);
    if (legal.length === 0) return null;
    let best: CheckersMove = legal[0];
    let bestScore = -Infinity;
    for (const move of legal) {
      let score = 0;
      // 取り手を最優先（キング取りはさらに加点）。強制取り時は全手が取り手なので差別化に効く。
      if (move.captured !== null) {
        score += 100 + (checkersIsKing(state.board[move.captured]) ? 30 : 10);
        // 連続取りが続く手は追加で加点。
        if (!move.promote) {
          const sim = ckApplyMove(state.board, move);
          if (ckPieceMoves(sim, move.to).captures.length > 0) score += 60;
        }
      }
      if (move.promote) score += 50;
      // 適用後の自他マテリアル差。
      const after = ckApplyMove(state.board, move);
      let material = 0;
      for (const v of after) {
        const owner = checkersOwnerOf(v);
        if (owner < 0) continue;
        const value = checkersIsKing(v) ? 30 : 10;
        material += owner === seat ? value : -value;
      }
      score += material;
      // 前進と中央寄せの微加点（通常コマのみ前進を評価）。
      const value = state.board[move.from];
      if (!checkersIsKing(value)) {
        const progress = seat === 0 ? CK_SIZE - 1 - ckRow(move.to) : ckRow(move.to);
        score += progress * 0.6;
      }
      score -= Math.abs(ckCol(move.to) - 3.5) * 0.2;
      // 取った直後に取り返される手は軽く減点。
      if (move.captured !== null) {
        const oppCaptures = checkersLegalMoves(after, 1 - seat, null).filter((m) => m.captured !== null);
        if (oppCaptures.some((m) => m.captured === move.to)) score -= 25;
      }
      if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && rng() < 0.4)) {
        best = move;
        bestScore = score;
      }
    }
    return { type: "move", from: best.from, to: best.to };
  },
};
