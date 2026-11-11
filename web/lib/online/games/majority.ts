// 多数決ゲーム（オンライン対戦）のルールモジュール。
// 基盤契約: import は type のみ（テストが import を剥がして連結する）。
// 状態は JSON 化可能な値だけ。applyAction / tick / onPlayerLeft は純関数。
// 流れ: question（20秒・全員回答か時間切れで締切）→ reveal（5秒・得票分布を開示）→ 次のお題。全8問。
// 採点ルール: 締切時に各選択肢の得票数を数え、最多得票の選択肢を選んだ人全員が
// 「最多得票数 × 10点」を得る。最多が複数選択肢で並んだ場合は、その全選択肢の回答者が得点する。
// 無回答・退出したプレイヤーの回答は得票にも得点にも数えない。
// 回答内容は締切まで秘匿し、viewFor では「回答済みかどうか」だけを公開する。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export type MjPhase = "question" | "reveal" | "finished";

export type MjQuestion = {
  topic: string;
  choices: string[];
};

export const MAJORITY_QUESTIONS: MjQuestion[] = [
  { topic: "朝ごはんといえば？", choices: ["ごはん", "パン", "シリアル", "食べない"] },
  { topic: "夏といえば？", choices: ["海", "花火", "かき氷", "お祭り"] },
  { topic: "日本の山といえば？", choices: ["富士山", "立山", "槍ヶ岳", "白馬岳"] },
  { topic: "カレーの辛さといえば？", choices: ["甘口", "中辛", "辛口", "激辛"] },
  { topic: "旅行先といえば？", choices: ["京都", "沖縄", "北海道", "大阪"] },
  { topic: "冬の飲み物といえば？", choices: ["ココア", "甘酒", "ホットコーヒー", "おしるこ"] },
  { topic: "好きな寿司ネタといえば？", choices: ["マグロ", "サーモン", "エビ", "イクラ"] },
  { topic: "初詣のおみくじで出てほしいのは？", choices: ["大吉", "中吉", "小吉", "末吉"] },
  { topic: "ラーメンの味といえば？", choices: ["醤油", "味噌", "塩", "とんこつ"] },
  { topic: "おにぎりの具といえば？", choices: ["梅", "鮭", "ツナマヨ", "昆布"] },
  { topic: "お正月といえば？", choices: ["お年玉", "おせち", "初夢", "書き初め"] },
  { topic: "花見といえば？", choices: ["桜", "団子", "お酒", "写真撮影"] },
  { topic: "学校の給食といえば？", choices: ["揚げパン", "カレー", "ミルク", "ソフト麺"] },
  { topic: "誕生日ケーキといえば？", choices: ["ショートケーキ", "チョコケーキ", "チーズケーキ", "モンブラン"] },
  { topic: "温泉といえば？", choices: ["露天風呂", "サウナ", "牛乳", "卓球"] },
  { topic: "コンビニといえば？", choices: ["おにぎり", "唐揚げ", "スイーツ", "ATM"] },
  { topic: "運動会といえば？", choices: ["徒競走", "リレー", "綱引き", "玉入れ"] },
  { topic: "クリスマスといえば？", choices: ["ケーキ", "チキン", "イルミネーション", "プレゼント"] },
  { topic: "犬の種類といえば？", choices: ["柴犬", "ゴールデンレトリバー", "チワワ", "プードル"] },
  { topic: "休みの日の過ごし方といえば？", choices: ["家でごろごろ", "買い物", "スポーツ", "旅行"] },
  { topic: "ピザのトッピングといえば？", choices: ["サラミ", "シーフード", "野菜", "チーズのみ"] },
  { topic: "スマホケースといえば？", choices: ["手帳型", "クリアケース", "ハードケース", "付けない"] },
  { topic: "雨の日といえば？", choices: ["ビニール傘", "折りたたみ傘", "長傘", "傘をささない"] },
  { topic: "花火大会といえば？", choices: ["浴衣", "屋台", "たまや", "線香花火"] },
  { topic: "お祭りといえば？", choices: ["たこ焼き", "かき氷", "りんご飴", "金魚すくい"] },
  { topic: "冬といえば？", choices: ["雪", "こたつ", "みかん", "鍋"] },
  { topic: "海といえば？", choices: ["水泳", "海の家", "スイカ割り", "釣り"] },
  { topic: "ピクニックといえば？", choices: ["お弁当", "レジャーシート", "バドミントン", "お昼寝"] },
  { topic: "学校の教室といえば？", choices: ["黒板", "机", "掃除用具", "窓"] },
  { topic: "テーマパークといえば？", choices: ["ジェットコースター", "観覧車", "パレード", "ポップコーン"] },
  { topic: "駅といえば？", choices: ["改札", "時刻表", "駅弁", "ホーム"] },
  { topic: "猫といえば？", choices: ["肉球", "昼寝", "魚", "鈴"] },
  { topic: "宇宙といえば？", choices: ["星", "月", "ロケット", "宇宙人"] },
  { topic: "昔話といえば？", choices: ["桃太郎", "浦島太郎", "かぐや姫", "一寸法師"] },
  { topic: "雨上がりといえば？", choices: ["虹", "水たまり", "カエルの合唱", "傘"] },
  { topic: "お城といえば？", choices: ["姫路城", "大阪城", "熊本城", "松本城"] },
  { topic: "野菜といえば？", choices: ["トマト", "にんじん", "きゅうり", "じゃがいも"] },
  { topic: "果物といえば？", choices: ["りんご", "バナナ", "みかん", "ぶどう"] },
  { topic: "夜ごはんといえば？", choices: ["味噌汁", "焼き魚", "サラダ", "納豆"] },
  { topic: "デザートといえば？", choices: ["プリン", "アイス", "ゼリー", "シュークリーム"] },
  { topic: "スポーツ観戦といえば？", choices: ["応援", "ユニフォーム", "実況", "歓声"] },
  { topic: "山登りといえば？", choices: ["頂上", "おにぎり", "リュック", "地図"] },
  { topic: "朝の飲み物といえば？", choices: ["コーヒー", "紅茶", "牛乳", "白湯"] },
  { topic: "電車の座席といえば？", choices: ["窓側", "通路側", "ドア付近", "どこでも"] },
  { topic: "お弁当のおかずといえば？", choices: ["卵焼き", "唐揚げ", "ウインナー", "ブロッコリー"] },
  { topic: "夏の虫といえば？", choices: ["セミ", "カブトムシ", "蚊", "ホタル"] },
  { topic: "冬の服装といえば？", choices: ["コート", "手袋", "マフラー", "耳あて"] },
  { topic: "パンの種類といえば？", choices: ["食パン", "クロワッサン", "メロンパン", "あんぱん"] },
  { topic: "雨の日の靴といえば？", choices: ["長靴", "スニーカー", "サンダル", "革靴"] },
  { topic: "お土産といえば？", choices: ["まんじゅう", "せんべい", "チョコレート", "キーホルダー"] },
  { topic: "部屋の照明といえば？", choices: ["明るいライト", "間接照明", "スタンドライト", "自然光"] },
  { topic: "休みの朝といえば？", choices: ["二度寝", "早起き", "朝食作り", "散歩"] },
  { topic: "公園といえば？", choices: ["ブランコ", "滑り台", "ベンチ", "噴水"] },
  { topic: "テレビ番組といえば？", choices: ["ニュース", "ドラマ", "バラエティ", "スポーツ中継"] },
  { topic: "仕事の休憩といえば？", choices: ["コーヒー", "甘いもの", "仮眠", "雑談"] },
  { topic: "川といえば？", choices: ["釣り", "川遊び", "バーベキュー", "水切り"] },
  { topic: "島といえば？", choices: ["沖縄本島", "佐渡島", "淡路島", "屋久島"] },
  { topic: "色といえば？", choices: ["赤", "青", "緑", "黄色"] },
  { topic: "数字といえば？", choices: ["7", "3", "1", "10"] },
  { topic: "楽器といえば？", choices: ["ピアノ", "ギター", "バイオリン", "ドラム"] },
  { topic: "文房具といえば？", choices: ["シャープペン", "ボールペン", "消しゴム", "ノート"] },
  { topic: "動物園といえば？", choices: ["パンダ", "ライオン", "ゾウ", "キリン"] },
  { topic: "水族館といえば？", choices: ["イルカショー", "大水槽", "ペンギン", "クラゲ"] },
  { topic: "図書館といえば？", choices: ["本棚", "静けさ", "貸出カード", "閲覧席"] },
  { topic: "梅雨といえば？", choices: ["あじさい", "てるてる坊主", "じめじめ", "洗濯物"] },
  { topic: "春といえば？", choices: ["桜", "新生活", "花粉", "たけのこ"] },
  { topic: "秋といえば？", choices: ["紅葉", "月見", "読書", "食欲"] },
  { topic: "冬の野菜といえば？", choices: ["白菜", "大根", "ねぎ", "ほうれん草"] },
  { topic: "野球といえば？", choices: ["ホームラン", "ピッチャー", "甲子園", "応援歌"] },
  { topic: "学校の行事といえば？", choices: ["文化祭", "体育祭", "修学旅行", "合唱コンクール"] },
  { topic: "お正月の料理といえば？", choices: ["お雑煮", "伊達巻", "栗きんとん", "黒豆"] },
  { topic: "遊園地の乗り物といえば？", choices: ["メリーゴーラウンド", "コーヒーカップ", "お化け屋敷", "ゴーカート"] },
  { topic: "朝食のパンといえば？", choices: ["トースト", "サンドイッチ", "ホットドッグ", "フレンチトースト"] },
  { topic: "携帯電話の機能といえば？", choices: ["カメラ", "地図", "目覚まし", "電卓"] },
  { topic: "飛行機といえば？", choices: ["機内食", "窓の景色", "離陸", "免税店"] },
  { topic: "ハロウィンといえば？", choices: ["かぼちゃ", "仮装", "お菓子", "コウモリ"] },
  { topic: "バレンタインといえば？", choices: ["チョコレート", "手作りチョコ", "義理チョコ", "告白"] },
  { topic: "七夕といえば？", choices: ["短冊", "織姫と彦星", "天の川", "笹"] },
  { topic: "ひな祭りといえば？", choices: ["ひな人形", "ちらし寿司", "ひなあられ", "桃の花"] },
  { topic: "こどもの日といえば？", choices: ["こいのぼり", "柏餅", "菖蒲湯", "兜"] },
  { topic: "母の日といえば？", choices: ["カーネーション", "手紙", "肩たたき券", "プレゼント"] },
  { topic: "スポーツといえば？", choices: ["サッカー", "野球", "テニス", "水泳"] },
  { topic: "都会といえば？", choices: ["高層ビル", "満員電車", "ネオン", "人混み"] },
  { topic: "田舎といえば？", choices: ["田んぼ", "星空", "セミの声", "ご近所づきあい"] },
  { topic: "朝といえば？", choices: ["目覚まし時計", "朝日", "新聞", "ラジオ体操"] },
  { topic: "夜といえば？", choices: ["月", "夜景", "夜更かし", "深夜のコンビニ"] },
  { topic: "音楽といえば？", choices: ["コンサート", "イヤホン", "楽譜", "カラオケ"] },
  { topic: "買い物といえば？", choices: ["セール", "エコバッグ", "ポイントカード", "ショーウィンドウ"] },
  { topic: "引っ越しといえば？", choices: ["段ボール", "引っ越しそば", "新居の鍵", "住所変更"] },
  { topic: "卒業といえば？", choices: ["卒業証書", "桜", "涙", "アルバム"] },
  { topic: "父の日といえば？", choices: ["ネクタイ", "ハンカチ", "お酒", "手紙"] },
  { topic: "キャンプといえば？", choices: ["テント", "焚き火", "バーベキュー", "星空"] },
  { topic: "映画館といえば？", choices: ["ポップコーン", "予告編", "指定席", "暗闇"] },
  { topic: "道の駅といえば？", choices: ["地元の野菜", "ソフトクリーム", "足湯", "スタンプ"] },
  { topic: "冬の鍋といえば？", choices: ["寄せ鍋", "キムチ鍋", "しゃぶしゃぶ", "すき焼き"] },
  { topic: "屋台といえば？", choices: ["焼きそば", "わたあめ", "チョコバナナ", "イカ焼き"] },
  { topic: "学校の昼休みといえば？", choices: ["ドッジボール", "図書室", "おしゃべり", "昼寝"] },
  { topic: "スーパーといえば？", choices: ["試食", "特売", "買い物かご", "ポイント"] },
  { topic: "秋の味覚といえば？", choices: ["栗", "さつまいも", "さんま", "松茸"] },
  { topic: "海水浴といえば？", choices: ["浮き輪", "ビーチパラソル", "砂のお城", "クラゲ"] },
];

