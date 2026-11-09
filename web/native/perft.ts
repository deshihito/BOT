// チェス perft の AssemblyScript 実装（WASM 実行方式用）。
// web/lib/chess-perft.ts の着手生成をそのまま移植したもの。盤面表現 (0x88)、
// 駒コード、着手パッキング、合法判定は TS 版と同一。
// FEN の解釈はホスト (TS) 側で行い、setSquare / setState で局面を渡す。

const WHITE: i32 = 0;
const BLACK: i32 = 1;

const EMPTY: i32 = 0;
const WP: i32 = 1, WN: i32 = 2, WB: i32 = 3, WR: i32 = 4, WQ: i32 = 5, WK: i32 = 6;
const BP: i32 = 9, BN: i32 = 10, BB: i32 = 11, BR: i32 = 12, BQ: i32 = 13, BK: i32 = 14;

const FLAG_CAPTURE: i32 = 1 << 17;
const FLAG_DOUBLE: i32 = 1 << 18;
const FLAG_EP: i32 = 1 << 19;
const FLAG_CASTLE: i32 = 1 << 20;

const KNIGHT_DELTAS: i32[] = [31, 33, 14, 18, -31, -33, -14, -18];
const KING_DELTAS: i32[] = [16, -16, 1, -1, 15, 17, -15, -17];
const BISHOP_DELTAS: i32[] = [15, 17, -15, -17];
const ROOK_DELTAS: i32[] = [16, -16, 1, -1];
const PROMOS: i32[] = [5, 4, 3, 2];

const CASTLE_CLEAR = new Int8Array(128);
CASTLE_CLEAR[0] = 2; // a1
CASTLE_CLEAR[4] = 3; // e1
CASTLE_CLEAR[7] = 1; // h1
CASTLE_CLEAR[112] = 8; // a8
CASTLE_CLEAR[116] = 12; // e8
CASTLE_CLEAR[119] = 4; // h8

const board = new Int8Array(128);
let side: i32 = WHITE;
let castling: i32 = 0;
let ep: i32 = -1;

// ply ごとの着手バッファと undo 情報（割り当てを繰り返さないための固定領域）
const MAX_PLY: i32 = 64;
const MAX_MOVES: i32 = 256;
const moveBuf = new Int32Array(MAX_PLY * MAX_MOVES);
const undoCaptured = new Int32Array(MAX_PLY);
const undoCastling = new Int32Array(MAX_PLY);
const undoEp = new Int32Array(MAX_PLY);

export function setSquare(index: i32, value: i32): void {
  board[index] = value as i8;
}

export function setState(nextSide: i32, nextCastling: i32, nextEp: i32): void {
  side = nextSide;
  castling = nextCastling;
  ep = nextEp;
}

function isAttacked(sq: i32, by: i32): bool {
  if (by == WHITE) {
    const a = sq - 15, b = sq - 17;
    if (!(a & 0x88) && board[a] == WP) return true;
    if (!(b & 0x88) && board[b] == WP) return true;
  } else {
    const a = sq + 15, b = sq + 17;
    if (!(a & 0x88) && board[a] == BP) return true;
    if (!(b & 0x88) && board[b] == BP) return true;
  }
  const knight = by == WHITE ? WN : BN;
  for (let i = 0; i < 8; i++) {
    const t = sq + KNIGHT_DELTAS[i];
    if (!(t & 0x88) && board[t] == knight) return true;
  }
  const king = by == WHITE ? WK : BK;
  for (let i = 0; i < 8; i++) {
    const t = sq + KING_DELTAS[i];
    if (!(t & 0x88) && board[t] == king) return true;
  }
  const bishop = by == WHITE ? WB : BB;
  const queen = by == WHITE ? WQ : BQ;
  for (let i = 0; i < 4; i++) {
    const d = BISHOP_DELTAS[i];
    let t = sq + d;
    while (!(t & 0x88)) {
      const p = board[t];
      if (p != EMPTY) {
        if (p == bishop || p == queen) return true;
        break;
      }
      t += d;
    }
  }
  const rook = by == WHITE ? WR : BR;
  for (let i = 0; i < 4; i++) {
    const d = ROOK_DELTAS[i];
    let t = sq + d;
    while (!(t & 0x88)) {
      const p = board[t];
      if (p != EMPTY) {
        if (p == rook || p == queen) return true;
        break;
      }
      t += d;
    }
  }
  return false;
}

