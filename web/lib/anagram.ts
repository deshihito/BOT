// アナグラムの純粋ロジック（UI 非依存・シード決定的）。
// カタカナ単語の文字をシャッフルして出し、タイルを並べ替えて元の単語を当てさせる。
// シャッフル結果は元の単語と異なる並びになることを保証する
// （全文字が同一など並べ替えても変わらない単語はバンクに含めない）。
// 全10問。スコアは正解で最大100点、ヒント1回につき -20点（下限40点）。

export const ANAGRAM_QUESTION_COUNT = 10;
export const ANAGRAM_BASE_SCORE = 100;
export const ANAGRAM_HINT_COST = 20;
export const ANAGRAM_MIN_SCORE = 40;

export const ANAGRAM_WORDS: string[] = [
  "サクラ", "トマト", "リンゴ", "スイカ", "メロン", "ミカン", "ブドウ", "イチゴ",
  "パンダ", "コアラ", "キツネ", "タヌキ", "ウサギ", "ライオン", "ヒヨコ", "ペンギン",
  "カメレオン", "カンガルー", "ピアノ", "ギター", "バイオリン", "サックス", "サッカー",
  "テニス", "スキー", "プール", "プリン", "ゼリー", "クッキー", "チョコ", "ラーメン",
  "スシ", "テンプラ", "タコヤキ", "ホタル", "セミ", "カブトムシ",
  "バナナ", "カラス", "フクロウ", "ゴリラ", "シマウマ", "カバ",
  "トラ", "ヒョウ", "オオカミ", "ヨット", "ボート", "ヘリコプター",
  "カヌー", "ソリ", "スケート", "サーフィン", "ダンス", "カラオケ",
  "レモン", "パイナップル", "マンゴー", "ゾウ", "キリン", "カエル",
  "ウクレレ", "トランペット", "フルート", "スパゲッティ", "ハンバーグ", "オムライス",
  "ピザ", "サラダ", "カメラ", "テレビ", "ラジオ", "パソコン",
  "スマホ", "バイク", "ヒコウキ", "タクシー", "トラック", "サル",
  "ヘビ",
  "ナシ", "ウマ", "ネコ", "イヌ", "ラッコ", "カモメ", "ヒツジ", "トナカイ",
  "ダイコン", "ニンジン", "マカロニ", "ドーナツ", "カステラ", "シロクマ", "アルパカ", "クレヨン",
  "エンピツ", "ジャガイモ", "ハムスター", "ランドセル",
  "クジラ", "タコ", "イカ", "エビ", "ハチ", "トンボ", "チョウ", "ケーキ", "アイス", "ヨーグルト",
  "ハンバーガー", "サンドイッチ", "バドミントン", "ゴルフ", "ドラム", "ハーモニカ", "デンシャ", "ロケット", "フェリー", "ボウリング",
];

export type AnagramTile = { id: number; char: string };

export type AnagramState = {
  words: string[];
  index: number;
  /** 現在の問題のタイル（シャッフル済みの提示順）。 */
  tiles: AnagramTile[];
  /** 回答として並べたタイル id の列。 */
  picked: number[];
  /** ヒントで開示済みの回答位置（0始まり）。 */
  hintPositions: number[];
  /** 現在の問題で使ったヒント数。 */
  hintsUsed: number;
  score: number;
  correctCount: number;
  /** playing: 回答中 / answered: 判定表示中 / finished: 全問終了 */
  status: "playing" | "answered" | "finished";
  lastCorrect: boolean | null;
  seed: number;
  rng: number;
};

/** mulberry32。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function shuffleWith<T>(items: T[], rng: number): { items: T[]; rng: number } {
  const arr = [...items];
  let state = rng;
  for (let i = arr.length - 1; i > 0; i--) {
    const r = nextRandom(state);
    state = r.rng;
    const j = Math.floor(r.value * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return { items: arr, rng: state };
}

/**
 * 単語の文字をシャッフルする。元の並びと同一にはならないことを保証する
 * （最大50回試行し、それでも同じなら1文字ずらす。ずらしても同じになる単語は対象外）。
 */
export function shuffleWord(word: string, rng: number): { text: string; rng: number } {
  const chars = [...word];
  if (chars.length < 2) return { text: word, rng };
  let state = rng;
  for (let attempt = 0; attempt < 50; attempt++) {
    const r = shuffleWith(chars, state);
    state = r.rng;
    const text = r.items.join("");
    if (text !== word) return { text, rng: state };
  }
  const rotated = [...chars.slice(1), chars[0]].join("");
  return { text: rotated !== word ? rotated : word, rng: state };
}

