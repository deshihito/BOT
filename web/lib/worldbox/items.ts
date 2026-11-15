// AGO WORLD BOX のアイテム定義（純粋データ＋道具ルール）。
// ブロック（ID 1〜9）に乗らない「物」: 金属インゴットと道具（ツルハシ・剣）。
// 道具はスタックしない単品で、インベントリの1枠を使う。
// 掘削の可否は道具の段階（tier）が決める: 素手では硬い鉱石は掘れない（本当のゲート）。
import { AIR, BEDROCK, COAL_ORE, COPPER_ORE, STONE, hardnessOf } from "./blocks";

export const COPPER_INGOT = 101;
export const WOODEN_PICKAXE = 102;
export const STONE_PICKAXE = 103;
export const COPPER_PICKAXE = 104;
export const SWORD = 105;

export type ItemDef = {
  id: number;
  name: string;
  /** HUD スウォッチの基調色。 */
  color: string;
  colorDark: string;
  /** 道具か（ツルハシ・剣）。道具はスタックせず所持は1つまで。 */
  tool: boolean;
  /** ツルハシの段階（剣・非道具は 0）。 */
  tier: number;
  /** 掘る速さの倍率（素手 = 1）。 */
  digSpeed: number;
  /** 攻撃ダメージ（素手 = HAND_DAMAGE）。 */
  attack: number;
};

/** 素手の攻撃ダメージ。 */
export const HAND_DAMAGE = 2;

export const ITEMS: Record<number, ItemDef> = {
  [COPPER_INGOT]: { id: COPPER_INGOT, name: "銅インゴット", color: "#e07f3f", colorDark: "#b35a24", tool: false, tier: 0, digSpeed: 1, attack: HAND_DAMAGE },
  [WOODEN_PICKAXE]: { id: WOODEN_PICKAXE, name: "木のツルハシ", color: "#a9743f", colorDark: "#7a5230", tool: true, tier: 1, digSpeed: 1.6, attack: HAND_DAMAGE },
  [STONE_PICKAXE]: { id: STONE_PICKAXE, name: "石のツルハシ", color: "#9a9aa0", colorDark: "#6e6e73", tool: true, tier: 2, digSpeed: 2.2, attack: HAND_DAMAGE },
  [COPPER_PICKAXE]: { id: COPPER_PICKAXE, name: "銅のツルハシ", color: "#e07f3f", colorDark: "#8d8d93", tool: true, tier: 3, digSpeed: 3.0, attack: HAND_DAMAGE },
  [SWORD]: { id: SWORD, name: "銅の剣", color: "#f0a35e", colorDark: "#b35a24", tool: true, tier: 0, digSpeed: 1, attack: 4 },
};

export function itemDef(id: number): ItemDef | undefined {
  return ITEMS[id];
}

export function isItemId(id: number): boolean {
  return id >= 100 && !!ITEMS[id];
}

export function isTool(id: number): boolean {
  return ITEMS[id]?.tool ?? false;
}

/** スタックできるか（ブロックとインゴットは可、道具は不可）。 */
export function isStackable(id: number): boolean {
  return !isTool(id);
}

/** 選択中スロットの道具 ID からツルハシ段階を返す（道具でなければ素手 0）。 */
export function tierOfTool(toolId: number | null | undefined): number {
  if (toolId == null) return 0;
  return ITEMS[toolId]?.tier ?? 0;
}

/** 選択中スロットの道具による掘り速さ倍率。 */
export function digSpeedOf(toolId: number | null | undefined): number {
  if (toolId == null) return 1;
  return ITEMS[toolId]?.digSpeed ?? 1;
}

/** 選択中スロットの道具による攻撃ダメージ（剣だけ高い）。 */
export function attackDamageOf(toolId: number | null | undefined): number {
  if (toolId == null) return HAND_DAMAGE;
  return ITEMS[toolId]?.attack ?? HAND_DAMAGE;
}

/** 深い石（銅のツルハシが必要になる深さ）。これより深い石は「深層の石」として扱う。 */
export const DEEP_STONE_Y = 44;

/**
 * そのブロックを掘るのに必要なツルハシ段階。
 * 素手(0): 草・土・砂・原木・葉 / 木(1): 石 / 石(2): 石炭鉱石・銅鉱石 /
 * 銅(3): 深層の石（y >= DEEP_STONE_Y の石）。岩盤は Infinity（掘削不可）。
 */
export function requiredTier(blockId: number, y: number): number {
  if (blockId === BEDROCK || blockId === AIR) return Infinity;
  if (blockId === STONE) return y >= DEEP_STONE_Y ? 3 : 1;
  if (blockId === COAL_ORE || blockId === COPPER_ORE) return 2;
  return 0;
}

/** その道具段階でそのブロックを掘れるか（ゲート判定）。 */
export function canDigWith(blockId: number, y: number, toolTier: number): boolean {
  if (hardnessOf(blockId) === Infinity) return false;
  return toolTier >= requiredTier(blockId, y);
}

/** 掘り切るまでの秒数（硬さ ÷ 道具の速さ）。掘れない道具では Infinity。 */
export function digSecondsFor(blockId: number, y: number, toolId: number | null | undefined): number {
  const tier = tierOfTool(toolId);
  if (!canDigWith(blockId, y, tier)) return Infinity;
  return hardnessOf(blockId) / digSpeedOf(toolId);
}
