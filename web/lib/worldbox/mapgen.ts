// AGO WORLD BOX の見下ろし型マップ生成（純粋ロジック、DOM 非依存）。
// 世界は1つだけ: 固定シードから全クライアントが決定的に同じ 128×128 マップを
// 生成する（地形そのものはサーバーに保存しない）。将来の nation 連携では
// このグリッドの上に首都・領地が載る前提で、タイル座標系を安定させる。
import { makeRng } from "./rng";

export const MAP_W = 128;
export const MAP_H = 128;

/** 全ユーザー共通の固定マップシード。地形はこの値からのみ決まる。 */
export const MAP_SEED = 20251115;

export const T_GRASS = 0;
export const T_WATER = 1;
export const T_SAND = 2;
export const T_TREE = 3;
export const T_ROCK = 4;
export const T_DIRT = 5;

export type TopDownMap = {
  seed: number;
  width: number;
  height: number;
  /** 行優先（y * width + x）のタイル配列。 */
  tiles: Uint8Array;
};

/** 整数格子点の決定的ハッシュ → [0, 1)。 */
function latticeHash(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 974634211) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** バリューノイズ（格子ハッシュの smoothstep 補間）。 */
export function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const a = latticeHash(ix, iy, seed);
  const b = latticeHash(ix + 1, iy, seed);
  const c = latticeHash(ix, iy + 1, seed);
  const d = latticeHash(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** フラクタル合成ノイズ。[0, 1) に正規化して返す。 */
export function fbm(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let total = 0;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + o * 101);
    total += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / total;
}

/** タイル ID の通行可否（水・木・岩は固体）。 */
export function isSolidMapTile(id: number): boolean {
  return id === T_WATER || id === T_TREE || id === T_ROCK;
}

export function mapTileAt(map: TopDownMap, x: number, y: number): number {
  if (x < 0 || x >= map.width || y < 0 || y >= map.height) return T_ROCK;
  return map.tiles[y * map.width + x];
}

/** スポーン地点（マップ中央、タイル中心座標）。 */
export function mapSpawn(map: TopDownMap): { x: number; y: number } {
  return { x: Math.floor(map.width / 2) + 0.5, y: Math.floor(map.height / 2) + 0.5 };
}

export function generateMap(seed: number = MAP_SEED): TopDownMap {
  const tiles = new Uint8Array(MAP_W * MAP_H);
  const map: TopDownMap = { seed, width: MAP_W, height: MAP_H, tiles };
  const set = (x: number, y: number, id: number) => {
    if (x >= 0 && x < MAP_W && y >= 0 && y < MAP_H) tiles[y * MAP_W + x] = id;
  };

  // 地形: 標高ノイズで水・浜・岩を、湿度ノイズで森と乾いた土を決める。
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const e = fbm(x * 0.045, y * 0.045, seed, 4);
      const m = fbm(x * 0.06 + 37.5, y * 0.06 + 91.25, seed ^ 0x9e3779b9, 3);
      let id = T_GRASS;
      if (e < 0.35) id = T_WATER;
      else if (e < 0.385) id = T_SAND;
      else if (e > 0.745) id = T_ROCK;
      else if (m > 0.585) id = T_TREE;
      else if (m < 0.30) id = T_DIRT;
      tiles[y * MAP_W + x] = id;
    }
  }

  // 川: 左端から右端へ蛇行しながら水を引く（両岸は砂）。
  const rng = makeRng(seed ^ 0x51ab);
  let ry = 16 + Math.floor(rng() * (MAP_H - 32));
  for (let x = 0; x < MAP_W; x++) {
    ry = Math.max(3, Math.min(MAP_H - 4, ry + Math.floor(rng() * 3) - 1));
    set(x, ry, T_WATER);
    if (rng() < 0.6) set(x, ry + 1, T_WATER);
    for (const by of [ry - 1, ry + 2]) {
      if (mapTileAt(map, x, by) !== T_WATER) set(x, by, T_SAND);
    }
  }

  // スポーン周辺は必ず歩ける草地にする（半径4の広場）。
  const spawn = mapSpawn(map);
  const sx = Math.floor(spawn.x);
  const sy = Math.floor(spawn.y);
  for (let y = sy - 4; y <= sy + 4; y++) {
    for (let x = sx - 4; x <= sx + 4; x++) {
      if ((x - sx) * (x - sx) + (y - sy) * (y - sy) <= 20) set(x, y, T_GRASS);
    }
  }

  return map;
}