function makeTiles(word: string, rng: number): { tiles: AnagramTile[]; rng: number } {
  const r = shuffleWord(word, rng);
  return {
    tiles: [...r.text].map((char, id) => ({ id, char })),
    rng: r.rng,
  };
}

export function createAnagramGame(seed: number, count: number = ANAGRAM_QUESTION_COUNT): AnagramState {
  const n = Math.max(1, Math.min(count, ANAGRAM_WORDS.length));
  const pickedWords = shuffleWith(ANAGRAM_WORDS, seed | 0);
  const words = pickedWords.items.slice(0, n);
  const first = makeTiles(words[0], pickedWords.rng);
  return {
    words,
    index: 0,
    tiles: first.tiles,
    picked: [],
    hintPositions: [],
    hintsUsed: 0,
    score: 0,
    correctCount: 0,
    status: "playing",
    lastCorrect: null,
    seed: seed | 0,
    rng: first.rng,
  };
}

/** 現在の問題の単語。終了時は null。 */
export function currentWord(state: AnagramState): string | null {
  return state.words[state.index] ?? null;
}

/** 現在並べている回答文字列。 */
export function currentAnswer(state: AnagramState): string {
  const byId = new Map(state.tiles.map((t) => [t.id, t.char]));
  return state.picked.map((id) => byId.get(id) ?? "").join("");
}

/** タイルを回答の末尾に置く。使えないタイル・判定表示中は同じ状態を返す。 */
export function pickTile(state: AnagramState, tileId: number): AnagramState {
  if (state.status !== "playing") return state;
  if (!state.tiles.some((t) => t.id === tileId)) return state;
  if (state.picked.includes(tileId)) return state;
  return { ...state, picked: [...state.picked, tileId] };
}

/** 回答の pos 番目（0始まり）に置いたタイルを外す。 */
export function unpickTile(state: AnagramState, pos: number): AnagramState {
  if (state.status !== "playing") return state;
  if (!Number.isInteger(pos) || pos < 0 || pos >= state.picked.length) return state;
  return { ...state, picked: state.picked.filter((_, i) => i !== pos) };
}

/** 回答を全部外す。 */
export function clearPicks(state: AnagramState): AnagramState {
  if (state.status !== "playing" || state.picked.length === 0) return state;
  return { ...state, picked: [] };
}

/**
 * ヒント: まだ開示されていない最も小さい回答位置の正解文字を開示する。
 * 全位置開示済み・判定表示中は同じ状態を返す。
 */
export function useHint(state: AnagramState): AnagramState {
  if (state.status !== "playing") return state;
  const word = currentWord(state);
  if (!word) return state;
  const len = [...word].length;
  for (let pos = 0; pos < len; pos++) {
    if (!state.hintPositions.includes(pos)) {
      return {
        ...state,
        hintPositions: [...state.hintPositions, pos].sort((a, b) => a - b),
        hintsUsed: state.hintsUsed + 1,
      };
    }
  }
  return state;
}

/** 位置 pos のヒント文字（開示済みのときだけ）。 */
export function hintCharAt(state: AnagramState, pos: number): string | null {
  if (!state.hintPositions.includes(pos)) return null;
  const word = currentWord(state);
  if (!word) return null;
  return [...word][pos] ?? null;
}

/** 正解時に得られるスコア（ヒント数で減点、下限あり）。 */
export function anagramScoreFor(hintsUsed: number): number {
  return Math.max(ANAGRAM_MIN_SCORE, ANAGRAM_BASE_SCORE - ANAGRAM_HINT_COST * Math.max(0, hintsUsed));
}

/** 回答を判定する。全タイルを並べていない場合は同じ状態を返す。 */
export function submitAnswer(state: AnagramState): AnagramState {
  if (state.status !== "playing") return state;
  const word = currentWord(state);
  if (!word) return state;
  if (state.picked.length !== state.tiles.length) return state;
  const correct = currentAnswer(state) === word;
  return {
    ...state,
    status: "answered",
    lastCorrect: correct,
    score: state.score + (correct ? anagramScoreFor(state.hintsUsed) : 0),
    correctCount: state.correctCount + (correct ? 1 : 0),
  };
}

/** 次の問題へ。最終問題のあとは finished。 */
export function nextQuestion(state: AnagramState): AnagramState {
  if (state.status !== "answered") return state;
  const nextIndex = state.index + 1;
  if (nextIndex >= state.words.length) {
    return { ...state, index: nextIndex, status: "finished", tiles: [], picked: [], hintPositions: [], hintsUsed: 0 };
  }
  const made = makeTiles(state.words[nextIndex], state.rng);
  return {
    ...state,
    index: nextIndex,
    tiles: made.tiles,
    picked: [],
    hintPositions: [],
    hintsUsed: 0,
    status: "playing",
    lastCorrect: null,
    rng: made.rng,
  };
}
