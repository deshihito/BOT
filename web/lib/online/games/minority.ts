// 少数決ゲーム（オンライン対戦）のルールモジュール。
// 基盤契約: import は type のみ（テストが import を剥がして連結する）。
// 状態は JSON 化可能な値だけ。applyAction / tick / onPlayerLeft は純関数。
// 流れ: question（15秒・全員回答か時間切れで締切）→ reveal（5秒・票数と脱落者を開示）→ 次のお題。
// 生存ルール（締切時の集計）:
// - 票が両方の選択肢に入っていて票数に差がある場合、そのラウンドの少数派を選んだ人だけが残り、
//   多数派を選んだ人は脱落する。
// - 票が同数の場合、または片方の選択肢にしか票が入らなかった場合（少数派が存在しない）は、
//   回答した全員が残る。
// - 回答しなかった人は脱落する。ただし全員が無回答だった場合は例外として全員残る。
// - 退出した人は脱落扱いで、票にも数えない。
// 終了条件: ラウンドの結果、生存者が2人以下になったらその生存者が優勝で終了。
// ラウンド上限（10ラウンド）に達しても決着しなければ、その時点の生存者全員が優勝。
import type { OnlineGameModule, Rng, SeatInfo } from "../types";

export type MnPhase = "question" | "reveal" | "finished";

export interface MnQuestion {
  topic: string;
  choices: [string, string];
}

