// 詰めチェス（チェックメイト問題集）の純粋ロジック（UI 非依存）。
// 攻め方（白）は毎手「王手」をかけ続け、指定手数で詰ませるのがルール。
// そのため合法手のうち王手になる手だけが指せる（playPuzzleMove は王手でない手を進めない）。
// 駒の動き・王手判定・詰み探索はこの lib 内に独立実装し、
// 収録問題は solveMate で「指定手数ちょうどで詰み、初手が1つだけに定まる」ことを
// 機械検証できたものだけに限る（検証は tests/games-a34.test.mjs でも再実行する）。
// 状態は JSON 化可能な値のみ。遷移関数は状態を破壊せず新しい状態を返す。

export type CpColor = "w" | "b";
export type CpPieceType = "P" | "N" | "B" | "R" | "Q" | "K";

export type CpPiece = {
  type: CpPieceType;
  color: CpColor;
};

/** 盤面: 長さ64。index = rank * 8 + file（rank 0 = 1段目、file 0 = a筋）。 */
export type CpBoard = (CpPiece | null)[];

export type CpPosition = {
  board: CpBoard;
  /** キャスリング権（"KQkq" の部分文字列、無ければ ""）。 */
  castling: string;
  /** アンパッサン対象マス（index、無ければ -1）。 */
  ep: number;
};

export type CpMove = {
  from: number;
  to: number;
  promotion?: CpPieceType;
};

export function squareName(index: number): string {
  const file = index % 8;
  const rank = Math.floor(index / 8);
  return "abcdefgh"[file] + String(rank + 1);
}

export function squareIndex(name: string): number {
  const file = "abcdefgh".indexOf(name[0]);
  const rank = Number(name[1]) - 1;
  return rank * 8 + file;
}

/** FEN の駒配置＋キャスリング＋アンパッサンだけを読む（手番以降は無視する）。 */
export function parseFen(fen: string): CpPosition {
  const parts = fen.trim().split(/\s+/);
  const rows = parts[0].split("/");
  if (rows.length !== 8) throw new Error(`FEN の段数が不正です: ${fen}`);
  const board: CpBoard = Array.from({ length: 64 }, () => null);
  const typeByChar: Record<string, CpPieceType> = {
    p: "P",
    n: "N",
    b: "B",
    r: "R",
    q: "Q",
    k: "K",
  };
  for (let r = 0; r < 8; r++) {
    const rank = 7 - r; // FEN は8段目から
    let file = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) {
        file += Number(ch);
        continue;
      }
      const type = typeByChar[ch.toLowerCase()];
      if (!type || file > 7) throw new Error(`FEN の駒が不正です: ${fen}`);
      board[rank * 8 + file] = { type, color: ch === ch.toUpperCase() ? "w" : "b" };
      file += 1;
    }
    if (file !== 8) throw new Error(`FEN の筋数が不正です: ${fen}`);
  }
  const castlingRaw = parts[2] ?? "-";
  const castling = castlingRaw === "-" ? "" : castlingRaw.split("").filter((c) => "KQkq".includes(c)).join("");
  const epRaw = parts[3] ?? "-";
  const ep = epRaw === "-" ? -1 : squareIndex(epRaw);
  return { board, castling, ep };
}

function opposite(color: CpColor): CpColor {
  return color === "w" ? "b" : "w";
}

function inBoard(file: number, rank: number): boolean {
  return file >= 0 && file < 8 && rank >= 0 && rank < 8;
}

