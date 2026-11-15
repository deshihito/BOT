// AGO WORLD BOX のモブ定義（純粋ロジック、DOM 非依存）。
// 出現バイオーム・時間帯・密度とドロップをデータ駆動で持つ。
// 配置はチャンク単位で決定的（特殊オブジェクトと同じ方式）。
// 戦闘そのもの（HP の増減・攻撃判定）はプレイヤー HP 実装側が担い、
// ここは「何が・どこに・どれだけ出て・何を落とすか」の基礎表に徹する。
import { itemById } from "./items";
import { CHUNK_SIZE, biomeAt, chunkHash, type BiomeId } from "./maplogic";

export type MobTemperament = "passive" | "neutral" | "hostile";

export type MobDef = {
  id: string;
  name: string;
  temperament: MobTemperament;
  hp: number;
  /** 攻撃力の目安（戦闘実装側の基礎値）。 */
  attack: number;
  biomes: readonly BiomeId[];
  /** 出現時間帯。 */
  time: "day" | "night" | "any";
  /** 1チャンクあたりの平均出現数。 */
  density: number;
  /** ダンジョン系の別枠マップ専用か。 */
  instanceOnly?: "cave" | "dungeon" | "ruins";
  loot: readonly { itemId: string; min: number; max: number; chance: number }[];
};

export const MOBS: readonly MobDef[] = [
  { id: "chicken", name: "ニワトリ", temperament: "passive", hp: 6, attack: 0, biomes: ["plains", "forest"], time: "day", density: 0.7, loot: [
    { itemId: "egg", min: 1, max: 1, chance: 0.6 }, { itemId: "feather", min: 1, max: 2, chance: 1 },
    { itemId: "raw_meat", min: 1, max: 1, chance: 0.8 }] },
  { id: "pig", name: "ブタ", temperament: "passive", hp: 12, attack: 0, biomes: ["plains", "forest"], time: "any", density: 0.5, loot: [
    { itemId: "raw_meat", min: 1, max: 3, chance: 1 }] },
  { id: "sheep", name: "ヒツジ", temperament: "passive", hp: 10, attack: 0, biomes: ["plains"], time: "day", density: 0.5, loot: [
    { itemId: "cloth", min: 1, max: 2, chance: 1 }, { itemId: "raw_meat", min: 1, max: 1, chance: 0.7 }] },
  { id: "cow", name: "ウシ", temperament: "passive", hp: 14, attack: 0, biomes: ["plains"], time: "day", density: 0.4, loot: [
    { itemId: "milk", min: 1, max: 2, chance: 0.9 }, { itemId: "leather", min: 1, max: 2, chance: 1 },
    { itemId: "raw_meat", min: 1, max: 2, chance: 0.8 }] },
  { id: "rabbit", name: "ウサギ", temperament: "passive", hp: 4, attack: 0, biomes: ["plains", "forest", "snowfield"], time: "any", density: 0.6, loot: [
    { itemId: "raw_meat", min: 1, max: 1, chance: 0.7 }, { itemId: "feather", min: 1, max: 1, chance: 0.3 }] },
  { id: "bee", name: "ミツバチ", temperament: "neutral", hp: 5, attack: 2, biomes: ["forest", "plains"], time: "day", density: 0.4, loot: [
    { itemId: "honey", min: 1, max: 1, chance: 0.7 }] },
  { id: "boar", name: "イノシシ", temperament: "neutral", hp: 16, attack: 4, biomes: ["forest", "dense_forest"], time: "any", density: 0.35, loot: [
    { itemId: "raw_meat", min: 2, max: 3, chance: 1 }, { itemId: "leather", min: 1, max: 1, chance: 0.6 }] },
  { id: "slime", name: "スライム", temperament: "hostile", hp: 10, attack: 3, biomes: ["wetland", "plains", "forest"], time: "any", density: 0.5, loot: [
    { itemId: "slime", min: 1, max: 2, chance: 1 }, { itemId: "slime_core", min: 1, max: 1, chance: 0.2 }] },
  { id: "wolf", name: "オオカミ", temperament: "hostile", hp: 18, attack: 6, biomes: ["forest", "dense_forest", "snow_forest"], time: "night", density: 0.35, loot: [
    { itemId: "wolf_fang", min: 1, max: 1, chance: 0.5 }, { itemId: "raw_meat", min: 1, max: 2, chance: 0.9 },
    { itemId: "leather", min: 1, max: 1, chance: 0.5 }] },
  { id: "spider", name: "クモ", temperament: "hostile", hp: 12, attack: 5, biomes: ["dense_forest"], time: "night", density: 0.3, loot: [
    { itemId: "string", min: 1, max: 3, chance: 1 }, { itemId: "silk", min: 1, max: 1, chance: 0.35 }] },
  { id: "skeleton", name: "スケルトン", temperament: "hostile", hp: 20, attack: 7, biomes: ["snowfield", "highland"], time: "night", density: 0.25, instanceOnly: undefined, loot: [
    { itemId: "bone", min: 1, max: 3, chance: 1 }, { itemId: "flint", min: 1, max: 1, chance: 0.3 }] },
  { id: "cave_bat", name: "洞窟コウモリ", temperament: "neutral", hp: 6, attack: 2, biomes: ["highland"], time: "any", density: 0.4, instanceOnly: "cave", loot: [
    { itemId: "feather", min: 1, max: 1, chance: 0.5 }, { itemId: "sulfur", min: 1, max: 1, chance: 0.25 }] },
  { id: "ghost", name: "ユウレイ", temperament: "hostile", hp: 24, attack: 8, biomes: ["dense_forest"], time: "night", density: 0.15, instanceOnly: "dungeon", loot: [
    { itemId: "ghost_tear", min: 1, max: 1, chance: 0.45 }, { itemId: "star_shard", min: 1, max: 1, chance: 0.1 }] },
  { id: "dungeon_dragon", name: "ダンジョンの竜", temperament: "hostile", hp: 120, attack: 16, biomes: ["highland"], time: "any", density: 0, instanceOnly: "dungeon", loot: [
    { itemId: "dragon_scale", min: 1, max: 3, chance: 1 }, { itemId: "ancient_relic", min: 1, max: 1, chance: 0.5 }] },
];

const MOB_BY_ID = new Map(MOBS.map((m) => [m.id, m]));
export function mobById(id: unknown): MobDef | null {
  return typeof id === "string" ? MOB_BY_ID.get(id) ?? null : null;
}

export function validateMobs(): string[] {
  const errors: string[] = [];
  for (const mob of MOBS) {
    for (const entry of mob.loot) {
      if (!itemById(entry.itemId)) errors.push(`${mob.id}: unknown loot item ${entry.itemId}`);
    }
  }
  return errors;
}

export type PlacedMob = { mobId: string; x: number; y: number; biome: BiomeId };

/** チャンク内のモブ出現を決定的に返す（地表分のみ。別枠専用は含まない）。 */
export function mobsForChunk(seed: number, cx: number, cy: number, isNight: boolean): PlacedMob[] {
  const out: PlacedMob[] = [];
  const used = new Set<string>();
  for (const def of MOBS) {
    if (def.instanceOnly || def.density <= 0) continue;
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
      out.push({ mobId: def.id, x, y, biome });
    }
  }
  return out;
}
