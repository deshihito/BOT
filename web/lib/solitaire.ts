// ソリティア（クロンダイク）の純粋ロジック（UI 非依存・シード決定的）。
// 状態は JSON 化可能な値だけを持ち、全ての遷移関数は入力を変更しない。
// ルール: 場札は色を交互に降順、組札は同スート昇順、空の場札には K のみ。
// ストックは1枚引き、尽きたら捨て札を裏返して再循環できる。

export type Suit = "spades" | "hearts" | "diamonds" | "clubs";

export type SolCard = {
  /** "spades-13" のような一意なID。 */
  id: string;
  suit: Suit;
  /** 1=A, 11=J, 12=Q, 13=K。 */
  rank: number;
  faceUp: boolean;
};

export type SolState = {
  /** 山札。末尾が一番上。 */
  stock: SolCard[];
  /** 捨て札（めくったカード）。末尾が一番上。 */
  waste: SolCard[];
  /** 組札4山。末尾が一番上。 */
  foundations: [SolCard[], SolCard[], SolCard[], SolCard[]];
  /** 場札7列。各列の末尾が一番下（手前）。 */
  tableau: SolCard[][];
  moves: number;
  status: "playing" | "won";
};

export const SUITS: readonly Suit[] = ["spades", "hearts", "diamonds", "clubs"];

export function isRedSuit(suit: Suit): boolean {
  return suit === "hearts" || suit === "diamonds";
}

