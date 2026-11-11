// 三目並べ（○×ゲーム）のルールモジュール。3×3、先手○・後手×。
// マス: 0=空, 1=seat0, 2=seat1。index = row*3+col。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export type TictactoeState = {
  players: SeatInfo[];
  board: number[];
  turn: number;
  winCells: number[];
  finished: boolean;
  winner: number | "draw" | null;
};

export type TictactoeAction = { type: "place"; index: number };

export type TictactoeView = {
  board: number[];
  turn: number;
  winCells: number[];
  finished: boolean;
  winner: number | "draw" | null;
  players: SeatInfo[];
};

const TTT_LINES: ReadonlyArray<readonly number[]> = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

function tttClonePlayers(players: SeatInfo[]): SeatInfo[] {
  return players.map((p) => ({ seat: p.seat, name: p.name }));
}

function tttFindWin(board: number[], stone: number): number[] | null {
  for (const line of TTT_LINES) {
    if (line.every((i) => board[i] === stone)) return [...line];
  }
  return null;
}

function tttWinner(board: number[]): number | "draw" | null {
  for (const seat of [0, 1] as const) {
    if (tttFindWin(board, seat + 1)) return seat;
  }
  if (board.every((v) => v !== 0)) return "draw";
  return null;
}

// minimax: seat 視点の評価（勝ち +10-深さ, 負け 深さ-10, 引き分け 0）。
// 早く勝ち、遅く負ける手を好む。
function tttMinimax(board: number[], turnSeat: number, cpuSeat: number, depth: number): number {
  const winner = tttWinner(board);
  if (winner === cpuSeat) return 10 - depth;
  if (winner === "draw") return 0;
  if (winner !== null) return depth - 10;
  const maximizing = turnSeat === cpuSeat;
  let best = maximizing ? -Infinity : Infinity;
  for (let i = 0; i < 9; i++) {
    if (board[i] !== 0) continue;
    board[i] = turnSeat + 1;
    const score = tttMinimax(board, 1 - turnSeat, cpuSeat, depth + 1);
    board[i] = 0;
    best = maximizing ? Math.max(best, score) : Math.min(best, score);
  }
  return best;
}

export const gameModule: OnlineGameModule<TictactoeState, TictactoeAction, TictactoeView> = {
  id: "tictactoe",
  title: "三目並べ",
  minPlayers: 2,
  maxPlayers: 2,
  cpuSupported: true,
  chatEnabled: true,

  createState(players: SeatInfo[], _rng: Rng, _options: Record<string, unknown>): TictactoeState {
    if (!Array.isArray(players) || players.length !== 2) {
      throw new Error("三目並べは2人専用です");
    }
    return {
      players: tttClonePlayers(players),
      board: new Array<number>(9).fill(0),
      turn: 0,
      winCells: [],
      finished: false,
      winner: null,
    };
  },

  applyAction(state: TictactoeState, seat: number, action: TictactoeAction, _rng: Rng): TictactoeState {
    if (state.finished) throw new Error("対局は終了しています");
    if (seat !== state.turn) throw new Error("あなたの手番ではありません");
    if (!action || typeof action !== "object" || action.type !== "place") {
      throw new Error("不明なアクションです");
    }
    const index = action.index;
    if (!Number.isInteger(index) || index < 0 || index >= 9) {
      throw new Error("マスが範囲外です");
    }
    if (state.board[index] !== 0) throw new Error("そのマスには既に印があります");
    const board = [...state.board];
    board[index] = seat + 1;
    const win = tttFindWin(board, seat + 1);
    if (win) {
      return {
        players: tttClonePlayers(state.players),
        board,
        turn: state.turn,
        winCells: win,
        finished: true,
        winner: seat,
      };
    }
    if (board.every((v) => v !== 0)) {
      return {
        players: tttClonePlayers(state.players),
        board,
        turn: state.turn,
        winCells: [],
        finished: true,
        winner: "draw",
      };
    }
    return {
      players: tttClonePlayers(state.players),
      board,
      turn: 1 - seat,
      winCells: [],
      finished: false,
      winner: null,
    };
  },

  viewFor(state: TictactoeState, _seat: number): TictactoeView {
    return {
      board: [...state.board],
      turn: state.turn,
      winCells: [...state.winCells],
      finished: state.finished,
      winner: state.winner,
      players: tttClonePlayers(state.players),
    };
  },

  parseAction(raw: unknown): TictactoeAction | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (r.type !== "place") return null;
    if (typeof r.index !== "number" || !Number.isInteger(r.index) || r.index < 0 || r.index >= 9) {
      return null;
    }
    return { type: "place", index: r.index };
  },

  phaseOf(state: TictactoeState): string {
    return state.finished ? "finished" : "playing";
  },

  isFinished(state: TictactoeState): boolean {
    return state.finished;
  },

  onPlayerLeft(state: TictactoeState, seat: number): TictactoeState {
    if (state.finished) {
      return { ...state, players: tttClonePlayers(state.players), board: [...state.board], winCells: [...state.winCells] };
    }
    return {
      players: tttClonePlayers(state.players),
      board: [...state.board],
      turn: state.turn,
      winCells: [...state.winCells],
      finished: true,
      winner: seat === 0 ? 1 : 0,
    };
  },

  cpuAction(state: TictactoeState, seat: number, rng: Rng): TictactoeAction | null {
    if (state.finished || seat !== state.turn) return null;
    const empties: number[] = [];
    for (let i = 0; i < 9; i++) if (state.board[i] === 0) empties.push(i);
    if (empties.length === 0) return null;
    // 全探索（minimax）で最善手を集め、同点なら rng で選ぶ。負ける手は選ばない。
    let bestScore = -Infinity;
    let bestMoves: number[] = [];
    for (const index of empties) {
      const board = [...state.board];
      board[index] = seat + 1;
      const score = tttMinimax(board, 1 - seat, seat, 1);
      if (score > bestScore + 1e-9) {
        bestScore = score;
        bestMoves = [index];
      } else if (Math.abs(score - bestScore) <= 1e-9) {
        bestMoves.push(index);
      }
    }
    const pick = bestMoves[Math.floor(rng() * bestMoves.length)] ?? bestMoves[0];
    return { type: "place", index: pick };
  },
};
