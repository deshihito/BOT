// AGO WORLD BOX のワールド生成（純粋ロジック、DOM 非依存）。
// シード付き乱数と 1 次元バリューノイズだけで決定的に生成する
// （同じシード → まったく同じワールド）。
import { AIR, BEDROCK, COAL_ORE, COPPER_ORE, DIRT, GRASS, LEAVES, SAND, STONE, WOOD } from "./blocks";

export const WORLD_W = 256;
export const WORLD_H = 64;

/**
 * 全ユーザー共通の固定ワールドシード（v2.2〜）。
 * WORLD BOX の世界は1つだけ: 地形はこのシードから決定的に生成され、
 * クライアントはランダムシードを一切作らない。「新しいワールド」は
 * この固定地形のまま、プレイヤーの進行だけをリセットする扱い。
 * （将来の共有化では世界状態とプレイヤー状態を分離する。）
 */
export const WORLD_SEED = 20251115;

export type World = {
  seed: number;
  width: number;
  height: number;
  /** 行優先（y * width + x）のタイル配列。値は blocks.ts のブロック ID。 */
  tiles: Uint8Array;
  /** 列ごとの地表 y（最初に固体になるタイルの y）。 */
  surfaces: Uint8Array;
};

/** mulberry32: シード付き疑似乱数。 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function tileIndex(width: number, x: number, y: number): number {
  return y * width + x;
}

/** 範囲外は「壁」として岩盤扱い、上下は上が空気・下が岩盤。 */
export function getTile(world: World, x: number, y: number): number {
  if (y < 0) return AIR;
  if (y >= world.height) return BEDROCK;
  if (x < 0 || x >= world.width) return BEDROCK;
  return world.tiles[tileIndex(world.width, x, y)];
}

export function setTile(world: World, x: number, y: number, id: number): void {
  if (x < 0 || x >= world.width || y < 0 || y >= world.height) return;
  world.tiles[tileIndex(world.width, x, y)] = id;
}

/** 地表の高さ列を作る（8 タイルごとの制御点を smoothstep 補間）。 */
function buildSurfaces(rng: () => number): Uint8Array {
  const surfaces = new Uint8Array(WORLD_W);
  const step = 8;
  const points: number[] = [];
  const base = 20;
  for (let i = 0; i <= Math.ceil(WORLD_W / step); i++) {
    points.push(base + Math.round((rng() * 2 - 1) * 4));
  }
  for (let x = 0; x < WORLD_W; x++) {
    const i = Math.floor(x / step);
    const t = (x - i * step) / step;
    const smooth = t * t * (3 - 2 * t);
    const y = Math.round(points[i] + (points[i + 1] - points[i]) * smooth);
    surfaces[x] = Math.max(13, Math.min(27, y));
  }
  return surfaces;
}

