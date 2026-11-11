// スパイダー・ソリティア（1スート簡易版）の純粋ロジック（UI 非依存・シード決定的）。
// 状態は JSON 化可能な値だけを持ち、全ての遷移関数は入力を変更しない。
//
// 簡易版の明示ルール:
// - カードは全て ♠（1スート制）。2組ぶんの104枚を使う。
//   表示上の都合で色は付けない（全カード同じスートとして扱う）。
// - 10列へ54枚配り（左4列が6枚、右6列が5枚）、各列の一番下だけ表向き。
//   残り50枚は山札として10枚ずつ5回配れる。
// - 移動: 下降順（13→1）に連続した表向きカードの束はまとめて動かせる。
//   置き先は「置く束の一番上が、相手の一番下より1小さい」か、空列（何でも可）。
// - 同じスート（=全カード）の K→A の13枚が列の末尾に揃ったら自動で取り除き、
//   下のカードが裏向きなら表にする。8組そろえばクリア。
// - 山札配布は空列があるときはできない（定番ルール）。

export type SpiderCard = {
  /** "sp-0-13" のような一意なID（組番号-ランク）。 */
  id: string;
  /** 1=A, 11=J, 12=Q, 13=K。スートは全てスペード固定。 */
  rank: number;
  faceUp: boolean;
};

export type SpiderState = {
  /** 場札10列。各列の末尾が一番下（手前）。 */
  columns: SpiderCard[][];
  /** 山札。末尾から10枚ずつ配る。 */
  stock: SpiderCard[];
  /** 取り除いた組数（0〜8）。 */
  completed: number;
  moves: number;
  status: "playing" | "won";
  seed: number;
};

export const SPIDER_COLUMNS = 10;
export const SPIDER_TOTAL_SETS = 8;

export function spiderRankLabel(rank: number): string {
  if (rank === 1) return "A";
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  return String(rank);
}

/** mulberry32 系。状態を持ち回らず、生成時だけ使う。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function createSpiderDeck(): SpiderCard[] {
  const deck: SpiderCard[] = [];
  for (let set = 0; set < 8; set++) {
    for (let rank = 1; rank <= 13; rank++) {
      deck.push({ id: `sp-${set}-${rank}`, rank, faceUp: false });
    }
  }
  return deck;
}

export function createSpider(seed: number): SpiderState {
  const deck = createSpiderDeck();
  let rng = seed | 0;
  for (let i = deck.length - 1; i > 0; i--) {
    const r = nextRandom(rng);
    rng = r.rng;
    const j = Math.floor(r.value * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const columns: SpiderCard[][] = [];
  let pos = 0;
  for (let col = 0; col < SPIDER_COLUMNS; col++) {
    const count = col < 4 ? 6 : 5;
    const pile: SpiderCard[] = [];
    for (let k = 0; k < count; k++) {
      const card = deck[pos];
      pos++;
      pile.push(k === count - 1 ? { ...card, faceUp: true } : card);
    }
    columns.push(pile);
  }
  return {
    columns,
    stock: deck.slice(pos),
    completed: 0,
    moves: 0,
    status: "playing",
    seed: seed | 0,
  };
}

/**
 * 列の末尾から見て、下降順に連続している表向きカードの数。
 * まとめて動かせる束はこの範囲内だけ。
 */
export function movableRunLength(state: SpiderState, col: number): number {
  const pile = state.columns[col];
  if (!pile || pile.length === 0) return 0;
  let length = 0;
  for (let i = pile.length - 1; i >= 0; i--) {
    const card = pile[i];
    if (!card.faceUp) break;
    if (i < pile.length - 1 && card.rank !== pile[i + 1].rank + 1) break;
    length++;
  }
  return length;
}

/** fromIndex から末尾までの束が、下降順の連続として動かせるか。 */
export function canMoveSpiderRun(
  state: SpiderState,
  fromCol: number,
  fromIndex: number,
  toCol: number,
): boolean {
  if (state.status !== "playing") return false;
  if (fromCol === toCol) return false;
  const from = state.columns[fromCol];
  const to = state.columns[toCol];
  if (!from || !to) return false;
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= from.length) return false;
  const runStart = from.length - movableRunLength(state, fromCol);
  if (fromIndex < runStart) return false;
  const bottom = from[fromIndex];
  if (to.length === 0) return true;
  const target = to[to.length - 1];
  if (!target.faceUp) return false;
  return target.rank === bottom.rank + 1;
}

/** 列の末尾に K→A の13枚が揃っていたら取り除く。変化した列だけ差し替える内部処理。 */
function removeCompletedRuns(columns: SpiderCard[][]): { columns: SpiderCard[][]; removed: number } {
  let removed = 0;
  const next = columns.map((pile) => {
    let current = pile;
    for (;;) {
      if (current.length < 13) break;
      const tail = current.slice(current.length - 13);
      const ok = tail.every((card, i) => card.faceUp && card.rank === 13 - i);
      if (!ok) break;
      removed++;
      current = current.slice(0, current.length - 13);
      // 取り除いた下のカードが裏向きなら表にする
      if (current.length > 0 && !current[current.length - 1].faceUp) {
        const flipped = current.slice();
        flipped[flipped.length - 1] = { ...flipped[flipped.length - 1], faceUp: true };
        current = flipped;
      }
    }
    return current;
  });
  return { columns: next, removed };
}

function withRemoval(state: SpiderState): SpiderState {
  const { columns, removed } = removeCompletedRuns(state.columns);
  if (removed === 0) return state;
  const completed = state.completed + removed;
  return {
    ...state,
    columns,
    completed,
    status: completed >= SPIDER_TOTAL_SETS ? "won" : state.status,
  };
}

function flipSourceTop(columns: SpiderCard[][], col: number): SpiderCard[][] {
  const pile = columns[col];
  if (!pile || pile.length === 0) return columns;
  const top = pile[pile.length - 1];
  if (top.faceUp) return columns;
  const next = columns.slice();
  const flipped = pile.slice();
  flipped[flipped.length - 1] = { ...top, faceUp: true };
  next[col] = flipped;
  return next;
}

/** 場札の列同士でカードの束を動かす。不正な手は状態を変えずにそのまま返す。 */
export function moveSpider(
  state: SpiderState,
  fromCol: number,
  fromIndex: number,
  toCol: number,
): SpiderState {
  if (!canMoveSpiderRun(state, fromCol, fromIndex, toCol)) return state;
  const moving = state.columns[fromCol].slice(fromIndex);
  let columns = state.columns.map((pile, i) => {
    if (i === fromCol) return pile.slice(0, fromIndex);
    if (i === toCol) return [...pile, ...moving];
    return pile;
  });
  columns = flipSourceTop(columns, fromCol);
  return withRemoval({ ...state, columns, moves: state.moves + 1 });
}

/** 山札から各列へ1枚ずつ（計10枚）配る。 */
export function dealSpider(state: SpiderState): SpiderState {
  if (state.status !== "playing") return state;
  if (state.stock.length < SPIDER_COLUMNS) return state;
  if (state.columns.some((pile) => pile.length === 0)) return state;
  const dealt = state.stock.slice(state.stock.length - SPIDER_COLUMNS);
  const stock = state.stock.slice(0, state.stock.length - SPIDER_COLUMNS);
  const columns = state.columns.map((pile, i) => [...pile, { ...dealt[i], faceUp: true }]);
  return withRemoval({ ...state, columns, stock, moves: state.moves + 1 });
}

/** 山札の残り配布回数。 */
export function spiderStockDeals(state: SpiderState): number {
  return Math.floor(state.stock.length / SPIDER_COLUMNS);
}
