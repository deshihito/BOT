// ライアーズダイス（オンライン対戦）のルールモジュール。
// 基盤契約: import は type のみ（テストが import を剥がして連結する）。
// 状態は JSON 化可能な値だけ。applyAction / onPlayerLeft は純関数。
// ルール:
// - 全員ダイス5個で開始。自分のダイスだけが見える（viewFor で秘匿）。
// - 手番の人は「場全体のダイスの中で、数字X（2〜6）が少なくともN個ある」と宣言する。
//   前の宣言より N を上げるか、同じ N で数字 X を上げなければいけない。
//   ラウンド最初の宣言は自由（ただしチャレンジはできない）。
// - 1の目はワイルドで、どの数字としても数える。
// - 次の人は「宣言を上げる」か「チャレンジ（ダウト）」を選ぶ。
//   チャレンジで全員のダイスを開示し、実際の個数（宣言の数字＋ワイルド）が
//   宣言以上なら宣言は本当＝チャレンジャーが、未満なら嘘＝宣言者がダイスを1個失う。
// - ダイスを全部失うと脱落。最後に残った1人が勝ち。
// - 新しいラウンドは、ダイスを失った人から始める（脱落した場合はその次の生存者）。
// - 退出したプレイヤーは脱落扱い（ダイスは場から除かれる）。宣言はそのまま残る。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export type LdPhase = "bidding" | "finished";

export interface LdBid {
  count: number;
  /** 2〜6（1はワイルド専用で宣言できない）。 */
  face: number;
  seat: number;
}

export interface LdReveal {
  round: number;
  bid: LdBid;
  /** 開示時の実際の個数（ワイルド込み）。 */
  actual: number;
  challengerSeat: number;
  loserSeat: number;
  /** 開示された全員のダイス（そのラウンドでダイスを持っていた人のみ）。 */
  dice: Record<number, number[]>;
}

export interface LiarsDiceState {
  players: { seat: number; name: string }[];
  leftSeats: number[];
  /** seat → 残りダイス数（0で脱落）。 */
  diceCounts: Record<number, number>;
  /** seat → 今のラウンドのダイス。内部のみ（ビューには自分の分だけ出す）。 */
  dice: Record<number, number[]>;
  phase: LdPhase;
  round: number;
  currentSeat: number;
  currentBid: LdBid | null;
  lastReveal: LdReveal | null;
  /** 脱落した順（先に脱落した順）。 */
  eliminationOrder: number[];
  winner: number | null;
}

export type LiarsDiceAction = { type: "bid"; count: number; face: number } | { type: "challenge" };

export interface LdViewPlayer {
  seat: number;
  name: string;
  diceCount: number;
  left: boolean;
  eliminated: boolean;
  isCurrent: boolean;
}

export interface LiarsDiceView {
  phase: LdPhase;
  round: number;
  currentSeat: number;
  currentBid: LdBid | null;
  /** 場に出ているダイスの総数。 */
  totalDice: number;
  winner: number | null;
  you: {
    seat: number;
    /** 自分の今のダイス（脱落・退出後は空）。 */
    dice: number[];
    left: boolean;
    eliminated: boolean;
    isYourTurn: boolean;
  };
  players: LdViewPlayer[];
  lastReveal: LdReveal | null;
  /** finished 時の順位。それ以外は null。 */
  standings: { seat: number; rank: number }[] | null;
}

export const LD_START_DICE = 5;

// ---------------------------------------------------------------- utilities

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function playerOf(state: LiarsDiceState, seat: number): { seat: number; name: string } | undefined {
  return state.players.find((p) => p.seat === seat);
}

/** まだ戦える seat（退出しておらず、ダイスが残っている）。 */
function activeSeats(state: LiarsDiceState): number[] {
  return state.players
    .filter((p) => !state.leftSeats.includes(p.seat) && (state.diceCounts[p.seat] ?? 0) > 0)
    .map((p) => p.seat);
}

/** from の次（seat 昇順で循環）の生存者。いなければ from を返す。 */
function nextActive(state: LiarsDiceState, from: number): number {
  const seats = state.players.map((p) => p.seat).sort((a, b) => a - b);
  const active = activeSeats(state);
  for (let step = 1; step <= seats.length; step++) {
    const candidate = seats[(seats.indexOf(from) + step) % seats.length];
    if (active.includes(candidate)) return candidate;
  }
  return from;
}

function rollDice(count: number, rng: Rng): number[] {
  return Array.from({ length: count }, () => 1 + Math.floor(rng() * 6));
}

