// ビンゴ対戦（オンライン）のルールモジュール。
// 基盤契約: import は type のみ（テストが import を剥がして連結する）。
// 状態は JSON 化可能な値だけ。tick / onPlayerLeft は純関数。
// 流れ: 全員に専用カード（5x5、列ごとに B=1-15 / I=16-30 / N=31-45 /
// G=46-60 / O=61-75、中央フリー）を配り、tick で 1〜75 を自動抽選する。
// 自分のカードの該当マスは自動で開く。縦・横・斜めのいずれか1ラインを
// 最初に完成させた人が勝ち（同じ抽選で複数人が完成したら同着優勝）。
// 抽選列は全員共通の公開情報だが、他人のカード自体は秘匿で、
// 開いたマス数とリーチ／ビンゴ状態だけが公開される。
// 75球すべて引いても決着しなければ、開いたマス数の多い順に順位を付ける。
// 退出した人は脱落扱いで、その時点の開いたマス数で固定され、優勝できない。
// 残りの参加者が1人になったら、その人を勝者として即終了する。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export const BB_MAX_NUMBER = 75;
/** 抽選の間隔（ms）。 */
export const BB_DRAW_INTERVAL_MS = 2500;

export type BbPhase = "drawing" | "finished";

export interface BingoBattleState {
  players: { seat: number; name: string }[];
  /** seat -> カード（row-major 25マス、中央 index 12 はフリーで 0）。 */
  cards: Record<number, number[]>;
  /** 残りの抽選順（先頭から引く）。 */
  pool: number[];
  /** 引かれた数字（引いた順、全員共通の公開情報）。 */
  drawn: number[];
  phase: BbPhase;
  /** 次の抽選時刻（epoch ms）。終了後は null。 */
  nextDrawAt: number | null;
  /** 最初にビンゴした seat 群。同着は複数が入る。決着前は null。 */
  winners: number[] | null;
  /** winners が確定した時点の抽選数。決着前は null。 */
  bingoAtDraw: number | null;
  /** 退出した seat（脱落扱い）。 */
  leftSeats: number[];
  /** 退出時点の開いたマス数: seat -> 数。 */
  frozenMarked: Record<number, number>;
  standings: BbStanding[] | null;
}

export interface BbStanding {
  seat: number;
  rank: number;
  markedCount: number;
  bingo: boolean;
  left: boolean;
}

export type BingoBattleAction = { type: "none" };

export interface BbViewPlayer {
  seat: number;
  name: string;
  left: boolean;
  markedCount: number;
  reach: boolean;
  bingo: boolean;
}

export interface BingoBattleView {
  phase: BbPhase;
  drawn: number[];
  lastDrawn: number | null;
  totalDrawn: number;
  maxNumber: number;
  nextDrawAt: number | null;
  you: {
    seat: number;
    left: boolean;
    card: number[];
    /** マスごとに開いているか（中央フリーは常に true）。 */
    marked: boolean[];
    markedCount: number;
    /** 完成したラインの id 一覧。 */
    lines: string[];
    reach: boolean;
    bingo: boolean;
  };
  /** 自分を含む全員の進捗（カード自体は含まない）。 */
  players: BbViewPlayer[];
  winners: number[] | null;
  standings: BbStanding[] | null;
}

