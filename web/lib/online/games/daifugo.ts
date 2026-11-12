// 大富豪（2〜4人）: 8切り・革命・反則あがりありの固定ルール実装。
// モジュール契約は lib/online/types.ts の OnlineGameModule に従う。
// 実行時 import は禁止（テストが import を剥がして連結するため type のみ）。
//
// カード表現: id 0〜51 が通常札（suit = floor(id/13): 0=♠,1=♥,2=♦,3=♣、
// rank = (id % 13) + 3 で 3〜15。15 が「2」）、id 52 がジョーカー。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export const JOKER = 52;
/** ♦3 のカード id（最初の手番の目印）。 */
export const DIAMOND3 = 26;
/** ♠3 のカード id（スペ3返しで使う）。 */
export const SPADE3 = 0;

/** ルーム作成時にホストが選べるローカルルール。既定値は従来の固定ルールと同一。 */
export interface DaifugoRules {
  /** 革命（5枚以上で革命が発動/解除される）。 */
  revolution: boolean;
  /** 8切り（8を含む手を出すと場が流れて自分がリード）。 */
  eightCut: boolean;
  /** スペ3返し（ジョーカー単体に♠3単体で返せる）。 */
  spade3Return: boolean;
  /** 縛り（場と同じマークを出すと、以後の手はそのマークに縛られる）。 */
  suitLock: boolean;
}

export const DEFAULT_DAIFUGO_RULES: DaifugoRules = {
  revolution: true,
  eightCut: true,
  spade3Return: false,
  suitLock: false,
};

/** options.rules を正規化する（真偽値以外は既定値に倒す）。 */
export function normalizeDaifugoRules(raw: unknown): DaifugoRules {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_DAIFUGO_RULES };
  const r = raw as Record<string, unknown>;
  const pick = (key: keyof DaifugoRules): boolean =>
    typeof r[key] === "boolean" ? (r[key] as boolean) : DEFAULT_DAIFUGO_RULES[key];
  return {
    revolution: pick("revolution"),
    eightCut: pick("eightCut"),
    spade3Return: pick("spade3Return"),
    suitLock: pick("suitLock"),
  };
}

function parseOptions(raw: Record<string, unknown>): Record<string, unknown> {
  return { rules: normalizeDaifugoRules(raw?.rules) };
}

export interface DaifugoField {
  cards: number[];
  seat: number;
}

export interface DaifugoLogEntry {
  seat: number;
  kind: "play" | "pass";
  cards?: number[];
}

export interface DaifugoState {
  players: SeatInfo[];
  hands: number[][];
  field: DaifugoField | null;
  revolution: boolean;
  turn: number;
  passStreak: number;
  /** リードパス（反則あがり回避の例外パス）が連続した回数。stalemate 裁定用。 */
  leadPassStreak: number;
  finishOrder: number[];
  finished: boolean;
  log: DaifugoLogEntry[];
  /** 退出した seat（順位は付けない）。 */
  leftSeats: number[];
  started: boolean;
  /** このルームのローカルルール。 */
  rules: DaifugoRules;
  /** 縛り中のマーク（suit 番号）。縛りが無ければ null。 */
  lockedSuit: number | null;
}

export type DaifugoAction =
  | { type: "play"; cards: number[] }
  | { type: "pass" };

export interface DaifugoView {
  yourHand: number[];
  others: { seat: number; name: string; count: number; finished: number | null }[];
  field: DaifugoField | null;
  revolution: boolean;
  turn: number;
  finishOrder: number[];
  yourRank: number | null;
  finished: boolean;
  log: DaifugoLogEntry[];
  players: SeatInfo[];
  rules: DaifugoRules;
  lockedSuit: number | null;
}