/** ワイルド（1）を込みで、face の個数を数える。 */
export function ldCountFace(diceBySeat: Record<number, number[]>, face: number): number {
  let total = 0;
  for (const dice of Object.values(diceBySeat)) {
    for (const d of dice) {
      if (d === face || d === 1) total++;
    }
  }
  return total;
}

/** 宣言が前の宣言より強いか（初回宣言は常に可）。 */
export function ldIsRaise(prev: LdBid | null, count: number, face: number): boolean {
  if (!prev) return true;
  return count > prev.count || (count === prev.count && face > prev.face);
}

function totalDiceInPlay(state: LiarsDiceState): number {
  return activeSeats(state).reduce((sum, s) => sum + (state.diceCounts[s] ?? 0), 0);
}

/** 勝敗が決まったら finished にする。決まらなければ false。 */
function finishIfDecided(draft: LiarsDiceState): boolean {
  const active = activeSeats(draft);
  if (active.length > 1) return false;
  draft.phase = "finished";
  draft.winner = active.length === 1 ? active[0] : null;
  return true;
}

/** チャレンジの解決（draft を破壊的に更新）。 */
function resolveChallenge(draft: LiarsDiceState, challengerSeat: number, rng: Rng): void {
  const bid = draft.currentBid as LdBid;
  // 開示対象は、そのラウンドにダイスを持っていた全員（退出者のダイスは除く）。
  const revealed: Record<number, number[]> = {};
  for (const p of draft.players) {
    if (draft.leftSeats.includes(p.seat)) continue;
    const dice = draft.dice[p.seat];
    if (dice && dice.length > 0) revealed[p.seat] = [...dice];
  }
  const actual = ldCountFace(revealed, bid.face);
  const loserSeat = actual >= bid.count ? challengerSeat : bid.seat;
  draft.lastReveal = {
    round: draft.round,
    bid: { ...bid },
    actual,
    challengerSeat,
    loserSeat,
    dice: revealed,
  };
  draft.diceCounts[loserSeat] = Math.max(0, (draft.diceCounts[loserSeat] ?? 0) - 1);
  if (draft.diceCounts[loserSeat] === 0 && !draft.eliminationOrder.includes(loserSeat)) {
    draft.eliminationOrder.push(loserSeat);
  }
  draft.currentBid = null;
  if (finishIfDecided(draft)) return;
  // 次のラウンド: 全員のダイスを振り直し、負けた人から始める。
  draft.round += 1;
  const newDice: Record<number, number[]> = {};
  for (const p of draft.players) {
    const count = draft.leftSeats.includes(p.seat) ? 0 : (draft.diceCounts[p.seat] ?? 0);
    newDice[p.seat] = count > 0 ? rollDice(count, rng) : [];
  }
  draft.dice = newDice;
  draft.currentSeat = activeSeats(draft).includes(loserSeat) ? loserSeat : nextActive(draft, loserSeat);
}

// ---------------------------------------------------------------- module

function createState(players: SeatInfo[], rng: Rng, _options: Record<string, unknown>): LiarsDiceState {
  if (!Array.isArray(players) || players.length < 2 || players.length > 6) {
    throw new Error("ライアーズダイスは2〜6人で遊ぶゲームです");
  }
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const diceCounts: Record<number, number> = {};
  const dice: Record<number, number[]> = {};
  for (const p of sorted) {
    diceCounts[p.seat] = LD_START_DICE;
    dice[p.seat] = rollDice(LD_START_DICE, rng);
  }
  return {
    players: sorted.map((p) => ({ seat: p.seat, name: p.name })),
    leftSeats: [],
    diceCounts,
    dice,
    phase: "bidding",
    round: 1,
    currentSeat: sorted[0].seat,
    currentBid: null,
    lastReveal: null,
    eliminationOrder: [],
    winner: null,
  };
}

