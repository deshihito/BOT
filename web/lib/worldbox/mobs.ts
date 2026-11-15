// AGO WORLD BOX のモブ定義（純粋ロジック、DOM 非依存）。
// 出現バイオーム・時間帯・密度・サイズとドロップをデータ駆動で持つ。
// 配置はチャンク単位で決定的（特殊オブジェクトと同じ方式）。
// 戦闘そのもの（HP の増減・攻撃判定）はプレイヤー HP 実装側が担い、
// ここは「何が・どこに・どれだけ出て・何を落とすか」の基礎表に徹する。
//
// サイズ規定: モブは size（1〜20）を持ち、占有は size×size マス。
// アンカーは中心タイル (x, y) で、占有範囲は mobFootprintBounds が返す。
// サイズ帯: 1=小型 / 2〜3=中型 / 4〜6=大型 / 7〜12=巨大 / 13〜20=超巨大。
// 大型（size>=4）はチャンク密度では出さず、スーパーセル方式で疎らに置く
// （占有が広いため、密集させるとマップが埋まる）。
import { itemById } from "./items";
import { biomeAt, chunkHash, type BiomeId } from "./maplogic";
import { CHUNK_SIZE } from "./mapgen";

/** 1チャンクに置く小型〜中型モブの合計上限（種ごとの独立抽選だけだと10体超が密集した）。 */
export const MOB_CHUNK_CAP = 4;
/** 同一チャンク内のモブのアンカー間最短距離（チェビシェフ、タイル）。 */
export const MOB_MIN_ANCHOR_DISTANCE = 5;
/** ワールドスポーン地点からこの半径（チェビシェフ、タイル）以内にはモブを置かない。 */
export const MOB_SPAWN_EXCLUSION_RADIUS = 6;
/**
 * スポーン基準タイル = 原点（0,0）。無制限マップ化（#937）で初期スポーンは
 * 原点中心・半径2000のランダム抽選＋原点からの決定的フォールバックになったため、
 * 固定の除外中心は原点に置く（個人ごとのランダムスポーン位置は決定的配置では
 * 除外できないぶん、チャンク上限と最短距離の間引きが受け持つ）。
 */
export const WORLD_SPAWN_TILE = { x: 0, y: 0 };

/** そのタイルがワールドスポーンの除外半径内か。 */
export function isNearWorldSpawn(x: number, y: number): boolean {
  return (
    Math.max(Math.abs(x - WORLD_SPAWN_TILE.x), Math.abs(y - WORLD_SPAWN_TILE.y)) <=
    MOB_SPAWN_EXCLUSION_RADIUS
  );
}

/** モブサイズの下限・上限（マス）。全モブはこの範囲の整数で規定する。 */
export const MOB_SIZE_MIN = 1;
export const MOB_SIZE_MAX = 20;
/** このサイズ以上は「大型」: 密度配置ではなくスーパーセル配置にする。 */
export const LARGE_MOB_SIZE = 4;

export type MobSizeClass = "small" | "medium" | "large" | "huge" | "colossal";

export const MOB_SIZE_CLASSES: readonly { id: MobSizeClass; name: string; min: number; max: number }[] = [
  { id: "small", name: "小型", min: 1, max: 1 },
  { id: "medium", name: "中型", min: 2, max: 3 },
  { id: "large", name: "大型", min: 4, max: 6 },
  { id: "huge", name: "巨大", min: 7, max: 12 },
  { id: "colossal", name: "超巨大", min: 13, max: 20 },
];

/** サイズ（1〜20）からサイズ帯を返す。範囲外は null。 */
export function mobSizeClass(size: unknown): MobSizeClass | null {
  if (typeof size !== "number" || !Number.isInteger(size)) return null;
  return MOB_SIZE_CLASSES.find((c) => size >= c.min && size <= c.max)?.id ?? null;
}

/** 占有範囲（アンカー中心）。size×size マスを返す。 */
export function mobFootprintBounds(
  size: number,
  x: number,
  y: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const left = x - Math.floor(size / 2);
  const top = y - Math.floor(size / 2);
  return { minX: left, minY: top, maxX: left + size - 1, maxY: top + size - 1 };
}

