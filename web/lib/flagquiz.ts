// フラッグクイズの純粋ロジック（UI 非依存・シード決定的）。
// 国旗絵文字と国名のペアから10問を出題する4択クイズ。
// 出題モードは「旗を見て国名を当てる」「国名を見て旗を当てる」の2種類。

export interface FlagPair {
  flag: string;
  name: string;
}

export const FLAG_PAIRS: FlagPair[] = [
  { flag: "🇯🇵", name: "日本" },
  { flag: "🇺🇸", name: "アメリカ" },
  { flag: "🇬🇧", name: "イギリス" },
  { flag: "🇫🇷", name: "フランス" },
  { flag: "🇩🇪", name: "ドイツ" },
  { flag: "🇮🇹", name: "イタリア" },
  { flag: "🇪🇸", name: "スペイン" },
  { flag: "🇵🇹", name: "ポルトガル" },
  { flag: "🇳🇱", name: "オランダ" },
  { flag: "🇧🇪", name: "ベルギー" },
  { flag: "🇨🇭", name: "スイス" },
  { flag: "🇦🇹", name: "オーストリア" },
  { flag: "🇸🇪", name: "スウェーデン" },
  { flag: "🇳🇴", name: "ノルウェー" },
  { flag: "🇩🇰", name: "デンマーク" },
  { flag: "🇫🇮", name: "フィンランド" },
  { flag: "🇵🇱", name: "ポーランド" },
  { flag: "🇬🇷", name: "ギリシャ" },
  { flag: "🇹🇷", name: "トルコ" },
  { flag: "🇷🇺", name: "ロシア" },
  { flag: "🇺🇦", name: "ウクライナ" },
  { flag: "🇮🇪", name: "アイルランド" },
  { flag: "🇨🇳", name: "中国" },
  { flag: "🇰🇷", name: "韓国" },
  { flag: "🇹🇼", name: "台湾" },
  { flag: "🇹🇭", name: "タイ" },
  { flag: "🇻🇳", name: "ベトナム" },
  { flag: "🇮🇳", name: "インド" },
  { flag: "🇮🇩", name: "インドネシア" },
  { flag: "🇵🇭", name: "フィリピン" },
  { flag: "🇲🇾", name: "マレーシア" },
  { flag: "🇸🇬", name: "シンガポール" },
  { flag: "🇲🇳", name: "モンゴル" },
  { flag: "🇰🇵", name: "北朝鮮" },
  { flag: "🇱🇰", name: "スリランカ" },
  { flag: "🇳🇵", name: "ネパール" },
  { flag: "🇵🇰", name: "パキスタン" },
  { flag: "🇧🇩", name: "バングラデシュ" },
  { flag: "🇦🇺", name: "オーストラリア" },
  { flag: "🇳🇿", name: "ニュージーランド" },
  { flag: "🇨🇦", name: "カナダ" },
  { flag: "🇲🇽", name: "メキシコ" },
  { flag: "🇧🇷", name: "ブラジル" },
  { flag: "🇦🇷", name: "アルゼンチン" },
  { flag: "🇨🇱", name: "チリ" },
  { flag: "🇵🇪", name: "ペルー" },
  { flag: "🇪🇬", name: "エジプト" },
  { flag: "🇿🇦", name: "南アフリカ" },
  { flag: "🇰🇪", name: "ケニア" },
  { flag: "🇲🇦", name: "モロッコ" },
  { flag: "🇸🇦", name: "サウジアラビア" },
  { flag: "🇦🇪", name: "アラブ首長国連邦" },
  { flag: "🇮🇱", name: "イスラエル" },
  { flag: "🇮🇷", name: "イラン" },
  { flag: "🇮🇶", name: "イラク" },
  { flag: "🇨🇿", name: "チェコ" },
  { flag: "🇸🇰", name: "スロバキア" },
  { flag: "🇭🇺", name: "ハンガリー" },
  { flag: "🇭🇷", name: "クロアチア" },
  { flag: "🇷🇴", name: "ルーマニア" },
  { flag: "🇧🇬", name: "ブルガリア" },
  { flag: "🇮🇸", name: "アイスランド" },
  { flag: "🇱🇹", name: "リトアニア" },
  { flag: "🇱🇻", name: "ラトビア" },
  { flag: "🇪🇪", name: "エストニア" },
  { flag: "🇰🇿", name: "カザフスタン" },
  { flag: "🇺🇿", name: "ウズベキスタン" },
  { flag: "🇲🇲", name: "ミャンマー" },
  { flag: "🇰🇭", name: "カンボジア" },
  { flag: "🇱🇦", name: "ラオス" },
  { flag: "🇨🇴", name: "コロンビア" },
  { flag: "🇻🇪", name: "ベネズエラ" },
  { flag: "🇪🇨", name: "エクアドル" },
  { flag: "🇺🇾", name: "ウルグアイ" },
  { flag: "🇵🇾", name: "パラグアイ" },
  { flag: "🇳🇬", name: "ナイジェリア" },
  { flag: "🇪🇹", name: "エチオピア" },
  { flag: "🇹🇳", name: "チュニジア" },
  { flag: "🇩🇿", name: "アルジェリア" },
  { flag: "🇶🇦", name: "カタール" },
  { flag: "🇰🇼", name: "クウェート" },
  { flag: "🇯🇴", name: "ヨルダン" },
  { flag: "🇨🇺", name: "キューバ" },
  { flag: "🇯🇲", name: "ジャマイカ" },
  { flag: "🇧🇴", name: "ボリビア" },
  { flag: "🇬🇭", name: "ガーナ" },
  { flag: "🇸🇳", name: "セネガル" },
  { flag: "🇨🇲", name: "カメルーン" },
  { flag: "🇹🇿", name: "タンザニア" },
  { flag: "🇺🇬", name: "ウガンダ" },
  { flag: "🇿🇼", name: "ジンバブエ" },
  { flag: "🇲🇬", name: "マダガスカル" },
  { flag: "🇴🇲", name: "オマーン" },
  { flag: "🇱🇧", name: "レバノン" },
  { flag: "🇸🇾", name: "シリア" },
  { flag: "🇦🇫", name: "アフガニスタン" },
  { flag: "🇹🇲", name: "トルクメニスタン" },
  { flag: "🇰🇬", name: "キルギス" },
  { flag: "🇹🇯", name: "タジキスタン" },
  { flag: "🇧🇳", name: "ブルネイ" },
  { flag: "🇧🇹", name: "ブータン" },
  { flag: "🇲🇻", name: "モルディブ" },
  { flag: "🇫🇯", name: "フィジー" },
  { flag: "🇵🇬", name: "パプアニューギニア" },
  { flag: "🇱🇺", name: "ルクセンブルク" },
  { flag: "🇲🇹", name: "マルタ" },
  { flag: "🇨🇾", name: "キプロス" },
  { flag: "🇲🇪", name: "モンテネグロ" },
  { flag: "🇲🇰", name: "北マケドニア" },
  { flag: "🇦🇱", name: "アルバニア" },
  { flag: "🇷🇸", name: "セルビア" },
  { flag: "🇧🇦", name: "ボスニア・ヘルツェゴビナ" },
  { flag: "🇸🇮", name: "スロベニア" },
  { flag: "🇲🇩", name: "モルドバ" },
  { flag: "🇧🇾", name: "ベラルーシ" },
  { flag: "🇬🇪", name: "ジョージア" },
  { flag: "🇦🇲", name: "アルメニア" },
  { flag: "🇦🇿", name: "アゼルバイジャン" },
  { flag: "🇦🇴", name: "アンゴラ" },
  { flag: "🇲🇿", name: "モザンビーク" },
  { flag: "🇱🇾", name: "リビア" },
  { flag: "🇸🇩", name: "スーダン" },
  { flag: "🇲🇱", name: "マリ" },
  { flag: "🇿🇲", name: "ザンビア" },
  { flag: "🇳🇦", name: "ナミビア" },
  { flag: "🇧🇼", name: "ボツワナ" },
  { flag: "🇨🇩", name: "コンゴ民主共和国" },
  { flag: "🇲🇺", name: "モーリシャス" },
  { flag: "🇾🇪", name: "イエメン" },
  { flag: "🇧🇭", name: "バーレーン" },
  { flag: "🇵🇸", name: "パレスチナ" },
  { flag: "🇹🇱", name: "東ティモール" },
  { flag: "🇸🇧", name: "ソロモン諸島" },
  { flag: "🇻🇺", name: "バヌアツ" },
  { flag: "🇼🇸", name: "サモア" },
  { flag: "🇹🇴", name: "トンガ" },
  { flag: "🇰🇮", name: "キリバス" },
  { flag: "🇵🇼", name: "パラオ" },
  { flag: "🇬🇹", name: "グアテマラ" },
  { flag: "🇭🇳", name: "ホンジュラス" },
  { flag: "🇳🇮", name: "ニカラグア" },
  { flag: "🇨🇷", name: "コスタリカ" },
  { flag: "🇵🇦", name: "パナマ" },
  { flag: "🇩🇴", name: "ドミニカ共和国" },
  { flag: "🇭🇹", name: "ハイチ" },
  { flag: "🇬🇾", name: "ガイアナ" },
  { flag: "🇸🇷", name: "スリナム" },
  { flag: "🇱🇮", name: "リヒテンシュタイン" },
  { flag: "🇦🇩", name: "アンドラ" },
  { flag: "🇲🇨", name: "モナコ" },
  { flag: "🇸🇻", name: "エルサルバドル" },
  { flag: "🇧🇿", name: "ベリーズ" },
  { flag: "🇧🇸", name: "バハマ" },
  { flag: "🇧🇧", name: "バルバドス" },
  { flag: "🇹🇹", name: "トリニダード・トバゴ" },
  { flag: "🇳🇷", name: "ナウル" },
  { flag: "🇹🇻", name: "ツバル" },
  { flag: "🇲🇭", name: "マーシャル諸島" },
  { flag: "🇫🇲", name: "ミクロネシア" },
  { flag: "🇸🇨", name: "セーシェル" },
  { flag: "🇨🇻", name: "カーボベルデ" },
  { flag: "🇩🇯", name: "ジブチ" },
  { flag: "🇸🇸", name: "南スーダン" },
  { flag: "🇹🇩", name: "チャド" },
  { flag: "🇳🇪", name: "ニジェール" },
  { flag: "🇨🇮", name: "コートジボワール" },
  { flag: "🇷🇼", name: "ルワンダ" },
  { flag: "🇱🇸", name: "レソト" },
  { flag: "🇭🇰", name: "香港" },
  { flag: "🇵🇷", name: "プエルトリコ" },
  { flag: "🇬🇩", name: "グレナダ" },
  { flag: "🇱🇨", name: "セントルシア" },
  { flag: "🇻🇨", name: "セントビンセント・グレナディーン" },
  { flag: "🇰🇳", name: "セントクリストファー・ネイビス" },
  { flag: "🇩🇲", name: "ドミニカ国" },
  { flag: "🇦🇬", name: "アンティグア・バーブーダ" },
  { flag: "🇪🇷", name: "エリトリア" },
  { flag: "🇨🇫", name: "中央アフリカ共和国" },
  { flag: "🇨🇬", name: "コンゴ共和国" },
  { flag: "🇬🇦", name: "ガボン" },
  { flag: "🇬🇳", name: "ギニア" },
  { flag: "🇧🇮", name: "ブルンジ" },
  { flag: "🇧🇫", name: "ブルキナファソ" },
  { flag: "🇹🇬", name: "トーゴ" },
  { flag: "🇸🇲", name: "サンマリノ" },
  { flag: "🇻🇦", name: "バチカン" },
  { flag: "🇬🇼", name: "ギニアビサウ" },
  { flag: "🇸🇱", name: "シエラレオネ" },
  { flag: "🇱🇷", name: "リベリア" },
  { flag: "🇲🇷", name: "モーリタニア" },
  { flag: "🇰🇲", name: "コモロ" },
  { flag: "🇸🇿", name: "エスワティニ" },
  { flag: "🇸🇹", name: "サントメ・プリンシペ" },
  { flag: "🇬🇱", name: "グリーンランド" },
  { flag: "🇨🇰", name: "クック諸島" },
];