export const MINORITY_QUESTIONS: MnQuestion[] = [
  { topic: "休みの日はどっち？", choices: ["家でゆっくり", "外に出かける"] },
  { topic: "旅行に行くならどっち？", choices: ["海", "山"] },
  { topic: "主食はどっち派？", choices: ["ごはん", "パン"] },
  { topic: "ペットにするならどっち？", choices: ["犬", "猫"] },
  { topic: "好きな季節はどっち？", choices: ["夏", "冬"] },
  { topic: "生活リズムはどっち？", choices: ["朝型", "夜型"] },
  { topic: "休日の過ごし方はどっち？", choices: ["インドア", "アウトドア"] },
  { topic: "住むならどっち？", choices: ["都市", "田舎"] },
  { topic: "移動手段はどっち？", choices: ["電車", "車"] },
  { topic: "映画を見るならどっち？", choices: ["映画館", "家で配信"] },
  { topic: "支払いはどっち？", choices: ["現金", "キャッシュレス"] },
  { topic: "連絡はどっち？", choices: ["電話", "メッセージ"] },
  { topic: "一日の終わりはどっち？", choices: ["お風呂", "シャワー"] },
  { topic: "暇つぶしはどっち？", choices: ["読書", "動画"] },
  { topic: "麺はどっち？", choices: ["ラーメン", "うどん"] },
  { topic: "温かい飲み物はどっち？", choices: ["コーヒー", "紅茶"] },
  { topic: "飛行機の席はどっち？", choices: ["窓側", "通路側"] },
  { topic: "旅行のスタイルはどっち？", choices: ["計画派", "ノリ派"] },
  { topic: "味噌汁の具はどっち？", choices: ["豆腐", "わかめ"] },
  { topic: "目玉焼きにかけるのはどっち？", choices: ["醤油", "ソース"] },
  { topic: "パスタはどっち？", choices: ["トマト系", "クリーム系"] },
  { topic: "おでんの具はどっち？", choices: ["大根", "卵"] },
  { topic: "寝る姿勢はどっち？", choices: ["あおむけ", "横向き"] },
  { topic: "買い物はどっち？", choices: ["ネット", "実店舗"] },
  { topic: "勉強するならどっち？", choices: ["音楽あり", "静かな場所"] },
  { topic: "夏の必需品はどっち？", choices: ["扇風機", "エアコン"] },
  { topic: "写真はどっちで撮る？", choices: ["スマホ", "カメラ"] },
  { topic: "歯磨きはどっち？", choices: ["朝食前", "朝食後"] },
  { topic: "カラオケで歌うのはどっち？", choices: ["バラード", "アップテンポ"] },
  { topic: "ゲームはどっち？", choices: ["アクション", "パズル"] },
  { topic: "読むならどっち？", choices: ["紙の本", "電子書籍"] },
  { topic: "信号待ちのときはどっち？", choices: ["スマホを見る", "ぼーっとする"] },
  { topic: "甘いものはどっち？", choices: ["和菓子", "洋菓子"] },
  { topic: "休日の起床はどっち？", choices: ["早起き", "昼まで寝る"] },
  { topic: "メッセージの返信はどっち？", choices: ["すぐ返す", "まとめて返す"] },
  { topic: "旅行の荷物はどっち？", choices: ["少なめ", "多め"] },
  { topic: "写真の保存はどっち？", choices: ["クラウド", "端末の中"] },
  { topic: "映画の言語はどっち？", choices: ["字幕", "吹替"] },
  { topic: "部屋の温度はどっち？", choices: ["涼しめ", "暖かめ"] },
  { topic: "宿題はどっち？", choices: ["先に終わらせる", "ギリギリにやる"] },
  { topic: "食事はどっち？", choices: ["手作り", "外食"] },
  { topic: "電車ではどっち？", choices: ["座る", "立つ"] },
  { topic: "髪型はどっち？", choices: ["短め", "長め"] },
  { topic: "買い物の決め方はどっち？", choices: ["即決", "じっくり比較"] },
  { topic: "朝の準備はどっち？", choices: ["前日に用意", "朝に用意"] },
  { topic: "カレーに合わせるのはどっち？", choices: ["白ごはん", "ナン"] },
  { topic: "うどんはどっち？", choices: ["温かい", "冷たい"] },
  { topic: "お風呂の温度はどっち？", choices: ["熱め", "ぬるめ"] },
  { topic: "映画館の席はどっち？", choices: ["前方", "後方"] },
  { topic: "カラオケはどっち？", choices: ["一人カラオケ", "みんなでカラオケ"] },
  { topic: "洗濯物はどっち？", choices: ["外干し", "部屋干し"] },
  { topic: "目覚ましアラームはどっち？", choices: ["一回だけ", "スヌーズ何回も"] },
  { topic: "旅行先はどっち？", choices: ["国内", "海外"] },
  { topic: "スマホの文字入力はどっち？", choices: ["フリック入力", "キーボード入力"] },
  { topic: "ごはんのお供はどっち？", choices: ["漬物", "ふりかけ"] },
  { topic: "お好み焼きはどっち？", choices: ["広島風", "関西風"] },
  { topic: "お米の硬さはどっち？", choices: ["硬め", "柔らかめ"] },
  { topic: "部屋の明かりはどっち？", choices: ["白い光", "暖かい光"] },
  { topic: "年賀状はどっち？", choices: ["紙ではがき", "メッセージで済ます"] },
  { topic: "財布はどっち？", choices: ["長財布", "二つ折り"] },
  { topic: "映画館のポップコーンはどっち？", choices: ["塩味", "キャラメル味"] },
  { topic: "洗濯する時間はどっち？", choices: ["朝", "夜"] },
  { topic: "サウナはどっち？", choices: ["入る派", "入らない派"] },
  { topic: "お風呂に入るのはどっち？", choices: ["夕食の前", "夕食の後"] },
  { topic: "置き時計はどっち？", choices: ["アナログ", "デジタル"] },
  { topic: "目玉焼きはどっち？", choices: ["半熟", "固焼き"] },
  { topic: "納豆はどっち？", choices: ["よく混ぜる", "あまり混ぜない"] },
  { topic: "焼き魚の皮はどっち？", choices: ["食べる", "残す"] },
  { topic: "プリンはどっち？", choices: ["固め", "なめらか"] },
  { topic: "寝る場所はどっち？", choices: ["ベッド", "布団"] },
  { topic: "年賀状の宛名はどっち？", choices: ["手書き", "印刷"] },
  { topic: "本を読む場所はどっち？", choices: ["電車の中", "家の中"] },
  { topic: "靴下はどっち？", choices: ["長め", "短め"] },
  { topic: "うどんの薬味はどっち？", choices: ["ねぎ", "しょうが"] },
  { topic: "コンビニおにぎりはどっち？", choices: ["温める", "温めない"] },
];