/** そのタイルがモブの占有範囲内か。 */
export function mobOccupiesTile(size: number, x: number, y: number, tx: number, ty: number): boolean {
  const b = mobFootprintBounds(size, x, y);
  return tx >= b.minX && tx <= b.maxX && ty >= b.minY && ty <= b.maxY;
}

export type MobTemperament = "passive" | "neutral" | "hostile";

export type MobDef = {
  id: string;
  name: string;
  temperament: MobTemperament;
  /** 占有サイズ（1〜20 マス、四方）。 */
  size: number;
  hp: number;
  /** 攻撃力の目安（戦闘実装側の基礎値）。 */
  attack: number;
  biomes: readonly BiomeId[];
  /** 出現時間帯。 */
  time: "day" | "night" | "any";
  /** 1チャンクあたりの平均出現数（size<4 のモブのみ使う）。 */
  density: number;
  /** 大型（size>=4）の出現確率（担当スーパーセルに候補が置かれた場合）。 */
  regionChance?: number;
  /** ダンジョン系の別枠マップ専用か。 */
  instanceOnly?: "cave" | "dungeon" | "ruins";
  loot: readonly { itemId: string; min: number; max: number; chance: number }[];
};

export const MOBS: readonly MobDef[] = [
  // ---- 小型（1マス） -------------------------------------------------------
  { id: "mouse", name: "ネズミ", temperament: "passive", size: 1, hp: 3, attack: 0, biomes: ["plains", "forest"], time: "any", density: 0.6, loot: [
    { itemId: "fiber", min: 1, max: 1, chance: 0.5 }, { itemId: "string", min: 1, max: 1, chance: 0.3 }] },
  { id: "chicken", name: "ニワトリ", temperament: "passive", size: 1, hp: 6, attack: 0, biomes: ["plains", "forest"], time: "day", density: 0.7, loot: [
    { itemId: "egg", min: 1, max: 1, chance: 0.6 }, { itemId: "feather", min: 1, max: 2, chance: 1 },
    { itemId: "raw_meat", min: 1, max: 1, chance: 0.8 }] },
  { id: "rabbit", name: "ウサギ", temperament: "passive", size: 1, hp: 4, attack: 0, biomes: ["plains", "forest", "snowfield"], time: "any", density: 0.6, loot: [
    { itemId: "raw_meat", min: 1, max: 1, chance: 0.7 }, { itemId: "feather", min: 1, max: 1, chance: 0.3 }] },
  { id: "frog", name: "カエル", temperament: "passive", size: 1, hp: 4, attack: 0, biomes: ["wetland", "lake"], time: "any", density: 0.6, loot: [
    { itemId: "fish", min: 1, max: 1, chance: 0.3 }] },
  { id: "crab", name: "カニ", temperament: "neutral", size: 1, hp: 7, attack: 2, biomes: ["beach", "lake"], time: "any", density: 0.5, loot: [
    { itemId: "raw_meat", min: 1, max: 1, chance: 0.9 }, { itemId: "fish", min: 1, max: 1, chance: 0.4 }] },
  { id: "bee", name: "ミツバチ", temperament: "neutral", size: 1, hp: 5, attack: 2, biomes: ["forest", "plains"], time: "day", density: 0.4, loot: [
    { itemId: "honey", min: 1, max: 1, chance: 0.7 }] },
  { id: "slime", name: "スライム", temperament: "hostile", size: 1, hp: 10, attack: 3, biomes: ["wetland", "plains", "forest"], time: "any", density: 0.5, loot: [
    { itemId: "slime", min: 1, max: 2, chance: 1 }, { itemId: "slime_core", min: 1, max: 1, chance: 0.2 }] },
  { id: "cave_bat", name: "洞窟コウモリ", temperament: "neutral", size: 1, hp: 6, attack: 2, biomes: ["highland"], time: "any", density: 0.4, instanceOnly: "cave", loot: [
    { itemId: "feather", min: 1, max: 1, chance: 0.5 }, { itemId: "sulfur", min: 1, max: 1, chance: 0.25 }] },
  { id: "cat", name: "ネコ", temperament: "passive", size: 1, hp: 5, attack: 0, biomes: ["plains", "forest"], time: "any", density: 0.5, loot: [
    { itemId: "string", min: 1, max: 1, chance: 0.4 }, { itemId: "fish", min: 1, max: 1, chance: 0.2 }] },
  { id: "dog", name: "イヌ", temperament: "passive", size: 1, hp: 7, attack: 0, biomes: ["plains"], time: "any", density: 0.5, loot: [
    { itemId: "bone", min: 1, max: 1, chance: 0.4 }, { itemId: "raw_meat", min: 1, max: 1, chance: 0.5 }] },
  { id: "duck", name: "アヒル", temperament: "passive", size: 1, hp: 5, attack: 0, biomes: ["lake", "beach"], time: "any", density: 0.6, loot: [
    { itemId: "feather", min: 1, max: 2, chance: 1 }, { itemId: "egg", min: 1, max: 1, chance: 0.5 }] },
  { id: "fox", name: "キツネ", temperament: "neutral", size: 1, hp: 8, attack: 3, biomes: ["forest", "dense_forest"], time: "any", density: 0.35, loot: [
    { itemId: "raw_meat", min: 1, max: 1, chance: 0.8 }, { itemId: "leather", min: 1, max: 1, chance: 0.5 }] },
  { id: "tanuki", name: "タヌキ", temperament: "passive", size: 1, hp: 7, attack: 0, biomes: ["forest"], time: "any", density: 0.4, loot: [
    { itemId: "raw_meat", min: 1, max: 1, chance: 0.7 }, { itemId: "leather", min: 1, max: 1, chance: 0.4 }] },
  { id: "bird_blue", name: "アオトリ", temperament: "passive", size: 1, hp: 3, attack: 0, biomes: ["forest", "plains"], time: "day", density: 0.5, loot: [
    { itemId: "feather", min: 1, max: 2, chance: 1 }] },
  { id: "crow", name: "カラス", temperament: "passive", size: 1, hp: 4, attack: 0, biomes: ["plains", "forest", "highland"], time: "day", density: 0.5, loot: [
    { itemId: "feather", min: 1, max: 2, chance: 1 }] },
  { id: "owl", name: "フクロウ", temperament: "passive", size: 1, hp: 5, attack: 0, biomes: ["forest", "dense_forest"], time: "night", density: 0.35, loot: [
    { itemId: "feather", min: 1, max: 2, chance: 1 }] },
  { id: "penguin", name: "ペンギン", temperament: "passive", size: 1, hp: 6, attack: 0, biomes: ["snowfield", "beach"], time: "any", density: 0.5, loot: [
    { itemId: "feather", min: 1, max: 1, chance: 0.8 }, { itemId: "fish", min: 1, max: 1, chance: 0.5 }] },
  { id: "butterfly", name: "チョウ", temperament: "passive", size: 1, hp: 2, attack: 0, biomes: ["plains", "forest"], time: "day", density: 0.5, loot: [
    { itemId: "fiber", min: 1, max: 1, chance: 0.3 }] },
  { id: "ladybug", name: "テントウムシ", temperament: "passive", size: 1, hp: 3, attack: 0, biomes: ["plains"], time: "day", density: 0.5, loot: [
    { itemId: "herb", min: 1, max: 1, chance: 0.3 }] },
  { id: "snail", name: "カタツムリ", temperament: "passive", size: 1, hp: 4, attack: 0, biomes: ["wetland", "forest"], time: "any", density: 0.4, loot: [
    { itemId: "slime", min: 1, max: 1, chance: 0.4 }] },
  { id: "fish_blue", name: "アオウオ", temperament: "passive", size: 1, hp: 4, attack: 0, biomes: ["lake"], time: "any", density: 0.6, loot: [
    { itemId: "fish", min: 1, max: 2, chance: 1 }] },
  { id: "fish_orange", name: "アカウオ", temperament: "passive", size: 1, hp: 4, attack: 0, biomes: ["lake"], time: "any", density: 0.5, loot: [
    { itemId: "fish", min: 1, max: 2, chance: 1 }, { itemId: "pearl", min: 1, max: 1, chance: 0.15 }] },
  { id: "jellyfish", name: "クラゲ", temperament: "hostile", size: 1, hp: 8, attack: 4, biomes: ["lake"], time: "any", density: 0.4, loot: [
    { itemId: "slime", min: 1, max: 1, chance: 0.6 }, { itemId: "fish", min: 1, max: 1, chance: 0.3 }] },
  { id: "mushroom", name: "キノコモブ", temperament: "neutral", size: 1, hp: 9, attack: 3, biomes: ["forest", "dense_forest"], time: "any", density: 0.35, loot: [
    { itemId: "mushroom", min: 1, max: 2, chance: 1 }, { itemId: "herb", min: 1, max: 1, chance: 0.4 }] },
  // ---- 中型（2〜3マス） -----------------------------------------------------
  { id: "pig", name: "ブタ", temperament: "passive", size: 2, hp: 12, attack: 0, biomes: ["plains", "forest"], time: "any", density: 0.5, loot: [
    { itemId: "raw_meat", min: 1, max: 3, chance: 1 }] },
  { id: "sheep", name: "ヒツジ", temperament: "passive", size: 2, hp: 10, attack: 0, biomes: ["plains"], time: "day", density: 0.5, loot: [
    { itemId: "cloth", min: 1, max: 2, chance: 1 }, { itemId: "raw_meat", min: 1, max: 1, chance: 0.7 }] },
  { id: "cow", name: "ウシ", temperament: "passive", size: 2, hp: 14, attack: 0, biomes: ["plains"], time: "day", density: 0.4, loot: [
    { itemId: "milk", min: 1, max: 2, chance: 0.9 }, { itemId: "leather", min: 1, max: 2, chance: 1 },
    { itemId: "raw_meat", min: 1, max: 2, chance: 0.8 }] },
  { id: "deer", name: "シカ", temperament: "passive", size: 2, hp: 12, attack: 0, biomes: ["plains", "forest", "dense_forest"], time: "day", density: 0.45, loot: [
    { itemId: "raw_meat", min: 1, max: 2, chance: 1 }, { itemId: "leather", min: 1, max: 1, chance: 0.7 }] },
  { id: "horse", name: "ウマ", temperament: "passive", size: 2, hp: 18, attack: 0, biomes: ["plains"], time: "day", density: 0.3, loot: [
    { itemId: "leather", min: 1, max: 2, chance: 1 }] },
  { id: "boar", name: "イノシシ", temperament: "neutral", size: 2, hp: 16, attack: 4, biomes: ["forest", "dense_forest"], time: "any", density: 0.35, loot: [
    { itemId: "raw_meat", min: 2, max: 3, chance: 1 }, { itemId: "leather", min: 1, max: 1, chance: 0.6 }] },
  { id: "wolf", name: "オオカミ", temperament: "hostile", size: 2, hp: 18, attack: 6, biomes: ["forest", "dense_forest", "snow_forest"], time: "night", density: 0.35, loot: [
    { itemId: "wolf_fang", min: 1, max: 1, chance: 0.5 }, { itemId: "raw_meat", min: 1, max: 2, chance: 0.9 },
    { itemId: "leather", min: 1, max: 1, chance: 0.5 }] },
  { id: "spider", name: "クモ", temperament: "hostile", size: 2, hp: 12, attack: 5, biomes: ["dense_forest"], time: "night", density: 0.3, loot: [
    { itemId: "string", min: 1, max: 3, chance: 1 }, { itemId: "silk", min: 1, max: 1, chance: 0.35 }] },
  { id: "skeleton", name: "スケルトン", temperament: "hostile", size: 2, hp: 20, attack: 7, biomes: ["snowfield", "highland"], time: "night", density: 0.25, loot: [
    { itemId: "bone", min: 1, max: 3, chance: 1 }, { itemId: "flint", min: 1, max: 1, chance: 0.3 }] },
  { id: "ghost", name: "ユウレイ", temperament: "hostile", size: 2, hp: 24, attack: 8, biomes: ["dense_forest"], time: "night", density: 0.15, instanceOnly: "dungeon", loot: [
    { itemId: "ghost_tear", min: 1, max: 1, chance: 0.45 }, { itemId: "star_shard", min: 1, max: 1, chance: 0.1 }] },
  { id: "bear", name: "クマ", temperament: "neutral", size: 3, hp: 45, attack: 9, biomes: ["forest", "dense_forest", "snow_forest"], time: "any", density: 0.2, loot: [
    { itemId: "raw_meat", min: 2, max: 4, chance: 1 }, { itemId: "leather", min: 1, max: 2, chance: 0.9 },
    { itemId: "honey", min: 1, max: 1, chance: 0.3 }] },
  { id: "golem", name: "ゴーレム", temperament: "hostile", size: 3, hp: 60, attack: 10, biomes: ["highland"], time: "any", density: 0.18, loot: [
    { itemId: "stone", min: 3, max: 6, chance: 1 }, { itemId: "iron_ore", min: 1, max: 3, chance: 0.8 },
    { itemId: "copper_ore", min: 1, max: 3, chance: 0.6 }] },
  { id: "goat", name: "ヤギ", temperament: "neutral", size: 2, hp: 11, attack: 3, biomes: ["plains", "highland"], time: "any", density: 0.4, loot: [
    { itemId: "raw_meat", min: 1, max: 2, chance: 1 }, { itemId: "leather", min: 1, max: 1, chance: 0.6 },
    { itemId: "milk", min: 1, max: 1, chance: 0.4 }] },
  { id: "octopus", name: "タコ", temperament: "neutral", size: 2, hp: 14, attack: 4, biomes: ["lake"], time: "any", density: 0.3, loot: [
    { itemId: "raw_meat", min: 1, max: 2, chance: 0.9 }, { itemId: "fish", min: 1, max: 1, chance: 0.5 }] },
  { id: "werewolf", name: "ワーウルフ", temperament: "hostile", size: 2, hp: 26, attack: 8, biomes: ["forest", "dense_forest", "snow_forest"], time: "night", density: 0.2, loot: [
    { itemId: "wolf_fang", min: 1, max: 2, chance: 0.7 }, { itemId: "leather", min: 1, max: 2, chance: 0.8 },
    { itemId: "raw_meat", min: 1, max: 2, chance: 0.9 }] },
  // ---- 大型（4〜6マス）: スーパーセル配置 ----------------------------------
  { id: "treant", name: "トレント", temperament: "neutral", size: 4, hp: 80, attack: 12, biomes: ["dense_forest", "forest"], time: "any", density: 0, regionChance: 0.35, loot: [
    { itemId: "wood", min: 5, max: 10, chance: 1 }, { itemId: "herb", min: 2, max: 4, chance: 0.8 },
    { itemId: "star_shard", min: 1, max: 1, chance: 0.1 }] },
  { id: "ogre", name: "オーガ", temperament: "hostile", size: 4, hp: 90, attack: 13, biomes: ["highland"], time: "any", density: 0, regionChance: 0.3, instanceOnly: "dungeon", loot: [
    { itemId: "gold_ore", min: 2, max: 4, chance: 0.9 }, { itemId: "leather", min: 2, max: 3, chance: 1 }] },
  { id: "dungeon_dragon", name: "ダンジョンの竜", temperament: "hostile", size: 5, hp: 120, attack: 16, biomes: ["highland"], time: "any", density: 0, regionChance: 0.25, instanceOnly: "dungeon", loot: [
    { itemId: "dragon_scale", min: 1, max: 3, chance: 1 }, { itemId: "ancient_relic", min: 1, max: 1, chance: 0.5 }] },
  { id: "sea_serpent", name: "ウミヘビ", temperament: "hostile", size: 6, hp: 110, attack: 14, biomes: ["lake"], time: "any", density: 0, regionChance: 0.3, loot: [
    { itemId: "fish", min: 3, max: 6, chance: 1 }, { itemId: "pearl", min: 1, max: 3, chance: 0.8 },
    { itemId: "dragon_scale", min: 1, max: 1, chance: 0.25 }] },
  { id: "spider_queen", name: "クモの女王", temperament: "hostile", size: 6, hp: 105, attack: 15, biomes: ["dense_forest"], time: "night", density: 0, regionChance: 0.3, instanceOnly: "dungeon", loot: [
    { itemId: "silk", min: 3, max: 6, chance: 1 }, { itemId: "slime_core", min: 1, max: 1, chance: 0.3 },
    { itemId: "ghost_tear", min: 1, max: 1, chance: 0.3 }] },
  // ---- 巨大（7〜12マス）: フィールドボス級 ----------------------------------
  { id: "giant_golem", name: "巨大ゴーレム", temperament: "hostile", size: 8, hp: 220, attack: 20, biomes: ["highland"], time: "any", density: 0, regionChance: 0.22, loot: [
    { itemId: "stone", min: 10, max: 20, chance: 1 }, { itemId: "iron_ore", min: 4, max: 8, chance: 1 },
    { itemId: "gold_ore", min: 2, max: 5, chance: 0.8 }, { itemId: "mithril", min: 1, max: 2, chance: 0.4 }] },
  { id: "giant", name: "巨人", temperament: "hostile", size: 10, hp: 320, attack: 24, biomes: ["plains", "highland"], time: "any", density: 0, regionChance: 0.18, loot: [
    { itemId: "gold_ingot", min: 2, max: 4, chance: 0.9 }, { itemId: "ancient_coin", min: 2, max: 5, chance: 0.8 },
    { itemId: "leather", min: 4, max: 8, chance: 1 }] },
  // ---- 超巨大（13〜20マス） ---------------------------------------------------
  { id: "ancient_turtle", name: "古代ガメ", temperament: "passive", size: 15, hp: 500, attack: 0, biomes: ["lake", "beach"], time: "any", density: 0, regionChance: 0.2, loot: [
    { itemId: "pearl", min: 3, max: 6, chance: 1 }, { itemId: "ancient_relic", min: 1, max: 1, chance: 0.4 },
    { itemId: "fish", min: 5, max: 10, chance: 1 }] },
  { id: "world_dragon", name: "ワールドドラゴン", temperament: "hostile", size: 20, hp: 1000, attack: 40, biomes: ["highland", "snowfield"], time: "any", density: 0, regionChance: 0.12, loot: [
    { itemId: "dragon_scale", min: 5, max: 10, chance: 1 }, { itemId: "mithril", min: 3, max: 6, chance: 1 },
    { itemId: "ancient_relic", min: 1, max: 2, chance: 0.9 }, { itemId: "star_shard", min: 1, max: 3, chance: 0.8 }] },
];

