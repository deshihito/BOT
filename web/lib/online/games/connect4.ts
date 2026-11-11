// 四目並べ（コネクト4）のルールモジュール。6行×7列、重力落下。
// 石: 0=空, 1=seat0, 2=seat1。index = row*7+col、row0=最上段。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export type Connect4State = {
  players: SeatInfo[];
  board: number[];
  turn: number;
  lastMove: number | null;
  winCells: number[];
  finished: boolean;
  winner: number | "draw" | null;
};

export type Connect4Action = { type: "drop"; col: number };

export type Connect4View = {
  board: number[];
  turn: number;
  lastMove: number | null;
  winCells: number[];
  finished: boolean;
  winner: number | "draw" | null;
  players: SeatInfo[];
};

const C4_ROWS = 6;
const C4_COLS = 7;
const C4_DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

function c4ClonePlayers(players: SeatInfo[]): SeatInfo[] {
  return players.map((p) => ({ seat: p.seat, name: p.name }));
}

function c4DropIndex(board: number[], col: number): number | null {
  for (let row = C4_ROWS - 1; row >= 0; row--) {
    const idx = row * C4_COLS + col;
    if (board[idx] === 0) return idx;
  }
  return null;
}

function c4LegalCols(board: number[]): number[] {
  const cols: number[] = [];
  for (let col = 0; col < C4_COLS; col++) {
    if (c4DropIndex(board, col) !== null) cols.push(col);
  }
  return cols;
}

function c4FindWin(board: number[], stone: number): number[] | null {
  for (let row = 0; row < C4_ROWS; row++) {
    for (let col = 0; col < C4_COLS; col++) {
      if (board[row * C4_COLS + col] !== stone) continue;
      for (const [dr, dc] of C4_DIRS) {
        const cells: number[] = [];
        for (let k = 0; k < 4; k++) {
          const r = row + dr * k;
          const c = col + dc * k;
          if (r < 0 || r >= C4_ROWS || c < 0 || c >= C4_COLS) break;
          if (board[r * C4_COLS + c] !== stone) break;
          cells.push(r * C4_COLS + c);
        }
        if (cells.length === 4) return cells;
      }
    }
  }
  return null;
}

// 指定列に石を落とした新しい盤面を返す（満杯なら null）。
function c4Simulate(board: number[], col: number, stone: number): number[] | null {
  const idx = c4DropIndex(board, col);
  if (idx === null) return null;
  const next = [...board];
  next[idx] = stone;
  return next;
}

export const gameModule: OnlineGameModule<Connect4State, Connect4Action, Connect4View> = {
  id: "connect4",
  title: "四目並べ",
  minPlayers: 2,
  maxPlayers: 2,
  cpuSupported: true,
  chatEnabled: true,

  createState(players: SeatInfo[], _rng: Rng, _options: Record<string, unknown>): Connect4State {
    if (!Array.isArray(players) || players.length !== 2) {
      throw new Error("四目並べは2人専用です");
    }
    return {
      players: c4ClonePlayers(players),
      board: new Array<number>(42).fill(0),
      turn: 0,
      lastMove: null,
      winCells: [],
      finished: false,
      winner: null,
    };
  },

  applyAction(state: Connect4State, seat: number, action: Connect4Action, _rng: Rng): Connect4State {
    if (state.finished) throw new Error("対局は終了しています");
    if (seat !== state.turn) throw new Error("あなたの手番ではありません");
    if (!action || typeof action !== "object" || action.type !== "drop") {
      throw new Error("不明なアクションです");
    }
    const col = action.col;
    if (!Number.isInteger(col) || col < 0 || col >= C4_COLS) {
      throw new Error("列が範囲外です");
    }
    const landing = c4DropIndex(state.board, col);
    if (landing === null) throw new Error("その列は満杯です");
    const stone = seat + 1;
    const board = [...state.board];
    board[landing] = stone;
    const win = c4FindWin(board, stone);
    if (win) {
      return {
        players: c4ClonePlayers(state.players),
        board,
        turn: state.turn,
        lastMove: landing,
        winCells: win,
        finished: true,
        winner: seat,
      };
    }
    if (board.every((v) => v !== 0)) {
      return {
        players: c4ClonePlayers(state.players),
        board,
        turn: state.turn,
        lastMove: landing,
        winCells: [],
        finished: true,
        winner: "draw",
      };
    }
    return {
      players: c4ClonePlayers(state.players),
      board,
      turn: 1 - seat,
      lastMove: landing,
      winCells: [],
      finished: false,
      winner: null,
    };
  },

  viewFor(state: Connect4State, _seat: number): Connect4View {
    return {
      board: [...state.board],
      turn: state.turn,
      lastMove: state.lastMove,
      winCells: [...state.winCells],
      finished: state.finished,
      winner: state.winner,
      players: c4ClonePlayers(state.players),
    };
  },

  parseAction(raw: unknown): Connect4Action | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (r.type !== "drop") return null;
    if (typeof r.col !== "number" || !Number.isInteger(r.col) || r.col < 0 || r.col >= C4_COLS) {
      return null;
    }
    return { type: "drop", col: r.col };
  },

  phaseOf(state: Connect4State): string {
    return state.finished ? "finished" : "playing";
  },

  isFinished(state: Connect4State): boolean {
    return state.finished;
  },

  onPlayerLeft(state: Connect4State, seat: number): Connect4State {
    if (state.finished) {
      return {
        ...state,
        players: c4ClonePlayers(state.players),
        board: [...state.board],
        winCells: [...state.winCells],
      };
    }
    return {
      players: c4ClonePlayers(state.players),
      board: [...state.board],
      turn: state.turn,
      lastMove: state.lastMove,
      winCells: [...state.winCells],
      finished: true,
      winner: seat === 0 ? 1 : 0,
    };
  },

  cpuAction(state: Connect4State, seat: number, rng: Rng): Connect4Action | null {
    if (state.finished) return null;
    const legal = c4LegalCols(state.board);
    if (legal.length === 0) return null;
    const myStone = seat + 1;
    const oppStone = (1 - seat) + 1;

    // 1. 自分の勝ち手。
    for (const col of legal) {
      const sim = c4Simulate(state.board, col, myStone);
      if (sim && c4FindWin(sim, myStone)) return { type: "drop", col };
    }
    // 2. 相手の勝ち阻止手。
    for (const col of legal) {
      const sim = c4Simulate(state.board, col, oppStone);
      if (sim && c4FindWin(sim, oppStone)) return { type: "drop", col };
    }
    // 3. 相手に即勝ちを与えない列に絞る（安全な列が残る場合のみ）。
    const safe = legal.filter((col) => {
      const sim = c4Simulate(state.board, col, myStone);
      if (!sim) return false;
      const oppCols = c4LegalCols(sim);
      for (const oc of oppCols) {
        const oppSim = c4Simulate(sim, oc, oppStone);
        if (oppSim && c4FindWin(oppSim, oppStone)) return false;
      }
      return true;
    });
    const pool = safe.length > 0 ? safe : legal;
    // 4. 中央寄せ。中央からの距離が最小の列群から rng で選ぶ。
    const minDist = Math.min(...pool.map((c) => Math.abs(c - 3)));
    const centered = pool.filter((c) => Math.abs(c - 3) === minDist);
    // 中央列そのものが候補にあればそれを優先（決定的に）。
    if (centered.includes(3)) return { type: "drop", col: 3 };
    const pick = centered[Math.floor(rng() * centered.length)] ?? centered[0];
    return { type: "drop", col: pick };
  },
};
