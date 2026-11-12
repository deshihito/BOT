// メモリーマッチ（神経衰弱）の純粋ロジック（UI 非依存・シード決定的）。
// めくる操作は flipCard、2枚開いたあとの照合は settlePair が行う
// （UI 側は不一致のとき少し見せてから settlePair を呼ぶ）。

export type MemoryShape =
  | "circle"
  | "triangle"
  | "square"
  | "star"
  | "diamond"
  | "heart"
  | "pentagon"
  | "cross";

export interface MemorySymbol {
  /** 絵柄 ID（MemCard.icon に入る）。 */
  id: string;
  shape: MemoryShape;
  /** 塗り色（CSS カラー）。 */
  color: string;
  /** 読み上げ・ラベル用の呼び名。 */
  label: string;
}

/** ペアの絵柄は「形×色」の図形8種。色と形の両方が8種すべて異なる。 */
export const MEMORY_SYMBOLS: MemorySymbol[] = [
  { id: "circle", shape: "circle", color: "#d93a3a", label: "赤い丸" },
  { id: "triangle", shape: "triangle", color: "#2f6fd0", label: "青い三角" },
  { id: "square", shape: "square", color: "#2f9e5f", label: "緑の四角" },
  { id: "star", shape: "star", color: "#d99a06", label: "金の星" },
  { id: "diamond", shape: "diamond", color: "#8b4fc0", label: "紫の菱形" },
  { id: "heart", shape: "heart", color: "#ef6fa5", label: "ピンクのハート" },
  { id: "pentagon", shape: "pentagon", color: "#ef7d1a", label: "オレンジの五角形" },
  { id: "cross", shape: "cross", color: "#0e9594", label: "青緑の十字" },
];

/** 絵柄 ID の列（createMemoryGame の既定ペア数に使う）。 */
export const MEMORY_ICONS: string[] = MEMORY_SYMBOLS.map((s) => s.id);

/** 絵柄 ID から図形定義を引く。 */
export function memorySymbol(icon: string): MemorySymbol {
  return MEMORY_SYMBOLS.find((s) => s.id === icon) ?? MEMORY_SYMBOLS[0];
}

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
