// パイプつなぎの純粋ロジック（UI 非依存・シード決定的）。
// 6x6 グリッドのタイルをタップで90度ずつ回転させ、水源（左端のマス）から
// 排水口（右端のマス）まで水が流れるようにする。
// 生成は「ランダムな経路を先に作り、その経路に沿うタイルを置いてから
// 回転をシャッフルする」方式なので、必ず解が存在する。
// 状態は JSON 化可能な値のみ。遷移関数は状態を破壊せず新しい状態を返す。

export const PIPE_SIZE = 6;

/** 方向: 0=北 1=東 2=南 3=西。開口は方向のビットマスクで表す。 */
export const PIPE_DIRS = [0, 1, 2, 3] as const;
const DIR_DR = [-1, 0, 1, 0];
const DIR_DC = [0, 1, 0, -1];

export type PipeTileKind = "straight" | "curve" | "tee" | "cross" | "end";

export type PipeCell = {
  kind: PipeTileKind;
  /** 時計回りの90度回転回数（0〜3）。 */
  rotation: number;
};

export type PipeStatus = "playing" | "won";

export type PipeState = {
  size: number;
  cells: PipeCell[];
  /** 水源マスの index。 */
  source: number;
  /** 排水口マスの index。 */
  drain: number;
  moves: number;
  status: PipeStatus;
  seed: number;
};

/** 回転0のときの開口（方向ビットマスク）。 */
const BASE_OPENINGS: Record<PipeTileKind, number> = {
  straight: (1 << 0) | (1 << 2), // 北南
  curve: (1 << 0) | (1 << 1), // 北東
  tee: (1 << 0) | (1 << 1) | (1 << 2), // 北東南
  cross: (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3),
  end: 1 << 0, // 北のみ
};

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function oppositeDir(dir: number): number {
  return (dir + 2) % 4;
}

/** タイルの現在の開口方向の配列（0=北 1=東 2=南 3=西）。 */
export function pipeOpenings(cell: PipeCell): number[] {
  const base = BASE_OPENINGS[cell.kind];
  const out: number[] = [];
  for (let d = 0; d < 4; d++) {
    const baseDir = (((d - cell.rotation) % 4) + 4) % 4;
    if (base & (1 << baseDir)) out.push(d);
  }
  return out;
}

function openingsMask(cell: PipeCell): number {
  let mask = 0;
  for (const d of pipeOpenings(cell)) mask |= 1 << d;
  return mask;
}

/**
 * 水源から水が届くマスの集合。水は「自マスがその方向に開いていて、
 * 隣マスが反対方向に開いている」ときだけ隣へ流れる。
 */
export function flowIndices(state: PipeState): number[] {
  const { size, cells } = state;
  const seen = new Set<number>([state.source]);
  const stack = [state.source];
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    const r = Math.floor(cur / size);
    const c = cur % size;
    const mask = openingsMask(cells[cur]);
    for (let d = 0; d < 4; d++) {
      if (!(mask & (1 << d))) continue;
      const nr = r + DIR_DR[d];
      const nc = c + DIR_DC[d];
      if (nr < 0 || nc < 0 || nr >= size || nc >= size) continue;
      const ni = nr * size + nc;
      if (seen.has(ni)) continue;
      if (!(openingsMask(cells[ni]) & (1 << oppositeDir(d)))) continue;
      seen.add(ni);
      stack.push(ni);
    }
  }
  return [...seen];
}

export function isPipeSolved(state: PipeState): boolean {
  return flowIndices(state).includes(state.drain);
}

