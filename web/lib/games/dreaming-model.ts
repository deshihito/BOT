// 「dreaming」の非-Transformer 確率的逐次生成モデル群（純粋 TypeScript・外部 API なし）。
//
// 3つの実モデルを連動させて「Transformer 以前の LLM が見る夢」を構造から生み出す：
// 1. 小型ゲート付き LSTM セル（DreamRnnState）:
//    固定長の隠れ状態ベクトル h_t と細胞状態 c_t を毎歩更新し、忘却ゲート f_t により
//    古い記憶を指数関数的に減衰させながら、6つの夢領域の混合確率分布（滲み）を出力する。
// 2. 文字レベル n-gram 言語モデル（CharNgramLM: 1/2/3-gram バックオフ補間 + 温度サンプリング）:
//    各領域の日本語ミニコーパスから文字遷移確率を学習し、RNN の領域混合比で複数モデルを
//    合成して 1 文字ずつ逐次生成する。温度や変質世代に応じて「意味がありそうで無い言葉」へ崩れる。
// 3. 2D 局所条件付きマルコフ場（sampleNextTile）:
//    確定済みの近傍タイル列の遷移確率表と RNN の領域確率分布を合成し、温度付きソフトマックスで
//    タイルを自己回帰的に逐次サンプリングする（局所整合＋全体の忘却）。

export type Rng = () => number;

