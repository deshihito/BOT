// 橋をかけろの純粋ロジック（UI 非依存・シード決定的）。
// ルール: 島の数字は、その島から出る橋の総数。橋は水平/垂直のみで最大2本まで。
// 橋同士は交差できず、最後は全島が1つにつながることがクリア条件。
// 生成は「解を先に作る」方式: 島を1つずつ生やしながら橋（解）でつなぎ、
// 連結した木を作ってから余分な橋を足すため、必ず解が存在する。
// 状態は JSON 化可能な値のみ。遷移関数は状態を破壊せず新しい状態を返す。

export type HashiSize = 7 | 9;

export type HashiIsland = {
  id: number;
  /** セル index（row * size + col）。 */
  index: number;
  /** 数字（= その島から出る橋の総数）。 */
  need: number;
};

export type HashiState = {
  size: HashiSize;
  seed: number;
  islands: HashiIsland[];
  /** 解（edgeKey -> 1|2）。生成の検証・テスト用に保持する。 */
  solution: Record<string, number>;
  /** 現在の橋（edgeKey -> 0|1|2。0 のキーは持たない）。 */
  bridges: Record<string, number>;
  moves: number;
  status: "playing" | "won";
};

export type HashiEdge = {
  a: number;
  b: number;
  /** 2島の間にあるセル index（橋が通るマス）。 */
  cells: number[];
  orientation: "h" | "v";
};

export type HashiViolation = {
  type: "over" | "crossing" | "mismatch" | "disconnected";
  islandIds: number[];
  message: string;
};

/** mulberry32（minesweeper 等と同一方式）。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function normalizeHashiSize(size: number): HashiSize {
  return size === 9 ? 9 : 7;
}

/** 島同士のペアを表すキー（小さい id を先に）。 */
export function hashiEdgeKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function rowOf(index: number, size: number): number {
  return Math.floor(index / size);
}
function colOf(index: number, size: number): number {
  return index % size;
}

/** 2島の間にあるセル（同行/同列でない・間に島がある場合は null）。 */
function cellsBetween(
  size: number,
  islandsByIndex: Map<number, HashiIsland>,
  a: HashiIsland,
  b: HashiIsland,
): { cells: number[]; orientation: "h" | "v" } | null {
  const ra = rowOf(a.index, size);
  const ca = colOf(a.index, size);
  const rb = rowOf(b.index, size);
  const cb = colOf(b.index, size);
  const cells: number[] = [];
  if (ra === rb) {
    const [from, to] = ca < cb ? [ca, cb] : [cb, ca];
    for (let c = from + 1; c < to; c++) {
      const idx = ra * size + c;
      if (islandsByIndex.has(idx)) return null;
      cells.push(idx);
    }
    return { cells, orientation: "h" };
  }
  if (ca === cb) {
    const [from, to] = ra < rb ? [ra, rb] : [rb, ra];
    for (let r = from + 1; r < to; r++) {
      const idx = r * size + ca;
      if (islandsByIndex.has(idx)) return null;
      cells.push(idx);
    }
    return { cells, orientation: "v" };
  }
  return null;
}

/**
 * 橋をかけられる島ペアの一覧（同行/同列で、間に島が無いペア）。
 * 生成・操作・描画のすべてがこの候補集合を正とする。
 */
export function hashiCandidateEdges(state: Pick<HashiState, "size" | "islands">): HashiEdge[] {
  const { size, islands } = state;
  const byIndex = new Map(islands.map((i) => [i.index, i]));
  const out: HashiEdge[] = [];
  for (let x = 0; x < islands.length; x++) {
    for (let y = x + 1; y < islands.length; y++) {
      const a = islands[x];
      const b = islands[y];
      const between = cellsBetween(size, byIndex, a, b);
      if (between && between.cells.length > 0) {
        out.push({ a: a.id, b: b.id, cells: between.cells, orientation: between.orientation });
      }
    }
  }
  return out;
}

