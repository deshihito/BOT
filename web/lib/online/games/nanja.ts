// ナンジャモンジャ風（名前付け＆早叫び）のルールモジュール。2〜6人・手番制。
// モジュール契約は lib/online/types.ts の OnlineGameModule に従う。
// 実行時 import は禁止（テストが import を剥がして連結するため type のみ）。
//
// 生き物カードは絵文字の組み合わせ30種 × 各4枚 = 120枚の山札。
// 手番の人が1枚めくり、初めて出た生き物にはその人が名前を付ける（30秒制限、
// 時間切れは自動名）。既に名前のある生き物が再び出たら、全員が名前を
// 叫べる（専用アクションでテキスト送信）。最初に完全一致で正解した人が
// 場の山を全部もらう。誤答した人はそのラウンド（その山）には参加できない。
// 山札が尽きて場の山も決着したら、獲得枚数の多い順に順位を付ける。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export const NANJA_NAME_TIME_MS = 30000;
export const NANJA_NAME_MAX = 12;
export const NANJA_COPIES_PER_CREATURE = 4;

export interface NanjaCreature {
  /** 顔の絵文字。 */
  face: string;
  /** 飾りの絵文字。 */
  deco: string;
  /** 未命名時に表示する仮の呼び名。 */
  label: string;
}

export const NANJA_CREATURES: NanjaCreature[] = [
  { face: "🐶", deco: "🎩", label: "ぼうしのワンコ" },
  { face: "🐱", deco: "👑", label: "かんむりのネコ" },
  { face: "🐸", deco: "🎀", label: "リボンのカエル" },
  { face: "🐵", deco: "🕶️", label: "グラサンのサル" },
  { face: "🐷", deco: "🌸", label: "お花のブタ" },
  { face: "🐰", deco: "⭐", label: "星のウサギ" },
  { face: "🦊", deco: "🍀", label: "クローバーのキツネ" },
  { face: "🐻", deco: "🎈", label: "風船のクマ" },
  { face: "🐼", deco: "🍩", label: "ドーナツのパンダ" },
  { face: "🦁", deco: "🔔", label: "ベルのライオン" },
  { face: "🐨", deco: "🍎", label: "りんごのコアラ" },
  { face: "🦄", deco: "🌈", label: "虹のユニコーン" },
  { face: "🐙", deco: "🍓", label: "いちごのタコ" },
  { face: "🐥", deco: "🎧", label: "ヘッドホンのヒヨコ" },
  { face: "🐢", deco: "🌙", label: "お月さまのカメ" },
  { face: "🦉", deco: "🧣", label: "マフラーのフクロウ" },
  { face: "🐴", deco: "🍇", label: "ぶどうのウマ" },
  { face: "🐘", deco: "🍕", label: "ピザのゾウ" },
  { face: "🦒", deco: "❄️", label: "ゆきのキリン" },
  { face: "🐳", deco: "🧢", label: "キャップのクジラ" },
  { face: "🐭", deco: "🧀", label: "チーズのネズミ" },
  { face: "🐮", deco: "🍼", label: "ミルクのウシ" },
  { face: "🐯", deco: "🎸", label: "ギターのトラ" },
  { face: "🦩", deco: "💐", label: "花束のフラミンゴ" },
  { face: "🐧", deco: "🎿", label: "スキーのペンギン" },
  { face: "🦖", deco: "🍦", label: "アイスのキョウリュウ" },
  { face: "🐹", deco: "🌻", label: "ひまわりのハムスター" },
  { face: "🦓", deco: "🍉", label: "スイカのシマウマ" },
  { face: "🦢", deco: "💎", label: "宝石のハクチョウ" },
  { face: "🐌", deco: "🍃", label: "葉っぱのカタツムリ" },
];

/** 命名が時間切れになったときに付く自動名（生き物ごとに固定）。 */
export const NANJA_DEFAULT_NAMES: string[] = [
  "モジャ",
  "ポヨン",
  "ニャモ",
  "フワリン",
  "ガブガブ",
  "ピョコ",
  "ムニムニ",
  "トロロ",
  "バブー",
  "コロコロ",
  "スヤスヤ",
  "ノビノビ",
  "ポテポテ",
  "クルリン",
  "モフモフ",
  "プニプニ",
  "ヨチヨチ",
  "ドッシン",
  "ピカリン",
  "スイスイ",
  "ポコポコ",
  "チョロリ",
  "ヌルヌル",
  "ヒョッコリ",
  "ゴロリン",
  "ペタペタ",
  "ワサワサ",
  "ピロリン",
  "タラタラ",
  "ムシャムシャ",
];

