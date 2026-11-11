// フルーツマージの純粋ロジック（UI 非依存・シード決定的）。
// 幅6列×高さ10行の箱に、指定した列へフルーツを1個ずつ落とすグリッド版マージ。
// 盤は一次元配列（index = row*COLS+col、row0=最上段）。
// 落下後、同じ段階のフルーツが縦横に2個以上つながっていると、
// グループごとに「一番下（同点なら一番左）」の1マスが次の段階へ合体し、残りは消える。
// 合体で空いた分は列ごとに下へ詰まり、また合体が起きれば連鎖する。
// 解消順序は決定的: 毎パス盤全体を走査して全グループを同時合体→落下、を繰り返す。
// 一番大きいフルーツ（最終段階）は合体しない。天井（最上段）まで埋まった列には落とせず、
// 落とそうとするとゲームオーバーになる。

export const MERGE_COLS = 6;
export const MERGE_ROWS = 10;
export const MERGE_CELLS = MERGE_COLS * MERGE_ROWS;

/** フルーツの段階（小さい順）。index が段階。 */
export const FRUIT_KINDS = [
  { emoji: "🍒", name: "さくらんぼ" },
  { emoji: "🍓", name: "いちご" },
  { emoji: "🍇", name: "ぶどう" },
  { emoji: "🍊", name: "みかん" },
  { emoji: "🍋", name: "レモン" },
  { emoji: "🍎", name: "りんご" },
  { emoji: "🍐", name: "なし" },
  { emoji: "🍑", name: "もも" },
  { emoji: "🍈", name: "メロン" },
  { emoji: "🍉", name: "すいか" },
] as const;

/** 落とせるのは小さい方からこの段階まで。 */
export const MERGE_DROP_MAX_LEVEL = 4;
/** 合体先の段階 L になったときの得点（×連鎖数）。 */
export function mergeScoreFor(level: number): number {
  return (level + 1) * 10;
}

export type MergeFruitState = {
  board: (number | null)[];
  /** 次に落とすフルーツの段階。 */
  current: number;
  /** その次のフルーツの段階。 */
  next: number;
  score: number;
  /** 落とした総数。 */
  dropped: number;
  /** 到達した最大の段階。 */
  maxLevel: number;
  /** このゲームで出た最大連鎖数。 */
  maxChain: number;
  status: "playing" | "gameover";
  rng: number;
  seed: number;
};

/** mulberry32（他 lib と同一方式）。状態に rng を持ち回る。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

/** 小さいフルーツほど出やすい重み付きで段階を1つ引く。 */
function drawFruit(rng: number): { level: number; rng: number } {
  const r = nextRandom(rng);
  // value^2 で小さい方へ寄せる（0 が最も出やすい）。
  const level = Math.min(MERGE_DROP_MAX_LEVEL, Math.floor(r.value * r.value * (MERGE_DROP_MAX_LEVEL + 1)));
  return { level, rng: r.rng };
}

export function createMergeGame(seed: number): MergeFruitState {
  const first = drawFruit(seed | 0);
  const second = drawFruit(first.rng);
  return {
    board: new Array<number | null>(MERGE_CELLS).fill(null),
    current: first.level,
    next: second.level,
    score: 0,
    dropped: 0,
    maxLevel: first.level,
    maxChain: 0,
    status: "playing",
    rng: second.rng,
    seed,
  };
}

/** 列ごとにフルーツを下へ詰める。 */
export function collapseMergeBoard(board: (number | null)[]): (number | null)[] {
  const out = new Array<number | null>(MERGE_CELLS).fill(null);
  for (let c = 0; c < MERGE_COLS; c++) {
    let write = MERGE_ROWS - 1;
    for (let r = MERGE_ROWS - 1; r >= 0; r--) {
      const v = board[r * MERGE_COLS + c];
      if (v !== null) {
        out[write * MERGE_COLS + c] = v;
        write--;
      }
    }
  }
  return out;
}

/**
 * 同じ段階で縦横につながったグループ（2個以上）を全て返す。
 * 最終段階は合体対象から除く。各グループは index の配列。
 */