const KNIGHT_DELTAS: [number, number][] = [
  [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];
const KING_DELTAS: [number, number][] = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];
const BISHOP_DIRS: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ROOK_DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** sq が by 色の駒に利かれているか。 */
export function isAttacked(board: CpBoard, sq: number, by: CpColor): boolean {
  const file = sq % 8;
  const rank = Math.floor(sq / 8);
  // ポーン: 白ポーンは rank+1 方向へ進むので、攻撃元は逆側。
  const pawnRank = by === "w" ? rank - 1 : rank + 1;
  for (const df of [-1, 1]) {
    const f = file + df;
    if (inBoard(f, pawnRank)) {
      const p = board[pawnRank * 8 + f];
      if (p && p.type === "P" && p.color === by) return true;
    }
  }
  for (const [df, dr] of KNIGHT_DELTAS) {
    const f = file + df;
    const r = rank + dr;
    if (!inBoard(f, r)) continue;
    const p = board[r * 8 + f];
    if (p && p.type === "N" && p.color === by) return true;
  }
  for (const [df, dr] of KING_DELTAS) {
    const f = file + df;
    const r = rank + dr;
    if (!inBoard(f, r)) continue;
    const p = board[r * 8 + f];
    if (p && p.type === "K" && p.color === by) return true;
  }
  const ray = (dirs: [number, number][], types: CpPieceType[]): boolean => {
    for (const [df, dr] of dirs) {
      let f = file + df;
      let r = rank + dr;
      while (inBoard(f, r)) {
        const p = board[r * 8 + f];
        if (p) {
          if (p.color === by && types.includes(p.type)) return true;
          break;
        }
        f += df;
        r += dr;
      }
    }
    return false;
  };
  if (ray(BISHOP_DIRS, ["B", "Q"])) return true;
  if (ray(ROOK_DIRS, ["R", "Q"])) return true;
  return false;
}

export function findKing(board: CpBoard, color: CpColor): number {
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p && p.type === "K" && p.color === color) return i;
  }
  return -1;
}

export function isInCheck(board: CpBoard, color: CpColor): boolean {
  const king = findKing(board, color);
  if (king < 0) return false;
  return isAttacked(board, king, opposite(color));
}

function pseudoMoves(pos: CpPosition, color: CpColor): CpMove[] {
  const { board } = pos;
  const moves: CpMove[] = [];
  const pushPawnMove = (from: number, to: number) => {
    const toRank = Math.floor(to / 8);
    if (toRank === 0 || toRank === 7) {
      for (const promotion of ["Q", "R", "B", "N"] as CpPieceType[]) {
        moves.push({ from, to, promotion });
      }
    } else {
      moves.push({ from, to });
    }
  };
  for (let i = 0; i < 64; i++) {
    const piece = board[i];
    if (!piece || piece.color !== color) continue;
    const file = i % 8;
    const rank = Math.floor(i / 8);
    if (piece.type === "P") {
      const dir = color === "w" ? 1 : -1;
      const startRank = color === "w" ? 1 : 6;
      const oneRank = rank + dir;
      if (inBoard(file, oneRank) && !board[oneRank * 8 + file]) {
        pushPawnMove(i, oneRank * 8 + file);
        const twoRank = rank + dir * 2;
        if (rank === startRank && !board[twoRank * 8 + file]) {
          moves.push({ from: i, to: twoRank * 8 + file });
        }
      }
      for (const df of [-1, 1]) {
        const f = file + df;
        if (!inBoard(f, oneRank)) continue;
        const to = oneRank * 8 + f;
        const target = board[to];
        if (target && target.color !== color) {
          pushPawnMove(i, to);
        } else if (!target && to === pos.ep) {
          moves.push({ from: i, to });
        }
      }
    } else if (piece.type === "N" || piece.type === "K") {
      const deltas = piece.type === "N" ? KNIGHT_DELTAS : KING_DELTAS;
      for (const [df, dr] of deltas) {
        const f = file + df;
        const r = rank + dr;
        if (!inBoard(f, r)) continue;
        const target = board[r * 8 + f];
        if (!target || target.color !== color) moves.push({ from: i, to: r * 8 + f });
      }
      if (piece.type === "K") {
        // キャスリング（通過マスへの利きも確認する）。
        const home = color === "w" ? 0 : 7;
        if (rank === home && file === 4) {
          const rights = color === "w" ? ["K", "Q"] : ["k", "q"];
          const tryCastle = (kingSide: boolean) => {
            const right = kingSide ? rights[0] : rights[1];
            if (!pos.castling.includes(right)) return;
            const rookFile = kingSide ? 7 : 0;
            const rook = board[home * 8 + rookFile];
            if (!rook || rook.type !== "R" || rook.color !== color) return;
            const step = kingSide ? 1 : -1;
            const between = kingSide ? [5, 6] : [1, 2, 3];
            if (between.some((f) => board[home * 8 + f])) return;
            const path = [4, 4 + step, 4 + step * 2];
            if (path.some((f) => isAttacked(board, home * 8 + f, opposite(color)))) return;
            moves.push({ from: i, to: home * 8 + (kingSide ? 6 : 2) });
          };
          tryCastle(true);
          tryCastle(false);
        }
      }
    } else {
      const dirs =
        piece.type === "B" ? BISHOP_DIRS : piece.type === "R" ? ROOK_DIRS : [...BISHOP_DIRS, ...ROOK_DIRS];
      for (const [df, dr] of dirs) {
        let f = file + df;
        let r = rank + dr;
        while (inBoard(f, r)) {
          const to = r * 8 + f;
          const target = board[to];
          if (!target) {
            moves.push({ from: i, to });
          } else {
            if (target.color !== color) moves.push({ from: i, to });
            break;
          }
          f += df;
          r += dr;
        }
      }
    }
  }
  return moves;
}

