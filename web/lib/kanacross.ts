// カナクロス（カタカナ単語クロスワード）の純粋ロジック（UI 非依存）。
// 盤データは単語配置済みの問題を内蔵し、行列ヒントは単語リスト＋意味ヒントで出す。
// 状態は JSON 化可能な値のみ。遷移関数は状態を破壊せず新しい状態を返す。

export type KanaDirection = "across" | "down";

export type KanaWord = {
  id: string;
  direction: KanaDirection;
  /** 開始マス（0 始まり）。 */
  row: number;
  col: number;
  length: number;
  answer: string;
  hint: string;
};

export type KanaPuzzle = {
  id: string;
  title: string;
  rows: number;
  cols: number;
  /** row-major の完成盤。null は黒マス。 */
  solution: (string | null)[];
  words: KanaWord[];
};

export const KANACROSS_PUZZLES: KanaPuzzle[] = [
  {
    id: "tabemono",
    title: "たべもの",
    rows: 4,
    cols: 4,
    solution: [
      null, null, null, "パ",
      "ラ", "ー", "メ", "ン",
      "イ", null, "ロ", null,
      "ス", null, "ン", null,
    ],
    words: [
      { id: "a1", direction: "across", row: 1, col: 0, length: 4, answer: "ラーメン", hint: "スープに入った麺の料理" },
      { id: "d1", direction: "down", row: 1, col: 0, length: 3, answer: "ライス", hint: "白いごはんを英語っぽく言ったもの" },
      { id: "d2", direction: "down", row: 1, col: 2, length: 3, answer: "メロン", hint: "網目模様のある甘い果物" },
      { id: "d3", direction: "down", row: 0, col: 3, length: 2, answer: "パン", hint: "小麦粉を焼いた食べ物" },
    ],
  },
  {
    id: "ikimono",
    title: "いきもの",
    rows: 3,
    cols: 3,
    solution: [
      "ネ", "コ", null,
      "ズ", null, null,
      "ミ", "ミ", "ズ",
    ],
    words: [
      { id: "a1", direction: "across", row: 0, col: 0, length: 2, answer: "ネコ", hint: "ニャーと鳴く動物" },
      { id: "a2", direction: "across", row: 2, col: 0, length: 3, answer: "ミミズ", hint: "土の中にいる細長い生き物" },
      { id: "d1", direction: "down", row: 0, col: 0, length: 3, answer: "ネズミ", hint: "チーズが好きな小さな動物" },
    ],
  },
  {
    id: "odekake",
    title: "おでかけ",
    rows: 5,
    cols: 4,
    solution: [
      null, null, "ス", null,
      "デ", "ン", "シ", "ャ",
      "パ", null, null, null,
      "ー", null, null, null,
      "ト", null, null, null,
    ],
    words: [
      { id: "a1", direction: "across", row: 1, col: 0, length: 4, answer: "デンシャ", hint: "線路を走る乗り物" },
      { id: "d1", direction: "down", row: 1, col: 0, length: 4, answer: "デパート", hint: "買い物ができる大きなお店" },
      { id: "d2", direction: "down", row: 0, col: 2, length: 2, answer: "スシ", hint: "酢飯と魚の日本の料理" },
    ],
  },
  {
    id: "otsumami",
    title: "おつまみ",
    rows: 5,
    cols: 4,
    solution: [
      null, "サ", null, null,
      null, "イ", null, null,
      "エ", "ダ", "マ", "メ",
      "ノ", "ー", null, "ン",
      "キ", null, null, "マ",
    ],
    words: [
      { id: "a1", direction: "across", row: 2, col: 0, length: 4, answer: "エダマメ", hint: "茹でて塩をふる、緑色の豆のおつまみ" },
      { id: "d1", direction: "down", row: 0, col: 1, length: 4, answer: "サイダー", hint: "シュワッと弾ける甘い炭酸飲料" },
      { id: "d2", direction: "down", row: 2, col: 0, length: 3, answer: "エノキ", hint: "白くて細長いキノコ" },
      { id: "d3", direction: "down", row: 2, col: 3, length: 3, answer: "メンマ", hint: "ラーメンにのる、竹を発酵させたもの" },
    ],
  },
  {
    id: "dobutsu",
    title: "どうぶつ",
    rows: 5,
    cols: 4,
    solution: [
      "カ", null, null, null,
      "ピ", null, null, null,
      "バ", "ッ", "タ", null,
      "ラ", null, "ヌ", null,
      null, null, "キ", null,
    ],
    words: [
      { id: "d1", direction: "down", row: 0, col: 0, length: 4, answer: "カピバラ", hint: "世界最大のネズミの仲間" },
      { id: "a1", direction: "across", row: 2, col: 0, length: 3, answer: "バッタ", hint: "後ろ足でぴょんぴょん跳ぶ虫" },
      { id: "d2", direction: "down", row: 2, col: 2, length: 3, answer: "タヌキ", hint: "化けることで有名な動物" },
    ],
  },
  {
    id: "ringo",
    title: "リンゴ",
    rows: 3,
    cols: 3,
    solution: [
      "リ", "ン", "ゴ",
      null, null, "リ",
      null, "バ", "ラ",
    ],
    words: [
      { id: "a1", direction: "across", row: 0, col: 0, length: 3, answer: "リンゴ", hint: "赤くて丸い果物" },
      { id: "d1", direction: "down", row: 0, col: 2, length: 3, answer: "ゴリラ", hint: "胸を叩く大きなサル" },
      { id: "a2", direction: "across", row: 2, col: 1, length: 2, answer: "バラ", hint: "トゲのある花" },
    ],
  },
  {
    id: "sakana",
    title: "さかな",
    rows: 3,
    cols: 3,
    solution: [
      "メ", "ダ", "カ",
      "バ", null, null,
      "ル", "ビ", "ー",
    ],
    words: [
      { id: "a1", direction: "across", row: 0, col: 0, length: 3, answer: "メダカ", hint: "小さな川魚" },
      { id: "d1", direction: "down", row: 0, col: 0, length: 3, answer: "メバル", hint: "岩場にいる赤い魚" },
      { id: "a2", direction: "across", row: 2, col: 0, length: 3, answer: "ルビー", hint: "赤い宝石" },
    ],
  },
  {
    id: "yasai",
    title: "やさい",
    rows: 3,
    cols: 4,
    solution: [
      "キ", "ュ", "ウ", "リ",
      null, null, null, "ン",
      null, "イ", "チ", "ゴ",
    ],
    words: [
      { id: "a1", direction: "across", row: 0, col: 0, length: 4, answer: "キュウリ", hint: "緑色の細長い野菜" },
      { id: "d1", direction: "down", row: 0, col: 3, length: 3, answer: "リンゴ", hint: "赤い果物" },
      { id: "a2", direction: "across", row: 2, col: 1, length: 3, answer: "イチゴ", hint: "甘酸っぱい赤い果物" },
    ],
  },
  {
    id: "okazu",
    title: "おかず",
    rows: 4,
    cols: 3,
    solution: [
      "ト", "マ", "ト",
      "ウ", null, "メ",
      "フ", null, "ロ",
      null, null, "ン",
    ],
    words: [
      { id: "a1", direction: "across", row: 0, col: 0, length: 3, answer: "トマト", hint: "赤くて丸い野菜" },
      { id: "d1", direction: "down", row: 0, col: 0, length: 3, answer: "トウフ", hint: "大豆から作る白い食べ物" },
      { id: "d2", direction: "down", row: 1, col: 2, length: 3, answer: "メロン", hint: "網目模様のある甘い果物" },
    ],
  },
  {
    id: "amerika",
    title: "アメリカ",
    rows: 4,
    cols: 3,
    solution: [
      "ア", "イ", "ス",
      "メ", null, "イ",
      "リ", null, "カ",
      "カ", null, null,
    ],
    words: [
      { id: "a1", direction: "across", row: 0, col: 0, length: 3, answer: "アイス", hint: "冷たくて甘いお菓子" },
      { id: "d1", direction: "down", row: 0, col: 0, length: 4, answer: "アメリカ", hint: "自由の女神がある大きな国" },
      { id: "d2", direction: "down", row: 0, col: 2, length: 3, answer: "スイカ", hint: "夏の赤くて大きな果物" },
    ],
  },
  {
    id: "karee",
    title: "カレー",
    rows: 3,
    cols: 3,
    solution: [
      "カ", "レ", "ー",
      "エ", "モ", null,
      "ル", "ン", null,
    ],
    words: [
      { id: "a1", direction: "across", row: 0, col: 0, length: 3, answer: "カレー", hint: "ごはんにかける、辛くて黄色い料理" },
      { id: "d1", direction: "down", row: 0, col: 0, length: 3, answer: "カエル", hint: "ケロケロ鳴く緑色の生き物" },
      { id: "d2", direction: "down", row: 0, col: 1, length: 3, answer: "レモン", hint: "黄色くて酸っぱい果物" },
    ],
  },
  {
    id: "umigame",
    title: "ウミガメ",
    rows: 4,
    cols: 3,
    solution: [
      "ウ", "サ", "ギ",
      "ミ", null, null,
      "ガ", "ム", null,
      "メ", null, null,
    ],
    words: [
      { id: "a1", direction: "across", row: 0, col: 0, length: 3, answer: "ウサギ", hint: "耳の長い動物" },
      { id: "d1", direction: "down", row: 0, col: 0, length: 4, answer: "ウミガメ", hint: "海を泳ぐ大きなカメ" },
      { id: "a2", direction: "across", row: 2, col: 0, length: 2, answer: "ガム", hint: "噛んで味わうお菓子" },
    ],
  },
  {
    id: "ajia",
    title: "アジア",
    rows: 4,
    cols: 3,
    solution: [
      "ア", "ジ", "ア",
      "ン", null, null,
      "パ", "ン", null,
      "ン", null, null,
    ],
    words: [
      { id: "a1", direction: "across", row: 0, col: 0, length: 3, answer: "アジア", hint: "日本がある大きな大陸" },
      { id: "d1", direction: "down", row: 0, col: 0, length: 4, answer: "アンパン", hint: "あんこが入った甘いパン" },
      { id: "a2", direction: "across", row: 2, col: 0, length: 2, answer: "パン", hint: "朝食によく食べる焼いた食べ物" },
    ],
  },
  {
    id: "kabocha",
    title: "かぼちゃ",
    rows: 4,
    cols: 4,
    solution: [
      "カ", null, null, null,
      "ボ", null, null, null,
      "チ", "ャ", "ハ", "ン",
      "ャ", null, null, null,
    ],
    words: [
      { id: "d1", direction: "down", row: 0, col: 0, length: 4, answer: "カボチャ", hint: "ハロウィンで使うオレンジ色の野菜" },
      { id: "a1", direction: "across", row: 2, col: 0, length: 4, answer: "チャハン", hint: "ごはんを炒めた中華料理" },
    ],
  },
];

