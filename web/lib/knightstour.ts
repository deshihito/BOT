// ナイトツアーの純粋ロジック（UI 非依存・シード決定的）。
// チェスのナイトの動きだけで盤の全マスを1回ずつ訪れるパズル。
// 作成時に Warnsdorff 法＋バックトラックで完全ツアーを構成し、
// 開始マスから全マス巡回できることを保証する（解は state.solution に保持）。
// プレイヤーの経路は解どおりでなくてもよく、自由に進んでよい。
// 行き詰まったら status が "stuck" になり、1手戻すことができる。

export type KtStatus = "playing" | "won" | "stuck";

export type KtState = {
  /** 盤の一辺（5 または 6）。 */
  size: number;
  /** 訪問済みマスの index を訪問順に並べたもの。末尾が現在位置。 */
  path: number[];
  /** 作成時に構成した完全ツアー（到達可能性の保証）。 */
  solution: number[];
  status: KtStatus;
  seed: number;
};

const KNIGHT_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-2, -1],
  [-2, 1],
  [-1, -2],
  [-1, 2],
  [1, -2],
  [1, 2],
  [2, -1],
  [2, 1],
];

/** mulberry32 系。呼び出しごとに rng 関数を返す決定的な乱数。 */
function makeRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** index からナイトが盤内で動ける先（訪問済みかどうかは見ない）。 */
export function knightTargets(size: number, index: number): number[] {
  const r = Math.floor(index / size);
  const c = index % size;
  const out: number[] = [];
  for (const [dr, dc] of KNIGHT_OFFSETS) {
    const nr = r + dr;
    const nc = c + dc;
    if (nr < 0 || nc < 0 || nr >= size || nc >= size) continue;
    out.push(nr * size + nc);
  }
  return out;
}

/** 現在位置から次に動ける未訪問マス。 */
export function legalMoves(state: KtState): number[] {
  if (state.path.length === 0) return [];
  const head = state.path[state.path.length - 1];
  const visited = new Set(state.path);
  return knightTargets(state.size, head).filter((i) => !visited.has(i));
}

/** 訪問済みマップ（index → 訪問順 1 始まり、未訪問は 0）。 */
export function visitOrder(state: KtState): number[] {
  const order = new Array<number>(state.size * state.size).fill(0);
  state.path.forEach((cell, i) => {
    order[cell] = i + 1;
  });
  return order;
}

function statusFor(size: number, path: number[], moves: number[]): KtStatus {
  if (path.length >= size * size) return "won";
  if (moves.length === 0) return "stuck";
  return "playing";
}

/**
 * Warnsdorff 法（次候補の進出可能数が少ない順）＋バックトラックで
 * start から始まる完全ツアーを探す。見つからなければ null。
 */
function findTour(size: number, start: number, rng: () => number): number[] | null {
  const total = size * size;
  const visited = new Array<boolean>(total).fill(false);
  const path: number[] = [start];
  visited[start] = true;
  let nodes = 0;
  const NODE_LIMIT = 2_000_000;

  const dfs = (): boolean => {
    if (path.length >= total) return true;
    if (++nodes > NODE_LIMIT) return false;
    const head = path[path.length - 1];
    const candidates = knightTargets(size, head)
      .filter((i) => !visited[i])
      .map((i) => ({
        cell: i,
        degree: knightTargets(size, i).filter((j) => !visited[j]).length,
        tie: rng(),
      }))
      .sort((a, b) => a.degree - b.degree || a.tie - b.tie);
    for (const cand of candidates) {
      visited[cand.cell] = true;
      path.push(cand.cell);
      if (dfs()) return true;
      path.pop();
      visited[cand.cell] = false;
      if (nodes > NODE_LIMIT) return false;
    }
    return false;
  };

  return dfs() ? [...path] : null;
}

export function createKnightsTour(size: number, seed: number): KtState {
  const n = size === 6 ? 6 : 5;
  const rng = makeRng(seed);
  // 開始マスの候補をシャッフルし、完全ツアーを構成できるマスを採用する。
  const starts = Array.from({ length: n * n }, (_, i) => i);
  for (let i = starts.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [starts[i], starts[j]] = [starts[j], starts[i]];
  }
  let solution: number[] | null = null;
  for (const start of starts) {
    solution = findTour(n, start, rng);
    if (solution) break;
  }
  if (!solution) {
    // 理論上ここには来ないが、安全側に倒して開始マスのみで返す。
    solution = [starts[0]];
  }
  const path = [solution[0]];
  const state: KtState = { size: n, path, solution, status: "playing", seed };
  return { ...state, status: statusFor(n, path, legalMoves(state)) };
}

/** ナイトの動きで未訪問マスへ進む。不正な移動は state をそのまま返す。 */
export function moveKnight(state: KtState, index: number): KtState {
  if (state.status === "won") return state;
  if (!Number.isInteger(index) || index < 0 || index >= state.size * state.size) return state;
  const moves = legalMoves(state);
  if (!moves.includes(index)) return state;
  const path = [...state.path, index];
  const next: KtState = { ...state, path, status: "playing" };
  return { ...next, status: statusFor(state.size, path, legalMoves(next)) };
}

/** 1手戻す。開始マスだけのときは何もしない。 */
export function undoMove(state: KtState): KtState {
  if (state.path.length <= 1) return state;
  const path = state.path.slice(0, -1);
  const next: KtState = { ...state, path, status: "playing" };
  // 戻した先からは、少なくとも今戻した1手が必ず打てるので stuck にはならない。
  return { ...next, status: statusFor(state.size, path, legalMoves(next)) };
}