export function generateWorld(seed: number): World {
  const rng = makeRng(seed);
  const tiles = new Uint8Array(WORLD_W * WORLD_H);
  const surfaces = buildSurfaces(rng);
  const world: World = { seed, width: WORLD_W, height: WORLD_H, tiles, surfaces };

  // 地層: 草 → 土（3〜4）→ 石 → 最下層は岩盤（+その1つ上も一部岩盤）
  for (let x = 0; x < WORLD_W; x++) {
    const surf = surfaces[x];
    const dirtDepth = 3 + Math.floor(rng() * 2);
    for (let y = surf; y < WORLD_H; y++) {
      let id = STONE;
      if (y === WORLD_H - 1) id = BEDROCK;
      else if (y === WORLD_H - 2 && rng() < 0.35) id = BEDROCK;
      else if (y === surf) id = GRASS;
      else if (y <= surf + dirtDepth) id = DIRT;
      setTile(world, x, y, id);
    }
  }

  // 砂のパッチ（地表とその下2層を砂に置換）
  const patchCount = 3 + Math.floor(rng() * 3);
  for (let p = 0; p < patchCount; p++) {
    const start = 6 + Math.floor(rng() * (WORLD_W - 20));
    const len = 4 + Math.floor(rng() * 5);
    for (let x = start; x < Math.min(WORLD_W - 2, start + len); x++) {
      const surf = surfaces[x];
      for (let y = surf; y <= Math.min(WORLD_H - 2, surf + 2); y++) setTile(world, x, y, SAND);
    }
  }

  // 鉱石: 石炭は浅め、銅は深め。見つけたら小さな鉱脈にする。
  // 鉱石は「石の中だけ」に置く（土・砂・岩盤には置かない）。
  const vein = (x: number, y: number, ore: number) => {
    setTile(world, x, y, ore);
    const extra = 1 + Math.floor(rng() * 3);
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (let i = 0; i < extra; i++) {
      const [dx, dy] = dirs[Math.floor(rng() * dirs.length)];
      if (getTile(world, x + dx, y + dy) === STONE) setTile(world, x + dx, y + dy, ore);
    }
  };
  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      if (getTile(world, x, y) !== STONE) continue;
      if (y >= 24 && y < 44 && rng() < 0.013) vein(x, y, COAL_ORE);
      else if (y >= 40 && rng() < 0.011) vein(x, y, COPPER_ORE);
    }
  }

  // 洞窟（v2.2）: 石の層をシード付きランダムウォークで掘り抜く。
  // 地表から5タイル以上深い場所だけを掘り、最下層には届かせない（地表は無傷）。
  // 鉱石に隣接する石は掘らない → 鉱脈が洞窟の壁にそのまま残る。
  const carveCaveCell = (x: number, y: number) => {
    if (x < 1 || x >= WORLD_W - 1 || y < 0 || y >= WORLD_H) return;
    if (getTile(world, x, y) !== STONE) return;
    const nearOre = [getTile(world, x + 1, y), getTile(world, x - 1, y), getTile(world, x, y + 1), getTile(world, x, y - 1)].some(
      (n) => n === COAL_ORE || n === COPPER_ORE,
    );
    if (nearOre) return;
    setTile(world, x, y, AIR);
  };
  const walkerCount = 22 + Math.floor(rng() * 8);
  for (let i = 0; i < walkerCount; i++) {
    let cx = 4 + Math.floor(rng() * (WORLD_W - 8));
    const startSurf = surfaces[cx];
    let cy = Math.min(WORLD_H - 8, startSurf + 7 + Math.floor(rng() * 14));
    let dir = rng() < 0.5 ? -1 : 1;
    const steps = 40 + Math.floor(rng() * 90);
    for (let s = 0; s < steps; s++) {
      carveCaveCell(cx, cy);
      if (rng() < 0.35) carveCaveCell(cx, cy + 1);
      if (rng() < 0.2) carveCaveCell(cx + dir, cy);
      const r = rng();
      if (r < 0.62) cx += dir;
      else if (r < 0.74) cy += 1;
      else if (r < 0.86) cy -= 1;
      else dir = -dir;
      // 掘削帯の中に留める（地表-5より浅く、最下層-3より深くは行かない）
      cx = Math.max(2, Math.min(WORLD_W - 3, cx));
      const minY = surfaces[cx] + 5;
      cy = Math.max(minY, Math.min(WORLD_H - 4, cy));
    }
  }

  // 木: 草の上に幹 3〜5 ＋ 葉の塊。近すぎる木は生やさない。
  let lastTreeX = -10;
  for (let x = 3; x < WORLD_W - 3; x++) {
    if (x - lastTreeX < 3) continue;
    const surf = surfaces[x];
    if (getTile(world, x, surf) !== GRASS) continue;
    if (rng() >= 0.12) continue;
    lastTreeX = x;
    const trunk = 3 + Math.floor(rng() * 3);
    for (let i = 1; i <= trunk; i++) setTile(world, x, surf - i, WOOD);
    const topY = surf - trunk;
    for (let dy = -2; dy <= 0; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (Math.abs(dx) === 2 && dy === -2 && rng() < 0.5) continue; // 角を落として丸く
        if (Math.abs(dx) === 2 && dy === 0) continue;
        const tx = x + dx;
        const ty = topY + dy;
        if (getTile(world, tx, ty) === AIR) setTile(world, tx, ty, LEAVES);
      }
    }
    if (topY - 1 >= 0 && getTile(world, x, topY - 1) === AIR) setTile(world, x, topY - 1, LEAVES);
  }

  return world;
}

/** スポーン地点（中央列の地表の真上）。{ x, y } はタイル座標（足元は y+2 が地表）。 */
export function findSpawn(world: World): { x: number; y: number } {
  const x = Math.floor(world.width / 2);
  const surf = world.surfaces[x];
  return { x, y: surf - 2 };
}
