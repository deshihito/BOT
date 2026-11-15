// AGO WORLD BOX の初期スポーン（純粋ロジック、DOM 非依存）。
// 新規プレイヤーの初回スポーンは固定地点ではなく、原点周辺の広い範囲から
// 陸の歩行可能タイルをランダムに選ぶ。決定はサーバー側（セーブ初回作成時）
// が正で、選ばれた位置はそのまま初回セーブになる。以後は通常のセーブ位置。
import { MAP_SEED, T_DIRT, T_GRASS, T_SAND, T_SNOW, tileAt } from "./mapgen";

/** 初期スポーンの抽選範囲（原点からの半径、タイル）。 */
export const SPAWN_RADIUS = 2000;
/** 抽選の試行回数。これで当たらなければ決定的スキャンに落ちる。 */
const SPAWN_TRIES = 256;

/** スポーンできるタイル（陸の歩行可能タイル。水・木・岩・雪の木には落とさない）。 */
export function isSpawnableTile(id: number): boolean {
  return id === T_GRASS || id === T_DIRT || id === T_SAND || id === T_SNOW;
}

/**
 * ランダムなスポーン地点（タイル中心座標）を返す。rand は [0, 1) の乱数源
 * （サーバーでは Math.random、テストでは決定的な源を渡す）。
 */
export function pickRandomSpawn(rand: () => number, seed: number = MAP_SEED): { x: number; y: number } {
  const span = SPAWN_RADIUS * 2 + 1;
  for (let i = 0; i < SPAWN_TRIES; i++) {
    const tx = Math.floor(rand() * span) - SPAWN_RADIUS;
    const ty = Math.floor(rand() * span) - SPAWN_RADIUS;
    if (isSpawnableTile(tileAt(tx, ty, seed))) return { x: tx + 0.5, y: ty + 0.5 };
  }
  // 決定的フォールバック: 原点からリング状に最初のスポーン可能タイルを探す
  for (let r = 0; r <= 256; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (isSpawnableTile(tileAt(dx, dy, seed))) return { x: dx + 0.5, y: dy + 0.5 };
      }
    }
  }
  return { x: 0.5, y: 0.5 };
}