export type NanjaPhase = "flip" | "naming" | "shout" | "finished";

export type NanjaEvent =
  | { type: "flip"; seat: number; creature: number }
  | { type: "named"; seat: number; creature: number; name: string; auto: boolean }
  | { type: "won"; seat: number; creature: number; name: string; count: number }
  | { type: "wrong"; seat: number }
  | { type: "dead" }
  | { type: "left"; seat: number };

export interface NanjaState {
  players: SeatInfo[];
  /** 山札（生き物 id の列。末尾が一番上。中身はビューに含めない）。 */
  deck: number[];
  /** 場の山（めくられた順。末尾が一番上・公開）。 */
  pile: number[];
  /** 生き物 id → 名前（未命名は null・公開）。 */
  names: (string | null)[];
  /** 生き物 id → 名付けた seat（退出しても残る）。 */
  namedBy: (number | null)[];
  /** 次にめくる seat。 */
  current: number;
  /** 直近にめくった seat。 */
  lastFlipper: number | null;
  phase: NanjaPhase;
  /** 命名中の seat とその対象。 */
  namingSeat: number | null;
  namingCreature: number | null;
  /** 命名の締切（ms epoch）。 */
  namingEndsAt: number | null;
  /** この山で誤答して参加できない seat のフラグ。 */
  shoutLocked: boolean[];
  /** seat ごとの獲得枚数。 */
  captured: number[];
  leftSeats: number[];
  lastEvent: NanjaEvent | null;
  /** 終了時の勝者 seat（同点は複数）。 */
  winners: number[] | null;
}

export type NanjaAction =
  | { type: "flip" }
  | { type: "name"; name: string }
  | { type: "shout"; name: string };

export interface NanjaStanding {
  seat: number;
  name: string;
  captured: number;
  rank: number;
  left: boolean;
}

export interface NanjaView {
  players: SeatInfo[];
  deckCount: number;
  pile: number[];
  pileCount: number;
  /** 場の山の一番上の生き物（無ければ null）。 */
  top: number | null;
  names: (string | null)[];
  namedBy: (number | null)[];
  current: number;
  lastFlipper: number | null;
  phase: NanjaPhase;
  namingSeat: number | null;
  namingCreature: number | null;
  namingEndsAt: number | null;
  shoutLocked: boolean[];
  captured: number[];
  leftSeats: number[];
  lastEvent: NanjaEvent | null;
  winners: number[] | null;
  standings: NanjaStanding[] | null;
  finished: boolean;
}

function cloneState(state: NanjaState): NanjaState {
  return {
    players: state.players.map((p) => ({ seat: p.seat, name: p.name })),
    deck: [...state.deck],
    pile: [...state.pile],
    names: [...state.names],
    namedBy: [...state.namedBy],
    current: state.current,
    lastFlipper: state.lastFlipper,
    phase: state.phase,
    namingSeat: state.namingSeat,
    namingCreature: state.namingCreature,
    namingEndsAt: state.namingEndsAt,
    shoutLocked: [...state.shoutLocked],
    captured: [...state.captured],
    leftSeats: [...state.leftSeats],
    lastEvent: state.lastEvent ? { ...state.lastEvent } : null,
    winners: state.winners ? [...state.winners] : null,
  };
}

function activeSeats(state: NanjaState): number[] {
  return state.players.map((p) => p.seat).filter((s) => !state.leftSeats.includes(s));
}

/** from の次に手番が回る生存 seat（いなければ from を返す）。 */
function nextActive(state: NanjaState, from: number): number {
  const n = state.players.length;
  for (let k = 1; k <= n; k++) {
    const cand = (from + k) % n;
    if (!state.leftSeats.includes(cand)) return cand;
  }
  return from;
}

/** 名前文字列の正規化（前後の空白を除き、連続空白を1つに）。 */
export function normalizeNanjaName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

function finishGame(state: NanjaState): NanjaState {
  const next = state;
  next.phase = "finished";
  next.namingSeat = null;
  next.namingCreature = null;
  next.namingEndsAt = null;
  const best = Math.max(...next.captured);
  next.winners = next.players
    .map((p) => p.seat)
    .filter((s) => next.captured[s] === best);
  return next;
}

