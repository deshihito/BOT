// ドミノ（ドローゲーム、2〜4人）のルールモジュール。
// モジュール契約は lib/online/types.ts の OnlineGameModule に従う。
// 実行時 import は禁止（テストが import を剥がして連結するため type のみ）。
//
// 牌表現: ダブル6セット28枚。tile id は [0,0]=0 から辞書順に振る。
// 場はチェーン（置かれた順）で持ち、各牌は表示向き left/right の目を持つ。
// 両端の目に合う牌を左右どちらかの端に置ける。出せる牌が無いときは
// 山から1枚ずつ引き、山が尽きたらパス。全員が連続で手詰まりになるか、
// 誰かが手札を出し切ったら終了し、残り手札の目の合計が少ない人が勝ち。
// 手札は viewFor で本人のものだけを返し、他人は枚数だけが見える。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export const DOMINO_MAX_PIP = 6;
export const DOMINO_TILE_COUNT = 28;

/** tile id → [小さい目, 大きい目]。 */
export function dominoTilePips(id: number): [number, number] {
  let rest = id;
  for (let a = 0; a <= DOMINO_MAX_PIP; a++) {
    for (let b = a; b <= DOMINO_MAX_PIP; b++) {
      if (rest === 0) return [a, b];
      rest--;
    }
  }
  return [6, 6];
}

export function dominoPipSum(id: number): number {
  const [a, b] = dominoTilePips(id);
  return a + b;
}

export interface DominoPlaced {
  tile: number;
  /** チェーンの左側に表示される目。 */
  left: number;
  /** チェーンの右側に表示される目。 */
  right: number;
}

export interface DominoLogEntry {
  seat: number;
  kind: "place" | "draw" | "pass" | "finish" | "win" | "left";
  tile?: number;
  side?: "left" | "right";
}

export interface DominoState {
  players: SeatInfo[];
  hands: number[][];
  boneyard: number[];
  board: DominoPlaced[];
  turn: number;
  /** 連続で置けなかった手番の数（全員分続いたら詰まり終了）。 */
  noPlaceStreak: number;
  finished: boolean;
  /** 残り手札の目合計（小さいほど上位）。終了時のみ確定。 */
  scores: number[];
  winners: number[];
  leftSeats: number[];
  starter: number;
  log: DominoLogEntry[];
}

export type DominoAction =
  | { type: "place"; tile: number; side: "left" | "right" }
  | { type: "draw" }
  | { type: "pass" };

export interface DominoOtherView {
  seat: number;
  name: string;
  count: number;
  left: boolean;
}

export interface DominoView {
  yourHand: number[];
  others: DominoOtherView[];
  board: DominoPlaced[];
  leftEnd: number | null;
  rightEnd: number | null;
  boneyardCount: number;
  turn: number;
  finished: boolean;
  scores: number[];
  winners: number[];
  yourPlayable: number[];
  canDraw: boolean;
  canPass: boolean;
  log: DominoLogEntry[];
  players: SeatInfo[];
}

function domClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function domIsActive(state: DominoState, seat: number): boolean {
  return !state.leftSeats.includes(seat);
}

function domActiveSeats(state: DominoState): number[] {
  const out: number[] = [];
  for (let s = 0; s < state.players.length; s++) {
    if (domIsActive(state, s)) out.push(s);
  }
  return out;
}

function domNextActive(state: DominoState, seat: number): number {
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const cand = (seat + step) % n;
    if (domIsActive(state, cand)) return cand;
  }
  return seat;
}

function domPushLog(state: DominoState, entry: DominoLogEntry): void {
  state.log = [...state.log, entry].slice(-30);
}

/** 両端の目 [left, right]。場が空なら null。 */
export function dominoEnds(state: DominoState): [number, number] | null {
  if (state.board.length === 0) return null;
  return [state.board[0].left, state.board[state.board.length - 1].right];
}

/** その牌が指定側に出せるか。 */
export function dominoCanPlaceOn(state: DominoState, tile: number, side: "left" | "right"): boolean {
  const ends = dominoEnds(state);
  if (!ends) return true;
  const [a, b] = dominoTilePips(tile);
  const end = side === "left" ? ends[0] : ends[1];
  return a === end || b === end;
}