/** 再現性のある軽量疑似乱数（mulberry32）。 */
export function createRng(seed: number): Rng {
  let s = (seed | 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type DomainId = "station" | "school" | "library" | "arcade" | "harbor" | "meadow";

export const DOMAIN_IDS: readonly DomainId[] = [
  "station",
  "school",
  "library",
  "arcade",
  "harbor",
  "meadow",
] as const;

export type DomainPalette = {
  id: DomainId;
  label: string;
  floor: [number, number, number];
  wall: [number, number, number];
  accent: [number, number, number];
  fog: [number, number, number];
  ink: [number, number, number];
};

/** 深夜フィルム写真・黄昏の光・古紙インク基調の6領域パレット（RGB 連続補間で滲ませる）。 */
export const DOMAIN_PALETTES: Record<DomainId, DomainPalette> = {
  station: {
    id: "station",
    label: "深夜駅",
    floor: [36, 52, 70],
    wall: [18, 28, 42],
    accent: [228, 190, 102],
    fog: [11, 18, 29],
    ink: [212, 228, 240],
  },
  school: {
    id: "school",
    label: "放課後校舎",
    floor: [82, 56, 40],
    wall: [34, 58, 52],
    accent: [240, 172, 92],
    fog: [28, 19, 17],
    ink: [244, 224, 196],
  },
  library: {
    id: "library",
    label: "古書庫",
    floor: [58, 41, 32],
    wall: [29, 20, 16],
    accent: [228, 176, 92],
    fog: [18, 13, 12],
    ink: [236, 222, 194],
  },
  arcade: {
    id: "arcade",
    label: "雨の商店街",
    floor: [32, 46, 52],
    wall: [19, 28, 34],
    accent: [218, 110, 86],
    fog: [12, 20, 25],
    ink: [204, 228, 224],
  },
  harbor: {
    id: "harbor",
    label: "霧の防波堤",
    floor: [26, 48, 64],
    wall: [14, 29, 42],
    accent: [152, 210, 224],
    fog: [10, 19, 29],
    ink: [206, 226, 236],
  },
  meadow: {
    id: "meadow",
    label: "踏切の草地",
    floor: [32, 60, 46],
    wall: [18, 36, 30],
    accent: [222, 228, 162],
    fog: [13, 24, 20],
    ink: [222, 236, 212],
  },
};

export const MIN_TEMPERATURE = 0.4;
export const MAX_TEMPERATURE = 1.8;

export function clampTemperature(temp: number): number {
  if (!Number.isFinite(temp)) return 0.92;
  return Math.max(MIN_TEMPERATURE, Math.min(MAX_TEMPERATURE, temp));
}

function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

/** 温度付きソフトマックス。確率の総和は常に 1 になる。 */
export function softmax(logits: readonly number[], temperature = 1): number[] {
  const t = Math.max(0.05, temperature);
  let maxScaled = -Infinity;
  const scaled = new Array<number>(logits.length);
  for (let i = 0; i < logits.length; i++) {
    const v = logits[i] / t;
    scaled[i] = v;
    if (v > maxScaled) maxScaled = v;
  }
  let sum = 0;
  const probs = new Array<number>(logits.length);
  for (let i = 0; i < scaled.length; i++) {
    const e = Math.exp(scaled[i] - maxScaled);
    probs[i] = e;
    sum += e;
  }
  if (sum <= 0 || !Number.isFinite(sum)) {
    const uniform = 1 / Math.max(1, logits.length);
    return logits.map(() => uniform);
  }
  for (let i = 0; i < probs.length; i++) probs[i] /= sum;
  return probs;
}

/** カテゴリ分布から 1 インデックスをサンプリングする。 */
export function sampleCategorical(probs: readonly number[], rng: Rng): number {
  const u = rng();
  let acc = 0;
  for (let i = 0; i < probs.length; i++) {
    acc += probs[i];
    if (u < acc) return i;
  }
  return Math.max(0, probs.length - 1);
}

/** 0..1 に正規化したシャノンエントロピー（滲み度）。 */
export function normalizedEntropy(probs: readonly number[]): number {
  if (probs.length <= 1) return 0;
  let h = 0;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    if (p > 1e-12) h -= p * Math.log(p);
  }
  return Math.max(0, Math.min(1, h / Math.log(probs.length)));
}

// ============================================================
// 1. 小型ゲート付き LSTM セル（隠れ状態 8 次元）
// ============================================================
// 次元 0..5: 6 つの夢領域（station, school, library, arcade, harbor, meadow）
// 次元 6: 静寂 <-> 喧騒（構造密度・灯り）
// 次元 7: 乾き <-> 湿り（水・霧・雨）

export const RNN_DIM = 8;

export type DreamRnnState = {
  /** 隠れ状態ベクトル h_t（長さ 8, -1..1）。 */
  h: number[];
  /** 細胞状態ベクトル c_t（長さ 8）。長期記憶の担い手。 */
  c: number[];
  /** 直近の忘却ゲート平均値（0..1、モニタ表示・テスト用）。 */
  lastForgetMean: number;
  /** 更新ステップ数。 */
  steps: number;
};

// 領域間の滲み結合行列（U_c: 隠れ状態から次ステップ候補細胞への再帰重み）。
// 対角成分は自己維持、隣り合う領域への非対角正結合が「境目なく別の場所へ滲む」遷移を作る。
// 駅 <-> 商店街 <-> 港 <-> 草地 <-> 校舎 <-> 書庫 <-> 駅 の環＋斜めの弱連想。
const U_CANDIDATE: readonly (readonly number[])[] = [
  // sta    sch    lib    arc    har    mea    hum    wet
  [0.54, 0.08, 0.14, 0.24, 0.12, 0.18, 0.06, 0.04], // station
  [0.10, 0.56, 0.24, 0.08, 0.04, 0.20, -0.06, -0.04], // school
  [0.14, 0.24, 0.58, 0.10, 0.06, 0.04, -0.10, -0.06], // library
  [0.24, 0.08, 0.10, 0.54, 0.22, 0.06, 0.12, 0.14], // arcade
  [0.14, 0.04, 0.06, 0.22, 0.56, 0.20, -0.04, 0.22], // harbor
  [0.20, 0.20, 0.06, 0.06, 0.18, 0.56, -0.08, 0.08], // meadow
  [0.10, -0.08, -0.12, 0.16, -0.04, -0.08, 0.48, 0.06], // hum
  [0.06, -0.06, -0.08, 0.18, 0.24, 0.10, 0.04, 0.52], // wet
];

// 忘却ゲートの再帰重み（同じ次元が飽和し続けると自己忘却が進み、緩やかに別領域へドリフトする）
const U_FORGET_DIAG = -0.34;
const U_INPUT_DIAG = 0.26;
const U_OUTPUT_DIAG = 0.32;

export function createRnnState(initialDomainIndex: number, rng?: Rng): DreamRnnState {
  const h = new Array<number>(RNN_DIM).fill(0);
  const c = new Array<number>(RNN_DIM).fill(0);
  const idx = ((initialDomainIndex % DOMAIN_IDS.length) + DOMAIN_IDS.length) % DOMAIN_IDS.length;
  for (let i = 0; i < RNN_DIM; i++) {
    const jitter = rng ? (rng() - 0.5) * 0.18 : 0;
    c[i] = (i === idx ? 1.15 : -0.12) + jitter;
    h[i] = Math.tanh(c[i]) * 0.72;
  }
  return { h, c, lastForgetMean: 0.76, steps: 0 };
}

/**
 * 1ステップのゲート付き LSTM 更新。
 * - input: 長さ 8 の外部入力ベクトル x_t（歩行方向・踏んだタイル・共鳴モチーフ・微弱ゆらぎ）
 * - depth: 現在の夢の深度（深いほど忘却ゲートバイアスが下がり、記憶が早く薄れる）
 * - temperature: サンプリング温度（高いほど入力ゲートが開きやすく、別の領域が滲み込みやすい）
 */
export function stepRnn(
  prev: DreamRnnState,
  input: readonly number[],
  depth: number,
  temperature: number,
): DreamRnnState {
  const nextC = new Array<number>(RNN_DIM);
  const nextH = new Array<number>(RNN_DIM);
  // 深度が深いほど忘却ゲートバイアスを下げて「すぐ忘れる」性質を強める（下限あり）。
  const forgetBias = Math.max(0.18, 1.18 - (Math.max(1, depth) - 1) * 0.11);
  // 温度が高いほど新しい入力や滲みを受け入れやすい。
  const tempShift = (clampTemperature(temperature) - 0.92) * 0.45;
  let forgetSum = 0;

  for (let i = 0; i < RNN_DIM; i++) {
    const xi = input[i] ?? 0;
    const hi = prev.h[i] ?? 0;
    const ci = prev.c[i] ?? 0;

    // 候補細胞 \tilde{c}_t = tanh(W_c x_t + U_c h_{t-1} + b_c)
    let recur = 0;
    const row = U_CANDIDATE[i];
    for (let j = 0; j < RNN_DIM; j++) {
      recur += row[j] * (prev.h[j] ?? 0);
    }
    const cand = Math.tanh(xi * 0.95 + recur);

    // 忘却ゲート f_t = sigmoid(W_f x_t + U_f h_{t-1} + b_f)
    const f = sigmoid(forgetBias + U_FORGET_DIAG * Math.abs(hi) - tempShift * 0.35 + xi * 0.18);
    // 入力ゲート i_t = sigmoid(W_i x_t + U_i h_{t-1} + b_i)
    const ig = sigmoid(-0.15 + tempShift + U_INPUT_DIAG * hi + Math.abs(xi) * 0.85);
    // 出力ゲート o_t = sigmoid(W_o x_t + U_o h_{t-1} + b_o)
    const og = sigmoid(0.55 + U_OUTPUT_DIAG * hi + xi * 0.25);

    const cNew = Math.max(-2.6, Math.min(2.6, f * ci + ig * cand));
    const hNew = og * Math.tanh(cNew);

    nextC[i] = cNew;
    nextH[i] = hNew;
    forgetSum += f;
  }

  return {
    h: nextH,
    c: nextC,
    lastForgetMean: forgetSum / RNN_DIM,
    steps: prev.steps + 1,
  };
}

/** 隠れ状態 h_t から 6 領域の確率分布 P(domain | h_t, T) を算出する。 */
export function domainProbsFromRnn(
  rnn: DreamRnnState,
  temperature: number,
): Record<DomainId, number> {
  // 隠れ状態の先頭 6 次元＋補助次元（喧騒・湿り）からの線形射影（出力層 W_out h_t）。
  const hum = rnn.h[6] ?? 0;
  const wet = rnn.h[7] ?? 0;
  const logits = [
    (rnn.h[0] ?? 0) * 2.5 + hum * 0.25 + wet * 0.1, // station
    (rnn.h[1] ?? 0) * 2.5 - hum * 0.18 - wet * 0.12, // school
    (rnn.h[2] ?? 0) * 2.5 - hum * 0.3 - wet * 0.18, // library
    (rnn.h[3] ?? 0) * 2.5 + hum * 0.34 + wet * 0.24, // arcade
    (rnn.h[4] ?? 0) * 2.5 - hum * 0.1 + wet * 0.42, // harbor
    (rnn.h[5] ?? 0) * 2.5 - hum * 0.22 + wet * 0.14, // meadow
  ];
  const probs = softmax(logits, Math.max(0.32, clampTemperature(temperature) * 0.82));
  return {
    station: probs[0],
    school: probs[1],
    library: probs[2],
    arcade: probs[3],
    harbor: probs[4],
    meadow: probs[5],
  };
}

export function dominantDomainOf(weights: Record<DomainId, number>): DomainId {
  let best: DomainId = "station";
  let bestVal = -1;
  for (const id of DOMAIN_IDS) {
    if (weights[id] > bestVal) {
      bestVal = weights[id];
      best = id;
    }
  }
  return best;
}

/** 6 領域の確率分布に従ってパレット色を連続的に滲み合成する。 */
export function blendDomainColors(
  weights: Record<DomainId, number>,
  channel: "floor" | "wall" | "accent" | "fog" | "ink",
): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const id of DOMAIN_IDS) {
    const w = weights[id] ?? 0;
    const c = DOMAIN_PALETTES[id][channel];
    r += c[0] * w;
    g += c[1] * w;
    b += c[2] * w;
  }
  return [Math.round(r), Math.round(g), Math.round(b)];
}