/** 命名（手動/自動共通）を確定し、次の手番へ進める。state は変更済みの前提。 */
function settleNaming(state: NanjaState, name: string, auto: boolean): NanjaState {
  const creature = state.namingCreature;
  const seat = state.namingSeat;
  if (creature === null || seat === null) return state;
  state.names[creature] = name;
  state.namedBy[creature] = seat;
  state.lastEvent = { type: "named", seat, creature, name, auto };
  state.namingSeat = null;
  state.namingCreature = null;
  state.namingEndsAt = null;
  if (state.deck.length === 0) {
    return finishGame(state);
  }
  state.phase = "flip";
  state.current = nextActive(state, state.lastFlipper ?? seat);
  return state;
}

/** 叫びラウンドが全員誤答で流れたときの処理。state は変更済みの前提。 */
function settleDeadRound(state: NanjaState): NanjaState {
  state.lastEvent = { type: "dead" };
  state.shoutLocked = state.shoutLocked.map(() => false);
  if (state.deck.length === 0) {
    return finishGame(state);
  }
  state.phase = "flip";
  state.current = nextActive(state, state.lastFlipper ?? state.current);
  return state;
}

function allActiveLocked(state: NanjaState): boolean {
  const active = activeSeats(state);
  return active.length > 0 && active.every((s) => state.shoutLocked[s]);
}

export function nanjaStandings(state: NanjaState): NanjaStanding[] {
  return state.players
    .map((p) => ({
      seat: p.seat,
      name: p.name,
      captured: state.captured[p.seat] ?? 0,
      rank: 1 + state.captured.filter((c) => c > (state.captured[p.seat] ?? 0)).length,
      left: state.leftSeats.includes(p.seat),
    }))
    .sort((a, b) => a.rank - b.rank || a.seat - b.seat);
}

