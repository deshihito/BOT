// PK戦の純粋ロジック（UI 非依存・シード決定的）。
// ルール:
// - ゴールは 6 ゾーン（左上/中央上/右上/左下/中央下/右下）。キッカーは狙う
//   ゾーンを選び、キーパーは飛ぶゾーンを選ぶ。
// - 判定は「枠外 → セーブ → ゴール」の順:
//   1. 枠外: ゾーンごとの外し率（隅ほど高い）で決定的に判定する。
//      隅 20% / 中央上 10% / 中央下 5%。強く隅を狙うほどリスクが上がる設計。
//   2. セーブ: キーパーのゾーンとキッカーのゾーンが一致したらセーブ。
//   3. それ以外はゴール。
// - CPU キーパーは偏りのある分布で飛ぶ（隅を多めに読む）:
//   PEN_KEEPER_WEIGHTS = 左上3 / 中央上2 / 右上3 / 左下3 / 中央下2 / 右下3。
// - CPU キッカーは下の隅を好む分布で蹴る:
//   PEN_SHOOTER_WEIGHTS = 左上3 / 中央上1 / 右上3 / 左下4 / 中央下1 / 右下4。
// - 交互に 5 本ずつ。残り本数で逆転できなくなった時点で早期終了する。
//   5 本で同点ならサドンデス（両者1本ずつ蹴って差が付いた時点で決着）。

export type PenSide = "player" | "cpu";
export type PenOutcome = "goal" | "saved" | "missed";
export type PenStatus = "playing" | "finished";

export interface PenZone {
  id: number;
  label: string;
  /** そのゾーンを狙ったときの枠外率（0〜1）。 */
  missRate: number;
}

export const PEN_ZONES: PenZone[] = [
  { id: 0, label: "左上", missRate: 0.2 },
  { id: 1, label: "中央上", missRate: 0.1 },
  { id: 2, label: "右上", missRate: 0.2 },
  { id: 3, label: "左下", missRate: 0.2 },
  { id: 4, label: "中央下", missRate: 0.05 },
  { id: 5, label: "右下", missRate: 0.2 },
];

/** CPU キーパーが各ゾーンへ飛ぶ重み（隅を多めに読む）。 */
export const PEN_KEEPER_WEIGHTS = [3, 2, 3, 3, 2, 3];
/** CPU キッカーが各ゾーンを狙う重み（下の隅を好む）。 */
export const PEN_SHOOTER_WEIGHTS = [3, 1, 3, 4, 1, 4];

export const PEN_ROUNDS = 5;

export interface PenKick {
  by: PenSide;
  /** 1 始まりのラウンド番号（サドンデスは 6 以降）。 */
  round: number;
  zone: number;
  keeperZone: number;
  outcome: PenOutcome;
  suddenDeath: boolean;
}

export interface PenaltyState {
  kicks: PenKick[];
  playerGoals: number;
  cpuGoals: number;
  /** 次に蹴る側。finished の間も最後の値のまま。 */
  turn: PenSide;
  status: PenStatus;
  winner: PenSide | null;
  suddenDeath: boolean;
  seed: number;
  rng: number;
}

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function pickWeighted(rng: number, weights: number[]): { index: number; rng: number } {
  const total = weights.reduce((a, b) => a + b, 0);
  const r = nextRandom(rng);
  let acc = r.value * total;
  for (let i = 0; i < weights.length; i++) {
    acc -= weights[i];
    if (acc < 0) return { index: i, rng: r.rng };
  }
  return { index: weights.length - 1, rng: r.rng };
}

function isValidZone(zone: number): boolean {
  return Number.isInteger(zone) && zone >= 0 && zone < PEN_ZONES.length;
}

export function createPenaltyGame(seed: number): PenaltyState {
  return {
    kicks: [],
    playerGoals: 0,
    cpuGoals: 0,
    turn: "player",
    status: "playing",
    winner: null,
    suddenDeath: false,
    seed,
    rng: seed | 0,
  };
}