export function rgbCss(rgb: readonly [number, number, number], alpha = 1): string {
  if (alpha >= 0.999) return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha.toFixed(3)})`;
}

// ============================================================
// 2. 文字レベル n-gram 言語モデル（1/2/3-gram バックオフ補間）
// ============================================================

const BOS = "\u0002";
const EOS = "\u0003";

/** 各夢領域のミニコーパス（ひらがな・カタカナ中心に揃えて 2/3-gram 接続密度を高めている）。 */
export const DOMAIN_CORPORA: Record<DomainId, readonly string[]> = {
  station: [
    "きさらぎえき",
    "しゅうでんほーむ",
    "むじんかいさつ",
    "よるののりば",
    "あおいけいこうとう",
    "とけいのないほーむ",
    "しろいはくせん",
    "みらいゆきでんしゃ",
    "かすむじこくひょう",
    "あめのこせんきょう",
    "からっぽのまちあいしつ",
    "とおいあなうんす",
    "さびたべんち",
    "ながいちかつうろ",
    "わすれたきっぷうりば",
    "にばんせんのかぜ",
    "あかいじゅわき",
    "よあけのしはつえき",
    "ていしゃしないでんしゃ",
    "ゆれるつりかわ",
    "ほーむのはしっこ",
    "しずかなふみきり",
    "だれもいないえきまえ",
    "みずたまりのれーる",
    "きりのほーむ",
    "うみへつづくえき",
  ],
  school: [
    "ほうかごのろうか",
    "ゆうやけのきょうしつ",
    "こくばんのうた",
    "ちいさなすいそう",
    "ならないちゃいむ",
    "ひらかないまど",
    "あめいろのゆかいた",
    "おどりばのかいだん",
    "わすれもののつくえ",
    "しろいちょーくのこな",
    "だれかのうわばき",
    "かーてんのゆれるまど",
    "しずかなおんがくしつ",
    "とおいぴあののおと",
    "あかいらんどせる",
    "ほけんしつのかーてん",
    "ながいわたりろうか",
    "かぎのかかったおくじょう",
    "かがみのまえのてあらい",
    "よるのりかしつ",
    "あめのおとのきょうしつ",
    "すいそうのきんぎょ",
    "とまったかべどけい",
    "くつばこのすみっこ",
    "ゆうぐれのろうか",
    "だれもいないかいだん",
  ],
  library: [
    "ふるいほんだな",
    "むげんのしょこ",
    "かみのにおいのろうか",
    "きいろいどくしょとう",
    "よめないもくろく",
    "ぺーじのないほん",
    "しずかなえつらんしつ",
    "はしごのかかるたな",
    "うすあかりのしょさい",
    "しおりのはさまったほん",
    "ながいらせんかいだん",
    "ほこりのまうてんじょう",
    "こわれたかーどばこ",
    "いんくのにじむのーと",
    "だれかのゆめにっき",
    "とじられたずかん",
    "あおいせびょうし",
    "ふかいちかしょこ",
    "かすれたばんごうふだ",
    "おとのないとしょしつ",
    "まどべのまるつくえ",
    "しろいしおりのいと",
    "ねむるふるほんのかべ",
    "わすれられたさくいん",
    "あめいろのほんだな",
    "よるのとしょしつ",
  ],
  arcade: [
    "あめのしょうてんがい",
    "ひかるじはんき",
    "さびたあーけーど",
    "あかいおきがさ",
    "ぬれたほどう",
    "ねむるしゃったー",
    "かすむかんばん",
    "よるのきっさてん",
    "あおいらんぷのかけら",
    "ふるいれこーどや",
    "こうしゅうでんわばこ",
    "あたたかいかんこーひー",
    "まがりかどのろじうら",
    "しずくのおちるひさし",
    "とけいやのしょうまど",
    "ゆれるちょうちん",
    "あめやどりののきした",
    "だれもいないろじうら",
    "かすかならじおのこえ",
    "しろいゆげののれん",
    "みずたまりのうつるそら",
    "ふるほんやのいりぐち",
    "かいてんとびらのかげ",
    "よふけのまがりかど",
    "あかいこうしゅうでんわ",
    "ぬれたあーけーど",
  ],
  harbor: [
    "きりのぼうはてい",
    "とおいとうだいのひ",
    "しおのかぜのさんばし",
    "ねむるふなつきば",
    "くらいうみのすいめん",
    "ひびくむてきのおと",
    "しろいぶいのゆらぎ",
    "さびたろーぷのくい",
    "なみおとのていぼう",
    "かすむすいへいせん",
    "よるのかもめのこえ",
    "ぬれたいしだたみ",
    "ちいさなわたしば",
    "あかりのもれるそうこ",
    "しずかなうみぞいみち",
    "みずうみのようなみなと",
    "うかぶあおいらんぷ",
    "しおのみちるかいだん",
    "きりのなかのでんわ",
    "ふねのないさんばし",
    "あわいみなとのけむり",
    "ながいぼうはていのはし",
    "みずのそこのとけい",
    "うみへつづくほーむ",
    "あおいなみのさんばし",
    "よるのとうだい",
  ],
  meadow: [
    "ふみきりのくさち",
    "つきしろのあぜみち",
    "あめのせんろぞい",
    "かぜのわたるすすき",
    "とおいけいほうき",
    "しずかなのっぱら",
    "ほたるびのやぶみち",
    "くさにうもれたべんち",
    "よるのくさむら",
    "あわいきりのほそみち",
    "ふるいまくらぎのかず",
    "むしのこえのつづくみち",
    "しろいさくのむこう",
    "みずたまりのくさむら",
    "うたうでんせんのかぜ",
    "くものながれるほしぞら",
    "ひくいおかのうえ",
    "あかいぽすとのくさみち",
    "とぎれたじゃりみち",
    "だれもこないばすてい",
    "つめたいつゆのくさば",
    "ひかるみずのほそみち",
    "よあけまえのふみきり",
    "はてのないはらっぱ",
    "しずかなせんろみち",
    "つきあかりのふみきり",
  ],
};

/** 夢の断片（一行テキスト）用の領域別フレーズコーパス。共通の助詞と語根で領域間が滲む。 */
const FRAGMENT_CORPORA: Record<DomainId, readonly string[]> = {
  station: [
    "つぎのでんしゃはもうきのうについた",
    "ほーむのはしでとけいがうしろへまわる",
    "かいさつのむこうになみのおとがきこえる",
    "じこくひょうのもじがすこしずつとけていく",
    "きっぷのないままながいろうかをあるく",
    "けいこうとうがひとつだけあおいひかりをだす",
    "にばんせんのかぜがふるいかみのにおいをはこぶ",
    "まちあいしつのべんちにだれかのとけいがのこる",
    "はくせんのむこうがしずかなうみにみえる",
    "しゅうでんのおとがまだとおくでひびいている",
  ],
  school: [
    "ちゃいむがなりおわるまえにゆうがたになる",
    "こくばんのもじがまばたきのあいだにかわる",
    "ろうかのさきがまたおなじおどりばだった",
    "すいそうのなかでちいさなほーむがひかる",
    "かーてんがゆれるとべつのへやのにおいがする",
    "だれかのわすれたとけいがまだうごいている",
    "まどのそとにしずかなふみきりのかげがみえる",
    "ゆうやけのゆかいたにみずたまりがひろがる",
    "おんがくしつのかいだんをおりるとえきにでる",
    "しろいちょーくのこながきりみたいにただよう",
  ],
  library: [
    "ほんだなのすきまからつめたいかぜがふく",
    "しおりをはずすとぺーじぜんぶがしろくなる",
    "きのうよんだはずのなまえをもうわすれた",
    "らせんかいだんをおりるとまたうえのろうかにでる",
    "ふるいかみのあいだにしおのかおりがのこる",
    "もくろくのばんごうがほーむのばんごうにみえる",
    "どくしょとうのしたでとけいのおとがとまる",
    "いんくのにじんだのーとにみしらぬえきがかいてある",
    "としょしつのまどからとおいとうだいがひかる",
    "とじられたほんのむこうでだれかがでんわをとる",
  ],
  arcade: [
    "じはんきのあかりだけがみずたまりにのこる",
    "あめやどりをしているうちにうしろのみちがかわった",
    "こうしゅうでんわのむこうでなみがおとをたてる",
    "かんばんのよみかたをおもいだせそうでだせない",
    "しゃったーのむこうにくらいきょうしつがある",
    "ぬれたあーけーどがどこまでもつづいている",
    "あかいおきがさのしたでとけいがしずかにうごく",
    "ろじうらをまがるとふるいほんだながならんでいる",
    "ひさしからしずくがおちるたびになまえがずれる",
    "だれもいないきっさてんでらじおがひくくなる",
  ],
  harbor: [
    "きりのむこうでふみきりのようなおとがなる",
    "さんばしのさきにいつのまにかほんだながたつ",
    "すいめんにうつるあかりがもじのかたちをする",
    "とうだいのひかりがまわるとうしろのみちがきえる",
    "なみうちぎわにあかいおきがさがたたずんでいる",
    "うみのかぜがふるいかみのにおいにかわっていく",
    "ぼうはていのはしにむじんかいさつがぽつんとある",
    "しおのみちるかいだんをおりるとろうかにつづく",
    "むてきのおとがちゃいむのようにとおくでひびく",
    "くらいすいめんのそこにしろいはくせんがしずむ",
  ],
  meadow: [
    "くさむらのなかにうすいほーむのはくせんがある",
    "ふみきりがしまってもでんしゃはとおらない",
    "じゃりみちをふりかえるともうろうかだった",
    "すすきのかげにじはんきがしずかにひかっている",
    "つきあかりのしたでばしょのなまえがすこしずれる",
    "ばすていのひょうしきがよめないかたちにかわる",
    "つめたいつゆのくさみちにでんわのおとがひびく",
    "せんろぞいをあるくうちにしおのかぜがふいてくる",
    "とおいけいほうきがとけいのようにきざんでいる",
    "だれもいないのっぱらにほんだなのかげがたつ",
  ],
};

export type CharNgramLM = {
  /** context(長さ 0, 1, 2) -> { nextChar -> count } */
  counts: Map<string, Map<string, number>>;
  /** 各コンテキストの総出現回数。 */
  totals: Map<string, number>;
  /** 学習した全文字集合（EOS 含む）。 */
  vocab: string[];
};

/** 文字列コーパスから 1/2/3-gram 文字遷移表を学習する。 */
export function trainCharLM(corpus: readonly string[]): CharNgramLM {
  const counts = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  const vocabSet = new Set<string>();

  const bump = (ctx: string, ch: string) => {
    let row = counts.get(ctx);
    if (!row) {
      row = new Map<string, number>();
      counts.set(ctx, row);
    }
    row.set(ch, (row.get(ch) ?? 0) + 1);
    totals.set(ctx, (totals.get(ctx) ?? 0) + 1);
  };

  for (const raw of corpus) {
    const chars = Array.from(raw);
    if (chars.length === 0) continue;
    const seq = [BOS, BOS, ...chars, EOS];
    for (let i = 2; i < seq.length; i++) {
      const ch = seq[i];
      vocabSet.add(ch);
      const ctx2 = seq[i - 2] + seq[i - 1];
      const ctx1 = seq[i - 1];
      bump(ctx2, ch);
      bump(ctx1, ch);
      bump("", ch);
    }
  }

  return {
    counts,
    totals,
    vocab: Array.from(vocabSet),
  };
}

/** 単一モデルで直近 2 文字コンテキストから次文字のバックオフ補間確率を計算する。 */
function charProbsSingle(lm: CharNgramLM, cPrev2: string, cPrev1: string): Map<string, number> {
  const out = new Map<string, number>();
  const ctx2 = cPrev2 + cPrev1;
  const row2 = lm.counts.get(ctx2);
  const tot2 = lm.totals.get(ctx2) ?? 0;
  const row1 = lm.counts.get(cPrev1);
  const tot1 = lm.totals.get(cPrev1) ?? 0;
  const row0 = lm.counts.get("");
  const tot0 = lm.totals.get("") ?? 1;

  // Jelinek-Mercer 補間: 3-gram 優先で局所日本語の滑らかさを保ち、未観測時だけ 2/1-gram へフォールバック
  const w2 = tot2 > 0 ? 0.86 : 0;
  const w1 = tot1 > 0 ? (tot2 > 0 ? 0.132 : 0.94) : 0;
  const w0 = Math.max(0.008, 1 - w2 - w1);

  if (row2 && tot2 > 0) {
    for (const [ch, cnt] of row2) {
      out.set(ch, (out.get(ch) ?? 0) + (w2 * cnt) / tot2);
    }
  }
  if (row1 && tot1 > 0) {
    for (const [ch, cnt] of row1) {
      out.set(ch, (out.get(ch) ?? 0) + (w1 * cnt) / tot1);
    }
  }
  if (row0) {
    for (const [ch, cnt] of row0) {
      out.set(ch, (out.get(ch) ?? 0) + (w0 * cnt) / tot0);
    }
  }
  return out;
}

const SMALL_Y = new Set(["ゃ", "ゅ", "ょ"]);
const YOON_BASE = new Set(["き", "し", "ち", "に", "ひ", "み", "り", "ぎ", "じ", "び", "ぴ"]);
const NO_START_CHARS = new Set(["ゃ", "ゅ", "ょ", "っ", "ー", "ん", "ぁ", "ぃ", "ぅ", "ぇ", "ぉ"]);

/** 日本語として発音不能な小書き・長音の並びだけを局所的に弾く。 */
function isPlausibleNextChar(ch: string, prev1: string, outLen: number): boolean {
  if (outLen === 0 && NO_START_CHARS.has(ch)) return false;
  if (SMALL_Y.has(ch) && !YOON_BASE.has(prev1)) return false;
  if (ch === "ー" && (prev1 === BOS || prev1 === "ー" || prev1 === "っ" || prev1 === "ん")) return false;
  if (ch === "っ" && (prev1 === "っ" || prev1 === "ー")) return false;
  return true;
}

export type DreamLanguageModels = {
  words: Record<DomainId, CharNgramLM>;
  fragments: Record<DomainId, CharNgramLM>;
};

let cachedModels: DreamLanguageModels | null = null;

export function getDreamLanguageModels(): DreamLanguageModels {
  if (cachedModels) return cachedModels;
  const words = {} as Record<DomainId, CharNgramLM>;
  const fragments = {} as Record<DomainId, CharNgramLM>;
  for (const id of DOMAIN_IDS) {
    words[id] = trainCharLM(DOMAIN_CORPORA[id]);
    fragments[id] = trainCharLM(FRAGMENT_CORPORA[id]);
  }
  cachedModels = { words, fragments };
  return cachedModels;
}

/**
 * 複数ドメインの CharNgramLM を領域確率分布 weights で線形混合し、
 * 温度付きソフトマックスで 1 文字ずつ逐次サンプリングする。
 */
export function sampleCharSequence(
  domainModels: Record<DomainId, CharNgramLM>,
  domainWeights: Record<DomainId, number>,
  temperature: number,
  rng: Rng,
  opts: { seedPrefix?: string; minLen?: number; maxLen?: number } = {},
): string {
  const minLen = opts.minLen ?? 4;
  const maxLen = opts.maxLen ?? 12;
  // ゲーム表示温度 [0.40, 1.80] を文字生成の実効温度 [0.34, 1.04] へ写像
  const charTemp = 0.34 + (clampTemperature(temperature) - MIN_TEMPERATURE) * 0.5;
  const prefixChars = opts.seedPrefix ? Array.from(opts.seedPrefix) : [];
  const out: string[] = [...prefixChars];

  let prev2 = BOS;
  let prev1 = BOS;
  for (const ch of prefixChars) {
    prev2 = prev1;
    prev1 = ch;
  }

  const hardMax = maxLen + 3;
  for (let step = out.length; step < hardMax; step++) {
    const mixed = new Map<string, number>();
    for (const id of DOMAIN_IDS) {
      const w = domainWeights[id] ?? 0;
      if (w <= 0.005) continue;
      const dist = charProbsSingle(domainModels[id], prev2, prev1);
      for (const [ch, p] of dist) {
        mixed.set(ch, (mixed.get(ch) ?? 0) + w * p);
      }
    }

    const candidates: string[] = [];
    const logits: number[] = [];
    for (const [ch, p] of mixed) {
      if (ch === EOS) {
        if (out.length < minLen || prev1 === "っ") continue;
      } else {
        if (!isPlausibleNextChar(ch, prev1, out.length)) continue;
        // 同じ文字の 3 連続だけ抑制
        if (out.length >= 2 && ch === prev1 && ch === prev2) continue;
      }
      // 1-gram のみの極小ノイズ候補は低温〜中温では足切りし、高温（深夢）でのみ崩れとして解禁
      if (p < 0.004 && charTemp < 0.85) continue;
      const prob = Math.max(1e-7, p);
      // maxLen に近づいたら EOS 確率を強めて自然に言い切る
      const eosBoost =
        ch === EOS
          ? out.length >= maxLen
            ? 2.4
            : out.length >= maxLen - 2
              ? 1.1
              : 0.15
          : 0;
      candidates.push(ch);
      logits.push(Math.log(prob) + eosBoost);
    }

    if (candidates.length === 0) break;
    const probs = softmax(logits, charTemp);
    const chosen = candidates[sampleCategorical(probs, rng)];
    if (chosen === EOS) break;

    out.push(chosen);
    prev2 = prev1;
    prev1 = chosen;
  }

  // 末尾が促音「っ」で終わってしまった場合だけ自然に整える
  while (out.length > 0 && out[out.length - 1] === "っ") {
    out.pop();
  }
  return out.join("");
}

/** 現在の領域混合と温度から「崩れた地名・場所名」を逐次生成する。 */
export function generateDreamPlaceName(
  models: DreamLanguageModels,
  domainWeights: Record<DomainId, number>,
  temperature: number,
  rng: Rng,
  seedPrefix?: string,
): string {
  const generated = sampleCharSequence(models.words, domainWeights, temperature, rng, {
    seedPrefix,
    minLen: 5,
    maxLen: 10,
  });
  return generated.length >= 3 ? generated : "かすむみち";
}

/**
 * 変質反復（Mutating Recurrence）用の名前生成。
 * 直前の名前から 2〜3 文字の断片だけを局所コンテキスト窓として引き継ぎ、
 * 残りを現在の領域分布とやや高い温度で文字 n-gram モデルから再生成する。
 */
export function mutateDreamName(
  models: DreamLanguageModels,
  domainWeights: Record<DomainId, number>,
  prevName: string,
  generation: number,
  temperature: number,
  rng: Rng,
): string {
  const chars = Array.from(prevName);
  // 世代が進むほど保持する接頭長を少し揺らし、後ろが別領域の語彙へ滲む。
  const keepLen = Math.min(
    chars.length,
    Math.max(2, generation % 2 === 0 ? 3 : 2),
  );
  const startIdx =
    generation >= 3 && chars.length > keepLen + 1 && rng() < 0.35
      ? Math.min(chars.length - keepLen, 1)
      : 0;
  const seed = chars.slice(startIdx, startIdx + keepLen).join("");
  const effTemp = clampTemperature(temperature + Math.min(0.45, (generation - 1) * 0.08));

  for (let attempt = 0; attempt < 4; attempt++) {
    const candidate = sampleCharSequence(models.words, domainWeights, effTemp, rng, {
      seedPrefix: seed,
      minLen: 5,
      maxLen: 11,
    });
    if (candidate !== prevName && Array.from(candidate).length >= 4) {
      return candidate;
    }
  }
  return seed + sampleCharSequence(models.words, domainWeights, effTemp, rng, { minLen: 3, maxLen: 6 });
}

/** 一行の「夢の断片」を文字レベル n-gram モデルで逐次生成する。 */
export function generateDreamFragment(
  models: DreamLanguageModels,
  domainWeights: Record<DomainId, number>,
  temperature: number,
  rng: Rng,
): string {
  const line = sampleCharSequence(models.fragments, domainWeights, clampTemperature(temperature * 0.94), rng, {
    minLen: 12,
    maxLen: 24,
  });
  return line.length >= 6 ? line : "とおいおとがまだきこえている";
}

// ============================================================
// 3. 2D 局所条件付きマルコフ場（Autoregressive Tile Sampling）
// ============================================================

export type TileKind =
  | "floor"
  | "wall"
  | "water"
  | "rail"
  | "shelf"
  | "window"
  | "lamp"
  | "rift";

export const TILE_KINDS: readonly TileKind[] = [
  "floor",
  "wall",
  "water",
  "rail",
  "shelf",
  "window",
  "lamp",
  "rift",
] as const;

export function isWalkableTile(kind: TileKind): boolean {
  return kind === "floor" || kind === "rail" || kind === "lamp" || kind === "rift";
}

// 各領域ごとの基本ロジット（RNN 隠れ状態の領域確率分布で重み付け合成される）
const DOMAIN_TILE_BIAS: Record<DomainId, Record<TileKind, number>> = {
  station: {
    floor: 1.55,
    wall: 0.42,
    water: -1.45,
    rail: 0.98,
    shelf: -1.65,
    window: 0.25,
    lamp: 0.45,
    rift: -3.6,
  },
  school: {
    floor: 1.65,
    wall: 0.58,
    water: -1.65,
    rail: -1.75,
    shelf: 0.05,
    window: 0.85,
    lamp: 0.22,
    rift: -3.6,
  },
  library: {
    floor: 1.48,
    wall: 0.28,
    water: -1.9,
    rail: -2.0,
    shelf: 1.15,
    window: -0.55,
    lamp: 0.52,
    rift: -3.6,
  },
  arcade: {
    floor: 1.52,
    wall: 0.46,
    water: 0.15,
    rail: -1.1,
    shelf: -0.25,
    window: 0.45,
    lamp: 0.72,
    rift: -3.6,
  },
  harbor: {
    floor: 1.38,
    wall: -0.1,
    water: 1.12,
    rail: -0.95,
    shelf: -1.85,
    window: -0.85,
    lamp: 0.48,
    rift: -3.6,
  },
  meadow: {
    floor: 1.72,
    wall: -0.45,
    water: 0.28,
    rail: 0.78,
    shelf: -2.1,
    window: -1.25,
    lamp: 0.08,
    rift: -3.6,
  },
};

// 隣接タイルからの局所マルコフ遷移重み（P(self | neighbor) の対数ポテンシャル）
// 局所的には「廊下・本棚の列・線路・水面・窓壁」として整合する構造を生む。
const NEIGHBOR_PAIR_POTENTIAL: Record<TileKind, Partial<Record<TileKind, number>>> = {
  floor: { floor: 0.36, lamp: 0.16, rail: 0.08, wall: -0.14, water: -0.12, shelf: -0.08 },
  wall: { wall: 0.62, window: 0.48, floor: 0.1, water: -0.4, rail: -0.55, shelf: 0.12 },
  water: { water: 0.92, floor: 0.05, wall: -0.45, shelf: -0.7, window: -0.6 },
  rail: { rail: 0.96, floor: 0.14, wall: -0.55, shelf: -0.75, water: -0.45 },
  shelf: { shelf: 0.78, floor: 0.18, lamp: 0.14, water: -0.65, rail: -0.7 },
  window: { wall: 0.52, window: 0.42, floor: 0.16, water: -0.4 },
  lamp: { floor: 0.46, lamp: -0.95, wall: -0.15, shelf: 0.1 },
  rift: { floor: 0.6, rift: -2.2, wall: -0.5, water: -0.4 },
};

export type NeighborContext = {
  north?: TileKind;
  south?: TileKind;
  east?: TileKind;
  west?: TileKind;
  /** アンカー保護域との境界など、領域が衝突している強度（0..1）。 */
  boundaryShock?: number;
  /** 現在の RNN 領域混合エントロピー（0..1）。高いほど裂け目が出やすい。 */
  bleedEntropy: number;
  /** 前回の潜行からの歩数（緩やかな出現補助）。 */
  stepsSinceDescend: number;
  /** すでに視界内に rift があるか。 */
  hasNearbyRift: boolean;
};

/** 局所近傍＋RNN 領域分布から各タイル種別の対数確率（ロジット）を計算する。 */
export function computeTileLogits(
  domainWeights: Record<DomainId, number>,
  ctx: NeighborContext,
): number[] {
  const logits = new Array<number>(TILE_KINDS.length).fill(0);

  // 1. RNN の領域混合分布による基本ロジット
  for (let ti = 0; ti < TILE_KINDS.length; ti++) {
    const kind = TILE_KINDS[ti];
    let v = 0;
    for (const d of DOMAIN_IDS) {
      v += (domainWeights[d] ?? 0) * DOMAIN_TILE_BIAS[d][kind];
    }
    logits[ti] = v;
  }

  // 2. 局所 4 近傍による 2D マルコフ遷移ポテンシャル
  const neighbors: (TileKind | undefined)[] = [ctx.north, ctx.south, ctx.east, ctx.west];
  let blockedNeighbors = 0;
  let knownNeighbors = 0;

  for (const nb of neighbors) {
    if (!nb) continue;
    knownNeighbors++;
    if (!isWalkableTile(nb)) blockedNeighbors++;
    const pot = NEIGHBOR_PAIR_POTENTIAL[nb];
    for (let ti = 0; ti < TILE_KINDS.length; ti++) {
      logits[ti] += pot[TILE_KINDS[ti]] ?? 0;
    }
  }

  // 直線構造の局所バイアス：線路が南北または東西に伸びていればそのまま直線に伸びやすい
  if ((ctx.north === "rail" || ctx.south === "rail") && ctx.east !== "rail" && ctx.west !== "rail") {
    logits[TILE_KINDS.indexOf("rail")] += 0.55;
  }
  if ((ctx.east === "rail" || ctx.west === "rail") && ctx.north !== "rail" && ctx.south !== "rail") {
    logits[TILE_KINDS.indexOf("rail")] += 0.55;
  }

  // 局所文法制約：近傍が障害物だらけになりかけたら通路（floor）へ強く引き戻し、完全閉塞を防ぐ
  if (blockedNeighbors >= 2) {
    const floorIdx = TILE_KINDS.indexOf("floor");
    const wallIdx = TILE_KINDS.indexOf("wall");
    const waterIdx = TILE_KINDS.indexOf("water");
    const shelfIdx = TILE_KINDS.indexOf("shelf");
    const windowIdx = TILE_KINDS.indexOf("window");
    const boost = blockedNeighbors >= 3 ? 2.4 : 0.95;
    logits[floorIdx] += boost;
    logits[wallIdx] -= boost * 0.6;
    logits[waterIdx] -= boost * 0.5;
    logits[shelfIdx] -= boost * 0.55;
    logits[windowIdx] -= boost * 0.55;
  } else if (knownNeighbors === 0) {
    logits[TILE_KINDS.indexOf("floor")] += 0.35;
  }

  // 3. 境界の裂け目（rift）: 滲みエントロピーやアンカー境界衝突が高いと開く
  const riftIdx = TILE_KINDS.indexOf("rift");
  if (ctx.hasNearbyRift) {
    logits[riftIdx] -= 4.5;
  } else {
    const shock = ctx.boundaryShock ?? 0;
    const stepLift = Math.min(1.6, ctx.stepsSinceDescend / 28);
    logits[riftIdx] += ctx.bleedEntropy * 1.45 + shock * 2.1 + stepLift;
  }

  return logits;
}

/** 2D 条件付きマルコフ場から 1 タイルを確率サンプリングする。 */
export function sampleNextTile(
  domainWeights: Record<DomainId, number>,
  ctx: NeighborContext,
  temperature: number,
  rng: Rng,
): TileKind {
  const logits = computeTileLogits(domainWeights, ctx);
  const probs = softmax(logits, clampTemperature(temperature));
  return TILE_KINDS[sampleCategorical(probs, rng)];
}
