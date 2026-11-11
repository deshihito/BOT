// クイズバトル（オンライン対戦）のルールモジュール。
// 基盤契約: import は type のみ（テストが import を剥がして連結する）。
// 状態は JSON 化可能な値だけ。applyAction / tick / onPlayerLeft は純関数。
// 流れ: question（15秒・全員回答か時間切れで締切）→ reveal（4秒・開示）→ 次の問題。全8問。
// 得点: 正解で 100 + 残り秒数（切り捨て）×2。不正解・無回答は0点。
// 回答内容は締切まで秘匿し、viewFor では「回答済みかどうか」だけを公開する。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export type QbPhase = "question" | "reveal" | "finished";

export type QbQuestion = {
  category: string;
  question: string;
  choices: string[];
  answer: number;
};

export const QUIZ_BATTLE_QUESTIONS: QbQuestion[] = [
  { category: "雑学", question: "日本の首都はどこ？", choices: ["東京", "京都", "大阪", "札幌"], answer: 0 },
  { category: "雑学", question: "1ダースは何個？", choices: ["12個", "10個", "20個", "6個"], answer: 0 },
  { category: "雑学", question: "ことわざ「石の上にも何年」？", choices: ["三年", "一年", "五年", "十年"], answer: 0 },
  { category: "雑学", question: "日本の国花として親しまれている花は？", choices: ["桜", "梅", "菊", "桃"], answer: 0 },
  { category: "科学", question: "地球に一番近い恒星は？", choices: ["太陽", "シリウス", "ベガ", "北極星"], answer: 0 },
  { category: "科学", question: "氷が水に浮く理由は、氷の方が水よりどうだから？", choices: ["軽い（密度が小さい）", "重い（密度が大きい）", "硬い", "冷たい"], answer: 0 },
  { category: "科学", question: "人間の体温は平熱でおよそ何度？", choices: ["約36度", "約32度", "約40度", "約28度"], answer: 0 },
  { category: "科学", question: "電池の＋と−を表す言葉は？", choices: ["電極（陽極・陰極）", "電圧と電流", "抵抗と絶縁", "磁石のN極とS極"], answer: 0 },
  { category: "歴史", question: "平安京に都を移した天皇は？", choices: ["桓武天皇", "聖武天皇", "天武天皇", "推古天皇"], answer: 0 },
  { category: "歴史", question: "大化の改新が始まった年は？", choices: ["645年", "710年", "794年", "1192年"], answer: 0 },
  { category: "歴史", question: "アメリカ独立宣言が出された年は？", choices: ["1776年", "1492年", "1865年", "1917年"], answer: 0 },
  { category: "歴史", question: "日本で鉄道が初めて開通した区間は新橋とどこ？", choices: ["横浜", "品川", "大宮", "上野"], answer: 0 },
  { category: "スポーツ", question: "サッカーのワールドカップは基本的に何年ごとに開催される？", choices: ["4年", "2年", "3年", "5年"], answer: 0 },
  { category: "スポーツ", question: "ゴルフで規定打数より1打少なくホールアウトすることを何という？", choices: ["バーディ", "イーグル", "ボギー", "パー"], answer: 0 },
  { category: "スポーツ", question: "大相撲の本場所は1年に何回ある？", choices: ["6回", "4回", "12回", "3回"], answer: 0 },
  { category: "スポーツ", question: "卓球のラケットに貼られたゴムの面を打つ部分を何という？", choices: ["ラバー面", "ブレード面", "グリップ面", "コート面"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『千と千尋の神隠し』で千尋が働くことになる湯屋の名前は？", choices: ["油屋", "湯屋本舗", "神の湯", "千湯"], answer: 0 },
  { category: "アニメ・ゲーム", question: "将棋で、相手の王を詰ませる一手を宣言する言葉は？", choices: ["詰み", "王手", "投了", "千日手"], answer: 0 },
  { category: "アニメ・ゲーム", question: "RPGでよくある略語「HP」は何の略？", choices: ["ヒットポイント", "ヒーローポイント", "ハイパワー", "ヒーリングポイント"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『スーパーマリオブラザーズ』でマリオが踏んで倒せる、キノコのような敵は？", choices: ["クリボー", "ノコノコ", "パックンフラワー", "クッパ"], answer: 0 },
  { category: "雑学", question: "十二支で一番最初の動物は？", choices: ["ねずみ（子）", "うし（丑）", "とら（寅）", "うさぎ（卯）"], answer: 0 },
  { category: "雑学", question: "虹は通常何色とされる？", choices: ["7色", "5色", "6色", "8色"], answer: 0 },
  { category: "雑学", question: "日本で一番面積が小さい都道府県は？", choices: ["香川県", "大阪府", "東京都", "沖縄県"], answer: 0 },
  { category: "雑学", question: "日本の国歌のタイトルは？", choices: ["君が代", "ふるさと", "日の丸", "日本賛歌"], answer: 0 },
  { category: "雑学", question: "「鶴は千年、亀は」何年？", choices: ["万年", "千年", "百年", "十年"], answer: 0 },
  { category: "雑学", question: "日本の都道府県で「府」は大阪府ともう1つ。もう1つは？", choices: ["京都府", "神奈川県", "愛知県", "福岡県"], answer: 0 },
  { category: "科学", question: "昆虫の足は何本？", choices: ["6本", "8本", "4本", "10本"], answer: 0 },
  { category: "科学", question: "地球の周りを回っている天体は？", choices: ["月", "金星", "火星", "太陽"], answer: 0 },
  { category: "科学", question: "1時間は何秒？", choices: ["3600秒", "360秒", "600秒", "3660秒"], answer: 0 },
  { category: "科学", question: "テレビのリモコンが信号を送るのに使う、目に見えない光は？", choices: ["赤外線", "紫外線", "X線", "可視光"], answer: 0 },
  { category: "科学", question: "パソコンの「CPU」の役割は？", choices: ["計算や処理の中心", "画面の表示専用", "データの保存専用", "通信専用"], answer: 0 },
  { category: "歴史", question: "世界で一番高い山は？", choices: ["エベレスト", "K2", "モンブラン", "富士山"], answer: 0 },
  { category: "歴史", question: "姫路城がある都道府県は？", choices: ["兵庫県", "京都府", "奈良県", "岡山県"], answer: 0 },
  { category: "スポーツ", question: "サッカーの試合時間は前後半合わせて通常何分？", choices: ["90分", "60分", "80分", "100分"], answer: 0 },
  { category: "スポーツ", question: "バスケットボールで遠い距離からのシュートが成功すると何点入る？", choices: ["3点", "2点", "4点", "5点"], answer: 0 },
  { category: "スポーツ", question: "チェスで、ゲーム開始時の最初の手だけ2マス進むことができる駒は？", choices: ["ポーン", "ルーク", "ナイト", "ビショップ"], answer: 0 },
  { category: "アニメ・ゲーム", question: "ドラえもんの大好物は？", choices: ["どら焼き", "たい焼き", "今川焼き", "大判焼き"], answer: 0 },
  { category: "アニメ・ゲーム", question: "ピアノの鍵盤は白鍵と黒鍵合わせて標準で何鍵？", choices: ["88鍵", "76鍵", "96鍵", "108鍵"], answer: 0 },
  { category: "雑学", question: "日本の硬貨のうち、真ん中に穴が開いているのは5円玉ともう1つは？", choices: ["50円玉", "100円玉", "10円玉", "500円玉"], answer: 0 },
  { category: "雑学", question: "1週間は全部で何時間？", choices: ["168時間", "144時間", "120時間", "200時間"], answer: 0 },
  { category: "雑学", question: "2024年に発行された新千円札の肖像は誰？", choices: ["北里柴三郎", "野口英世", "福沢諭吉", "樋口一葉"], answer: 0 },
  { category: "科学", question: "水の化学式は？", choices: ["H2O", "CO2", "O2", "H2SO4"], answer: 0 },
  { category: "科学", question: "空気の約78%を占める気体は？", choices: ["窒素", "酸素", "二酸化炭素", "アルゴン"], answer: 0 },
  { category: "科学", question: "血液の中で酸素を運ぶ赤い色素は？", choices: ["ヘモグロビン", "メラニン", "クロロフィル", "インスリン"], answer: 0 },
  { category: "科学", question: "空気中（気温15度）で音が進む速さはおよそ秒速何メートル？", choices: ["約340メートル", "約150メートル", "約1000メートル", "約30メートル"], answer: 0 },
  { category: "歴史", question: "江戸幕府を開いた人物は？", choices: ["徳川家康", "織田信長", "豊臣秀吉", "源頼朝"], answer: 0 },
  { category: "歴史", question: "人類で初めて月面に着陸した宇宙船は？", choices: ["アポロ11号", "スプートニク1号", "ボストーク1号", "アポロ13号"], answer: 0 },
  { category: "歴史", question: "日本国憲法が施行されたのは何年？", choices: ["1947年", "1945年", "1889年", "1964年"], answer: 0 },
  { category: "歴史", question: "「天下布武」の印を使った戦国武将は？", choices: ["織田信長", "武田信玄", "上杉謙信", "伊達政宗"], answer: 0 },
  { category: "スポーツ", question: "フルマラソンの距離はおよそ何km？", choices: ["約42km", "約30km", "約50km", "約26km"], answer: 0 },
  { category: "スポーツ", question: "テニスで、相手に1点も取らせずにゲームを取ることを何という？", choices: ["ラブゲーム", "デュース", "タイブレーク", "マッチポイント"], answer: 0 },
  { category: "スポーツ", question: "バレーボールで、ネット越しにボールを強く打ち込む攻撃を何という？", choices: ["スパイク", "サーブ", "レシーブ", "トス"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『ドラゴンクエスト』でおなじみの、青くてぷるぷるしたモンスターは？", choices: ["スライム", "ゴブリン", "オーク", "ガーゴイル"], answer: 0 },
  { category: "アニメ・ゲーム", question: "アニメ『サザエさん』で、主人公サザエの夫の名前は？", choices: ["マスオ", "カツオ", "タラオ", "ノリスケ"], answer: 0 },
  { category: "アニメ・ゲーム", question: "ボードゲーム「オセロ（リバーシ）」で、最初に置かれている石は何個？", choices: ["4個", "2個", "6個", "8個"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『Minecraft』で、近づくと爆発する緑色のモンスターは？", choices: ["クリーパー", "エンダーマン", "ゾンビ", "スケルトン"], answer: 0 },
  { category: "雑学", question: "日本の元号で、令和の1つ前は？", choices: ["平成", "昭和", "大正", "明治"], answer: 0 },
  { category: "雑学", question: "1円玉の材料は？", choices: ["アルミニウム", "鉄", "銅", "ニッケル"], answer: 0 },
  { category: "雑学", question: "ことわざ「猿も木から」どうする？", choices: ["落ちる", "滑る", "転ぶ", "降りる"], answer: 0 },
  { category: "科学", question: "植物が光合成で吸収する気体は？", choices: ["二酸化炭素", "酸素", "窒素", "水素"], answer: 0 },
  { category: "科学", question: "人間の体の中で一番大きな臓器は？", choices: ["皮膚", "肝臓", "心臓", "肺"], answer: 0 },
  { category: "科学", question: "磁石の同じ極同士（N極とN極）を近づけるとどうなる？", choices: ["反発する", "引き合う", "くっつく", "回転する"], answer: 0 },
  { category: "歴史", question: "鎌倉幕府を開いた人物は？", choices: ["源頼朝", "源義経", "平清盛", "足利尊氏"], answer: 0 },
  { category: "歴史", question: "日本で最初の女性天皇は？", choices: ["推古天皇", "持統天皇", "光明皇后", "卑弥呼"], answer: 0 },
  { category: "歴史", question: "ライト兄弟が初飛行に成功した乗り物は？", choices: ["飛行機", "気球", "グライダー", "ヘリコプター"], answer: 0 },
  { category: "スポーツ", question: "バドミントンで打ち合う、羽のついた球の名前は？", choices: ["シャトル", "バード", "フェザー", "ウィング"], answer: 0 },
  { category: "スポーツ", question: "100m走の世界記録保持者ウサイン・ボルトの出身国は？", choices: ["ジャマイカ", "アメリカ", "ケニア", "イギリス"], answer: 0 },
  { category: "スポーツ", question: "剣道で使う竹製の刀を何という？", choices: ["竹刀", "木刀", "模擬刀", "竹剣"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『ポケットモンスター』でピカチュウのタイプは？", choices: ["でんき", "ほのお", "みず", "くさ"], answer: 0 },
  { category: "アニメ・ゲーム", question: "トランプ1組は、ジョーカーを除くと何枚？", choices: ["52枚", "48枚", "54枚", "40枚"], answer: 0 },
  { category: "雑学", question: "日本の国鳥は？", choices: ["キジ", "ハト", "ツル", "コウノトリ"], answer: 0 },
  { category: "雑学", question: "「一富士二鷹三茄子」は何の夢のこと？", choices: ["初夢", "大晦日の夢", "昼寝の夢", "予知夢"], answer: 0 },
  { category: "雑学", question: "日本で一番長い川は？", choices: ["信濃川", "利根川", "石狩川", "淀川"], answer: 0 },
  { category: "科学", question: "地球から月までの距離はおよそ何km？", choices: ["約38万km", "約4万km", "約150万km", "約1000km"], answer: 0 },
  { category: "科学", question: "太陽系で一番大きい惑星は？", choices: ["木星", "土星", "海王星", "地球"], answer: 0 },
  { category: "科学", question: "単3形の乾電池の電圧はおよそ何ボルト？", choices: ["1.5ボルト", "3ボルト", "9ボルト", "100ボルト"], answer: 0 },
  { category: "歴史", question: "ペリーが黒船で来航したのは何年？", choices: ["1853年", "1600年", "1868年", "1945年"], answer: 0 },
  { category: "歴史", question: "『解体新書』を翻訳した人物は？", choices: ["杉田玄白", "福沢諭吉", "新渡戸稲造", "野口英世"], answer: 0 },
  { category: "歴史", question: "フランス革命が始まった年は？", choices: ["1789年", "1776年", "1689年", "1917年"], answer: 0 },
  { category: "スポーツ", question: "野球で、塁に出た走者が次の塁を狙って走ることを何という？", choices: ["盗塁", "犠打", "併殺", "死球"], answer: 0 },
  { category: "スポーツ", question: "オリンピックの金メダルの主な材料は？", choices: ["銀", "金", "銅", "プラチナ"], answer: 0 },
  { category: "スポーツ", question: "サッカーで、重大な反則をした選手に出される退場のカードは？", choices: ["レッドカード", "イエローカード", "グリーンカード", "ブルーカード"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『ドラゴンボール』で孫悟空が育った山の名前は？", choices: ["パオズ山", "カリン塔", "神様の神殿", "界王星"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『テトリス』で一度に4列消すことを何という？", choices: ["テトリス", "コンボ", "Tスピン", "パーフェクト"], answer: 0 },
  { category: "雑学", question: "手紙を送るときに切手を貼るのは、封筒のどの位置？", choices: ["右上", "左上", "右下", "真ん中"], answer: 0 },
  { category: "雑学", question: "祝日と日曜日が重なったときに、翌日が休みになる制度は？", choices: ["振替休日", "国民の休日", "臨時休日", "代休日"], answer: 0 },
  { category: "雑学", question: "日本の郵便ポストの色は一般的に何色？", choices: ["赤", "青", "緑", "黄色"], answer: 0 },
  { category: "科学", question: "人間の成人の骨はおよそ何本？", choices: ["約206本", "約106本", "約306本", "約406本"], answer: 0 },
  { category: "科学", question: "地球が自転で1回転するのにかかる時間はおよそ何時間？", choices: ["約24時間", "約12時間", "約36時間", "約48時間"], answer: 0 },
  { category: "科学", question: "雷で、光が見えてから音が聞こえるまで時間差があるのは、音より光の方がどうだから？", choices: ["速い", "遅い", "重い", "大きい"], answer: 0 },
  { category: "歴史", question: "江戸時代に参勤交代を制度化した将軍は？", choices: ["徳川家光", "徳川家康", "徳川吉宗", "徳川綱吉"], answer: 0 },
  { category: "歴史", question: "「維新の三傑」の一人、西郷隆盛の出身の藩は？", choices: ["薩摩藩", "長州藩", "土佐藩", "肥前藩"], answer: 0 },
  { category: "歴史", question: "第二次世界大戦が終わった年は？", choices: ["1945年", "1918年", "1939年", "1950年"], answer: 0 },
  { category: "スポーツ", question: "野球で、1試合は通常何回まで？", choices: ["9回", "7回", "10回", "12回"], answer: 0 },
  { category: "スポーツ", question: "柔道で、相手を投げる技の総称は？", choices: ["投げ技", "固め技", "締め技", "寝技"], answer: 0 },
  { category: "スポーツ", question: "ボウリングで、1投目で10本全てのピンを倒すことを何という？", choices: ["ストライク", "スペア", "ガター", "ターキー"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『名探偵コナン』の主人公・江戸川コナンの本当の姿は？", choices: ["工藤新一", "服部平次", "怪盗キッド", "毛利小五郎"], answer: 0 },
  { category: "アニメ・ゲーム", question: "将棋の駒で、成ると「龍王」になる駒は？", choices: ["飛車", "角行", "金将", "香車"], answer: 0 },
];

export const QB_TOTAL_QUESTIONS = 8;
export const QB_TIME_LIMIT_MS = 15000;
export const QB_REVEAL_MS = 4000;
export const QB_BASE_SCORE = 100;
export const QB_SPEED_BONUS_PER_SEC = 2;

export type QbAnswer = { seat: number; choice: number; atMs: number };

export type QbResultEntry = {
  seat: number;
  /** 無回答は null。 */
  choice: number | null;
  correct: boolean;
  gained: number;
};

export type QbHistoryEntry = {
  questionIndex: number;
  correctChoice: number;
  results: QbResultEntry[];
};

export interface QuizBattleState {
  players: { seat: number; name: string }[];
  /** 退出した seat（脱落扱い）。 */
  leftSeats: number[];
  /** 出題デッキ（選択肢シャッフル済み）。 */
  questions: QbQuestion[];
  index: number;
  phase: QbPhase;
  /** 現在の問題の締切（epoch ms）。question フェーズ以外は null。 */
  questionEndsAt: number | null;
  /** 開示フェーズの終了時刻（epoch ms）。reveal 以外は null。 */
  revealEndsAt: number | null;
  /** 内部のみ。締切まで viewFor で秘匿する。 */
  answers: QbAnswer[];
  scores: Record<number, number>;
  history: QbHistoryEntry[];
}

export type QuizBattleAction = { type: "answer"; choice: number };

export interface QbViewPlayer {
  seat: number;
  name: string;
  score: number;
  left: boolean;
  answered: boolean;
  /** reveal / finished でのみ開示される回答（無回答は null）。それ以外はキー自体なし。 */
  choice?: number | null;
  correct?: boolean;
  gained?: number;
}

export interface QuizBattleView {
  phase: QbPhase;
  index: number;
  totalQuestions: number;
  questionEndsAt: number | null;
  revealEndsAt: number | null;
  /** 現在の問題（answer は含まない）。finished では null。 */
  question: { category: string; question: string; choices: string[] } | null;
  /** reveal / finished で開示される正解の位置。 */
  correctChoice: number | null;
  you: { seat: number; answered: boolean; yourChoice: number | null; left: boolean };
  players: QbViewPlayer[];
  /** finished 時の順位（同点は同順位）。それ以外は null。 */
  standings: { seat: number; score: number; rank: number }[] | null;
}

// ---------------------------------------------------------------- utilities

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 正解時の得点。残り時間（ms）から秒を切り捨ててボーナスを加える。 */
export function qbScoreFor(remainingMs: number): number {
  const sec = Math.max(0, Math.floor(remainingMs / 1000));
  return QB_BASE_SCORE + sec * QB_SPEED_BONUS_PER_SEC;
}

function playerOf(state: QuizBattleState, seat: number): { seat: number; name: string } | undefined {
  return state.players.find((p) => p.seat === seat);
}

function activeSeats(state: QuizBattleState): number[] {
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

function buildDeck(rng: Rng): QbQuestion[] {
  const picked = shuffled(QUIZ_BATTLE_QUESTIONS, rng).slice(0, QB_TOTAL_QUESTIONS);
  return picked.map((q) => {
    const order = shuffled(q.choices.map((_, i) => i), rng);
    return {
      category: q.category,
      question: q.question,
      choices: order.map((i) => q.choices[i]),
      answer: order.indexOf(q.answer),
    };
  });
}

/** 現在の問題を締め切り、採点して reveal へ移す（draft を破壊的に更新）。 */
function closeQuestion(draft: QuizBattleState, now: number): void {
  const q = draft.questions[draft.index];
  if (!q) return;
  const endsAt = draft.questionEndsAt ?? now;
  const results: QbResultEntry[] = draft.players.map((p) => {
    const ans = draft.answers.find((a) => a.seat === p.seat);
    const choice = ans ? ans.choice : null;
    const correct = choice !== null && choice === q.answer;
    // 脱落したプレイヤーの回答は得点に数えない。
    const gained = correct && !draft.leftSeats.includes(p.seat) ? qbScoreFor(endsAt - (ans ? ans.atMs : now)) : 0;
    return { seat: p.seat, choice, correct, gained };
  });
  for (const r of results) {
    draft.scores[r.seat] = (draft.scores[r.seat] ?? 0) + r.gained;
  }
  draft.history.push({ questionIndex: draft.index, correctChoice: q.answer, results });
  draft.answers = [];
  draft.phase = "reveal";
  draft.questionEndsAt = null;
  draft.revealEndsAt = now + QB_REVEAL_MS;
}

/** reveal を終えて次の問題へ進む（draft を破壊的に更新）。 */
function advance(draft: QuizBattleState, now: number): void {
  const next = draft.index + 1;
  draft.revealEndsAt = null;
  if (next >= draft.questions.length) {
    draft.index = next;
    draft.phase = "finished";
    return;
  }
  draft.index = next;
  draft.phase = "question";
  draft.questionEndsAt = now + QB_TIME_LIMIT_MS;
}

/** 全員（脱落を除く）が回答済みなら即締切する。 */
function closeIfAllAnswered(draft: QuizBattleState, now: number): void {
  if (draft.phase !== "question") return;
  const active = activeSeats(draft);
  if (active.length === 0) return;
  if (active.every((s) => draft.answers.some((a) => a.seat === s))) closeQuestion(draft, now);
}

// ---------------------------------------------------------------- module

function createState(players: SeatInfo[], rng: Rng, _options: Record<string, unknown>): QuizBattleState {
  if (!Array.isArray(players) || players.length < 2 || players.length > 4) {
    throw new Error("クイズバトルは2〜4人で遊ぶゲームです");
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
    questionEndsAt: Date.now() + QB_TIME_LIMIT_MS,
    revealEndsAt: null,
    answers: [],
    scores,
    history: [],
  };
}

function applyAction(state: QuizBattleState, seat: number, action: QuizBattleAction, _rng: Rng): QuizBattleState {
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
  draft.answers.push({ seat, choice, atMs: now });
  closeIfAllAnswered(draft, now);
  return draft;
}

function viewFor(state: QuizBattleState, seat: number): QuizBattleView {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  const finished = state.phase === "finished";
  const revealing = state.phase === "reveal" || finished;
  const lastHistory = state.history[state.history.length - 1];
  const revealForCurrent = revealing && lastHistory && lastHistory.questionIndex === (finished ? state.questions.length - 1 : state.index);

  const players: QbViewPlayer[] = state.players.map((p) => {
    const entry: QbViewPlayer = {
      seat: p.seat,
      name: p.name,
      score: state.scores[p.seat] ?? 0,
      left: state.leftSeats.includes(p.seat),
      answered: state.answers.some((a) => a.seat === p.seat) ||
        (revealing && lastHistory ? lastHistory.results.some((r) => r.seat === p.seat && r.choice !== null) : false),
    };
    if (revealForCurrent && lastHistory) {
      const r = lastHistory.results.find((x) => x.seat === p.seat);
      if (r) {
        entry.choice = r.choice;
        entry.correct = r.correct;
        entry.gained = r.gained;
      }
    }
    return entry;
  });

  const q = state.questions[state.index];
  const question = !finished && q ? { category: q.category, question: q.question, choices: [...q.choices] } : null;
  const myAnswer = state.answers.find((a) => a.seat === seat);
  let yourChoice: number | null = myAnswer ? myAnswer.choice : null;
  if (yourChoice === null && revealForCurrent && lastHistory) {
    const r = lastHistory.results.find((x) => x.seat === seat);
    if (r) yourChoice = r.choice;
  }

  let standings: QuizBattleView["standings"] = null;
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
    correctChoice: revealForCurrent && lastHistory ? lastHistory.correctChoice : null,
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

function parseAction(raw: unknown): QuizBattleAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.type !== "answer") return null;
  if (typeof rec.choice !== "number" || !Number.isInteger(rec.choice) || rec.choice < 0 || rec.choice > 3) return null;
  return { type: "answer", choice: rec.choice };
}

function onPlayerLeft(state: QuizBattleState, seat: number): QuizBattleState {
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

function tick(state: QuizBattleState, now: number): QuizBattleState {
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

export const gameModule: OnlineGameModule<QuizBattleState, QuizBattleAction, QuizBattleView> = {
  id: "quizbattle",
  title: "クイズバトル",
  minPlayers: 2,
  maxPlayers: 4,
  cpuSupported: false,
  chatEnabled: true,
  createState,
  applyAction,
  viewFor,
  parseAction,
  phaseOf: (state: QuizBattleState) => state.phase,
  isFinished: (state: QuizBattleState) => state.phase === "finished",
  onPlayerLeft,
  tick,
};