export function suitSymbol(suit: Suit): string {
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

/** mulberry32 系。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function createDeck(): SolCard[] {
  const deck: SolCard[] = [];
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 13; rank++) {
      deck.push({ id: `${suit}-${rank}`, suit, rank, faceUp: false });
    }
  }
  return deck;
}

export function createSolitaire(seed: number): SolState {
  const deck = createDeck();
  let rng = seed | 0;
  for (let i = deck.length - 1; i > 0; i--) {
    const r = nextRandom(rng);
    rng = r.rng;
    const j = Math.floor(r.value * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const tableau: SolCard[][] = [];
  let pos = 0;
  for (let col = 0; col < 7; col++) {
    const pile: SolCard[] = [];
    for (let k = 0; k <= col; k++) {
      const card = deck[pos];
      pos++;
      pile.push(k === col ? { ...card, faceUp: true } : card);
    }
    tableau.push(pile);
  }
  return {
    stock: deck.slice(pos),
    waste: [],
    foundations: [[], [], [], []],
    tableau,
    moves: 0,
    status: "playing",
  };
}

/** 場札の上に重ねられるか。空列には K のみ、それ以外は色交互で1つ下の数字。 */
export function canStackOnTableau(moving: SolCard, targetTop: SolCard | null): boolean {
  if (!moving.faceUp) return false;
  if (targetTop === null) return moving.rank === 13;
  if (!targetTop.faceUp) return false;
  if (isRedSuit(moving.suit) === isRedSuit(targetTop.suit)) return false;
  return targetTop.rank === moving.rank + 1;
}

/** 組札の上に重ねられるか。空山には A のみ、それ以外は同スートで1つ上の数字。 */
export function canStackOnFoundation(card: SolCard, pile: SolCard[]): boolean {
  if (!card.faceUp) return false;
  const top = pile.length > 0 ? pile[pile.length - 1] : null;
  if (top === null) return card.rank === 1;
  return top.suit === card.suit && card.rank === top.rank + 1;
}

export function foundationTotal(state: SolState): number {
  return state.foundations.reduce((sum, pile) => sum + pile.length, 0);
}

export function isWon(state: SolState): boolean {
  return foundationTotal(state) === 52;
}

/** 場札の先頭（末尾）が裏向きなら表にする。tableau を差し替えたあとに使う内部処理。 */
function flipTableauTops(tableau: SolCard[][]): SolCard[][] {
  return tableau.map((pile) => {
    if (pile.length === 0) return pile;
    const top = pile[pile.length - 1];
    if (top.faceUp) return pile;
    const next = pile.slice();
    next[next.length - 1] = { ...top, faceUp: true };
    return next;
  });
}

function finish(state: SolState): SolState {
  if (state.status !== "won" && isWon(state)) return { ...state, status: "won" };
  return state;
}

/** ストックを1枚めくる。ストックが尽きていれば捨て札を裏返して再循環する。 */
export function drawFromStock(state: SolState): SolState {
  if (state.status === "won") return state;
  if (state.stock.length > 0) {
    const card = state.stock[state.stock.length - 1];
    return {
      ...state,
      stock: state.stock.slice(0, -1),
      waste: [...state.waste, { ...card, faceUp: true }],
      moves: state.moves + 1,
    };
  }
  if (state.waste.length > 0) {
    const stock = state.waste
      .slice()
      .reverse()
      .map((card) => ({ ...card, faceUp: false }));
    return { ...state, stock, waste: [], moves: state.moves + 1 };
  }
  return state;
}

/** 捨て札の一番上を場札の列へ動かす。 */
export function moveWasteToTableau(state: SolState, col: number): SolState {
  if (state.status === "won") return state;
  const pile = state.tableau[col];
  const card = state.waste.length > 0 ? state.waste[state.waste.length - 1] : null;
  if (!pile || !card) return state;
  const targetTop = pile.length > 0 ? pile[pile.length - 1] : null;
  if (!canStackOnTableau(card, targetTop)) return state;
  return finish({
    ...state,
    waste: state.waste.slice(0, -1),
    tableau: state.tableau.map((p, i) => (i === col ? [...p, card] : p)),
    moves: state.moves + 1,
  });
}

/** 場札の列同士で、表向きカード（複数枚の束も可）を動かす。 */
export function moveTableauToTableau(
  state: SolState,
  fromCol: number,
  fromIndex: number,
  toCol: number,
): SolState {
  if (state.status === "won") return state;
  if (fromCol === toCol) return state;
  const from = state.tableau[fromCol];
  const to = state.tableau[toCol];
  if (!from || !to) return state;
  if (fromIndex < 0 || fromIndex >= from.length) return state;
  const moving = from.slice(fromIndex);
  if (moving.length === 0 || moving.some((c) => !c.faceUp)) return state;
  // 束の内部が「色交互・降順」になっていることを検証する（不正な状態を弾く）
  for (let i = 1; i < moving.length; i++) {
    if (!canStackOnTableau(moving[i], moving[i - 1])) return state;
  }
  const targetTop = to.length > 0 ? to[to.length - 1] : null;
  if (!canStackOnTableau(moving[0], targetTop)) return state;
  const tableau = state.tableau.map((p, i) => {
    if (i === fromCol) return p.slice(0, fromIndex);
    if (i === toCol) return [...p, ...moving];
    return p;
  });
  return finish({
    ...state,
    tableau: flipTableauTops(tableau),
    moves: state.moves + 1,
  });
}

/** 組札の山から場札へ1枚戻す。 */
export function moveFoundationToTableau(state: SolState, pileIndex: number, col: number): SolState {
  if (state.status === "won") return state;
  const pile = state.foundations[pileIndex];
  const target = state.tableau[col];
  if (!pile || pile.length === 0 || !target) return state;
  const card = pile[pile.length - 1];
  const targetTop = target.length > 0 ? target[target.length - 1] : null;
  if (!canStackOnTableau(card, targetTop)) return state;
  const foundations = state.foundations.map((p, i) =>
    i === pileIndex ? p.slice(0, -1) : p,
  ) as SolState["foundations"];
  return finish({
    ...state,
    foundations,
    tableau: state.tableau.map((p, i) => (i === col ? [...p, card] : p)),
    moves: state.moves + 1,
  });
}

function placeOnFoundation(
  state: SolState,
  card: SolCard,
  remove: (s: SolState) => Partial<SolState>,
): SolState {
  const pileIndex = state.foundations.findIndex((pile) => canStackOnFoundation(card, pile));
  if (pileIndex < 0) return state;
  const foundations = state.foundations.map((p, i) =>
    i === pileIndex ? [...p, card] : p,
  ) as SolState["foundations"];
  const partial = remove(state);
  const merged: SolState = { ...state, ...partial, foundations, moves: state.moves + 1 };
  return finish({ ...merged, tableau: flipTableauTops(merged.tableau) });
}

/** 捨て札の一番上を組札へ動かす。置ける山が無ければ状態は変わらない。 */
export function moveWasteToFoundation(state: SolState): SolState {
  if (state.status === "won") return state;
  const card = state.waste.length > 0 ? state.waste[state.waste.length - 1] : null;
  if (!card) return state;
  return placeOnFoundation(state, card, (s) => ({ waste: s.waste.slice(0, -1) }));
}

/** 場札の列の一番下（末尾）を組札へ動かす。 */
export function moveTableauToFoundation(state: SolState, col: number): SolState {
  if (state.status === "won") return state;
  const pile = state.tableau[col];
  if (!pile || pile.length === 0) return state;
  const card = pile[pile.length - 1];
  if (!card.faceUp) return state;
  return placeOnFoundation(state, card, (s) => ({
    tableau: s.tableau.map((p, i) => (i === col ? p.slice(0, -1) : p)),
  }));
}

export type FoundationSource = { kind: "waste" } | { kind: "tableau"; col: number };

/** いま組札へ動かせるカードがあれば、その出所を返す（自動移動・候補表示用）。 */
export function findFoundationMove(state: SolState): FoundationSource | null {
  if (state.status === "won") return null;
  const wasteTop = state.waste.length > 0 ? state.waste[state.waste.length - 1] : null;
  if (wasteTop && state.foundations.some((pile) => canStackOnFoundation(wasteTop, pile))) {
    return { kind: "waste" };
  }
  for (let col = 0; col < state.tableau.length; col++) {
    const pile = state.tableau[col];
    if (pile.length === 0) continue;
    const top = pile[pile.length - 1];
    if (top.faceUp && state.foundations.some((f) => canStackOnFoundation(top, f))) {
      return { kind: "tableau", col };
    }
  }
  return null;
}

/** 組札へ自動で1枚動かす。動かせるカードが無ければ状態は変わらない。 */
export function autoMoveToFoundation(state: SolState): SolState {
  const source = findFoundationMove(state);
  if (!source) return state;
  return source.kind === "waste"
    ? moveWasteToFoundation(state)
    : moveTableauToFoundation(state, source.col);
}

/** 指定した出所のカードを組札へ動かす（ダブルクリック用）。 */
export function tryMoveToFoundation(state: SolState, source: FoundationSource): SolState {
  return source.kind === "waste"
    ? moveWasteToFoundation(state)
    : moveTableauToFoundation(state, source.col);
}
