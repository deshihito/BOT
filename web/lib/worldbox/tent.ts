// AGO WORLD BOX のテント内装（純粋ロジック、DOM 非依存）。
// 置いたテントを踏むと入れる小さな室内空間。形は LobbyData と同じにして、
// ロビーの描画・移動・ステーション判定をそのまま使う。最低限の設備として
// 作業台とかまど（どちらも station: "smith" = 合成の場所）を持つ。
// 個人空間は拡張段階（tier）で広がる: 0=13x10 / 1=17x13 / 2=22x17。
// 家具の配置は左上を基準に、右端・下端の物は辺に寄せて再配置する。
import { T_GRASS, T_ROCK, tilesSource, type TopDownMap } from "./mapgen";
import { L_WALL, L_WOOD, isSeatSprite, isSolidLobbyTile, type LobbyData, type LobbyObject } from "./lobby";

export interface TentTier {
  w: number;
  h: number;
  /** 次の段階へ広げる価格（AGO コイン、暫定）。tier 0 は 0。 */
  price: number;
}

export const TENT_TIERS: readonly TentTier[] = [
  { w: 13, h: 10, price: 0 },
  { w: 17, h: 13, price: 3000 },
  { w: 22, h: 17, price: 10000 },
];

export const TENT_MAX_TIER = TENT_TIERS.length - 1;

export function tentTierOf(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.min(TENT_MAX_TIER, Math.max(0, Math.floor(raw)))
    : 0;
}

export function tentSizeForTier(tier: number): TentTier {
  return TENT_TIERS[tentTierOf(tier)];
}

/** 全段階のうち最大の寸法（サーバー側の座標クランプ用）。 */
export const TENT_MAX_W = TENT_TIERS[TENT_MAX_TIER].w;
export const TENT_MAX_H = TENT_TIERS[TENT_MAX_TIER].h;

export const TENT_W = TENT_TIERS[0].w;
export const TENT_H = TENT_TIERS[0].h;

/** 出入口タイル（南壁の中央。踏むとワールドへ戻る）。 */
export function tentExitFor(tier: number): { x: number; y: number } {
  const { w, h } = tentSizeForTier(tier);
  return { x: Math.floor(w / 2), y: h - 1 };
}

/** 入室直後の位置（出入口の内側）。 */
export function tentEntryFor(tier: number): { x: number; y: number } {
  const exit = tentExitFor(tier);
  return { x: exit.x + 0.5, y: exit.y - 0.5 };
}

export const TENT_ENTRY = tentEntryFor(0);
export const TENT_EXIT = tentExitFor(0);

function tentObjectsFor(tier: number): readonly LobbyObject[] {
  const { w, h } = tentSizeForTier(tier);
  const exit = tentExitFor(tier);
  return [
    // 左上の鍛冶コーナー
    { sprite: "furnace", x: 1, y: 1, w: 1, h: 1, solid: true, station: "smith" },
    { sprite: "anvil", x: 2, y: 1, w: 1, h: 1, solid: true, station: "smith" },
    // 右上の小物
    { sprite: "lamp", x: w - 2, y: 1, w: 1, h: 1, solid: true },
    { sprite: "bookshelf", x: w - 3, y: 1, w: 1, h: 1, solid: true },
    // 左下の収納コーナー
    { sprite: "crate", x: 1, y: h - 2, w: 1, h: 1, solid: true },
    { sprite: "barrel", x: 2, y: h - 2, w: 1, h: 1, solid: true },
    // 右下の休憩コーナー
    { sprite: "sofa", x: w - 2, y: h - 2, w: 1, h: 1, solid: true },
    // 出入口の脇の作業台（入ってすぐ合成できる）
    { sprite: "workbench", x: exit.x + 1, y: h - 2, w: 1, h: 1, solid: true, station: "smith" },
    // 出入口（平置き・通過可）
    { sprite: "warp_pad", x: exit.x, y: exit.y, w: 1, h: 1, solid: false },
  ];
}

export function tentTileAt(tiles: Uint8Array, width: number, height: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= width || y >= height) return 0;
  return tiles[y * width + x];
}

const tentCache = new Map<number, LobbyData>();

/** テント内装を構築する（決定的。段階ごとにキャッシュする）。 */
export function buildTent(tier = 0): LobbyData {
  const t = tentTierOf(tier);
  const cached = tentCache.get(t);
  if (cached) return cached;
  const { w, h } = tentSizeForTier(t);
  const exit = tentExitFor(t);
  const objects = tentObjectsFor(t);
  const tiles = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const border = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      const door = x === exit.x && y === exit.y;
      tiles[y * w + x] = border && !door ? L_WALL : L_WOOD;
    }
  }
  const blocked = new Set<string>();
  for (const o of objects) {
    if (!o.solid) continue;
    if (isSeatSprite(o.sprite)) continue; // 座席は上に乗って座るため固体にしない（lobby.ts と同じ）
    for (let dy = 0; dy < o.h; dy++) {
      for (let dx = 0; dx < o.w; dx++) blocked.add(`${o.x + dx},${o.y + dy}`);
    }
  }
  const moveTiles = new Uint8Array(w * h);
  for (let i = 0; i < tiles.length; i++) {
    moveTiles[i] = isSolidLobbyTile(tiles[i]) ? T_ROCK : T_GRASS;
  }
  const moveMap: TopDownMap = tilesSource(0, w, h, moveTiles);
  const data: LobbyData = {
    width: w,
    height: h,
    tiles,
    objects,
    npcs: [],
    blocked,
    moveMap,
  };
  tentCache.set(t, data);
  return data;
}