const MOB_BY_ID = new Map(MOBS.map((m) => [m.id, m]));
export function mobById(id: unknown): MobDef | null {
  return typeof id === "string" ? MOB_BY_ID.get(id) ?? null : null;
}

export function validateMobs(): string[] {
  const errors: string[] = [];
  for (const mob of MOBS) {
    if (!Number.isInteger(mob.size) || mob.size < MOB_SIZE_MIN || mob.size > MOB_SIZE_MAX) {
      errors.push(`${mob.id}: size out of range ${mob.size}`);
    }
    if (mob.size >= LARGE_MOB_SIZE) {
      if (!(mob.regionChance !== undefined && mob.regionChance > 0 && mob.regionChance <= 1)) {
        errors.push(`${mob.id}: large mob needs regionChance`);
      }
      if (mob.density !== 0) errors.push(`${mob.id}: large mob must use region placement (density 0)`);
    }
    for (const entry of mob.loot) {
      if (!itemById(entry.itemId)) errors.push(`${mob.id}: unknown loot item ${entry.itemId}`);
    }
  }
  return errors;
}

export type PlacedMob = { mobId: string; x: number; y: number; biome: BiomeId; size: number };

/**
 * チャンク内のモブ出現を決定的に返す（地表・小型〜中型のみ）。
 * 大型（size>=4）は largeMobsForChunk が担い、別枠専用は含まない。
 * 占有が複数マスに及ぶモブはアンカー（中心）だけを返し、占有範囲は
 * mobFootprintBounds で求める。
 */