export const MJ_TOTAL_QUESTIONS = 8;
export const MJ_TIME_LIMIT_MS = 20000;
export const MJ_REVEAL_MS = 5000;
export const MJ_POINTS_PER_VOTE = 10;

export type MjAnswer = { seat: number; choice: number };

export type MjResultEntry = {
  seat: number;
  /** 無回答は null。 */
  choice: number | null;
  gained: number;
};

export type MjHistoryEntry = {
  questionIndex: number;
  /** 選択肢ごとの得票数。 */
  tally: number[];
  /** 最多得票数。 */
  topVotes: number;
  results: MjResultEntry[];
};

export interface MajorityState {
  players: { seat: number; name: string }[];
  /** 退出した seat（脱落扱い・未回答として扱う）。 */
  leftSeats: number[];
  /** 出題デッキ（選択肢シャッフル済み）。 */
  questions: MjQuestion[];
  index: number;
  phase: MjPhase;
  /** 現在のお題の締切（epoch ms）。question フェーズ以外は null。 */
  questionEndsAt: number | null;
  /** 開示フェーズの終了時刻（epoch ms）。reveal 以外は null。 */
  revealEndsAt: number | null;
  /** 内部のみ。締切まで viewFor で秘匿する。 */
  answers: MjAnswer[];
  scores: Record<number, number>;
  history: MjHistoryEntry[];
}

