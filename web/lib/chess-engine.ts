// チェス CPU の探索エンジン（純粋ロジック）。着手生成は lib/chess-perft.ts、
// 評価は駒価値＋配置テーブル（PST）の単純な静的評価、探索は αβ 法。
// Web Worker（lib/workers-src/chess-cpu.worker.entry.js）から使われる前提で、
// ブラウザ・Node テストのどちらからでも呼べる形にしてある。
import {
  WHITE,
  applyMove,
  generateLegalMoves,
  isInCheck,
  type Position,
} from "./chess-perft";

const MATE_SCORE = 100_000;
const PIECE_VALUES = [0, 100, 320, 330, 500, 900, 0]; // index = 駒種 (1=P..6=K)

// 配置テーブルは 8 ランク目→1 ランク目の順（公開されている古典的な値）。
const PST: Record<number, number[]> = {
  1: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  2: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  3: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  4: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0,
  ],
  5: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  6: [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20,
  ],
};

/** 静的評価（センチポーン、白が有利なら正）。 */
export function evaluatePosition(pos: Position): number {
  let score = 0;
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) continue;
    const piece = pos.board[sq];
    if (piece === 0) continue;
    const type = piece & 7;
    const file = sq & 7;
    const rank = sq >> 4; // 0 = 1 ランク目
    if (piece <= 6) {
      score += PIECE_VALUES[type] + PST[type][(7 - rank) * 8 + file];
    } else {
      score -= PIECE_VALUES[type] + PST[type][rank * 8 + file];
    }
  }
  return score;
}

function evaluateForSideToMove(pos: Position): number {
  const whiteScore = evaluatePosition(pos);
  return pos.side === WHITE ? whiteScore : -whiteScore;
}

function clonePosition(pos: Position): Position {
  return { board: pos.board.slice(), side: pos.side, castling: pos.castling, ep: pos.ep };
}

type SearchContext = {
  nodes: number;
  maxNodes: number;
};

/** 取る手は「取られる駒の価値が高い順」に並べ替えると αβ が効く。 */
function orderedMoves(pos: Position, moves: { move: number; uci: string }[]): { move: number; uci: string }[] {
  const scored = moves.map((entry) => {
    const to = (entry.move >> 7) & 0x7f;
    const victim = pos.board[to];
    const attacker = pos.board[entry.move & 0x7f] & 7;
    let score = 0;
    if (victim !== 0) score = 10 * PIECE_VALUES[victim & 7] - PIECE_VALUES[attacker];
    else if (entry.move & (1 << 19)) score = 10 * PIECE_VALUES[1] - PIECE_VALUES[attacker]; // アンパッサン
    if (((entry.move >> 14) & 0x7) !== 0) score += 900; // 昇格は優先
    return { entry, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ entry }) => entry);
}

function negamax(pos: Position, depth: number, alpha: number, beta: number, ply: number, ctx: SearchContext): number {
  ctx.nodes += 1;
  const moves = generateLegalMoves(pos);
  if (moves.length === 0) {
    return isInCheck(pos, pos.side) ? -MATE_SCORE + ply : 0;
  }
  if (depth === 0 || ctx.nodes > ctx.maxNodes) {
    return evaluateForSideToMove(pos);
  }
  let best = -Infinity;
  for (const { move } of orderedMoves(pos, moves)) {
    const child = clonePosition(pos);
    applyMove(child, move);
    const score = -negamax(child, depth - 1, -beta, -alpha, ply + 1, ctx);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

export type BestMoveResult = {
  move: number;
  uci: string;
  /** 手番側から見た評価値（センチポーン）。 */
  score: number;
  depth: number;
  nodes: number;
};

export type FindBestMoveOptions = {
  depth: number;
  /** この範囲内（センチポーン）の手からランダムに選ぶ。0 なら最善手のみ。 */
  jitterCp?: number;
  maxNodes?: number;
  rng?: () => number;
};

/** 最善手（または jitter 範内の候補からランダムな手）を返す。合法手が無い場合は null。 */
export function findBestMove(pos: Position, options: FindBestMoveOptions): BestMoveResult | null {
  const moves = generateLegalMoves(pos);
  if (moves.length === 0) return null;
  const depth = Math.max(1, Math.trunc(options.depth));
  const ctx: SearchContext = { nodes: 0, maxNodes: options.maxNodes ?? 800_000 };
  const scored: { move: number; uci: string; score: number }[] = [];
  let alpha = -Infinity;
  for (const entry of orderedMoves(pos, moves)) {
    const child = clonePosition(pos);
    applyMove(child, entry.move);
    const score = -negamax(child, depth - 1, -Infinity, -alpha, 1, ctx);
    scored.push({ move: entry.move, uci: entry.uci, score });
    if (score > alpha) alpha = score;
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const jitter = options.jitterCp ?? 0;
  let chosen = best;
  if (jitter > 0) {
    const candidates = scored.filter((entry) => entry.score >= best.score - jitter);
    if (candidates.length > 1) {
      const rng = options.rng ?? Math.random;
      chosen = candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))];
    }
  }
  return { move: chosen.move, uci: chosen.uci, score: chosen.score, depth, nodes: ctx.nodes };
}