/** 状態のルールを読む（手組みの旧状態でも既定値で動くよう正規化して返す）。 */
function rulesOf(state: DaifugoState): DaifugoRules {
  return state.rules ? normalizeDaifugoRules(state.rules) : { ...DEFAULT_DAIFUGO_RULES };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 通常札のランク（3〜15）。ジョーカーは null。 */
export function rankOf(id: number): number | null {
  if (id === JOKER) return null;
  return (id % 13) + 3;
}

/** 手札の表示順ソートキー（ランク昇順、ジョーカーは最後）。 */
function sortKey(id: number): number {
  return id === JOKER ? 100 : (rankOf(id) as number);
}

function sortHand(hand: number[]): number[] {
  return [...hand].sort((a, b) => sortKey(a) - sortKey(b) || a - b);
}

interface ComboInfo {
  /** 実効ランク（ジョーカー以外の札のランク）。ジョーカー単体では null。 */
  effRank: number | null;
  jokerSingle: boolean;
  count: number;
}

/** 組み合わせの妥当性を判定する。不正なら null。 */
function comboInfo(cards: number[]): ComboInfo | null {
  if (!Array.isArray(cards) || cards.length === 0) return null;
  if (new Set(cards).size !== cards.length) return null;
  for (const c of cards) {
    if (!Number.isInteger(c) || c < 0 || c > 52) return null;
  }
  const nonJoker = cards.filter((c) => c !== JOKER);
  if (nonJoker.length === 0) {
    // ジョーカーはデッキに1枚だけなので、複数枚のジョーカー組は存在しない。
    if (cards.length !== 1) return null;
    return { effRank: null, jokerSingle: true, count: 1 };
  }
  const rank = rankOf(nonJoker[0]);
  if (nonJoker.some((c) => rankOf(c) !== rank)) return null;
  return { effRank: rank, jokerSingle: false, count: cards.length };
}

/** 強さの数値化。ジョーカー単体は革命中でも常に最強として扱う。 */
function strengthOf(info: ComboInfo, revolution: boolean): number {
  if (info.jokerSingle) return 1000;
  const rank = info.effRank as number;
  return revolution ? -rank : rank;
}

/** 実札の8を含むか（ジョーカーを8として使った場合は含めない）。 */
function hasReal8(cards: number[]): boolean {
  return cards.some((c) => c !== JOKER && rankOf(c) === 8);
}

/** その手を出すと反則あがりになるか（手札が0になる前提で判定する側が使う）。 */
function isForbiddenFinish(cards: number[], handSize: number, rules: DaifugoRules): boolean {
  if (cards.length !== handSize) return false;
  return (
    (rules.eightCut && hasReal8(cards)) ||
    cards.includes(JOKER) ||
    (rules.revolution && cards.length >= 5)
  );
}

/**
 * 組み合わせの実効マーク。ジョーカー以外の札が全て同じマークならその番号、
 * ジョーカー単体は "wild"（どのマークとしても扱える）、マークが混ざれば null。
 */
function comboSuit(cards: number[]): number | "wild" | null {
  const nonJoker = cards.filter((c) => c !== JOKER);
  if (nonJoker.length === 0) return "wild";
  const suit = Math.floor(nonJoker[0] / 13);
  return nonJoker.every((c) => Math.floor(c / 13) === suit) ? suit : null;
}

/** スペ3返しが成立する手か（ルール有効時、場がジョーカー単体で♠3単体を出す）。 */
function isSpade3Return(state: DaifugoState, cards: number[], rules: DaifugoRules): boolean {
  if (!rules.spade3Return || !state.field) return false;
  if (cards.length !== 1 || cards[0] !== SPADE3) return false;
  const fieldInfo = comboInfo(state.field.cards);
  return !!fieldInfo && fieldInfo.jokerSingle;
}

function isActive(state: DaifugoState, seat: number): boolean {
  return !state.finishOrder.includes(seat) && !state.leftSeats.includes(seat);
}

function activeSeats(state: DaifugoState): number[] {
  const out: number[] = [];
  for (let s = 0; s < state.players.length; s++) {
    if (isActive(state, s)) out.push(s);
  }
  return out;
}

function nextActive(state: DaifugoState, from: number): number {
  const n = state.players.length;
  for (let step = 1; step <= n; step++) {
    const s = (from + step) % n;
    if (isActive(state, s)) return s;
  }
  return from;
}

/** 場が流れるまでに必要な連続パス数（場の持ち主が現役でない場合は現役全員）。 */
function neededPasses(state: DaifugoState): number {
  const active = activeSeats(state).length;
  const ownerActive = state.field ? isActive(state, state.field.seat) : false;
  return active - (ownerActive ? 1 : 0);
}

/**
 * 手札から作れる組み合わせ候補を列挙する（同じランクの部分集合＋ジョーカー付加）。
 * 同ランク内ではどの札を選んでも強さは同じなので代表だけを出す。
 */
function enumerateCombos(hand: number[]): number[][] {
  const combos: number[][] = [];
  const seen = new Set<string>();
  const push = (cards: number[]) => {
    const key = [...cards].sort((a, b) => a - b).join(",");
    if (seen.has(key)) return;
    seen.add(key);
    combos.push([...cards].sort((a, b) => a - b));
  };
  const byRank = new Map<number, number[]>();
  for (const c of hand) {
    if (c === JOKER) continue;
    const r = rankOf(c) as number;
    if (!byRank.has(r)) byRank.set(r, []);
    (byRank.get(r) as number[]).push(c);
  }
  const hasJoker = hand.includes(JOKER);
  for (const ids of byRank.values()) {
    const sorted = [...ids].sort((a, b) => a - b);
    for (let k = 1; k <= sorted.length; k++) {
      push(sorted.slice(0, k));
      if (hasJoker) push([...sorted.slice(0, k), JOKER]);
    }
  }
  if (hasJoker) push([JOKER]);
  return combos;
}

/**
 * その seat が現在出せる合法手（反則あがりを除く）をすべて列挙する。
 * 場がある場合は枚数一致＋より強いもののみ、リード時は全組み合わせ。
 */
export function legalPlays(state: DaifugoState, seat: number): number[][] {
  const hand = state.hands[seat];
  if (!hand) return [];
  const rules = rulesOf(state);
  const fieldInfo = state.field ? comboInfo(state.field.cards) : null;
  const lockedSuit = rules.suitLock ? (state.lockedSuit ?? null) : null;
  return enumerateCombos(hand).filter((cards) => {
    if (isForbiddenFinish(cards, hand.length, rules)) return false;
    if (!fieldInfo) return true;
    const info = comboInfo(cards);
    if (!info || info.count !== fieldInfo.count) return false;
    if (lockedSuit !== null) {
      const suit = comboSuit(cards);
      if (suit !== "wild" && suit !== lockedSuit) return false;
    }
    if (isSpade3Return(state, cards, rules)) return true;
    return strengthOf(info, state.revolution) > strengthOf(fieldInfo, state.revolution);
  });
}

function pushLog(state: DaifugoState, entry: DaifugoLogEntry): void {
  state.log = [...state.log, entry].slice(-20);
}

function createState(
  players: SeatInfo[],
  rng: Rng,
  options: Record<string, unknown>,
): DaifugoState {
  const rules = normalizeDaifugoRules(options?.rules);
  if (!Array.isArray(players) || players.length < 2 || players.length > 4) {
    throw new Error("大富豪は2〜4人で遊びます");
  }
  const deck: number[] = Array.from({ length: 53 }, (_, i) => i);
  // Fisher-Yates シャッフル（rng 駆動で決定的に再現可能）。
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  const n = players.length;
  const hands: number[][] = Array.from({ length: n }, () => []);
  // 1枚ずつ回し配り（余りは先の seat から1枚多くなる）。
  deck.forEach((card, i) => {
    hands[i % n].push(card);
  });
  const sortedHands = hands.map(sortHand);
  const turn = sortedHands.findIndex((h) => h.includes(DIAMOND3));
  return {
    players: clone(players),
    hands: sortedHands,
    field: null,
    revolution: false,
    turn,
    passStreak: 0,
    leadPassStreak: 0,
    finishOrder: [],
    finished: false,
    log: [],
    leftSeats: [],
    started: true,
    rules,
    lockedSuit: null,
  };
}

function applyPlay(
  state: DaifugoState,
  seat: number,
  cards: number[],
): DaifugoState {
  const hand = state.hands[seat];
  if (!Array.isArray(cards) || cards.length === 0) {
    throw new Error("出すカードを選んでください");
  }
  if (new Set(cards).size !== cards.length) {
    throw new Error("同じカードは複数出せません");
  }
  for (const c of cards) {
    if (!hand.includes(c)) {
      throw new Error("手札にないカードは出せません");
    }
  }
  const rules = rulesOf(state);
  const info = comboInfo(cards);
  if (!info) {
    throw new Error("同じランクの組み合わせでしか出せません");
  }
  if (state.field) {
    const fieldInfo = comboInfo(state.field.cards) as ComboInfo;
    if (info.count !== fieldInfo.count) {
      throw new Error("場と同じ枚数で出してください");
    }
    if (
      !isSpade3Return(state, cards, rules) &&
      strengthOf(info, state.revolution) <= strengthOf(fieldInfo, state.revolution)
    ) {
      throw new Error("場より強い組み合わせで出してください");
    }
    // 縛り中は場と同じマーク（またはジョーカー単体）しか出せない
    const lockedSuit = rules.suitLock ? (state.lockedSuit ?? null) : null;
    if (lockedSuit !== null) {
      const suit = comboSuit(cards);
      if (suit !== "wild" && suit !== lockedSuit) {
        throw new Error("縛り中は同じマークでしか出せません");
      }
    }
  }
  if (isForbiddenFinish(cards, hand.length, rules)) {
    throw new Error("反則あがりになる手は出せません");
  }

  const next = clone(state);
  const played = [...cards].sort((a, b) => a - b);
  next.hands[seat] = sortHand(hand.filter((c) => !cards.includes(c)));
  next.field = { cards: played, seat };
  next.passStreak = 0;
  next.leadPassStreak = 0;
  pushLog(next, { seat, kind: "play", cards: played });
  // 縛りの成立/維持: 場と同じマークを出すと縛りが発生し、場が流れるまで続く。
  if (rules.suitLock && state.field) {
    const playedSuit = comboSuit(played);
    const fieldSuit = comboSuit(state.field.cards);
    if (typeof playedSuit === "number" && playedSuit === fieldSuit) {
      next.lockedSuit = playedSuit;
    } else if (typeof state.lockedSuit === "number") {
      next.lockedSuit = state.lockedSuit;
    } else {
      next.lockedSuit = null;
    }
  } else {
    next.lockedSuit = null;
  }
  // 革命の発動/解除はトグル。その手自体の強さ判定は発動前の状態で済んでいる。
  if (rules.revolution && played.length >= 5) {
    next.revolution = !next.revolution;
  }
  const finishedNow = next.hands[seat].length === 0;
  if (finishedNow) {
    next.finishOrder.push(seat);
  }
  const remaining = activeSeats(next);
  if (remaining.length === 1) {
    next.finishOrder.push(remaining[0]);
    next.finished = true;
    next.turn = remaining[0];
    return next;
  }
  if (rules.eightCut && hasReal8(played)) {
    // 8切り: その手の直後に場が流れ、出した本人が次のリードになる。
    // （8を含む手で上がることは反則あがりとして弾かれているので本人は現役。）
    next.field = null;
    next.lockedSuit = null;
    next.turn = seat;
    return next;
  }
  next.turn = nextActive(next, seat);
  return next;
}

function applyPass(state: DaifugoState, seat: number): DaifugoState {
  const next = clone(state);
  next.lockedSuit = rulesOf(state).suitLock ? (state.lockedSuit ?? null) : null;
  pushLog(next, { seat, kind: "pass" });
  if (!state.field) {
    // リードでは原則パス不可。合法手が反則あがりしか存在しない場合のみ許可する
    // （デッドロック回避の例外）。
    if (legalPlays(state, seat).length > 0) {
      throw new Error("リードではパスできません");
    }
    next.leadPassStreak = state.leadPassStreak + 1;
    const remaining = activeSeats(next);
    if (next.leadPassStreak >= remaining.length) {
      // stalemate 裁定（コーディネーター固定）: 全員の手札が反則あがりに
      // なる札しか残っておらず、リードパスが現役全員分連続したら、残りの
      // 現役を seat 順に順位確定してゲームを終了する。
      for (const s of remaining) next.finishOrder.push(s);
      next.finished = true;
      next.turn = remaining[0];
      return next;
    }
    next.turn = nextActive(next, seat);
    return next;
  }
  next.passStreak = state.passStreak + 1;
  if (next.passStreak >= neededPasses(next)) {
    // 場が流れる。次のリードは場の持ち主（上がっている/退出済みなら次の現役）。
    const owner = (state.field as DaifugoField).seat;
    next.field = null;
    next.lockedSuit = null;
    next.passStreak = 0;
    next.leadPassStreak = 0;
    next.turn = isActive(next, owner) ? owner : nextActive(next, owner);
  } else {
    next.turn = nextActive(next, seat);
  }
  return next;
}

function applyAction(
  state: DaifugoState,
  seat: number,
  action: DaifugoAction,
  rng: Rng,
): DaifugoState {
  void rng;
  if (state.finished) {
    throw new Error("ゲームは終了しています");
  }
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) {
    throw new Error("不正な席です");
  }
  if (!isActive(state, seat)) {
    throw new Error("既に終了したプレイヤーです");
  }
  if (seat !== state.turn) {
    throw new Error("手番ではありません");
  }
  if (!action || typeof action !== "object") {
    throw new Error("不正なアクションです");
  }
  if (action.type === "play") return applyPlay(state, seat, action.cards);
  if (action.type === "pass") return applyPass(state, seat);
  throw new Error("不正なアクションです");
}

