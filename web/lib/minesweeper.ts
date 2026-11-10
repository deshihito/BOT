// マインスイーパーの純粋ロジック（UI 非依存・シード決定的）。
// 地雷は初回クリック後に、そのマスと周囲を避けて配置する（初手は必ず安全）。

export type MsStatus = "ready" | "playing" | "won" | "lost";

export type MsCell = {
  mine: boolean;
  open: boolean;
  flagged: boolean;
  /** 周囲8マスの地雷数。 */
  count: number;
};

export type MsState = {
  rows: number;
  cols: number;
  mineTotal: number;
  cells: MsCell[];
  status: MsStatus;
  opened: number;
  flags: number;
  planted: boolean;
  /** 地雷を踏んだマスの index（敗北時の表示用）。 */
  exploded: number | null;
  seed: number;
  rng: number;
};

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function createMsGame(rows: number, cols: number, mineTotal: number, seed: number): MsState {
  const cells: MsCell[] = Array.from({ length: rows * cols }, () => ({
    mine: false,
    open: false,
    flagged: false,
    count: 0,
  }));
  return {
    rows,
    cols,
    mineTotal,
    cells,
    status: "ready",
    opened: 0,
    flags: 0,
    planted: false,
    exploded: null,
    seed,
    rng: seed | 0,
  };
}

function neighbors(state: MsState, index: number): number[] {
  const { rows, cols } = state;
  const r = Math.floor(index / cols);
  const c = index % cols;
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      out.push(nr * cols + nc);
    }
  }
  return out;
}

function plant(state: MsState, safeIndex: number): MsState {
  const safe = new Set([safeIndex, ...neighbors(state, safeIndex)]);
  const candidates: number[] = [];
  for (let i = 0; i < state.cells.length; i++) {
    if (!safe.has(i)) candidates.push(i);
  }
  const cells = state.cells.map((cell) => ({ ...cell }));
  let rng = state.rng;
  let placed = 0;
  const pool = [...candidates];
  while (placed < state.mineTotal && pool.length > 0) {
    const r = nextRandom(rng);
    rng = r.rng;
    const pick = Math.floor(r.value * pool.length);
    const idx = pool.splice(pick, 1)[0];
    cells[idx].mine = true;
    placed++;
  }
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].mine) continue;
    cells[i].count = neighbors(state, i).filter((n) => cells[n].mine).length;
  }
  return { ...state, cells, planted: true, rng, mineTotal: placed };
}

export function revealCell(state: MsState, index: number): MsState {
  if (state.status === "won" || state.status === "lost") return state;
  const target = state.cells[index];
  if (!target || target.open || target.flagged) return state;
  let s = state.planted ? state : plant(state, index);
  const cells = s.cells.map((cell) => ({ ...cell }));
  if (cells[index].mine) {
    cells[index].open = true;
    // 敗北時は全ての地雷を見せる
    for (const cell of cells) {
      if (cell.mine) cell.open = true;
    }
    return { ...s, cells, status: "lost", exploded: index };
  }
  // 0 のマスは周囲をまとめて開く（フラッドフィル）
  let opened = s.opened;
  const stack = [index];
  while (stack.length > 0) {
    const i = stack.pop() as number;
    const cell = cells[i];
    if (cell.open || cell.flagged || cell.mine) continue;
    cell.open = true;
    opened++;
    if (cell.count === 0) {
      for (const n of neighbors(s, i)) {
        if (!cells[n].open) stack.push(n);
      }
    }
  }
  const totalSafe = s.rows * s.cols - s.mineTotal;
  const won = opened >= totalSafe;
  return { ...s, cells, opened, status: won ? "won" : "playing" };
}

export function toggleFlag(state: MsState, index: number): MsState {
  if (state.status === "won" || state.status === "lost") return state;
  const target = state.cells[index];
  if (!target || target.open) return state;
  const cells = state.cells.map((cell) => ({ ...cell }));
  cells[index].flagged = !cells[index].flagged;
  return { ...state, cells, flags: state.flags + (cells[index].flagged ? 1 : -1) };
}