function kingSquare(color: i32): i32 {
  const king = color == WHITE ? WK : BK;
  for (let i = 0; i < 128; i++) {
    if (!(i & 0x88) && board[i] == king) return i;
  }
  return -1;
}

function isEnemy(target: i32): bool {
  return side == WHITE ? target >= 9 : target <= 6;
}

function makeMove(move: i32, ply: i32): void {
  const from = move & 0x7f;
  const to = (move >> 7) & 0x7f;
  const piece = board[from];
  undoCaptured[ply] = board[to];
  undoCastling[ply] = castling;
  undoEp[ply] = ep;

  ep = -1;
  castling &= ~CASTLE_CLEAR[from] & ~CASTLE_CLEAR[to] & 0xf;

  if (move & FLAG_EP) {
    const capSq = side == WHITE ? to - 16 : to + 16;
    undoCaptured[ply] = board[capSq];
    board[capSq] = EMPTY as i8;
  }
  board[to] = piece as i8;
  board[from] = EMPTY as i8;

  const promo = (move >> 14) & 0x7;
  if (promo != 0) {
    board[to] = (side == WHITE ? promo : promo + 8) as i8;
  }
  if (move & FLAG_DOUBLE) {
    ep = side == WHITE ? from + 16 : from - 16;
  }
  if (move & FLAG_CASTLE) {
    if (to == 6) { board[5] = board[7]; board[7] = EMPTY as i8; }
    else if (to == 2) { board[3] = board[0]; board[0] = EMPTY as i8; }
    else if (to == 118) { board[117] = board[119]; board[119] = EMPTY as i8; }
    else if (to == 114) { board[115] = board[112]; board[112] = EMPTY as i8; }
  }
  side = side == WHITE ? BLACK : WHITE;
}

function unmakeMove(move: i32, ply: i32): void {
  side = side == WHITE ? BLACK : WHITE;
  const from = move & 0x7f;
  const to = (move >> 7) & 0x7f;
  let piece: i32 = board[to];
  const promo = (move >> 14) & 0x7;
  if (promo != 0) piece = side == WHITE ? WP : BP;
  board[from] = piece as i8;
  board[to] = EMPTY as i8;
  if (move & FLAG_CASTLE) {
    if (to == 6) { board[7] = board[5]; board[5] = EMPTY as i8; }
    else if (to == 2) { board[0] = board[3]; board[3] = EMPTY as i8; }
    else if (to == 118) { board[119] = board[117]; board[117] = EMPTY as i8; }
    else if (to == 114) { board[112] = board[115]; board[115] = EMPTY as i8; }
  }
  if (move & FLAG_EP) {
    const capSq = side == WHITE ? to - 16 : to + 16;
    board[capSq] = undoCaptured[ply] as i8;
  } else if (undoCaptured[ply] != EMPTY) {
    board[to] = undoCaptured[ply] as i8;
  }
  castling = undoCastling[ply];
  ep = undoEp[ply];
}

