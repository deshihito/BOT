// AGO WORLD BOX の特殊オブジェクト（純粋ロジック、DOM 非依存）。
// マップ上に点在する「触ると何か起きる」対象の定義と、決定的配置・
// ルート（入手物）ロール・再出現の規則。定義はデータ駆動で、
// 追加はこの表への1行で済む。配置はチャンク単位で決定的に決まるため、
// サーバーに全オブジェクトを保存しなくても全クライアントで一致する。
// 入口系（洞窟/ダンジョン/遺跡）は構造物配置（maplogic.ts の STRUCTURES）
// が担うため、ここには定義を持たない（旧 cave_mouth/dungeon_gate/
// ruins_gate は density 0 で配置されず、実体と二重管理になるため除去）。
import { itemById } from "./items";
import {
  biomeAt, chunkHash, type BiomeId,
} from "./maplogic";
import { CHUNK_SIZE } from "./mapgen";
import { makeRng } from "./rng";

export type ObjectInteraction =
  | "harvest" // 採取（茂み・群生・巣）
  | "mine" // 採掘（鉱脈・クラスター）
  | "open" // 開ける（宝箱。罠の可能性あり）
  | "enter" // 入る（別枠マップへの入口）
  | "rest" // 休む（温泉・祠: 回復）
  | "search" // 調べる（倒木・野営地・石柱）
  | "fish"; // 釣る（魚影）

export type LootEntry = {
  itemId: string;
  min: number;
  max: number;
  /** 0〜1。このエントリが出る確率。 */
  chance: number;
};

export type SpecialObjectDef = {
  id: string;
  name: string;
  interaction: ObjectInteraction;
  /** 出現しうるバイオーム。 */
  biomes: readonly BiomeId[];
  /** 1チャンクあたりの平均出現数（小数可。決定的ロールで使う）。 */
  density: number;
  /** 採取・開封後に再出現するまでの時間（ミリ秒）。0 は再出現しない。 */
  respawnMs: number;
  /** 移動の当たり判定を持つか（入口・石柱は固体、茂み・魚影は通過可）。 */
  solid: boolean;
  /** 必要な道具の種類（無ければ素手でよい）。 */
  tool?: "axe" | "pickaxe";
  /** 必要な道具の最低段位。 */
  minTier?: number;
  /** 入口系の遷移先スペース。 */
  targetSpace?: "cave" | "dungeon" | "ruins" | "lobby";
  /** 宝箱の罠が発動する確率（0〜1）。 */
  trapChance?: number;
  /** 回復量（rest のみ。HP/空腹の回復目安）。 */
  heal?: number;
  loot: readonly LootEntry[];
};

const HOUR = 3600 * 1000;

