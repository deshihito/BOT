// レーザーミラーの純粋ロジック（UI 非依存・シード決定的）。
// 左端の発射口から出た光を、鏡（/ と \）を回転させて反射させ、的セルに当てるパズル。
// 問題の生成: 光の通り道（解）を先に構築し、鏡の位置と正しい向きを決めてから
// 初期の向きだけをランダムにずらす。このため必ず解が存在する（可解性保証）。
// 光路は traceLaser でシミュレーションし、(セル, 進行方向) の再訪でループを検出する。

export const LASER_SIZE = 6;

export type LaserDir = "N" | "E" | "S" | "W";
export type MirrorKind = "/" | "\\";
export type LaserStatus = "playing" | "solved";

export interface LaserMirror {
  /** セルの index（row * cols + col）。 */
  index: number;
  kind: MirrorKind;
}

export interface LaserState {
  rows: number;
  cols: number;
  /** 発射口のある行。光はその行の左端から右向きに入る。 */
  emitterRow: number;
  /** 的セルの index。 */
  target: number;
  mirrors: LaserMirror[];
  status: LaserStatus;
  moves: number;
  seed: number;
}

export interface LaserTrace {
  /** 光が通過したセルの index（入った順）。的や壁で止まった場合はそのセルまで。 */
  cells: number[];
  hitTarget: boolean;
  looped: boolean;
  /** 最後に記録したセルを出たときの進行方向（描画の終端を伸ばす用）。 */
  endDir: LaserDir;
}

const DELTA: Record<LaserDir, { dr: number; dc: number }> = {
  N: { dr: -1, dc: 0 },
  E: { dr: 0, dc: 1 },
  S: { dr: 1, dc: 0 },
  W: { dr: 0, dc: -1 },
};

/** 鏡での反射。"/" は E<->N, W<->S。"\\" は E<->S, W<->N。 */
export function reflect(dir: LaserDir, kind: MirrorKind): LaserDir {
  if (kind === "/") {
    switch (dir) {
      case "E": return "N";
      case "N": return "E";
      case "W": return "S";
      case "S": return "W";
    }
  }
  switch (dir) {
    case "E": return "S";
    case "S": return "E";
    case "W": return "N";
    case "N": return "W";
  }
}

/** (入射方向, 出射方向) から必要な鏡の向きを求める。直進・逆行は null。 */
function kindForTurn(from: LaserDir, to: LaserDir): MirrorKind | null {
  const candidates: MirrorKind[] = ["/", "\\"];
  for (const kind of candidates) {
    if (reflect(from, kind) === to) return kind;
  }
  return null;
}

function perpendiculars(dir: LaserDir): LaserDir[] {
  return dir === "E" || dir === "W" ? ["N", "S"] : ["E", "W"];
}

/** 光路をシミュレーションする。 */
export function traceLaser(state: LaserState): LaserTrace {
  const mirrorAt = new Map(state.mirrors.map((m) => [m.index, m.kind]));
  const cells: number[] = [];
  const visited = new Set<string>();
  let r = state.emitterRow;
  let c = 0;
  let dir: LaserDir = "E";
  let hitTarget = false;
  let looped = false;
  const maxSteps = state.rows * state.cols * 4 + 8;
  for (let step = 0; step < maxSteps; step++) {
    const index = r * state.cols + c;
    const key = `${index}:${dir}`;
    if (visited.has(key)) {
      looped = true;
      break;
    }
    visited.add(key);
    cells.push(index);
    if (index === state.target) {
      hitTarget = true;
      break;
    }
    const kind = mirrorAt.get(index);
    if (kind) dir = reflect(dir, kind);
    const { dr, dc } = DELTA[dir];
    const nr = r + dr;
    const nc = c + dc;
    if (nr < 0 || nc < 0 || nr >= state.rows || nc >= state.cols) break;
    r = nr;
    c = nc;
  }
  return { cells, hitTarget, looped, endDir: dir };
}

