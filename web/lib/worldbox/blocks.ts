// AGO WORLD BOX のブロック定義（純粋データ）。
// 描画色・硬さ・当たり判定の有無はここに集約し、worldgen / rules / physics と
// クライアント描画はすべてこの表を参照する。

export const AIR = 0;
export const GRASS = 1;
export const DIRT = 2;
export const STONE = 3;
export const WOOD = 4;
export const LEAVES = 5;
export const SAND = 6;
export const COAL_ORE = 7;
export const COPPER_ORE = 8;
export const BEDROCK = 9;
/** 松明（v2.2）。固体ではない置き物タイルで、周囲を照らす。掘るとそのまま回収できる。 */
export const TORCH = 10;
/** 作業台（v2.2）。one-way の設置物で、足場になる＋触ると「つくる」が開く。 */
export const WORKBENCH = 11;

export type BlockDef = {
  id: number;
  /** 表示名（日本語）。 */
  name: string;
  /** 描画の基調色（上面）。 */
  color: string;
  /** 描画の基調色（下面・側面寄り）。 */
  colorDark: string;
  /** 物理的に固体か（空気だけ false）。 */
  solid: boolean;
  /** 掘り切るまでの保持秒数。Infinity は破壊不可。 */
  hardness: number;
  /** ホットバーに出して設置できるか。 */
  placeable: boolean;
  /**
   * 緩いブロックか（v2 の崩落対象）。草・土・砂・葉は緩く、下が空くと落ちる。
   * 石・鉱石・原木・岩盤は構造材で、支えを失っても落ちない。
   */
  loose: boolean;
  /**
   * 透過（one-way）ブロックか（v2.2）。横から・下からは通り抜けられ、
   * 上面にだけ乗れる。原木・葉・作業台が該当する。
   */
  oneWay: boolean;
};

export const BLOCKS: Record<number, BlockDef> = {
  [GRASS]: { id: GRASS, name: "草ブロック", color: "#57a639", colorDark: "#8a5a2b", solid: true, hardness: 0.45, placeable: true, loose: true, oneWay: false },
  [DIRT]: { id: DIRT, name: "土", color: "#8a5a2b", colorDark: "#6f4520", solid: true, hardness: 0.4, placeable: true, loose: true, oneWay: false },
  [STONE]: { id: STONE, name: "石", color: "#8d8d93", colorDark: "#6e6e73", solid: true, hardness: 1.1, placeable: true, loose: false, oneWay: false },
  [WOOD]: { id: WOOD, name: "原木", color: "#7a5230", colorDark: "#5d3d22", solid: true, hardness: 0.8, placeable: true, loose: false, oneWay: true },
  [LEAVES]: { id: LEAVES, name: "葉っぱ", color: "#3e7d2c", colorDark: "#2f6121", solid: true, hardness: 0.15, placeable: true, loose: true, oneWay: true },
  [SAND]: { id: SAND, name: "砂", color: "#ddd29a", colorDark: "#c4b87f", solid: true, hardness: 0.35, placeable: true, loose: true, oneWay: false },
  [COAL_ORE]: { id: COAL_ORE, name: "石炭鉱石", color: "#8d8d93", colorDark: "#55555a", solid: true, hardness: 1.4, placeable: true, loose: false, oneWay: false },
  [COPPER_ORE]: { id: COPPER_ORE, name: "銅鉱石", color: "#8d8d93", colorDark: "#7a4a33", solid: true, hardness: 1.6, placeable: true, loose: false, oneWay: false },
  [BEDROCK]: { id: BEDROCK, name: "岩盤", color: "#3a3a40", colorDark: "#26262b", solid: true, hardness: Infinity, placeable: false, loose: false, oneWay: false },
  // 松明は固体ではない置き物（通り抜けられる）。設置は rules.placeTorch が担うので placeable は false。
  // 硬さはほぼゼロ: 触ればすぐ回収できる。
  [TORCH]: { id: TORCH, name: "松明", color: "#ffb84d", colorDark: "#8a5a2b", solid: false, hardness: 0.05, placeable: false, loose: false, oneWay: false },
  // 作業台は one-way の設置物（上に乗れて横・下は通り抜け）。通常の設置フローで置ける。
  [WORKBENCH]: { id: WORKBENCH, name: "作業台", color: "#a9743f", colorDark: "#7a5230", solid: true, hardness: 0.7, placeable: true, loose: false, oneWay: true },
};

/** ホットバーに並べる設置可能ブロック（表示順）。 */
export const HOTBAR_BLOCKS: number[] = [GRASS, DIRT, STONE, WOOD, LEAVES, SAND, COAL_ORE, COPPER_ORE];

export function blockDef(id: number): BlockDef | undefined {
  return BLOCKS[id];
}

export function isSolidBlock(id: number): boolean {
  return id !== AIR && (BLOCKS[id]?.solid ?? false);
}

/** 手で掘れるか（岩盤だけ不可）。 */
export function canDigBlock(id: number): boolean {
  const def = BLOCKS[id];
  return !!def && def.hardness !== Infinity;
}

/** 掘り切るまでの秒数。不明なブロックは掘れないものとして Infinity。 */
export function hardnessOf(id: number): number {
  return BLOCKS[id]?.hardness ?? Infinity;
}

/** 掘ったときに手に入るブロック（v1 では掘ったブロックそのもの）。 */
export function dropOf(id: number): number {
  return BLOCKS[id] ? id : AIR;
}

/** 緩いブロックか（下が空くと崩落する）。空気・未定義は false。 */
export function isLooseBlock(id: number): boolean {
  return BLOCKS[id]?.loose ?? false;
}

/** 透過（one-way）ブロックか（横・下は通り抜け、上面にだけ乗れる）。 */
export function isOneWayBlock(id: number): boolean {
  return BLOCKS[id]?.oneWay ?? false;
}

/**
 * 全面固体のブロックか（横からも下からもぶつかる）。
 * one-way ブロックと非固体（空気・松明）は含まない。壁判定はこちらを使う。
 */
export function isFullSolidBlock(id: number): boolean {
  return isSolidBlock(id) && !isOneWayBlock(id);
}