export const MN_TIME_LIMIT_MS = 15000;
export const MN_REVEAL_MS = 5000;
export const MN_MAX_ROUNDS = 10;

export type MnAnswer = { seat: number; choice: number };

export interface MnHistoryEntry {
  questionIndex: number;
  /** 選択肢ごとの得票数 [選択肢0, 選択肢1]。 */
  tally: [number, number];
  /** このラウンドで脱落した seat。 */
  eliminatedSeats: number[];
  /** このラウンドの結果残った seat。 */
  survivorSeats: number[];
  /** 各プレイヤーの回答（無回答・退出は null）。 */
  answers: { seat: number; choice: number | null }[];
}

export interface MinorityState {
  players: { seat: number; name: string }[];
  leftSeats: number[];
  /** seat → 脱落したラウンド index（退出も含む）。 */
  eliminatedRound: Record<number, number>;
  questions: MnQuestion[];
  index: number;
  phase: MnPhase;
  questionEndsAt: number | null;
  revealEndsAt: number | null;
  /** 内部のみ。締切まで viewFor で秘匿する。 */
  answers: MnAnswer[];
  history: MnHistoryEntry[];
  /** 優勝者（終了時に確定）。それ以外は null。 */
  winners: number[] | null;
}

export type MinorityAction = { type: "answer"; choice: number };

export interface MnViewPlayer {
  seat: number;
  name: string;
  alive: boolean;
  left: boolean;
  answered: boolean;
  /** reveal / finished でのみ開示される回答（無回答は null）。それ以外はキー自体なし。 */
  choice?: number | null;
  /** reveal 中、そのラウンドで脱落したかどうか。 */
  eliminatedThisRound?: boolean;
}

export interface MinorityView {
  phase: MnPhase;
  /** 現在のラウンド番号（1始まり）。 */
  round: number;
  maxRounds: number;
  questionEndsAt: number | null;
  revealEndsAt: number | null;
  question: MnQuestion | null;
  /** reveal / finished で開示される票数。それ以外は null。 */
  tally: [number, number] | null;
  /** reveal 中に脱落した seat。それ以外は null。 */
  lastEliminated: number[] | null;
  you: {
    seat: number;
    alive: boolean;
    answered: boolean;
    yourChoice: number | null;
    left: boolean;
  };
  players: MnViewPlayer[];
  winners: number[] | null;
  /** finished 時の順位（優勝者は1位、同ラウンド脱落は同順位）。それ以外は null。 */
  standings: { seat: number; rank: number; winner: boolean }[] | null;
}

// ---------------------------------------------------------------- utilities

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function playerOf(state: MinorityState, seat: number): { seat: number; name: string } | undefined {
  return state.players.find((p) => p.seat === seat);
}

/** 生存中の seat（退出・脱落していない）。 */
function aliveSeats(state: MinorityState): number[] {
  return state.players
    .filter((p) => !state.leftSeats.includes(p.seat) && state.eliminatedRound[p.seat] === undefined)
    .map((p) => p.seat);
}

function shuffled<T>(items: T[], rng: Rng): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildDeck(rng: Rng): MnQuestion[] {
  const picked = shuffled(MINORITY_QUESTIONS, rng).slice(0, MN_MAX_ROUNDS);
  return picked.map((q) => {
    const flip = rng() < 0.5;
    return { topic: q.topic, choices: flip ? [q.choices[1], q.choices[0]] : [...q.choices] as [string, string] };
  });
}