/** セル index が含まれる候補辺（橋の通り道）を返す。島セル・対象外は null。 */
export function hashiEdgeAtCell(
  state: Pick<HashiState, "size" | "islands">,
  index: number,
): HashiEdge | null {
  if (!Number.isInteger(index) || index < 0 || index >= state.size * state.size) return null;
  for (const edge of hashiCandidateEdges(state)) {
    if (edge.cells.includes(index)) return edge;
  }
  return null;
}

/** 現在の橋の本数（島 id の昇順配列と対応）。 */
export function hashiBridgeCount(state: HashiState, a: number, b: number): number {
  return state.bridges[hashiEdgeKey(a, b)] ?? 0;
}

/** 描画用: そのセルを通る現在の橋（本数つき）。交差点では橋のある側を返す。 */
export function hashiCellBridge(
  state: HashiState,
  index: number,
): { orientation: "h" | "v"; count: number } | null {
  if (!Number.isInteger(index) || index < 0 || index >= state.size * state.size) return null;
  for (const edge of hashiCandidateEdges(state)) {
    if (!edge.cells.includes(index)) continue;
    const count = hashiBridgeCount(state, edge.a, edge.b);
    if (count > 0) return { orientation: edge.orientation, count };
  }
  return null;
}

/** 各島から出ている橋の総数（島 id 順）。 */
export function hashiDegrees(state: HashiState): number[] {
  const degrees = new Array<number>(state.islands.length).fill(0);
  for (const edge of hashiCandidateEdges(state)) {
    const count = hashiBridgeCount(state, edge.a, edge.b);
    degrees[edge.a] += count;
    degrees[edge.b] += count;
  }
  return degrees;
}

// ---------------------------------------------------------------- 生成

type GrownPuzzle = {
  positions: number[];
  solution: Record<string, number>;
};

/** 島を生やしながら解の木を作る。条件を満たせなければ null。 */
function growHashi(size: HashiSize, rng: number): { puzzle: GrownPuzzle; rng: number } | null {
  let cur = rng;
  const rand = () => {
    const r = nextRandom(cur);
    cur = r.rng;
    return r.value;
  };
  const randInt = (n: number) => Math.floor(rand() * n);

  const total = size * size;
  const target = size === 7 ? 10 + randInt(3) : 14 + randInt(4); // 7x7:10-12島 / 9x9:14-17島
  const minIslands = size === 7 ? 8 : 11;

  const positions: number[] = [];
  const islandSet = new Set<number>();
  /** 橋が通るセル -> 向き。交差と島の上書き防止に使う。 */
  const segmentDir = new Map<number, "h" | "v">();
  const solution = new Map<string, number>();

  const first = randInt(total);
  positions.push(first);
  islandSet.add(first);

  const DIRS = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const;

  const orthogonallyAdjacentToIsland = (index: number): boolean => {
    const r = rowOf(index, size);
    const c = colOf(index, size);
    for (const [dr, dc] of DIRS) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= size || nc >= size) continue;
      if (islandSet.has(nr * size + nc)) return true;
    }
    return false;
  };

  let attempts = 0;
  const maxAttempts = 900;
  while (positions.length < target && attempts < maxAttempts) {
    attempts++;
    const sourceId = randInt(positions.length);
    const source = positions[sourceId];
    const sr = rowOf(source, size);
    const sc = colOf(source, size);
    const [dr, dc] = DIRS[randInt(4)];
    const dist = 2 + randInt(3); // 2〜4マス先（間に最低1マス）
    const tr = sr + dr * dist;
    const tc = sc + dc * dist;
    if (tr < 0 || tc < 0 || tr >= size || tc >= size) continue;
    const targetIndex = tr * size + tc;
    if (islandSet.has(targetIndex)) continue;
    if (segmentDir.has(targetIndex)) continue;
    if (orthogonallyAdjacentToIsland(targetIndex)) continue;

    const orientation: "h" | "v" = dr === 0 ? "h" : "v";
    const cells: number[] = [];
    let ok = true;
    for (let step = 1; step < dist; step++) {
      const idx = (sr + dr * step) * size + (sc + dc * step);
      if (islandSet.has(idx)) {
        ok = false;
        break;
      }
      const used = segmentDir.get(idx);
      if (used !== undefined && used !== orientation) {
        ok = false; // 交差
        break;
      }
      if (used === orientation) {
        ok = false; // 既存の橋と重なる経路は候補を乱すので避ける
        break;
      }
      cells.push(idx);
    }
    if (!ok) continue;

    const newId = positions.length;
    positions.push(targetIndex);
    islandSet.add(targetIndex);
    for (const idx of cells) segmentDir.set(idx, orientation);
    solution.set(hashiEdgeKey(sourceId, newId), rand() < 0.35 ? 2 : 1);
  }

  if (positions.length < minIslands) return null;

  const islands: HashiIsland[] = positions.map((index, id) => ({ id, index, need: 0 }));

  // 木に含まれない候補辺を少し足して輪を作る（交差しないものだけ）。
  const probe: Pick<HashiState, "size" | "islands"> = { size, islands };
  for (const edge of hashiCandidateEdges(probe)) {
    const key = hashiEdgeKey(edge.a, edge.b);
    if (solution.has(key)) continue;
    const crosses = edge.cells.some((idx) => {
      const used = segmentDir.get(idx);
      return used !== undefined && used !== edge.orientation;
    });
    if (crosses) continue;
    if (rand() < 0.3) {
      solution.set(key, 1);
      for (const idx of edge.cells) segmentDir.set(idx, edge.orientation);
    }
  }
  // 既存の橋を2本へ格上げする候補。
  for (const [key, count] of [...solution.entries()]) {
    if (count === 1 && rand() < 0.25) solution.set(key, 2);
  }

  return { puzzle: { positions, solution: Object.fromEntries(solution) }, rng: cur };
}