export const gameModule: OnlineGameModule<NanjaState, NanjaAction, NanjaView> = {
  id: "nanja",
  title: "ナンジャモンジャ風",
  minPlayers: 2,
  maxPlayers: 6,
  cpuSupported: false,
  chatEnabled: true,

  createState(players: SeatInfo[], rng: Rng, _options: Record<string, unknown>): NanjaState {
    if (!Array.isArray(players) || players.length < 2 || players.length > 6) {
      throw new Error("ナンジャモンジャ風は2〜6人で遊びます");
    }
    const deck: number[] = [];
    for (let c = 0; c < NANJA_CREATURES.length; c++) {
      for (let k = 0; k < NANJA_COPIES_PER_CREATURE; k++) deck.push(c);
    }
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return {
      players: players.map((p) => ({ seat: p.seat, name: p.name })),
      deck,
      pile: [],
      names: new Array<string | null>(NANJA_CREATURES.length).fill(null),
      namedBy: new Array<number | null>(NANJA_CREATURES.length).fill(null),
      current: players[0].seat,
      lastFlipper: null,
      phase: "flip",
      namingSeat: null,
      namingCreature: null,
      namingEndsAt: null,
      shoutLocked: players.map(() => false),
      captured: players.map(() => 0),
      leftSeats: [],
      lastEvent: null,
      winners: null,
    };
  },

  applyAction(state: NanjaState, seat: number, action: NanjaAction, _rng: Rng): NanjaState {
    if (state.phase === "finished") throw new Error("対局は終了しています");
    if (!state.players.some((p) => p.seat === seat)) throw new Error("参加者ではありません");
    if (state.leftSeats.includes(seat)) throw new Error("退出済みのプレイヤーは操作できません");
    if (!action || typeof action !== "object") throw new Error("不明なアクションです");

    if (action.type === "flip") {
      if (state.phase !== "flip") throw new Error("今はカードをめくれません");
      if (seat !== state.current) throw new Error("あなたの手番ではありません");
      if (state.deck.length === 0) throw new Error("山札がもうありません");
      const next = cloneState(state);
      const creature = next.deck.pop() as number;
      next.pile.push(creature);
      next.lastFlipper = seat;
      next.shoutLocked = next.shoutLocked.map(() => false);
      next.lastEvent = { type: "flip", seat, creature };
      if (next.names[creature] === null) {
        next.phase = "naming";
        next.namingSeat = seat;
        next.namingCreature = creature;
        next.namingEndsAt = Date.now() + NANJA_NAME_TIME_MS;
      } else {
        next.phase = "shout";
      }
      return next;
    }

    if (action.type === "name") {
      if (state.phase !== "naming" || state.namingSeat !== seat) {
        throw new Error("今は名前を付けられません");
      }
      const name = normalizeNanjaName(typeof action.name === "string" ? action.name : "");
      if (name.length === 0) throw new Error("名前を入力してください");
      if ([...name].length > NANJA_NAME_MAX) {
        throw new Error(`名前は${NANJA_NAME_MAX}文字までです`);
      }
      const next = cloneState(state);
      return settleNaming(next, name, false);
    }

    if (action.type === "shout") {
      if (state.phase !== "shout") throw new Error("今は叫べません");
      if (state.shoutLocked[seat]) throw new Error("この山ではもう叫べません");
      const top = state.pile[state.pile.length - 1];
      if (top === undefined) throw new Error("場の山がありません");
      const answer = state.names[top];
      if (answer === null) throw new Error("この生き物にはまだ名前がありません");
      const said = normalizeNanjaName(typeof action.name === "string" ? action.name : "");
      const next = cloneState(state);
      if (said === answer) {
        const count = next.pile.length;
        next.captured[seat] += count;
        next.pile = [];
        next.shoutLocked = next.shoutLocked.map(() => false);
        next.lastEvent = { type: "won", seat, creature: top, name: answer, count };
        if (next.deck.length === 0) {
          return finishGame(next);
        }
        next.phase = "flip";
        next.current = seat; // 山を取った人が次をめくる
        return next;
      }
      next.shoutLocked[seat] = true;
      next.lastEvent = { type: "wrong", seat };
      if (allActiveLocked(next)) {
        return settleDeadRound(next);
      }
      return next;
    }

    throw new Error("不明なアクションです");
  },

  viewFor(state: NanjaState, _seat: number): NanjaView {
    const finished = state.phase === "finished";
    return {
      players: state.players.map((p) => ({ seat: p.seat, name: p.name })),
      deckCount: state.deck.length,
      pile: [...state.pile],
      pileCount: state.pile.length,
      top: state.pile.length > 0 ? state.pile[state.pile.length - 1] : null,
      names: [...state.names],
      namedBy: [...state.namedBy],
      current: state.current,
      lastFlipper: state.lastFlipper,
      phase: state.phase,
      namingSeat: state.namingSeat,
      namingCreature: state.namingCreature,
      namingEndsAt: state.namingEndsAt,
      shoutLocked: [...state.shoutLocked],
      captured: [...state.captured],
      leftSeats: [...state.leftSeats],
      lastEvent: state.lastEvent ? { ...state.lastEvent } : null,
      winners: state.winners ? [...state.winners] : null,
      standings: finished ? nanjaStandings(state) : null,
      finished,
    };
  },

  parseAction(raw: unknown): NanjaAction | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (r.type === "flip") return { type: "flip" };
    if (r.type === "name" || r.type === "shout") {
      if (typeof r.name !== "string" || r.name.length > 100) return null;
      return { type: r.type, name: r.name };
    }
    return null;
  },

  phaseOf(state: NanjaState): string {
    return state.phase;
  },

  isFinished(state: NanjaState): boolean {
    return state.phase === "finished";
  },

  tick(state: NanjaState, now: number): NanjaState {
    if (state.phase !== "naming" || state.namingEndsAt === null) return state;
    if (now < state.namingEndsAt) return state;
    const next = cloneState(state);
    const creature = next.namingCreature ?? 0;
    return settleNaming(next, NANJA_DEFAULT_NAMES[creature] ?? "モジャ", true);
  },

  onPlayerLeft(state: NanjaState, seat: number): NanjaState {
    if (state.phase === "finished") return cloneState(state);
    if (!state.players.some((p) => p.seat === seat)) return cloneState(state);
    const next = cloneState(state);
    if (!next.leftSeats.includes(seat)) next.leftSeats.push(seat);
    next.lastEvent = { type: "left", seat };
    // 生存者が1人以下になったら終了（残った人の獲得枚数がそのまま結果になる）。
    if (activeSeats(next).length <= 1) {
      return finishGame(next);
    }
    if (next.phase === "naming" && next.namingSeat === seat) {
      const creature = next.namingCreature ?? 0;
      return settleNaming(next, NANJA_DEFAULT_NAMES[creature] ?? "モジャ", true);
    }
    if (next.phase === "flip" && next.current === seat) {
      next.current = nextActive(next, seat);
    }
    if (next.phase === "shout" && allActiveLocked(next)) {
      return settleDeadRound(next);
    }
    return next;
  },
};