export type KanaState = {
  puzzleIndex: number;
  /** row-major の入力。黒マスと未入力は ""。 */
  entries: string[];
  status: "playing" | "completed";
  /** 「チェック」で間違いだった回数。 */
  mistakes: number;
};

export function getKanacrossPuzzle(index: number): KanaPuzzle {
  const i = Number.isFinite(index) ? Math.floor(index) : 0;
  return KANACROSS_PUZZLES[Math.min(KANACROSS_PUZZLES.length - 1, Math.max(0, i))];
}

/** 単語が占めるマスの index 一覧。 */
export function wordCells(puzzle: KanaPuzzle, word: KanaWord): number[] {
  const out: number[] = [];
  for (let k = 0; k < word.length; k++) {
    const row = word.direction === "down" ? word.row + k : word.row;
    const col = word.direction === "across" ? word.col + k : word.col;
    out.push(row * puzzle.cols + col);
  }
  return out;
}

/** そのマスを含む単語 id の一覧。 */
export function cellWordIds(puzzle: KanaPuzzle, index: number): string[] {
  return puzzle.words
    .filter((w) => wordCells(puzzle, w).includes(index))
    .map((w) => w.id);
}

/** 盤データの整合性検証（単語と完成盤の一致、全ての白マスが単語に属すること）。 */
export function isValidPuzzle(puzzle: KanaPuzzle): boolean {
  if (puzzle.solution.length !== puzzle.rows * puzzle.cols) return false;
  const covered = new Set<number>();
  for (const word of puzzle.words) {
    if (word.answer.length !== word.length) return false;
    const cells = wordCells(puzzle, word);
    for (let k = 0; k < cells.length; k++) {
      if (puzzle.solution[cells[k]] !== word.answer[k]) return false;
      covered.add(cells[k]);
    }
  }
  for (let i = 0; i < puzzle.solution.length; i++) {
    if (puzzle.solution[i] !== null && !covered.has(i)) return false;
  }
  return true;
}

