// AGO WORLD BOX の見下ろし型マップ生成（純粋ロジック、DOM 非依存）。
// 世界は1つだけ: 固定シードから全クライアントが決定的に同じ 1024×1024 マップを
// 生成する（地形そのものはサーバーに保存しない）。将来の nation 連携では
// このグリッドの上に首都・領地が載る前提で、タイル座標系を安定させる。
import { makeRng } from "./rng";

export const MAP_W = 1024;
export const MAP_H = 1024;

/** 全ユーザー共通の固定マップシード。地形はこの値からのみ決まる。 */
export const MAP_SEED = 20251115;

export const T_GRASS = 0;
export const T_WATER = 1;
export const T_SAND = 2;
export const T_TREE = 3;
export const T_ROCK = 4;
export const T_DIRT = 5;
export const T_SNOW = 6;
export const T_SNOW_TREE = 7;

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

/** タイル ID の通行可否（水・木・岩・雪の木は固体）。 */
export function isSolidMapTile(id: number): boolean {
  return id === T_WATER || id === T_TREE || id === T_ROCK || id === T_SNOW_TREE;
}

export function mapTileAt(map: TopDownMap, x: number, y: number): number {
  if (x < 0 || x >= map.width || y < 0 || y >= map.height) return T_ROCK;
  return map.tiles[y * map.width + x];
}

/** スポーン地点（マップ中央、タイル中心座標）。 */
export function mapSpawn(map: TopDownMap): { x: number; y: number } {
  return { x: Math.floor(map.width / 2) + 0.5, y: Math.floor(map.height / 2) + 0.5 };
}

// ノイズの空間スケールは「マップ幅あたりのセル数」で決める。128 時代と同じ
// 相対地理（大陸・湖・森が地域として読める大きさ）を 1024 でも保つため、
// 周波数はマップ幅に比例させる（タイル単位の絶対周波数を固定すると地形が
// 細切れになり、逆に 8 倍へ引き伸ばすと単調になる）。
/** 標高ノイズ: 横に約7セル → 大陸サイズの陸塊と湖。 */
const ELEV_CELLS = 7;
/** 湿度ノイズ: 横に約9.5セル → 森と乾地が地域単位で分布する。 */
const MOIST_CELLS = 9.5;
/** 雪原バイオーム: 北端からこの割合の帯（境界はノイズで揺れる）。 */
export const SNOW_BAND_RATIO = 0.22;
/** 雪原境界の南北の揺れ幅（タイル）。 */
const SNOW_EDGE_AMP = 26;

/**
 * 雪原帯の南端（この行より北＝小さい y が雪原）。x ごとにノイズで揺れるため
 * 境界は直線にならない。生成とテストの両方から使う。
 */
export function snowBoundaryAt(seed: number, x: number): number {
  const base = MAP_H * SNOW_BAND_RATIO;
  return base + (fbm(x * 0.006, 13.7, seed ^ 0x53c1, 2) - 0.5) * 2 * SNOW_EDGE_AMP;
}

/** ミニマップのオフスクリーン解像度（1024 マップを 4 タイルごとに間引く）。 */
export const MINIMAP_SIZE = 256;

/**
 * ミニマップ用にマップを size×size へ間引いたタイル ID 配列を返す。
 * 各セルは対応するタイルブロック中心のタイルを代表値とする（純粋関数）。
 */
export function sampleMinimapTiles(map: TopDownMap, size: number = MINIMAP_SIZE): Uint8Array {
  const out = new Uint8Array(size * size);
  const stepX = map.width / size;
  const stepY = map.height / size;
  for (let y = 0; y < size; y++) {
    const sy = Math.min(map.height - 1, Math.floor((y + 0.5) * stepY));
    for (let x = 0; x < size; x++) {
      const sx = Math.min(map.width - 1, Math.floor((x + 0.5) * stepX));
      out[y * size + x] = map.tiles[sy * map.width + sx];
    }
  }
  return out;
}

/**
 * fbm フィールド（格子ハッシュと補間係数を全て事前計算した形）。
 * 1024×1024 = 約105万タイルで直接 fbm を回すと遅いため、オクターブごとの
 * 格子ハッシュ・列係数・行係数を先に計算し、タイルごとの評価は補間だけに
 * する。返す値は fbm(x*baseFreq+offX, y*baseFreq+offY, …) と同一になる。
 */