/** シードから問題を生成する（解の存在を保証する）。 */
export function generateHashiPuzzle(
  seed: number,
  size: HashiSize,
): { islands: HashiIsland[]; solution: Record<string, number> } {
  let rng = seed | 0;
  for (let attempt = 0; attempt < 300; attempt++) {
    const grown = growHashi(size, rng);
    if (grown) {
      rng = grown.rng;
      const degrees = new Array<number>(grown.puzzle.positions.length).fill(0);
      const byKey = new Map<string, [number, number]>();
      for (const edge of hashiCandidateEdges({
        size,
        islands: grown.puzzle.positions.map((index, id) => ({ id, index, need: 0 })),
      })) {
        byKey.set(hashiEdgeKey(edge.a, edge.b), [edge.a, edge.b]);
      }
      for (const [key, count] of Object.entries(grown.puzzle.solution)) {
        const pair = byKey.get(key);
        if (!pair) continue;
        degrees[pair[0]] += count;
        degrees[pair[1]] += count;
      }
      const islands = grown.puzzle.positions.map((index, id) => ({
        id,
        index,
        need: degrees[id],
      }));
      // 数字 0 の島（孤立）は生成ミスなので作り直す。
      if (islands.every((i) => i.need > 0)) {
        return { islands, solution: grown.puzzle.solution };
      }
    } else {
      const r = nextRandom(rng);
      rng = r.rng;
    }
  }
  throw new Error("橋をかけろの盤面生成に失敗しました");
}

// ---------------------------------------------------------------- 検証

/**
 * ルール違反を調べる。
 * full=false（途中経過）: 数字を超えた島と交差だけを見る。
 * full=true（完成判定）: 数字の一致と全島の連結まで見る。
 */
