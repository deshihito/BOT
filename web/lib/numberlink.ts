// ナンバーリンク（フローフリー系）の純粋ロジック（UI 非依存・シード決定的）。
// 同じ数字のペアを線でつなぎ、全マスを線で埋めるパズル。
// 生成は「解を先に作る」方式: 盤面全体を覆うハミルトン路（1本の長い経路）を
// 作り、それを区切って各区間を1ペアにする。端点だけを問題として出すため、
// 区間そのものが解になり、可解性が保証される。
// プレイヤーの線は paths[pair] にセル index の列で保持する。
// 線を他のペアの線の上に引くと、その線は触れた場所で切れる（定番の作法）。

export type NumberlinkSize = 5 | 6;

export type NumberlinkState = {
  size: NumberlinkSize;
  seed: number;
  /** 端点セル → ペア番号（1始まり）。端点でないセルは null。 */
  endpoints: (number | null)[];
  /** ペア数。 */
  pairCount: number;
  /** 生成時の解（ペア番号 → セル列）。検証用に保持する。 */
  solution: number[][];
  /** プレイヤーの線（ペア番号 → セル列。paths[0] は未使用で常に空）。 */
  paths: number[][];
  moves: number;
  status: "playing" | "won";
};

/** mulberry32（minesweeper 等と同一方式）。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function neighborsOf(index: number, size: number): number[] {
  const r = Math.floor(index / size);
  const c = index % size;
  const out: number[] = [];
  if (r > 0) out.push(index - size);
  if (r < size - 1) out.push(index + size);
  if (c > 0) out.push(index - 1);
  if (c < size - 1) out.push(index + 1);
  return out;
}

function adjacent(a: number, b: number, size: number): boolean {
  const ar = Math.floor(a / size);
  const ac = a % size;
  const br = Math.floor(b / size);
  const bc = b % size;
  return Math.abs(ar - br) + Math.abs(ac - bc) === 1;
}

/** 蛇行（牛耕式）のハミルトン路。生成の保険として必ず成功する。 */
function snakePath(size: number): number[] {
  const path: number[] = [];
  for (let r = 0; r < size; r++) {
    if (r % 2 === 0) {
      for (let c = 0; c < size; c++) path.push(r * size + c);
    } else {
      for (let c = size - 1; c >= 0; c--) path.push(r * size + c);
    }
  }
  return path;
}

/**
 * ランダムなハミルトン路を深さ優先探索で作る。
 * 次に進めるマスが少ない候補を優先する（Warnsdorff 的ヒューリスティクス）で
 * 大抵は一気に見つかる。手順数上限を超えたら null を返す。
 */
function hamiltonianPath(
  size: number,
  rand: () => number,
): number[] | null {
  const total = size * size;
  const visited = new Array<boolean>(total).fill(false);
  const path: number[] = [];
  const start = Math.floor(rand() * total);
  visited[start] = true;
  path.push(start);
  let steps = 0;
  const STEP_LIMIT = 20000;

  const dfs = (): boolean => {
    if (path.length === total) return true;
    steps++;
    if (steps > STEP_LIMIT) return false;
    const cur = path[path.length - 1];
    const cands = neighborsOf(cur, size)
      .filter((n) => !visited[n])
      .map((n) => ({
        cell: n,
        degree: neighborsOf(n, size).filter((m) => !visited[m] && m !== cur).length,
        jitter: rand(),
      }))
      .sort((a, b) => a.degree - b.degree || a.jitter - b.jitter);
    for (const cand of cands) {
      visited[cand.cell] = true;
      path.push(cand.cell);
      if (dfs()) return true;
      path.pop();
      visited[cand.cell] = false;
      if (steps > STEP_LIMIT) return false;
    }
    return false;
  };

  return dfs() ? [...path] : null;
}

