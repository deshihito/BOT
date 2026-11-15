// AGO WORLD BOX のクラフトと精錬（純粋ロジック）。
// レシピは素材2種まで・成果物1種に収め、5枠インベントリでも回るようにする。
// 精錬はパネル内の「かまど」: 銅鉱石1＋石炭鉱石1 → 銅インゴット1（数秒）。
// かまどの成果物は枠が空くまで かまど側に留まり、受け取りボタンで回収する。
import { COAL_ORE, COPPER_ORE, STONE, TORCH, WOOD, WORKBENCH } from "./blocks";
import { COPPER_INGOT, COPPER_PICKAXE, STONE_PICKAXE, SWORD, WOODEN_PICKAXE, isTool } from "./items";
import { addItem, canAdd, countOf, removeItem, type InventoryV2 } from "./inventory";

export type Recipe = {
  id: string;
  name: string;
  output: number;
  /** 1回のクラフトで得られる個数（既定1。松明は4）。 */
  outputCount?: number;
  costs: { id: number; count: number }[];
};

export const RECIPES: Recipe[] = [
  { id: "wooden_pickaxe", name: "木のツルハシ", output: WOODEN_PICKAXE, costs: [{ id: WOOD, count: 3 }] },
  {
    id: "stone_pickaxe",
    name: "石のツルハシ",
    output: STONE_PICKAXE,
    costs: [
      { id: STONE, count: 3 },
      { id: WOOD, count: 2 },
    ],
  },
  {
    id: "copper_pickaxe",
    name: "銅のツルハシ",
    output: COPPER_PICKAXE,
    costs: [
      { id: COPPER_INGOT, count: 3 },
      { id: WOOD, count: 2 },
    ],
  },
  {
    id: "sword",
    name: "銅の剣",
    output: SWORD,
    costs: [
      { id: COPPER_INGOT, count: 2 },
      { id: WOOD, count: 1 },
    ],
  },
  {
    // 松明: 石炭鉱石は精錬に回さず、そのまま燃料として使う（石炭アイテムは別にない）
    id: "torch",
    name: "松明",
    output: TORCH,
    outputCount: 4,
    costs: [
      { id: COAL_ORE, count: 1 },
      { id: WOOD, count: 1 },
    ],
  },
  {
    id: "workbench",
    name: "作業台",
    output: WORKBENCH,
    costs: [{ id: WOOD, count: 4 }],
  },
];

export function recipeById(id: string): Recipe | undefined {
  return RECIPES.find((r) => r.id === id);
}

export type CraftCheck = "ok" | "materials" | "no_slot" | "owned";

/** 作れるかの事前判定（UI のボタン活性と理由表示に使う）。 */
export function checkCraft(inv: InventoryV2, recipe: Recipe): CraftCheck {
  // 「所持済み」で止めるのは道具だけ（松明・作業台は何個でも作れる）
  if (isTool(recipe.output) && countOf(inv, recipe.output) > 0) return "owned";
  for (const cost of recipe.costs) {
    if (countOf(inv, cost.id) < cost.count) return "materials";
  }
  if (!canAdd(inv, recipe.output, recipe.outputCount ?? 1)) return "no_slot";
  return "ok";
}

/** クラフトを実行する。checkCraft が "ok" のときだけ成功する。 */
export function applyCraft(inv: InventoryV2, recipe: Recipe): boolean {
  if (checkCraft(inv, recipe) !== "ok") return false;
  for (const cost of recipe.costs) removeItem(inv, cost.id, cost.count);
  addItem(inv, recipe.output, recipe.outputCount ?? 1);
  return true;
}

// ---- 精錬（かまど） ----

/** 1回の精錬にかかる秒数。 */
export const SMELT_SECONDS = 4;

export type Furnace = {
  /** 精錬中なら残り秒数。待機中は null。 */
  smelting: { remaining: number } | null;
  /** 焼き上がって かまど に留まっている銅インゴットの数。 */
  output: number;
};

export function createFurnace(): Furnace {
  return { smelting: null, output: 0 };
}

/** 精錬を始められるか（かまどが空き、素材が揃っている）。 */
export function canStartSmelt(furnace: Furnace, inv: InventoryV2): boolean {
  return furnace.smelting === null && countOf(inv, COPPER_ORE) >= 1 && countOf(inv, COAL_ORE) >= 1;
}

/** 精錬開始: 銅鉱石1と石炭鉱石1を消費する。 */
export function startSmelt(furnace: Furnace, inv: InventoryV2): boolean {
  if (!canStartSmelt(furnace, inv)) return false;
  removeItem(inv, COPPER_ORE, 1);
  removeItem(inv, COAL_ORE, 1);
  furnace.smelting = { remaining: SMELT_SECONDS };
  return true;
}

/** かまどを dt 秒進める。焼き上がったら true（output が1増える）。 */
export function tickFurnace(furnace: Furnace, dt: number): boolean {
  if (!furnace.smelting) return false;
  furnace.smelting.remaining -= dt;
  if (furnace.smelting.remaining > 0) return false;
  furnace.smelting = null;
  furnace.output += 1;
  return true;
}

/** 焼き上がったインゴットを受け取る。入った数だけ output が減る。 */
export function collectSmelt(furnace: Furnace, inv: InventoryV2): number {
  if (furnace.output <= 0) return 0;
  const added = addItem(inv, COPPER_INGOT, furnace.output);
  furnace.output -= added;
  return added;
}