/** 現在のお題を締め切り、生存者を決めて reveal へ移す（draft を破壊的に更新）。 */
function closeRound(draft: MinorityState, now: number): void {
  const alive = aliveSeats(draft);
  const answered = draft.answers.filter((a) => alive.includes(a.seat));
  const tally: [number, number] = [0, 0];
  for (const a of answered) {
    if (a.choice === 0 || a.choice === 1) tally[a.choice]++;
  }

  let survivors: number[];
  if (answered.length === 0) {
    // 全員無回答のときだけは例外として全員残る。
    survivors = [...alive];
  } else if (tally[0] === tally[1] || tally[0] === 0 || tally[1] === 0) {
    // 同数、または片方にしか票がない（少数派が存在しない）→ 回答者全員が残る。
    survivors = answered.map((a) => a.seat);
  } else {
    const minorityChoice = tally[0] < tally[1] ? 0 : 1;
    survivors = answered.filter((a) => a.choice === minorityChoice).map((a) => a.seat);
  }

  const eliminatedSeats = alive.filter((s) => !survivors.includes(s));
  for (const s of eliminatedSeats) draft.eliminatedRound[s] = draft.index;
  draft.history.push({
    questionIndex: draft.index,
    tally,
    eliminatedSeats,
    survivorSeats: survivors,
    answers: draft.players.map((p) => {
      const a = draft.answers.find((x) => x.seat === p.seat);
      return { seat: p.seat, choice: a && alive.includes(p.seat) ? a.choice : null };
    }),
  });
  draft.answers = [];
  if (survivors.length <= 2 || draft.index + 1 >= MN_MAX_ROUNDS) {
    draft.winners = survivors;
  }
  draft.phase = "reveal";
  draft.questionEndsAt = null;
  draft.revealEndsAt = now + MN_REVEAL_MS;
}

/** reveal を終える（draft を破壊的に更新）。優勝者がいれば finished、なければ次のお題へ。 */
function advance(draft: MinorityState, now: number): void {
  draft.revealEndsAt = null;
  const alive = aliveSeats(draft);
  if (draft.winners === null && alive.length <= 2) {
    // reveal 中の退出などで生存者が2人以下になった場合も、ここで優勝を確定する。
    draft.winners = alive;
  }
  if (draft.winners !== null) {
    draft.phase = "finished";
    return;
  }
  draft.index += 1;
  draft.phase = "question";
  draft.questionEndsAt = now + MN_TIME_LIMIT_MS;
}

/** 生存者全員が回答済みなら即締切する。 */
function closeIfAllAnswered(draft: MinorityState, now: number): void {
  if (draft.phase !== "question") return;
  const alive = aliveSeats(draft);
  if (alive.length === 0) return;
  if (alive.every((s) => draft.answers.some((a) => a.seat === s))) closeRound(draft, now);
}

// ---------------------------------------------------------------- module

function createState(players: SeatInfo[], rng: Rng, _options: Record<string, unknown>): MinorityState {
  if (!Array.isArray(players) || players.length < 3 || players.length > 8) {
    throw new Error("少数決ゲームは3〜8人で遊ぶゲームです");
  }
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  return {
    players: sorted.map((p) => ({ seat: p.seat, name: p.name })),
    leftSeats: [],
    eliminatedRound: {},
    questions: buildDeck(rng),
    index: 0,
    phase: "question",
    questionEndsAt: Date.now() + MN_TIME_LIMIT_MS,
    revealEndsAt: null,
    answers: [],
    history: [],
    winners: null,
  };
}

