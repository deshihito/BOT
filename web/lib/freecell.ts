// フリーセルの純粋ロジック（UI 非依存・シード決定的）。
// 状態は JSON 化可能な値だけを持ち、全ての遷移関数は入力を変更しない。
// ルール: 場札（8列）は色を交互に降順に重ねる。空列には何でも置ける。
// フリーセルは4つ、各1枚まで。組札は同スートを A→K の昇順。
// まとめて動かせる枚数は (1+空きフリーセル) × 2^(空列の数)。
// 移動先が空列の場合、その空列は倍率に数えない。

export type FcSuit = "spades" | "hearts" | "diamonds" | "clubs";

export type FcCard = {
  /** "spades-13" のような一意なID。 */
  id: string;
  suit: FcSuit;
  /** 1=A, 11=J, 12=Q, 13=K。 */
  rank: number;
};

export type FcState = {
  /** 場札8列。末尾が一番手前（下）。 */
  columns: FcCard[][];
  /** フリーセル4つ。 */
  freeCells: (FcCard | null)[];
  /** 組札4山（SUITS の順）。末尾が一番上。 */
  foundations: FcCard[][];
  moves: number;
  status: "playing" | "won";
  seed: number;
};

export type FcSource = { kind: "column"; column: number } | { kind: "freecell"; index: number };
export type FcTarget =
  | { kind: "column"; column: number }
  | { kind: "freecell"; index: number }
  | { kind: "foundation"; index: number };

export const FC_SUITS: readonly FcSuit[] = ["spades", "hearts", "diamonds", "clubs"];
export const FC_COLUMNS = 8;
export const FC_FREE_CELLS = 4;

export function isRedSuit(suit: FcSuit): boolean {
  return suit === "hearts" || suit === "diamonds";
}

export function suitSymbol(suit: FcSuit): string {
  switch (suit) {
    case "spades":
      return "♠";
    case "hearts":
      return "♥";
    case "diamonds":
      return "♦";
    case "clubs":
      return "♣";
  }
}

export function rankLabel(rank: number): string {
  if (rank === 1) return "A";
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  return String(rank);
}