export const FLAG_QUIZ_QUESTION_COUNT = 10;
export const FLAG_QUIZ_SCORE_PER_CORRECT = 100;
export const FLAG_QUIZ_STREAK_BONUS = 20;
export const FLAG_QUIZ_STREAK_BONUS_CAP = 100;

export type FlagQuizMode = "flagToName" | "nameToFlag";
export type FlagQuizPhase = "question" | "revealed" | "finished";

export interface FlagQuestion {
  mode: FlagQuizMode;
  /** 正解のペア index（FLAG_PAIRS 内）。 */
  target: number;
  /** 選択肢のペア index（表示順、4つ）。 */
  choices: number[];
  /** choices 内の正解位置。 */
  answerPos: number;
}

export interface FlagRecord {
  questionIndex: number;
  /** 選んだペア index。 */
  picked: number;
  correct: boolean;
  gained: number;
}

export interface FlagQuizState {
  questions: FlagQuestion[];
  index: number;
  phase: FlagQuizPhase;
  records: FlagRecord[];
  score: number;
  streak: number;
  bestStreak: number;
  seed: number;
}

/** mulberry32 系の決定的 RNG（生成時にだけ使うローカルクロージャ）。 */
function makeRng(seed: number): () => number {
  let t = seed | 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], rng: () => number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function createFlagQuizGame(seed: number, count: number = FLAG_QUIZ_QUESTION_COUNT): FlagQuizState {
  const rng = makeRng(seed);
  const total = Math.max(1, Math.min(count, FLAG_PAIRS.length));
  const targets = shuffled(FLAG_PAIRS.map((_, i) => i), rng).slice(0, total);
  const questions: FlagQuestion[] = targets.map((target) => {
    const mode: FlagQuizMode = rng() < 0.5 ? "flagToName" : "nameToFlag";
    const others = shuffled(
      FLAG_PAIRS.map((_, i) => i).filter((i) => i !== target),
      rng,
    ).slice(0, 3);
    const choices = shuffled([target, ...others], rng);
    return { mode, target, choices, answerPos: choices.indexOf(target) };
  });
  return {
    questions,
    index: 0,
    phase: "question",
    records: [],
    score: 0,
    streak: 0,
    bestStreak: 0,
    seed,
  };
}

