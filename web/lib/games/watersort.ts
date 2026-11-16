// ウォーターソートの純粋ロジック（UI 非依存・シード決定的）。
// ボトルは色の層の配列（index 0 が底、末尾が上）。容量は4。
// 注ぎルール（標準）: 注ぎ先に空きがあり、一番上の色が同じか、注ぎ先が空のときだけ注げる。
// 注ぐ量は「一番上の色の連続した層」のうち注ぎ先に入る分だけ。
// 問題生成: 完成状態から「逆操作」を繰り返して作る。各逆操作は
//   - あるボトルの一番上の色の層を、全部ではなく一部だけ別のボトルへ移す
//   - 移し先の一番上はその色と異なる（または空）
// という形に限定するため、逆操作を逆順に戻す操作が常に正規の注ぎとして成立し、可解性が保証される。
// 解法（注ぎの列）は state.solution に保持する（テスト・検証用）。

export const WS_CAPACITY = 4;

export type WsMove = { from: number; to: number };

export type WsState = {
  /** ボトルの配列。各ボトルは色 index の配列（底→上）。 */
  bottles: number[][];
  capacity: number;
  colorCount: number;
  moves: number;
  status: "playing" | "won";
  /** アンドゥ用スナップショット（bottles のコピー）。 */
  history: number[][][];
  seed: number;
  /** 生成時に使った逆操作を戻す、解法の注ぎ列。 */
  solution: WsMove[];
};

/** mulberry32。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function topRunLength(bottle: number[]): number {
  if (bottle.length === 0) return 0;
  const top = bottle[bottle.length - 1];
  let n = 0;
  for (let i = bottle.length - 1; i >= 0 && bottle[i] === top; i--) n++;
  return n;
}

/** 完成しているか: 全ボトルが空か、同色で満杯。 */
export function isWsSolved(bottles: number[][], capacity: number = WS_CAPACITY): boolean {
  return bottles.every(
    (b) => b.length === 0 || (b.length === capacity && b.every((c) => c === b[0])),
  );
}

/** from から to へ注げるか（標準ルール）。 */
export function canPour(state: WsState, from: number, to: number): boolean {
  if (state.status !== "playing") return false;
  if (from === to) return false;
  const src = state.bottles[from];
  const dst = state.bottles[to];
  if (!src || !dst) return false;
  if (src.length === 0) return false;
  if (dst.length >= state.capacity) return false;
  if (dst.length === 0) return true;
  return dst[dst.length - 1] === src[src.length - 1];
}

/** 注ぎを実行する。注げない場合は状態をそのまま返す。 */
export function pourWater(state: WsState, from: number, to: number): WsState {
  if (!canPour(state, from, to)) return state;
  const bottles = state.bottles.map((b) => [...b]);
  const src = bottles[from];
  const dst = bottles[to];
  const color = src[src.length - 1];
  const amount = Math.min(topRunLength(src), state.capacity - dst.length);
  for (let i = 0; i < amount; i++) {
    src.pop();
    dst.push(color);
  }
  const won = isWsSolved(bottles, state.capacity);
  return {
    ...state,
    bottles,
    moves: state.moves + 1,
    status: won ? "won" : "playing",
    history: [...state.history, state.bottles.map((b) => [...b])],
  };
}

/** 1手戻す。履歴が無ければ状態をそのまま返す。 */
export function undoWaterSort(state: WsState): WsState {
  if (state.history.length === 0) return state;
  const prev = state.history[state.history.length - 1];
  return {
    ...state,
    bottles: prev.map((b) => [...b]),
    moves: Math.max(0, state.moves - 1),
    status: "playing",
    history: state.history.slice(0, -1),
  };
}

export function createWaterSortGame(seed: number, colorCount: number = 5): WsState {
  const colors = Math.min(7, Math.max(3, Math.floor(colorCount) || 5));
  const capacity = WS_CAPACITY;
  let rng = seed | 0;
  const rand = (n: number) => {
    const r = nextRandom(rng);
    rng = r.rng;
    return Math.floor(r.value * n);
  };

  // 完成状態: 色ごとに満杯のボトル + 空ボトル2本。
  const bottles: number[][] = [];
  for (let c = 0; c < colors; c++) bottles.push(Array.from({ length: capacity }, () => c));
  bottles.push([], []);
  const bottleCount = bottles.length;

  // 逆操作で崩す。各操作の逆（解法側の注ぎ）を記録する。
  const inverseMoves: WsMove[] = [];
  let lastFrom = -1;
  let lastTo = -1;
  let applied = 0;
  let attempts = 0;
  while (applied < 48 && attempts < 600) {
    attempts++;
    const from = rand(bottleCount);
    const to = rand(bottleCount);
    if (from === to) continue;
    if (from === lastTo && to === lastFrom) continue; // 直前の操作の単純な巻き戻しは避ける
    const src = bottles[from];
    const dst = bottles[to];
    if (src.length === 0) continue;
    const run = topRunLength(src);
    if (run < 2) continue; // 層の一部だけを移すため、上の層が2以上必要
    const space = capacity - dst.length;
    if (space <= 0) continue;
    if (dst.length > 0 && dst[dst.length - 1] === src[src.length - 1]) continue; // 移し先の上は別の色
    const maxK = Math.min(run - 1, space);
    if (maxK < 1) continue;
    const k = 1 + rand(maxK);
    const color = src[src.length - 1];
    for (let i = 0; i < k; i++) {
      src.pop();
      dst.push(color);
    }
    inverseMoves.push({ from: to, to: from });
    lastFrom = from;
    lastTo = to;
    applied++;
  }

  // 解法は逆操作を逆順に戻す列。
  const solution = inverseMoves.reverse();
  return {
    bottles,
    capacity,
    colorCount: colors,
    moves: 0,
    status: "playing",
    history: [],
    seed: seed | 0,
    solution,
  };
}