/** ハミルトン路を区間の列（=解の線）に切り分ける。各区間は3マス以上。 */
function cutIntoPairs(path: number[], size: number, rand: () => number): number[][] {
  const minLen = 3;
  const maxLen = size === 5 ? 6 : 8;
  const segments: number[][] = [];
  let i = 0;
  while (i < path.length) {
    const rest = path.length - i;
    if (rest <= maxLen + minLen) {
      // 残りが短い場合は丸ごと1区間にする（長くなりすぎる場合は半分で割る）。
      if (rest <= maxLen + 2) {
        segments.push(path.slice(i));
        i = path.length;
      } else {
        const half = Math.floor(rest / 2);
        segments.push(path.slice(i, i + half));
        i += half;
        segments.push(path.slice(i));
        i = path.length;
      }
    } else {
      const len = minLen + Math.floor(rand() * (maxLen - minLen + 1));
      segments.push(path.slice(i, i + len));
      i += len;
    }
  }
  return segments;
}

export function createNumberlink(size: number, seed: number): NumberlinkState {
  const n: NumberlinkSize = size === 6 ? 6 : 5;
  let rng = seed | 0;
  const rand = () => {
    const r = nextRandom(rng);
    rng = r.rng;
    return r.value;
  };
  let full: number[] | null = null;
  for (let attempt = 0; attempt < 8 && full === null; attempt++) {
    full = hamiltonianPath(n, rand);
  }
  if (full === null) full = snakePath(n);
  const solution = cutIntoPairs(full, n, rand);
  const total = n * n;
  const endpoints: (number | null)[] = new Array(total).fill(null);
  solution.forEach((seg, idx) => {
    const pair = idx + 1;
    endpoints[seg[0]] = pair;
    endpoints[seg[seg.length - 1]] = pair;
  });
  const pairCount = solution.length;
  return {
    size: n,
    seed: seed | 0,
    endpoints,
    pairCount,
    solution,
    paths: Array.from({ length: pairCount + 1 }, () => [] as number[]),
    moves: 0,
    status: "playing",
  };
}

function clonePaths(paths: number[][]): number[][] {
  return paths.map((p) => [...p]);
}

/** セル → そのセルを通るペア番号（線が無いセルは 0）。 */
export function ownerOf(state: NumberlinkState): number[] {
  const owner = new Array<number>(state.size * state.size).fill(0);
  for (let pair = 1; pair <= state.pairCount; pair++) {
    for (const cell of state.paths[pair]) owner[cell] = pair;
  }
  return owner;
}

/** ペアの2端点 [始点, 終点]。 */
export function pairEndpoints(state: NumberlinkState, pair: number): [number, number] | null {
  const cells: number[] = [];
  state.endpoints.forEach((p, i) => {
    if (p === pair) cells.push(i);
  });
  if (cells.length !== 2) return null;
  return [cells[0], cells[1]];
}

/** ペアの線が両端点をつないでいるか。 */
export function isPairConnected(state: NumberlinkState, pair: number): boolean {
  const ends = pairEndpoints(state, pair);
  if (!ends) return false;
  const path = state.paths[pair];
  if (!path || path.length < 2) return false;
  const [a, b] = ends;
  return (
    (path[0] === a && path[path.length - 1] === b) ||
    (path[0] === b && path[path.length - 1] === a)
  );
}

export type NumberlinkCheck = {
  solved: boolean;
  filled: number;
  total: number;
  connectedPairs: number;
  pairCount: number;
};

/** 完成判定: 全ペアが接続し、全マスが線で埋まっていること。 */
export function checkNumberlink(state: NumberlinkState): NumberlinkCheck {
  const owner = ownerOf(state);
  const filled = owner.filter((o) => o > 0).length;
  let connectedPairs = 0;
  for (let pair = 1; pair <= state.pairCount; pair++) {
    if (isPairConnected(state, pair)) connectedPairs++;
  }
  const total = state.size * state.size;
  return {
    solved: filled === total && connectedPairs === state.pairCount,
    filled,
    total,
    connectedPairs,
    pairCount: state.pairCount,
  };
}