export const SPECIAL_OBJECTS: readonly SpecialObjectDef[] = [
  // ---- 採取系（自然の恵み） ---------------------------------------------
  { id: "berry_bush", name: "木の実の茂み", interaction: "harvest", biomes: ["plains", "forest", "dense_forest"], density: 0.9, respawnMs: 30 * 60 * 1000, solid: false, loot: [
    { itemId: "berry", min: 1, max: 3, chance: 1 },
    { itemId: "apple", min: 1, max: 1, chance: 0.25 },
    { itemId: "fiber", min: 1, max: 2, chance: 0.5 },
  ] },
  { id: "herb_patch", name: "薬草の群生", interaction: "harvest", biomes: ["plains", "forest", "wetland"], density: 0.8, respawnMs: 20 * 60 * 1000, solid: false, loot: [
    { itemId: "herb", min: 1, max: 3, chance: 1 },
    { itemId: "flower", min: 1, max: 2, chance: 0.4 },
  ] },
  { id: "mushroom_patch", name: "キノコの群生", interaction: "harvest", biomes: ["forest", "dense_forest", "wetland"], density: 0.7, respawnMs: 40 * 60 * 1000, solid: false, loot: [
    { itemId: "mushroom", min: 1, max: 3, chance: 1 },
  ] },
  { id: "flower_meadow", name: "花畑", interaction: "harvest", biomes: ["plains", "wetland"], density: 0.6, respawnMs: 15 * 60 * 1000, solid: false, loot: [
    { itemId: "flower", min: 2, max: 4, chance: 1 },
    { itemId: "fiber", min: 1, max: 2, chance: 0.5 },
  ] },
  { id: "beehive", name: "ミツバチの巣", interaction: "harvest", biomes: ["forest", "dense_forest", "plains"], density: 0.35, respawnMs: 2 * HOUR, solid: true, loot: [
    { itemId: "honey", min: 1, max: 2, chance: 1 },
    { itemId: "beeswax", min: 1, max: 1, chance: 0.6 },
  ] },
  { id: "bird_nest", name: "鳥の巣", interaction: "harvest", biomes: ["forest", "snow_forest", "plains"], density: 0.4, respawnMs: 1 * HOUR, solid: false, loot: [
    { itemId: "egg", min: 1, max: 2, chance: 0.9 },
    { itemId: "feather", min: 1, max: 3, chance: 1 },
  ] },
  // ---- 採掘系（鉱脈） -----------------------------------------------------
  { id: "copper_vein", name: "銅の鉱脈", interaction: "mine", biomes: ["highland", "dryland"], density: 0.6, respawnMs: 3 * HOUR, solid: true, tool: "pickaxe", loot: [
    { itemId: "copper_ore", min: 2, max: 4, chance: 1 },
    { itemId: "stone", min: 1, max: 2, chance: 0.6 },
  ] },
  { id: "coal_vein", name: "石炭の鉱脈", interaction: "mine", biomes: ["highland"], density: 0.55, respawnMs: 3 * HOUR, solid: true, tool: "pickaxe", loot: [
    { itemId: "coal", min: 2, max: 4, chance: 1 },
    { itemId: "flint", min: 1, max: 1, chance: 0.3 },
  ] },
  { id: "rare_vein", name: "希少な鉱脈", interaction: "mine", biomes: ["highland"], density: 0.18, respawnMs: 6 * HOUR, solid: true, tool: "pickaxe", minTier: 2, loot: [
    { itemId: "gold_ore", min: 1, max: 3, chance: 1 },
    { itemId: "ruby", min: 1, max: 1, chance: 0.22 },
    { itemId: "sapphire", min: 1, max: 1, chance: 0.22 },
    { itemId: "emerald", min: 1, max: 1, chance: 0.15 },
    { itemId: "diamond", min: 1, max: 1, chance: 0.1 },
  ] },
  { id: "crystal_cluster", name: "水晶のクラスター", interaction: "mine", biomes: ["highland", "snowfield"], density: 0.22, respawnMs: 6 * HOUR, solid: true, tool: "pickaxe", minTier: 2, loot: [
    { itemId: "crystal_block", min: 1, max: 1, chance: 0.5 },
    { itemId: "diamond", min: 1, max: 1, chance: 0.18 },
    { itemId: "star_shard", min: 1, max: 1, chance: 0.08 },
  ] },
  { id: "mithril_vein", name: "ミスリルの鉱脈", interaction: "mine", biomes: [], density: 0, respawnMs: 6 * HOUR, solid: true, tool: "pickaxe", minTier: 3, loot: [
    { itemId: "mithril", min: 1, max: 2, chance: 1 },
    { itemId: "diamond", min: 1, max: 1, chance: 0.12 },
  ] },
  { id: "sulfur_vent", name: "硫黄の噴気", interaction: "harvest", biomes: ["highland", "dryland"], density: 0.3, respawnMs: 2 * HOUR, solid: false, loot: [
    { itemId: "sulfur", min: 1, max: 3, chance: 1 },
  ] },
  // ---- 宝箱系（遺跡・洞窟・ダンジョンの中身の性格を地表の宝箱にも） -------
  { id: "ruins_chest", name: "遺跡の宝箱", interaction: "open", biomes: ["plains", "forest", "dryland"], density: 0.12, respawnMs: 0, solid: true, trapChance: 0.3, loot: [
    { itemId: "ancient_coin", min: 1, max: 2, chance: 0.9 },
    { itemId: "ancient_relic", min: 1, max: 1, chance: 0.25 },
    { itemId: "gold_ingot", min: 1, max: 2, chance: 0.5 },
    { itemId: "star_map", min: 1, max: 1, chance: 0.2 },
  ] },
  { id: "cave_chest", name: "洞窟の宝箱", interaction: "open", biomes: ["highland"], density: 0.1, respawnMs: 0, solid: true, trapChance: 0.2, loot: [
    { itemId: "gold_ore", min: 2, max: 4, chance: 0.9 },
    { itemId: "emerald", min: 1, max: 1, chance: 0.3 },
    { itemId: "golden_key", min: 1, max: 1, chance: 0.15 },
  ] },
  { id: "dungeon_chest", name: "ダンジョンの宝箱", interaction: "open", biomes: ["dense_forest", "snowfield", "highland"], density: 0.07, respawnMs: 0, solid: true, trapChance: 0.4, loot: [
    { itemId: "ancient_relic", min: 1, max: 1, chance: 0.5 },
    { itemId: "dragon_scale", min: 1, max: 1, chance: 0.3 },
    { itemId: "ghost_tear", min: 1, max: 2, chance: 0.4 },
    { itemId: "mithril", min: 1, max: 2, chance: 0.45 },
  ] },
  // ---- 回復・探索系 ---------------------------------------------------------
  { id: "hot_spring", name: "温泉", interaction: "rest", biomes: ["highland", "snowfield", "forest"], density: 0.15, respawnMs: 0, solid: false, heal: 50, loot: [
    { itemId: "salt", min: 1, max: 2, chance: 0.4 },
  ] },
  { id: "ancient_pillar", name: "古代の石柱", interaction: "search", biomes: ["plains", "dryland", "snowfield"], density: 0.14, respawnMs: 0, solid: true, loot: [
    { itemId: "ancient_coin", min: 1, max: 1, chance: 0.5 },
    { itemId: "star_shard", min: 1, max: 1, chance: 0.1 },
  ] },
  { id: "fallen_log", name: "倒木", interaction: "search", biomes: ["forest", "dense_forest", "snow_forest"], density: 0.5, respawnMs: 4 * HOUR, solid: true, tool: "axe", loot: [
    { itemId: "wood", min: 2, max: 4, chance: 1 },
    { itemId: "mushroom", min: 1, max: 2, chance: 0.45 },
  ] },
  { id: "fishing_spot", name: "魚影", interaction: "fish", biomes: ["lake", "beach", "wetland"], density: 0.8, respawnMs: 10 * 60 * 1000, solid: false, loot: [
    { itemId: "fish", min: 1, max: 2, chance: 1 },
    { itemId: "pearl", min: 1, max: 1, chance: 0.12 },
    { itemId: "salt", min: 1, max: 2, chance: 0.3 },
  ] },
  { id: "driftwood", name: "流木", interaction: "search", biomes: ["beach", "lake"], density: 0.5, respawnMs: 1 * HOUR, solid: false, loot: [
    { itemId: "wood", min: 1, max: 3, chance: 1 },
    { itemId: "rope", min: 1, max: 1, chance: 0.15 },
  ] },
];