export function hashiViolations(state: HashiState, full: boolean): HashiViolation[] {
  const violations: HashiViolation[] = [];
  const degrees = hashiDegrees(state);
  const edges = hashiCandidateEdges(state);

  // 交差: 向きの違う2本の橋が同じセルを通っていないか。
  const cellUse = new Map<number, { orientation: "h" | "v"; edgeKey: string }[]>();
  for (const edge of edges) {
    const count = hashiBridgeCount(state, edge.a, edge.b);
    if (count <= 0) continue;
    for (const idx of edge.cells) {
      const list = cellUse.get(idx) ?? [];
      list.push({ orientation: edge.orientation, edgeKey: hashiEdgeKey(edge.a, edge.b) });
      cellUse.set(idx, list);
    }
  }
  const crossedKeys = new Set<string>();
  for (const list of cellUse.values()) {
    if (list.length >= 2 && new Set(list.map((u) => u.orientation)).size > 1) {
      for (const u of list) crossedKeys.add(u.edgeKey);
    }
  }
  if (crossedKeys.size > 0) {
    const islandIds = new Set<number>();
    for (const key of crossedKeys) {
      const [a, b] = key.split("-").map(Number);
      islandIds.add(a);
      islandIds.add(b);
    }
    violations.push({
      type: "crossing",
      islandIds: [...islandIds],
      message: "橋が交差しています",
    });
  }

  state.islands.forEach((island, i) => {
    if (degrees[i] > island.need) {
      violations.push({
        type: "over",
        islandIds: [island.id],
        message: `島の橋が数字（${island.need}）を超えています`,
      });
    } else if (full && degrees[i] !== island.need) {
      violations.push({
        type: "mismatch",
        islandIds: [island.id],
        message: `島の橋の数が数字（${island.need}）と一致しません`,
      });
    }
  });

  if (full && violations.length === 0 && state.islands.length > 0) {
    // 全島の連結（橋のある辺だけでたどる）。
    const adjacency = new Map<number, number[]>();
    for (const edge of edges) {
      if (hashiBridgeCount(state, edge.a, edge.b) <= 0) continue;
      adjacency.set(edge.a, [...(adjacency.get(edge.a) ?? []), edge.b]);
      adjacency.set(edge.b, [...(adjacency.get(edge.b) ?? []), edge.a]);
    }
    const seen = new Set<number>([0]);
    const stack = [0];
    while (stack.length > 0) {
      const cur = stack.pop() as number;
      for (const next of adjacency.get(cur) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    if (seen.size !== state.islands.length) {
      violations.push({
        type: "disconnected",
        islandIds: state.islands.filter((i) => !seen.has(i.id)).map((i) => i.id),
        message: "すべての島がつながっていません",
      });
    }
  }
  return violations;
}

/** 完成判定: 全部の島が数字どおりで、交差がなく、全島が連結している。 */
export function isHashiComplete(state: HashiState): boolean {
  if (state.islands.length === 0) return false;
  return hashiViolations(state, true).length === 0;
}

// ---------------------------------------------------------------- 状態遷移

export function createHashiGame(seed: number, size: HashiSize = 7): HashiState {
  const normalized = normalizeHashiSize(size);
  const puzzle = generateHashiPuzzle(seed, normalized);
  return {
    size: normalized,
    seed,
    islands: puzzle.islands,
    solution: puzzle.solution,
    bridges: {},
    moves: 0,
    status: "playing",
  };
}

/**
 * 島ペアの橋を 0→1→2→0 と循環させる。
 * 候補辺でないペア、交差する橋、完成後の操作は無効（同じ状態を返す）。
 */
export function cycleHashiBridge(state: HashiState, a: number, b: number): HashiState {
  if (state.status === "won") return state;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) return state;
  if (a < 0 || b < 0 || a >= state.islands.length || b >= state.islands.length) return state;
  const edges = hashiCandidateEdges(state);
  const edge = edges.find(
    (e) => (e.a === a && e.b === b) || (e.a === b && e.b === a),
  );
  if (!edge) return state;
  const key = hashiEdgeKey(edge.a, edge.b);
  const current = state.bridges[key] ?? 0;
  const next = (current + 1) % 3;
  if (next > 0) {
    // 交差チェック: 向きの違う既存の橋とセルが重なれば置けない。
    for (const other of edges) {
      if (other === edge) continue;
      if (other.orientation === edge.orientation) continue;
      if (hashiBridgeCount(state, other.a, other.b) <= 0) continue;
      if (other.cells.some((idx) => edge.cells.includes(idx))) return state;
    }
  }
  const bridges = { ...state.bridges };
  if (next === 0) delete bridges[key];
  else bridges[key] = next;
  const moved: HashiState = { ...state, bridges, moves: state.moves + 1 };
  return isHashiComplete(moved) ? { ...moved, status: "won" } : moved;
}
