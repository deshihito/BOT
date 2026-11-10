// このファイルは自動生成です。編集しないでください。
// 生成元: lib/chess-perft.ts / lib/compute-wasm.ts / lib/compute-wasm-bytes.ts と
// lib/workers-src/*.entry.js。再生成は `npm run build:workers`。
// ※ ファイル名が .js でなければならない: ビルド成果物は元ファイルの拡張子を
//   引き継ぎ、.ts だと配信サーバーが video/mp2t を返して読めなくなるため。
// ※ import を含めてはならない: Next のビルドが相対 import の実ファイルを
//   成果物に出さず、本番で 404 になるため、依存はすべて同梱している。

// AssemblyScript 製 perft (web/native/perft.ts) をコンパイルした WASM バイナリ。
// 再生成手順は web/scripts/build-wasm.mjs を参照。
// 元バイナリ: 4319 bytes
const WASM_BASE64 = "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" +
    "///f////8v///+7///8AQcwICwEsAEHYCAsVBAAAABAAAAAgBAAAIAQAACAAAAAIAEH8CAsBPABBiAkLKAEAAAAgAAAAEAAAAPD/" +
    "//8BAAAA/////w8AAAARAAAA8f///+////8AQbwJCwEsAEHICQsVBAAAABAAAACQBAAAkAQAACAAAAAIAEHsCQsBLABB+AkLGAEA" +
    "AAAQAAAADwAAABEAAADx////7////wBBnAoLASwAQagKCxUEAAAAEAAAAAAFAAAABQAAEAAAAAQAQcwKCwEsAEHYCgsYAQAAABAA" +
    "AAAQAAAA8P///wEAAAD/////AEH8CgsBLABBiAsLFQQAAAAQAAAAYAUAAGAFAAAQAAAABABBrAsLASwAQbgLCxUBAAAAEAAAAAUA" +
    "AAAEAAAAAwAAAAIAQdwLCwEsAEHoCwsVBAAAABAAAADABQAAwAUAABAAAAAEAEGMDAsBLABBmAwLIwIAAAAcAAAASQBuAHYAYQBs" +
    "AGkAZAAgAGwAZQBuAGcAdABoAEG8DAsBPABByAwLLQIAAAAmAAAAfgBsAGkAYgAvAGEAcgByAGEAeQBiAHUAZgBmAGUAcgAuAHQA" +
    "cwBB/AwLATwAQYgNCy8CAAAAKAAAAEEAbABsAG8AYwBhAHQAaQBvAG4AIAB0AG8AbwAgAGwAYQByAGcAZQBBvA0LATwAQcgNCyUC" +
    "AAAAHgAAAH4AbABpAGIALwByAHQALwBzAHQAdQBiAC4AdABzAEH8DQsBPABBiA4LKwIAAAAkAAAASQBuAGQAZQB4ACAAbwB1AHQA" +
    "IABvAGYAIAByAGEAbgBnAGUAQbwOCwE8AEHIDgsrAgAAACQAAAB+AGwAaQBiAC8AdAB5AHAAZQBkAGEAcgByAGEAeQAuAHQAcwBB" +
    "/A4LASwAQYgPCyECAAAAGgAAAH4AbABpAGIALwBhAHIAcgBhAHkALgB0AHM=";

