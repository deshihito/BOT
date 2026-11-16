// AGO WORLD BOX のユニオンポーター（純粋ロジック）。
// テレポーター（冒険役職）がダブルタップした地点に設置する転移点で、
// ユニオン（国 = Discord サーバー）に1つだけ持てる。所属員はマップから
// 選んでそこへテレポートできる。保存は warp-online.ts（bot_kv
// "worldbox_warp"、キー = ギルド ID）、設置の発動は roles ルートの
// スキル分岐、利用は /api/worldbox/warp が担う。
import { isSolidMapTile, WORLD_COORD_LIMIT, type TopDownMap } from "./mapgen";
import { findFreeNear } from "./move";

/** ポーター1件（タイル座標は整数）。 */
export type UnionPorter = {
  x: number;
  y: number;
  /** 設置した人の所有者キー。 */
  by: string;
  /** 設置時刻（epoch ms）。 */
  at: number;
};

/** 設置できる距離: 自分のタイルからチェビシェフ距離でこのタイル数まで。 */
export const PORTER_PLACE_RANGE = 8;

/** 保存値の解釈。壊れていれば null。 */
export function parsePorter(raw: unknown): UnionPorter | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as { x?: unknown; y?: unknown; by?: unknown; at?: unknown };
  if (typeof v.x !== "number" || typeof v.y !== "number") return null;
  if (!Number.isInteger(v.x) || !Number.isInteger(v.y)) return null;
  if (Math.abs(v.x) > WORLD_COORD_LIMIT || Math.abs(v.y) > WORLD_COORD_LIMIT) return null;
  if (typeof v.by !== "string" || v.by.length === 0) return null;
  if (typeof v.at !== "number" || !Number.isFinite(v.at) || v.at <= 0) return null;
  return { x: v.x, y: v.y, by: v.by, at: Math.floor(v.at) };
}

/** 設置距離の検証: 自分のタイル (fromX, fromY) から対象タイルまでのチェビシェフ距離。 */
export function porterInRange(fromX: number, fromY: number, tx: number, ty: number): boolean {
  return Math.max(Math.abs(tx - fromX), Math.abs(ty - fromY)) <= PORTER_PLACE_RANGE;
}

/**
 * 設置先タイルの通行可否: 地形が固体（水・木・岩・雪の木）か、設置ブロックが
 * あるタイルには置けない。どちらでもなければ null（設置可）。
 */
export function porterTileError(tileId: number, hasBlock: boolean): "blocked_tile" | null {
  if (hasBlock) return "blocked_tile";
  if (isSolidMapTile(tileId)) return "blocked_tile";
  return null;
}

/**
 * テレポートの着地点: ポーターのタイル中心。設置後に周囲が変わって
 * 立てなくなっていたら、立てる場所へ寄せる（ファストトラベルと同じ流儀）。
 */
export function porterDestination(map: TopDownMap, porter: UnionPorter): { x: number; y: number } {
  return findFreeNear(map, porter.x + 0.5, porter.y + 0.5, undefined, { swim: true });
}