function genMoves(ply: i32): i32 {
  const base = ply * MAX_MOVES;
  let n = 0;
  for (let from = 0; from < 128; from++) {
    if (from & 0x88) continue;
    const piece = board[from];
    if (piece == EMPTY || (side == WHITE ? piece > 6 : piece < 9)) continue;
    const ptype = piece & 7;
    if (ptype == 1) {
      const up = side == WHITE ? 16 : -16;
      const startRank = side == WHITE ? 1 : 6;
      const promoRank = side == WHITE ? 6 : 1;
      const rank = from >> 4;
      const one = from + up;
      if (board[one] == EMPTY) {
        if (rank == promoRank) {
          for (let pi = 0; pi < 4; pi++) {
            moveBuf[base + n] = from | (one << 7) | (PROMOS[pi] << 14);
            n++;
          }
        } else {
          moveBuf[base + n] = from | (one << 7);
          n++;
          const two = from + 2 * up;
          if (rank == startRank && board[two] == EMPTY) {
            moveBuf[base + n] = from | (two << 7) | FLAG_DOUBLE;
            n++;
          }
        }
      }
      for (let di = 0; di < 2; di++) {
        const d = di == 0 ? up - 1 : up + 1;
        const to = from + d;
        if (to & 0x88) continue;
        const target = board[to];
        if (target != EMPTY && isEnemy(target)) {
          if (rank == promoRank) {
            for (let pi = 0; pi < 4; pi++) {
              moveBuf[base + n] = from | (to << 7) | (PROMOS[pi] << 14) | FLAG_CAPTURE;
              n++;
            }
          } else {
            moveBuf[base + n] = from | (to << 7) | FLAG_CAPTURE;
            n++;
          }
        } else if (to == ep) {
          moveBuf[base + n] = from | (to << 7) | FLAG_CAPTURE | FLAG_EP;
          n++;
        }
      }
    } else if (ptype == 2 || ptype == 6) {
      for (let i = 0; i < 8; i++) {
        const d = ptype == 2 ? KNIGHT_DELTAS[i] : KING_DELTAS[i];
        const to = from + d;
        if (to & 0x88) continue;
        const target = board[to];
        if (target == EMPTY) {
          moveBuf[base + n] = from | (to << 7);
          n++;
        } else if (isEnemy(target)) {
          moveBuf[base + n] = from | (to << 7) | FLAG_CAPTURE;
          n++;
        }
      }
      if (ptype == 6) {
        if (side == WHITE && from == 4) {
          if ((castling & 1) && board[5] == EMPTY && board[6] == EMPTY && board[7] == WR &&
              !isAttacked(4, BLACK) && !isAttacked(5, BLACK) && !isAttacked(6, BLACK)) {
            moveBuf[base + n] = from | (6 << 7) | FLAG_CASTLE;
            n++;
          }
          if ((castling & 2) && board[3] == EMPTY && board[2] == EMPTY && board[1] == EMPTY && board[0] == WR &&
              !isAttacked(4, BLACK) && !isAttacked(3, BLACK) && !isAttacked(2, BLACK)) {
            moveBuf[base + n] = from | (2 << 7) | FLAG_CASTLE;
            n++;
          }
        } else if (side == BLACK && from == 116) {
          if ((castling & 4) && board[117] == EMPTY && board[118] == EMPTY && board[119] == BR &&
              !isAttacked(116, WHITE) && !isAttacked(117, WHITE) && !isAttacked(118, WHITE)) {
            moveBuf[base + n] = from | (118 << 7) | FLAG_CASTLE;
            n++;
          }
          if ((castling & 8) && board[115] == EMPTY && board[114] == EMPTY && board[113] == EMPTY && board[112] == BR &&
              !isAttacked(116, WHITE) && !isAttacked(115, WHITE) && !isAttacked(114, WHITE)) {
            moveBuf[base + n] = from | (114 << 7) | FLAG_CASTLE;
            n++;
          }
        }
      }
    } else {
      for (let set = 0; set < 2; set++) {
        if (ptype == 3 && set == 1) continue;
        if (ptype == 4 && set == 0) continue;
        for (let i = 0; i < 4; i++) {
          const d = set == 0 ? BISHOP_DELTAS[i] : ROOK_DELTAS[i];
          let to = from + d;
          while (!(to & 0x88)) {
            const target = board[to];
            if (target == EMPTY) {
              moveBuf[base + n] = from | (to << 7);
              n++;
            } else {
              if (isEnemy(target)) {
                moveBuf[base + n] = from | (to << 7) | FLAG_CAPTURE;
                n++;
              }
              break;
            }
            to += d;
          }
        }
      }
    }
  }
  return n;
}

function perftRec(depth: i32, ply: i32): u64 {
  if (depth == 0) return 1;
  const mover = side;
  const count = genMoves(ply);
  let nodes: u64 = 0;
  for (let i = 0; i < count; i++) {
    const move = moveBuf[ply * MAX_MOVES + i];
    makeMove(move, ply);
    const ksq = kingSquare(mover);
    if (ksq >= 0 && !isAttacked(ksq, side)) {
      nodes += depth == 1 ? 1 : perftRec(depth - 1, ply + 1);
    }
    unmakeMove(move, ply);
  }
  return nodes;
}

/** setSquare / setState で渡された局面の perft を数える。 */
export function perftNow(depth: i32): u64 {
  return perftRec(depth, 0);
}