function applyAction(state: LiarsDiceState, seat: number, action: LiarsDiceAction, rng: Rng): LiarsDiceState {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished") throw new Error("ゲームは終了しています");
  if (state.leftSeats.includes(seat)) throw new Error("退出したプレイヤーは操作できません");
  if ((state.diceCounts[seat] ?? 0) <= 0) throw new Error("脱落したプレイヤーは操作できません");
  if (seat !== state.currentSeat) throw new Error("あなたの手番ではありません");
  if (!action || typeof action !== "object") throw new Error("不明なアクションです");

  if (action.type === "challenge") {
    if (!state.currentBid) throw new Error("まだ宣言がないのでチャレンジできません");
    if (state.currentBid.seat === seat) throw new Error("自分の宣言にはチャレンジできません");
    const draft = clone(state);
    resolveChallenge(draft, seat, rng);
    return draft;
  }

  if (action.type === "bid") {
    const { count, face } = action;
    if (!Number.isInteger(count) || !Number.isInteger(face)) throw new Error("宣言が不正です");
    if (face < 2 || face > 6) throw new Error("宣言できる数字は2〜6です（1はワイルド）");
    const total = totalDiceInPlay(state);
    if (count < 1 || count > total) throw new Error(`個数は1〜${total}で宣言してください`);
    if (!ldIsRaise(state.currentBid, count, face)) {
      throw new Error("前の宣言より強くしてください（個数を上げるか、同じ個数で数字を上げる）");
    }
    const draft = clone(state);
    draft.currentBid = { count, face, seat };
    draft.currentSeat = nextActive(draft, seat);
    return draft;
  }

  throw new Error("不明なアクションです");
}

function viewFor(state: LiarsDiceState, seat: number): LiarsDiceView {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  const finished = state.phase === "finished";
  const players: LdViewPlayer[] = state.players.map((p) => ({
    seat: p.seat,
    name: p.name,
    diceCount: state.diceCounts[p.seat] ?? 0,
    left: state.leftSeats.includes(p.seat),
    eliminated: (state.diceCounts[p.seat] ?? 0) <= 0,
    isCurrent: state.phase === "bidding" && state.currentSeat === p.seat,
  }));

  let standings: LiarsDiceView["standings"] = null;
  if (finished) {
    standings = state.players.map((p) => {
      let rank: number;
      if (state.winner === p.seat) {
        rank = 1;
      } else {
        // 後から脱落した人ほど上位。脱落順リストの後ろから数える。
        const idx = state.eliminationOrder.indexOf(p.seat);
        const laterEliminations =
          idx >= 0 ? state.eliminationOrder.length - 1 - idx : state.eliminationOrder.length;
        rank = 2 + laterEliminations;
      }
      return { seat: p.seat, rank };
    });
  }

  return {
    phase: state.phase,
    round: state.round,
    currentSeat: state.currentSeat,
    currentBid: state.currentBid ? { ...state.currentBid } : null,
    totalDice: totalDiceInPlay(state),
    winner: state.winner,
    you: {
      seat,
      dice: [...(state.dice[seat] ?? [])],
      left: state.leftSeats.includes(seat),
      eliminated: (state.diceCounts[seat] ?? 0) <= 0,
      isYourTurn: state.phase === "bidding" && state.currentSeat === seat,
    },
    players,
    lastReveal: state.lastReveal ? clone(state.lastReveal) : null,
    standings,
  };
}

function parseAction(raw: unknown): LiarsDiceAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.type === "challenge") return { type: "challenge" };
  if (rec.type === "bid") {
    if (typeof rec.count !== "number" || !Number.isInteger(rec.count) || rec.count < 1 || rec.count > 30) {
      return null;
    }
    if (typeof rec.face !== "number" || !Number.isInteger(rec.face) || rec.face < 2 || rec.face > 6) {
      return null;
    }
    return { type: "bid", count: rec.count, face: rec.face };
  }
  return null;
}

function onPlayerLeft(state: LiarsDiceState, seat: number): LiarsDiceState {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished" || state.leftSeats.includes(seat)) return state;
  const draft = clone(state);
  draft.leftSeats.push(seat);
  // 退出者のダイスは場から除く。
  draft.dice[seat] = [];
  if ((draft.diceCounts[seat] ?? 0) > 0 && !draft.eliminationOrder.includes(seat)) {
    draft.eliminationOrder.push(seat);
  }
  if (finishIfDecided(draft)) return draft;
  if (draft.currentSeat === seat) {
    draft.currentSeat = nextActive(draft, seat);
  }
  return draft;
}

export const gameModule: OnlineGameModule<LiarsDiceState, LiarsDiceAction, LiarsDiceView> = {
  id: "liarsdice",
  title: "ライアーズダイス",
  minPlayers: 2,
  maxPlayers: 6,
  cpuSupported: false,
  chatEnabled: true,
  createState,
  applyAction,
  viewFor,
  parseAction,
  phaseOf: (state: LiarsDiceState) => state.phase,
  isFinished: (state: LiarsDiceState) => state.phase === "finished",
  onPlayerLeft,
};
