// AGO WORLD BOX の見下ろし型マップ生成（純粋ロジック、DOM 非依存）。
// 世界は1つだけ: 固定シードと整数座標から、任意のタイルを決定的に返す
// 純関数 tileAt が地形の正。マップは有限グリッドではなくチャンク式で、
// 座標は実質無制限（生成も保存も「全体」ではなく座標そのもので扱う）。
// 地形そのものはサーバーに保存しない。国・建物・タイル上書きはこの上に載る。

export const T_GRASS = 0;
export const T_WATER = 1;
export const T_SAND = 2;
export const T_TREE = 3;
export const T_ROCK = 4;
export const T_DIRT = 5;
export const T_SNOW = 6;
export const T_SNOW_TREE = 7;

/** 全ユーザー共通の固定マップシード。地形はこの値と座標からのみ決まる。 */
export const MAP_SEED = 20251115;

/**
 * 座標の健全な絶対上限。これを超える座標は壊れたデータとして扱う
 * （実質無制限の範囲内での誤入力・改竄ガード）。
 */
export const WORLD_COORD_LIMIT = 1_000_000;

/** 座標の矩形範囲（プレゼンス・予測位置のクランプ用）。 */
export type CoordBounds = { minX: number; maxX: number; minY: number; maxY: number };

/** 原点を含む幅・高さの矩形（ロビーなど有限空間の範囲）。 */
export function rectBounds(width: number, height: number): CoordBounds {
  return { minX: 0, maxX: width, minY: 0, maxY: height };
}

/** ワールド全体の範囲（実質無制限）。 */
export function worldBounds(): CoordBounds {
  return {
    minX: -WORLD_COORD_LIMIT, maxX: WORLD_COORD_LIMIT,
    minY: -WORLD_COORD_LIMIT, maxY: WORLD_COORD_LIMIT,
  };
}

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

/** タイル ID の通行可否（水・木・岩・雪の木は固体）。 */
export function isSolidMapTile(id: number): boolean {
  return id === T_WATER || id === T_TREE || id === T_ROCK || id === T_SNOW_TREE;
}

// ---------------------------------------------------------------- タイル源
/**
 * タイル源: 任意の整数座標のタイルを返すもの。ワールドは tileAt の純関数、
 * ロビーのような有限空間はタイル配列で作る。移動・描画・検証はすべて
 * この形だけを見る（全体グリッドの存在を前提にしない）。
 */
export type TileSource = {
  seed: number;
  tileAt: (x: number, y: number) => number;
  /** 有限のタイル源（ロビー等）だけが持つ広さ。無制限ワールドでは undefined。 */
  width?: number;
  height?: number;
};

/** 互換名（旧来の「マップ」はタイル源そのものになった）。 */
export type TopDownMap = TileSource;

export function mapTileAt(map: TileSource, x: number, y: number): number {
  return map.tileAt(x, y);
}

/** タイル配列から有限のタイル源を作る。範囲外は岩（固体）。 */
export function tilesSource(seed: number, width: number, height: number, tiles: Uint8Array): TileSource {
  return {
    seed,
    width,
    height,
    tileAt: (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? T_ROCK : tiles[y * width + x]),
  };
}

// ---------------------------------------------------------------- 地形
// ノイズの空間スケールは旧 1024×1024 マップ時代の相対地理（大陸・湖・森が
// 地域として読める大きさ）を絶対周波数として固定したもの。原点付近では
// 旧マップと概ね同じ分布になる。
/** 標高ノイズの周波数: 横に約7セル → 大陸サイズの陸塊と湖。 */
const ELEV_FREQ = 7 / 1024;
/** 湿度ノイズの周波数: 横に約9.5セル → 森と乾地が地域単位で分布する。 */
const MOIST_FREQ = 9.5 / 1024;
/** 雪原バイオームの基準緯度（この y より北＝小さい y が雪原）。 */
export const SNOW_BASE_Y = 1024 * 0.22;
/** 雪原境界の南北の揺れ幅（タイル）。 */
const SNOW_EDGE_AMP = 26;

/**
 * 雪原帯の南端（この行より北＝小さい y が雪原）。x ごとにノイズで揺れるため
 * 境界は直線にならない。生成とテストの両方から使う。
 */