/**
 * 1ストローク分のセル列をペア pair の線として適用する。
 * - ストロークは、pair の端点か、既存の自分の線の上から始めること。
 * - 既存の自分の線の途中から始めた場合はそこまで巻き戻して引き直す。
 * - 他のペアの線を横切ると、その線は横切った位置で切れる。
 * - 他のペアの端点には入らない。反対側の端点に届いたらそこで確定する。
 * 不正なストロークは状態を変えずにそのまま返す。
 */
export function applyStroke(
  state: NumberlinkState,
  pair: number,
  cells: number[],
): NumberlinkState {
  if (state.status === "won") return state;
  if (!Number.isInteger(pair) || pair < 1 || pair > state.pairCount) return state;
  if (!Array.isArray(cells) || cells.length === 0) return state;
  const total = state.size * state.size;
  for (const c of cells) {
    if (!Number.isInteger(c) || c < 0 || c >= total) return state;
  }
  const ends = pairEndpoints(state, pair);
  if (!ends) return state;
  const [endA, endB] = ends;
  const start = cells[0];
  const current = state.paths[pair];
  const startIdx = current.indexOf(start);

  let path: number[];
  if (state.endpoints[start] === pair) {
    // 端点からの引き直しは、反対側の端点から既に線が出ている場合のみ継続扱い。
    if (current.length > 0 && current[current.length - 1] === start) {
      path = [...current];
    } else {
      path = [start];
    }
  } else if (startIdx >= 0) {
    path = current.slice(0, startIdx + 1);
  } else {
    return state;
  }

  const paths = clonePaths(state.paths);
  let changed = false;
  let prev = path[path.length - 1];

  for (let k = 1; k < cells.length; k++) {
    const cell = cells[k];
    if (cell === prev) continue;
    if (!adjacent(prev, cell, state.size)) return state;
    const ep = state.endpoints[cell];
    if (ep !== null && ep !== pair) return state; // 他ペアの端点には入らない
    if (ep === pair && cell !== endA && cell !== endB) return state;

    if (ep === pair) {
      // 自分の反対側の端点に到達 → 確定（残りの入力は無視）。
      const other = path[0] === endA ? endB : endA;
      if (cell === other) {
        path.push(cell);
        changed = true;
        prev = cell;
        break;
      }
      // 始点側の端点に戻るのは無効（その場で何もしない）。
      continue;
    }

    const ownIdx = path.indexOf(cell);
    if (ownIdx >= 0) {
      // 自分の線をさかのぼる → そこまで巻き戻す。
      path = path.slice(0, ownIdx + 1);
      changed = true;
      prev = cell;
      continue;
    }

    // 他のペアの線を横切ったら、その線をこのセルの手前で切る。
    for (let other = 1; other <= state.pairCount; other++) {
      if (other === pair) continue;
      const idx = paths[other].indexOf(cell);
      if (idx >= 0) {
        paths[other] = paths[other].slice(0, idx);
        changed = true;
      }
    }

    path.push(cell);
    changed = true;
    prev = cell;
  }

  // ストロークが端点タップだけ（長さ1）で既存線と異なる場合は引き直しとみなす。
  if (cells.length === 1 && path.length !== current.length) changed = true;
  if (!changed && path.length === current.length && path.every((v, i) => v === current[i])) {
    return state;
  }

  paths[pair] = path;
  const next: NumberlinkState = {
    ...state,
    paths,
    moves: state.moves + 1,
  };
  if (checkNumberlink(next).solved) next.status = "won";
  return next;
}

/** ペアの線を全部消す。 */
export function clearPath(state: NumberlinkState, pair: number): NumberlinkState {
  if (state.status === "won") return state;
  if (!Number.isInteger(pair) || pair < 1 || pair > state.pairCount) return state;
  if (!state.paths[pair] || state.paths[pair].length === 0) return state;
  const paths = clonePaths(state.paths);
  paths[pair] = [];
  return { ...state, paths, moves: state.moves + 1 };
}