// ---------------------------------------------------------------- utilities

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function shuffled(values: number[], rng: Rng): number[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** カードを1枚作る（列ごとに範囲内から5つ、中央はフリーで 0）。 */
export function bbCreateCard(rng: Rng): number[] {
  const cells = new Array<number>(25).fill(0);
  for (let col = 0; col < 5; col++) {
    const min = col * 15 + 1;
    const picks = shuffled(
      Array.from({ length: 15 }, (_, i) => min + i),
      rng,
    );
    for (let row = 0; row < 5; row++) {
      cells[row * 5 + col] = picks[row];
    }
  }
  cells[12] = 0;
  return cells;
}

/** カードの妥当性検証（列範囲・重複なし・中央フリー）。 */
export function bbIsValidCard(card: number[]): boolean {
  if (!Array.isArray(card) || card.length !== 25) return false;
  if (card[12] !== 0) return false;
  const seen = new Set<number>();
  for (let col = 0; col < 5; col++) {
    const min = col * 15 + 1;
    const max = min + 14;
    for (let row = 0; row < 5; row++) {
      if (row === 2 && col === 2) continue;
      const v = card[row * 5 + col];
      if (!Number.isInteger(v) || v < min || v > max) return false;
      if (seen.has(v)) return false;
      seen.add(v);
    }
  }
  return seen.size === 24;
}

/** 全12ライン（横5・縦5・斜め2）。 */
export const BB_LINES: { id: string; cells: number[] }[] = [
  ...Array.from({ length: 5 }, (_, row) => ({
    id: `row${row}`,
    cells: Array.from({ length: 5 }, (_, col) => row * 5 + col),
  })),
  ...Array.from({ length: 5 }, (_, col) => ({
    id: `col${col}`,
    cells: Array.from({ length: 5 }, (_, row) => row * 5 + col),
  })),
  { id: "diag0", cells: [0, 6, 12, 18, 24] },
  { id: "diag1", cells: [4, 8, 12, 16, 20] },
];

function bbIsMarked(card: number[], drawnSet: Set<number>, index: number): boolean {
  const v = card[index];
  if (v === 0) return true;
  return drawnSet.has(v);
}

export interface BbCardStatus {
  markedCount: number;
  lines: string[];
  reach: boolean;
  bingo: boolean;
  /** 完成までの最短残りマス数（ビンゴ済みなら 0）。 */
  minRemaining: number;
}

/** カードと抽選済み数字から進捗を計算する。 */
export function bbCardStatus(card: number[], drawn: number[]): BbCardStatus {
  const drawnSet = new Set(drawn);
  const lines: string[] = [];
  let reach = false;
  let minRemaining = 5;
  for (const line of BB_LINES) {
    const unmarked = line.cells.filter((i) => !bbIsMarked(card, drawnSet, i)).length;
    if (unmarked === 0) lines.push(line.id);
    else if (unmarked === 1) reach = true;
    if (unmarked < minRemaining) minRemaining = unmarked;
  }
  return {
    markedCount: card.filter((_, i) => bbIsMarked(card, drawnSet, i)).length,
    lines,
    reach: lines.length === 0 && reach,
    bingo: lines.length > 0,
    minRemaining,
  };
}

function playerOf(state: BingoBattleState, seat: number): { seat: number; name: string } | undefined {
  return state.players.find((p) => p.seat === seat);
}

function activeSeats(state: BingoBattleState): number[] {
  return state.players.filter((p) => !state.leftSeats.includes(p.seat)).map((p) => p.seat);
}

function markedCountOf(state: BingoBattleState, seat: number): number {
  if (state.leftSeats.includes(seat)) return state.frozenMarked[seat] ?? 0;
  const card = state.cards[seat];
  if (!card) return 0;
  return bbCardStatus(card, state.drawn).markedCount;
}

/** 順位表を作る。winnerSeats は優勝扱いの seat 群（同着は複数）。 */
function computeStandings(state: BingoBattleState, winnerSeats: number[]): BbStanding[] {
  type Entry = {
    seat: number;
    group: number; // 0=優勝, 1=参加中, 2=脱落
    markedCount: number;
    minRemaining: number;
    bingo: boolean;
    left: boolean;
  };
  const entries: Entry[] = state.players.map((p) => {
    const left = state.leftSeats.includes(p.seat);
    const status = left ? null : bbCardStatus(state.cards[p.seat], state.drawn);
    return {
      seat: p.seat,
      group: winnerSeats.includes(p.seat) ? 0 : left ? 2 : 1,
      markedCount: left ? (state.frozenMarked[p.seat] ?? 0) : (status?.markedCount ?? 0),
      minRemaining: left ? 99 : (status?.minRemaining ?? 5),
      bingo: status?.bingo ?? false,
      left,
    };
  });
  const better = (a: Entry, b: Entry): boolean => {
    if (a.group !== b.group) return a.group < b.group;
    if (a.group === 1) {
      if (a.markedCount !== b.markedCount) return a.markedCount > b.markedCount;
      return a.minRemaining < b.minRemaining;
    }
    if (a.group === 2) return a.markedCount > b.markedCount;
    return false;
  };
  const sorted = [...entries].sort((a, b) => {
    if (better(a, b)) return -1;
    if (better(b, a)) return 1;
    return a.seat - b.seat;
  });
  return sorted.map((e) => ({
    seat: e.seat,
    rank: 1 + entries.filter((o) => better(o, e)).length,
    markedCount: e.markedCount,
    bingo: e.bingo,
    left: e.left,
  }));
}

/** 終了処理（draft を破壊的に更新）。 */
function finishGame(draft: BingoBattleState, winnerSeats: number[]): void {
  draft.phase = "finished";
  draft.nextDrawAt = null;
  draft.winners = [...winnerSeats].sort((a, b) => a - b);
  draft.standings = computeStandings(draft, winnerSeats);
}

/** 1球引いて勝敗を判定する（draft を破壊的に更新）。 */
function drawOne(draft: BingoBattleState): void {
  if (draft.pool.length === 0) return;
  const ball = draft.pool[0];
  draft.pool = draft.pool.slice(1);
  draft.drawn = [...draft.drawn, ball];
  const bingoSeats = activeSeats(draft).filter(
    (seat) => bbCardStatus(draft.cards[seat], draft.drawn).bingo,
  );
  if (bingoSeats.length > 0) {
    draft.bingoAtDraw = draft.drawn.length;
    finishGame(draft, bingoSeats);
    return;
  }
  if (draft.pool.length === 0) {
    // 全て引いても決着なし: 開いたマス数が最も多い人を優勝とする。
    let best = -1;
    for (const seat of activeSeats(draft)) {
      const n = markedCountOf(draft, seat);
      if (n > best) best = n;
    }
    const top = activeSeats(draft).filter((seat) => markedCountOf(draft, seat) === best);
    finishGame(draft, top);
  }
}

// ---------------------------------------------------------------- module

function createState(
  players: SeatInfo[],
  rng: Rng,
  _options: Record<string, unknown>,
): BingoBattleState {
  if (!Array.isArray(players) || players.length < 2 || players.length > 8) {
    throw new Error("ビンゴ対戦は2〜8人で遊ぶゲームです");
  }
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const cards: Record<number, number[]> = {};
  for (const p of sorted) cards[p.seat] = bbCreateCard(rng);
  const pool = shuffled(
    Array.from({ length: BB_MAX_NUMBER }, (_, i) => i + 1),
    rng,
  );
  return {
    players: sorted.map((p) => ({ seat: p.seat, name: p.name })),
    cards,
    pool,
    drawn: [],
    phase: "drawing",
    nextDrawAt: Date.now() + BB_DRAW_INTERVAL_MS,
    winners: null,
    bingoAtDraw: null,
    leftSeats: [],
    frozenMarked: {},
    standings: null,
  };
}

function applyAction(
  _state: BingoBattleState,
  _seat: number,
  _action: BingoBattleAction,
  _rng: Rng,
): BingoBattleState {
  // 抽選もマスの開放も自動で進むため、プレイヤーの操作は存在しない。
  throw new Error("ビンゴ対戦に操作はありません");
}

function viewFor(state: BingoBattleState, seat: number): BingoBattleView {
  const me = playerOf(state, seat);
  if (!me) throw new Error("プレイヤーが存在しません");
  const myCard = state.cards[seat] ?? [];
  const myStatus = bbCardStatus(myCard, state.drawn);
  const drawnSet = new Set(state.drawn);

  const players: BbViewPlayer[] = state.players.map((p) => {
    const left = state.leftSeats.includes(p.seat);
    if (left) {
      return {
        seat: p.seat,
        name: p.name,
        left: true,
        markedCount: state.frozenMarked[p.seat] ?? 0,
        reach: false,
        bingo: false,
      };
    }
    const st = bbCardStatus(state.cards[p.seat], state.drawn);
    return {
      seat: p.seat,
      name: p.name,
      left: false,
      markedCount: st.markedCount,
      reach: st.reach,
      bingo: st.bingo,
    };
  });

  return {
    phase: state.phase,
    drawn: [...state.drawn],
    lastDrawn: state.drawn.length > 0 ? state.drawn[state.drawn.length - 1] : null,
    totalDrawn: state.drawn.length,
    maxNumber: BB_MAX_NUMBER,
    nextDrawAt: state.nextDrawAt,
    you: {
      seat,
      left: state.leftSeats.includes(seat),
      card: [...myCard],
      marked: myCard.map((v, i) => v === 0 || drawnSet.has(v) || i === 12),
      markedCount: myStatus.markedCount,
      lines: myStatus.lines,
      reach: myStatus.reach,
      bingo: myStatus.bingo,
    },
    players,
    winners: state.winners ? [...state.winners] : null,
    standings: state.standings ? clone(state.standings) : null,
  };
}

function parseAction(_raw: unknown): BingoBattleAction | null {
  // 有効なアクションは存在しない。
  return null;
}

function onPlayerLeft(state: BingoBattleState, seat: number): BingoBattleState {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished" || state.leftSeats.includes(seat)) return state;
  const draft = clone(state);
  draft.frozenMarked[seat] = bbCardStatus(draft.cards[seat], draft.drawn).markedCount;
  draft.leftSeats.push(seat);
  const active = activeSeats(draft);
  if (active.length === 0) {
    finishGame(draft, []);
  } else if (active.length === 1) {
    // 対戦相手が全員いなくなったら、残った人を勝者として終了する。
    finishGame(draft, active);
  }
  return draft;
}

function tick(state: BingoBattleState, now: number): BingoBattleState {
  if (state.phase !== "drawing") return state;
  if (state.nextDrawAt === null || now < state.nextDrawAt) return state;
  if (activeSeats(state).length === 0) {
    const draft = clone(state);
    finishGame(draft, []);
    return draft;
  }
  const draft = clone(state);
  // 長時間ポーリングが止まっていた場合は、遅れ分をまとめて引く。
  let guard = 0;
  while (
    draft.phase === "drawing" &&
    draft.nextDrawAt !== null &&
    now >= draft.nextDrawAt &&
    guard <= BB_MAX_NUMBER
  ) {
    drawOne(draft);
    guard++;
    if (draft.phase === "drawing") draft.nextDrawAt += BB_DRAW_INTERVAL_MS;
  }
  return draft;
}

export const gameModule: OnlineGameModule<BingoBattleState, BingoBattleAction, BingoBattleView> = {
  id: "bingobattle",
  title: "ビンゴ対戦",
  minPlayers: 2,
  maxPlayers: 8,
  cpuSupported: false,
  chatEnabled: true,
  createState,
  applyAction,
  viewFor,
  parseAction,
  phaseOf: (state: BingoBattleState) => state.phase,
  isFinished: (state: BingoBattleState) => state.phase === "finished",
  onPlayerLeft,
  tick,
};