// チェス perft（合法手生成のノード数計算）— 決定的・外部依存なし。
// クライアント分散コンピューティング v1 のワークロードとして、
// ブラウザの Web Worker と Node テストの両方から使う純粋モジュール。
//
// 盤面は 0x88 表現（128 マス）。駒コード: 白 1..6 (P,N,B,R,Q,K)、黒 9..14。
// 着手は 32bit 整数に詰める: from(7) | to(7) | promo type(3) | flags(4)。
const WHITE = 0;
const BLACK = 1;
const EMPTY = 0;
const WP = 1, WN = 2, WB = 3, WR = 4, WQ = 5, WK = 6;
const BP = 9, BN = 10, BB = 11, BR = 12, BQ = 13, BK = 14;
const KNIGHT_DELTAS = [31, 33, 14, 18, -31, -33, -14, -18];
const KING_DELTAS = [16, -16, 1, -1, 15, 17, -15, -17];
const BISHOP_DELTAS = [15, 17, -15, -17];
const ROOK_DELTAS = [16, -16, 1, -1];
const FLAG_CAPTURE = 1 << 17;
const FLAG_DOUBLE = 1 << 18;
const FLAG_EP = 1 << 19;
const FLAG_CASTLE = 1 << 20;
// キャスリング権: 1=白K側, 2=白Q側, 4=黒K側, 8=黒Q側
// マスごとの「そのマスに駒が出入りしたら消える権利」マスク
const CASTLE_CLEAR = new Int8Array(128);
CASTLE_CLEAR[0] = 2; // a1
CASTLE_CLEAR[4] = 3; // e1
CASTLE_CLEAR[7] = 1; // h1
CASTLE_CLEAR[112] = 8; // a8
CASTLE_CLEAR[116] = 12; // e8
CASTLE_CLEAR[119] = 4; // h8
const PIECE_FROM_CHAR = {
    P: WP, N: WN, B: WB, R: WR, Q: WQ, K: WK,
    p: BP, n: BN, b: BB, r: BR, q: BQ, k: BK,
};
function parseFen(fen) {
    const parts = fen.trim().split(/\s+/);
    if (parts.length < 2)
        throw new Error(`invalid FEN: ${fen}`);
    const board = new Int8Array(128);
    const rows = parts[0].split("/");
    if (rows.length !== 8)
        throw new Error(`invalid FEN: ${fen}`);
    for (let r = 0; r < 8; r++) {
        const rank = 7 - r; // FEN は 8 ランク目から
        let file = 0;
        for (const ch of rows[r]) {
            if (ch >= "1" && ch <= "8") {
                file += ch.charCodeAt(0) - 48;
            }
            else {
                const piece = PIECE_FROM_CHAR[ch];
                if (piece === undefined || file > 7)
                    throw new Error(`invalid FEN: ${fen}`);
                board[rank * 16 + file] = piece;
                file += 1;
            }
        }
        if (file !== 8)
            throw new Error(`invalid FEN: ${fen}`);
    }
    const side = parts[1] === "b" ? BLACK : WHITE;
    let castling = 0;
    const c = parts[2] ?? "-";
    if (c.includes("K"))
        castling |= 1;
    if (c.includes("Q"))
        castling |= 2;
    if (c.includes("k"))
        castling |= 4;
    if (c.includes("q"))
        castling |= 8;
    let ep = -1;
    const epPart = parts[3] ?? "-";
    if (epPart !== "-") {
        const file = epPart.charCodeAt(0) - 97;
        const rank = epPart.charCodeAt(1) - 49;
        if (file < 0 || file > 7 || rank < 0 || rank > 7)
            throw new Error(`invalid FEN: ${fen}`);
        ep = rank * 16 + file;
    }
    return { board, side, castling, ep };
}
function isAttacked(pos, sq, by) {
    const board = pos.board;
    // ポーン: 白ポーンは +15/+17 方向へ進むので、sq を攻撃する白ポーンは sq-15/sq-17 にいる
    if (by === WHITE) {
        const a = sq - 15, b = sq - 17;
        if (!(a & 0x88) && board[a] === WP)
            return true;
        if (!(b & 0x88) && board[b] === WP)
            return true;
    }
    else {
        const a = sq + 15, b = sq + 17;
        if (!(a & 0x88) && board[a] === BP)
            return true;
        if (!(b & 0x88) && board[b] === BP)
            return true;
    }
    const knight = by === WHITE ? WN : BN;
    for (const d of KNIGHT_DELTAS) {
        const t = sq + d;
        if (!(t & 0x88) && board[t] === knight)
            return true;
    }
    const king = by === WHITE ? WK : BK;
    for (const d of KING_DELTAS) {
        const t = sq + d;
        if (!(t & 0x88) && board[t] === king)
            return true;
    }
    const bishop = by === WHITE ? WB : BB;
    const queen = by === WHITE ? WQ : BQ;
    for (const d of BISHOP_DELTAS) {
        let t = sq + d;
        while (!(t & 0x88)) {
            const p = board[t];
            if (p !== EMPTY) {
                if (p === bishop || p === queen)
                    return true;
                break;
            }
            t += d;
        }
    }
    const rook = by === WHITE ? WR : BR;
    for (const d of ROOK_DELTAS) {
        let t = sq + d;
        while (!(t & 0x88)) {
            const p = board[t];
            if (p !== EMPTY) {
                if (p === rook || p === queen)
                    return true;
                break;
            }
            t += d;
        }
    }
    return false;
}
function kingSquare(pos, color) {
    const king = color === WHITE ? WK : BK;
    for (let i = 0; i < 128; i++) {
        if (!(i & 0x88) && pos.board[i] === king)
            return i;
    }
    return -1;
}
function makeMove(pos, move) {
    const from = move & 0x7f;
    const to = (move >> 7) & 0x7f;
    const board = pos.board;
    const piece = board[from];
    const undo = { move, captured: board[to], castling: pos.castling, ep: pos.ep };
    pos.ep = -1;
    pos.castling &= ~CASTLE_CLEAR[from] & ~CASTLE_CLEAR[to] & 0xf;
    if (move & FLAG_EP) {
        // 取られるポーンは to の1つ後ろ（白なら to-16、黒なら to+16）
        const capSq = pos.side === WHITE ? to - 16 : to + 16;
        undo.captured = board[capSq];
        board[capSq] = EMPTY;
    }
    board[to] = piece;
    board[from] = EMPTY;
    const promo = (move >> 14) & 0x7;
    if (promo !== 0) {
        board[to] = pos.side === WHITE ? promo : promo + 8;
    }
    if (move & FLAG_DOUBLE) {
        pos.ep = pos.side === WHITE ? from + 16 : from - 16;
    }
    if (move & FLAG_CASTLE) {
        if (to === 6) {
            board[5] = board[7];
            board[7] = EMPTY;
        } // 白K側 g1, ルーク h1->f1
        else if (to === 2) {
            board[3] = board[0];
            board[0] = EMPTY;
        } // 白Q側 c1, a1->d1
        else if (to === 118) {
            board[117] = board[119];
            board[119] = EMPTY;
        } // 黒K側 g8
        else if (to === 114) {
            board[115] = board[112];
            board[112] = EMPTY;
        } // 黒Q側 c8
    }
    pos.side = pos.side === WHITE ? BLACK : WHITE;
    return undo;
}
function unmakeMove(pos, undo) {
    const move = undo.move;
    pos.side = pos.side === WHITE ? BLACK : WHITE;
    const from = move & 0x7f;
    const to = (move >> 7) & 0x7f;
    const board = pos.board;
    let piece = board[to];
    const promo = (move >> 14) & 0x7;
    if (promo !== 0)
        piece = pos.side === WHITE ? WP : BP;
    board[from] = piece;
    board[to] = EMPTY;
    if (move & FLAG_CASTLE) {
        if (to === 6) {
            board[7] = board[5];
            board[5] = EMPTY;
        }
        else if (to === 2) {
            board[0] = board[3];
            board[3] = EMPTY;
        }
        else if (to === 118) {
            board[119] = board[117];
            board[117] = EMPTY;
        }
        else if (to === 114) {
            board[112] = board[115];
            board[115] = EMPTY;
        }
    }
    if (move & FLAG_EP) {
        const capSq = pos.side === WHITE ? to - 16 : to + 16;
        board[capSq] = undo.captured;
    }
    else if (undo.captured !== EMPTY) {
        board[to] = undo.captured;
    }
    pos.castling = undo.castling;
    pos.ep = undo.ep;
}
function generatePseudoMoves(pos) {
    const moves = [];
    const board = pos.board;
    const side = pos.side;
    for (let from = 0; from < 128; from++) {
        if (from & 0x88)
            continue;
        const piece = board[from];
        if (piece === EMPTY || (side === WHITE ? piece > 6 : piece < 9))
            continue;
        const type = piece & 7;
        if (type === 1) {
            // ポーン
            const up = side === WHITE ? 16 : -16;
            const startRank = side === WHITE ? 1 : 6;
            const promoRank = side === WHITE ? 6 : 1; // このランクからの前進はプロモーション
            const rank = from >> 4;
            const one = from + up;
            if (board[one] === EMPTY) {
                if (rank === promoRank) {
                    for (const promo of [5, 4, 3, 2])
                        moves.push(from | (one << 7) | (promo << 14));
                }
                else {
                    moves.push(from | (one << 7));
                    const two = from + 2 * up;
                    if (rank === startRank && board[two] === EMPTY) {
                        moves.push(from | (two << 7) | FLAG_DOUBLE);
                    }
                }
            }
            for (const d of [up - 1, up + 1]) {
                const to = from + d;
                if (to & 0x88)
                    continue;
                const target = board[to];
                if (target !== EMPTY && (side === WHITE ? target >= 9 : target <= 6)) {
                    if (rank === promoRank) {
                        for (const promo of [5, 4, 3, 2])
                            moves.push(from | (to << 7) | (promo << 14) | FLAG_CAPTURE);
                    }
                    else {
                        moves.push(from | (to << 7) | FLAG_CAPTURE);
                    }
                }
                else if (to === pos.ep) {
                    moves.push(from | (to << 7) | FLAG_CAPTURE | FLAG_EP);
                }
            }
        }
        else if (type === 2 || type === 6) {
            // ナイト / キング
            const deltas = type === 2 ? KNIGHT_DELTAS : KING_DELTAS;
            for (const d of deltas) {
                const to = from + d;
                if (to & 0x88)
                    continue;
                const target = board[to];
                if (target === EMPTY)
                    moves.push(from | (to << 7));
                else if (side === WHITE ? target >= 9 : target <= 6)
                    moves.push(from | (to << 7) | FLAG_CAPTURE);
            }
            if (type === 6) {
                // キャスリング（キング・ルーク未動、間が空、通過マスが攻撃されていない）
                if (side === WHITE && from === 4) {
                    if ((pos.castling & 1) && board[5] === EMPTY && board[6] === EMPTY && board[7] === WR &&
                        !isAttacked(pos, 4, BLACK) && !isAttacked(pos, 5, BLACK) && !isAttacked(pos, 6, BLACK)) {
                        moves.push(from | (6 << 7) | FLAG_CASTLE);
                    }
                    if ((pos.castling & 2) && board[3] === EMPTY && board[2] === EMPTY && board[1] === EMPTY && board[0] === WR &&
                        !isAttacked(pos, 4, BLACK) && !isAttacked(pos, 3, BLACK) && !isAttacked(pos, 2, BLACK)) {
                        moves.push(from | (2 << 7) | FLAG_CASTLE);
                    }
                }
                else if (side === BLACK && from === 116) {
                    if ((pos.castling & 4) && board[117] === EMPTY && board[118] === EMPTY && board[119] === BR &&
                        !isAttacked(pos, 116, WHITE) && !isAttacked(pos, 117, WHITE) && !isAttacked(pos, 118, WHITE)) {
                        moves.push(from | (118 << 7) | FLAG_CASTLE);
                    }
                    if ((pos.castling & 8) && board[115] === EMPTY && board[114] === EMPTY && board[113] === EMPTY && board[112] === BR &&
                        !isAttacked(pos, 116, WHITE) && !isAttacked(pos, 115, WHITE) && !isAttacked(pos, 114, WHITE)) {
                        moves.push(from | (114 << 7) | FLAG_CASTLE);
                    }
                }
            }
        }
        else {
            // スライダー（ビショップ / ルーク / クイーン）
            const deltaSets = type === 3 ? [BISHOP_DELTAS] : type === 4 ? [ROOK_DELTAS] : [BISHOP_DELTAS, ROOK_DELTAS];
            for (const deltas of deltaSets) {
                for (const d of deltas) {
                    let to = from + d;
                    while (!(to & 0x88)) {
                        const target = board[to];
                        if (target === EMPTY) {
                            moves.push(from | (to << 7));
                        }
                        else {
                            if (side === WHITE ? target >= 9 : target <= 6)
                                moves.push(from | (to << 7) | FLAG_CAPTURE);
                            break;
                        }
                        to += d;
                    }
                }
            }
        }
    }
    return moves;
}
/** 局面の合法手を UCI 文字列つきで返す（タスク分割用）。 */
function generateLegalMoves(pos) {
    const result = [];
    const mover = pos.side;
    for (const move of generatePseudoMoves(pos)) {
        const undo = makeMove(pos, move);
        const ksq = kingSquare(pos, mover);
        if (ksq >= 0 && !isAttacked(pos, ksq, pos.side)) {
            result.push({ move, uci: moveToUci(move) });
        }
        unmakeMove(pos, undo);
    }
    return result;
}
function applyMove(pos, move) {
    makeMove(pos, move);
}
function squareName(sq) {
    const file = sq & 7;
    const rank = sq >> 4;
    return "abcdefgh"[file] + String(rank + 1);
}
function moveToUci(move) {
    const from = move & 0x7f;
    const to = (move >> 7) & 0x7f;
    const promo = (move >> 14) & 0x7;
    const suffix = promo !== 0 ? "nbrq"[promo - 2] : "";
    return squareName(from) + squareName(to) + suffix;
}
function perftSlow(pos, depth) {
    if (depth === 0)
        return 1;
    const mover = pos.side;
    let nodes = 0;
    for (const move of generatePseudoMoves(pos)) {
        const undo = makeMove(pos, move);
        const ksq = kingSquare(pos, mover);
        if (ksq >= 0 && !isAttacked(pos, ksq, pos.side)) {
            nodes += depth === 1 ? 1 : perftSlow(pos, depth - 1);
        }
        unmakeMove(pos, undo);
    }
    return nodes;
}
// --- 高速 perft 内部エンジン ---
// perft() のホットパス専用。局面をモジュール共有の型付き配列へ移し、
// ply ごとの事前確保バッファで着手生成と Undo を行うことで、再帰中の
// 配列・オブジェクト確保をなくす（実測で約1.2〜1.75倍速）。
// 状態はモジュール共有なので再入はできないが、使うのは perft の再帰だけで、
// Position を使う公開関数とは干渉しない（呼び出し側の Position は変更しない）。
const FAST_MAX_PLY = 64;
const FAST_MAX_MOVES = 320; // 疑似合法手の上限（既知の最大合法手数 218 を十分に上回る）
const fastBoard = new Int8Array(128);
let fastSide = WHITE;
let fastCastling = 0;
let fastEp = -1;
const fastMoves = new Int32Array(FAST_MAX_PLY * FAST_MAX_MOVES);
const fastUndoCaptured = new Int8Array(FAST_MAX_PLY);
const fastUndoCastling = new Int8Array(FAST_MAX_PLY);
const fastUndoEp = new Int8Array(FAST_MAX_PLY);
const PROMO_TYPES = [5, 4, 3, 2];
function fastIsAttacked(sq, by) {
    if (by === WHITE) {
        const a = sq - 15, b = sq - 17;
        if (!(a & 0x88) && fastBoard[a] === WP)
            return true;
        if (!(b & 0x88) && fastBoard[b] === WP)
            return true;
    }
    else {
        const a = sq + 15, b = sq + 17;
        if (!(a & 0x88) && fastBoard[a] === BP)
            return true;
        if (!(b & 0x88) && fastBoard[b] === BP)
            return true;
    }
    const knight = by === WHITE ? WN : BN;
    for (let i = 0; i < 8; i++) {
        const t = sq + KNIGHT_DELTAS[i];
        if (!(t & 0x88) && fastBoard[t] === knight)
            return true;
    }
    const king = by === WHITE ? WK : BK;
    for (let i = 0; i < 8; i++) {
        const t = sq + KING_DELTAS[i];
        if (!(t & 0x88) && fastBoard[t] === king)
            return true;
    }
    const bishop = by === WHITE ? WB : BB;
    const queen = by === WHITE ? WQ : BQ;
    for (let i = 0; i < 4; i++) {
        const d = BISHOP_DELTAS[i];
        let t = sq + d;
        while (!(t & 0x88)) {
            const p = fastBoard[t];
            if (p !== EMPTY) {
                if (p === bishop || p === queen)
                    return true;
                break;
            }
            t += d;
        }
    }
    const rook = by === WHITE ? WR : BR;
    for (let i = 0; i < 4; i++) {
        const d = ROOK_DELTAS[i];
        let t = sq + d;
        while (!(t & 0x88)) {
            const p = fastBoard[t];
            if (p !== EMPTY) {
                if (p === rook || p === queen)
                    return true;
                break;
            }
            t += d;
        }
    }
    return false;
}
function fastKingSquare(color) {
    const king = color === WHITE ? WK : BK;
    for (let i = 0; i < 128; i++) {
        if (!(i & 0x88) && fastBoard[i] === king)
            return i;
    }
    return -1;
}
function fastMakeMove(move, ply) {
    const from = move & 0x7f;
    const to = (move >> 7) & 0x7f;
    const piece = fastBoard[from];
    fastUndoCaptured[ply] = fastBoard[to];
    fastUndoCastling[ply] = fastCastling;
    fastUndoEp[ply] = fastEp;
    fastEp = -1;
    fastCastling &= ~CASTLE_CLEAR[from] & ~CASTLE_CLEAR[to] & 0xf;
    if (move & FLAG_EP) {
        const capSq = fastSide === WHITE ? to - 16 : to + 16;
        fastUndoCaptured[ply] = fastBoard[capSq];
        fastBoard[capSq] = EMPTY;
    }
    fastBoard[to] = piece;
    fastBoard[from] = EMPTY;
    const promo = (move >> 14) & 0x7;
    if (promo !== 0)
        fastBoard[to] = fastSide === WHITE ? promo : promo + 8;
    if (move & FLAG_DOUBLE)
        fastEp = fastSide === WHITE ? from + 16 : from - 16;
    if (move & FLAG_CASTLE) {
        if (to === 6) {
            fastBoard[5] = fastBoard[7];
            fastBoard[7] = EMPTY;
        }
        else if (to === 2) {
            fastBoard[3] = fastBoard[0];
            fastBoard[0] = EMPTY;
        }
        else if (to === 118) {
            fastBoard[117] = fastBoard[119];
            fastBoard[119] = EMPTY;
        }
        else if (to === 114) {
            fastBoard[115] = fastBoard[112];
            fastBoard[112] = EMPTY;
        }
    }
    fastSide = fastSide === WHITE ? BLACK : WHITE;
}
function fastUnmakeMove(move, ply) {
    fastSide = fastSide === WHITE ? BLACK : WHITE;
    const from = move & 0x7f;
    const to = (move >> 7) & 0x7f;
    let piece = fastBoard[to];
    const promo = (move >> 14) & 0x7;
    if (promo !== 0)
        piece = fastSide === WHITE ? WP : BP;
    fastBoard[from] = piece;
    fastBoard[to] = EMPTY;
    if (move & FLAG_CASTLE) {
        if (to === 6) {
            fastBoard[7] = fastBoard[5];
            fastBoard[5] = EMPTY;
        }
        else if (to === 2) {
            fastBoard[0] = fastBoard[3];
            fastBoard[3] = EMPTY;
        }
        else if (to === 118) {
            fastBoard[119] = fastBoard[117];
            fastBoard[117] = EMPTY;
        }
        else if (to === 114) {
            fastBoard[112] = fastBoard[115];
            fastBoard[115] = EMPTY;
        }
    }
    if (move & FLAG_EP) {
        const capSq = fastSide === WHITE ? to - 16 : to + 16;
        fastBoard[capSq] = fastUndoCaptured[ply];
    }
    else if (fastUndoCaptured[ply] !== EMPTY) {
        fastBoard[to] = fastUndoCaptured[ply];
    }
    fastCastling = fastUndoCastling[ply];
    fastEp = fastUndoEp[ply];
}
function fastGenerate(ply) {
    const base = ply * FAST_MAX_MOVES;
    let n = 0;
    const white = fastSide === WHITE;
    for (let from = 0; from < 128; from++) {
        if (from & 0x88)
            continue;
        const piece = fastBoard[from];
        if (piece === EMPTY || (white ? piece > 6 : piece < 9))
            continue;
        const type = piece & 7;
        if (type === 1) {
            const up = white ? 16 : -16;
            const startRank = white ? 1 : 6;
            const promoRank = white ? 6 : 1;
            const rank = from >> 4;
            const one = from + up;
            if (fastBoard[one] === EMPTY) {
                if (rank === promoRank) {
                    for (let pi = 0; pi < 4; pi++)
                        fastMoves[base + n++] = from | (one << 7) | (PROMO_TYPES[pi] << 14);
                }
                else {
                    fastMoves[base + n++] = from | (one << 7);
                    const two = from + 2 * up;
                    if (rank === startRank && fastBoard[two] === EMPTY) {
                        fastMoves[base + n++] = from | (two << 7) | FLAG_DOUBLE;
                    }
                }
            }
            for (let di = 0; di < 2; di++) {
                const to = from + (di === 0 ? up - 1 : up + 1);
                if (to & 0x88)
                    continue;
                const target = fastBoard[to];
                if (target !== EMPTY && (white ? target >= 9 : target <= 6)) {
                    if (rank === promoRank) {
                        for (let pi = 0; pi < 4; pi++)
                            fastMoves[base + n++] = from | (to << 7) | (PROMO_TYPES[pi] << 14) | FLAG_CAPTURE;
                    }
                    else {
                        fastMoves[base + n++] = from | (to << 7) | FLAG_CAPTURE;
                    }
                }
                else if (to === fastEp) {
                    fastMoves[base + n++] = from | (to << 7) | FLAG_CAPTURE | FLAG_EP;
                }
            }
        }
        else if (type === 2 || type === 6) {
            const deltas = type === 2 ? KNIGHT_DELTAS : KING_DELTAS;
            for (let i = 0; i < 8; i++) {
                const to = from + deltas[i];
                if (to & 0x88)
                    continue;
                const target = fastBoard[to];
                if (target === EMPTY)
                    fastMoves[base + n++] = from | (to << 7);
                else if (white ? target >= 9 : target <= 6)
                    fastMoves[base + n++] = from | (to << 7) | FLAG_CAPTURE;
            }
            if (type === 6) {
                if (white && from === 4) {
                    if ((fastCastling & 1) && fastBoard[5] === EMPTY && fastBoard[6] === EMPTY && fastBoard[7] === WR &&
                        !fastIsAttacked(4, BLACK) && !fastIsAttacked(5, BLACK) && !fastIsAttacked(6, BLACK)) {
                        fastMoves[base + n++] = from | (6 << 7) | FLAG_CASTLE;
                    }
                    if ((fastCastling & 2) && fastBoard[3] === EMPTY && fastBoard[2] === EMPTY && fastBoard[1] === EMPTY && fastBoard[0] === WR &&
                        !fastIsAttacked(4, BLACK) && !fastIsAttacked(3, BLACK) && !fastIsAttacked(2, BLACK)) {
                        fastMoves[base + n++] = from | (2 << 7) | FLAG_CASTLE;
                    }
                }
                else if (!white && from === 116) {
                    if ((fastCastling & 4) && fastBoard[117] === EMPTY && fastBoard[118] === EMPTY && fastBoard[119] === BR &&
                        !fastIsAttacked(116, WHITE) && !fastIsAttacked(117, WHITE) && !fastIsAttacked(118, WHITE)) {
                        fastMoves[base + n++] = from | (118 << 7) | FLAG_CASTLE;
                    }
                    if ((fastCastling & 8) && fastBoard[115] === EMPTY && fastBoard[114] === EMPTY && fastBoard[113] === EMPTY && fastBoard[112] === BR &&
                        !fastIsAttacked(116, WHITE) && !fastIsAttacked(115, WHITE) && !fastIsAttacked(114, WHITE)) {
                        fastMoves[base + n++] = from | (114 << 7) | FLAG_CASTLE;
                    }
                }
            }
        }
        else {
            for (let set = 0; set < 2; set++) {
                if (type === 3 && set === 1)
                    continue;
                if (type === 4 && set === 0)
                    continue;
                const deltas = set === 0 ? BISHOP_DELTAS : ROOK_DELTAS;
                for (let i = 0; i < 4; i++) {
                    const d = deltas[i];
                    let to = from + d;
                    while (!(to & 0x88)) {
                        const target = fastBoard[to];
                        if (target === EMPTY) {
                            fastMoves[base + n++] = from | (to << 7);
                        }
                        else {
                            if (white ? target >= 9 : target <= 6)
                                fastMoves[base + n++] = from | (to << 7) | FLAG_CAPTURE;
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
function fastPerftRec(depth, ply) {
    const mover = fastSide;
    const count = fastGenerate(ply);
    const base = ply * FAST_MAX_MOVES;
    let nodes = 0;
    for (let i = 0; i < count; i++) {
        const move = fastMoves[base + i];
        fastMakeMove(move, ply);
        const ksq = fastKingSquare(mover);
        if (ksq >= 0 && !fastIsAttacked(ksq, fastSide)) {
            nodes += depth === 1 ? 1 : fastPerftRec(depth - 1, ply + 1);
        }
        fastUnmakeMove(move, ply);
    }
    return nodes;
}
/** perft: 深さ depth の合法手列の総数。決定的で、公開既知値と照合できる。 */
function perft(pos, depth) {
    if (depth === 0)
        return 1;
    if (depth > FAST_MAX_PLY)
        return perftSlow(pos, depth);
    fastBoard.set(pos.board);
    fastSide = pos.side;
    fastCastling = pos.castling;
    fastEp = pos.ep;
    return fastPerftRec(depth, 0);
}
/** FEN を直接受ける便利関数。 */
function perftFen(fen, depth) {
    return perft(parseFen(fen), depth);
}
// --- 対局用ヘルパー（WEB ゲームのチェス CPU 対戦が使う） ---
const PIECE_TO_CHAR = {
    [WP]: "P", [WN]: "N", [WB]: "B", [WR]: "R", [WQ]: "Q", [WK]: "K",
    [BP]: "p", [BN]: "n", [BB]: "b", [BR]: "r", [BQ]: "q", [BK]: "k",
};
/** 指定した色のキングがチェックされているか。 */
function isInCheck(pos, color) {
    const ksq = kingSquare(pos, color);
    if (ksq < 0)
        return false;
    return isAttacked(pos, ksq, color === WHITE ? BLACK : WHITE);
}
/**
 * 局面を FEN の先頭4フィールド（盤面・手番・キャスリング権・アンパッサン）
 * として書き出す。手数カウンタは Position が保持しないため含めない
 * （必要な呼び出し側が別に付け足す）。
 */
function positionToFen(pos) {
    const rows = [];
    for (let rank = 7; rank >= 0; rank--) {
        let row = "";
        let empty = 0;
        for (let file = 0; file < 8; file++) {
            const piece = pos.board[rank * 16 + file];
            if (piece === EMPTY) {
                empty += 1;
                continue;
            }
            if (empty > 0) {
                row += String(empty);
                empty = 0;
            }
            row += PIECE_TO_CHAR[piece] ?? "?";
        }
        if (empty > 0)
            row += String(empty);
        rows.push(row);
    }
    let castling = "";
    if (pos.castling & 1)
        castling += "K";
    if (pos.castling & 2)
        castling += "Q";
    if (pos.castling & 4)
        castling += "k";
    if (pos.castling & 8)
        castling += "q";
    const ep = pos.ep >= 0 ? squareName(pos.ep) : "-";
    return `${rows.join("/")} ${pos.side === WHITE ? "w" : "b"} ${castling === "" ? "-" : castling} ${ep}`;
}

// 分散コンピューティングの WASM 実行エンジン。
// AssemblyScript 製の perft (web/native/perft.ts をコンパイルし、
// compute-wasm-bytes.ts に base64 で埋め込み) を Web Worker から使う。
// 着手生成の意味は lib/chess-perft.ts と同一で、公開既知値とカタログの
// 正解値で検証済み（tests/compute-wasm.test.mjs）。対応環境では
// JavaScript 実装より高速に計算できる。
/** この環境で WebAssembly が使えるか。 */
function isWasmSupported() {
    return typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
}
function decodeBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++)
        bytes[i] = binary.charCodeAt(i);
    return bytes;
}
let exportsPromise = null;
function getExports() {
    if (!exportsPromise) {
        exportsPromise = (async () => {
            const bytes = decodeBase64(WASM_BASE64);
            const { instance } = await WebAssembly.instantiate(bytes, {
                env: {
                    abort: () => {
                        throw new Error("wasm abort");
                    },
                },
            });
            return instance.exports;
        })();
        exportsPromise.catch(() => {
            exportsPromise = null;
        });
    }
    return exportsPromise;
}
/** FEN 局面の perft を WASM で計算する。 */
async function perftFenWasm(fen, depth) {
    const wasm = await getExports();
    const pos = parseFen(fen);
    for (let i = 0; i < 128; i++)
        wasm.setSquare(i, pos.board[i]);
    wasm.setState(pos.side, pos.castling, pos.ep);
    return Number(wasm.perftNow(depth));
}

// ワーカーのエントリ（WASM 方式・本体）。perftFenWasm はバンドル時に
// compute-wasm.ts が同梱される前提で、import は書かない
// （scripts/build-workers.mjs が lib/compute-wasm.worker.js を生成する）。
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "run") return;
  const started = Date.now();
  perftFenWasm(data.fen, data.depth)
    .then((nodes) => {
      self.postMessage({ type: "result", taskId: data.taskId, nodes, elapsedMs: Date.now() - started });
    })
    .catch((error) => {
      self.postMessage({
        type: "error",
        taskId: data.taskId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
});
