// LLL（画像鑑定カードバトル）の純粋ロジック。自己完結モジュール
// （import なし）。鑑定（ティア・ステータス・属性の決定的生成）、
// AI 言葉の検証、フォールバック言葉、強化計算、スターター、
// ラダー敵デッキをここに集約する。バトル進行は lib/lll-battle.ts。
//
// 設計原則（仕様 §2）:
// - 同じ画像（同じ特徴量 + 同じ SHA）は必ず同じカードになる。
//   総量（＝強さ）はティア予算でサーバー側が決め、AI は言葉だけを供給する。
// - AI の言葉が検証を通らなければ決定的フォールバックに倒す
//   （捏造で成功にしない）。

export type LllElement = "fire" | "water" | "wind" | "earth" | "light" | "dark";
export type LllTier = "normal" | "elite" | "legend";
export type LllSkillKind = "damage" | "heal" | "shield" | "burn" | "stun" | "guard_break" | "overdrive" | "drain";
export type LllSkill = {
  name: string;
  kind: LllSkillKind;
  power: number;
  cooldown: number;
  ap: number;
  description: string;
};
export type LllTraitKind = "regen" | "thorns" | "haste" | "guard" | "focus";
export type LllTrait = { name: string; kind: LllTraitKind; description: string };
export type LllCard = {
  id: string;
  name: string;
  flavor: string;
  element: LllElement;
  tier: LllTier;
  kind: "action";
  stats: { hp: number; atk: number; def: number; spd: number };
  skills: [LllSkill, LllSkill];
  trait: LllTrait;
  imageDataUrl?: string;
  glyph?: string;
  imageHash?: string;
  level: number;
  createdAt: number;
};
export type ImageFeatures = {
  /** 主要色相 0-360 */
  hue: number;
  /** 彩度 0-1 */
  saturation: number;
  /** 明度 0-1 */
  brightness: number;
  /** 色のばらつき 0-1 */
  colorVariance: number;
  /** エッジ複雑度 0-1 */
  edgeComplexity: number;
  /** 暖かさ 0-1 */
  warmth: number;
  /** 寒さ 0-1 */
  coolness: number;
  pixelHash: string;
};
export type AiWords = {
  name: string;
  flavor: string;
  skillNames: [string, string];
  traitName: string;
};

/** ティア予算（原作 generate-card の正規化規則）。base=平均、min=最低。 */
export const TIER_BUDGET: Record<LllTier, { base: number; min: number }> = {
  normal: { base: 300, min: 100 },
  elite: { base: 360, min: 260 },
  legend: { base: 420, min: 380 },
};
/** ステータス総量の絶対上限。 */
export const STAT_TOTAL_CAP = 500;
/** レベルの上限。 */
export const MAX_LEVEL = 10;
/** 所持上限。 */
export const COLLECTION_CAP = 60;
/** 同一画像の再スカウトで変換される強化の欠片。 */
export const DUPLICATE_SHARDS: Record<LllTier, number> = { normal: 5, elite: 15, legend: 40 };

/* --- 決定的ハッシュ / 乱数 --- */

