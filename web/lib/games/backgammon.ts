// バックギャモンの純粋ロジック（UI 非依存・シード決定的）。対 CPU 専用。
// 状態は JSON 化可能な値だけを持ち、全ての遷移関数は入力を変更しない。
//
// 盤面表現: points は24要素で、正の数はプレイヤー0、負の数はプレイヤー1のコマ数。
// - プレイヤー0（あなた）: index 23 → 0 の向きに進み、ホームは index 0〜5、0 の外へ上がる。
// - プレイヤー1（CPU）  : index 0 → 23 の向きに進み、ホームは index 18〜23、23 の外へ上がる。
// ルール:
// - ダイス2個。ゾロ目は同じ目を4回使える。
// - 相手コマが1個だけのマスはヒットでき、相手コマはバーへ送られる。
// - 相手コマが2個以上のマスには入れない（ブロック）。
// - コマがバーにある間は、バーからの復帰しかできない。
// - 自分のコマが全部ホームに入ったらベアオフ（上がり）できる。
//   ぴったりの目で上がり、そのマスにコマが無い場合のみ大きい目でも上がれる
//   （ただしもっと奥のマスにコマが残っている場合は不可）。
// 簡易化の明示:
// - ダイスの使用順序は自由（両目を使い切る義務や大きい目優先の厳密ルールは採用しない）。
// - ダブリングキューブは無し。

export type BgPlayer = 0 | 1;
export type BgFrom = number | "bar";
export type BgTo = number | "off";

export type BgMove = {
  from: BgFrom;
  die: number;
  to: BgTo;
};

export type BgState = {
  points: number[];
  bar: [number, number];
  off: [number, number];
  turn: BgPlayer;
  /** "roll" = ダイス待ち、"move" = 移動中。 */
  phase: "roll" | "move" | "finished";
  dice: number[];
  lastRoll: [number, number] | null;
  winner: BgPlayer | null;
  turns: number;
  seed: number;
  rng: number;
};

export const BG_TOTAL_CHECKERS = 15;

/** mulberry32 系。状態で持ち回り、決定的に再現する。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function bgCreateGame(seed: number): BgState {
  const points = new Array<number>(24).fill(0);
  // プレイヤー0（正）: 23に2、12に5、7に3、5に5
  points[23] = 2;
  points[12] = 5;
  points[7] = 3;
  points[5] = 5;
  // プレイヤー1（負）: 0に2、11に5、16に3、18に5
  points[0] = -2;
  points[11] = -5;
  points[16] = -3;
  points[18] = -5;
  return {
    points,
    bar: [0, 0],
    off: [0, 0],
    turn: 0,
    phase: "roll",
    dice: [],
    lastRoll: null,
    winner: null,
    turns: 1,
    seed: seed | 0,
    rng: seed | 0,
  };
}

function sign(player: BgPlayer): number {
  return player === 0 ? 1 : -1;
}

function dirOf(player: BgPlayer): number {
  return player === 0 ? -1 : 1;
}

function homeRange(player: BgPlayer): [number, number] {
  return player === 0 ? [0, 5] : [18, 23];
}

/** プレイヤーのコマが全部ホームに入っているか。 */
export function bgAllInHome(state: BgState, player: BgPlayer): boolean {
  if (state.bar[player] > 0) return false;
  const s = sign(player);
  const [lo, hi] = homeRange(player);
  for (let i = 0; i < 24; i++) {
    if (i >= lo && i <= hi) continue;
    if (state.points[i] * s > 0) return false;
  }
  return true;
}

/** 残りピップ数（ゴールまでの距離合計）。小さいほど進んでいる。 */
export function bgPipCount(state: BgState, player: BgPlayer): number {
  const s = sign(player);
  let pips = state.bar[player] * 25;
  for (let i = 0; i < 24; i++) {
    const count = state.points[i] * s;
    if (count <= 0) continue;
    const distance = player === 0 ? i + 1 : 24 - i;
    pips += count * distance;
  }
  return pips;
}

/** 目的地に入れるか。相手1個はヒット可、相手2個以上はブロック。 */
function canLand(state: BgState, player: BgPlayer, index: number): boolean {
  const opp = state.points[index] * sign(player);
  return opp >= -1;
}

/** from（数値index）から die を使った移動先。ベアオフ可否も判定する。 */
function moveDest(state: BgState, player: BgPlayer, from: number, die: number): BgTo | null {
  const to = from + dirOf(player) * die;
  if (to >= 0 && to <= 23) {
    return canLand(state, player, to) ? to : null;
  }
  // 盤外 = ベアオフ候補
  if (!bgAllInHome(state, player)) return null;
  const distance = player === 0 ? from + 1 : 24 - from;
  if (die === distance) return "off";
  if (die > distance) {
    // 大きい目で上がれるのは、そのマスより奥に自分のコマが無いときだけ。
    const s = sign(player);
    if (player === 0) {
      for (let i = from + 1; i <= 5; i++) if (state.points[i] * s > 0) return null;
    } else {
      for (let i = 18; i < from; i++) if (state.points[i] * s > 0) return null;
    }
    return "off";
  }
  return null;
}

/** バーからの復帰先。 */
function entryDest(state: BgState, player: BgPlayer, die: number): number | null {
  const index = player === 0 ? 24 - die : die - 1;
  return canLand(state, player, index) ? index : null;
}