const OBJECT_BY_ID = new Map(SPECIAL_OBJECTS.map((o) => [o.id, o]));
export function specialObjectById(id: unknown): SpecialObjectDef | null {
  return typeof id === "string" ? OBJECT_BY_ID.get(id) ?? null : null;
}

/** ルート定義の整合性（全エントリが実在アイテムを指すか）。 */
export function validateSpecialObjects(): string[] {
  const errors: string[] = [];
  for (const def of SPECIAL_OBJECTS) {
    for (const entry of def.loot) {
      if (!itemById(entry.itemId)) errors.push(`${def.id}: unknown loot item ${entry.itemId}`);
      if (entry.min < 0 || entry.max < entry.min) errors.push(`${def.id}: bad loot range ${entry.itemId}`);
      if (entry.chance <= 0 || entry.chance > 1) errors.push(`${def.id}: bad loot chance ${entry.itemId}`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------- 配置
export type PlacedObject = {
  objectId: string;
  x: number;
  y: number;
  biome: BiomeId;
};

/**
 * チャンク内の特殊オブジェクト配置を決定的に返す。
 * density は「チャンクあたり平均個数」: 整数部は確定枠、小数部は確率枠。
 * 位置はチャンク内ハッシュから決め、同じタイルの重複は避ける。
 * 入口系（density 0）は構造物配置（maplogic の STRUCTURES）が担うため
 * ここでは出さない。
 */
export function objectsForChunk(seed: number, cx: number, cy: number): PlacedObject[] {
  const out: PlacedObject[] = [];
  const used = new Set<string>();
  for (const def of SPECIAL_OBJECTS) {
    if (def.density <= 0) continue;
    const whole = Math.floor(def.density);
    const frac = def.density - whole;
    let count = whole;
    if (frac > 0 && chunkHash(seed, cx, cy, def.id.length * 131 + 7) < frac) count += 1;
    for (let i = 0; i < count; i++) {
      const salt = def.id.charCodeAt(0) * 1000 + def.id.length * 17 + i * 977;
      const lx = Math.floor(chunkHash(seed, cx, cy, salt) * CHUNK_SIZE);
      const ly = Math.floor(chunkHash(seed, cx, cy, salt + 331) * CHUNK_SIZE);
      const x = cx * CHUNK_SIZE + lx;
      const y = cy * CHUNK_SIZE + ly;
      const key = `${x},${y}`;
      if (used.has(key)) continue;
      const biome = biomeAt(seed, x, y);
      if (!def.biomes.includes(biome)) continue;
      used.add(key);
      out.push({ objectId: def.id, x, y, biome });
    }
  }
  return out;
}

// ---------------------------------------------------------------- ルート
export type LootResult = {
  gained: Record<string, number>;
  /** 罠が発動したか（宝箱系のみ）。 */
  trapped: boolean;
};

/** ルートをロールする。rng は呼び出し側がシード付きで渡す（決定的に再現可能）。 */
export function rollObjectLoot(def: SpecialObjectDef, rng: () => number): LootResult {
  const gained: Record<string, number> = {};
  for (const entry of def.loot) {
    if (rng() >= entry.chance) continue;
    const count = entry.min + Math.floor(rng() * (entry.max - entry.min + 1));
    if (count > 0) gained[entry.itemId] = (gained[entry.itemId] ?? 0) + count;
  }
  const trapped = def.trapChance !== undefined && rng() < def.trapChance;
  return { gained, trapped };
}

/** 座標とオブジェクト ID から決定的にルートを引く（サーバー/クライアント一致用）。 */
export function lootForObjectAt(seed: number, objectId: string, x: number, y: number, nonce: number): LootResult | null {
  const def = specialObjectById(objectId);
  if (!def) return null;
  let h = (seed ^ Math.imul(x + 101, 374761393) ^ Math.imul(y + 57, 668265263) ^ Math.imul(nonce + 1, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  const rng = makeRng((h ^ (h >>> 16)) >>> 0);
  return rollObjectLoot(def, rng);
}

/** 採取後に再出現しているか。respawnMs=0 の一回きりオブジェクトは常に false。 */
export function objectRespawned(def: SpecialObjectDef, harvestedAt: number | null, now: number): boolean {
  if (harvestedAt === null) return true;
  if (def.respawnMs <= 0) return false;
  return now - harvestedAt >= def.respawnMs;
}

/** 座標にある地表オブジェクトを決定的配置から逆引きする。無ければ null。 */
export function surfaceObjectAt(seed: number, x: number, y: number): PlacedObject | null {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cy = Math.floor(y / CHUNK_SIZE);
  for (const o of objectsForChunk(seed, cx, cy)) {
    if (o.x === x && o.y === y) return o;
  }
  return null;
}

/**
 * 範囲 [x0..x1]×[y0..y1] 内の固体オブジェクトのタイルキー集合
 * （ワールド側の移動衝突判定用）。枯渇しても岩・巣・倒木そのものは
 * 残るため、採取状態には依存しない。
 */
export function surfaceSolidTilesInRect(
  seed: number, x0: number, y0: number, x1: number, y1: number,
): Set<string> {
  const out = new Set<string>();
  const cx0 = Math.floor(x0 / CHUNK_SIZE);
  const cx1 = Math.floor(x1 / CHUNK_SIZE);
  const cy0 = Math.floor(y0 / CHUNK_SIZE);
  const cy1 = Math.floor(y1 / CHUNK_SIZE);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      for (const o of objectsForChunk(seed, cx, cy)) {
        if (o.x < x0 || o.x > x1 || o.y < y0 || o.y > y1) continue;
        if (specialObjectById(o.objectId)?.solid) out.add(`${o.x},${o.y}`);
      }
    }
  }
  return out;
}

/**
 * bot_kv の枯渇状態（キー "x,y" → 採取時刻の文字列/数値）を
 * { "x,y": 時刻 } の辞書へ正規化する。不正なキーは捨てる。
 */
export function parseObjectStates(entries: Map<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, raw] of entries) {
    if (!/^-?\d+,-?\d+$/.test(key)) continue;
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (Number.isFinite(n) && n > 0) out[key] = n;
  }
  return out;
}