/** 手札のうち場に出せる牌の id 一覧。 */
export function dominoPlayableTiles(state: DominoState, seat: number): number[] {
  const hand = state.hands[seat] ?? [];
  if (dominoEnds(state) === null) return [...hand];
  return hand.filter(
    (t) => dominoCanPlaceOn(state, t, "left") || dominoCanPlaceOn(state, t, "right"),
  );
}

function domFinish(state: DominoState): void {
  state.finished = true;
  // 退出者は順位対象外。JSON 化できるよう無限大ではなく大きな番兵値を使う。
  state.scores = state.players.map((_, s) =>
    domIsActive(state, s)
      ? state.hands[s].reduce((sum, t) => sum + dominoPipSum(t), 0)
      : 9999,
  );
  const active = domActiveSeats(state);
  let best = 9999;
  for (const s of active) best = Math.min(best, state.scores[s]);
  state.winners = active.filter((s) => state.scores[s] === best);
  for (const w of state.winners) domPushLog(state, { seat: w, kind: "win" });
}

function domHandSize(players: number): number {
  return players === 4 ? 5 : 7;
}

/** 最初の手番: 最高のダブル持ち。無ければ目合計が最大の牌の持ち主。 */
function domFindStarter(hands: number[][]): number {
  let bestDouble = -1;
  let starter = 0;
  hands.forEach((hand, s) => {
    for (const t of hand) {
      const [a, b] = dominoTilePips(t);
      if (a === b && a > bestDouble) {
        bestDouble = a;
        starter = s;
      }
    }
  });
  if (bestDouble >= 0) return starter;
  let bestScore = -1;
  hands.forEach((hand, s) => {
    for (const t of hand) {
      const [a, b] = dominoTilePips(t);
      const score = dominoPipSum(t) * 10 + Math.max(a, b);
      if (score > bestScore) {
        bestScore = score;
        starter = s;
      }
    }
  });
  return starter;
}

function domCreateState(
  players: SeatInfo[],
  rng: Rng,
  _options: Record<string, unknown>,
): DominoState {
  if (!Array.isArray(players) || players.length < 2 || players.length > 4) {
    throw new Error("ドミノは2〜4人で遊びます");
  }
  const deck: number[] = Array.from({ length: DOMINO_TILE_COUNT }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  const n = players.length;
  const per = domHandSize(n);
  const hands: number[][] = Array.from({ length: n }, () => []);
  let pos = 0;
  for (let s = 0; s < n; s++) {
    for (let k = 0; k < per; k++) {
      hands[s].push(deck[pos]);
      pos++;
    }
  }
  const starter = domFindStarter(hands);
  return {
    players: domClone(players),
    hands,
    boneyard: deck.slice(pos),
    board: [],
    turn: starter,
    noPlaceStreak: 0,
    finished: false,
    scores: [],
    winners: [],
    leftSeats: [],
    starter,
    log: [],
  };
}

function domAdvance(state: DominoState): void {
  state.turn = domNextActive(state, state.turn);
}

function domApplyAction(
  state: DominoState,
  seat: number,
  action: DominoAction,
  _rng: Rng,
): DominoState {
  if (state.finished) throw new Error("ゲームは終了しています");
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) {
    throw new Error("不正な席です");
  }
  if (!domIsActive(state, seat)) throw new Error("既に退出したプレイヤーです");
  if (seat !== state.turn) throw new Error("手番ではありません");
  if (!action || typeof action !== "object") throw new Error("不正なアクションです");

  const playable = dominoPlayableTiles(state, seat);

  if (action.type === "draw") {
    if (playable.length > 0) throw new Error("出せる牌があるときは引けません");
    if (state.boneyard.length === 0) throw new Error("山が尽きています");
    const next = domClone(state);
    const tile = next.boneyard.pop() as number;
    next.hands[seat].push(tile);
    domPushLog(next, { seat, kind: "draw" });
    // 引いたら手番は継続（出せる牌が出るまで引ける）。ただし出せる牌が
    // 出た時点で自動的には置かないので、クライアント側で続けて置く操作を行う。
    return next;
  }

  if (action.type === "pass") {
    if (playable.length > 0) throw new Error("出せる牌があります");
    if (state.boneyard.length > 0) throw new Error("まだ山から引けます");
    const next = domClone(state);
    next.noPlaceStreak++;
    domPushLog(next, { seat, kind: "pass" });
    if (next.noPlaceStreak >= domActiveSeats(next).length) {
      domFinish(next);
      return next;
    }
    domAdvance(next);
    return next;
  }

  if (action.type === "place") {
    const tile = action.tile;
    const side = action.side;
    if (!Number.isInteger(tile) || tile < 0 || tile >= DOMINO_TILE_COUNT) {
      throw new Error("不正な牌です");
    }
    if (side !== "left" && side !== "right") throw new Error("置く側が不正です");
    if (!state.hands[seat].includes(tile)) throw new Error("その牌は持っていません");
    const next = domClone(state);
    const ends = dominoEnds(next);
    const [a, b] = dominoTilePips(tile);
    if (ends === null) {
      next.board.push({ tile, left: a, right: b });
    } else if (side === "left") {
      const end = ends[0];
      if (a !== end && b !== end) throw new Error("左端の目に合いません");
      const placed: DominoPlaced =
        b === end ? { tile, left: a, right: b } : { tile, left: b, right: a };
      next.board.unshift(placed);
    } else {
      const end = ends[1];
      if (a !== end && b !== end) throw new Error("右端の目に合いません");
      const placed: DominoPlaced =
        a === end ? { tile, left: a, right: b } : { tile, left: b, right: a };
      next.board.push(placed);
    }
    next.hands[seat] = next.hands[seat].filter((t) => t !== tile);
    next.noPlaceStreak = 0;
    domPushLog(next, { seat, kind: "place", tile, side });
    if (next.hands[seat].length === 0) {
      domPushLog(next, { seat, kind: "finish" });
      domFinish(next);
      return next;
    }
    domAdvance(next);
    return next;
  }

  throw new Error("不正なアクションです");
}