function applyAction(state: MinorityState, seat: number, action: MinorityAction, _rng: Rng): MinorityState {
  if (!action || typeof action !== "object" || (action as { type?: unknown }).type !== "answer") {
    throw new Error("不明なアクションです");
  }
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished") throw new Error("ゲームは終了しています");
  if (state.phase !== "question") throw new Error("今は回答できません");
  if (!aliveSeats(state).includes(seat)) throw new Error("脱落したプレイヤーは回答できません");
  const choice = (action as { choice?: unknown }).choice;
  if (choice !== 0 && choice !== 1) throw new Error("回答が不正です");
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

function viewFor(state: MinorityState, seat: number): MinorityView {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  const revealing = state.phase === "reveal" || state.phase === "finished";
  const last = state.history[state.history.length - 1];
  const revealCurrent = revealing && last && last.questionIndex === state.index;
  const alive = aliveSeats(state);

  const players: MnViewPlayer[] = state.players.map((p) => {
    const entry: MnViewPlayer = {
      seat: p.seat,
      name: p.name,
      alive: alive.includes(p.seat),
      left: state.leftSeats.includes(p.seat),
      answered:
        state.answers.some((a) => a.seat === p.seat) ||
        (revealCurrent && last ? last.answers.some((a) => a.seat === p.seat && a.choice !== null) : false),
    };
    if (revealCurrent && last) {
      const a = last.answers.find((x) => x.seat === p.seat);
      entry.choice = a ? a.choice : null;
      entry.eliminatedThisRound = last.eliminatedSeats.includes(p.seat);
    }
    return entry;
  });

  const myAnswer = state.answers.find((a) => a.seat === seat);
  let yourChoice: number | null = myAnswer ? myAnswer.choice : null;
  if (yourChoice === null && revealCurrent && last) {
    const a = last.answers.find((x) => x.seat === seat);
    if (a) yourChoice = a.choice;
  }

  let standings: MinorityView["standings"] = null;
  if (state.phase === "finished") {
    const winners = state.winners ?? [];
    standings = state.players.map((p) => {
      const isWinner = winners.includes(p.seat);
      let rank = 1;
      if (!isWinner) {
        const myRound = state.eliminatedRound[p.seat] ?? -1;
        // 自分より長く生き残った人数 + 1 が順位。
        const better = state.players.filter((o) => {
          if (o.seat === p.seat) return false;
          if (winners.includes(o.seat)) return true;
          return (state.eliminatedRound[o.seat] ?? -1) > myRound;
        }).length;
        rank = better + 1;
      }
      return { seat: p.seat, rank, winner: isWinner };
    });
  }

  const q = state.questions[state.index];
  return {
    phase: state.phase,
    round: Math.min(state.index + 1, state.questions.length),
    maxRounds: state.questions.length,
    questionEndsAt: state.questionEndsAt,
    revealEndsAt: state.revealEndsAt,
    question: state.phase !== "finished" && q ? { topic: q.topic, choices: [...q.choices] as [string, string] } : null,
    tally: revealCurrent && last ? [...last.tally] as [number, number] : null,
    lastEliminated: revealCurrent && last ? [...last.eliminatedSeats] : null,
    you: {
      seat,
      alive: alive.includes(seat),
      answered: players.find((p) => p.seat === seat)?.answered ?? false,
      yourChoice,
      left: state.leftSeats.includes(seat),
    },
    players,
    winners: state.winners ? [...state.winners] : null,
    standings,
  };
}

function parseAction(raw: unknown): MinorityAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.type !== "answer") return null;
  if (rec.choice !== 0 && rec.choice !== 1) return null;
  return { type: "answer", choice: rec.choice };
}

function onPlayerLeft(state: MinorityState, seat: number): MinorityState {
  if (!playerOf(state, seat)) throw new Error("プレイヤーが存在しません");
  if (state.phase === "finished" || state.leftSeats.includes(seat)) return state;
  const draft = clone(state);
  draft.leftSeats.push(seat);
  if (draft.eliminatedRound[seat] === undefined) {
    draft.eliminatedRound[seat] = draft.index;
  }
  const alive = aliveSeats(draft);
  if (draft.phase === "question") {
    if (alive.length <= 2) {
      draft.winners = alive;
      draft.phase = "finished";
      draft.questionEndsAt = null;
      return draft;
    }
    closeIfAllAnswered(draft, Date.now());
  }
  return draft;
}

function tick(state: MinorityState, now: number): MinorityState {
  if (state.phase === "question" && state.questionEndsAt !== null && now >= state.questionEndsAt) {
    const draft = clone(state);
    closeRound(draft, now);
    return draft;
  }
  if (state.phase === "reveal" && state.revealEndsAt !== null && now >= state.revealEndsAt) {
    const draft = clone(state);
    advance(draft, now);
    return draft;
  }
  return state;
}

export const gameModule: OnlineGameModule<MinorityState, MinorityAction, MinorityView> = {
  id: "minority",
  title: "少数決ゲーム",
  minPlayers: 3,
  maxPlayers: 8,
  cpuSupported: false,
  chatEnabled: true,
  createState,
  applyAction,
  viewFor,
  parseAction,
  phaseOf: (state: MinorityState) => state.phase,
  isFinished: (state: MinorityState) => state.phase === "finished",
  onPlayerLeft,
  tick,
};