function cpuAction(state: DaifugoState, seat: number, rng: Rng): DaifugoAction | null {
  void rng;
  if (state.finished) return null;
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) return null;
  if (!isActive(state, seat) || seat !== state.turn) return null;
  const plays = legalPlays(state, seat);
  if (plays.length === 0) return { type: "pass" };
  // ジョーカーは温存する（ジョーカーなしで出せる手があればそちらを優先）。
  const noJoker = plays.filter((p) => !p.includes(JOKER));
  const pool = noJoker.length > 0 ? noJoker : plays;
  const scored = pool.map((cards) => {
    const info = comboInfo(cards) as ComboInfo;
    return { cards, strength: strengthOf(info, state.revolution) };
  });
  scored.sort((a, b) => {
    if (a.strength !== b.strength) return a.strength - b.strength;
    if (!state.field) {
      // リード: 最も弱いランクの札はそのランクの手持ちをまとめて出す方を優先する。
      // ただし5枚以上の革命組は「強くなりすぎる」ので後回しにして単体寄りに倒す。
      const aBig = a.cards.length >= 5 ? 1 : 0;
      const bBig = b.cards.length >= 5 ? 1 : 0;
      if (aBig !== bBig) return aBig - bBig;
      return b.cards.length - a.cards.length;
    }
    return a.cards.length - b.cards.length;
  });
  return { type: "play", cards: scored[0].cards };
}

