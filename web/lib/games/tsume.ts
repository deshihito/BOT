// 詰将棋の純粋ロジック（UI 非依存・決定的）。
// 攻め方（A）は王手の連続で玉方（D）の玉を詰ませる。玉方は全ての合法手
// （玉の移動・王手駒の捕獲・合い駒（盤上の移動と持ち駒の打ち））で応じる。
// 座標: index = y * 9 + x。x = 9 - 筋（左端が9筋）、y = 段 - 1（上段が1段）。
// 攻め方は下段（9段側）から上段へ進む（dy = -1 が前）。

export type TsumeSide = "A" | "D";

/** 駒コード。+ は成り駒（+B=馬、+R=龍）。 */
export type TsumePiece =
  | "P" | "L" | "N" | "S" | "G" | "B" | "R" | "K"
  | "+P" | "+L" | "+N" | "+S" | "+B" | "+R";

/** 持ち駒になれる素の駒。 */
export type TsumeBasePiece = "P" | "L" | "N" | "S" | "G" | "B" | "R";

export interface TsumeCell {
  side: TsumeSide;
  piece: TsumePiece;
}

export interface TsumePosition {
  board: (TsumeCell | null)[];
  handA: Partial<Record<TsumeBasePiece, number>>;
  handD: Partial<Record<TsumeBasePiece, number>>;
}

/** from = -1 は持ち駒の打ち。その場合 drop に素の駒コードが入る。piece は着地後の駒。 */
export interface TsumeMove {
  side: TsumeSide;
  from: number;
  to: number;
  piece: TsumePiece;
  drop: TsumeBasePiece | null;
  promote: boolean;
}

export const PIECE_LABEL: Record<TsumePiece, string> = {
  P: "歩", L: "香", N: "桂", S: "銀", G: "金", B: "角", R: "飛", K: "玉",
  "+P": "と", "+L": "成香", "+N": "成桂", "+S": "成銀", "+B": "馬", "+R": "龍",
};

const BASE_OF: Record<TsumePiece, TsumeBasePiece | "K"> = {
  P: "P", L: "L", N: "N", S: "S", G: "G", B: "B", R: "R", K: "K",
  "+P": "P", "+L": "L", "+N": "N", "+S": "S", "+B": "B", "+R": "R",
};

const PROMOTABLE: ReadonlySet<TsumePiece> = new Set(["P", "L", "N", "S", "B", "R"]);