/** 現在のダイスで可能な合法手を全て列挙する（同じ目が複数あれば重複させない）。 */
export function bgLegalMoves(state: BgState): BgMove[] {
  if (state.phase !== "move") return [];
  const player = state.turn;
  const s = sign(player);
  const dice = [...new Set(state.dice)];
  const moves: BgMove[] = [];
  if (state.bar[player] > 0) {
    for (const die of dice) {
      const to = entryDest(state, player, die);
      if (to !== null) moves.push({ from: "bar", die, to });
    }
    return moves;
  }
  for (let i = 0; i < 24; i++) {
    if (state.points[i] * s <= 0) continue;
    for (const die of dice) {
      const to = moveDest(state, player, i, die);
      if (to !== null) moves.push({ from: i, die, to });
    }
  }
  return moves;
}

function endTurn(state: BgState): BgState {
  const next = (1 - state.turn) as BgPlayer;
  return {
    ...state,
    turn: next,
    phase: "roll",
    dice: [],
    turns: state.turns + (next === 0 ? 1 : 0),
  };
}

/** ダイスを振る。phase が "roll" のときだけ有効。ゾロ目は4回分。 */
export function bgRollDice(state: BgState): BgState {
  if (state.phase !== "roll") return state;
  let rng = state.rng;
  const r1 = nextRandom(rng);
  rng = r1.rng;
  const r2 = nextRandom(rng);
  rng = r2.rng;
  const d1 = 1 + Math.floor(r1.value * 6);
  const d2 = 1 + Math.floor(r2.value * 6);
  const dice = d1 === d2 ? [d1, d1, d1, d1] : [d1, d2];
  return { ...state, rng, dice, lastRoll: [d1, d2], phase: "move" };
}

/** 1手進める。不正な手は状態を変えずにそのまま返す。 */
export function bgApplyMove(state: BgState, move: BgMove): BgState {
  if (state.phase !== "move") return state;
  const legal = bgLegalMoves(state);
  const ok = legal.some(
    (m) => m.from === move.from && m.die === move.die && m.to === move.to,
  );
  if (!ok) return state;
  const player = state.turn;
  const opp = (1 - player) as BgPlayer;
  const s = sign(player);
  const points = [...state.points];
  const bar: [number, number] = [...state.bar];
  const off: [number, number] = [...state.off];

  if (move.from === "bar") {
    bar[player]--;
  } else {
    points[move.from] -= s;
  }
  if (move.to === "off") {
    off[player]++;
  } else {
    if (points[move.to] === -s) {
      // ヒット: 相手コマ1個をバーへ
      points[move.to] = s;
      bar[opp]++;
    } else {
      points[move.to] += s;
    }
  }
  const dice = [...state.dice];
  const dieIndex = dice.indexOf(move.die);
  if (dieIndex >= 0) dice.splice(dieIndex, 1);

  let next: BgState = { ...state, points, bar, off, dice };
  if (off[player] >= BG_TOTAL_CHECKERS) {
    return { ...next, phase: "finished", winner: player };
  }
  // ダイスを使い切ったら自動で手番交代。
  if (dice.length === 0) {
    next = endTurn(next);
  }
  return next;
}

/** 残りダイスを放棄して手番を終える（合法手が無いとき用。通常は自動で交代する）。 */
export function bgPassTurn(state: BgState): BgState {
  if (state.phase === "finished") return state;
  return endTurn({ ...state, dice: [] });
}

/** CPU 評価: player 視点のスコア（大きいほど有利）。 */
export function bgEvaluate(state: BgState, player: BgPlayer): number {
  const opp = (1 - player) as BgPlayer;
  let score = 0;
  score += state.off[player] * 120;
  score -= state.off[opp] * 120;
  score -= bgPipCount(state, player);
  score += bgPipCount(state, opp);
  score -= state.bar[player] * 60;
  score += state.bar[opp] * 60;
  const s = sign(player);
  const os = sign(opp);
  for (let i = 0; i < 24; i++) {
    const mine = state.points[i] * s;
    if (mine >= 2) score += 10; // 作ったマスは安全で有利
    if (mine === 1) {
      // 単独コマは、相手の射程内にいると危険
      score -= 4;
      for (let d = 1; d <= 6; d++) {
        const from = i - dirOf(opp) * d;
        if (from >= 0 && from <= 23 && state.points[from] * os > 0) {
          score -= 9;
          break;
        }
      }
    }
  }
  return score;
}

/** CPU の1手を選ぶ。合法手が無ければ null。 */
export function bgChooseMove(state: BgState): BgMove | null {
  const moves = bgLegalMoves(state);
  if (moves.length === 0) return null;
  const player = state.turn;
  let best: BgMove | null = null;
  let bestScore = -Infinity;
  for (const move of moves) {
    // bgApplyMove の副作用（自動手番交代）を避けるため、評価は内部盤面で近似する:
    // 1手だけ適用した局面を bgEvaluate で採点する。
    const after = bgApplyMovePreview(state, move);
    let score = bgEvaluate(after, player);
    // ヒットは追加で強く評価
    if (typeof move.to === "number" && state.points[move.to] === -sign(player)) {
      score += 35;
    }
    // ベアオフも加点
    if (move.to === "off") score += 25;
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }
  return best;
}

/** 評価専用: 手番交代をせずに1手だけ適用した局面を返す。 */
function bgApplyMovePreview(state: BgState, move: BgMove): BgState {
  const player = state.turn;
  const opp = (1 - player) as BgPlayer;
  const s = sign(player);
  const points = [...state.points];
  const bar: [number, number] = [...state.bar];
  const off: [number, number] = [...state.off];
  if (move.from === "bar") bar[player]--;
  else points[move.from] -= s;
  if (move.to === "off") off[player]++;
  else if (points[move.to] === -s) {
    points[move.to] = s;
    bar[opp]++;
  } else {
    points[move.to] += s;
  }
  const dice = [...state.dice];
  const idx = dice.indexOf(move.die);
  if (idx >= 0) dice.splice(idx, 1);
  return { ...state, points, bar, off, dice };
}