export type MajorityAction = { type: "answer"; choice: number };

export interface MjViewPlayer {
  seat: number;
  name: string;
  score: number;
  left: boolean;
  answered: boolean;
  /** reveal / finished でのみ開示される回答（無回答は null）。それ以外はキー自体なし。 */
  choice?: number | null;
  gained?: number;
}

export interface MajorityView {
  phase: MjPhase;
  index: number;
  totalQuestions: number;
  questionEndsAt: number | null;
  revealEndsAt: number | null;
  /** 現在のお題（finished では null）。 */
  question: { topic: string; choices: string[] } | null;
  /** reveal / finished で開示される得票分布。それ以外は null。 */
  tally: number[] | null;
  /** reveal / finished での最多得票数。それ以外は null。 */
  topVotes: number | null;
  you: { seat: number; answered: boolean; yourChoice: number | null; left: boolean };
  players: MjViewPlayer[];
  /** finished 時の順位（同点は同順位）。それ以外は null。 */
  standings: { seat: number; score: number; rank: number }[] | null;
}

// ---------------------------------------------------------------- utilities

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 得点ルール: 最多得票の選択肢を選んだ人は「最多得票数 × 10点」。それ以外は 0。 */
export function mjScoreFor(choiceVotes: number, topVotes: number): number {
  if (topVotes <= 0) return 0;
  return choiceVotes === topVotes ? topVotes * MJ_POINTS_PER_VOTE : 0;
}

