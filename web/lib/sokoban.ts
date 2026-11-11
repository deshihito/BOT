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
