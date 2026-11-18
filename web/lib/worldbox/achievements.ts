// AGO WORLD BOX の実績・称号定義と判定（純粋ロジック、DOM 非依存）。
// マイクラ型の進捗（採集/建築・クラフト・戦闘・交流）を集計し、
// 条件達成で称号を解放する（コインの直接ミントは行わない）。

export const STAT_KEYS = [
  "chops",
  "mines",
  "harvests",
  "places",
  "fortifies",
  "crafts",
  "smelts",
  "cooks",
  "weaves",
  "enhances",
  "kills",
  "bossKills",
  "dungeons",
  "trades",
  "fishes",
] as const;

export type StatKey = (typeof STAT_KEYS)[number];

export type PlayerStats = Partial<Record<StatKey, number>>;

export type AchievementCategory = "gather" | "craft" | "combat" | "social";

export type AchievementDef = {
  id: string;
  name: string;
  category: AchievementCategory;
  label: string;
  target: number;
  title: string;
  /** true の場合、初達成時に所属ユニオンの Discord チャンネルへ速報を送る。 */
  announce?: boolean;
};

export const ACHIEVEMENT_CATEGORY_NAMES: Record<AchievementCategory, string> = {
  gather: "開拓",
  craft: "クラフト",
  combat: "戦闘",
  social: "交流",
};

/** 装備できる称号の最大文字数（ネームプレート崩れ防止）。 */
export const PLAYER_TITLE_MAX = 12;

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  // 開拓
  { id: "first_chop", name: "森への第一歩", category: "gather", label: "伐採 1回", target: 1, title: "木こり" },
  { id: "master_miner", name: "岩盤を砕く者", category: "gather", label: "採掘 50回", target: 50, title: "鉱夫" },
  { id: "harvest_50", name: "実りの季節", category: "gather", label: "収穫 50回", target: 50, title: "農匠" },
  { id: "master_builder", name: "世界を創る手", category: "gather", label: "建築設置 100回", target: 100, title: "建築家" },
  { id: "iron_bastion", name: "鉄壁の守り手", category: "gather", label: "要塞化 10回", target: 10, title: "城塞守" },
  { id: "angler_20", name: "太公望", category: "gather", label: "釣り 20回", target: 20, title: "釣り師" },

  // クラフト
  { id: "first_craft", name: "職人の目覚め", category: "craft", label: "製作 1回", target: 1, title: "見習い職人" },
  { id: "chef_25", name: "森の料理番", category: "craft", label: "調理 25回", target: 25, title: "料理長" },
  { id: "smith_30", name: "炉端の熟練", category: "craft", label: "精錬・合成 30回", target: 30, title: "鍛冶師" },
  { id: "enchanter", name: "限界突破", category: "craft", label: "道具強化 1回", target: 1, title: "研鑽者", announce: true },
  { id: "recipe_collector", name: "知恵の探究者", category: "craft", label: "レシピ発見 15種", target: 15, title: "博物学者", announce: true },

  // 戦闘
  { id: "first_kill", name: "初陣の勇気", category: "combat", label: "討伐 1体", target: 1, title: "冒険者" },
  { id: "slayer_50", name: "百戦錬磨", category: "combat", label: "討伐 50体", target: 50, title: "討伐隊" },
  { id: "boss_slayer", name: "巨獣を屠る者", category: "combat", label: "ボス討伐 1体", target: 1, title: "竜殺し", announce: true },
  { id: "boss_legend", name: "伝説の英雄", category: "combat", label: "ボス討伐 5体", target: 5, title: "英雄", announce: true },
  { id: "dungeon_conqueror", name: "深淵踏破", category: "combat", label: "迷宮制覇 1回", target: 1, title: "迷宮踏破者", announce: true },

  // 交流
  { id: "first_trade", name: "商いの縁", category: "social", label: "取引完了 1回", target: 1, title: "行商人" },
  { id: "merchant_10", name: "大商人の風格", category: "social", label: "取引完了 10回", target: 10, title: "豪商", announce: true },
];

export type AchievementInput = {
  stats?: PlayerStats;
  discoveredRecipes?: readonly string[];
};

export type AchievementProgress = {
  def: AchievementDef;
  current: number;
  target: number;
  unlocked: boolean;
};

export function sanitizePlayerTitle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, PLAYER_TITLE_MAX);
}

/** 実績 ID ごとの現在達成度を求める（プロフィールの累計統計と発見済みレシピを参照）。 */
export function achievementProgressValue(id: string, input: AchievementInput): number {
  const s = input.stats ?? {};
  switch (id) {
    case "first_chop":
      return s.chops ?? 0;
    case "master_miner":
      return s.mines ?? 0;
    case "harvest_50":
      return s.harvests ?? 0;
    case "master_builder":
      return s.places ?? 0;
    case "iron_bastion":
      return s.fortifies ?? 0;
    case "angler_20":
      return s.fishes ?? 0;
    case "first_craft":
      return (s.crafts ?? 0) + (s.smelts ?? 0) + (s.cooks ?? 0) + (s.weaves ?? 0);
    case "chef_25":
      return s.cooks ?? 0;
    case "smith_30":
      return (s.smelts ?? 0) + (s.crafts ?? 0);
    case "enchanter":
      return s.enhances ?? 0;
    case "recipe_collector":
      return input.discoveredRecipes?.length ?? 0;
    case "first_kill":
      return s.kills ?? 0;
    case "slayer_50":
      return s.kills ?? 0;
    case "boss_slayer":
      return s.bossKills ?? 0;
    case "boss_legend":
      return s.bossKills ?? 0;
    case "dungeon_conqueror":
      return s.dungeons ?? 0;
    case "first_trade":
      return s.trades ?? 0;
    case "merchant_10":
      return s.trades ?? 0;
    default:
      return 0;
  }
}

export function evaluateAchievements(input: AchievementInput): AchievementProgress[] {
  return ACHIEVEMENTS.map((def) => {
    const raw = Math.max(0, Math.floor(achievementProgressValue(def.id, input)));
    const unlocked = raw >= def.target;
    return {
      def,
      current: Math.min(raw, def.target),
      target: def.target,
      unlocked,
    };
  });
}

export function unlockedTitles(input: AchievementInput): string[] {
  return evaluateAchievements(input)
    .filter((a) => a.unlocked)
    .map((a) => a.def.title);
}

export function isTitleUnlocked(input: AchievementInput, title: string): boolean {
  const clean = sanitizePlayerTitle(title);
  if (!clean) return false;
  return unlockedTitles(input).includes(clean);
}

/**
 * before → after の変化で新たに達成された announce=true の実績を返す。
 */
export function newlyUnlockedAnnouncements(
  before: AchievementInput,
  after: AchievementInput,
): AchievementDef[] {
  const prev = new Set(evaluateAchievements(before).filter((a) => a.unlocked).map((a) => a.def.id));
  return evaluateAchievements(after)
    .filter((a) => a.unlocked && a.def.announce && !prev.has(a.def.id))
    .map((a) => a.def);
}