export function findMergeGroups(board: (number | null)[]): number[][] {
  const visited = new Array<boolean>(MERGE_CELLS).fill(false);
  const groups: number[][] = [];
  const maxLevel = FRUIT_KINDS.length - 1;
  for (let i = 0; i < MERGE_CELLS; i++) {
    const v = board[i];
    if (v === null || v >= maxLevel || visited[i]) continue;
    const group: number[] = [];
    const stack = [i];
    visited[i] = true;
    while (stack.length > 0) {
      const cur = stack.pop() as number;
      group.push(cur);
      const r = Math.floor(cur / MERGE_COLS);
      const c = cur % MERGE_COLS;
      const around: number[] = [];
      if (r > 0) around.push(cur - MERGE_COLS);
      if (r < MERGE_ROWS - 1) around.push(cur + MERGE_COLS);
      if (c > 0) around.push(cur - 1);
      if (c < MERGE_COLS - 1) around.push(cur + 1);
      for (const n of around) {
        if (!visited[n] && board[n] === v) {
          visited[n] = true;
          stack.push(n);
        }
      }
    }
    if (group.length >= 2) groups.push(group);
  }
  return groups;
}

/** グループの合体先（残るマス）: 一番下、同点なら一番左。 */
function groupAnchor(group: number[]): number {
  let anchor = group[0];
  for (const idx of group) {
    const r = Math.floor(idx / MERGE_COLS);
    const c = idx % MERGE_COLS;
    const ar = Math.floor(anchor / MERGE_COLS);
    const ac = anchor % MERGE_COLS;
    if (r > ar || (r === ar && c < ac)) anchor = idx;
  }
  return anchor;
}

export type MergeResolveResult = {
  board: (number | null)[];
  /** 合体で得た得点合計（連鎖ごとに倍率が付く）。 */
  gained: number;
  /** 合体した回数（グループ数）。 */
  merges: number;
  /** 連鎖数（合体が起きなかったら 0）。 */
  chains: number;
  /** 合体で到達した最大の段階（合体なしなら -1）。 */
  bestLevel: number;
};

/** 盤面の合体と連鎖をすべて解決する（盤面レベルの純関数）。 */
export function resolveMergeBoard(boardIn: (number | null)[]): MergeResolveResult {
  let board = [...boardIn];
  let gained = 0;
  let merges = 0;
  let chains = 0;
  let bestLevel = -1;
  for (let guard = 0; guard < 100; guard++) {
    const groups = findMergeGroups(board);
    if (groups.length === 0) break;
    chains++;
    const next = [...board];
    for (const group of groups) {
      const level = board[group[0]] as number;
      const anchor = groupAnchor(group);
      for (const idx of group) next[idx] = null;
      next[anchor] = level + 1;
      gained += mergeScoreFor(level + 1) * chains;
      merges++;
      bestLevel = Math.max(bestLevel, level + 1);
    }
    board = collapseMergeBoard(next);
  }
  return { board, gained, merges, chains, bestLevel };
}

/** 指定列の一番下の空き行。列が満杯なら -1。 */
export function landingRow(board: (number | null)[], col: number): number {
  if (!Number.isInteger(col) || col < 0 || col >= MERGE_COLS) return -1;
  for (let r = MERGE_ROWS - 1; r >= 0; r--) {
    if (board[r * MERGE_COLS + col] === null) return r;
  }
  return -1;
}

/**
 * 指定列へ現在のフルーツを落とす。合体を解決して次のフルーツへ進む。
 * 列が満杯（天井まで埋まっている）なら、その手でゲームオーバーになる。
 * 不正な列は同じ状態を返す。
 */
export function dropFruit(state: MergeFruitState, col: number): MergeFruitState {
  if (state.status !== "playing") return state;
  if (!Number.isInteger(col) || col < 0 || col >= MERGE_COLS) return state;
  const row = landingRow(state.board, col);
  if (row < 0) {
    // 天井まで埋まった列に落とそうとした = ゲームオーバー。
    return { ...state, status: "gameover" };
  }
  const placed = [...state.board];
  placed[row * MERGE_COLS + col] = state.current;
  const resolved = resolveMergeBoard(placed);
  const drawn = drawFruit(state.rng);
  return {
    ...state,
    board: resolved.board,
    current: state.next,
    next: drawn.level,
    rng: drawn.rng,
    score: state.score + resolved.gained,
    dropped: state.dropped + 1,
    maxLevel: Math.max(state.maxLevel, resolved.bestLevel),
    maxChain: Math.max(state.maxChain, resolved.chains),
  };
}