/** 手を適用した新しい局面を返す（元の局面は変更しない）。 */
export function applyMove(pos: CpPosition, move: CpMove): CpPosition {
  const board = pos.board.slice();
  const piece = board[move.from];
  if (!piece) throw new Error("移動元に駒がありません");
  let castling = pos.castling;
  let ep = -1;
  const fromRank = Math.floor(move.from / 8);
  const fromFile = move.from % 8;
  const toRank = Math.floor(move.to / 8);
  // アンパッサンで取られるポーン。
  if (piece.type === "P" && move.to === pos.ep && !board[move.to] && fromFile !== move.to % 8) {
    board[fromRank * 8 + (move.to % 8)] = null;
  }
  // キャスリングのルーク移動。
  if (piece.type === "K" && Math.abs((move.to % 8) - fromFile) === 2) {
    const kingSide = move.to % 8 > fromFile;
    const rookFrom = fromRank * 8 + (kingSide ? 7 : 0);
    const rookTo = fromRank * 8 + (kingSide ? 5 : 3);
    board[rookTo] = board[rookFrom];
    board[rookFrom] = null;
  }
  board[move.from] = null;
  board[move.to] = move.promotion ? { type: move.promotion, color: piece.color } : piece;
  if (piece.type === "P" && Math.abs(toRank - fromRank) === 2) {
    ep = ((fromRank + toRank) / 2) * 8 + fromFile;
  }
  // キャスリング権の更新。
  const strip = (chars: string) => {
    castling = castling.split("").filter((c) => !chars.includes(c)).join("");
  };
  if (piece.type === "K") strip(piece.color === "w" ? "KQ" : "kq");
  if (move.from === 0 || move.to === 0) strip("Q");
  if (move.from === 7 || move.to === 7) strip("K");
  if (move.from === 56 || move.to === 56) strip("q");
  if (move.from === 63 || move.to === 63) strip("k");
  return { board, castling, ep };
}

/** 合法手（自玉が利きに入る手を除く）。 */
export function legalMoves(pos: CpPosition, color: CpColor): CpMove[] {
  return pseudoMoves(pos, color).filter((m) => {
    const next = applyMove(pos, m);
    return !isInCheck(next.board, color);
  });
}

export function isCheckmate(pos: CpPosition, color: CpColor): boolean {
  return isInCheck(pos.board, color) && legalMoves(pos, color).length === 0;
}

/** 手の簡易表記（SAN 風。曖昧さ回避の符号は付けない）。 */
export function moveNotation(pos: CpPosition, move: CpMove): string {
  const piece = pos.board[move.from];
  if (!piece) return "?";
  const target = pos.board[move.to];
  const isEpCapture =
    piece.type === "P" && move.to === pos.ep && !target && move.from % 8 !== move.to % 8;
  const capture = !!target || isEpCapture;
  let text: string;
  if (piece.type === "K" && Math.abs((move.to % 8) - (move.from % 8)) === 2) {
    text = move.to % 8 > move.from % 8 ? "O-O" : "O-O-O";
  } else if (piece.type === "P") {
    text = capture
      ? `${"abcdefgh"[move.from % 8]}x${squareName(move.to)}`
      : squareName(move.to);
    if (move.promotion) text += `=${move.promotion}`;
  } else {
    text = `${piece.type}${capture ? "x" : ""}${squareName(move.to)}`;
  }
  const next = applyMove(pos, move);
  if (isCheckmate(next, opposite(piece.color))) text += "#";
  else if (isInCheck(next.board, opposite(piece.color))) text += "+";
  return text;
}

