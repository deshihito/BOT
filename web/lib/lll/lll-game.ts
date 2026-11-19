// LLL（画像鑑定カードバトル）の純粋ロジック。自己完結モジュール
// （import なし）。鑑定（ティア・ステータス・属性の決定的生成）、
// AI 言葉の検証、フォールバック言葉、強化計算、スターター、
// ラダー敵デッキをここに集約する。バトル進行は lib/lll/lll-battle.ts。
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
  /** 限界突破段階 0〜5（未設定は0扱い）。1凸につき実効ステータス +5%。 */
  limitBreak?: number;
  /** レアリティ覚醒済みフラグ（normal→elite→legend へ昇格した場合に true）。 */
  awakened?: boolean;
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
/** 限界突破の上限（0〜5凸）。 */
export const MAX_LIMIT_BREAK = 5;
/** 所持上限。 */
export const COLLECTION_CAP = 60;
/** 同一画像の再スカウトで変換される強化の欠片。 */
export const DUPLICATE_SHARDS: Record<LllTier, number> = { normal: 5, elite: 15, legend: 40 };
/** 分解時に返還される基本欠片数。 */
export const DISMANTLE_SHARDS: Record<LllTier, number> = { normal: 4, elite: 12, legend: 35 };
/** レアリティ覚醒（昇格）のコスト。 */
export const AWAKEN_COST: Record<"normal" | "elite", { shards: number; lumen: number }> = {
  normal: { shards: 40, lumen: 120 },
  elite: { shards: 100, lumen: 320 },
};

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
export const ELEMENTAL_CYCLE: readonly LllElement[] = ["fire", "wind", "earth", "light", "dark", "water"];

