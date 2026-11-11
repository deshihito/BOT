// カタカナワードル（5文字カタカナ単語推測）の純粋ロジック（UI 非依存・シード決定的）。
// 英語版ワードル（lib/wordle.ts）と同じ作法で判定する:
// まず完全一致を確定し、残りの文字数の中で「含まれる」を割り当てるため、
// 重複文字を出現回数ベースで正確に処理できる。
// 推測は辞書判定をせず「カタカナ5文字」であれば受け付ける（答えバンクのみ実在語で構成）。
// 小文字（ャュョッァィゥェォ）と長音（ー）・濁点文字も1文字として数える。

export type KanaMark = "correct" | "present" | "absent";

export type KwordleStatus = "playing" | "won" | "lost";

export type KwordleState = {
  answer: string;
  guesses: string[];
  marks: KanaMark[][];
  status: KwordleStatus;
  maxGuesses: number;
};

export const KWORDLE_LENGTH = 5;
export const KWORDLE_MAX_GUESSES = 6;

/** 答えの候補（実在する5文字カタカナ語）。 */
export const KWORDLE_ANSWERS: readonly string[] = [
  "カレンダー", "バスケット", "ハンバーグ", "オムライス", "プリンセス",
  "カンガルー", "モノレール", "ユニコーン", "メロンパン", "カレーパン",
  "チャーハン", "シューマイ", "ナポリタン", "ヨーグルト", "サクランボ",
  "ラズベリー", "ハスカップ", "マヌルネコ", "ハリネズミ", "モルモット",
  "ハムスター", "カメレオン", "ロブスター", "ボウリング", "ビリヤード",
  "サーフィン", "ダイビング", "ジョギング", "カーリング", "フラダンス",
  "バイオリン", "マンドリン", "バンジョー", "ハーモニカ", "リコーダー",
  "タンバリン", "ティンパニ", "ダンプカー", "スクーター", "バイキング",
  "レストラン", "ベーカリー", "ブティック", "ピクニック", "ハイキング",
  "プラモデル", "ヌイグルミ", "マージャン", "ルーレット", "カブトムシ",
  "チョウチョ", "カタツムリ", "フェレット", "アルマジロ", "ナマケモノ",
  "カモノハシ", "エビフライ", "メンチカツ", "アジフライ", "カキフライ",
  "ケチャップ", "マヨネーズ", "キャラメル", "パンケーキ", "ティラミス",
  "モンブラン", "ウインナー", "サツマイモ", "ジャガイモ", "ワラビモチ",
  "カキゴオリ", "スムージー", "シャンパン", "ウイスキー", "ニホンシュ",
  "オヤコドン", "オポッサム", "チンアナゴ", "フラミンゴ", "ハクチョウ",
  "アホウドリ", "キリギリス", "スズメバチ", "ダンゴムシ", "アライグマ",
  "ユキウサギ", "ボクシング", "レスリング", "ボブスレー", "フリスビー",
];

/** カタカナ1文字（小文字・濁点文字・長音を含む）かどうか。 */
const KANA_CHAR_RE = /^[ァ-ヶー]$/;

export function isKanaChar(ch: string): boolean {
  return typeof ch === "string" && [...ch].length === 1 && KANA_CHAR_RE.test(ch);
}

/** 文字単位に分解する（サロゲートペアを壊さない）。 */
export function kanaChars(word: string): string[] {
  return [...word];
}

/** 推測として妥当か（カタカナ5文字ちょうど）。 */
export function isValidKwordleGuess(raw: string): boolean {
  if (typeof raw !== "string") return false;
  const chars = kanaChars(raw.trim());
  return chars.length === KWORDLE_LENGTH && chars.every(isKanaChar);
}

/** 推測を検証し、エラーメッセージ（日本語）または null を返す。 */
export function validateKwordleGuess(raw: string): string | null {
  if (typeof raw !== "string") return "カタカナ5文字を入力してください";
  const chars = kanaChars(raw.trim());
  if (chars.length !== KWORDLE_LENGTH) return "カタカナ5文字を入力してください";
  if (!chars.every(isKanaChar)) return "カタカナのみ入力できます";
  return null;
}

/**
 * 推測を答えと照合する。重複文字は標準ルールで処理する:
 * 1) 位置も一致する文字を correct として確定し、答え側の残り文字数を数える。
 * 2) 左から順に、残り文字数がある文字を present、無ければ absent にする。
 */
