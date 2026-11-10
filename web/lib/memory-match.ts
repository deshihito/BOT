// メモリーマッチ（神経衰弱）の純粋ロジック（UI 非依存・シード決定的）。
// めくる操作は flipCard、2枚開いたあとの照合は settlePair が行う
// （UI 側は不一致のとき少し見せてから settlePair を呼ぶ）。

export const MEMORY_ICONS = ["🍎", "🍋", "🍇", "🍓", "🍑", "🍈", "🍒", "🥝"] as const;

export type MemCard = {
  icon: string;
  matched: boolean;
};

export type MemState = {
  cards: MemCard[];
  /** 現在めくって表向きの index（0〜2枚）。 */
  faceUp: number[];
  moves: number;
  matchedPairs: number;
  status: "playing" | "won";
};

function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

export function createMemoryGame(seed: number, pairCount: number = MEMORY_ICONS.length): MemState {
  const icons = MEMORY_ICONS.slice(0, pairCount);
  const deck: string[] = [...icons, ...icons];
  let rng = seed | 0;
  for (let i = deck.length - 1; i > 0; i--) {
    const r = nextRandom(rng);
    rng = r.rng;
    const j = Math.floor(r.value * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return {
    cards: deck.map((icon) => ({ icon, matched: false })),
    faceUp: [],
    moves: 0,
    matchedPairs: 0,
    status: "playing",
  };
}

export function flipCard(state: MemState, index: number): MemState {
  if (state.status !== "playing") return state;
  if (state.faceUp.length >= 2) return state;
  const card = state.cards[index];
  if (!card || card.matched || state.faceUp.includes(index)) return state;
  return { ...state, faceUp: [...state.faceUp, index] };
}

/** 2枚開いた状態を照合する。一致なら matched にし、不一致なら裏へ戻す。 */
export function settlePair(state: MemState): MemState {
  if (state.faceUp.length !== 2) return state;
  const [a, b] = state.faceUp;
  const moves = state.moves + 1;
  if (state.cards[a].icon === state.cards[b].icon) {
    const cards = state.cards.map((card, i) =>
      i === a || i === b ? { ...card, matched: true } : card,
    );
    const matchedPairs = state.matchedPairs + 1;
    const won = matchedPairs * 2 === state.cards.length;
    return {
      ...state,
      cards,
      faceUp: [],
      moves,
      matchedPairs,
      status: won ? "won" : "playing",
    };
  }
  return { ...state, faceUp: [], moves };
}

/** 2枚開いていて照合待ちかどうか。 */
export function isPairPending(state: MemState): boolean {
  return state.faceUp.length === 2;
}

/** 開いている2枚が一致しているか（UI のハイライト用。settlePair 前提）。 */
export function pendingIsMatch(state: MemState): boolean {
  if (state.faceUp.length !== 2) return false;
  return state.cards[state.faceUp[0]].icon === state.cards[state.faceUp[1]].icon;
}