export const BEATS: Record<LllElement, LllElement> = {
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

export const SKILL_DESCRIPTION: Record<LllSkillKind, string> = {
  damage: "敵1体にダメージを与える",
  heal: "味方1体のHPを回復する",
  shield: "味方1体にシールドを付与する",
  burn: "敵1体にダメージを与え、やけどを付与する",
  stun: "敵1体にダメージを与え、スタンを付与する",
  guard_break: "敵1体にダメージを与え、防御崩しを付与する",
  overdrive: "自分の攻撃力を上げる",
  drain: "敵1体にダメージを与え、与えたダメージの半分を回復する",
};

export const TRAIT_DESCRIPTION: Record<LllTraitKind, string> = {
  regen: "自分のターン開始時にHPが少し回復する",
  thorns: "受けたダメージの一部を相手に返す",
  haste: "行動順が速くなる",
  guard: "受けるダメージが軽減される",
  focus: "与えるダメージが増える",
};

export const ALL_TRAIT_KINDS: readonly LllTraitKind[] = ["regen", "thorns", "haste", "guard", "focus"];
export const TUNABLE_SKILL2_KINDS: readonly LllSkillKind[] = [
  "burn",
  "stun",
  "guard_break",
  "overdrive",
  "heal",
  "shield",
  "drain",
];

export const TUNE_TRAIT_COST = { shards: 5, lumen: 25 } as const;
export const TUNE_SKILL2_COST = { shards: 10, lumen: 40 } as const;

export const TRAIT_DEFAULT_NAME: Record<LllTraitKind, string> = {
  regen: "再生の脈動",
  thorns: "茨の反撃",
  haste: "疾風の心得",
  guard: "鉄壁の構え",
  focus: "集中の極意",
};

export const SKILL2_KIND_LABEL: Record<LllSkillKind, string> = {
  damage: "強打",
  heal: "回復",
  shield: "防護シールド",
  burn: "やけど付与",
  stun: "スタン付与",
  guard_break: "防御崩し",
  overdrive: "攻撃上昇",
  drain: "HP吸収",
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

export function makeSkill(name: string, kind: LllSkillKind, power: number, cooldown: number): LllSkill {
  // AP は表示上の技コストとして保持する（原作 AP=100 固定の名残。仕様 §4）
  return { name, kind, power, cooldown, ap: 100, description: SKILL_DESCRIPTION[kind] };
}

export function makeTrait(name: string, kind: LllTraitKind): LllTrait {
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

/** レベル倍率（×(1+0.08×(Lv-1))、四捨五入）→ 進化倍率 → 限界突破倍率（+5%/凸）の順で適用した実効ステータス。 */
export function effectiveStats(card: LllCard): { hp: number; atk: number; def: number; spd: number } {
  const levelScale = 1 + 0.08 * (clamp(card.level, 1, MAX_LEVEL) - 1);
  const evolution = EVOLUTION_MULTIPLIER[evolutionStage(card)];
  const lb = clamp(Math.floor(card.limitBreak ?? 0), 0, MAX_LIMIT_BREAK);
  const lbScale = 1 + 0.05 * lb;
  const apply = (value: number) => {
    const base = Math.round(Math.round(value * levelScale) * evolution);
    return lb > 0 ? Math.round(base * lbScale) : base;
  };
  return { hp: apply(card.stats.hp), atk: apply(card.stats.atk), def: apply(card.stats.def), spd: apply(card.stats.spd) };
}

/** 現在Lvから次Lvへ上げるコスト（欠片）。 */
export function levelUpCost(level: number): number {
  return 8 * level;
}

/** 現在凸数から次の限界突破へ上げるコスト（欠片）。 */
export function limitBreakCost(limitBreak: number): number {
  return 12 * (clamp(Math.floor(limitBreak), 0, MAX_LIMIT_BREAK) + 1);
}

/** 次のレアリティティア。legend なら null。 */
export function nextTier(tier: LllTier): LllTier | null {
  if (tier === "normal") return "elite";
  if (tier === "elite") return "legend";
  return null;
}

/** レアリティ覚醒コスト。legend なら null。 */
export function awakenCost(tier: LllTier): { shards: number; lumen: number } | null {
  if (tier === "normal") return AWAKEN_COST.normal;
  if (tier === "elite") return AWAKEN_COST.elite;
  return null;
}

/** 分解時に得られる欠片（レベルや凸の一部も還元）。 */
export function dismantleShards(card: Pick<LllCard, "tier" | "level" | "limitBreak">): number {
  const base = DISMANTLE_SHARDS[card.tier] ?? 4;
  const lvBonus = Math.max(0, (card.level ?? 1) - 1) * 3;
  const lbBonus = Math.max(0, card.limitBreak ?? 0) * 6;
  return base + lvBonus + lbBonus;
}

/** カードの総合戦闘力（表示用スコア）。 */
export function cardPowerScore(card: LllCard): number {
  const s = effectiveStats(card);
  const tierBonus = card.tier === "legend" ? 1.15 : card.tier === "elite" ? 1.07 : 1;
  return Math.round((s.hp * 0.8 + s.atk * 1.4 + s.def * 1.1 + s.spd * 1.1) * tierBonus);
}

/** UI用のダメージ予測（バトル式の 0.8〜1.2 乱数幅）。 */
export function predictDamageRange(
  attacker: { atk: number; element: LllElement; traitKind?: string; overdrive?: boolean; buffMult?: number },
  target: { def: number; element: LllElement; traitKind?: string; defending?: boolean; guardBreak?: boolean },
  power: number,
): { min: number; max: number; affinity: number } {
  let atk = attacker.atk;
  if (attacker.traitKind === "focus") atk *= 1.1;
  if (attacker.overdrive) atk *= 1.3;
  if (attacker.buffMult && attacker.buffMult > 0) atk *= attacker.buffMult;
  const def = target.def * (target.guardBreak ? 0.6 : 1);
  const affinity = affinityMultiplier(attacker.element, target.element);
  const base =
    power *
    (atk / Math.max(1, atk + def)) *
    affinity *
    (target.defending ? 0.5 : 1) *
    (target.traitKind === "guard" ? 0.9 : 1);
  return {
    min: Math.max(1, Math.floor(base * 0.8)),
    max: Math.max(1, Math.floor(base * 1.2)),
    affinity,
  };
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
    "星",
    { hp: 120, atk: 55, def: 75, spd: 50 },
    [makeSkill("蒼の奔流", "damage", 55, 1), makeSkill("癒しの星詠み", "heal", 85, 2)],
    makeTrait("再生の雫", "regen"),
  ),
  starterCard(
    "starter_warden",
    "紅蓮の番人",
    "燃え上がる想いを刃に宿した番人。",
    "fire",
    "炎",
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

const ELEMENT_GLYPH: Record<LllElement, string> = { fire: "火", water: "水", wind: "風", earth: "土", light: "光", dark: "闇" };

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

/* --- 深淵の試練（エンドコンテンツ連戦） --- */

const ABYSS_ELEMENTS: LllElement[] = ["fire", "water", "wind", "earth", "light", "dark"];
const ABYSS_PREFIXES = ["深淵の", "虚無の", "星骸の", "黄昏の", "永久の", "禁忌の", "蒼穹の", "煉獄の"];
const ABYSS_TITLES = ["監視者", "守護龍", "剣聖", "魔導卿", "使徒", "星詠み", "影騎士", "覇者"];

/** 深淵の試練（階層 1..N）の敵3体デッキ。5階層ごとにボス階。 */
export function abyssEnemyDeck(floor: number): LllCard[] {
  const f = Math.max(1, Math.floor(floor));
  const isBoss = f % 5 === 0;
  const cardTier: LllTier = isBoss || f >= 12 ? "legend" : f >= 5 ? "elite" : "normal";
  const baseTotal = Math.min(STAT_TOTAL_CAP, 300 + f * 18 + (isBoss ? 40 : 0));
  const level = clamp(Math.min(MAX_LEVEL, 2 + Math.floor(f * 0.7)), 1, MAX_LEVEL);
  const limitBreak = clamp(Math.floor(Math.max(0, f - 8) / 3), 0, MAX_LIMIT_BREAK);
  const weightSets = [
    { hp: 1.25, atk: 0.85, def: 1.05, spd: 0.75 },
    { hp: 0.95, atk: 1.3, def: 0.8, spd: 0.95 },
    { hp: 0.9, atk: 1.05, def: 0.85, spd: 1.3 },
  ];
  return [0, 1, 2].map((slot) => {
    const seedKey = `abyss:${f}:${slot}`;
    const element = ABYSS_ELEMENTS[Math.floor(seeded01(`${seedKey}:el`) * ABYSS_ELEMENTS.length)];
    const prefix = pickBySeed(ABYSS_PREFIXES, `${seedKey}:pre`);
    const title = isBoss && slot === 1 ? "深淵魔王" : pickBySeed(ABYSS_TITLES, `${seedKey}:tit`);
    const total = clamp(baseTotal + (slot === 1 && isBoss ? 30 : 0), 100, STAT_TOTAL_CAP);
    const stats = distributeStats(total, weightSets[slot]);
    const pools = SKILL_POOLS[element];
    const skillNames = ELEMENT_SKILL_NAMES[element];
    return {
      id: `abyss_${f}_${slot}`,
      name: `${prefix}${title}`,
      flavor: isBoss ? `深淵第${f}階層を統べる守護主。` : `深淵第${f}階層に潜む影。`,
      element,
      tier: cardTier,
      kind: "action" as const,
      stats,
      skills: [
        makeSkill(pickBySeed(skillNames, `${seedKey}:s1`), pickBySeed(pools.first, `${seedKey}:k1`), 55, slot % 2),
        makeSkill(pickBySeed(skillNames, `${seedKey}:s2`), pickBySeed(pools.second, `${seedKey}:k2`), 85, 2),
      ],
      trait: makeTrait(pickBySeed(TRAIT_NAMES[element], `${seedKey}:t`), pickBySeed(pools.traits, `${seedKey}:tk`)),
      glyph: ELEMENT_GLYPH[element],
      level,
      limitBreak,
      createdAt: 0,
    };
  });
}

/** 深淵の試練クリア時の報酬。 */
export function abyssRewards(floor: number): { shards: number; lumen: number; tickets: number } {
  const f = Math.max(1, Math.floor(floor));
  const isBoss = f % 5 === 0;
  return {
    shards: 12 + f * 4 + (isBoss ? 25 : 0),
    lumen: 35 + f * 12 + (isBoss ? 80 : 0),
    tickets: isBoss ? 1 : 0,
  };
}

/* --- 模擬 PvP ゴーストライバル（規定ライバル） --- */

export type RivalGhostPreset = {
  id: string;
  playerName: string;
  title: string;
  rating: number;
  tacticDeckId: "chain" | "echo" | "pursuit";
  cards: LllCard[];
};

export const RIVAL_GHOST_PRESETS: RivalGhostPreset[] = [
  {
    id: "ghost_iris",
    playerName: "イリス",
    title: "蒼穹の鑑定士",
    rating: 1120,
    tacticDeckId: "chain",
    cards: ladderDeck(2).map((c, idx) => ({ ...c, id: `ghost_iris_${idx}`, level: 5, limitBreak: 1 })),
  },
  {
    id: "ghost_ren",
    playerName: "レン",
    title: "残響の構築者",
    rating: 1340,
    tacticDeckId: "echo",
    cards: ladderDeck(4).map((c, idx) => ({ ...c, id: `ghost_ren_${idx}`, level: 7, limitBreak: 2, tier: "elite" })),
  },
  {
    id: "ghost_kuro",
    playerName: "クロウ",
    title: "深淵の戦術家",
    rating: 1580,
    tacticDeckId: "pursuit",
    cards: ladderDeck(7).map((c, idx) => ({ ...c, id: `ghost_kuro_${idx}`, level: 10, limitBreak: 3, tier: "legend" })),
  },
];

/* --- ログインボーナス / ミッション / 実績（ソシャゲ循環） --- */

export type RewardBundle = { shards: number; lumen: number; tickets: number };

export const LOGIN_BONUS_REWARDS: RewardBundle[] = [
  { shards: 15, lumen: 50, tickets: 1 },
  { shards: 20, lumen: 60, tickets: 0 },
  { shards: 25, lumen: 80, tickets: 1 },
  { shards: 30, lumen: 100, tickets: 0 },
  { shards: 40, lumen: 120, tickets: 1 },
  { shards: 50, lumen: 150, tickets: 0 },
  { shards: 80, lumen: 250, tickets: 2 },
];

export type DailyMissionDef = {
  id: string;
  title: string;
  metric: "scout" | "wins" | "tactics" | "weakHits";
  target: number;
  reward: RewardBundle;
};

export const DAILY_MISSIONS: DailyMissionDef[] = [
  { id: "daily_scout_1", title: "画像を1回スカウトする", metric: "scout", target: 1, reward: { shards: 12, lumen: 40, tickets: 0 } },
  { id: "daily_win_2", title: "バトルで2回勝利する", metric: "wins", target: 2, reward: { shards: 20, lumen: 70, tickets: 1 } },
  { id: "daily_tactic_5", title: "戦術カードを累計5枚使う", metric: "tactics", target: 5, reward: { shards: 15, lumen: 50, tickets: 0 } },
  { id: "daily_weak_3", title: "属性弱点を3回突く", metric: "weakHits", target: 3, reward: { shards: 18, lumen: 60, tickets: 0 } },
];

export type AchievementDef = {
  id: string;
  title: string;
  description: string;
  reward: RewardBundle;
};

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: "ach_cards_5", title: "鑑定の見習い", description: "カードを5枚以上所持する", reward: { shards: 20, lumen: 60, tickets: 1 } },
  { id: "ach_cards_12", title: "記憶の収集家", description: "カードを12枚以上所持する", reward: { shards: 45, lumen: 140, tickets: 2 } },
  { id: "ach_wins_5", title: "アリーナの挑戦者", description: "通算5勝を達成する", reward: { shards: 30, lumen: 90, tickets: 1 } },
  { id: "ach_legend_1", title: "黄金の切り札", description: "レジェンドカードを所持または覚醒させる", reward: { shards: 50, lumen: 160, tickets: 2 } },
  { id: "ach_lv10_1", title: "極致の一枚", description: "カードをLv10まで強化する", reward: { shards: 60, lumen: 180, tickets: 1 } },
  { id: "ach_abyss_5", title: "深淵踏破者", description: "深淵の試練 第5階層をクリアする", reward: { shards: 75, lumen: 240, tickets: 2 } },
  { id: "ach_relic_1", title: "遺物の鍛冶師", description: "遺物を1つ鍛造する", reward: { shards: 25, lumen: 80, tickets: 1 } },
  { id: "ach_wins_10", title: "歴戦の調律者", description: "通算10勝を達成する", reward: { shards: 55, lumen: 180, tickets: 2 } },
];

/* --- 属性共鳴（編成ボーナス） --- */

export type PartyResonanceId = "mono" | "dual" | "eclipse" | "triad" | "harmony";

export type PartyResonance = {
  id: PartyResonanceId;
  name: string;
  shortLabel: string;
  description: string;
  /** mono / dual の主軸属性（任意）。 */
  element?: LllElement;
  atkMult: number;
  defMult: number;
  spdMult: number;
  healShieldMult: number;
  weakBonusMult: number;
  startBurst: number;
};

export const PARTY_RESONANCE_CATALOG: Omit<PartyResonance, "element">[] = [
  {
    id: "mono",
    name: "単色極致",
    shortLabel: "同属性×3",
    description: "ATK +16% / 共鳴バースト初期値 +25%",
    atkMult: 1.16,
    defMult: 1,
    spdMult: 1,
    healShieldMult: 1,
    weakBonusMult: 1,
    startBurst: 25,
  },
  {
    id: "eclipse",
    name: "光闇交錯",
    shortLabel: "光＋闇を含む",
    description: "ATK +8% / 弱点ダメージさらに +12%",
    atkMult: 1.08,
    defMult: 1,
    spdMult: 1,
    healShieldMult: 1,
    weakBonusMult: 1.12,
    startBurst: 10,
  },
  {
    id: "dual",
    name: "双星共鳴",
    shortLabel: "同属性×2",
    description: "ATK +9% / SPD +6%",
    atkMult: 1.09,
    defMult: 1,
    spdMult: 1.06,
    healShieldMult: 1,
    weakBonusMult: 1,
    startBurst: 10,
  },
  {
    id: "triad",
    name: "四元循環",
    shortLabel: "火・水・風・土から3種",
    description: "SPD +10% / 弱点ダメージさらに +10%",
    atkMult: 1,
    defMult: 1,
    spdMult: 1.1,
    healShieldMult: 1,
    weakBonusMult: 1.1,
    startBurst: 10,
  },
  {
    id: "harmony",
    name: "三界調和",
    shortLabel: "異なる3属性",
    description: "ATK +6% / DEF +6% / 回復・シールド +10%",
    atkMult: 1.06,
    defMult: 1.06,
    spdMult: 1,
    healShieldMult: 1.1,
    weakBonusMult: 1,
    startBurst: 0,
  },
];

const CORE_FOUR_ELEMENTS = new Set<LllElement>(["fire", "water", "wind", "earth"]);
const ELEMENT_JP: Record<LllElement, string> = {
  fire: "火",
  water: "水",
  wind: "風",
  earth: "土",
  light: "光",
  dark: "闇",
};

/** 3枚（または任意枚数）の編成から発動する属性共鳴を判定する。 */
export function evaluatePartyResonance(cards: readonly { element: LllElement }[]): PartyResonance {
  const counts = new Map<LllElement, number>();
  for (const c of cards) {
    counts.set(c.element, (counts.get(c.element) ?? 0) + 1);
  }
  const byId = (id: PartyResonanceId) => PARTY_RESONANCE_CATALOG.find((r) => r.id === id)!;

  for (const [el, cnt] of counts.entries()) {
    if (cnt >= 3) {
      const base = byId("mono");
      return { ...base, name: `${ELEMENT_JP[el]}・${base.name}`, element: el };
    }
  }
  if ((counts.get("light") ?? 0) >= 1 && (counts.get("dark") ?? 0) >= 1) {
    return { ...byId("eclipse") };
  }
  for (const [el, cnt] of counts.entries()) {
    if (cnt >= 2) {
      const base = byId("dual");
      return { ...base, name: `${ELEMENT_JP[el]}・${base.name}`, element: el };
    }
  }
  const uniqueCore = [...counts.keys()].filter((el) => CORE_FOUR_ELEMENTS.has(el)).length;
  if (uniqueCore >= 3) {
    return { ...byId("triad") };
  }
  return { ...byId("harmony") };
}

/* --- フィールド地脈（アリーナギミック） --- */

export type BattleFieldId =
  | "neutral"
  | "inferno"
  | "mirror_lake"
  | "gale_corridor"
  | "monolith"
  | "eclipse_sanctum"
  | "abyss_miasma";

export type BattleFieldDef = {
  id: BattleFieldId;
  name: string;
  shortTag: string;
  description: string;
  accentHex: string;
  /** 3Dアリーナの床リング＆ライティング色。 */
  arenaTintHex: string;
  /** 該当属性への攻撃強化（1.0 = 等倍）。 */
  elementBoost?: Partial<Record<LllElement, number>>;
  healShieldMult?: number;
  burnDamageMult?: number;
  weakBonusMult?: number;
  guardMult?: number;
  roundErosionPct?: number;
};

export const BATTLE_FIELDS: BattleFieldDef[] = [
  {
    id: "neutral",
    name: "調律の石盤",
    shortTag: "標準地脈",
    description: "属性補正のない均整の取れた戦場。基本の相性と戦術が勝敗を分ける。",
    accentHex: "#d4a24c",
    arenaTintHex: "#8a7a5a",
  },
  {
    id: "inferno",
    name: "紅蓮の炉心",
    shortTag: "火強化・灼熱",
    description: "火属性の与ダメージ +15% / やけどダメージが 1.5倍。",
    accentHex: "#e06d53",
    arenaTintHex: "#b8462c",
    elementBoost: { fire: 1.15 },
    burnDamageMult: 1.5,
  },
  {
    id: "mirror_lake",
    name: "鏡面の蒼湖",
    shortTag: "水強化・癒し",
    description: "水属性の与ダメージ +15% / すべての回復・シールド効果 +20%。",
    accentHex: "#4e98c8",
    arenaTintHex: "#2d6f9e",
    elementBoost: { water: 1.15 },
    healShieldMult: 1.2,
  },
  {
    id: "gale_corridor",
    name: "蒼穹の風廊",
    shortTag: "風強化・疾走",
    description: "風属性の与ダメージ +15% / 共鳴バーストの蓄積速度 +25%。",
    accentHex: "#55b084",
    arenaTintHex: "#2e7f5a",
    elementBoost: { wind: 1.15 },
  },
  {
    id: "monolith",
    name: "玄武の岩窟",
    shortTag: "土強化・堅牢",
    description: "土属性の与ダメージ +15% / 防御時の軽減がさらに強化（被ダメ 0.4倍）。",
    accentHex: "#c99a49",
    arenaTintHex: "#8d6b32",
    elementBoost: { earth: 1.15 },
    guardMult: 0.4,
  },
  {
    id: "eclipse_sanctum",
    name: "黄昏の聖域",
    shortTag: "光闇強化・鋭利",
    description: "光・闇属性の与ダメージ +15% / 属性弱点ダメージさらに +12%。",
    accentHex: "#d7b46a",
    arenaTintHex: "#7b6c4a",
    elementBoost: { light: 1.15, dark: 1.15 },
    weakBonusMult: 1.12,
  },
  {
    id: "abyss_miasma",
    name: "深淵の瘴気",
    shortTag: "毎R侵蝕・高揚",
    description: "毎ラウンド開始時に全員へ最大HPの3%侵蝕（最低HP1残る） / 反応ダメージ +20%。",
    accentHex: "#c46373",
    arenaTintHex: "#7d2e3d",
    roundErosionPct: 0.03,
  },
];

export const BATTLE_FIELD_BY_ID: Record<BattleFieldId, BattleFieldDef> = Object.fromEntries(
  BATTLE_FIELDS.map((f) => [f.id, f]),
) as Record<BattleFieldId, BattleFieldDef>;

const LADDER_FIELD_SEQUENCE: BattleFieldId[] = [
  "neutral",
  "monolith",
  "mirror_lake",
  "eclipse_sanctum",
  "gale_corridor",
  "inferno",
  "eclipse_sanctum",
  "abyss_miasma",
];

export function fieldForLadderTier(tierIndex: number): BattleFieldId {
  const idx = clamp(Math.floor(tierIndex), 0, LADDER_FIELD_SEQUENCE.length - 1);
  return LADDER_FIELD_SEQUENCE[idx];
}

const ABYSS_FIELD_CYCLE: BattleFieldId[] = [
  "inferno",
  "mirror_lake",
  "gale_corridor",
  "monolith",
  "abyss_miasma",
];

export function fieldForAbyssFloor(floor: number): BattleFieldId {
  const f = Math.max(1, Math.floor(floor));
  if (f % 5 === 0) return "abyss_miasma";
  return ABYSS_FIELD_CYCLE[(f - 1) % ABYSS_FIELD_CYCLE.length];
}

export function fieldForPvpRival(rivalId: string): BattleFieldId {
  if (rivalId === "ghost_iris") return "mirror_lake";
  if (rivalId === "ghost_ren") return "gale_corridor";
  if (rivalId === "ghost_kuro") return "eclipse_sanctum";
  return "neutral";
}

/* --- 属性反応（状態異常×攻撃属性コンボ） --- */

export type ElementalReactionId = "vaporize" | "spread" | "shatter" | "judgment" | "overload";

export type ElementalReactionDef = {
  id: ElementalReactionId;
  name: string;
  triggerElement: LllElement | "light_or_dark";
  requiredStatus: "burn" | "guard_break" | "stun";
  consumesStatus: boolean;
  /** 直前ダメージに対する追加ダメージ係数（または固定最小値あり）。 */
  bonusRatio: number;
  minBonus: number;
  extraEffect: string;
  summary: string;
};

export const ELEMENTAL_REACTIONS: ElementalReactionDef[] = [
  {
    id: "vaporize",
    name: "蒸発",
    triggerElement: "water",
    requiredStatus: "burn",
    consumesStatus: true,
    bonusRatio: 0.45,
    minBonus: 14,
    extraEffect: "やけどを消費して大ダメージ",
    summary: "やけど中の敵へ水属性攻撃 → やけど消費＋与ダメの45%追加ダメージ",
  },
  {
    id: "spread",
    name: "熱風拡散",
    triggerElement: "wind",
    requiredStatus: "burn",
    consumesStatus: false,
    bonusRatio: 0.22,
    minBonus: 8,
    extraEffect: "他の生存敵にもやけど(2T)を拡散",
    summary: "やけど中の敵へ風属性攻撃 → 22%追加ダメージ＋他の敵全員にやけど拡散",
  },
  {
    id: "shatter",
    name: "岩盤粉砕",
    triggerElement: "earth",
    requiredStatus: "guard_break",
    consumesStatus: true,
    bonusRatio: 0.35,
    minBonus: 12,
    extraEffect: "防御崩しを消費し、攻撃者にシールド+24",
    summary: "防御崩し中の敵へ土属性攻撃 → 防御崩し消費＋35%追加ダメージ＋自身シールド24",
  },
  {
    id: "judgment",
    name: "断罪閃光",
    triggerElement: "light_or_dark",
    requiredStatus: "stun",
    consumesStatus: false,
    bonusRatio: 0.4,
    minBonus: 14,
    extraEffect: "スタン中の敵へ追撃＋防御崩し(2T)",
    summary: "スタン中の敵へ光/闇属性攻撃 → 40%追加ダメージ＋防御崩し(2T)",
  },
  {
    id: "overload",
    name: "過負荷",
    triggerElement: "fire",
    requiredStatus: "guard_break",
    consumesStatus: true,
    bonusRatio: 0.35,
    minBonus: 12,
    extraEffect: "防御崩しを消費し、共鳴バースト +18%",
    summary: "防御崩し中の敵へ火属性攻撃 → 防御崩し消費＋35%追加ダメージ＋バースト+18%",
  },
];

/** 攻撃属性と対象の現在状態から誘発する属性反応を返す（該当なければ null）。 */
export function detectElementalReaction(
  attackElement: LllElement,
  targetStatuses: readonly { kind: string }[],
): ElementalReactionDef | null {
  const has = (k: string) => targetStatuses.some((s) => s.kind === k);
  for (const r of ELEMENTAL_REACTIONS) {
    if (!has(r.requiredStatus)) continue;
    if (r.triggerElement === "light_or_dark") {
      if (attackElement === "light" || attackElement === "dark") return r;
    } else if (r.triggerElement === attackElement) {
      return r;
    }
  }
  return null;
}

/* --- 共鳴バースト（チーム必殺技） --- */

export const RESONANCE_BURST_INFO: Record<LllElement, { name: string; summary: string }> = {
  fire: { name: "紅蓮覇壊", summary: "敵全体へ威力68ダメージ＋全員にやけど(2T)" },
  water: { name: "蒼穹星癒", summary: "敵全体へ威力52ダメージ＋味方全員を回復＆シールド20" },
  wind: { name: "烈風連刃", summary: "敵全体へ威力58ダメージ＋戦術カードを2枚ドロー" },
  earth: { name: "玄武要塞", summary: "味方全員にシールド45＋敵全体へ威力42ダメージ" },
  light: { name: "暁光裁定", summary: "敵単体へ威力115の極大ダメージ＋味方全員にシールド20" },
  dark: { name: "深淵蝕滅", summary: "敵全体へ威力64ダメージ＋敵全員に防御崩し(2T)＋HP吸収" },
};

/* --- 遺物（アーティファクト装備: 最大2枠） --- */

export type LllRelicId =
  | "relic_aegis"
  | "relic_chronometer"
  | "relic_ember_core"
  | "relic_prism_lens"
  | "relic_resonance_bell"
  | "relic_vampire_fang"
  | "relic_iron_vow"
  | "relic_gale_feather";

export type LllRelicDef = {
  id: LllRelicId;
  name: string;
  category: "offense" | "defense" | "tactics" | "resonance";
  summary: string;
  craftShards: number;
  craftLumen: number;
};

export const MAX_EQUIPPED_RELICS = 2;

export const RELICS: LllRelicDef[] = [
  {
    id: "relic_aegis",
    name: "真鍮の防壁章",
    category: "defense",
    summary: "開幕時、味方全員にシールド +28 を付与。",
    craftShards: 18,
    craftLumen: 90,
  },
  {
    id: "relic_chronometer",
    name: "星刻の懐中時計",
    category: "tactics",
    summary: "開幕の戦術TP +1・初期手札 +1枚。",
    craftShards: 22,
    craftLumen: 110,
  },
  {
    id: "relic_ember_core",
    name: "炉心の熾火玉",
    category: "offense",
    summary: "与ダメージ +8%、敵へのやけどダメージ +35%。",
    craftShards: 24,
    craftLumen: 120,
  },
  {
    id: "relic_prism_lens",
    name: "分光プリズム",
    category: "offense",
    summary: "弱点ダメージさらに +15%、属性反応ダメージ +25%。",
    craftShards: 28,
    craftLumen: 140,
  },
  {
    id: "relic_resonance_bell",
    name: "共鳴の調律鈴",
    category: "resonance",
    summary: "共鳴バースト初期値 +35%、蓄積速度 +20%。",
    craftShards: 26,
    craftLumen: 130,
  },
  {
    id: "relic_vampire_fang",
    name: "紅玉の吸血牙",
    category: "defense",
    summary: "直接攻撃の与ダメージの 12% を自身のHPとして吸収。",
    craftShards: 30,
    craftLumen: 150,
  },
  {
    id: "relic_iron_vow",
    name: "黒鉄の誓約印",
    category: "defense",
    summary: "防御コマンド選択時、自身にシールド +24 とバースト +10%。",
    craftShards: 20,
    craftLumen: 100,
  },
  {
    id: "relic_gale_feather",
    name: "白銀の疾風羽",
    category: "tactics",
    summary: "味方全員の行動順 SPD +12%。先手を取りやすい。",
    craftShards: 22,
    craftLumen: 110,
  },
];

export const RELIC_BY_ID: Record<string, LllRelicDef> = Object.fromEntries(
  RELICS.map((r) => [r.id, r]),
);


