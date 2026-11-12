// ワード当て（5文字英単語推測）の純粋ロジック（UI 非依存・シード決定的）。
// 文字判定は標準ルール: まず完全一致を確定し、残りの文字数の中で
// 「含まれる」を割り当てるため、重複文字を正確に処理できる。

export type LetterMark = "correct" | "present" | "absent";

export type WordleStatus = "playing" | "won" | "lost";

export type WordleState = {
  answer: string;
  guesses: string[];
  marks: LetterMark[][];
  status: WordleStatus;
  maxGuesses: number;
};

export const WORDLE_LENGTH = 5;
export const WORDLE_MAX_GUESSES = 6;

/** 答えの候補（実在する5文字英単語）。 */
export const ANSWER_WORDS: readonly string[] = [
  "APPLE", "BRAVE", "CRANE", "DREAM", "EAGLE", "FLAME", "GRAPE", "HOUSE", "IVORY", "JUICE",
  "KOALA", "LEMON", "MANGO", "NIGHT", "OCEAN", "PIANO", "QUEEN", "RIVER", "STONE", "TIGER",
  "ULTRA", "VIVID", "WATER", "YOUTH", "ZEBRA", "ABOUT", "ABOVE", "ACTOR", "ACUTE", "ADMIT",
  "ADOPT", "ADULT", "AFTER", "AGAIN", "AGENT", "AGREE", "AHEAD", "ALARM", "ALBUM", "ALERT",
  "ALIEN", "ALIGN", "ALIKE", "ALIVE", "ALLOW", "ALONE", "ALONG", "ALOUD", "ALPHA", "ALTAR",
  "ALTER", "AMBER", "AMEND", "AMPLE", "ANGEL", "ANGER", "ANGLE", "ANGRY", "ANKLE", "APART",
  "ARENA", "ARGUE", "ARISE", "ARMOR", "AROMA", "ARROW", "ASIDE", "ASSET", "AUDIO", "AUDIT",
  "AVOID", "AWAKE", "AWARD", "AWARE", "AWFUL", "BACON", "BADGE", "BAGEL", "BAKER", "BASIC",
  "BASIL", "BASIN", "BASIS", "BATCH", "BEACH", "BEARD", "BEAST", "BEGIN", "BEING", "BELLY",
  "BELOW", "BENCH", "BERRY", "BIBLE", "BIRCH", "BIRTH", "BISON", "BLACK", "BLADE", "BLAME",
  "BLANK", "BLAST", "BLAZE", "BLEAK", "BLEND", "BLESS", "BLIND", "BLINK", "BLISS", "BLOCK",
  "BLOOD", "BLOOM", "BLUES", "BLUFF", "BLUNT", "BLURT", "BOARD", "BOAST", "BONUS", "BOOST",
  "BOOTH", "BOUND", "BRAIN", "BRAND", "BRASS", "BREAD", "BREAK", "BREED", "BRICK", "BRIDE",
  "BRIEF", "BRINE", "BRING", "BRISK", "BROAD", "BROKE", "BROOD", "BROOK", "BROOM", "BROTH",
  "BROWN", "BRUSH", "BRUTE", "BUDDY", "BUDGE", "BUILD", "BUILT", "BULGE", "BULKY", "BULLY",
  "BUMPY", "BUNCH", "BUNNY", "BURNT", "BURST", "BUSHY", "BUYER", "BYTES", "CABIN", "CABLE",
  "CACAO", "CACHE", "CADET", "CADRE", "CAGEY", "CAIRN", "CANDY", "CANOE", "CANON", "CAPER",
  "CARAT", "CARGO", "CAROL", "CARRY", "CARVE", "CASES", "CATTY", "CASTE", "CATCH", "CATER",
  "CAUSE", "CAVIL", "CEASE", "CEDAR", "CELLO", "CHAIN", "CHAIR", "CHALK", "CHAMP", "CHANT",
  "CHAOS", "CHARD", "CHARM", "CHART", "CHASE", "CHASM", "CHEAP", "CHEAT", "CHECK", "CHEEK",
  "CHEER", "CHESS", "CHEST", "CHICK", "CHIDE", "CHIEF", "CHILD", "CHILL", "CHIME", "CHINA",
  "CHIPS", "CHIRP", "CHOIR", "CHOKE", "CHORD", "CHORE", "CHOSE", "CHUCK", "CHUNK", "CHURN",
  "CHUTE", "CIDER", "CIGAR", "CINCH", "CIRCA", "CITED", "CIVIC", "CIVIL", "CLAIM", "CLAMP",
];