function domViewFor(state: DominoState, seat: number): DominoView {
  const playable = state.finished ? [] : dominoPlayableTiles(state, seat);
  const isTurn = !state.finished && state.turn === seat && domIsActive(state, seat);
  return {
    yourHand: [...(state.hands[seat] ?? [])],
    others: state.players
      .map((p, s) => ({
        seat: s,
        name: p.name,
        count: state.hands[s]?.length ?? 0,
        left: state.leftSeats.includes(s),
      }))
      .filter((o) => o.seat !== seat),
    board: domClone(state.board),
    leftEnd: dominoEnds(state)?.[0] ?? null,
    rightEnd: dominoEnds(state)?.[1] ?? null,
    boneyardCount: state.boneyard.length,
    turn: state.turn,
    finished: state.finished,
    scores: state.finished ? [...state.scores] : [],
    winners: state.finished ? [...state.winners] : [],
    yourPlayable: isTurn ? playable : [],
    canDraw: isTurn && playable.length === 0 && state.boneyard.length > 0,
    canPass: isTurn && playable.length === 0 && state.boneyard.length === 0,
    log: domClone(state.log),
    players: domClone(state.players),
  };
}

function domParseAction(raw: unknown): DominoAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.type === "draw") return { type: "draw" };
  if (r.type === "pass") return { type: "pass" };
  if (r.type === "place") {
    if (typeof r.tile !== "number" || !Number.isInteger(r.tile) || r.tile < 0 || r.tile >= DOMINO_TILE_COUNT) {
      return null;
    }
    if (r.side !== "left" && r.side !== "right") return null;
    return { type: "place", tile: r.tile, side: r.side };
  }
  return null;
}

function domOnPlayerLeft(state: DominoState, seat: number): DominoState {
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) {
    throw new Error("不正な席です");
  }
  if (state.finished) return domClone(state);
  if (!domIsActive(state, seat)) return domClone(state);
  const next = domClone(state);
  next.hands[seat] = [];
  next.leftSeats.push(seat);
  domPushLog(next, { seat, kind: "left" });
  // 残り現役が1人になったら、その人が勝者で終了する。
  if (domActiveSeats(next).length <= 1) {
    domFinish(next);
    return next;
  }
  if (next.turn === seat) {
    next.noPlaceStreak = 0;
    domAdvance(next);
  }
  return next;
}

export const gameModule: OnlineGameModule<DominoState, DominoAction, DominoView> = {
  id: "domino",
  title: "ドミノ",
  minPlayers: 2,
  maxPlayers: 4,
  cpuSupported: false,
  chatEnabled: true,
  createState: domCreateState,
  applyAction: domApplyAction,
  viewFor: domViewFor,
  parseAction: domParseAction,
  phaseOf: (state) => (state.finished ? "finished" : "playing"),
  isFinished: (state) => state.finished,
  onPlayerLeft: domOnPlayerLeft,
};
