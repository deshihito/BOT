// 倉庫番の純粋ロジック（UI 非依存・決定的。乱数は使わない）。
// 面データは文字列マップ: # 壁 / 空白 床 / . ゴール / $ 箱 / * 箱（ゴール上） / @ プレイヤー / + プレイヤー（ゴール上）。
// 状態は壁とゴールを静的な真偽配列で持ち、箱とプレイヤーは index 配列で持つ（JSON 化可能）。

export type SokobanDir = "up" | "down" | "left" | "right";

export type SokobanSnapshot = {
  boxes: number[];
  player: number;
  moves: number;
  pushes: number;
};

export type SokobanState = {
  level: number;
  width: number;
  height: number;
  walls: boolean[];
  goals: boolean[];
  /** 箱のあるマスの index（ソート済み）。 */
  boxes: number[];
  player: number;
  /** 歩数（箱を押さない移動も含む）。 */
  moves: number;
  /** 箱を押した回数。 */
  pushes: number;
  status: "playing" | "won";
  history: SokobanSnapshot[];
};

export type SokobanLevel = { name: string; map: string[] };

export const SOKOBAN_LEVELS: SokobanLevel[] = [
  {
    name: "第1面",
    map: [
      "######",
      "#    #",
      "# @$ #",
      "#  . #",
      "######",
    ],
  },
  {
    name: "第2面",
    map: [
      "#######",
      "#     #",
      "# $$  #",
      "# ..@ #",
      "#######",
    ],
  },
  {
    name: "第3面",
    map: [
      "########",
      "#      #",
      "# $  . #",
      "# @$ . #",
      "########",
    ],
  },
  {
    name: "第4面",
    map: [
      "#########",
      "#   #   #",
      "# $   $ #",
      "# . @ . #",
      "#########",
    ],
  },
  {
    name: "第5面",
    map: [
      "##########",
      "#  .     #",
      "#  $ $   #",
      "# @ $ .  #",
      "#    .    #",
      "##########",
    ],
  },
  {
    name: "第6面",
    map: [
      "##########",
      "#        #",
      "# $ $$   #",
      "#  . .   #",
      "# @$ .   #",
      "#   .    #",
      "##########",
    ],
  },
];

export function sokobanLevelCount(): number {
  return SOKOBAN_LEVELS.length;
}

function parseLevel(levelIndex: number): Omit<SokobanState, "history"> {
  const level = SOKOBAN_LEVELS[levelIndex];
  if (!level) throw new Error("面が存在しません");
  const height = level.map.length;
  const width = Math.max(...level.map.map((row) => row.length));
  const walls: boolean[] = new Array(width * height).fill(false);
  const goals: boolean[] = new Array(width * height).fill(false);
  const boxes: number[] = [];
  let player = -1;
  for (let r = 0; r < height; r++) {
    const row = level.map[r];
    for (let c = 0; c < width; c++) {
      const ch = row[c] ?? "#";
      const i = r * width + c;
      if (ch === "#") walls[i] = true;
      else if (ch === ".") goals[i] = true;
      else if (ch === "$") boxes.push(i);
      else if (ch === "*") {
        goals[i] = true;
        boxes.push(i);
      } else if (ch === "@") player = i;
      else if (ch === "+") {
        goals[i] = true;
        player = i;
      }
    }
  }
  boxes.sort((a, b) => a - b);
  return {
    level: levelIndex,
    width,
    height,
    walls,
    goals,
    boxes,
    player,
    moves: 0,
    pushes: 0,
    status: goals.every((g, i) => !g || boxes.includes(i)) && boxes.length > 0 ? "won" : "playing",
  };
}

export function createSokobanGame(level: number): SokobanState {
  const idx = Number.isInteger(level) && level >= 0 && level < SOKOBAN_LEVELS.length ? level : 0;
  return { ...parseLevel(idx), history: [] };
}

const DELTAS: Record<SokobanDir, [number, number]> = {
  up: [-1, 0],
  down: [1, 0],
  left: [0, -1],
  right: [0, 1],
};

export function isSokobanDir(value: unknown): value is SokobanDir {
  return value === "up" || value === "down" || value === "left" || value === "right";
}