function playerOf(state: MajorityState, seat: number): { seat: number; name: string } | undefined {
  return state.players.find((p) => p.seat === seat);
}

function activeSeats(state: MajorityState): number[] {
  return state.players.filter((p) => !state.leftSeats.includes(p.seat)).map((p) => p.seat);
}

function shuffled<T>(items: T[], rng: Rng): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildDeck(rng: Rng): MjQuestion[] {
  const picked = shuffled(MAJORITY_QUESTIONS, rng).slice(0, MJ_TOTAL_QUESTIONS);
  return picked.map((q) => ({
    topic: q.topic,
    choices: shuffled(q.choices, rng),
  }));
}

/** 現在のお題を締め切り、集計して reveal へ移す（draft を破壊的に更新）。 */
function closeQuestion(draft: MajorityState, now: number): void {
  const q = draft.questions[draft.index];
  if (!q) return;
  const tally = new Array<number>(q.choices.length).fill(0);
  for (const ans of draft.answers) {
    if (draft.leftSeats.includes(ans.seat)) continue;
    if (ans.choice >= 0 && ans.choice < tally.length) tally[ans.choice]++;
  }
  const topVotes = tally.length > 0 ? Math.max(...tally) : 0;
  const results: MjResultEntry[] = draft.players.map((p) => {
    const ans = draft.answers.find((a) => a.seat === p.seat);
    const choice = ans && !draft.leftSeats.includes(p.seat) ? ans.choice : null;
    const gained = choice !== null ? mjScoreFor(tally[choice], topVotes) : 0;
    return { seat: p.seat, choice, gained };
  });
  for (const r of results) {
    draft.scores[r.seat] = (draft.scores[r.seat] ?? 0) + r.gained;
  }
  draft.history.push({ questionIndex: draft.index, tally, topVotes, results });
  draft.answers = [];
  draft.phase = "reveal";
  draft.questionEndsAt = null;
  draft.revealEndsAt = now + MJ_REVEAL_MS;
}