export function snowBoundaryAt(seed: number, x: number): number {
  return SNOW_BASE_Y + (fbm(x * 0.006, 13.7, seed ^ 0x53c1, 2) - 0.5) * 2 * SNOW_EDGE_AMP;
}

// 川: 中心線を低周波ノイズで蛇行させ、その帯を水・両岸を砂にする。
// 中心線が x の純関数なので、どこまで行っても決定的に続く。
const RIVER_CENTER_Y = 480;
const RIVER_AMP = 190;
const RIVER_FREQ = 0.0035;
const RIVER_PHASE = 7.3;
/** 川の半幅（この距離内は水）。 */
const RIVER_HALF = 0.9;
/** 両岸の砂の外端（この距離内は砂、水は除く）。 */
const RIVER_BANK = 2.1;

function riverCenterAt(seed: number, x: number): number {
  return RIVER_CENTER_Y + (fbm(x * RIVER_FREQ, RIVER_PHASE, seed ^ 0x51ab, 3) - 0.5) * 2 * RIVER_AMP;
}

/**
 * ワールド地形の純関数: 整数座標 (x, y) のタイルをシードから決定的に返す。
 * 標高ノイズで水・浜・岩を、湿度ノイズで森と乾いた土を決める。北の緯度帯
 * では同じ規則の結果を雪タイルへ読み替える（水・砂・岩は共通）。
 */
export function tileAt(x: number, y: number, seed: number = MAP_SEED): number {
  const e = fbm(x * ELEV_FREQ, y * ELEV_FREQ, seed, 4);
  let id = T_GRASS;
  if (e < 0.35) id = T_WATER;
  else if (e < 0.385) id = T_SAND;
  else if (e > 0.745) id = T_ROCK;
  else {
    const m = fbm(x * MOIST_FREQ + 37.5, y * MOIST_FREQ + 91.25, seed ^ 0x9e3779b9, 3);
    if (m > 0.585) id = T_TREE;
    else if (m < 0.30) id = T_DIRT;
  }
  if (y < snowBoundaryAt(seed, x)) {
    if (id === T_GRASS || id === T_DIRT) id = T_SNOW;
    else if (id === T_TREE) id = T_SNOW_TREE;
  }
  const d = Math.abs(y - riverCenterAt(seed, x));
  if (d <= RIVER_HALF) id = T_WATER;
  else if (d <= RIVER_BANK && id !== T_WATER) id = T_SAND;
  return id;
}

/** ワールドのタイル源（無制限・純関数）。 */
/**
 * 互換: 有限範囲（既定 1024×1024）をタイル配列として生成する旧 generateMap。
 * 中身は tileAt の切り出しで、無制限ワールドと地形が一致する。
 */
export function generateMap(
  seed: number = MAP_SEED,
  width = 1024,
  height = 1024,
): TileSource & { tiles: Uint8Array } {
  const tiles = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) tiles[y * width + x] = tileAt(x, y, seed);
  }
  return { ...tilesSource(seed, width, height, tiles), tiles };
}

export function worldTileSource(seed: number = MAP_SEED): TileSource {
  return { seed, tileAt: (x, y) => tileAt(x, y, seed) };
}

// ---------------------------------------------------------------- チャンク
/** チャンクの一辺（タイル）。地形はこの単位でまとめて生成できる。 */
export const CHUNK_SIZE = 32;

export type WorldChunk = {
  /** チャンク座標（タイル座標 = チャンク座標 × CHUNK_SIZE から）。 */
  cx: number;
  cy: number;
  size: number;
  /** 行優先（(y - cy*size) * size + (x - cx*size)）のタイル配列。 */
  tiles: Uint8Array;
};

/** チャンク単位の生成。結果は tileAt の寄せ集めと常に一致する。 */
export function generateChunk(cx: number, cy: number, seed: number = MAP_SEED): WorldChunk {
  const tiles = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  for (let y = 0; y < CHUNK_SIZE; y++) {
    for (let x = 0; x < CHUNK_SIZE; x++) {
      tiles[y * CHUNK_SIZE + x] = tileAt(x0 + x, y0 + y, seed);
    }
  }
  return { cx, cy, size: CHUNK_SIZE, tiles };
}