/** 1手進める。動けない場合（壁・押せない箱・クリア後）は同じ状態を返す。 */
export function moveSokoban(state: SokobanState, dir: SokobanDir): SokobanState {
  if (state.status !== "playing" || !isSokobanDir(dir)) return state;
  const [dr, dc] = DELTAS[dir];
  const pr = Math.floor(state.player / state.width);
  const pc = state.player % state.width;
  const nr = pr + dr;
  const nc = pc + dc;
  if (nr < 0 || nc < 0 || nr >= state.height || nc >= state.width) return state;
  const next = nr * state.width + nc;
  if (state.walls[next]) return state;

  let boxes = state.boxes;
  let pushes = state.pushes;
  if (state.boxes.includes(next)) {
    const br = nr + dr;
    const bc = nc + dc;
    if (br < 0 || bc < 0 || br >= state.height || bc >= state.width) return state;
    const beyond = br * state.width + bc;
    if (state.walls[beyond] || state.boxes.includes(beyond)) return state;
    boxes = state.boxes.map((b) => (b === next ? beyond : b)).sort((a, b) => a - b);
    pushes++;
  }

  const won = boxes.every((b) => state.goals[b]);
  return {
    ...state,
    boxes,
    player: next,
    moves: state.moves + 1,
    pushes,
    status: won ? "won" : "playing",
    history: [
      ...state.history,
      { boxes: [...state.boxes], player: state.player, moves: state.moves, pushes: state.pushes },
    ],
  };
}

/** 1手戻す。履歴が無ければ同じ状態を返す。 */
export function undoSokoban(state: SokobanState): SokobanState {
  const last = state.history[state.history.length - 1];
  if (!last) return state;
  return {
    ...state,
    boxes: [...last.boxes],
    player: last.player,
    moves: last.moves,
    pushes: last.pushes,
    status: "playing",
    history: state.history.slice(0, -1),
  };
}

/** 全ての箱がゴールの上にあればクリア。 */
export function isSokobanCleared(state: SokobanState): boolean {
  return state.boxes.length > 0 && state.boxes.every((b) => state.goals[b]);
}

function isWallAt(state: SokobanState, r: number, c: number): boolean {
  if (r < 0 || c < 0 || r >= state.height || c >= state.width) return true;
  return state.walls[r * state.width + c];
}

/**
 * 詰み（デッドロック）になっている箱の index 一覧。誤検出しないよう、
 * 確実に二度と動かせないパターンだけを検出する:
 * 1) ゴール上でない箱が壁の角に押し込まれている。
 * 2) 壁に沿った1列（両端が閉じ、途中に脱出路もゴールも無い）に閉じ込められている。
 * 3) 壁と箱だけで固まった 2×2 ブロックの中にある（ゴール上の箱だけの場合は除く）。
 */
export function deadlockedBoxes(state: SokobanState): number[] {
  const dead = new Set<number>();
  const boxSet = new Set(state.boxes);
  const { width, height } = state;

  for (const box of state.boxes) {
    if (state.goals[box]) continue;
    const r = Math.floor(box / width);
    const c = box % width;
    const up = isWallAt(state, r - 1, c);
    const down = isWallAt(state, r + 1, c);
    const left = isWallAt(state, r, c - 1);
    const right = isWallAt(state, r, c + 1);
    // 1) 角
    if ((up || down) && (left || right)) {
      dead.add(box);
      continue;
    }
    // 2) 壁沿いの列: 壁側が [dr,dc]、箱が滑る軸が水平/垂直
    const wallSides: { dr: number; dc: number; axisR: number; axisC: number }[] = [];
    if (up) wallSides.push({ dr: -1, dc: 0, axisR: 0, axisC: 1 });
    if (down) wallSides.push({ dr: 1, dc: 0, axisR: 0, axisC: 1 });
    if (left) wallSides.push({ dr: 0, dc: -1, axisR: 1, axisC: 0 });
    if (right) wallSides.push({ dr: 0, dc: 1, axisR: 1, axisC: 0 });
    for (const side of wallSides) {
      // 箱のいるセルから軸方向の両側へ、壁側がずっと壁である範囲をたどる。
      // 範囲の両端が「箱の列自体の壁」で閉じ、範囲内にゴールが無ければ詰み。
      let closed = true;
      let hasGoal: boolean = state.goals[box];
      for (const sign of [1, -1]) {
        let cr = r;
        let cc = c;
        for (;;) {
          const nr = cr + side.axisR * sign;
          const nc = cc + side.axisC * sign;
          if (nr < 0 || nc < 0 || nr >= height || nc >= width || state.walls[nr * width + nc]) {
            break; // 列自体が壁で閉じた
          }
          if (!isWallAt(state, nr + side.dr, nc + side.dc)) {
            closed = false; // 壁から離れる隙間がある（脱出できる）
            break;
          }
          if (state.goals[nr * width + nc]) hasGoal = true;
          cr = nr;
          cc = nc;
        }
        if (!closed) break;
      }
      if (closed && !hasGoal) {
        dead.add(box);
        break;
      }
    }
  }

  // 3) 2×2 ブロック（壁と箱のみ）: 中の箱は全て凍結する
  for (let r = 0; r + 1 < height; r++) {
    for (let c = 0; c + 1 < width; c++) {
      const cells = [r * width + c, r * width + c + 1, (r + 1) * width + c, (r + 1) * width + c + 1];
      if (!cells.every((i) => state.walls[i] || boxSet.has(i))) continue;
      const boxesHere = cells.filter((i) => boxSet.has(i));
      if (boxesHere.length === 0) continue;
      if (boxesHere.every((i) => state.goals[i])) continue;
      for (const b of boxesHere) {
        if (!state.goals[b]) dead.add(b);
      }
    }
  }

  return [...dead].sort((a, b) => a - b);
}

