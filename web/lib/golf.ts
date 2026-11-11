// ゴルフ（ソリティア）の純粋ロジック（UI 非依存・シード決定的）。
// 状態は JSON 化可能な値だけを持ち、全ての遷移関数は入力を変更しない。
// ルール: 7列×5枚の場札は全て表向き。山札を1枚めくって捨て札（台札）にし、
// 場札の各列の一番下（手前）のカードのうち、台札と数字が ±1 のものを台札へ取れる。
// スートは不問。K と A はつながらない（循環しない）。
// 台札に取れるカードが無くなったら山札をめくる。山札が尽きて取れるカードも
// 無くなったら終了。場札を全部取ればクリア。スコアは残った場札の枚数（少ないほど良い）。

export type GolfSuit = "spades" | "hearts" | "diamonds" | "clubs";

export type GolfCard = {
  /** "spades-13" のような一意なID。 */
  id: string;
  suit: GolfSuit;
  /** 1=A, 11=J, 12=Q, 13=K。 */
  rank: number;
};

export type GolfState = {
  /** 場札7列。各列の末尾が一番下（手前・取れるカード）。 */
  columns: GolfCard[][];
  /** 山札。末尾が一番上。 */
  stock: GolfCard[];
  /** 台札（捨て札）。末尾が現在の台。 */
  waste: GolfCard[];
  moves: number;
  taken: number;
  status: "playing" | "won" | "stuck";
  seed: number;
};

export const GOLF_COLUMNS = 7;
export const GOLF_ROWS = 5;

const SUITS: readonly GolfSuit[] = ["spades", "hearts", "diamonds", "clubs"];

export function golfSuitSymbol(suit: GolfSuit): string {
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

export function golfIsRed(suit: GolfSuit): boolean {
  return suit === "hearts" || suit === "diamonds";
}

export function golfRankLabel(rank: number): string {
  if (rank === 1) return "A";
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  return String(rank);
}

/** mulberry32（他ソリティアと同一方式）。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

/** 台札の数字に対して ±1 か（K↔A の循環はしない）。 */
export function golfMatches(rank: number, wasteRank: number): boolean {
  return Math.abs(rank - wasteRank) === 1;
}

export function createGolf(seed: number): GolfState {
  const deck: GolfCard[] = [];
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
  const columns: GolfCard[][] = [];
  let pos = 0;
  for (let col = 0; col < GOLF_COLUMNS; col++) {
    columns.push(deck.slice(pos, pos + GOLF_ROWS));
    pos += GOLF_ROWS;
  }
  const stockAll = deck.slice(pos);
  // 最初の1枚を台札としてめくる。
  const waste = stockAll.slice(stockAll.length - 1);
  const stock = stockAll.slice(0, stockAll.length - 1);
  return refreshGolfStatus({
    columns,
    stock,
    waste,
    moves: 0,
    taken: 0,
    status: "playing",
    seed: seed | 0,
  });
}

export function golfWasteTop(state: GolfState): GolfCard | null {
  return state.waste.length > 0 ? state.waste[state.waste.length - 1] : null;
}

/** いま台札へ取れる列の index 一覧。 */
export function golfPlayableColumns(state: GolfState): number[] {
  const top = golfWasteTop(state);
  if (!top || state.status !== "playing") return [];
  const out: number[] = [];
  state.columns.forEach((pile, i) => {
    if (pile.length === 0) return;
    if (golfMatches(pile[pile.length - 1].rank, top.rank)) out.push(i);
  });
  return out;
}

/** 場札の残り枚数（スコア）。 */
export function golfRemaining(state: GolfState): number {
  return state.columns.reduce((sum, pile) => sum + pile.length, 0);
}

function refreshGolfStatus(state: GolfState): GolfState {
  if (golfRemaining(state) === 0) return { ...state, status: "won" };
  if (state.stock.length === 0 && golfPlayableColumns({ ...state, status: "playing" }).length === 0) {
    return { ...state, status: "stuck" };
  }
  return { ...state, status: "playing" };
}

/** 指定列の一番下のカードを台札へ取る。不正な手は状態を変えずにそのまま返す。 */
export function takeGolf(state: GolfState, col: number): GolfState {
  if (state.status !== "playing") return state;
  if (!golfPlayableColumns(state).includes(col)) return state;
  const pile = state.columns[col];
  const card = pile[pile.length - 1];
  const columns = state.columns.map((p, i) => (i === col ? p.slice(0, -1) : p));
  return refreshGolfStatus({
    ...state,
    columns,
    waste: [...state.waste, card],
    moves: state.moves + 1,
    taken: state.taken + 1,
  });
}

/** 山札を1枚めくって台札に重ねる。 */
export function flipGolfStock(state: GolfState): GolfState {
  if (state.status !== "playing") return state;
  if (state.stock.length === 0) return state;
  const card = state.stock[state.stock.length - 1];
  return refreshGolfStatus({
    ...state,
    stock: state.stock.slice(0, -1),
    waste: [...state.waste, card],
    moves: state.moves + 1,
  });
}
