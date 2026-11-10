// チェス対局の進行管理（純粋ロジック）。着手生成は perft で検証済みの
// lib/chess-perft.ts に委ね、ここでは状態遷移・終局判定・棋譜表記だけを持つ。
// 対局は端末内で完結し、サーバーへは何も送らない。
import {
  BLACK,
  WHITE,
  applyMove,
  generateLegalMoves,
  isInCheck,
  parseFen,
  positionToFen,
  squareName,
  type Position,
} from "./chess-perft";

export { BLACK, WHITE };

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// 着手 int のビット配置（chess-perft.ts の規約）
const MF_CAPTURE = 1 << 17;
const MF_EP = 1 << 19;
const MF_CASTLE = 1 << 20;

export type DrawReason = "stalemate" | "insufficient-material" | "threefold-repetition" | "fifty-move";

export type ChessGameState = {
  position: Position;
  /** UCI 形式の着手履歴。 */
  moves: string[];
  /** 表示用の SAN 風棋譜。 */
  sans: string[];
  halfmoveClock: number;
  fullmoveNumber: number;
  status: "playing" | "checkmate" | "draw" | "resigned";
  drawReason: DrawReason | null;
  /** 勝者（WHITE | BLACK）。引き分け・対局中は null。 */
  winner: number | null;
  /** 手番側のキングがチェックされているか。 */
  inCheck: boolean;
  /** 繰り返し局面の出現回数（キー＝FEN 先頭4フィールド）。 */
  repetitions: Record<string, number>;
};

export type LegalMove = { move: number; uci: string };

function clonePosition(pos: Position): Position {
  return { board: pos.board.slice(), side: pos.side, castling: pos.castling, ep: pos.ep };
}

export function legalMoves(state: ChessGameState): LegalMove[] {
  return generateLegalMoves(state.position);
}

export function legalMovesFrom(state: ChessGameState, from: number): LegalMove[] {
  return generateLegalMoves(state.position).filter(({ move }) => (move & 0x7f) === from);
}

/** 駒不足による引き分けか（両軍とも詰ます材料が無い）。 */
function hasInsufficientMaterial(board: Int8Array): boolean {
  const minors: { type: number; parity: number }[] = [];
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) continue;
    const piece = board[sq];
    if (piece === 0) continue;
    const type = piece & 7;
    if (type === 1 || type === 4 || type === 5) return false; // ポーン/ルーク/クイーンがあれば不成立
    if (type === 2 || type === 3) {
      minors.push({ type, parity: ((sq >> 4) + (sq & 7)) % 2 });
    }
  }
  if (minors.length <= 1) return true;
  // 全てビショップで同色マスだけなら、どちらのキングも詰まない
  return minors.every((m) => m.type === 3) && minors.every((m) => m.parity === minors[0].parity);
}

function settleStatus(state: ChessGameState): ChessGameState {
  const { position } = state;
  const inCheck = isInCheck(position, position.side);
  const legal = generateLegalMoves(position);
  if (legal.length === 0) {
    if (inCheck) {
      return { ...state, status: "checkmate", winner: position.side === WHITE ? BLACK : WHITE, inCheck };
    }
    return { ...state, status: "draw", drawReason: "stalemate", inCheck };
  }
  if (hasInsufficientMaterial(position.board)) {
    return { ...state, status: "draw", drawReason: "insufficient-material", inCheck };
  }
  if (state.halfmoveClock >= 100) {
    return { ...state, status: "draw", drawReason: "fifty-move", inCheck };
  }
  const key = positionToFen(position);
  if ((state.repetitions[key] ?? 0) >= 3) {
    return { ...state, status: "draw", drawReason: "threefold-repetition", inCheck };
  }
  return { ...state, status: "playing", inCheck };
}