export function evaluateKwordleGuess(answer: string, guess: string): KanaMark[] {
  const a = kanaChars(answer);
  const g = kanaChars(guess);
  const marks: KanaMark[] = Array.from({ length: KWORDLE_LENGTH }, () => "absent" as KanaMark);
  const remaining = new Map<string, number>();
  for (let i = 0; i < KWORDLE_LENGTH; i++) {
    if (g[i] === a[i]) {
      marks[i] = "correct";
    } else {
      remaining.set(a[i], (remaining.get(a[i]) ?? 0) + 1);
    }
  }
  for (let i = 0; i < KWORDLE_LENGTH; i++) {
    if (marks[i] === "correct") continue;
    const count = remaining.get(g[i]) ?? 0;
    if (count > 0) {
      marks[i] = "present";
      remaining.set(g[i], count - 1);
    }
  }
  return marks;
}

/** mulberry32 系（lib/wordle.ts と同じ作法）。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

/** シードから決定的に答えを選ぶ。 */
export function pickKwordleAnswer(seed: number): string {
  const r = nextRandom(seed | 0);
  const index = Math.floor(r.value * KWORDLE_ANSWERS.length) % KWORDLE_ANSWERS.length;
  return KWORDLE_ANSWERS[index];
}

export function createKwordleGame(seed: number): KwordleState {
  return {
    answer: pickKwordleAnswer(seed),
    guesses: [],
    marks: [],
    status: "playing",
    maxGuesses: KWORDLE_MAX_GUESSES,
  };
}

/** 答えを直接指定してゲームを作る（テスト・デバッグ用）。 */
export function createKwordleGameWithAnswer(answer: string): KwordleState {
  return {
    answer,
    guesses: [],
    marks: [],
    status: "playing",
    maxGuesses: KWORDLE_MAX_GUESSES,
  };
}

export type KwordleSubmitResult = {
  state: KwordleState;
  error: string | null;
};

/** 推測を1回分進める。不正な推測では状態を変えず error を返す。 */
export function submitKwordleGuess(state: KwordleState, rawGuess: string): KwordleSubmitResult {
  if (state.status !== "playing") return { state, error: "このゲームは終了しています" };
  const error = validateKwordleGuess(rawGuess);
  if (error) return { state, error };
  const guess = rawGuess.trim();
  const marks = evaluateKwordleGuess(state.answer, guess);
  const guesses = [...state.guesses, guess];
  const allMarks = [...state.marks, marks];
  const won = guess === state.answer;
  const lost = !won && guesses.length >= state.maxGuesses;
  return {
    state: {
      ...state,
      guesses,
      marks: allMarks,
      status: won ? "won" : lost ? "lost" : "playing",
    },
    error: null,
  };
}

const MARK_PRIORITY: Record<KanaMark, number> = { absent: 0, present: 1, correct: 2 };

/** キーボード表示用に、各文字の最良の判定を集約する。 */
export function kwordleKeyboardState(state: KwordleState): Record<string, KanaMark> {
  const out: Record<string, KanaMark> = {};
  state.guesses.forEach((guess, row) => {
    const marks = state.marks[row];
    if (!marks) return;
    const chars = kanaChars(guess);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const mark = marks[i];
      const current = out[ch];
      if (!current || MARK_PRIORITY[mark] > MARK_PRIORITY[current]) out[ch] = mark;
    }
  });
  return out;
}

/**
 * 画面キーボードの並び（五十音＋濁点・半濁点＋小文字・長音）。
 * 小文字（ャュョッなど）と長音（ー）も独立したキーとして置く。
 */
export const KWORDLE_KEY_ROWS: readonly (readonly string[])[] = [
  ["ア", "イ", "ウ", "エ", "オ", "カ", "キ", "ク", "ケ", "コ"],
  ["サ", "シ", "ス", "セ", "ソ", "タ", "チ", "ツ", "テ", "ト"],
  ["ナ", "ニ", "ヌ", "ネ", "ノ", "ハ", "ヒ", "フ", "ヘ", "ホ"],
  ["マ", "ミ", "ム", "メ", "モ", "ヤ", "ユ", "ヨ", "ラ", "リ"],
  ["ル", "レ", "ロ", "ワ", "ヲ", "ン", "ガ", "ギ", "グ", "ゲ"],
  ["ゴ", "ザ", "ジ", "ズ", "ゼ", "ゾ", "ダ", "ヂ", "ヅ", "デ"],
  ["ド", "バ", "ビ", "ブ", "ベ", "ボ", "パ", "ピ", "プ", "ペ"],
  ["ポ", "ァ", "ィ", "ゥ", "ェ", "ォ", "ャ", "ュ", "ョ", "ッ"],
  ["ー", "ヴ"],
];
