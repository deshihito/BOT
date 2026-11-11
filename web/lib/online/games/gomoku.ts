// 五目並べのルールモジュール。15×15、禁じ手なし、長連も勝ち。
// 石: 0=空, 1=seat0, 2=seat1。index = row*15+col。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export type GomokuState = {
  players: SeatInfo[];
  board: number[];
  turn: number;
  lastMove: number | null;
  winCells: number[];
  finished: boolean;
  winner: number | "draw" | null;
};

export type GomokuAction = { type: "place"; index: number };

export type GomokuView = {
  board: number[];
  turn: number;
  lastMove: number | null;
  winCells: number[];
  finished: boolean;
  winner: number | "draw" | null;
  players: SeatInfo[];
};

const GOM_SIZE = 15;
const GOM_CELLS = GOM_SIZE * GOM_SIZE;
const GOM_DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

function gomClonePlayers(players: SeatInfo[]): SeatInfo[] {
  return players.map((p) => ({ seat: p.seat, name: p.name }));
}

function gomInBoard(r: number, c: number): boolean {
  return r >= 0 && r < GOM_SIZE && c >= 0 && c < GOM_SIZE;
}

// lastMove を通るラインで並んだ全マス（勝ちなら）を返す。勝ちでなければ null。
function gomWinThrough(board: number[], index: number, stone: number): number[] | null {
  const row = Math.floor(index / GOM_SIZE);
  const col = index % GOM_SIZE;
  const all = new Set<number>();
  let won = false;
  for (const [dr, dc] of GOM_DIRS) {
    const line: number[] = [index];
    let r = row + dr;
    let c = col + dc;
    while (gomInBoard(r, c) && board[r * GOM_SIZE + c] === stone) {
      line.push(r * GOM_SIZE + c);
      r += dr;
      c += dc;
    }
    r = row - dr;
    c = col - dc;
    while (gomInBoard(r, c) && board[r * GOM_SIZE + c] === stone) {
      line.push(r * GOM_SIZE + c);
      r -= dr;
      c -= dc;
    }
    if (line.length >= 5) {
      won = true;
      for (const cell of line) all.add(cell);
    }
  }
  if (!won) return null;
  return [...all].sort((a, b) => a - b);
}

// 空きマス index に stone を置いたと仮定したとき、その方向の連続数と両端の空き。
function gomLineInfo(
  board: number[],
  index: number,
  stone: number,
  dr: number,
  dc: number,
): { count: number; openEnds: number } {
  const row = Math.floor(index / GOM_SIZE);
  const col = index % GOM_SIZE;
  let count = 1;
  let openEnds = 0;
  let r = row + dr;
  let c = col + dc;
  while (gomInBoard(r, c) && board[r * GOM_SIZE + c] === stone) {
    count++;
    r += dr;
    c += dc;
  }
  if (gomInBoard(r, c) && board[r * GOM_SIZE + c] === 0) openEnds++;
  r = row - dr;
  c = col - dc;
  while (gomInBoard(r, c) && board[r * GOM_SIZE + c] === stone) {
    count++;
    r -= dr;
    c -= dc;
  }
  if (gomInBoard(r, c) && board[r * GOM_SIZE + c] === 0) openEnds++;
  return { count, openEnds };
}

function gomWouldWin(board: number[], index: number, stone: number): boolean {
  for (const [dr, dc] of GOM_DIRS) {
    if (gomLineInfo(board, index, stone, dr, dc).count >= 5) return true;
  }
  return false;
}

// 既存の石から2マス以内にある空きマス候補。
function gomCandidates(board: number[]): number[] {
  const set = new Set<number>();
  let hasStone = false;
  for (let i = 0; i < GOM_CELLS; i++) {
    if (board[i] === 0) continue;
    hasStone = true;
    const row = Math.floor(i / GOM_SIZE);
    const col = i % GOM_SIZE;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const r = row + dr;
        const c = col + dc;
        if (!gomInBoard(r, c)) continue;
        const idx = r * GOM_SIZE + c;
        if (board[idx] === 0) set.add(idx);
      }
    }
  }
  if (!hasStone) return [112]; // 中央（7,7）
  return [...set].sort((a, b) => a - b);
}