/** mulberry32（他 lib と同一方式）。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function createFcDeck(): FcCard[] {
  const deck: FcCard[] = [];
  for (const suit of FC_SUITS) {
    for (let rank = 1; rank <= 13; rank++) {
      deck.push({ id: `${suit}-${rank}`, suit, rank });
    }
  }
  return deck;
}

/** シード決定的に配る。前4列が7枚、後ろ4列が6枚。 */
export function createFreecell(seed: number): FcState {
  const deck = createFcDeck();
  let rng = seed | 0;
  for (let i = deck.length - 1; i > 0; i--) {
    const r = nextRandom(rng);
    rng = r.rng;
    const j = Math.floor(r.value * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const columns: FcCard[][] = Array.from({ length: FC_COLUMNS }, () => []);
  deck.forEach((card, i) => {
    columns[i % FC_COLUMNS].push(card);
  });
  return {
    columns,
    freeCells: new Array<FcCard | null>(FC_FREE_CELLS).fill(null),
    foundations: FC_SUITS.map(() => []),
    moves: 0,
    status: "playing",
    seed,
  };
}

/** カード列が「色交互・降順」の正しい並びか（下から上へ rank が1ずつ減り色が交互）。 */
export function isValidStack(cards: FcCard[]): boolean {
  for (let i = 1; i < cards.length; i++) {
    const below = cards[i - 1];
    const above = cards[i];
    if (above.rank !== below.rank - 1) return false;
    if (isRedSuit(above.suit) === isRedSuit(below.suit)) return false;
  }
  return true;
}

export function emptyFreeCellCount(state: FcState): number {
  return state.freeCells.filter((c) => c === null).length;
}

export function emptyColumnCount(state: FcState): number {
  return state.columns.filter((c) => c.length === 0).length;
}

/**
 * 一度に動かせる最大枚数。
 * targetColumn が空列の場合、その列は倍率（2の指数）に含めない。
 */
export function maxMovableCards(state: FcState, targetColumn?: number): number {
  const free = emptyFreeCellCount(state);
  let emptyCols = emptyColumnCount(state);
  if (targetColumn !== undefined && state.columns[targetColumn]?.length === 0) {
    emptyCols = Math.max(0, emptyCols - 1);
  }
  return (1 + free) * 2 ** emptyCols;
}

/** 場札の上に重ねられるか。空列には何でも可、それ以外は色交互で1つ下の数字。 */
export function canStackOnColumn(moving: FcCard, destTop: FcCard | null): boolean {
  if (destTop === null) return true;
  if (isRedSuit(moving.suit) === isRedSuit(destTop.suit)) return false;
  return destTop.rank === moving.rank + 1;
}

/** 組札の上に重ねられるか。空山には A のみ、それ以外は同スートで1つ上の数字。 */
export function canStackOnFoundation(state: FcState, card: FcCard, foundationIndex: number): boolean {
  const pile = state.foundations[foundationIndex];
  if (!pile) return false;
  // 組札はスートごとに固定（foundations[i] は FC_SUITS[i] 専用）。
  if (FC_SUITS[foundationIndex] !== card.suit) return false;
  const top = pile.length > 0 ? pile[pile.length - 1] : null;
  if (top === null) return card.rank === 1;
  return card.rank === top.rank + 1;
}

function foundationIndexOfSuit(suit: FcSuit): number {
  return FC_SUITS.indexOf(suit);
}

function isWon(state: FcState): boolean {
  return state.foundations.reduce((sum, pile) => sum + pile.length, 0) === 52;
}

/**
 * カードを動かす。不正な移動は状態をそのまま返す。
 * - column → column: 先頭から count 枚（正しい並び＋移動可能枚数内）を持っていく。
 * - column/freecell → freecell: 1枚だけ、空きセルのみ。
 * - column/freecell → foundation: 1枚だけ。
 */
export function moveFreecell(state: FcState, source: FcSource, target: FcTarget, count = 1): FcState {
  if (state.status === "won") return state;
  if (!Number.isInteger(count) || count < 1) return state;

  // 移動するカード列を取り出す。
  let moving: FcCard[] = [];
  if (source.kind === "column") {
    const col = state.columns[source.column];
    if (!col || col.length === 0) return state;
    if (source.column === (target as { column?: number }).column && target.kind === "column") return state;
    if (count > col.length) return state;
    moving = col.slice(col.length - count);
    if (!isValidStack(moving)) return state;
  } else {
    if (count !== 1) return state;
    const card = state.freeCells[source.index];
    if (!card) return state;
    moving = [card];
  }

  // 移動先の検証。
  if (target.kind === "column") {
    const dest = state.columns[target.column];
    if (!dest) return state;
    if (count > maxMovableCards(state, target.column)) return state;
    const destTop = dest.length > 0 ? dest[dest.length - 1] : null;
    if (!canStackOnColumn(moving[0], destTop)) return state;
  } else if (target.kind === "freecell") {
    if (count !== 1) return state;
    if (source.kind === "freecell") return state;
    if (state.freeCells[target.index] !== null) return state;
  } else {
    if (count !== 1) return state;
    if (!canStackOnFoundation(state, moving[0], target.index)) return state;
  }

  // 適用（コピーしてから変更）。
  const columns = state.columns.map((col) => [...col]);
  const freeCells = [...state.freeCells];
  const foundations = state.foundations.map((pile) => [...pile]);
  if (source.kind === "column") {
    columns[source.column].splice(columns[source.column].length - count, count);
  } else {
    freeCells[source.index] = null;
  }
  if (target.kind === "column") {
    columns[target.column].push(...moving);
  } else if (target.kind === "freecell") {
    freeCells[target.index] = moving[0];
  } else {
    foundations[target.index].push(moving[0]);
  }
  const next: FcState = { ...state, columns, freeCells, foundations, moves: state.moves + 1 };
  return isWon(next) ? { ...next, status: "won" } : next;
}

/** そのカードを組札へ自動で送って安全か（相手色の組札が rank-1 以上進んでいる、または 2 以下）。 */
export function isSafeAutoFoundation(state: FcState, card: FcCard): boolean {
  if (card.rank <= 2) return true;
  const red = isRedSuit(card.suit);
  for (const suit of FC_SUITS) {
    if (isRedSuit(suit) === red) continue;
    const pile = state.foundations[foundationIndexOfSuit(suit)];
    const topRank = pile.length > 0 ? pile[pile.length - 1].rank : 0;
    if (topRank < card.rank - 1) return false;
  }
  return true;
}

/** 場札の先頭とフリーセルから、安全に送れるカードを組札へ繰り返し送る簡易自動送り。 */
export function autoMoveFreecell(state: FcState): FcState {
  if (state.status === "won") return state;
  let current = state;
  for (let guard = 0; guard < 60; guard++) {
    let moved = false;
    // フリーセル。
    for (let i = 0; i < FC_FREE_CELLS && !moved; i++) {
      const card = current.freeCells[i];
      if (!card) continue;
      const fi = foundationIndexOfSuit(card.suit);
      if (canStackOnFoundation(current, card, fi) && isSafeAutoFoundation(current, card)) {
        current = moveFreecell(current, { kind: "freecell", index: i }, { kind: "foundation", index: fi }, 1);
        moved = true;
      }
    }
    // 場札の先頭。
    for (let c = 0; c < FC_COLUMNS && !moved; c++) {
      const col = current.columns[c];
      if (col.length === 0) continue;
      const card = col[col.length - 1];
      const fi = foundationIndexOfSuit(card.suit);
      if (canStackOnFoundation(current, card, fi) && isSafeAutoFoundation(current, card)) {
        current = moveFreecell(current, { kind: "column", column: c }, { kind: "foundation", index: fi }, 1);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return current;
}

/** 残り枚数（組札以外にあるカード数）。 */
export function freecellRemaining(state: FcState): number {
  return 52 - state.foundations.reduce((sum, pile) => sum + pile.length, 0);
}
