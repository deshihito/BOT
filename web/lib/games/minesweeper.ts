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

function neighborsOf(rows: number, cols: number, index: number): number[] {
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

function neighbors(state: MsState, index: number): number[] {
  return neighborsOf(state.rows, state.cols, index);
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

/**
 * 推測なしで解けるかを論理ソルバーで検証する。
 * 初手マスを開いた状態から、数字マスの制約（基本ルール＋部分集合の差分）だけで
 * 全ての安全マスを開き切れる場合に true。地雷の実配置に対する検証であり、
 * 導出は制約からの論理的帰結のみを使う（総当たりはしない）。
 */
export function isSolvableWithoutGuessing(
  rows: number,
  cols: number,
  mines: boolean[],
  startIndex: number,
): boolean {
  const total = rows * cols;
  if (startIndex < 0 || startIndex >= total || mines[startIndex]) return false;
  const nbrs: number[][] = Array.from({ length: total }, (_, i) => neighborsOf(rows, cols, i));
  const counts = new Array<number>(total).fill(0);
  let mineTotal = 0;
  for (let i = 0; i < total; i++) {
    if (mines[i]) {
      mineTotal++;
      continue;
    }
    counts[i] = nbrs[i].filter((n) => mines[n]).length;
  }
  const open = new Array<boolean>(total).fill(false);
  const knownMine = new Array<boolean>(total).fill(false);
  let openedCount = 0;
  const flood = (start: number) => {
    const stack = [start];
    while (stack.length > 0) {
      const i = stack.pop() as number;
      if (open[i] || knownMine[i] || mines[i]) continue;
      open[i] = true;
      openedCount++;
      if (counts[i] === 0) {
        for (const n of nbrs[i]) {
          if (!open[n]) stack.push(n);
        }
      }
    }
  };
  flood(startIndex);
  const totalSafe = total - mineTotal;

  // global = 全体制約（残り地雷数）。基本ルールにだけ使い、部分集合差分の対象からは外す。
  type Constraint = { cells: number[]; need: number; global?: boolean };
  // 論理推論を進展が無くなるまで繰り返す
  for (let round = 0; round < total + 2 && openedCount < totalSafe; round++) {
    // 現在の開示状況から制約を集める
    const constraints: Constraint[] = [];
    let knownMineCount = 0;
    for (let i = 0; i < total; i++) if (knownMine[i]) knownMineCount++;
    for (let i = 0; i < total; i++) {
      if (!open[i] || counts[i] === 0) continue;
      const hidden: number[] = [];
      let flagged = 0;
      for (const n of nbrs[i]) {
        if (knownMine[n]) flagged++;
        else if (!open[n]) hidden.push(n);
      }
      if (hidden.length === 0) continue;
      const need = counts[i] - flagged;
      if (need < 0 || need > hidden.length) return false; // 論理矛盾（通常起きない）
      constraints.push({ cells: hidden, need });
    }
    // 全体制約（残り地雷数）も加えると終盤の詰めに効く
    const allHidden: number[] = [];
    for (let i = 0; i < total; i++) {
      if (!open[i] && !knownMine[i]) allHidden.push(i);
    }
    if (allHidden.length > 0) {
      constraints.push({ cells: allHidden, need: mineTotal - knownMineCount, global: true });
    }

    // 制約集合の中で基本ルールと部分集合差分を伝播させる
    const foundSafe = new Set<number>();
    const foundMine = new Set<number>();
    const seenKeys = new Set(constraints.map((c) => c.cells.join(",")));
    const work = [...constraints];
    let grew = true;
    let guard = 0;
    while (grew && guard++ < 40) {
      grew = false;
      for (const con of work) {
        if (con.need === 0) {
          for (const cell of con.cells) if (!foundSafe.has(cell)) { foundSafe.add(cell); grew = true; }
        } else if (con.need === con.cells.length) {
          for (const cell of con.cells) if (!foundMine.has(cell)) { foundMine.add(cell); grew = true; }
        }
      }
      // 確定が見つかったらこのラウンドは打ち切り、外側で盤面へ反映して制約を作り直す
      if (foundSafe.size > 0 || foundMine.size > 0) break;
      // 部分集合: A ⊂ B なら (B\A, needB-needA) が新しい制約になる（小さな制約同士だけを対象にする）
      const additions: Constraint[] = [];
      const small = work.filter((c) => !c.global && c.cells.length <= 12);
      for (let a = 0; a < small.length; a++) {
        for (let b = 0; b < small.length; b++) {
          if (a === b) continue;
          const A = small[a];
          const B = small[b];
          if (A.cells.length >= B.cells.length) continue;
          const bSet = new Set(B.cells);
          if (!A.cells.every((c) => bSet.has(c))) continue;
          const diff = B.cells.filter((c) => !A.cells.includes(c));
          const need = B.need - A.need;
          if (diff.length === 0 || need < 0 || need > diff.length) continue;
          const key = diff.join(",");
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          additions.push({ cells: diff, need });
        }
      }
      if (additions.length > 0) {
        work.push(...additions);
        grew = true;
      }
    }

    if (foundSafe.size === 0 && foundMine.size === 0) break; // 推測なしでは進めない
    for (const m of foundMine) knownMine[m] = true;
    for (const s of foundSafe) flood(s);
  }
  return openedCount >= totalSafe;
}

/** 推測不要盤面として受理できるか（初手が空き領域を開くこと＋ソルバー検証）。 */
function isNoGuessBoard(state: MsState, safeIndex: number): boolean {
  if (state.cells[safeIndex].count !== 0) return false;
  return isSolvableWithoutGuessing(
    state.rows,
    state.cols,
    state.cells.map((c) => c.mine),
    safeIndex,
  );
}

/** 初手クリック時に地雷を配置する。推測不要盤面になるまで rng を進めて再配置を試す。 */
function plantSolvable(state: MsState, safeIndex: number): MsState {
  let attempt = plant(state, safeIndex);
  if (attempt.mineTotal === 0) return attempt;
  const cellCount = state.rows * state.cols;
  const maxAttempts = cellCount <= 81 ? 300 : cellCount <= 144 ? 150 : 100;
  for (let tries = 1; tries < maxAttempts; tries++) {
    if (isNoGuessBoard(attempt, safeIndex)) return attempt;
    attempt = plant({ ...state, rng: attempt.rng }, safeIndex);
  }
  return attempt;
}

/** cells（コピー済み配列）の start からフラッドフィルで開き、開いた数を返す。start が地雷でない前提。 */
function floodOpenCells(cells: MsCell[], state: MsState, start: number): number {
  let opened = 0;
  const stack = [start];
  while (stack.length > 0) {
    const i = stack.pop() as number;
    const cell = cells[i];
    if (cell.open || cell.flagged || cell.mine) continue;
    cell.open = true;
    opened++;
    if (cell.count === 0) {
      for (const n of neighbors(state, i)) {
        if (!cells[n].open) stack.push(n);
      }
    }
  }
  return opened;
}

export function revealCell(state: MsState, index: number): MsState {
  if (state.status === "won" || state.status === "lost") return state;
  const target = state.cells[index];
  if (!target || target.open || target.flagged) return state;
  let s = state.planted ? state : plantSolvable(state, index);
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
  const opened = s.opened + floodOpenCells(cells, s, index);
  const totalSafe = s.rows * s.cols - s.mineTotal;
  const won = opened >= totalSafe;
  return { ...s, cells, opened, status: won ? "won" : "playing" };
}

/**
 * コード入力: 開いた数字マスに対し、周囲の旗の数が数字と一致していれば
 * 旗以外の周囲マスを一括で開く。旗の置き間違いがあると地雷を踏んで敗北する。
 * 条件を満たさない場合は同じ状態を返す。
 */
export function chordCell(state: MsState, index: number): MsState {
  if (state.status === "won" || state.status === "lost") return state;
  const target = state.cells[index];
  if (!target || !target.open || target.count === 0) return state;
  const ns = neighbors(state, index);
  const flagCount = ns.filter((n) => state.cells[n].flagged).length;
  if (flagCount !== target.count) return state;
  const targets = ns.filter((n) => !state.cells[n].open && !state.cells[n].flagged);
  if (targets.length === 0) return state;
  const cells = state.cells.map((cell) => ({ ...cell }));
  let opened = state.opened;
  for (const t of targets) {
    if (cells[t].mine) {
      cells[t].open = true;
      for (const cell of cells) {
        if (cell.mine) cell.open = true;
      }
      return { ...state, cells, opened, status: "lost", exploded: t };
    }
    opened += floodOpenCells(cells, state, t);
  }
  const totalSafe = state.rows * state.cols - state.mineTotal;
  const won = opened >= totalSafe;
  return { ...state, cells, opened, status: won ? "won" : "playing" };
}

export function toggleFlag(state: MsState, index: number): MsState {
  if (state.status === "won" || state.status === "lost") return state;
  const target = state.cells[index];
  if (!target || target.open) return state;
  const cells = state.cells.map((cell) => ({ ...cell }));
  cells[index].flagged = !cells[index].flagged;
  return { ...state, cells, flags: state.flags + (cells[index].flagged ? 1 : -1) };
}
