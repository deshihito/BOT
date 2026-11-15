// AGO WORLD BOX の共有ワールド同期（純粋ロジック、v3）。
// 世界は1つだけ: 地形は WORLD_SEED から決定的に生成され、プレイヤー全員の
// 変更は「生成地形との差分（diffs）」としてサーバーに集約される。
// diffs のキーは "x,y"、値はタイル ID（0 = 掘って空気）。
// 競合はタイル単位の last-writer-wins。生成地形と同じ値に戻った差分は捨てる。
import { AIR, BEDROCK, BLOCKS } from "./blocks";
import { WORLD_H, WORLD_W, WORLD_SEED, findSpawn, generateWorld, tileIndex, type World } from "./worldgen";

export type TileChange = { x: number; y: number; tile: number };
export type RejectedChange = TileChange & { reason: string };
export type SharedWorldData = { epoch: number; diffs: Record<string, number> };

/** 1回の PUT で送れる変更の上限。 */
export const MAX_CHANGE_BATCH = 256;

/** スポーン保護: スポーン列±この幅、 地表から上6・下4タイルは変更不可。 */
export const SPAWN_PROTECT_RADIUS_X = 4;
export const SPAWN_PROTECT_ABOVE = 6;
export const SPAWN_PROTECT_BELOW = 4;

let baseCache: World | null = null;

/** 生成地形そのもの（読み取り専用。書き換えたい場合は generateWorld を別に呼ぶ）。 */
export function baseWorld(): World {
  if (!baseCache) baseCache = generateWorld(WORLD_SEED);
  return baseCache;
}

export function diffKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function parseDiffKey(key: string): { x: number; y: number } | null {
  const m = /^(\d+),(\d+)$/.exec(key);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]) };
}

export function emptySharedWorld(): SharedWorldData {
  return { epoch: 0, diffs: {} };
}

export function isValidTileId(tile: number): boolean {
  return Number.isInteger(tile) && tile >= 0 && (tile === AIR || BLOCKS[tile] !== undefined);
}

/** スポーン保護区域内か（スポーン列の周囲、地表の上下数タイル）。 */
export function isSpawnProtected(x: number, y: number, world: World = baseWorld()): boolean {
  const spawn = findSpawn(world);
  const surf = world.surfaces[spawn.x];
  return Math.abs(x - spawn.x) <= SPAWN_PROTECT_RADIUS_X && y >= surf - SPAWN_PROTECT_ABOVE && y <= surf + SPAWN_PROTECT_BELOW;
}

/**
 * 変更1件の検証。問題なければ null、あれば理由文字列。
 * 岩盤は「置く」ことも「掘る（=空気化）」こともできない。
 */
export function validateChange(change: TileChange, world: World = baseWorld()): string | null {
  if (!change || !Number.isInteger(change.x) || !Number.isInteger(change.y) || !Number.isInteger(change.tile)) {
    return "invalid_change";
  }
  const { x, y, tile } = change;
  if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) return "out_of_bounds";
  if (tile === BEDROCK) return "bedrock";
  if (!isValidTileId(tile)) return "invalid_tile";
  if (world.tiles[tileIndex(WORLD_W, x, y)] === BEDROCK) return "bedrock";
  if (isSpawnProtected(x, y, world)) return "spawn_protected";
  return null;
}

/**
 * 変更群を共有状態へマージする（LWW）。生成地形と同じ値への変更は差分から
 * 落とす。差分マップが実際に変わったときだけ epoch を進める。
 */
export function mergeChanges(
  data: SharedWorldData,
  changes: TileChange[],
  world: World = baseWorld(),
): { data: SharedWorldData; rejected: RejectedChange[] } {
  const diffs: Record<string, number> = { ...data.diffs };
  const rejected: RejectedChange[] = [];
  let changed = false;
  for (const c of changes) {
    const reason = validateChange(c, world);
    if (reason) {
      rejected.push({ x: c?.x, y: c?.y, tile: c?.tile, reason });
      continue;
    }
    const key = diffKey(c.x, c.y);
    const base = world.tiles[tileIndex(WORLD_W, c.x, c.y)];
    if (c.tile === base) {
      if (key in diffs) {
        delete diffs[key];
        changed = true;
      }
    } else if (diffs[key] !== c.tile) {
      diffs[key] = c.tile;
      changed = true;
    }
  }
  return { data: { epoch: data.epoch + (changed ? 1 : 0), diffs }, rejected };
}

/** 差分をワールドへ適用する（範囲外・不正値は無視）。 */
export function applyDiffs(world: World, diffs: Record<string, number>): void {
  for (const [key, tile] of Object.entries(diffs)) {
    const pos = parseDiffKey(key);
    if (!pos) continue;
    if (pos.x < 0 || pos.x >= world.width || pos.y < 0 || pos.y >= world.height) continue;
    if (!isValidTileId(tile) || tile === BEDROCK) continue;
    world.tiles[tileIndex(world.width, pos.x, pos.y)] = tile;
  }
}

/** 現在タイルと「同期済みタイル」の差をすべて変更として列挙する（クライアントの送信キュー用）。 */
export function diffTilesAgainst(tiles: Uint8Array, known: Uint8Array): TileChange[] {
  const out: TileChange[] = [];
  const n = Math.min(tiles.length, known.length);
  for (let i = 0; i < n; i++) {
    if (tiles[i] === known[i]) continue;
    out.push({ x: i % WORLD_W, y: Math.floor(i / WORLD_W), tile: tiles[i] });
  }
  return out;
}

export function serializeSharedWorld(data: SharedWorldData): string {
  return JSON.stringify({ epoch: data.epoch, diffs: data.diffs });
}

/** 壊れたデータは null。個別の不正な差分は落として読む（全体を捨てない）。 */
export function parseSharedWorld(json: string | null | undefined): SharedWorldData | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as { epoch?: unknown; diffs?: unknown };
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.epoch !== "number" || !Number.isFinite(raw.epoch) || raw.epoch < 0) return null;
    if (!raw.diffs || typeof raw.diffs !== "object" || Array.isArray(raw.diffs)) return null;
    const base = baseWorld();
    const diffs: Record<string, number> = {};
    for (const [key, tile] of Object.entries(raw.diffs as Record<string, unknown>)) {
      const pos = parseDiffKey(key);
      if (!pos || pos.x >= WORLD_W || pos.y >= WORLD_H) continue;
      if (typeof tile !== "number" || !isValidTileId(tile) || tile === BEDROCK) continue;
      if (base.tiles[tileIndex(WORLD_W, pos.x, pos.y)] === tile) continue; // 生成地形と同じ差分は持たない
      if (base.tiles[tileIndex(WORLD_W, pos.x, pos.y)] === BEDROCK) continue;
      diffs[key] = tile;
    }
    return { epoch: Math.floor(raw.epoch), diffs };
  } catch {
    return null;
  }
}