/** 2つの接続方向から、正解のタイル種別と回転を求める（経路タイル用）。 */
function tileForConnections(conns: number[]): { kind: PipeTileKind; rotation: number } {
  if (conns.length === 1) {
    // end は回転0で北を向くので、接続方向そのものが回転になる。
    return { kind: "end", rotation: conns[0] };
  }
  const [a, b] = conns;
  if (oppositeDir(a) === b) {
    // straight は回転0で北南。東西なら1回転。
    return { kind: "straight", rotation: a === 0 || a === 2 ? 0 : 1 };
  }
  // curve は回転0で北東。{a,b} がその回転で得られる回転を探す。
  for (let r = 0; r < 4; r++) {
    const dirs = [r % 4, (r + 1) % 4].sort((x, y) => x - y);
    const want = [...conns].sort((x, y) => x - y);
    if (dirs[0] === want[0] && dirs[1] === want[1]) return { kind: "curve", rotation: r };
  }
  return { kind: "curve", rotation: 0 };
}

export function createPipeGame(seed: number): PipeState {
  const size = PIPE_SIZE;
  let rng = seed | 0;
  const rand = (): number => {
    const r = nextRandom(rng);
    rng = r.rng;
    return r.value;
  };

  // 1) 左端列のランダムな行から、右端列に到達する自己回避経路を DFS で作る。
  const startRow = Math.floor(rand() * size);
  const start = startRow * size;
  const visited = new Set<number>([start]);
  const path: number[] = [start];
  const dfs = (cur: number): boolean => {
    if (cur % size === size - 1) return true;
    const r = Math.floor(cur / size);
    const c = cur % size;
    const order = [0, 1, 2, 3];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const d of order) {
      const nr = r + DIR_DR[d];
      const nc = c + DIR_DC[d];
      if (nr < 0 || nc < 0 || nr >= size || nc >= size) continue;
      const ni = nr * size + nc;
      if (visited.has(ni)) continue;
      visited.add(ni);
      path.push(ni);
      if (dfs(ni)) return true;
      path.pop();
    }
    return false;
  };
  dfs(start);
  const drain = path[path.length - 1];
  const pathSet = new Set(path);

  // 2) 経路タイルは接続方向から種別と正解回転を決め、回転だけシャッフルする。
  //    経路外はダミータイル（ランダム種別・回転）。
  const cells: PipeCell[] = [];
  for (let i = 0; i < size * size; i++) {
    if (pathSet.has(i)) {
      const idx = path.indexOf(i);
      const conns: number[] = [];
      const r = Math.floor(i / size);
      const c = i % size;
      for (const nb of [path[idx - 1], path[idx + 1]]) {
        if (nb === undefined) continue;
        const nr = Math.floor(nb / size);
        const nc = nb % size;
        for (let d = 0; d < 4; d++) {
          if (r + DIR_DR[d] === nr && c + DIR_DC[d] === nc) conns.push(d);
        }
      }
      const sol = tileForConnections(conns);
      const scramble = Math.floor(rand() * 4);
      cells.push({ kind: sol.kind, rotation: (sol.rotation + scramble) % 4 });
    } else {
      const kinds: PipeTileKind[] = ["straight", "curve", "tee", "cross", "end"];
      const kind = kinds[Math.floor(rand() * kinds.length)];
      cells.push({ kind, rotation: Math.floor(rand() * 4) });
    }
  }

  const state: PipeState = {
    size,
    cells,
    source: start,
    drain,
    moves: 0,
    status: "playing",
    seed: seed | 0,
  };

  // 3) たまたま解けた状態で始まらないよう、経路タイルを1つずつずらす。
  let guard = 0;
  while (isPipeSolved(state) && guard < size * size) {
    const idx = path[guard % path.length];
    state.cells[idx] = { ...state.cells[idx], rotation: (state.cells[idx].rotation + 1) % 4 };
    guard++;
  }
  return state;
}

/** タイルを時計回りに90度回転させる。解けたら won になる。 */
export function rotatePipe(state: PipeState, index: number): PipeState {
  if (state.status !== "playing") return state;
  if (!Number.isInteger(index) || index < 0 || index >= state.cells.length) return state;
  const cells = state.cells.map((cell, i) =>
    i === index ? { ...cell, rotation: (cell.rotation + 1) % 4 } : cell,
  );
  const next: PipeState = { ...state, cells, moves: state.moves + 1 };
  if (isPipeSolved(next)) next.status = "won";
  return next;
}