function onPlayerLeft(state: DaifugoState, seat: number): DaifugoState {
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) {
    throw new Error("不正な席です");
  }
  if (state.finished) return clone(state);
  if (!isActive(state, seat)) return clone(state);
  const next = clone(state);
  // 退出者の手札を取り除き、順位は付けず現役から外す。
  next.hands[seat] = [];
  next.leftSeats.push(seat);

  const remaining = activeSeats(next);
  if (remaining.length === 1) {
    next.finishOrder.push(remaining[0]);
    next.finished = true;
    next.turn = remaining[0];
    return next;
  }
  if (remaining.length === 0) {
    next.finished = true;
    return next;
  }

  // 場の流れ判定を現役人数で再計算する。
  if (next.field && next.passStreak >= neededPasses(next)) {
    const owner = next.field.seat;
    next.field = null;
    next.lockedSuit = null;
    next.passStreak = 0;
    next.turn = isActive(next, owner) ? owner : nextActive(next, owner);
    return next;
  }
  if (next.turn === seat || !isActive(next, next.turn)) {
    // 手番だったら次の現役プレイヤーへ進める（場の持ち主の札は場に残る）。
    next.turn = nextActive(next, next.turn);
  }
  return next;
}

function viewFor(state: DaifugoState, seat: number): DaifugoView {
  const rankOfSeat = (s: number): number | null => {
    const idx = state.finishOrder.indexOf(s);
    return idx >= 0 ? idx + 1 : null;
  };
  return {
    yourHand: [...(state.hands[seat] ?? [])],
    others: state.players
      .map((p, s) => ({
        seat: s,
        name: p.name,
        count: state.hands[s].length,
        finished: rankOfSeat(s),
      }))
      .filter((o) => o.seat !== seat),
    field: state.field ? { cards: [...state.field.cards], seat: state.field.seat } : null,
    revolution: state.revolution,
    turn: state.turn,
    finishOrder: [...state.finishOrder],
    yourRank: rankOfSeat(seat),
    finished: state.finished,
    log: clone(state.log),
    players: clone(state.players),
    rules: rulesOf(state),
    lockedSuit: rulesOf(state).suitLock ? (state.lockedSuit ?? null) : null,
  };
}

function parseAction(raw: unknown): DaifugoAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.type === "pass") return { type: "pass" };
  if (r.type === "play") {
    if (!Array.isArray(r.cards)) return null;
    const cards: number[] = [];
    for (const c of r.cards) {
      if (typeof c !== "number") return null;
      cards.push(c);
    }
    return { type: "play", cards };
  }
  return null;
}

export const gameModule: OnlineGameModule<DaifugoState, DaifugoAction, DaifugoView> = {
  id: "daifugo",
  title: "大富豪",
  minPlayers: 2,
  maxPlayers: 4,
  cpuSupported: true,
  chatEnabled: true,
  createState,
  applyAction,
  viewFor,
  parseAction,
  parseOptions,
  phaseOf: (state) => (state.finished ? "finished" : "playing"),
  isFinished: (state) => state.finished,
  onPlayerLeft,
  cpuAction,
};
