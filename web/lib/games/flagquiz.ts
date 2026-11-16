// フラッグクイズの純粋ロジック（UI 非依存・シード決定的）。
// 国コードと国名のペアから10問を出題する4択クイズ。旗は画像で表示する。
// 出題モードは「旗を見て国名を当てる」「国名を見て旗を当てる」の2種類。

export interface FlagPair {
  /** ISO 3166-1 alpha-2 の国コード（小文字）。旗画像は flagcdn から引く。 */
  code: string;
  name: string;
}

export const FLAG_PAIRS: FlagPair[] = [
  { code: "jp", name: "日本" },
  { code: "us", name: "アメリカ" },
  { code: "gb", name: "イギリス" },
  { code: "fr", name: "フランス" },
  { code: "de", name: "ドイツ" },
  { code: "it", name: "イタリア" },
  { code: "es", name: "スペイン" },
  { code: "pt", name: "ポルトガル" },
  { code: "nl", name: "オランダ" },
  { code: "be", name: "ベルギー" },
  { code: "ch", name: "スイス" },
  { code: "at", name: "オーストリア" },
  { code: "se", name: "スウェーデン" },
  { code: "no", name: "ノルウェー" },
  { code: "dk", name: "デンマーク" },
  { code: "fi", name: "フィンランド" },
  { code: "pl", name: "ポーランド" },
  { code: "gr", name: "ギリシャ" },
  { code: "tr", name: "トルコ" },
  { code: "ru", name: "ロシア" },
  { code: "ua", name: "ウクライナ" },
  { code: "ie", name: "アイルランド" },
  { code: "cn", name: "中国" },
  { code: "kr", name: "韓国" },
  { code: "tw", name: "台湾" },
  { code: "th", name: "タイ" },
  { code: "vn", name: "ベトナム" },
  { code: "in", name: "インド" },
  { code: "id", name: "インドネシア" },
  { code: "ph", name: "フィリピン" },
  { code: "my", name: "マレーシア" },
  { code: "sg", name: "シンガポール" },
  { code: "mn", name: "モンゴル" },
  { code: "kp", name: "北朝鮮" },
  { code: "lk", name: "スリランカ" },
  { code: "np", name: "ネパール" },
  { code: "pk", name: "パキスタン" },
  { code: "bd", name: "バングラデシュ" },
  { code: "au", name: "オーストラリア" },
  { code: "nz", name: "ニュージーランド" },
  { code: "ca", name: "カナダ" },
  { code: "mx", name: "メキシコ" },
  { code: "br", name: "ブラジル" },
  { code: "ar", name: "アルゼンチン" },
  { code: "cl", name: "チリ" },
  { code: "pe", name: "ペルー" },
  { code: "eg", name: "エジプト" },
  { code: "za", name: "南アフリカ" },
  { code: "ke", name: "ケニア" },
  { code: "ma", name: "モロッコ" },
  { code: "sa", name: "サウジアラビア" },
  { code: "ae", name: "アラブ首長国連邦" },
  { code: "il", name: "イスラエル" },
  { code: "ir", name: "イラン" },
  { code: "iq", name: "イラク" },
  { code: "cz", name: "チェコ" },
  { code: "sk", name: "スロバキア" },
  { code: "hu", name: "ハンガリー" },
  { code: "hr", name: "クロアチア" },
  { code: "ro", name: "ルーマニア" },
  { code: "bg", name: "ブルガリア" },
  { code: "is", name: "アイスランド" },
  { code: "lt", name: "リトアニア" },
  { code: "lv", name: "ラトビア" },
  { code: "ee", name: "エストニア" },
  { code: "kz", name: "カザフスタン" },
  { code: "uz", name: "ウズベキスタン" },
  { code: "mm", name: "ミャンマー" },
  { code: "kh", name: "カンボジア" },
  { code: "la", name: "ラオス" },
  { code: "co", name: "コロンビア" },
  { code: "ve", name: "ベネズエラ" },
  { code: "ec", name: "エクアドル" },
  { code: "uy", name: "ウルグアイ" },
  { code: "py", name: "パラグアイ" },
  { code: "ng", name: "ナイジェリア" },
  { code: "et", name: "エチオピア" },
  { code: "tn", name: "チュニジア" },
  { code: "dz", name: "アルジェリア" },
  { code: "qa", name: "カタール" },
  { code: "kw", name: "クウェート" },
  { code: "jo", name: "ヨルダン" },
  { code: "cu", name: "キューバ" },
  { code: "jm", name: "ジャマイカ" },
  { code: "bo", name: "ボリビア" },
  { code: "gh", name: "ガーナ" },
  { code: "sn", name: "セネガル" },
  { code: "cm", name: "カメルーン" },
  { code: "tz", name: "タンザニア" },
  { code: "ug", name: "ウガンダ" },
  { code: "zw", name: "ジンバブエ" },
  { code: "mg", name: "マダガスカル" },
  { code: "om", name: "オマーン" },
  { code: "lb", name: "レバノン" },
  { code: "sy", name: "シリア" },
  { code: "af", name: "アフガニスタン" },
  { code: "tm", name: "トルクメニスタン" },
  { code: "kg", name: "キルギス" },
  { code: "tj", name: "タジキスタン" },
  { code: "bn", name: "ブルネイ" },
  { code: "bt", name: "ブータン" },
  { code: "mv", name: "モルディブ" },
  { code: "fj", name: "フィジー" },
  { code: "pg", name: "パプアニューギニア" },
  { code: "lu", name: "ルクセンブルク" },
  { code: "mt", name: "マルタ" },
  { code: "cy", name: "キプロス" },
  { code: "me", name: "モンテネグロ" },
  { code: "mk", name: "北マケドニア" },
  { code: "al", name: "アルバニア" },
  { code: "rs", name: "セルビア" },
  { code: "ba", name: "ボスニア・ヘルツェゴビナ" },
  { code: "si", name: "スロベニア" },
  { code: "md", name: "モルドバ" },
  { code: "by", name: "ベラルーシ" },
  { code: "ge", name: "ジョージア" },
  { code: "am", name: "アルメニア" },
  { code: "az", name: "アゼルバイジャン" },
  { code: "ao", name: "アンゴラ" },
  { code: "mz", name: "モザンビーク" },
  { code: "ly", name: "リビア" },
  { code: "sd", name: "スーダン" },
  { code: "ml", name: "マリ" },
  { code: "zm", name: "ザンビア" },
  { code: "na", name: "ナミビア" },
  { code: "bw", name: "ボツワナ" },
  { code: "cd", name: "コンゴ民主共和国" },
  { code: "mu", name: "モーリシャス" },
  { code: "ye", name: "イエメン" },
  { code: "bh", name: "バーレーン" },
  { code: "ps", name: "パレスチナ" },
  { code: "tl", name: "東ティモール" },
  { code: "sb", name: "ソロモン諸島" },
  { code: "vu", name: "バヌアツ" },
  { code: "ws", name: "サモア" },
  { code: "to", name: "トンガ" },
  { code: "ki", name: "キリバス" },
  { code: "pw", name: "パラオ" },
  { code: "gt", name: "グアテマラ" },
  { code: "hn", name: "ホンジュラス" },
  { code: "ni", name: "ニカラグア" },
  { code: "cr", name: "コスタリカ" },
  { code: "pa", name: "パナマ" },
  { code: "do", name: "ドミニカ共和国" },
  { code: "ht", name: "ハイチ" },
  { code: "gy", name: "ガイアナ" },
  { code: "sr", name: "スリナム" },
  { code: "li", name: "リヒテンシュタイン" },
  { code: "ad", name: "アンドラ" },
  { code: "mc", name: "モナコ" },
  { code: "sv", name: "エルサルバドル" },
  { code: "bz", name: "ベリーズ" },
  { code: "bs", name: "バハマ" },
  { code: "bb", name: "バルバドス" },
  { code: "tt", name: "トリニダード・トバゴ" },
  { code: "nr", name: "ナウル" },
  { code: "tv", name: "ツバル" },
  { code: "mh", name: "マーシャル諸島" },
  { code: "fm", name: "ミクロネシア" },
  { code: "sc", name: "セーシェル" },
  { code: "cv", name: "カーボベルデ" },
  { code: "dj", name: "ジブチ" },
  { code: "ss", name: "南スーダン" },
  { code: "td", name: "チャド" },
  { code: "ne", name: "ニジェール" },
  { code: "ci", name: "コートジボワール" },
  { code: "rw", name: "ルワンダ" },
  { code: "ls", name: "レソト" },
  { code: "hk", name: "香港" },
  { code: "pr", name: "プエルトリコ" },
  { code: "gd", name: "グレナダ" },
  { code: "lc", name: "セントルシア" },
  { code: "vc", name: "セントビンセント・グレナディーン" },
  { code: "kn", name: "セントクリストファー・ネイビス" },
  { code: "dm", name: "ドミニカ国" },
  { code: "ag", name: "アンティグア・バーブーダ" },
  { code: "er", name: "エリトリア" },
  { code: "cf", name: "中央アフリカ共和国" },
  { code: "cg", name: "コンゴ共和国" },
  { code: "ga", name: "ガボン" },
  { code: "gn", name: "ギニア" },
  { code: "bi", name: "ブルンジ" },
  { code: "bf", name: "ブルキナファソ" },
  { code: "tg", name: "トーゴ" },
  { code: "sm", name: "サンマリノ" },
  { code: "va", name: "バチカン" },
  { code: "gw", name: "ギニアビサウ" },
  { code: "sl", name: "シエラレオネ" },
  { code: "lr", name: "リベリア" },
  { code: "mr", name: "モーリタニア" },
  { code: "km", name: "コモロ" },
  { code: "sz", name: "エスワティニ" },
  { code: "st", name: "サントメ・プリンシペ" },
  { code: "gl", name: "グリーンランド" },
  { code: "ck", name: "クック諸島" },
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
