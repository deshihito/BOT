// ピラミッド（ソリティア）の純粋ロジック（UI 非依存・シード決定的）。
// 7段28枚のピラミッドと、残り24枚のストックで遊ぶ。
// 合計13になるペア（A=1 … Q=12）、または K 単体を取り除ける。
// ピラミッドのカードは、下段の覆っている2枚が両方無くなると露出する。
// ストックは1枚ずつウェイスト（捨て山）へめくり、ウェイストの一番上だけ使える。
// ストックが尽きたらウェイストを裏返して再利用できる（回数無制限）。

export type PyramidSuit = "spades" | "hearts" | "diamonds" | "clubs";

export type PyramidCard = {
  /** "spades-13" のような一意なID。 */
  id: string;
  suit: PyramidSuit;
  /** 1=A, 11=J, 12=Q, 13=K。 */
  rank: number;
};

export type PyramidState = {
  /** ピラミッド28枠。index = row*(row+1)/2 + col（row 0 が頂点）。null は除去済み。 */
  pyramid: (PyramidCard | null)[];
  /** ストック。末尾が一番上。 */
  stock: PyramidCard[];
  /** ウェイスト。末尾が一番上（使えるカード）。 */
  waste: PyramidCard[];
  moves: number;
  removed: number;
  status: "playing" | "won" | "stuck";
  seed: number;
};

export const PYRAMID_ROWS = 7;
export const PYRAMID_SLOTS = 28;

const SUITS: readonly PyramidSuit[] = ["spades", "hearts", "diamonds", "clubs"];

