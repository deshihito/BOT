// リバーシ（オセロ）のルールモジュール。8×8、標準初期配置。
// 石: 0=空, 1=seat0, 2=seat1。index = row*8+col。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export type ReversiState = {
  players: SeatInfo[];
  board: number[];
  turn: number;
  lastMove: number | null;
  lastPass: boolean;
  finished: boolean;
  winner: number | "draw" | null;
};

export type ReversiAction = { type: "place"; index: number } | { type: "pass" };

export type ReversiView = {
  board: number[];
  turn: number;
  yourLegalMoves: number[];
  counts: [number, number];
  lastMove: number | null;
  lastPass: boolean;
  finished: boolean;
  winner: number | "draw" | null;
  players: SeatInfo[];
};

const REV_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
];

const REV_CORNERS = [0, 7, 56, 63];

// 隅に隣接するマス（隅が空いている間は危険）。
const REV_CORNER_NEIGHBORS: Record<number, number[]> = {
  0: [1, 8, 9],
  7: [6, 14, 15],
  56: [48, 49, 57],
  63: [54, 55, 62],
};
// 特に危険なXマス（隅の斜め隣）。
const REV_X_SQUARES = new Set([9, 14, 49, 54]);

function revFlips(board: number[], index: number, stone: number): number[] {
  if (board[index] !== 0) return [];
  const opp = stone === 1 ? 2 : 1;
  const row = Math.floor(index / 8);
  const col = index % 8;
  const flips: number[] = [];
  for (const [dr, dc] of REV_DIRS) {
    const line: number[] = [];
    let r = row + dr;
    let c = col + dc;
    while (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r * 8 + c] === opp) {
      line.push(r * 8 + c);
      r += dr;
      c += dc;
    }
    if (line.length > 0 && r >= 0 && r < 8 && c >= 0 && c < 8 && board[r * 8 + c] === stone) {
      flips.push(...line);
    }
  }
  return flips;
}

function revLegalMoves(board: number[], seat: number): number[] {
  const stone = seat + 1;
  const moves: number[] = [];
  for (let i = 0; i < 64; i++) {
    if (board[i] === 0 && revFlips(board, i, stone).length > 0) moves.push(i);
  }
  return moves;
}

function revCounts(board: number[]): [number, number] {
  let n0 = 0;
  let n1 = 0;
  for (const v of board) {
    if (v === 1) n0++;
    else if (v === 2) n1++;
  }
  return [n0, n1];
}

function revWinnerByCounts(board: number[]): number | "draw" {
  const [n0, n1] = revCounts(board);
  if (n0 === n1) return "draw";
  return n0 > n1 ? 0 : 1;
}

function revClonePlayers(players: SeatInfo[]): SeatInfo[] {
  return players.map((p) => ({ seat: p.seat, name: p.name }));
}

function revCpuScore(state: ReversiState, seat: number, index: number, flips: number[]): number {
  const stone = seat + 1;
  const board = [...state.board];
  board[index] = stone;
  for (const f of flips) board[f] = stone;
  let score = flips.length * 2;
  if (REV_CORNERS.includes(index)) score += 120;
  // 隅が空いている間、その隣接マスは減点（Xマスはより大きく）。
  for (const corner of REV_CORNERS) {
    if (state.board[corner] === 0 && REV_CORNER_NEIGHBORS[corner].includes(index)) {
      score -= REV_X_SQUARES.has(index) ? 45 : 30;
    }
  }
  // 相手の合法手数を減らす手を加点、自分の次手の選択肢も軽く評価。
  const oppMoves = revLegalMoves(board, 1 - seat).length;
  const myMoves = revLegalMoves(board, seat).length;
  score -= oppMoves * 6;
  score += myMoves * 1.5;
  // 辺のマスは軽く加点。
  const row = Math.floor(index / 8);
  const col = index % 8;
  if (row === 0 || row === 7 || col === 0 || col === 7) score += 6;
  return score;
}