// ライン評価: 連続数と開放度からスコア化する。
function gomDirScore(count: number, openEnds: number): number {
  if (count >= 5) return 1000000;
  if (count === 4) return openEnds === 2 ? 100000 : openEnds === 1 ? 10000 : 0;
  if (count === 3) return openEnds === 2 ? 5000 : openEnds === 1 ? 500 : 0;
  if (count === 2) return openEnds === 2 ? 200 : openEnds === 1 ? 40 : 0;
  if (count === 1) return openEnds === 2 ? 8 : 2;
  return 0;
}

function gomCellScore(board: number[], index: number, seat: number): number {
  const myStone = seat + 1;
  const oppStone = (1 - seat) + 1;
  let score = 0;
  for (const [dr, dc] of GOM_DIRS) {
    const mine = gomLineInfo(board, index, myStone, dr, dc);
    score += gomDirScore(mine.count, mine.openEnds);
    const theirs = gomLineInfo(board, index, oppStone, dr, dc);
    score += gomDirScore(theirs.count, theirs.openEnds) * 0.9;
  }
  // 中央寄せの微加点。
  const row = Math.floor(index / GOM_SIZE);
  const col = index % GOM_SIZE;
  score -= (Math.abs(row - 7) + Math.abs(col - 7)) * 0.1;
  return score;
}

function gomPickBest(
  board: number[],
  candidates: number[],
  seat: number,
  rng: Rng,
): number {
  let best = candidates[0];
  let bestScore = -Infinity;
  for (const index of candidates) {
    const score = gomCellScore(board, index, seat);
    if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && rng() < 0.3)) {
      best = index;
      bestScore = score;
    }
  }
  return best;
}