/** reveal を終えて次のお題へ進む（draft を破壊的に更新）。 */
function advance(draft: MajorityState, now: number): void {
  const next = draft.index + 1;
  draft.revealEndsAt = null;
  if (next >= draft.questions.length) {
    draft.index = next;
    draft.phase = "finished";
    return;
  }
  draft.index = next;
  draft.phase = "question";
  draft.questionEndsAt = now + MJ_TIME_LIMIT_MS;
}

/** 全員（脱落を除く）が回答済みなら即締切する。 */
function closeIfAllAnswered(draft: MajorityState, now: number): void {
  if (draft.phase !== "question") return;
  const active = activeSeats(draft);
  if (active.length === 0) return;
  if (active.every((s) => draft.answers.some((a) => a.seat === s))) closeQuestion(draft, now);
}

// ---------------------------------------------------------------- module

function createState(players: SeatInfo[], rng: Rng, _options: Record<string, unknown>): MajorityState {
  if (!Array.isArray(players) || players.length < 2 || players.length > 8) {
    throw new Error("多数決ゲームは2〜8人で遊ぶゲームです");
  }
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const scores: Record<number, number> = {};
  for (const p of sorted) scores[p.seat] = 0;
  return {
    players: sorted.map((p) => ({ seat: p.seat, name: p.name })),
    leftSeats: [],
    questions: buildDeck(rng),
    index: 0,
    phase: "question",
    questionEndsAt: Date.now() + MJ_TIME_LIMIT_MS,
    revealEndsAt: null,
    answers: [],
    scores,
    history: [],
  };
}

function applyAction(state: MajorityState, seat: number, action: MajorityAction, _rng: Rng): MajorityState {
  if (!action || typeof action !== "object" || (action as { type?: unknown }).type !== "answer") {
    throw new Error("不明なアクションです");
  }
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished") throw new Error("ゲームは終了しています");
  if (state.phase !== "question") throw new Error("今は回答できません");
  if (state.leftSeats.includes(seat)) throw new Error("退出したプレイヤーは回答できません");
  const choice = (action as { choice?: unknown }).choice;
  if (typeof choice !== "number" || !Number.isInteger(choice)) throw new Error("回答が不正です");
  const q = state.questions[state.index];
  if (!q || choice < 0 || choice >= q.choices.length) throw new Error("回答が不正です");
  if (state.answers.some((a) => a.seat === seat)) throw new Error("すでに回答しています");

  const now = Date.now();
  if (state.questionEndsAt !== null && now > state.questionEndsAt) {
    throw new Error("制限時間を過ぎています");
  }
  const draft = clone(state);
  draft.answers.push({ seat, choice });
  closeIfAllAnswered(draft, now);
  return draft;
}