export const gameModule: OnlineGameModule<ReversiState, ReversiAction, ReversiView> = {
  id: "reversi",
  title: "リバーシ",
  minPlayers: 2,
  maxPlayers: 2,
  cpuSupported: true,
  chatEnabled: true,

  createState(players: SeatInfo[], _rng: Rng, _options: Record<string, unknown>): ReversiState {
    if (!Array.isArray(players) || players.length !== 2) {
      throw new Error("リバーシは2人専用です");
    }
    const board = new Array<number>(64).fill(0);
    board[27] = 2;
    board[28] = 1;
    board[35] = 1;
    board[36] = 2;
    return {
      players: revClonePlayers(players),
      board,
      turn: 0,
      lastMove: null,
      lastPass: false,
      finished: false,
      winner: null,
    };
  },

  applyAction(state: ReversiState, seat: number, action: ReversiAction, _rng: Rng): ReversiState {
    if (state.finished) throw new Error("対局は終了しています");
    if (seat !== state.turn) throw new Error("あなたの手番ではありません");
    if (!action || typeof action !== "object") throw new Error("不明なアクションです");
    const stone = seat + 1;
    const opponent = 1 - seat;

    if (action.type === "pass") {
      if (revLegalMoves(state.board, seat).length > 0) {
        throw new Error("置けるマスがあるのでパスできません");
      }
      if (revLegalMoves(state.board, opponent).length === 0) {
        return {
          players: revClonePlayers(state.players),
          board: [...state.board],
          turn: state.turn,
          lastMove: null,
          lastPass: false,
          finished: true,
          winner: revWinnerByCounts(state.board),
        };
      }
      return {
        players: revClonePlayers(state.players),
        board: [...state.board],
        turn: opponent,
        lastMove: null,
        lastPass: true,
        finished: false,
        winner: null,
      };
    }

    if (action.type === "place") {
      const index = action.index;
      if (!Number.isInteger(index) || index < 0 || index >= 64) {
        throw new Error("マスが範囲外です");
      }
      if (state.board[index] !== 0) throw new Error("そのマスには既に石があります");
      const flips = revFlips(state.board, index, stone);
      if (flips.length === 0) throw new Error("そこには置けません（挟める石がありません）");
      const board = [...state.board];
      board[index] = stone;
      for (const f of flips) board[f] = stone;

      if (revLegalMoves(board, opponent).length > 0) {
        return {
          players: revClonePlayers(state.players),
          board,
          turn: opponent,
          lastMove: index,
          lastPass: false,
          finished: false,
          winner: null,
        };
      }
      if (revLegalMoves(board, seat).length > 0) {
        // 相手はパス。手番は自分に戻る。
        return {
          players: revClonePlayers(state.players),
          board,
          turn: seat,
          lastMove: index,
          lastPass: true,
          finished: false,
          winner: null,
        };
      }
      return {
        players: revClonePlayers(state.players),
        board,
        turn: seat,
        lastMove: index,
        lastPass: false,
        finished: true,
        winner: revWinnerByCounts(board),
      };
    }

    throw new Error("不明なアクションです");
  },

  viewFor(state: ReversiState, seat: number): ReversiView {
    const yourLegalMoves =
      !state.finished && seat === state.turn ? revLegalMoves(state.board, seat) : [];
    return {
      board: [...state.board],
      turn: state.turn,
      yourLegalMoves,
      counts: revCounts(state.board),
      lastMove: state.lastMove,
      lastPass: state.lastPass,
      finished: state.finished,
      winner: state.winner,
      players: revClonePlayers(state.players),
    };
  },

  parseAction(raw: unknown): ReversiAction | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (r.type === "pass") return { type: "pass" };
    if (r.type === "place") {
      if (typeof r.index !== "number" || !Number.isInteger(r.index) || r.index < 0 || r.index >= 64) {
        return null;
      }
      return { type: "place", index: r.index };
    }
    return null;
  },

  phaseOf(state: ReversiState): string {
    return state.finished ? "finished" : "playing";
  },

  isFinished(state: ReversiState): boolean {
    return state.finished;
  },

  onPlayerLeft(state: ReversiState, seat: number): ReversiState {
    if (state.finished) {
      return { ...state, players: revClonePlayers(state.players), board: [...state.board] };
    }
    const winner = seat === 0 ? 1 : 0;
    return {
      players: revClonePlayers(state.players),
      board: [...state.board],
      turn: state.turn,
      lastMove: state.lastMove,
      lastPass: false,
      finished: true,
      winner,
    };
  },

  cpuAction(state: ReversiState, seat: number, rng: Rng): ReversiAction | null {
    if (state.finished) return null;
    const moves = revLegalMoves(state.board, seat);
    if (moves.length === 0) return { type: "pass" };
    let best: number = moves[0];
    let bestScore = -Infinity;
    for (const index of moves) {
      const flips = revFlips(state.board, index, seat + 1);
      const score = revCpuScore(state, seat, index, flips);
      if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && rng() < 0.5)) {
        best = index;
        bestScore = score;
      }
    }
    return { type: "place", index: best };
  },
};