export const gameModule: OnlineGameModule<GomokuState, GomokuAction, GomokuView> = {
  id: "gomoku",
  title: "五目並べ",
  minPlayers: 2,
  maxPlayers: 2,
  cpuSupported: true,
  chatEnabled: true,

  createState(players: SeatInfo[], _rng: Rng, _options: Record<string, unknown>): GomokuState {
    if (!Array.isArray(players) || players.length !== 2) {
      throw new Error("五目並べは2人専用です");
    }
    return {
      players: gomClonePlayers(players),
      board: new Array<number>(GOM_CELLS).fill(0),
      turn: 0,
      lastMove: null,
      winCells: [],
      finished: false,
      winner: null,
    };
  },

  applyAction(state: GomokuState, seat: number, action: GomokuAction, _rng: Rng): GomokuState {
    if (state.finished) throw new Error("対局は終了しています");
    if (seat !== state.turn) throw new Error("あなたの手番ではありません");
    if (!action || typeof action !== "object" || action.type !== "place") {
      throw new Error("不明なアクションです");
    }
    const index = action.index;
    if (!Number.isInteger(index) || index < 0 || index >= GOM_CELLS) {
      throw new Error("マスが範囲外です");
    }
    if (state.board[index] !== 0) throw new Error("そのマスには既に石があります");
    const stone = seat + 1;
    const board = [...state.board];
    board[index] = stone;
    const win = gomWinThrough(board, index, stone);
    if (win) {
      return {
        players: gomClonePlayers(state.players),
        board,
        turn: state.turn,
        lastMove: index,
        winCells: win,
        finished: true,
        winner: seat,
      };
    }
    if (board.every((v) => v !== 0)) {
      return {
        players: gomClonePlayers(state.players),
        board,
        turn: state.turn,
        lastMove: index,
        winCells: [],
        finished: true,
        winner: "draw",
      };
    }
    return {
      players: gomClonePlayers(state.players),
      board,
      turn: 1 - seat,
      lastMove: index,
      winCells: [],
      finished: false,
      winner: null,
    };
  },

  viewFor(state: GomokuState, _seat: number): GomokuView {
    return {
      board: [...state.board],
      turn: state.turn,
      lastMove: state.lastMove,
      winCells: [...state.winCells],
      finished: state.finished,
      winner: state.winner,
      players: gomClonePlayers(state.players),
    };
  },

  parseAction(raw: unknown): GomokuAction | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (r.type !== "place") return null;
    if (typeof r.index !== "number" || !Number.isInteger(r.index) || r.index < 0 || r.index >= GOM_CELLS) {
      return null;
    }
    return { type: "place", index: r.index };
  },

  phaseOf(state: GomokuState): string {
    return state.finished ? "finished" : "playing";
  },

  isFinished(state: GomokuState): boolean {
    return state.finished;
  },

  onPlayerLeft(state: GomokuState, seat: number): GomokuState {
    if (state.finished) {
      return {
        ...state,
        players: gomClonePlayers(state.players),
        board: [...state.board],
        winCells: [...state.winCells],
      };
    }
    return {
      players: gomClonePlayers(state.players),
      board: [...state.board],
      turn: state.turn,
      lastMove: state.lastMove,
      winCells: [...state.winCells],
      finished: true,
      winner: seat === 0 ? 1 : 0,
    };
  },

  cpuAction(state: GomokuState, seat: number, _rng: Rng): GomokuAction | null {
    if (state.finished) return null;
    const rng = _rng;
    const myStone = seat + 1;
    const oppStone = (1 - seat) + 1;
    const candidates = gomCandidates(state.board);
    if (candidates.length === 0) return null;
    if (candidates.length === 1 && state.board.every((v) => v === 0)) {
      return { type: "place", index: candidates[0] };
    }

    // 1. 自分の勝ち手（あと1つで5つ）。
    const wins = candidates.filter((i) => gomWouldWin(state.board, i, myStone));
    if (wins.length > 0) return { type: "place", index: gomPickBest(state.board, wins, seat, rng) };

    // 2. 相手の勝ち阻止手。
    const blocks = candidates.filter((i) => gomWouldWin(state.board, i, oppStone));
    if (blocks.length > 0) return { type: "place", index: gomPickBest(state.board, blocks, seat, rng) };

    // 3a. 自分の4作り（オープン4を優先）。
    const makeFourOpen: number[] = [];
    const makeFour: number[] = [];
    for (const i of candidates) {
      for (const [dr, dc] of GOM_DIRS) {
        const info = gomLineInfo(state.board, i, myStone, dr, dc);
        if (info.count === 4) {
          makeFour.push(i);
          if (info.openEnds === 2) makeFourOpen.push(i);
          break;
        }
      }
    }
    if (makeFourOpen.length > 0) return { type: "place", index: gomPickBest(state.board, makeFourOpen, seat, rng) };
    if (makeFour.length > 0) return { type: "place", index: gomPickBest(state.board, makeFour, seat, rng) };

    // 3b. 相手の3（オープン3）の阻止: 相手がそこに置くと4になるマス＝相手の3の延長。
    //     両端が開いた4になるもの（オープン4化）を最優先で止める。
    const oppFourOpen: number[] = [];
    const oppFour: number[] = [];
    for (const i of candidates) {
      for (const [dr, dc] of GOM_DIRS) {
        const info = gomLineInfo(state.board, i, oppStone, dr, dc);
        if (info.count === 4) {
          oppFour.push(i);
          if (info.openEnds === 2) oppFourOpen.push(i);
          break;
        }
      }
    }
    if (oppFourOpen.length > 0) return { type: "place", index: gomPickBest(state.board, oppFourOpen, seat, rng) };
    if (oppFour.length > 0) return { type: "place", index: gomPickBest(state.board, oppFour, seat, rng) };

    // 4. ライン評価が最大のマス。
    return { type: "place", index: gomPickBest(state.board, candidates, seat, rng) };
  },
};