function viewFor(state: MajorityState, seat: number): MajorityView {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  const finished = state.phase === "finished";
  const revealing = state.phase === "reveal" || finished;
  const lastHistory = state.history[state.history.length - 1];
  const revealForCurrent =
    revealing && lastHistory && lastHistory.questionIndex === (finished ? state.questions.length - 1 : state.index);

  const players: MjViewPlayer[] = state.players.map((p) => {
    const entry: MjViewPlayer = {
      seat: p.seat,
      name: p.name,
      score: state.scores[p.seat] ?? 0,
      left: state.leftSeats.includes(p.seat),
      answered:
        state.answers.some((a) => a.seat === p.seat) ||
        (revealing && lastHistory ? lastHistory.results.some((r) => r.seat === p.seat && r.choice !== null) : false),
    };
    if (revealForCurrent && lastHistory) {
      const r = lastHistory.results.find((x) => x.seat === p.seat);
      if (r) {
        entry.choice = r.choice;
        entry.gained = r.gained;
      }
    }
    return entry;
  });

  const q = state.questions[state.index];
  const question = !finished && q ? { topic: q.topic, choices: [...q.choices] } : null;
  const myAnswer = state.answers.find((a) => a.seat === seat);
  let yourChoice: number | null = myAnswer ? myAnswer.choice : null;
  if (yourChoice === null && revealForCurrent && lastHistory) {
    const r = lastHistory.results.find((x) => x.seat === seat);
    if (r) yourChoice = r.choice;
  }

  let standings: MajorityView["standings"] = null;
  if (finished) {
    const sorted = [...state.players].sort((a, b) => (state.scores[b.seat] ?? 0) - (state.scores[a.seat] ?? 0));
    standings = sorted.map((p) => ({
      seat: p.seat,
      score: state.scores[p.seat] ?? 0,
      rank: 1 + sorted.filter((o) => (state.scores[o.seat] ?? 0) > (state.scores[p.seat] ?? 0)).length,
    }));
  }

  return {
    phase: state.phase,
    index: Math.min(state.index, state.questions.length - 1),
    totalQuestions: state.questions.length,
    questionEndsAt: state.questionEndsAt,
    revealEndsAt: state.revealEndsAt,
    question,
    tally: revealForCurrent && lastHistory ? [...lastHistory.tally] : null,
    topVotes: revealForCurrent && lastHistory ? lastHistory.topVotes : null,
    you: {
      seat,
      answered: players.find((p) => p.seat === seat)?.answered ?? false,
      yourChoice,
      left: state.leftSeats.includes(seat),
    },
    players,
    standings,
  };
}

function parseAction(raw: unknown): MajorityAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.type !== "answer") return null;
  if (typeof rec.choice !== "number" || !Number.isInteger(rec.choice) || rec.choice < 0 || rec.choice > 3) return null;
  return { type: "answer", choice: rec.choice };
}

function onPlayerLeft(state: MajorityState, seat: number): MajorityState {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished" || state.leftSeats.includes(seat)) return state;
  const draft = clone(state);
  draft.leftSeats.push(seat);
  if (activeSeats(draft).length === 0) {
    draft.phase = "finished";
    draft.questionEndsAt = null;
    draft.revealEndsAt = null;
    return draft;
  }
  // 残り全員が回答済みなら締め切る。
  closeIfAllAnswered(draft, Date.now());
  return draft;
}

function tick(state: MajorityState, now: number): MajorityState {
  if (state.phase === "question" && state.questionEndsAt !== null && now >= state.questionEndsAt) {
    const draft = clone(state);
    closeQuestion(draft, now);
    return draft;
  }
  if (state.phase === "reveal" && state.revealEndsAt !== null && now >= state.revealEndsAt) {
    const draft = clone(state);
    advance(draft, now);
    return draft;
  }
  return state;
}

export const gameModule: OnlineGameModule<MajorityState, MajorityAction, MajorityView> = {
  id: "majority",
  title: "多数決ゲーム",
  minPlayers: 2,
  maxPlayers: 8,
  cpuSupported: false,
  chatEnabled: true,
  createState,
  applyAction,
  viewFor,
  parseAction,
  phaseOf: (state: MajorityState) => state.phase,
  isFinished: (state: MajorityState) => state.phase === "finished",
  onPlayerLeft,
  tick,
};