export function mobsForChunk(seed: number, cx: number, cy: number, isNight: boolean): PlacedMob[] {
  // 候補は従来どおり種ごとに決定的に集める（アンカー座標の決め方は変えない）。
  const candidates: PlacedMob[] = [];
  const used = new Set<string>();
  for (const def of MOBS) {
    if (def.instanceOnly || def.density <= 0 || def.size >= LARGE_MOB_SIZE) continue;
    if (def.time === "day" && isNight) continue;
    if (def.time === "night" && !isNight) continue;
    const whole = Math.floor(def.density);
    const frac = def.density - whole;
    let count = whole;
    if (frac > 0 && chunkHash(seed, cx, cy, def.id.length * 271 + 13) < frac) count += 1;
    for (let i = 0; i < count; i++) {
      const salt = def.id.charCodeAt(0) * 733 + def.id.length * 29 + i * 613;
      const lx = Math.floor(chunkHash(seed, cx, cy, salt) * CHUNK_SIZE);
      const ly = Math.floor(chunkHash(seed, cx, cy, salt + 197) * CHUNK_SIZE);
      const x = cx * CHUNK_SIZE + lx;
      const y = cy * CHUNK_SIZE + ly;
      const key = `${x},${y}`;
      if (used.has(key)) continue;
      const biome = biomeAt(seed, x, y);
      if (!def.biomes.includes(biome)) continue;
      used.add(key);
      candidates.push({ mobId: def.id, x, y, biome, size: def.size });
    }
  }
  // 種横断の間引き（沸きすぎ対策）: 決定的順序で走査し、スポーン除外・
  // アンカー間最短距離・チャンク合計上限を満たすものだけを採用する。
  // 順序は座標と種から決まる決定的キーで固定する（定義表の順序に依存しない）。
  const ordered = [...candidates].sort((a, b) => {
    const ka = chunkHash(seed, a.x, a.y, a.mobId.length * 131 + a.mobId.charCodeAt(0));
    const kb = chunkHash(seed, b.x, b.y, b.mobId.length * 131 + b.mobId.charCodeAt(0));
    return ka - kb || a.y - b.y || a.x - b.x || (a.mobId < b.mobId ? -1 : 1);
  });
  const out: PlacedMob[] = [];
  for (const cand of ordered) {
    if (out.length >= MOB_CHUNK_CAP) break;
    if (isNearWorldSpawn(cand.x, cand.y)) continue;
    const tooClose = out.some(
      (m) =>
        Math.max(Math.abs(m.x - cand.x), Math.abs(m.y - cand.y)) < MOB_MIN_ANCHOR_DISTANCE,
    );
    if (tooClose) continue;
    out.push(cand);
  }
  return out;
}

function mobFloorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/**
 * 大型モブ（size>=4、地表分）の配置。スーパーセル方式:
 * セル一辺は size*2 チャンクで、その種の候補はセルに最大1体だけ。
 * 占有が広いぶん、同種同士の最小間隔が構造的に保証される。
 * 返すのは、そのチャンクが候補の「アンカー」を含む場合のみ（最大1体）。
 */
export function largeMobsForChunk(seed: number, cx: number, cy: number, isNight: boolean): PlacedMob[] {
  for (const def of MOBS) {
    if (def.instanceOnly || def.size < LARGE_MOB_SIZE) continue;
    if (def.time === "day" && isNight) continue;
    if (def.time === "night" && !isNight) continue;
    const cellChunks = def.size * 2;
    const cellX = mobFloorDiv(cx, cellChunks);
    const cellY = mobFloorDiv(cy, cellChunks);
    const candCx = cellX * cellChunks + Math.floor(chunkHash(seed, cellX, cellY, def.id.length * 31 + 7) * cellChunks);
    const candCy = cellY * cellChunks + Math.floor(chunkHash(seed, cellX, cellY, def.id.length * 47 + 13) * cellChunks);
    if (candCx !== cx || candCy !== cy) continue;
    if (chunkHash(seed, cx, cy, def.id.length * 59 + 3) >= (def.regionChance ?? 0)) continue;
    const x = cx * CHUNK_SIZE + Math.floor(CHUNK_SIZE / 2);
    const y = cy * CHUNK_SIZE + Math.floor(CHUNK_SIZE / 2);
    if (isNearWorldSpawn(x, y)) continue;
    const biome = biomeAt(seed, x, y);
    if (!def.biomes.includes(biome)) continue;
    return [{ mobId: def.id, x, y, biome, size: def.size }];
  }
  return [];
}