/** FEN から対局を開始する（省略時は初期局面）。 */
export function createGame(fen: string = START_FEN): ChessGameState {
  const parts = fen.trim().split(/\s+/);
  const position = parseFen(fen);
  const halfmoveClock = Number.parseInt(parts[4] ?? "0", 10) || 0;
  const fullmoveNumber = Number.parseInt(parts[5] ?? "1", 10) || 1;
  const base: ChessGameState = {
    position,
    moves: [],
    sans: [],
    halfmoveClock,
    fullmoveNumber,
    status: "playing",
    drawReason: null,
    winner: null,
    inCheck: false,
    repetitions: { [positionToFen(position)]: 1 },
  };
  return settleStatus(base);
}

/** 対局の現在局面を完全な FEN で返す（Worker への受け渡し用）。 */
export function gameFen(state: ChessGameState): string {
  return `${positionToFen(state.position)} ${state.halfmoveClock} ${state.fullmoveNumber}`;
}

function moveToSan(before: ChessGameState, move: number, legalBefore: LegalMove[], after: ChessGameState): string {
  const board = before.position.board;
  const from = move & 0x7f;
  const to = (move >> 7) & 0x7f;
  const promo = (move >> 14) & 0x7;
  const piece = board[from];
  const type = piece & 7;
  const isCapture = (move & MF_CAPTURE) !== 0 || board[to] !== 0;
  let san: string;
  if (move & MF_CASTLE) {
    san = (to & 7) === 6 ? "O-O" : "O-O-O";
  } else if (type === 1) {
    const dest = squareName(to);
    san = isCapture ? `${"abcdefgh"[from & 7]}x${dest}` : dest;
    if (promo !== 0) san += `=${"nbrq"[promo - 2].toUpperCase()}`;
  } else {
    const letter = "PNBRQK"[type - 1];
    const others = legalBefore.filter(
      (entry) =>
        entry.move !== move &&
        ((entry.move >> 7) & 0x7f) === to &&
        (board[entry.move & 0x7f] & 7) === type,
    );
    let disambiguation = "";
    if (others.length > 0) {
      const sameFile = others.some((entry) => (entry.move & 7) === (from & 7));
      const sameRank = others.some((entry) => ((entry.move >> 4) & 7) === ((from >> 4) & 7));
      if (!sameFile) disambiguation = "abcdefgh"[from & 7];
      else if (!sameRank) disambiguation = String((from >> 4) + 1);
      else disambiguation = squareName(from);
    }
    san = `${letter}${disambiguation}${isCapture ? "x" : ""}${squareName(to)}`;
  }
  if (after.status === "checkmate") san += "#";
  else if (after.inCheck) san += "+";
  return san;
}

/** UCI の着手を適用した新しい状態を返す。合法手でなければ例外。 */
export function applyUciMove(state: ChessGameState, uci: string): ChessGameState {
  if (state.status !== "playing") throw new Error("対局は既に終了しています");
  const legalBefore = generateLegalMoves(state.position);
  const entry = legalBefore.find(({ uci: candidate }) => candidate === uci);
  if (!entry) throw new Error(`合法手ではありません: ${uci}`);
  const move = entry.move;
  const from = move & 0x7f;
  const movedType = state.position.board[from] & 7;
  const isCapture = (move & MF_CAPTURE) !== 0 || (move & MF_EP) !== 0;

  const position = clonePosition(state.position);
  applyMove(position, move);
  const repetitions = { ...state.repetitions };
  const key = positionToFen(position);
  repetitions[key] = (repetitions[key] ?? 0) + 1;

  const next: ChessGameState = {
    ...state,
    position,
    moves: [...state.moves, entry.uci],
    halfmoveClock: movedType === 1 || isCapture ? 0 : state.halfmoveClock + 1,
    fullmoveNumber: state.position.side === BLACK ? state.fullmoveNumber + 1 : state.fullmoveNumber,
    repetitions,
  };
  const settled = settleStatus(next);
  const san = moveToSan(state, move, legalBefore, settled);
  return { ...settled, sans: [...state.sans, san] };
}

/** 投了した状態を返す。 */
export function resignGame(state: ChessGameState, loser: number): ChessGameState {
  if (state.status !== "playing") return state;
  return { ...state, status: "resigned", winner: loser === WHITE ? BLACK : WHITE };
}