/** FNV-1a 32bit。文字列から決定的な数値を得る。 */
export function hashString(s: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 文字列シードから [0,1) の決定的な値を得る。 */
export function seeded01(seedKey: string): number {
  return hashString(seedKey) / 4294967296;
}

/** mulberry32。seed から決定的な乱数列を返す。 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pickBySeed<T>(items: readonly T[], seedKey: string): T {
  const index = Math.min(items.length - 1, Math.floor(seeded01(seedKey) * items.length));
  return items[index];
}

/* --- 属性 --- */

/**
 * 特徴量から属性を決める（仕様 §2.3）。
 * 低彩度+高明度=光、低明度=闇を色相より優先し、残りは色相で分ける。
 */
export function elementFromFeatures(f: ImageFeatures): LllElement {
  if (f.saturation < 0.25 && f.brightness > 0.72) return "light";
  if (f.brightness < 0.28) return "dark";
  const hue = ((f.hue % 360) + 360) % 360;
  if (hue < 15 || hue >= 345) return "fire";
  if (hue < 70) return "earth";
  if (hue < 165) return "wind";
  if (hue < 260) return "water";
  return "dark";
}

/** 相性循環: 火→風→土→光→闇→水→火（矢印方向に有利）。 */
const BEATS: Record<LllElement, LllElement> = {
  fire: "wind",
  wind: "earth",
  earth: "light",
  light: "dark",
  dark: "water",
  water: "fire",
};

/** 属性倍率。有利 1.25 / 不利 0.8 / 中立 1。 */
export function affinityMultiplier(atk: LllElement, def: LllElement): number {
  if (BEATS[atk] === def) return 1.25;
  if (BEATS[def] === atk) return 0.8;
  return 1;
}

/* --- ティア --- */

/** ティア決定（仕様 §2.1）。凝った画像ほど特徴量ボーナスで上振れる。 */
export function tierFromFeatures(f: ImageFeatures, imageSha: string): LllTier {
  const roll = seeded01(`${imageSha}:tier`);
  const score = roll + f.edgeComplexity * 0.15 + f.colorVariance * 0.1;
  if (score >= 0.97) return "legend";
  if (score >= 0.78) return "elite";
  return "normal";
}

/* --- 技・特性の説明とプール --- */

const SKILL_DESCRIPTION: Record<LllSkillKind, string> = {
  damage: "敵1体にダメージを与える",
  heal: "味方1体のHPを回復する",
  shield: "味方1体にシールドを付与する",
  burn: "敵1体にダメージを与え、やけどを付与する",
  stun: "敵1体にダメージを与え、スタンを付与する",
  guard_break: "敵1体にダメージを与え、防御崩しを付与する",
  overdrive: "自分の攻撃力を上げる",
  drain: "敵1体にダメージを与え、与えたダメージの半分を回復する",
};

const TRAIT_DESCRIPTION: Record<LllTraitKind, string> = {
  regen: "自分のターン開始時にHPが少し回復する",
  thorns: "受けたダメージの一部を相手に返す",
  haste: "行動順が速くなる",
  guard: "受けるダメージが軽減される",
  focus: "与えるダメージが増える",
};

/** 属性ごとの技種別プール。技1は素直な攻撃系、技2は状態・支援系。 */
const SKILL_POOLS: Record<LllElement, { first: LllSkillKind[]; second: LllSkillKind[]; traits: LllTraitKind[] }> = {
  fire: { first: ["damage", "damage", "drain"], second: ["burn", "overdrive", "guard_break"], traits: ["thorns", "focus", "haste"] },
  water: { first: ["damage", "drain", "damage"], second: ["heal", "shield", "drain"], traits: ["regen", "guard", "focus"] },
  wind: { first: ["damage", "damage", "drain"], second: ["stun", "overdrive", "guard_break"], traits: ["haste", "focus", "thorns"] },
  earth: { first: ["damage", "damage"], second: ["shield", "guard_break", "stun"], traits: ["guard", "thorns", "regen"] },
  light: { first: ["damage", "damage", "drain"], second: ["heal", "overdrive", "shield"], traits: ["regen", "focus", "guard"] },
  dark: { first: ["damage", "drain", "damage"], second: ["drain", "stun", "guard_break"], traits: ["focus", "thorns", "haste"] },
};

/** 属性ごとの技名プール（フォールバックと敵デッキで共用）。 */
const ELEMENT_SKILL_NAMES: Record<LllElement, string[]> = {
  fire: ["紅蓮斬", "灼熱の咆哮", "焔の舞", "火柱崩し", "煉獄の一撃", "燃ゆる牙"],
  water: ["蒼の奔流", "深海の抱擁", "潮騒の刃", "水鏡の守り", "大海の裁き", "雫の連弾"],
  wind: ["疾風裂き", "旋風の舞", "翠の疾走", "風読みの刃", "嵐の呼び声", "空裂き"],
  earth: ["大地の怒り", "岩盤砕き", "黄土の守り", "山鳴り", "堅陣の一撃", "地脈の牙"],
  light: ["暁光斬", "聖なる加護", "白日の裁き", "灯火の祈り", "閃光の連撃", "黎明の盾"],
  dark: ["影縫い", "深淵の囁き", "月蝕の刃", "闇の抱擁", "影喰らい", "夜霧の舞"],
};

function makeSkill(name: string, kind: LllSkillKind, power: number, cooldown: number): LllSkill {
  // AP は表示上の技コストとして保持する（原作 AP=100 固定の名残。仕様 §4）
  return { name, kind, power, cooldown, ap: 100, description: SKILL_DESCRIPTION[kind] };
}

function makeTrait(name: string, kind: LllTraitKind): LllTrait {
  return { name, kind, description: TRAIT_DESCRIPTION[kind] };
}

/* --- AI 言葉の検証（仕様 §2.4） --- */

const FORBIDDEN_WORD_PATTERNS = [/https?:\/\//i, /www\./i, /:\/\//, /[<>`#*_[\]{}|\\]/];

function isCleanWord(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > maxLength) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return !FORBIDDEN_WORD_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * AI が供給する言葉だけを厳密に検証する。
 * 文字数・制御文字・URL・Markdown 記法のいずれかに触れれば null
 * （呼び出し側はフォールバック生成に倒す）。
 */
export function validateAiWords(raw: unknown): AiWords | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (!isCleanWord(record.name, 24)) return null;
  if (!isCleanWord(record.flavor, 120)) return null;
  if (!isCleanWord(record.traitName, 20)) return null;
  const skillNames = record.skillNames;
  if (!Array.isArray(skillNames) || skillNames.length !== 2) return null;
  if (!isCleanWord(skillNames[0], 20) || !isCleanWord(skillNames[1], 20)) return null;
  return {
    name: (record.name as string).trim(),
    flavor: (record.flavor as string).trim(),
    skillNames: [(skillNames[0] as string).trim(), (skillNames[1] as string).trim()],
    traitName: (record.traitName as string).trim(),
  };
}

/* --- フォールバック言葉（決定的生成） --- */

const NAME_PARTS: Record<LllElement, { prefixes: string[]; cores: string[] }> = {
  fire: { prefixes: ["紅蓮の", "灼熱の", "焔を纏う", "燃え盛る"], cores: ["番人", "竜騎士", "精霊", "守護者"] },
  water: { prefixes: ["蒼穹の", "深海の", "星詠みの", "潮騒の"], cores: ["守護者", "番人", "精霊", "詠み手"] },
  wind: { prefixes: ["疾風の", "翠の", "嵐を呼ぶ", "空を駆ける"], cores: ["剣士", "精霊", "旅人", "守護者"] },
  earth: { prefixes: ["大地の", "岩盤の", "黄土の", "山脈の"], cores: ["番人", "ゴーレム", "守護者", "巨人"] },
  light: { prefixes: ["暁光の", "白日の", "黎明の", "灯火の"], cores: ["騎士", "守護者", "番人", "聖者"] },
  dark: { prefixes: ["深淵の", "月蝕の", "影を纏う", "夜霧の"], cores: ["番人", "精霊", "守護者", "使者"] },
};

const FLAVOR_TEMPLATES: Record<LllElement, string[]> = {
  fire: ["燃え上がる想いを刃に宿した番人。", "静かな炎ほど熱いと知る守護者。", "夕映えの色をたたえた戦士。"],
  water: ["静かな青をたたえた守護者。", "深い水底の星明かりを映す存在。", "穏やかな流れと確かな意志を持つ番人。"],
  wind: ["風の行方を読む自由な魂。", "緑のざわめきと共に現れる旅人。", "嵐の前触れを告げる守護者。"],
  earth: ["揺るがぬ大地の意志を宿す番人。", "長い年月を見守ってきた守護者。", "陽だまりの土の匂いをまとう巨人。"],
  light: ["夜明けの光を背に立つ騎士。", "澄んだ光に選ばれた守護者。", "迷う者を照らす灯火の番人。"],
  dark: ["夜の静けさに溶け込む使者。", "影の中でこそ目覚める守護者。", "月明かりだけを道しるべとする番人。"],
};

const TRAIT_NAMES: Record<LllElement, string[]> = {
  fire: ["反撃の炎", "燃ゆる心", "焔の加護"],
  water: ["潮の加護", "再生の雫", "深海の守り"],
  wind: ["風の加護", "疾風の心得", "空の祝福"],
  earth: ["大地の守り", "岩の加護", "揺るがぬ心"],
  light: ["光の加護", "暁の祈り", "守護の心得"],
  dark: ["影の加護", "深淵の眼", "夜の祝福"],
};

/** AI が使えないときの決定的な言葉生成。属性と特徴量の seed で合成する。 */
export function fallbackWords(f: ImageFeatures, imageSha: string): AiWords {
  const element = elementFromFeatures(f);
  const parts = NAME_PARTS[element];
  const name = pickBySeed(parts.prefixes, `${imageSha}:fb-prefix`) + pickBySeed(parts.cores, `${imageSha}:fb-core`);
  const flavor = pickBySeed(FLAVOR_TEMPLATES[element], `${imageSha}:fb-flavor`);
  const skillPool = ELEMENT_SKILL_NAMES[element];
  const firstIndex = Math.floor(seeded01(`${imageSha}:fb-skill`) * skillPool.length);
  const secondIndex = (firstIndex + 1 + Math.floor(seeded01(`${imageSha}:fb-skill2`) * (skillPool.length - 1))) % skillPool.length;
  const traitName = pickBySeed(TRAIT_NAMES[element], `${imageSha}:fb-trait`);
  return { name, flavor, skillNames: [skillPool[firstIndex], skillPool[secondIndex]], traitName };
}

/* --- ステータス配分 --- */

/** total を比率で配分する。各値最低20、端数は HP へ（仕様 §2.2）。 */
function distributeStats(total: number, weights: { hp: number; atk: number; def: number; spd: number }): { hp: number; atk: number; def: number; spd: number } {
  const keys = ["hp", "atk", "def", "spd"] as const;
  const weightSum = weights.hp + weights.atk + weights.def + weights.spd;
  const remaining = Math.max(0, total - 20 * keys.length);
  const stats = { hp: 20, atk: 20, def: 20, spd: 20 };
  let allocated = 20 * keys.length;
  for (const key of keys) {
    const share = Math.floor((remaining * weights[key]) / weightSum);
    stats[key] += share;
    allocated += share;
  }
  stats.hp += total - allocated;
  return stats;
}

/* --- 鑑定（決定的カード生成） --- */

/**
 * 特徴量 + 画像 SHA + 言葉からカードを決定的に生成する（仕様 §2）。
 * 同じ入力からは必ず同じカードになる。now は createdAt として記録する。
 */
export function appraiseDeterministic(f: ImageFeatures, imageSha: string, words: AiWords, now = 0): LllCard {
  const element = elementFromFeatures(f);
  const tier = tierFromFeatures(f, imageSha);
  const budget = TIER_BUDGET[tier];
  const rawTotal = budget.base + Math.round((seeded01(`${imageSha}:total`) - 0.5) * 120);
  const total = clamp(rawTotal, budget.min, STAT_TOTAL_CAP);
  const stats = distributeStats(total, {
    atk: 0.6 + f.saturation * 0.8 + f.warmth * 0.4,
    def: 0.6 + f.coolness * 0.8 + (1 - f.colorVariance) * 0.4,
    spd: 0.5 + f.edgeComplexity * 1.0,
    hp: 0.9 + f.brightness * 0.3,
  });

  const pools = SKILL_POOLS[element];
  const skill1Kind = pickBySeed(pools.first, `${imageSha}:skill1`);
  const skill2Kind = pickBySeed(pools.second, `${imageSha}:skill2`);
  const skill1: LllSkill = makeSkill(words.skillNames[0], skill1Kind, 55, Math.floor(seeded01(`${imageSha}:cd1`) * 2));
  const skill2: LllSkill = makeSkill(words.skillNames[1], skill2Kind, 85, 2 + Math.floor(seeded01(`${imageSha}:cd2`) * 2));
  const traitKind = pickBySeed(pools.traits, `${imageSha}:trait`);

  return {
    id: `card_${imageSha.slice(0, 16)}`,
    name: words.name,
    flavor: words.flavor,
    element,
    tier,
    kind: "action",
    stats,
    skills: [skill1, skill2],
    trait: makeTrait(words.traitName, traitKind),
    imageHash: imageSha,
    level: 1,
    createdAt: now,
  };
}

/* --- 強化（仕様 §5） --- */

/** 枠進化の段階。Lv5 で 1、Lv10 で 2。 */
export function evolutionStage(card: Pick<LllCard, "level">): 0 | 1 | 2 {
  if (card.level >= 10) return 2;
  if (card.level >= 5) return 1;
  return 0;
}

const EVOLUTION_MULTIPLIER = [1, 1.1, 1.21] as const;

/** レベル倍率（×(1+0.08×(Lv-1))、四捨五入）→ 進化倍率の順で適用した実効ステータス。 */
export function effectiveStats(card: LllCard): { hp: number; atk: number; def: number; spd: number } {
  const levelScale = 1 + 0.08 * (clamp(card.level, 1, MAX_LEVEL) - 1);
  const evolution = EVOLUTION_MULTIPLIER[evolutionStage(card)];
  const apply = (value: number) => Math.round(Math.round(value * levelScale) * evolution);
  return { hp: apply(card.stats.hp), atk: apply(card.stats.atk), def: apply(card.stats.def), spd: apply(card.stats.spd) };
}

/** 現在Lvから次Lvへ上げるコスト（欠片）。 */
export function levelUpCost(level: number): number {
  return 8 * level;
}

/* --- スターター（仕様 §1。初回付与の3枚、紋章グラフィック） --- */

function starterCard(
  id: string,
  name: string,
  flavor: string,
  element: LllElement,
  glyph: string,
  stats: LllCard["stats"],
  skills: [LllSkill, LllSkill],
  trait: LllTrait,
): LllCard {
  return { id, name, flavor, element, tier: "normal", kind: "action", stats, skills, trait, glyph, level: 1, createdAt: 0 };
}

export const STARTER_CARDS: LllCard[] = [
  starterCard(
    "starter_knight",
    "暁光の騎士",
    "夜明けの光を背に立つ騎士。",
    "light",
    "⚔",
    { hp: 110, atk: 70, def: 70, spd: 50 },
    [makeSkill("暁光斬", "damage", 55, 0), makeSkill("聖なる加護", "shield", 85, 2)],
    makeTrait("守護の心得", "guard"),
  ),
  starterCard(
    "starter_guardian",
    "星詠みの守護者",
    "星の巡りを読み、仲間を守る守護者。",
    "water",
    "🔮",
    { hp: 120, atk: 55, def: 75, spd: 50 },
    [makeSkill("蒼の奔流", "damage", 55, 1), makeSkill("癒しの星詠み", "heal", 85, 2)],
    makeTrait("再生の雫", "regen"),
  ),
  starterCard(
    "starter_warden",
    "紅蓮の番人",
    "燃え上がる想いを刃に宿した番人。",
    "fire",
    "🔥",
    { hp: 100, atk: 80, def: 55, spd: 65 },
    [makeSkill("紅蓮斬", "damage", 55, 0), makeSkill("灼熱の咆哮", "burn", 85, 2)],
    makeTrait("反撃の炎", "thorns"),
  ),
];

/* --- ラダー（仕様 §4.1） --- */

export type LadderTier = {
  index: number;
  name: string;
  enemyLevel: number;
  winShards: number;
  winLumen: number;
  loseShards: number;
  /** 初回クリア時は報酬2倍（全ティア対象）。 */
  firstClearBonus: boolean;
};

export const LADDER_TIERS: LadderTier[] = [
  { index: 0, name: "試し切り", enemyLevel: 1, winShards: 10, winLumen: 30, loseShards: 2, firstClearBonus: true },
  { index: 1, name: "ブロンズ", enemyLevel: 2, winShards: 14, winLumen: 45, loseShards: 3, firstClearBonus: true },
  { index: 2, name: "シルバー", enemyLevel: 4, winShards: 20, winLumen: 65, loseShards: 4, firstClearBonus: true },
  { index: 3, name: "ゴールド", enemyLevel: 6, winShards: 28, winLumen: 90, loseShards: 5, firstClearBonus: true },
  { index: 4, name: "プラチナ", enemyLevel: 8, winShards: 38, winLumen: 120, loseShards: 6, firstClearBonus: true },
  { index: 5, name: "ダイヤ", enemyLevel: 10, winShards: 50, winLumen: 160, loseShards: 8, firstClearBonus: true },
  { index: 6, name: "マスター", enemyLevel: 10, winShards: 65, winLumen: 210, loseShards: 10, firstClearBonus: true },
  { index: 7, name: "レジェンド", enemyLevel: 10, winShards: 85, winLumen: 280, loseShards: 12, firstClearBonus: true },
];

const LADDER_TEMPLATES: { names: [string, string, string]; elements: [LllElement, LllElement, LllElement] }[] = [
  { names: ["紅蓮の番人", "訓練用ゴーレム", "見習い剣士"], elements: ["fire", "earth", "wind"] },
  { names: ["ブロンズゴーレム", "銅の槍兵", "大地の番人"], elements: ["earth", "wind", "water"] },
  { names: ["シルバーナイト", "銀の射手", "月光の守護者"], elements: ["water", "light", "earth"] },
  { names: ["ゴールドタイタン", "金の魔導士", "太陽の番人"], elements: ["light", "fire", "dark"] },
  { names: ["プラチナセンチネル", "白金の騎士", "星屑の守護者"], elements: ["dark", "water", "wind"] },
  { names: ["ダイヤモンドゴーレム", "蒼玉の魔導士", "結晶の番人"], elements: ["earth", "light", "fire"] },
  { names: ["マスターブレイド", "達人の守護者", "深淵の騎士"], elements: ["fire", "dark", "light"] },
  { names: ["レジェンドドラゴン", "伝説の勇者", "世界樹の守護者"], elements: ["light", "dark", "fire"] },
];

const ELEMENT_GLYPH: Record<LllElement, string> = { fire: "🔥", water: "💧", wind: "🍃", earth: "🪨", light: "✨", dark: "🌙" };

/** ラダー敵デッキ。ティアごとに決定的な3枚（純粋関数: 時刻・乱数なし）。 */
export function ladderDeck(tierIndex: number): LllCard[] {
  const index = clamp(Math.floor(tierIndex), 0, LADDER_TIERS.length - 1);
  const tier = LADDER_TIERS[index];
  const template = LADDER_TEMPLATES[index];
  const cardTier: LllTier = index >= 7 ? "legend" : index >= 6 ? "elite" : "normal";
  const baseTotal = Math.min(STAT_TOTAL_CAP, 280 + index * 45);
  // 役割で比率を少しずつ変える（0=耐久、1=攻撃、2=速さ寄り）
  const weightSets = [
    { hp: 1.2, atk: 0.8, def: 1.0, spd: 0.7 },
    { hp: 0.9, atk: 1.25, def: 0.8, spd: 0.9 },
    { hp: 0.95, atk: 1.0, def: 0.85, spd: 1.25 },
  ];
  return template.names.map((name, slot) => {
    const element = template.elements[slot];
    const total = clamp(baseTotal + (slot - 1) * 10, 100, STAT_TOTAL_CAP);
    const stats = distributeStats(total, weightSets[slot]);
    const seedKey = `ladder:${index}:${slot}`;
    const pools = SKILL_POOLS[element];
    const skillNames = ELEMENT_SKILL_NAMES[element];
    const skills: [LllSkill, LllSkill] = [
      makeSkill(pickBySeed(skillNames, `${seedKey}:s1`), pickBySeed(pools.first, `${seedKey}:k1`), 55, slot % 2),
      makeSkill(pickBySeed(skillNames, `${seedKey}:s2`), pickBySeed(pools.second, `${seedKey}:k2`), 85, 2 + (slot % 2)),
    ];
    return {
      id: `ladder_${index}_${slot}`,
      name,
      flavor: `${tier.name}に立ちはだかる対戦相手。`,
      element,
      tier: cardTier,
      kind: "action" as const,
      stats,
      skills,
      trait: makeTrait(pickBySeed(TRAIT_NAMES[element], `${seedKey}:t`), pickBySeed(pools.traits, `${seedKey}:tk`)),
      glyph: ELEMENT_GLYPH[element],
      level: tier.enemyLevel,
      createdAt: 0,
    };
  });
}