/** mulberry32。生成専用に局所で使う。 */
function makeRng(seed: number): () => number {
  let t = seed | 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

interface BuiltPuzzle {
  emitterRow: number;
  target: number;
  solution: LaserMirror[];
  pathCells: Set<number>;
}

/** 解の光路を先に構築する。失敗したら null。 */
function buildSolution(rng: () => number): BuiltPuzzle | null {
  const rows = LASER_SIZE;
  const cols = LASER_SIZE;
  const emitterRow = randInt(rng, 0, rows - 1);
  const turns = randInt(rng, 2, 4);
  const mirrors = new Map<number, MirrorKind>();
  const pathCells = new Set<number>();
  // 現在位置は「最後に通過したセル」。開始前は発射口の外（col = -1）。
  let curR = emitterRow;
  let curC = -1;
  let dir: LaserDir = "E";

  for (let t = 0; t < turns; t++) {
    const isLast = t === turns - 1;
    const { dr, dc } = DELTA[dir];
    // 曲がり角の候補: 現在位置から dir 方向に1マス以上先のセル。
    const options: { r: number; c: number; newDir: LaserDir; kind: MirrorKind }[] = [];
    for (let s = 1; ; s++) {
      const r = curR + dr * s;
      const c = curC + dc * s;
      if (r < 0 || c < 0 || r >= rows || c >= cols) break;
      const index = r * cols + c;
      // 途中に既存の鏡があると光が先に当たってしまうため、その先は候補にできない。
      if (mirrors.has(index)) break;
      for (const newDir of perpendiculars(dir)) {
        const kind = kindForTurn(dir, newDir);
        if (!kind) continue;
        // 曲がった先に必要な空き: 最後の角なら的を置く1マス、それ以外は次の角+的の2マス。
        const nd = DELTA[newDir];
        let room = 0;
        for (let k = 1; ; k++) {
          const rr = r + nd.dr * k;
          const cc = c + nd.dc * k;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) break;
          room++;
        }
        if (room >= (isLast ? 1 : 2)) options.push({ r, c, newDir, kind });
      }
    }
    if (options.length === 0) return null;
    const picked = options[Math.floor(rng() * options.length)];
    // 現在位置の直後から角までを光路セルとして記録。
    for (let s = 1; ; s++) {
      const r = curR + dr * s;
      const c = curC + dc * s;
      pathCells.add(r * cols + c);
      if (r === picked.r && c === picked.c) break;
    }
    mirrors.set(picked.r * cols + picked.c, picked.kind);
    curR = picked.r;
    curC = picked.c;
    dir = picked.newDir;
  }

  // 的: 最後の角から dir 方向に1マス以上先。
  const { dr, dc } = DELTA[dir];
  const targets: number[] = [];
  for (let s = 1; ; s++) {
    const r = curR + dr * s;
    const c = curC + dc * s;
    if (r < 0 || c < 0 || r >= rows || c >= cols) break;
    if (mirrors.has(r * cols + c)) break; // 鏡が先にあると光が届かない
    if (s >= 2) pathCells.add(r * cols + c); // 的の手前は光路
    targets.push(r * cols + c);
  }
  if (targets.length === 0) return null;
  const target = targets[Math.floor(rng() * targets.length)];
  pathCells.delete(target);
  if (mirrors.size < 2) return null;
  return {
    emitterRow,
    target,
    solution: [...mirrors.entries()].map(([index, kind]) => ({ index, kind })),
    pathCells,
  };
}

/** 生成に失敗し続けた場合の固定パズル（フォールバック）。 */
function fallbackPuzzle(): BuiltPuzzle {
  // 発射口 (1行目) → (1,4) の "\" で南へ → (4,4) の "/" で西へ → 的 (4,1)。
  return {
    emitterRow: 1,
    target: 4 * LASER_SIZE + 1,
    solution: [
      { index: 1 * LASER_SIZE + 4, kind: "\\" },
      { index: 4 * LASER_SIZE + 4, kind: "/" },
    ],
    pathCells: new Set([
      1 * LASER_SIZE + 0, 1 * LASER_SIZE + 1, 1 * LASER_SIZE + 2, 1 * LASER_SIZE + 3, 1 * LASER_SIZE + 4,
      2 * LASER_SIZE + 4, 3 * LASER_SIZE + 4, 4 * LASER_SIZE + 4,
      4 * LASER_SIZE + 3, 4 * LASER_SIZE + 2,
    ]),
  };
}

export function createLaserPuzzle(seed: number): LaserState {
  const rng = makeRng(seed);
  let built: BuiltPuzzle | null = null;
  for (let attempt = 0; attempt < 200 && built === null; attempt++) {
    built = buildSolution(rng);
  }
  if (built === null) built = fallbackPuzzle();

  // 解の鏡はそのまま置き、初期の向きだけをランダムにずらす。
  const mirrors: LaserMirror[] = built.solution.map((m) => ({
    index: m.index,
    kind: rng() < 0.5 ? m.kind : m.kind === "/" ? "\\" : "/",
  }));
  // おとりの鏡を光路外に0〜2枚置く（解の光は通らないので可解性に影響しない）。
  const occupied = new Set([...mirrors.map((m) => m.index), built.target]);
  const decoyCount = randInt(rng, 0, 2);
  let placedDecoys = 0;
  for (let tries = 0; tries < 40 && placedDecoys < decoyCount; tries++) {
    const index = randInt(rng, 0, LASER_SIZE * LASER_SIZE - 1);
    if (occupied.has(index) || built.pathCells.has(index)) continue;
    // 発射口の行の先頭セルは光が最初に入るため避ける（pathCells に含まれるが念のため）。
    occupied.add(index);
    mirrors.push({ index, kind: rng() < 0.5 ? "/" : "\\" });
    placedDecoys++;
  }
  mirrors.sort((a, b) => a.index - b.index);

  const state: LaserState = {
    rows: LASER_SIZE,
    cols: LASER_SIZE,
    emitterRow: built.emitterRow,
    target: built.target,
    mirrors,
    status: "playing",
    moves: 0,
    seed: seed | 0,
  };
  // 偶然そのまま解けていたら、解の鏡を1枚ひっくり返して未解決にする。
  if (traceLaser(state).hitTarget) {
    const solutionIndex = new Set(built.solution.map((m) => m.index));
    const flipAt = state.mirrors.findIndex((m) => solutionIndex.has(m.index));
    if (flipAt >= 0) {
      state.mirrors = state.mirrors.map((m, i) =>
        i === flipAt ? { ...m, kind: m.kind === "/" ? "\\" : "/" } : m,
      );
    }
  }
  return state;
}

/** 鏡を回転させる（/ と \ の切り替え）。終了後・鏡の無いセルは無効。 */
export function rotateLaserMirror(state: LaserState, index: number): LaserState {
  if (state.status !== "playing") return state;
  const target = state.mirrors.find((m) => m.index === index);
  if (!target) return state;
  const mirrors = state.mirrors.map((m) =>
    m.index === index ? { ...m, kind: (m.kind === "/" ? "\\" : "/") as MirrorKind } : m,
  );
  const next: LaserState = { ...state, mirrors, moves: state.moves + 1 };
  if (traceLaser(next).hitTarget) next.status = "solved";
  return next;
}