/** 白の合法手のうち、黒に王手がかかる手だけを返す（このゲームで指せる手）。 */
export function checkingMoves(pos: CpPosition): CpMove[] {
  return legalMoves(pos, "w").filter((m) => isInCheck(applyMove(pos, m).board, "b"));
}

/**
 * 王手の連続で詰ませる探索。
 * depth 手（白の手数）以内で詰む白の初手一覧を返す。詰まなければ空配列。
 */
export function forcingMoves(pos: CpPosition, depth: number): CpMove[] {
  if (depth <= 0) return [];
  const out: CpMove[] = [];
  for (const move of checkingMoves(pos)) {
    const afterWhite = applyMove(pos, move);
    if (isCheckmate(afterWhite, "b")) {
      out.push(move);
      continue;
    }
    if (depth === 1) continue;
    const replies = legalMoves(afterWhite, "b");
    if (replies.length === 0) continue; // 王手なのに応手なし＝詰みのはずだが念のため
    const allMated = replies.every(
      (reply) => forcingMoves(applyMove(afterWhite, reply), depth - 1).length > 0,
    );
    if (allMated) out.push(move);
  }
  return out;
}

/** maxDepth までで最短の詰みを探す。見つからなければ null。 */
export function solveMate(
  pos: CpPosition,
  maxDepth: number,
): { mateIn: number; firstMoves: CpMove[] } | null {
  for (let d = 1; d <= maxDepth; d++) {
    const firstMoves = forcingMoves(pos, d);
    if (firstMoves.length > 0) return { mateIn: d, firstMoves };
  }
  return null;
}

// ---------------------------------------------------------------- 問題集

export type CpProblem = {
  id: string;
  title: string;
  /** 局面（手番は常に白）。 */
  fen: string;
  /** 詰ませるまでの白の手数。 */
  mateIn: number;
  /** ほのめかし用の短い説明。 */
  comment: string;
};

/**
 * 収録問題。全て solveMate による機械検証済み
 * （初期局面で黒は王手がかかっておらず、指定手数ちょうどで詰み、初手は1つだけ）。
 */
export const CHESS_PROBLEMS: CpProblem[] = [
  {
    id: "cp1",
    title: "隅の玉にクイーン",
    fen: "k7/8/2K5/1Q6/8/8/8/8 w - - 0 1",
    mateIn: 1,
    comment: "キングに守られたクイーンで、隅の玉を詰ませます。",
  },
  {
    id: "cp2",
    title: "バックランク",
    fen: "7k/6pp/8/8/8/8/8/R3K3 w - - 0 1",
    mateIn: 1,
    comment: "自分のポーンに囲まれたキングは、8段目への一撃に弱いです。",
  },
  {
    id: "cp3",
    title: "ルークとキングの連携",
    fen: "7k/R7/6K1/8/8/8/8/8 w - - 0 1",
    mateIn: 1,
    comment: "ルークの利きとキングの寄りで逃げ場を消します。",
  },
  {
    id: "cp4",
    title: "クイーンの追い込み",
    fen: "8/8/5Q2/8/8/2K5/k7/8 w - - 0 1",
    mateIn: 2,
    comment: "王手をかけ続け、玉を盤の縁へ追い込みます。",
  },
  {
    id: "cp5",
    title: "隅へ追う",
    fen: "8/8/8/6Q1/8/2K5/8/k7 w - - 0 1",
    mateIn: 2,
    comment: "隅にいる玉へ、クイーンを寄せていきます。",
  },
  {
    id: "cp6",
    title: "キングが決め手",
    fen: "8/8/8/1p6/8/8/8/2Q1K2k w - - 0 1",
    mateIn: 2,
    comment: "決め手はクイーンではなく、キングの一歩です。",
  },
  {
    id: "cp7",
    title: "ポーンのある局面",
    fen: "8/3Q4/p7/8/8/5K2/8/7k w - - 0 1",
    mateIn: 2,
    comment: "黒のポーンが逃げ道をふさいでいます。",
  },
  {
    id: "cp8",
    title: "ナイトが支えるルーク",
    fen: "k7/2K5/6R1/2N5/8/8/8/8 w - - 0 1",
    mateIn: 1,
    comment: "ナイトがルークを支え、玉の逃げ道もふさいでいます。",
  },
  {
    id: "cp9",
    title: "昇格が決め手",
    fen: "8/4P3/8/7k/4Q3/8/6K1/8 w - - 0 1",
    mateIn: 2,
    comment: "ポーンの昇格で王手をかけ、2枚のクイーンで詰ませます。",
  },
  {
    id: "cp10",
    title: "隅の玉とポーン",
    fen: "2K5/8/k7/p7/8/8/2Q5/8 w - - 0 1",
    mateIn: 2,
    comment: "黒のポーンが、玉の逃げ道を狭めています。",
  },
  {
    id: "cp11",
    title: "囲いの中の玉",
    fen: "6rk/6pp/8/6N1/8/8/8/6K1 w - - 0 1",
    mateIn: 1,
    comment: "玉は自分の駒に囲まれて身動きが取れません。ナイトの王手は止められません。",
  },
  {
    id: "cp12",
    title: "最速の詰み筋",
    fen: "rnbqkbnr/ppppp2p/5p2/6p1/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1",
    mateIn: 1,
    comment: "序盤の油断が命取り。クイーンの斜めの利きが、囲いの隙間から玉に届きます。",
  },
  {
    id: "cp13",
    title: "キングが開ける道",
    fen: "8/8/8/8/8/8/8/k2KQ3 w - - 0 1",
    mateIn: 2,
    comment: "キングが一歩動くと、後ろに隠れていたクイーンの利きが玉に届きます。",
  },
  {
    id: "cp14",
    title: "隅のビショップ",
    fen: "k1K5/8/B1N5/8/8/8/8/8 w - - 0 1",
    mateIn: 1,
    comment: "ビショップの一撃で詰み。ナイトとキングが、玉の逃げ道をふさいでいます。",
  },
  {
    id: "cp15",
    title: "2枚のビショップ",
    fen: "2K5/k3B3/8/8/8/3B4/8/8 w - - 0 1",
    mateIn: 2,
    comment: "2枚のビショップの斜めの利きが交わり、玉を隅へ追い込みます。",
  },
];

