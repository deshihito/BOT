// すごろく（30マス直線コース）の純粋ロジック（UI 非依存・シード決定的）。
// プレイヤー1人＋CPU 2人の3人レース。先にゴール（29マス目）に着いた人が勝ち。
// マス効果は着地したとき1回だけ発動する（効果で動いた先の効果は連鎖しない）。
// 「1回休み」のマスに止まると、次の自分の番はサイコロを振らずに休む。

export type SquareEffect =
  | { type: "none" }
  | { type: "goal" }
  | { type: "forward"; steps: number }
  | { type: "back"; steps: number }
  | { type: "skip" }
  | { type: "coins"; amount: number };

export const SUGOROKU_GOAL = 29;
export const SUGOROKU_PLAYER_COUNT = 3;

/** マス番号（0=スタート、29=ゴール）ごとの効果。 */
export const SUGOROKU_SQUARES: SquareEffect[] = [
  { type: "none" }, // 0 スタート
  { type: "coins", amount: 3 }, // 1
  { type: "none" }, // 2
  { type: "forward", steps: 2 }, // 3
  { type: "coins", amount: -2 }, // 4
  { type: "none" }, // 5
  { type: "back", steps: 2 }, // 6
  { type: "coins", amount: 5 }, // 7
  { type: "skip" }, // 8
  { type: "none" }, // 9
  { type: "forward", steps: 3 }, // 10
  { type: "coins", amount: -3 }, // 11
  { type: "none" }, // 12
  { type: "back", steps: 3 }, // 13
  { type: "coins", amount: 4 }, // 14
  { type: "none" }, // 15
  { type: "forward", steps: 2 }, // 16
  { type: "coins", amount: -4 }, // 17
  { type: "skip" }, // 18
  { type: "none" }, // 19
  { type: "back", steps: 2 }, // 20
  { type: "coins", amount: 6 }, // 21
  { type: "none" }, // 22
  { type: "forward", steps: 4 }, // 23
  { type: "coins", amount: -5 }, // 24
  { type: "none" }, // 25
  { type: "back", steps: 4 }, // 26
  { type: "coins", amount: 8 }, // 27
  { type: "none" }, // 28
  { type: "goal" }, // 29 ゴール
];

export function squareEffect(index: number): SquareEffect {
  if (!Number.isInteger(index) || index < 0 || index >= SUGOROKU_SQUARES.length) return { type: "none" };
  return SUGOROKU_SQUARES[index];
}

export function describeEffect(effect: SquareEffect): string {
  switch (effect.type) {
    case "goal":
      return "ゴール";
    case "forward":
      return `${effect.steps}マス進む`;
    case "back":
      return `${effect.steps}マス戻る`;
    case "skip":
      return "1回休み";
    case "coins":
      return effect.amount >= 0 ? `コイン+${effect.amount}` : `コイン${effect.amount}`;
    default:
      return "";
  }
}

export type SugorokuPlayer = {
  name: string;
  cpu: boolean;
  position: number;
  coins: number;
  skipNext: boolean;
};

export type SugorokuState = {
  players: SugorokuPlayer[];
  /** 現在の手番（players の index）。終了時は勝者の index。 */
  turn: number;
  status: "playing" | "finished";
  winner: number | null;
  /** 直近のサイコロの目（休み・未投擲は null）。 */
  lastRoll: number | null;
  /** 経過ターン数（全員合計の手番回数）。 */
  turns: number;
  log: string[];
  seed: number;
  rng: number;
};

const PLAYER_NAMES = ["あなた", "CPU みかん", "CPU すずめ"];

/** mulberry32。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function createSugorokuGame(seed: number): SugorokuState {
  return {
    players: PLAYER_NAMES.map((name, i) => ({
      name,
      cpu: i !== 0,
      position: 0,
      coins: 0,
      skipNext: false,
    })),
    turn: 0,
    status: "playing",
    winner: null,
    lastRoll: null,
    turns: 0,
    log: ["スタート！先にゴールした人の勝ちです。"],
    seed: seed | 0,
    rng: seed | 0,
  };
}

function pushLog(log: string[], entry: string): string[] {
  return [...log, entry].slice(-60);
}

/**
 * 現在の手番のプレイヤーがサイコロを振る（1回休みなら休んで手番を渡す）。
 * 終了後は同じ状態を返す。CPU の手番もこの関数で進める（UI 側がタイミングを制御）。
 */
export function rollDice(state: SugorokuState): SugorokuState {
  if (state.status !== "playing") return state;
  const players = state.players.map((p) => ({ ...p }));
  const me = players[state.turn];
  const nextTurn = (state.turn + 1) % players.length;
  let log = state.log;

  if (me.skipNext) {
    me.skipNext = false;
    log = pushLog(log, `${me.name} は1回休み。`);
    return { ...state, players, turn: nextTurn, lastRoll: null, turns: state.turns + 1, log };
  }

  const r = nextRandom(state.rng);
  const dice = 1 + Math.floor(r.value * 6);
  const from = me.position;
  let pos = Math.min(SUGOROKU_GOAL, from + dice);
  log = pushLog(log, `${me.name} は ${dice} が出て ${from} → ${pos} マス目へ。`);

  let status: SugorokuState["status"] = "playing";
  let winner: number | null = null;

  if (pos >= SUGOROKU_GOAL) {
    me.position = SUGOROKU_GOAL;
    status = "finished";
    winner = state.turn;
    log = pushLog(log, `${me.name} がゴール！勝ちです。`);
  } else {
    const effect = squareEffect(pos);
    if (effect.type === "forward") {
      pos = Math.min(SUGOROKU_GOAL, pos + effect.steps);
      log = pushLog(log, `  ${describeEffect(effect)} → ${pos} マス目。`);
      if (pos >= SUGOROKU_GOAL) {
        status = "finished";
        winner = state.turn;
        log = pushLog(log, `${me.name} がゴール！勝ちです。`);
      }
    } else if (effect.type === "back") {
      pos = Math.max(0, pos - effect.steps);
      log = pushLog(log, `  ${describeEffect(effect)} → ${pos} マス目。`);
    } else if (effect.type === "skip") {
      me.skipNext = true;
      log = pushLog(log, `  ${me.name} は次の番は1回休み。`);
    } else if (effect.type === "coins") {
      me.coins = Math.max(0, me.coins + effect.amount);
      log = pushLog(log, `  ${describeEffect(effect)}（所持 ${me.coins} 枚）。`);
    }
    me.position = pos;
  }

  return {
    ...state,
    players,
    turn: status === "finished" ? state.turn : nextTurn,
    status,
    winner,
    lastRoll: dice,
    turns: state.turns + 1,
    log,
    rng: r.rng,
  };
}

/** 現在の手番が CPU かどうか。 */
export function isCpuTurn(state: SugorokuState): boolean {
  return state.status === "playing" && state.players[state.turn]?.cpu === true;
}