export function pyramidSuitSymbol(suit: PyramidSuit): string {
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

export function pyramidIsRed(suit: PyramidSuit): boolean {
  return suit === "hearts" || suit === "diamonds";
}

export function pyramidRankLabel(rank: number): string {
  if (rank === 1) return "A";
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  return String(rank);
}

/** mulberry32（solitaire 等と同一方式）。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

/** 枠 index から (row, col) を返す。 */
export function pyramidSlotPos(slot: number): { row: number; col: number } {
  let row = 0;
  let rest = slot;
  while (rest > row) {
    rest -= row + 1;
    row++;
  }
  return { row, col: rest };
}

export function createPyramid(seed: number): PyramidState {
  const deck: PyramidCard[] = [];
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 13; rank++) {
      deck.push({ id: `${suit}-${rank}`, suit, rank });
    }
  }
  let rng = seed | 0;
  for (let i = deck.length - 1; i > 0; i--) {
    const r = nextRandom(rng);
    rng = r.rng;
    const j = Math.floor(r.value * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const pyramid = deck.slice(0, PYRAMID_SLOTS).map((c) => ({ ...c }));
  // ストックは末尾が一番上になるよう、そのまま残りを入れる。
  const stock = deck.slice(PYRAMID_SLOTS).map((c) => ({ ...c }));
  return refreshStatus({
    pyramid,
    stock,
    waste: [],
    moves: 0,
    removed: 0,
    status: "playing",
    seed: seed | 0,
  });
}

/**
 * 枠のカードが露出しているか。
 * 最下段は常に露出。上段のカードは、真下の2枚（(row+1,col) と (row+1,col+1)）が
 * 両方とも取り除かれたときに露出する。
 */
export function isPyramidExposed(state: PyramidState, slot: number): boolean {
  if (!Number.isInteger(slot) || slot < 0 || slot >= PYRAMID_SLOTS) return false;
  if (state.pyramid[slot] === null) return false;
  const { row, col } = pyramidSlotPos(slot);
  if (row === PYRAMID_ROWS - 1) return true;
  const belowLeft = (row + 1) * (row + 2) / 2 + col;
  const belowRight = belowLeft + 1;
  return state.pyramid[belowLeft] === null && state.pyramid[belowRight] === null;
}

/** 露出しているピラミッドの枠 index の一覧。 */
export function exposedSlots(state: PyramidState): number[] {
  const out: number[] = [];
  for (let i = 0; i < PYRAMID_SLOTS; i++) {
    if (isPyramidExposed(state, i)) out.push(i);
  }
  return out;
}

export type PyramidTarget =
  | { kind: "pyramid"; slot: number }
  | { kind: "waste" };

function targetCard(state: PyramidState, target: PyramidTarget): PyramidCard | null {
  if (target.kind === "waste") {
    return state.waste.length > 0 ? state.waste[state.waste.length - 1] : null;
  }
  if (!isPyramidExposed(state, target.slot)) return null;
  return state.pyramid[target.slot];
}

/** 対象1つ（K単体）または2つ（合計13）が取り除ける組み合わせか。 */
export function canRemove(state: PyramidState, targets: PyramidTarget[]): boolean {
  if (state.status !== "playing") return false;
  if (targets.length === 1) {
    const card = targetCard(state, targets[0]);
    return card !== null && card.rank === 13;
  }
  if (targets.length === 2) {
    const [a, b] = targets;
    if (a.kind === "waste" && b.kind === "waste") return false;
    if (a.kind === "pyramid" && b.kind === "pyramid" && a.slot === b.slot) return false;
    const ca = targetCard(state, a);
    const cb = targetCard(state, b);
    if (ca === null || cb === null) return false;
    return ca.rank + cb.rank === 13;
  }
  return false;
}

/** 現在のウェイストの一番上も含めて、取り除ける手がどこかにあるか。 */
export function pyramidHasAnyMove(state: PyramidState): boolean {
  const exposed = exposedSlots(state);
  const exposedCards = exposed
    .map((slot) => state.pyramid[slot])
    .filter((c): c is PyramidCard => c !== null);
  // 露出カード同士・単体 K
  for (const card of exposedCards) {
    if (card.rank === 13) return true;
  }
  for (let i = 0; i < exposedCards.length; i++) {
    for (let j = i + 1; j < exposedCards.length; j++) {
      if (exposedCards[i].rank + exposedCards[j].rank === 13) return true;
    }
  }
  // ストック＋ウェイストの全カードはいずれ一番上に来うるので候補に含める。
  const sideCards = [...state.waste, ...state.stock];
  for (const side of sideCards) {
    if (side.rank === 13) return true;
    for (const card of exposedCards) {
      if (side.rank + card.rank === 13) return true;
    }
  }
  return false;
}

function refreshStatus(state: PyramidState): PyramidState {
  if (state.removed >= PYRAMID_SLOTS) {
    return { ...state, status: "won" };
  }
  // ストック/ウェイストの全カードはいずれ一番上に来うるため、
  // それらを全部候補に入れても手が無ければ、めくっても進まない＝詰み。
  if (!pyramidHasAnyMove(state)) {
    return { ...state, status: "stuck" };
  }
  return { ...state, status: "playing" };
}

/** カードを取り除く。不正な組み合わせは状態を変えずにそのまま返す。 */
export function removePyramidCards(
  state: PyramidState,
  targets: PyramidTarget[],
): PyramidState {
  if (!canRemove(state, targets)) return state;
  const pyramid = [...state.pyramid];
  const waste = [...state.waste];
  let removedPyramid = 0;
  for (const target of targets) {
    if (target.kind === "pyramid") {
      pyramid[target.slot] = null;
      removedPyramid++;
    } else {
      waste.pop();
    }
  }
  const next: PyramidState = {
    ...state,
    pyramid,
    waste,
    moves: state.moves + 1,
    removed: state.removed + removedPyramid,
  };
  return refreshStatus(next);
}

/** ストックを1枚めくる。尽きていればウェイストを裏返して再利用する。 */
export function flipPyramidStock(state: PyramidState): PyramidState {
  if (state.status === "won") return state;
  if (state.stock.length > 0) {
    const stock = [...state.stock];
    const waste = [...state.waste];
    waste.push(stock.pop() as PyramidCard);
    return refreshStatus({ ...state, stock, waste, moves: state.moves + 1 });
  }
  if (state.waste.length > 0) {
    // ウェイストをそのまま裏返すと、めくった順の一番下が次の一番上になる。
    const stock = [...state.waste].reverse();
    return refreshStatus({ ...state, stock, waste: [], moves: state.moves + 1 });
  }
  return state;
}