const KANA_RE = /^[ァ-ヶー]$/;

/**
 * 入力パレットの行構成（清音＋小書き＋濁点・半濁点）。
 * 全問題の solution に現れる文字は必ずこのパレットに含まれる
 * （パレットだけで全問題を完成できること。テストで検証する）。
 */
export const KANA_PALETTE_ROWS: string[] = [
  "アイウエオカキクケコ",
  "サシスセソタチツテト",
  "ナニヌネノハヒフヘホ",
  "マミムメモヤユヨラリルレロ",
  "ワヲンーァィゥェォャュョッ",
  "ガギグゲゴザジズゼゾ",
  "ダヂヅデドバビブベボ",
  "パピプペポ",
];

export function createKanacrossGame(puzzleIndex: number): KanaState {
  const puzzle = getKanacrossPuzzle(puzzleIndex);
  return {
    puzzleIndex: KANACROSS_PUZZLES.indexOf(puzzle),
    entries: puzzle.solution.map(() => ""),
    status: "playing",
    mistakes: 0,
  };
}

/** 全ての白マスが正解と一致しているか。 */
export function isComplete(state: KanaState): boolean {
  const puzzle = getKanacrossPuzzle(state.puzzleIndex);
  return puzzle.solution.every((ch, i) => ch === null || state.entries[i] === ch);
}