/** 推測として認める追加単語（答えにはならない）。 */
export const EXTRA_WORDS: readonly string[] = [
  "SLATE", "CRATE", "TRACE", "STARE", "ERASE", "LEAST", "STALE", "STEAL", "TALES", "IRATE", "ORATE",
  "AROSE", "RAISE", "TRIAL", "TRAIL", "TRAIN", "GRAIN", "DRAIN", "PLAID", "PLAIN", "SNAIL",
  "SNARE", "SNAKE", "SHAKE", "SHARE", "SHARD", "SHARK", "SHARP", "SHEEP", "SHEET", "SHELF",
  "SHELL", "SHIFT", "SHINE", "SHIRT", "SHOCK", "SHONE", "SHOES", "SHOOT", "SHORE", "SHORT",
  "SHOUT", "SHOVE", "SHOWN", "SHOWY", "SHRED", "SHREW", "SHRUB", "SHRUG", "SHUCK", "SHUNT",
  "SHUSH", "SHYLY", "ADIEU", "AUDIO", "OUIJA", "XYLEM", "JAZZY", "FUZZY", "PIZZA", "JIFFY",
  "QUIRK", "JUMBO", "VODKA", "WHIRL", "ZESTY", "YACHT", "XENON", "WALTZ", "VEXED", "MOCHA",
  "LATTE", "SUSHI", "RAMEN", "PASTA", "TACOS", "CURRY", "GYOZA", "KEBAB", "KABOB", "MANGA",
  "ABIDE", "ABODE", "ABORT", "ABUSE", "ABYSS", "ACORN", "ACRID", "ACTED", "ADEPT", "ADOBE", "ADORE",
  "ADORN", "AFIRE", "AFOOT", "AGAPE", "AGATE", "AGILE", "AGING", "AGLOW", "AGONY", "AILED", "AIMED",
  "AISLE", "ALDER", "ALGAE", "ALIBI", "ALLAY", "ALLEY", "ALLOT", "ALLOY", "ALOFT", "AMASS", "AMAZE",
  "AMBLE", "AMIGO", "AMINO", "AMISS", "AMITY", "AMONG", "AMUSE", "ANGST", "ANIMA", "ANIME", "ANISE",
  "ANNEX", "ANNOY", "ANNUL", "ANODE", "ANTIC", "ANVIL", "AORTA", "APHID", "APPLY", "APRON", "ARBOR",
  "ARDOR", "AREAS", "ARGON", "ARGOT", "ARGUS", "ARIAS", "ARIES", "ARMED", "ARRAY", "ARSON", "ASCOT",
  "ASHEN", "ASHES", "ASKER", "ASKEW", "ASPEN", "ASSAY", "ATOLL", "ATOMS", "ATONE", "ATTIC", "AVAIL",
  "AWAIT", "AXIAL", "AXIOM", "AXLES", "AZURE", "BADLY", "BAILS", "BAITS", "BAKED", "BAKES", "BALES",
  "BALKS", "BALLS", "BALMS", "BALMY", "BANAL", "BANDS", "BANES", "BANGS", "BANJO", "BANKS", "BARBS",
  "BARDS", "BARED", "BARER", "BARES", "BARFS", "BARGE", "BARKS", "BARMY", "BARNS", "BARON", "BARRE",
  "BEARS", "BONES", "BOOKS", "BOWLS", "CAKES", "CAMEL", "CARPS", "CLAMS", "CLASS", "CLEAN", "CLEAR",
  "CLIMB", "CLOCK", "CLOSE", "CLOUD", "COCKS", "COLOR", "COMET", "COOKS", "CORAL", "COUCH", "COUNT",
  "COVER", "CRABS", "CRACK", "CRASH", "CREAM", "CRICK", "CRISP", "CROSS", "CROWS", "CRUDE", "CRUEL",
  "CRUSH", "CURLY", "DADDY", "DAILY", "DAISY", "DANCE", "DESKS", "DICEY", "DINGY", "DINKY", "DIRTY",
  "DISCO", "DITTO", "DITZY", "DIVED", "DIVER", "DIVES", "DIZZY", "DODGE", "DODGY", "DOERS", "DOEST",
  "DOETH", "DOFFS", "DOGGY", "DOGMA", "DOORS", "DRANK", "DRESS", "DRIED", "DRIFT", "DRILL", "DRINK",
  "DRIVE", "DROPS", "DROWN", "DRUMS", "DRYLY", "DUCKS", "DULLY", "DUMPS", "DUMPY", "ELBOW", "FAINT",
  "FAIRY", "FAITH", "FALLS", "FALSE", "FANCY", "FANGS", "FARMS", "FATAL", "FEARS", "FEAST", "FEATS",
  "FEEDS", "FEELS", "FEIGN", "FEINT", "FELON", "FENCE", "FERNS", "FERRY", "FETAL", "FETCH", "FETID",
  "FEUDS", "FEVER", "FEWER", "FIBER", "FIELD", "FIEND", "FIERY", "FIFTH", "FIFTY", "FIGHT", "FILCH",
  "FILED", "FILER", "FILES", "FILET", "FILLO", "FILLS", "FILMS", "FILMY", "FILTH", "FINAL", "FINCH",
  "FINIS", "FINKS", "FLIES", "FLUTE", "FOGGY", "FORKS", "FOXES", "FROGS", "FROST", "FRUIT", "GAILY",
  "GAINS", "GAITS", "GALAS", "GALES", "GALLS", "GALOP", "GAMES", "GAMEY", "GAMIN", "GAMMA", "GAMMY",
  "GAMUT", "GANEF", "GANGS", "GANJA", "GEESE", "GIRLS", "GLASS", "GOALS", "GOATS", "GOLDS", "GOOSE",
  "GRASS", "GREEN", "HABIT", "HACKS", "HAILS", "HAIRS", "HANDS", "HAPPY", "HEADS", "HEART", "HELLO",
  "HERON", "HONEY", "HORSE", "HYENA", "JELLY", "JUMPS", "KICKS", "KITTY", "KNEES", "KNIFE", "LAMPS",
  "LEAFY", "LEARN", "LIGHT", "LIONS", "LIVER", "LLAMA", "LOCKS", "LUNGS", "MANLY", "MATCH", "MELON",
  "MILKS", "MISTY", "MOLES", "MOMMY", "MONEY", "MOONS", "MOOSE", "MOTHS", "MOUSE", "MOUTH", "MUSIC", "NAILS",
  "NOSES", "NURSE", "ORBIT", "OTTER", "OVALS", "PANDA", "PAPER", "PEACH", "PEARL", "PHONE", "PIGGY",
  "PLANT", "PLATE", "PUMAS", "QUICK", "RACER", "RACES", "RAINY", "RAVEN", "ROBIN", "ROCKS", "ROSES",
  "ROUND", "SACKS", "SACRA", "SADLY", "SALAD", "SANDS", "SCORE", "SEEDS", "SHAPE", "SINGS", "SKUNK",
  "SLEEP", "SLUGS", "SMILE", "SNOWY", "SONGS", "SPEED", "SPOON", "SPORT", "SQUID", "STARS", "STORK", "STORM",
  "STOVE", "STUDY", "SUGAR", "SUNNY", "SWANS", "SWIMS", "TABLE", "TEACH", "TEAMS", "TEDDY", "TEETH",
  "THROW", "TIRED", "TOADS", "TREES", "TRIAD", "TRUMP", "TULIP", "VOLES", "WASPS", "WATCH", "WAVES",
  "WHALE", "WHITE", "WINDY", "WOLFS", "WOMAN", "WORKS", "WORLD", "WORMS", "WRENS", "WRITE",
];