type NoiseField = {
  octaves: number;
  grids: Float32Array[];
  gridW: number[];
  /** オクターブ×列: 格子列インデックスと smooth 済み端数。 */
  colI: Int32Array[];
  colFx: Float32Array[];
  /** オクターブ×行: 格子行の先頭インデックスと smooth 済み端数。 */
  rowBase: Int32Array[];
  rowFy: Float32Array[];
};

function makeNoiseField(
  baseFreq: number,
  offX: number,
  offY: number,
  fieldSeed: number,
  octaves: number,
): NoiseField {
  const grids: Float32Array[] = [];
  const gridW: number[] = [];
  const colI: Int32Array[] = [];
  const colFx: Float32Array[] = [];
  const rowBase: Int32Array[] = [];
  const rowFy: Float32Array[] = [];
  for (let o = 0; o < octaves; o++) {
    const fo = 2 ** o;
    const ox = Math.floor(offX * fo);
    const oy = Math.floor(offY * fo);
    const w = Math.floor(((MAP_W - 1) * baseFreq + offX) * fo) - ox + 2;
    const h = Math.floor(((MAP_H - 1) * baseFreq + offY) * fo) - oy + 2;
    const g = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        g[j * w + i] = latticeHash(ox + i, oy + j, fieldSeed + o * 101);
      }
    }
    const ci = new Int32Array(MAP_W);
    const cfx = new Float32Array(MAP_W);
    for (let x = 0; x < MAP_W; x++) {
      const u = (x * baseFreq + offX) * fo;
      const iu = Math.floor(u);
      ci[x] = iu - ox;
      cfx[x] = smooth(u - iu);
    }
    const rb = new Int32Array(MAP_H);
    const rfy = new Float32Array(MAP_H);
    for (let y = 0; y < MAP_H; y++) {
      const v = (y * baseFreq + offY) * fo;
      const iv = Math.floor(v);
      rb[y] = (iv - oy) * w;
      rfy[y] = smooth(v - iv);
    }
    grids.push(g);
    gridW.push(w);
    colI.push(ci);
    colFx.push(cfx);
    rowBase.push(rb);
    rowFy.push(rfy);
  }
  return { octaves, grids, gridW, colI, colFx, rowBase, rowFy };
}

function sampleField(f: NoiseField, x: number, y: number): number {
  let sum = 0;
  let amp = 1;
  let total = 0;
  for (let o = 0; o < f.octaves; o++) {
    const g = f.grids[o];
    const w = f.gridW[o];
    const gi = f.rowBase[o][y] + f.colI[o][x];
    const fx = f.colFx[o][x];
    const fy = f.rowFy[o][y];
    const a = g[gi];
    const b = g[gi + 1];
    const c = g[gi + w];
    const d = g[gi + w + 1];
    sum += amp * (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy);
    total += amp;
    amp *= 0.5;
  }
  return sum / total;
}

export function generateMap(seed: number = MAP_SEED): TopDownMap {
  const tiles = new Uint8Array(MAP_W * MAP_H);
  const map: TopDownMap = { seed, width: MAP_W, height: MAP_H, tiles };
  const set = (x: number, y: number, id: number) => {
    if (x >= 0 && x < MAP_W && y >= 0 && y < MAP_H) tiles[y * MAP_W + x] = id;
  };

  // 雪原境界は列ごとに1回だけ計算する（タイルごとの再計算を避ける）。
  const snowEdge = new Float32Array(MAP_W);
  for (let x = 0; x < MAP_W; x++) snowEdge[x] = snowBoundaryAt(seed, x);

  // 地形: 標高ノイズで水・浜・岩を、湿度ノイズで森と乾いた土を決める。
  // 北の帯では同じ規則の結果を雪タイルへ読み替える（水・砂・岩は共通）。
  // 湿度は標高で草・森・土のどれかになるタイルでだけ必要なので遅延評価する。
  const elev = makeNoiseField(ELEV_CELLS / MAP_W, 0, 0, seed, 4);
  const moist = makeNoiseField(MOIST_CELLS / MAP_W, 37.5, 91.25, seed ^ 0x9e3779b9, 3);
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const e = sampleField(elev, x, y);
      let id = T_GRASS;
      if (e < 0.35) id = T_WATER;
      else if (e < 0.385) id = T_SAND;
      else if (e > 0.745) id = T_ROCK;
      else {
        const m = sampleField(moist, x, y);
        if (m > 0.585) id = T_TREE;
        else if (m < 0.30) id = T_DIRT;
      }
      if (y < snowEdge[x]) {
        if (id === T_GRASS || id === T_DIRT) id = T_SNOW;
        else if (id === T_TREE) id = T_SNOW_TREE;
      }
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