/** 問題が「検証済みの約束」を満たすかを確認する（テストと実行時ガード用）。 */
export function verifyProblem(problem: CpProblem): {
  ok: boolean;
  reason: string;
  firstMoveCount: number;
} {
  const pos = parseFen(problem.fen);
  if (isInCheck(pos.board, "b")) {
    return { ok: false, reason: "初期局面で黒に王手がかかっている", firstMoveCount: 0 };
  }
  if (findKing(pos.board, "w") < 0 || findKing(pos.board, "b") < 0) {
    return { ok: false, reason: "キングが不足している", firstMoveCount: 0 };
  }
  const solved = solveMate(pos, problem.mateIn);
  if (!solved) {
    return { ok: false, reason: "指定手数で詰まない", firstMoveCount: 0 };
  }
  if (solved.mateIn !== problem.mateIn) {
    return {
      ok: false,
      reason: `実際の最短は ${solved.mateIn} 手（指定 ${problem.mateIn} 手）`,
      firstMoveCount: solved.firstMoves.length,
    };
  }
  if (solved.firstMoves.length !== 1) {
    return {
      ok: false,
      reason: `初手が ${solved.firstMoves.length} 通りある`,
      firstMoveCount: solved.firstMoves.length,
    };
  }
  return { ok: true, reason: "", firstMoveCount: 1 };
}

// ---------------------------------------------------------------- ゲーム進行

export type CpStatus = "playing" | "solved";

export type CpSnapshot = {
  position: CpPosition;
  plies: string[];
};

export type CpGameState = {
  problemId: string;
  position: CpPosition;
  status: CpStatus;
  /** ここまでの棋譜（白・黒の順、SAN 風表記）。 */
  plies: string[];
  /** 白が指す前の局面スナップショット（1手戻す用）。 */
  history: CpSnapshot[];
  /** 直近の黒の応手表記。 */
  lastReply: string | null;
  /** 挑戦した白の手数。 */
  attempts: number;
};

export function problemById(id: string): CpProblem {
  const problem = CHESS_PROBLEMS.find((p) => p.id === id) ?? CHESS_PROBLEMS[0];
  if (!problem) throw new Error("詰めチェスの問題がありません");
  return problem;
}