export function currentFlagQuestion(state: FlagQuizState): FlagQuestion | null {
  return state.questions[state.index] ?? null;
}

/** 選択肢（表示位置）で回答する。即時判定し、revealed へ移る。 */
export function answerFlagQuestion(state: FlagQuizState, choicePos: number): FlagQuizState {
  if (state.phase !== "question") return state;
  const q = currentFlagQuestion(state);
  if (!q) return state;
  if (!Number.isInteger(choicePos) || choicePos < 0 || choicePos >= q.choices.length) return state;
  const picked = q.choices[choicePos];
  const correct = picked === q.target;
  const streak = correct ? state.streak + 1 : 0;
  const bonus = correct ? Math.min(FLAG_QUIZ_STREAK_BONUS_CAP, (streak - 1) * FLAG_QUIZ_STREAK_BONUS) : 0;
  const gained = correct ? FLAG_QUIZ_SCORE_PER_CORRECT + bonus : 0;
  return {
    ...state,
    phase: "revealed",
    records: [...state.records, { questionIndex: state.index, picked, correct, gained }],
    score: state.score + gained,
    streak,
    bestStreak: Math.max(state.bestStreak, streak),
  };
}

/** revealed から次の問題へ。最後なら finished。 */
export function nextFlagQuestion(state: FlagQuizState): FlagQuizState {
  if (state.phase !== "revealed") return state;
  const next = state.index + 1;
  if (next >= state.questions.length) {
    return { ...state, index: next, phase: "finished" };
  }
  return { ...state, index: next, phase: "question" };
}

export function flagQuizCorrectCount(state: FlagQuizState): number {
  return state.records.filter((r) => r.correct).length;
}