export function penaltyTaken(state: PenaltyState, side: PenSide): number {
  return state.kicks.filter((k) => k.by === side).length;
}

/** 1 本のキックを解決する（内部用）。rng は消費後の値を返す。 */
function resolveKick(
  state: PenaltyState,
  by: PenSide,
  zone: number,
  keeperZone: number,
  rng: number,
): PenaltyState {
  const miss = nextRandom(rng);
  const missRate = PEN_ZONES[zone]?.missRate ?? 0;
  const outcome: PenOutcome = miss.value < missRate ? "missed" : keeperZone === zone ? "saved" : "goal";
  const round = Math.floor(state.kicks.length / 2) + 1;
  const kick: PenKick = {
    by,
    round,
    zone,
    keeperZone,
    outcome,
    suddenDeath: state.suddenDeath,
  };
  const kicked: PenaltyState = {
    ...state,
    rng: miss.rng,
    kicks: [...state.kicks, kick],
    playerGoals: state.playerGoals + (by === "player" && outcome === "goal" ? 1 : 0),
    cpuGoals: state.cpuGoals + (by === "cpu" && outcome === "goal" ? 1 : 0),
    turn: by === "player" ? "cpu" : "player",
  };
  return settle(kicked);
}

/** 早期決着とサドンデスの判定。 */
function settle(state: PenaltyState): PenaltyState {
  const pTaken = penaltyTaken(state, "player");
  const cTaken = penaltyTaken(state, "cpu");
  if (!state.suddenDeath) {
    const remP = PEN_ROUNDS - pTaken;
    const remC = PEN_ROUNDS - cTaken;
    if (state.playerGoals > state.cpuGoals + remC) {
      return { ...state, status: "finished", winner: "player" };
    }
    if (state.cpuGoals > state.playerGoals + remP) {
      return { ...state, status: "finished", winner: "cpu" };
    }
    if (pTaken >= PEN_ROUNDS && cTaken >= PEN_ROUNDS) {
      if (state.playerGoals !== state.cpuGoals) {
        return {
          ...state,
          status: "finished",
          winner: state.playerGoals > state.cpuGoals ? "player" : "cpu",
        };
      }
      return { ...state, suddenDeath: true };
    }
    return state;
  }
  // サドンデス: 両者が同数蹴り終えた時点で差があれば決着。
  if (pTaken === cTaken && state.playerGoals !== state.cpuGoals) {
    return {
      ...state,
      status: "finished",
      winner: state.playerGoals > state.cpuGoals ? "player" : "cpu",
    };
  }
  return state;
}

/**
 * プレイヤーがキッカーとして zone を狙って蹴る。
 * CPU キーパーは PEN_KEEPER_WEIGHTS の分布で飛ぶ。手番でなければ state をそのまま返す。
 */
export function playerShoot(state: PenaltyState, zone: number): PenaltyState {
  if (state.status !== "playing" || state.turn !== "player") return state;
  if (!isValidZone(zone)) return state;
  const keeper = pickWeighted(state.rng, PEN_KEEPER_WEIGHTS);
  return resolveKick(state, "player", zone, keeper.index, keeper.rng);
}

/**
 * プレイヤーがキーパーとして zone へ飛ぶ。
 * CPU キッカーは PEN_SHOOTER_WEIGHTS の分布で蹴る。手番でなければ state をそのまま返す。
 */
export function playerDive(state: PenaltyState, zone: number): PenaltyState {
  if (state.status !== "playing" || state.turn !== "cpu") return state;
  if (!isValidZone(zone)) return state;
  const shot = pickWeighted(state.rng, PEN_SHOOTER_WEIGHTS);
  return resolveKick(state, "cpu", shot.index, zone, shot.rng);
}

/** 直近のキック（結果表示用）。 */
export function penaltyLastKick(state: PenaltyState): PenKick | null {
  return state.kicks[state.kicks.length - 1] ?? null;
}