export function createChessPuzzleGame(problemId: string): CpGameState {
  const problem = problemById(problemId);
  return {
    problemId: problem.id,
    position: parseFen(problem.fen),
    status: "playing",
    plies: [],
    history: [],
    lastReply: null,
    attempts: 0,
  };
}

/** 現在指せる白の手（王手になる合法手のみ）。 */
export function playableMoves(state: CpGameState): CpMove[] {
  if (state.status !== "playing") return [];
  return checkingMoves(state.position);
}

function sameMove(a: CpMove, b: CpMove): boolean {
  return a.from === b.from && a.to === b.to && (a.promotion ?? "Q") === (b.promotion ?? "Q");
}

/**
 * 黒の応手の中で「最も粘る」手を選ぶ。
 * 詰みまでの手数が最大の応手を選び、同点なら (from, to) の辞書順で最初の一つ（決定的）。
 * 探索上限を超えて逃げ切れる応手があればそれを最優先する。
 */
export function chooseDefense(posAfterWhite: CpPosition, searchCap: number): CpMove | null {
  const replies = legalMoves(posAfterWhite, "b");
  if (replies.length === 0) return null;
  const sorted = [...replies].sort(
    (a, b) => a.from - b.from || a.to - b.to || (a.promotion ?? "").localeCompare(b.promotion ?? ""),
  );
  let best: CpMove | null = null;
  let bestScore = -1;
  for (const reply of sorted) {
    const next = applyMove(posAfterWhite, reply);
    const solved = solveMate(next, searchCap);
    const score = solved ? solved.mateIn : Number.POSITIVE_INFINITY;
    if (score > bestScore) {
      bestScore = score;
      best = reply;
    }
  }
  return best;
}

/**
 * 白の手を指す。王手でない手・違法手は状態を変えずにそのまま返す。
 * 詰ませれば solved、そうでなければ黒の応手（最も粘る手）を自動で指す。
 */
export function playPuzzleMove(state: CpGameState, move: CpMove): CpGameState {
  if (state.status !== "playing") return state;
  const candidates = checkingMoves(state.position).filter(
    (m) => m.from === move.from && m.to === move.to,
  );
  if (candidates.length === 0) return state;
  const chosen =
    candidates.find((m) => (m.promotion ?? "Q") === (move.promotion ?? "Q")) ?? candidates[0];
  const notation = moveNotation(state.position, chosen);
  const afterWhite = applyMove(state.position, chosen);
  const snapshot: CpSnapshot = {
    position: state.position,
    plies: state.plies,
  };
  if (isCheckmate(afterWhite, "b")) {
    return {
      ...state,
      position: afterWhite,
      status: "solved",
      plies: [...state.plies, notation],
      history: [...state.history, snapshot],
      lastReply: null,
      attempts: state.attempts + 1,
    };
  }
  const defense = chooseDefense(afterWhite, 4);
  if (!defense) return state; // 詰みでもないのに応手がない局面は来ないはず
  const replyNotation = moveNotation(afterWhite, defense);
  const afterBlack = applyMove(afterWhite, defense);
  return {
    ...state,
    position: afterBlack,
    plies: [...state.plies, notation, replyNotation],
    history: [...state.history, snapshot],
    lastReply: replyNotation,
    attempts: state.attempts + 1,
  };
}

/** 白の手を1手戻す（黒の応手も一緒に巻き戻る）。 */
export function undoPuzzleMove(state: CpGameState): CpGameState {
  const last = state.history[state.history.length - 1];
  if (!last) return state;
  return {
    ...state,
    position: last.position,
    plies: last.plies,
    history: state.history.slice(0, -1),
    status: "playing",
    lastReply: null,
  };
}

/** ヒント: ソルバーが見つけた正解の初手（現在の局面から）。無ければ null。 */
export function hintMove(state: CpGameState): CpMove | null {
  if (state.status !== "playing") return null;
  const problem = problemById(state.problemId);
  const remaining = problem.mateIn - state.history.length;
  const solved = solveMate(state.position, Math.max(1, remaining));
  if (!solved || solved.firstMoves.length === 0) return null;
  const sorted = [...solved.firstMoves].sort((a, b) => a.from - b.from || a.to - b.to);
  return sorted[0];
}