const GOLD_STEPS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [-1, -1], [1, -1], [-1, 0], [1, 0], [0, 1],
];
const SILVER_STEPS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [-1, -1], [1, -1], [-1, 1], [1, 1],
];
const KING_STEPS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [-1, -1], [1, -1], [-1, 0], [1, 0], [0, 1], [-1, 1], [1, 1],
];
const DIAG_SLIDES: ReadonlyArray<readonly [number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
const ORTHO_SLIDES: ReadonlyArray<readonly [number, number]> = [[0, -1], [0, 1], [-1, 0], [1, 0]];

function stepDirs(piece: TsumePiece): ReadonlyArray<readonly [number, number]> {
  switch (piece) {
    case "P": return [[0, -1]];
    case "N": return [[-1, -2], [1, -2]];
    case "S": return SILVER_STEPS;
    case "G": case "+P": case "+L": case "+N": case "+S": return GOLD_STEPS;
    case "K": return KING_STEPS;
    case "+B": return ORTHO_SLIDES;
    case "+R": return DIAG_SLIDES;
    default: return [];
  }
}

function slideDirs(piece: TsumePiece): ReadonlyArray<readonly [number, number]> {
  switch (piece) {
    case "L": return [[0, -1]];
    case "B": case "+B": return DIAG_SLIDES;
    case "R": case "+R": return ORTHO_SLIDES;
    default: return [];
  }
}

/** index から「筋段」表記（例: 左上 = "91"、右下 = "19"）。 */
export function squareName(index: number): string {
  const x = index % 9;
  const y = Math.floor(index / 9);
  return `${9 - x}${y + 1}`;
}

/** 「筋段」表記から index へ。不正な表記は -1。 */
export function indexOfSquare(name: string): number {
  if (!/^[1-9][1-9]$/.test(name)) return -1;
  const file = Number(name[0]);
  const rank = Number(name[1]);
  return (rank - 1) * 9 + (9 - file);
}

function inZone(side: TsumeSide, y: number): boolean {
  return side === "A" ? y <= 2 : y >= 6;
}

/** 成らずに置いたら行き場がなくなる段か（side 視点）。 */
function deadRank(side: TsumeSide, piece: TsumePiece, y: number): boolean {
  if (piece === "P" || piece === "L") return side === "A" ? y === 0 : y === 8;
  if (piece === "N") return side === "A" ? y <= 1 : y >= 7;
  return false;
}

function clonePosition(pos: TsumePosition): TsumePosition {
  return {
    board: pos.board.map((c) => (c ? { ...c } : null)),
    handA: { ...pos.handA },
    handD: { ...pos.handD },
  };
}

function handOf(pos: TsumePosition, side: TsumeSide): Partial<Record<TsumeBasePiece, number>> {
  return side === "A" ? pos.handA : pos.handD;
}

/** 指定マスが bySide の駒の利きにあるか。 */
export function isAttacked(pos: TsumePosition, target: number, bySide: TsumeSide): boolean {
  const tx = target % 9;
  const ty = Math.floor(target / 9);
  const dirSign = bySide === "A" ? 1 : -1;
  for (let i = 0; i < 81; i++) {
    const cell = pos.board[i];
    if (!cell || cell.side !== bySide) continue;
    const x = i % 9;
    const y = Math.floor(i / 9);
    for (const [dx, dy] of stepDirs(cell.piece)) {
      if (x + dx === tx && y + dy * dirSign === ty) return true;
    }
    for (const [dx, dy] of slideDirs(cell.piece)) {
      let nx = x + dx;
      let ny = y + dy * dirSign;
      while (nx >= 0 && nx < 9 && ny >= 0 && ny < 9) {
        if (nx === tx && ny === ty) return true;
        if (pos.board[ny * 9 + nx]) break;
        nx += dx;
        ny += dy * dirSign;
      }
    }
  }
  return false;
}

export function kingIndex(pos: TsumePosition, side: TsumeSide): number {
  for (let i = 0; i < 81; i++) {
    const cell = pos.board[i];
    if (cell && cell.side === side && cell.piece === "K") return i;
  }
  return -1;
}

export function inCheck(pos: TsumePosition, side: TsumeSide): boolean {
  const k = kingIndex(pos, side);
  if (k < 0) return false;
  return isAttacked(pos, k, side === "A" ? "D" : "A");
}

/** 移動・打ちの候補（自玉の安全は見ない素の合法性まで）。 */
function pseudoMoves(pos: TsumePosition, side: TsumeSide): TsumeMove[] {
  const moves: TsumeMove[] = [];
  const dirSign = side === "A" ? 1 : -1;
  const hand = handOf(pos, side);

  for (let i = 0; i < 81; i++) {
    const cell = pos.board[i];
    if (!cell || cell.side !== side) continue;
    const x = i % 9;
    const y = Math.floor(i / 9);
    const dests: number[] = [];
    for (const [dx, dy] of stepDirs(cell.piece)) {
      const nx = x + dx;
      const ny = y + dy * dirSign;
      if (nx < 0 || nx >= 9 || ny < 0 || ny >= 9) continue;
      dests.push(ny * 9 + nx);
    }
    for (const [dx, dy] of slideDirs(cell.piece)) {
      let nx = x + dx;
      let ny = y + dy * dirSign;
      while (nx >= 0 && nx < 9 && ny >= 0 && ny < 9) {
        const idx = ny * 9 + nx;
        dests.push(idx);
        if (pos.board[idx]) break;
        nx += dx;
        ny += dy * dirSign;
      }
    }
    for (const to of dests) {
      const occ = pos.board[to];
      if (occ && occ.side === side) continue;
      if (occ && occ.piece === "K") continue; // 玉は取らない（詰みで決着する）
      const toY = Math.floor(to / 9);
      const canPromote =
        PROMOTABLE.has(cell.piece) && (inZone(side, y) || inZone(side, toY));
      if (deadRank(side, cell.piece, toY)) {
        if (canPromote) moves.push({ side, from: i, to, piece: ("+" + cell.piece) as TsumePiece, drop: null, promote: true });
        continue;
      }
      moves.push({ side, from: i, to, piece: cell.piece, drop: null, promote: false });
      if (canPromote) {
        moves.push({ side, from: i, to, piece: ("+" + cell.piece) as TsumePiece, drop: null, promote: true });
      }
    }
  }

  // 持ち駒の打ち
  for (const base of Object.keys(hand) as TsumeBasePiece[]) {
    if (!hand[base]) continue;
    for (let to = 0; to < 81; to++) {
      if (pos.board[to]) continue;
      const toY = Math.floor(to / 9);
      if (deadRank(side, base, toY)) continue;
      if (base === "P") {
        // 二歩: 同じ筋に自分の未成の歩があれば打てない
        const x = to % 9;
        let nifu = false;
        for (let yy = 0; yy < 9; yy++) {
          const c = pos.board[yy * 9 + x];
          if (c && c.side === side && c.piece === "P") { nifu = true; break; }
        }
        if (nifu) continue;
      }
      moves.push({ side, from: -1, to, piece: base, drop: base, promote: false });
    }
  }
  return moves;
}

export function applyMove(pos: TsumePosition, move: TsumeMove): TsumePosition {
  const next = clonePosition(pos);
  if (move.from === -1 && move.drop) {
    const h = handOf(next, move.side);
    h[move.drop] = (h[move.drop] ?? 0) - 1;
    if (h[move.drop] === 0) delete h[move.drop];
    next.board[move.to] = { side: move.side, piece: move.drop };
    return next;
  }
  const cell = next.board[move.from];
  if (!cell) return next;
  const captured = next.board[move.to];
  next.board[move.to] = { side: cell.side, piece: move.piece };
  next.board[move.from] = null;
  if (captured && captured.piece !== "K") {
    const base = BASE_OF[captured.piece];
    if (base !== "K") {
      const h = handOf(next, cell.side);
      h[base] = (h[base] ?? 0) + 1;
    }
  }
  return next;
}

/**
 * 完全な合法手。玉方は自玉の安全を満たす手だけ。
 * 攻め方は打ち歩詰め（歩を打って詰ませる手）のみ禁止する。
 * ※ 歩の打ちで王手がかかる場合、その歩自体が王手駒になるので、
 *    その局面が詰みなら打ち歩詰めとして一律に除く（連珠的な例外は扱わない）。
 */
export function generateMoves(pos: TsumePosition, side: TsumeSide): TsumeMove[] {
  const raw = pseudoMoves(pos, side);
  if (side === "D") {
    return raw.filter((m) => !inCheck(applyMove(pos, m), "D"));
  }
  return raw.filter((m) => {
    if (m.drop === "P") {
      const next = applyMove(pos, m);
      if (inCheck(next, "D") && isMated(next)) return false;
    }
    return true;
  });
}

/** 玉方が詰んでいるか（王手がかかって合法手がない）。 */
export function isMated(pos: TsumePosition): boolean {
  if (kingIndex(pos, "D") < 0) return false;
  if (!inCheck(pos, "D")) return false;
  return generateMoves(pos, "D").length === 0;
}

/** 攻め方の王手になる手だけ。 */
export function checkingMoves(pos: TsumePosition): TsumeMove[] {
  return generateMoves(pos, "A").filter((m) => inCheck(applyMove(pos, m), "D"));
}

// ------------------------------------------------------------ solver

const solverCache = new Map<string, number>();

function positionKey(pos: TsumePosition, depth: number): string {
  let s = `${depth}|`;
  for (const c of pos.board) s += c ? (c.side === "A" ? c.piece : c.piece.toLowerCase()) + "," : ".,";
  const dump = (h: Partial<Record<TsumeBasePiece, number>>) =>
    (Object.keys(h) as TsumeBasePiece[]).sort().map((k) => `${k}${h[k]}`).join("");
  return s + "|" + dump(pos.handA) + "|" + dump(pos.handD);
}

/**
 * 攻め方の手番から数えて、あと何手（攻め方の手数）で詰むか。
 * maxMoves 以内で詰まなければ Infinity。
 */
export function mateDistance(pos: TsumePosition, maxMoves: number): number {
  if (maxMoves <= 0) return Infinity;
  const key = positionKey(pos, maxMoves);
  const cached = solverCache.get(key);
  if (cached !== undefined) return cached;
  let best = Infinity;
  for (const move of checkingMoves(pos)) {
    const next = applyMove(pos, move);
    if (isMated(next)) { best = 1; break; }
    if (maxMoves === 1) continue;
    const defs = generateMoves(next, "D");
    if (defs.length === 0) { best = 1; break; } // 王手後に合法手なし = 詰み
    let worst = 0;
    let allMate = true;
    for (const d of defs) {
      const sub = mateDistance(applyMove(next, d), maxMoves - 1);
      if (sub === Infinity) { allMate = false; break; }
      if (sub > worst) worst = sub;
    }
    if (allMate && 1 + worst < best) best = 1 + worst;
    if (best === 1) break;
  }
  solverCache.set(key, best);
  return best;
}

export interface TsumeSolution {
  mate: boolean;
  /** 詰みまでの攻め方の手数（mate でない場合は 0）。 */
  moves: number;
  /** 最善の初手（詰ませられる初手すべて）。 */
  winningFirstMoves: TsumeMove[];
}

export function solveTsume(pos: TsumePosition, maxMoves: number): TsumeSolution {
  const dist = mateDistance(pos, maxMoves);
  if (dist === Infinity) return { mate: false, moves: 0, winningFirstMoves: [] };
  const winning: TsumeMove[] = [];
  for (const move of checkingMoves(pos)) {
    const next = applyMove(pos, move);
    if (isMated(next)) { if (dist === 1) winning.push(move); continue; }
    if (dist === 1) continue;
    const defs = generateMoves(next, "D");
    if (defs.length === 0) { winning.push(move); continue; }
    let worst = 0;
    let allMate = true;
    for (const d of defs) {
      const sub = mateDistance(applyMove(next, d), dist - 1);
      if (sub === Infinity) { allMate = false; break; }
      if (sub > worst) worst = sub;
    }
    if (allMate && 1 + worst === dist) winning.push(move);
  }
  return { mate: true, moves: dist, winningFirstMoves: winning };
}

/**
 * 玉方の応手を選ぶ。残り手数内で詰みを逃れられる手があればそれを、
 * なければ最も詰みが遅くなる手を返す（同点は生成順で決定的）。
 */
export function chooseDefense(posAfterCheck: TsumePosition, remainingAttackerMoves: number): TsumeMove | null {
  const defs = generateMoves(posAfterCheck, "D");
  if (defs.length === 0) return null;
  let bestMove: TsumeMove | null = null;
  let bestScore = -1;
  for (const d of defs) {
    const sub = mateDistance(applyMove(posAfterCheck, d), remainingAttackerMoves);
    const score = sub === Infinity ? Number.MAX_SAFE_INTEGER : sub;
    if (score > bestScore) { bestScore = score; bestMove = d; }
  }
  return bestMove;
}

/** 手の表示名（例: "22金"、"11角成"、"12歩打"）。 */
export function moveLabel(pos: TsumePosition, move: TsumeMove): string {
  const base = `${squareName(move.to)}${PIECE_LABEL[move.piece]}`;
  if (move.drop) return `${base}打`;
  void pos;
  return move.promote ? `${base}成` : base;
}

// ------------------------------------------------------------ problems

export interface TsumeProblem {
  id: string;
  title: string;
  /** 1手詰め / 3手詰め。 */
  moves: 1 | 3;
  board: { at: string; piece: TsumePiece; side: TsumeSide }[];
  handA?: Partial<Record<TsumeBasePiece, number>>;
  handD?: Partial<Record<TsumeBasePiece, number>>;
}

export function problemPosition(problem: TsumeProblem): TsumePosition {
  const board: (TsumeCell | null)[] = Array.from({ length: 81 }, () => null);
  for (const entry of problem.board) {
    const idx = indexOfSquare(entry.at);
    if (idx >= 0) board[idx] = { side: entry.side, piece: entry.piece };
  }
  return { board, handA: { ...(problem.handA ?? {}) }, handD: { ...(problem.handD ?? {}) } };
}

// 収録問題は全て solveTsume で「指定手数で詰み・初手が1つだけ」を機械検証済み。
export const TSUME_PROBLEMS: TsumeProblem[] = [
  {
    id: "atama-kin-1",
    title: "頭金の基本",
    moves: 1,
    board: [
      { at: "11", piece: "K", side: "D" },
      { at: "56", piece: "B", side: "A" },
    ],
    handA: { G: 1 },
  },
  {
    id: "atama-kin-2",
    title: "隅の玉に頭金",
    moves: 1,
    board: [
      { at: "91", piece: "K", side: "D" },
      { at: "65", piece: "B", side: "A" },
    ],
    handA: { G: 1 },
  },
  {
    id: "uma-dukuri",
    title: "飛車打ちから馬づくり",
    moves: 3,
    board: [
      { at: "92", piece: "K", side: "D" },
      { at: "93", piece: "B", side: "D" },
      { at: "46", piece: "B", side: "A" },
      { at: "56", piece: "S", side: "A" },
    ],
    handA: { G: 1, R: 1 },
  },
  {
    id: "gin-kin-relay",
    title: "銀と金の連続王手",
    moves: 3,
    board: [
      { at: "11", piece: "K", side: "D" },
      { at: "22", piece: "B", side: "D" },
      { at: "25", piece: "R", side: "A" },
    ],
    handA: { P: 1, G: 1, S: 1 },
  },
  {
    id: "ryu-kin",
    title: "龍と金で隅に追う",
    moves: 3,
    board: [
      { at: "81", piece: "K", side: "D" },
      { at: "91", piece: "G", side: "D" },
      { at: "63", piece: "R", side: "A" },
    ],
    handA: { G: 1, S: 1 },
  },
  {
    id: "atama-kin-3",
    title: "三筋の玉に頭金",
    moves: 1,
    board: [
      { at: "31", piece: "K", side: "D" },
      { at: "54", piece: "B", side: "A" },
    ],
    handA: { G: 1 },
  },
  {
    id: "ryu-yose",
    title: "龍の寄せ",
    moves: 1,
    board: [
      { at: "91", piece: "K", side: "D" },
      { at: "92", piece: "P", side: "D" },
      { at: "76", piece: "+R", side: "A" },
    ],
  },
  {
    id: "kaku-hi-kin",
    title: "角打ちから飛車と金",
    moves: 3,
    board: [
      { at: "91", piece: "K", side: "D" },
      { at: "49", piece: "R", side: "A" },
    ],
    handA: { G: 1, B: 1 },
  },
  {
    id: "sumi-gin",
    title: "隅の玉に銀打ち",
    moves: 1,
    board: [
      { at: "11", piece: "K", side: "D" },
      { at: "32", piece: "R", side: "A" },
    ],
    handA: { S: 1 },
  },
  {
    id: "kaku-gin-3",
    title: "角と銀で追い詰める",
    moves: 3,
    board: [
      { at: "12", piece: "K", side: "D" },
      { at: "22", piece: "G", side: "D" },
      { at: "14", piece: "S", side: "A" },
      { at: "25", piece: "B", side: "A" },
    ],
    handA: { G: 1, R: 1 },
  },
  {
    id: "hi-narabi",
    title: "2枚の飛車で詰ます",
    moves: 1,
    board: [
      { at: "61", piece: "K", side: "D" },
      { at: "52", piece: "R", side: "A" },
    ],
    handA: { R: 1 },
  },
  {
    id: "ryu-hi-yose",
    title: "龍と飛車で追い詰める",
    moves: 3,
    board: [
      { at: "81", piece: "K", side: "D" },
      { at: "78", piece: "+R", side: "A" },
      { at: "64", piece: "P", side: "A" },
    ],
    handA: { R: 2 },
    handD: { S: 1 },
  },
  {
    id: "atama-kin-4",
    title: "七筋の玉に頭金",
    moves: 1,
    board: [
      { at: "71", piece: "K", side: "D" },
      { at: "45", piece: "B", side: "A" },
    ],
    handA: { G: 1 },
  },
  {
    id: "ryu-gin-3",
    title: "龍と銀で追い込む",
    moves: 3,
    board: [
      { at: "92", piece: "K", side: "D" },
      { at: "81", piece: "S", side: "D" },
      { at: "85", piece: "+R", side: "A" },
    ],
    handA: { S: 1 },
  },
];

export const TSUME_PROBLEM_MAP: Record<string, TsumeProblem> = Object.fromEntries(
  TSUME_PROBLEMS.map((p) => [p.id, p]),
);

// ------------------------------------------------------------ game state

export type TsumeStatus = "playing" | "cleared" | "failed";

export interface TsumeGameState {
  problem: TsumeProblem;
  pos: TsumePosition;
  /** 攻め方が指した手数。 */
  movesUsed: number;
  status: TsumeStatus;
  /** 表示用メッセージ（王手でない・詰まない等の案内）。 */
  message: string;
  /** 指し手の履歴（攻め方・玉方を交互に並べた表示名）。 */
  line: string[];
  /** 取り消し用: 攻め方が指す直前の局面スナップショット。 */
  snapshots: TsumePosition[];
}

export function createTsumeGame(problemId: string): TsumeGameState {
  const problem = TSUME_PROBLEM_MAP[problemId] ?? TSUME_PROBLEMS[0];
  return {
    problem,
    pos: problemPosition(problem),
    movesUsed: 0,
    status: "playing",
    message: `${problem.moves}手詰めです。王手を続けて玉を詰ませましょう。`,
    line: [],
    snapshots: [],
  };
}

function sameMove(a: TsumeMove, b: TsumeMove): boolean {
  return a.side === b.side && a.from === b.from && a.to === b.to && a.piece === b.piece && a.drop === b.drop;
}

/** 攻め方の合法手（全て。王手かどうかは checkingMoves で判定できる）。 */
export function attackerMoves(state: TsumeGameState): TsumeMove[] {
  return generateMoves(state.pos, "A");
}

/**
 * 攻め方の手を指す。王手でなければ局面は進めず案内を返す。
 * 王手のあとはソルバーで玉方の応手（詰み逃れ優先）を自動で指す。
 */
export function playAttackerMove(state: TsumeGameState, move: TsumeMove): TsumeGameState {
  if (state.status !== "playing") return state;
  const legal = generateMoves(state.pos, "A");
  const found = legal.find((m) => sameMove(m, move));
  if (!found) return { ...state, message: "その手は指せません。" };
  const next = applyMove(state.pos, found);
  if (!inCheck(next, "D")) {
    return { ...state, message: "詰将棋は王手の連続です。王手になる手を指してください。" };
  }
  const snapshots = [...state.snapshots, state.pos];
  const line = [...state.line, moveLabel(state.pos, found)];
  const movesUsed = state.movesUsed + 1;
  if (isMated(next)) {
    return {
      ...state, pos: next, movesUsed, snapshots, line,
      status: "cleared",
      message: `詰み！ ${movesUsed}手で詰ませました。`,
    };
  }
  const remaining = state.problem.moves - movesUsed;
  const defense = chooseDefense(next, remaining);
  if (!defense) {
    return {
      ...state, pos: next, movesUsed, snapshots, line,
      status: "cleared",
      message: `詰み！ ${movesUsed}手で詰ませました。`,
    };
  }
  const afterDefense = applyMove(next, defense);
  const defenseLabel = moveLabel(next, defense);
  if (mateDistance(afterDefense, remaining) === Infinity) {
    return {
      ...state, pos: afterDefense, movesUsed, snapshots,
      line: [...line, defenseLabel],
      status: "failed",
      message: "その王手では詰みません。玉に逃げられました。「1手戻す」で考え直しましょう。",
    };
  }
  return {
    ...state, pos: afterDefense, movesUsed, snapshots,
    line: [...line, defenseLabel],
    status: "playing",
    message: `あと ${remaining} 手で詰む手順があります。王手を続けてください。`,
  };
}

/** 攻め方の直前の手（と玉方の応手）を取り消す。 */
export function undoAttackerMove(state: TsumeGameState): TsumeGameState {
  const snap = state.snapshots[state.snapshots.length - 1];
  if (!snap) return state;
  return {
    ...state,
    pos: snap,
    movesUsed: Math.max(0, state.movesUsed - 1),
    snapshots: state.snapshots.slice(0, -1),
    line: state.line.slice(0, Math.max(0, (state.snapshots.length - 1) * 2)),
    status: "playing",
    message: "1手戻しました。",
  };
}