/** 1マス入力する。黒マス・完成後・カタカナ1文字でない入力は無視する。 */
export function setEntry(state: KanaState, index: number, ch: string): KanaState {
  if (state.status !== "playing") return state;
  const puzzle = getKanacrossPuzzle(state.puzzleIndex);
  if (!Number.isInteger(index) || index < 0 || index >= puzzle.solution.length) return state;
  if (puzzle.solution[index] === null) return state;
  if (typeof ch !== "string" || (ch !== "" && !KANA_RE.test(ch))) return state;
  if (state.entries[index] === ch) return state;
  const entries = [...state.entries];
  entries[index] = ch;
  const next: KanaState = { ...state, entries };
  return isComplete(next) ? { ...next, status: "completed" } : next;
}

export type KanaWordStatus = "correct" | "wrong" | "partial" | "empty";

/** 単語の現在の状態（入力と正解の比較）。 */
export function wordStatus(state: KanaState, wordId: string): KanaWordStatus {
  const puzzle = getKanacrossPuzzle(state.puzzleIndex);
  const word = puzzle.words.find((w) => w.id === wordId);
  if (!word) return "empty";
  const cells = wordCells(puzzle, word);
  const values = cells.map((i) => state.entries[i]);
  if (values.every((v) => v === "")) return "empty";
  if (values.some((v) => v === "")) return "partial";
  return values.every((v, k) => v === word.answer[k]) ? "correct" : "wrong";
}

/** 単語をチェックする。埋まっていて間違いなら mistakes を加算する。 */
export function checkWord(state: KanaState, wordId: string): { state: KanaState; status: KanaWordStatus } {
  const status = wordStatus(state, wordId);
  if (status === "wrong") {
    return { state: { ...state, mistakes: state.mistakes + 1 }, status };
  }
  return { state, status };
}

/** 入力済みマス数と白マス総数（進捗表示用）。 */
export function progress(state: KanaState): { filled: number; total: number } {
  const puzzle = getKanacrossPuzzle(state.puzzleIndex);
  let filled = 0;
  let total = 0;
  for (let i = 0; i < puzzle.solution.length; i++) {
    if (puzzle.solution[i] === null) continue;
    total++;
    if (state.entries[i] !== "") filled++;
  }
  return { filled, total };
}