/**
 * 箱をクリックしたときの「歩いて行って押す」操作。
 * 押せる方向があり、その反対側の立ち位置まで箱や壁に阻まれず歩いて行ける場合に、
 * 歩行＋1回の押しを moveSokoban の列として適用した最終状態を返す。
 * 押せる方向が無い・歩いて行けない場合は同じ状態を返す。
 */
export function pushBoxByClick(state: SokobanState, boxIndex: number): SokobanState {
  if (state.status !== "playing") return state;
  if (!state.boxes.includes(boxIndex)) return state;
  const { width, height } = state;
  const boxSet = new Set(state.boxes);
  const br = Math.floor(boxIndex / width);
  const bc = boxIndex % width;

  const DIRS: { dir: SokobanDir; dr: number; dc: number }[] = [
    { dir: "up", dr: -1, dc: 0 },
    { dir: "down", dr: 1, dc: 0 },
    { dir: "left", dr: 0, dc: -1 },
    { dir: "right", dr: 0, dc: 1 },
  ];
  const DIR_BY_DELTA = new Map<string, SokobanDir>(DIRS.map((d) => [`${d.dr},${d.dc}`, d.dir]));

  // プレイヤーの歩行可能範囲を BFS し、経路も復元する
  const walkable = (i: number) => !state.walls[i] && !boxSet.has(i);
  const prev = new Map<number, number>();
  const queue = [state.player];
  prev.set(state.player, -1);
  while (queue.length > 0) {
    const cur = queue.shift() as number;
    const cr = Math.floor(cur / width);
    const cc = cur % width;
    for (const d of DIRS) {
      const nr = cr + d.dr;
      const nc = cc + d.dc;
      if (nr < 0 || nc < 0 || nr >= height || nc >= width) continue;
      const ni = nr * width + nc;
      if (prev.has(ni) || !walkable(ni)) continue;
      prev.set(ni, cur);
      queue.push(ni);
    }
  }

  for (const d of DIRS) {
    const targetR = br + d.dr;
    const targetC = bc + d.dc;
    if (targetR < 0 || targetC < 0 || targetR >= height || targetC >= width) continue;
    const target = targetR * width + targetC;
    if (state.walls[target] || boxSet.has(target)) continue;
    const stand = (br - d.dr) * width + (bc - d.dc);
    if (br - d.dr < 0 || bc - d.dc < 0 || br - d.dr >= height || bc - d.dc >= width) continue;
    if (!prev.has(stand)) continue;
    // 経路をたどって歩行を適用し、最後に押す
    const path: number[] = [];
    for (let cur = stand; cur !== -1; cur = prev.get(cur) as number) path.push(cur);
    path.reverse();
    let s = state;
    for (let k = 1; k < path.length; k++) {
      const from = path[k - 1];
      const to = path[k];
      const dir = DIR_BY_DELTA.get(`${Math.floor(to / width) - Math.floor(from / width)},${(to % width) - (from % width)}`);
      if (!dir) return state;
      s = moveSokoban(s, dir);
    }
    return moveSokoban(s, d.dir);
  }
  return state;
}