/** 推測に使える全単語（答え候補＋追加単語、大文字5文字）。 */
export const WORDLE_DICTIONARY: ReadonlySet<string> = new Set<string>([
  ...ANSWER_WORDS,
  ...EXTRA_WORDS,
]);

export function normalizeGuess(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isValidGuess(raw: string): boolean {
  const word = normalizeGuess(raw);
  return /^[A-Z]{5}$/.test(word) && WORDLE_DICTIONARY.has(word);
}

/** 推測を検証し、エラーメッセージ（日本語）または null を返す。 */
export function validateGuess(raw: string): string | null {
  const word = normalizeGuess(raw);
  if (word.length !== WORDLE_LENGTH) return "5文字の単語を入力してください";
  if (!/^[A-Z]+$/.test(word)) return "英字のみ入力できます";
  if (!WORDLE_DICTIONARY.has(word)) return "辞書にない単語です";
  return null;
}

/**
 * 推測を答えと照合する。重複文字は標準ルールで処理する:
 * 1) 位置も一致する文字を correct として確定し、答え側の残り文字数を数える。
 * 2) 左から順に、残り文字数がある文字を present、無ければ absent にする。
 */
export function evaluateGuess(answer: string, guess: string): LetterMark[] {
  const a = normalizeGuess(answer);
  const g = normalizeGuess(guess);
  const marks: LetterMark[] = Array.from({ length: WORDLE_LENGTH }, () => "absent" as LetterMark);
  const remaining = new Map<string, number>();
  for (let i = 0; i < WORDLE_LENGTH; i++) {
    if (g[i] === a[i]) {
      marks[i] = "correct";
    } else {
      remaining.set(a[i], (remaining.get(a[i]) ?? 0) + 1);
    }
  }
  for (let i = 0; i < WORDLE_LENGTH; i++) {
    if (marks[i] === "correct") continue;
    const count = remaining.get(g[i]) ?? 0;
    if (count > 0) {
      marks[i] = "present";
      remaining.set(g[i], count - 1);
    }
  }
  return marks;
}

/** mulberry32 系。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

/** シードから決定的に答えを選ぶ。 */
export function pickAnswer(seed: number): string {
  const r = nextRandom(seed | 0);
  const index = Math.floor(r.value * ANSWER_WORDS.length) % ANSWER_WORDS.length;
  return ANSWER_WORDS[index];
}

export function createWordleGame(seed: number): WordleState {
  return {
    answer: pickAnswer(seed),
    guesses: [],
    marks: [],
    status: "playing",
    maxGuesses: WORDLE_MAX_GUESSES,
  };
}

/** 答えを直接指定してゲームを作る（テスト・デバッグ用）。 */
export function createWordleGameWithAnswer(answer: string): WordleState {
  return {
    answer: normalizeGuess(answer),
    guesses: [],
    marks: [],
    status: "playing",
    maxGuesses: WORDLE_MAX_GUESSES,
  };
}

export type SubmitResult = {
  state: WordleState;
  error: string | null;
};

/** 推測を1回分進める。不正な推測では状態を変えず error を返す。 */
export function submitGuess(state: WordleState, rawGuess: string): SubmitResult {
  if (state.status !== "playing") return { state, error: "このゲームは終了しています" };
  const error = validateGuess(rawGuess);
  if (error) return { state, error };
  const guess = normalizeGuess(rawGuess);
  const marks = evaluateGuess(state.answer, guess);
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

/** デイリー用の日付キー（Asia/Tokyo の YYYY-MM-DD）。全員が同じ日付で同じ答えになる。 */
export function dailyKeyFor(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 日付キーから決定的なシードを作る。 */
export function dailySeedFor(date: Date): number {
  const key = dailyKeyFor(date);
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

/** デイリーモードのゲーム（その日の答えは全員共通）。 */
export function createDailyWordleGame(date: Date = new Date()): WordleState {
  return createWordleGame(dailySeedFor(date));
}

export type WordleStats = {
  played: number;
  wins: number;
  currentStreak: number;
  maxStreak: number;
  /** 推測回数分布: index 0 = 1回で正解 … index 5 = 6回で正解。 */
  distribution: number[];
  /** 記録済みゲームのキー（同一ゲームの二重記録を防ぐ）。直近60件だけ保持する。 */
  recordedKeys: string[];
};

export function emptyWordleStats(): WordleStats {
  return {
    played: 0,
    wins: 0,
    currentStreak: 0,
    maxStreak: 0,
    distribution: [0, 0, 0, 0, 0, 0],
    recordedKeys: [],
  };
}

/**
 * 終了したゲームの結果を成績へ反映する。key はゲームを一意に識別する文字列
 * （デイリーは日付キー、ランダムは開始時刻など）。同じ key は二度記録しない。
 */
export function recordWordleResult(
  stats: WordleStats,
  result: { won: boolean; guessesUsed: number; key: string },
): WordleStats {
  if (stats.recordedKeys.includes(result.key)) return stats;
  const distribution = [...stats.distribution];
  if (result.won && result.guessesUsed >= 1 && result.guessesUsed <= 6) {
    distribution[result.guessesUsed - 1]++;
  }
  const currentStreak = result.won ? stats.currentStreak + 1 : 0;
  return {
    played: stats.played + 1,
    wins: stats.wins + (result.won ? 1 : 0),
    currentStreak,
    maxStreak: Math.max(stats.maxStreak, currentStreak),
    distribution,
    recordedKeys: [...stats.recordedKeys, result.key].slice(-60),
  };
}

const SHARE_MARKS: Record<LetterMark, string> = {
  correct: "■",
  present: "▨",
  absent: "□",
};

/** 結果シェア文（絵文字ではなくブロック文字で盤面を表す）。 */
export function buildShareText(state: WordleState, label: string): string {
  const score = state.status === "won" ? String(state.guesses.length) : "X";
  const lines = state.marks.map((row) => row.map((m) => SHARE_MARKS[m]).join(""));
  return [`ワード当て ${label} ${score}/${state.maxGuesses}`, ...lines].join("\n");
}

const MARK_PRIORITY: Record<LetterMark, number> = { absent: 0, present: 1, correct: 2 };

/** キーボード表示用に、各文字の最良の判定を集約する。 */
export function keyboardState(state: WordleState): Record<string, LetterMark> {
  const out: Record<string, LetterMark> = {};
  state.guesses.forEach((guess, row) => {
    const marks = state.marks[row];
    if (!marks) return;
    for (let i = 0; i < guess.length; i++) {
      const letter = guess[i];
      const mark = marks[i];
      const current = out[letter];
      if (!current || MARK_PRIORITY[mark] > MARK_PRIORITY[current]) out[letter] = mark;
    }
  });
  return out;
}
