// AGO WORLD BOX のタイル上書き（純粋ロジック、DOM 非依存）。
// 地形そのものは固定シードから決定的に生成されるため保存しない。ここで
// 扱うのはプレイヤーの行為で変わった差分だけ: 伐採・採掘・耕作・作付け。
// 農業は「畑を設置」するのではなく、地面を耕して好きな作物を植える。
// 保存は tiles-online.ts（bot_kv、タイルごとのキー）が担う。
import { ITEMS, cropById, cropBySeedId, type ToolKind } from "./items";
import {
  MAP_H, MAP_W, T_DIRT, T_GRASS, T_ROCK, T_SNOW, T_SNOW_TREE, T_TREE,
  mapTileAt, type TopDownMap,
} from "./mapgen";
import { addItem, countItem, removeItem, type PlayerProfile } from "./profile";
import { presenceIdFor } from "./presence";

/** 伐採した木が再生するまでの時間（6時間）。 */
export const TREE_REGROW_MS = 6 * 3600 * 1000;
/** 伐採・採掘の収穫数。 */
export const CHOP_WOOD_COUNT = 2;
export const MINE_STONE_COUNT = 2;

export type CropState = {
  cropId: string;
  plantedAt: number;
  readyAt: number;
};

/** 1タイルの上書き。無い項目は「地形どおり・素の状態」を意味する。 */
export type TileOverride = {
  /** 地形の置き換え（伐採→草/雪、採掘→土）。 */
  tile?: number;
  /** 耕された畑かどうか。 */
  farmland?: boolean;
  /** 作付け中の作物。null は「畑だが未作付け」を明示する。 */
  crop?: CropState | null;
  /** 伐採直後の切り株（再生までの間だけ描く）。 */
  stump?: boolean;
  /** 最後に手を入れた人（作物の所有者）の不透明 ID。 */
  ownerId: string;
  /** この上書きが失効する時刻（木の再生）。過ぎたら地形どおりに戻る。 */
  until?: number;
};

/** "x,y" → 上書き。 */
export type TileOverridesMap = Record<string, TileOverride>;

export function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function parseTileKey(key: string): { x: number; y: number } | null {
  const m = /^(-?\d+),(-?\d+)$/.exec(key);
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return null;
  return { x, y };
}

/** 上書きがまだ効いているか（until を過ぎたら地形に戻る）。 */
export function isOverrideActive(ov: TileOverride | undefined | null, now: number): boolean {
  if (!ov) return false;
  return ov.until === undefined || ov.until > now;
}

/** そのタイルの実効地形（上書き優先、失効・未設定なら生成地形）。 */
export function effectiveTile(
  map: TopDownMap,
  overrides: TileOverridesMap,
  x: number,
  y: number,
  now: number,
): number {
  const ov = overrides[tileKey(x, y)];
  if (isOverrideActive(ov, now) && ov && ov.tile !== undefined) return ov.tile;
  return mapTileAt(map, x, y);
}

/** 作物の成長段階 0=芽 1=若葉 2=収穫可。 */
export function cropStage(crop: CropState, now: number): 0 | 1 | 2 {
  if (now >= crop.readyAt) return 2;
  const span = Math.max(1, crop.readyAt - crop.plantedAt);
  return (now - crop.plantedAt) / span < 0.5 ? 0 : 1;
}

/** クライアント描画・行為判定用のタイルビュー。 */
export type TileView = {
  x: number;
  y: number;
  /** 実効地形。 */
  tile: number;
  farmland: boolean;
  stump: boolean;
  crop: { cropId: string; stage: 0 | 1 | 2; ready: boolean } | null;
  /** 自分の作物・作業かどうか。 */
  mine: boolean;
};

export function tileView(
  map: TopDownMap,
  overrides: TileOverridesMap,
  x: number,
  y: number,
  now: number,
  selfKey: string | null,
): TileView {
  const ov = overrides[tileKey(x, y)];
  const active = isOverrideActive(ov, now) ? ov : null;
  const crop = active?.crop ?? null;
  return {
    x,
    y,
    tile: effectiveTile(map, overrides, x, y, now),
    farmland: active?.farmland === true,
    stump: active?.stump === true,
    crop: crop
      ? { cropId: crop.cropId, stage: cropStage(crop, now), ready: now >= crop.readyAt }
      : null,
    mine: selfKey !== null && active !== null && active.ownerId === presenceIdFor(selfKey),
  };
}

// ---------------------------------------------------------------- 検証・適用
/** その種類の道具をどれか持っているか。 */
export function hasTool(profile: PlayerProfile, kind: ToolKind): boolean {
  return ITEMS.some((i) => i.tool === kind && countItem(profile, i.id) > 0);
}

export type TileActionKind = "chop" | "mine" | "till" | "plant" | "harvest";

export type TileActionResult =
  | {
      ok: true;
      /** そのタイルの新しい上書き（null は上書き削除）。 */
      override: TileOverride | null;
      profile: PlayerProfile;
      view: TileView;
      /** 得たアイテム（収穫・伐採・採掘）。 */
      gained: Record<string, number>;
    }
  | { ok: false; error: string };

function checkedTile(xRaw: unknown, yRaw: unknown): { x: number; y: number } | null {
  if (typeof xRaw !== "number" || typeof yRaw !== "number") return null;
  if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) return null;
  const x = Math.floor(xRaw);
  const y = Math.floor(yRaw);
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return null;
  return { x, y };
}

function viewAfter(
  map: TopDownMap,
  overrides: TileOverridesMap,
  key: string,
  next: TileOverride | null,
  x: number,
  y: number,
  now: number,
  selfKey: string,
): TileView {
  const merged = { ...overrides };
  if (next) merged[key] = next;
  else delete merged[key];
  return tileView(map, merged, x, y, now, selfKey);
}

/**
 * タイル行為の適用（1タイル分）。地形の適否・道具の所持・作物の成長を
 * すべてサーバー側の真値（生成地形＋保存済み上書き）で検証する。
 * - chop: 斧で木/雪の木 → 草/雪＋木材。切り株が残り、6時間で再生する
 * - mine: ツルハシで岩 → 土＋石材（再生しない）
 * - till: クワで草/土 → 畑
 * - plant: 畑に種を植える（種を消費、成長時間はカタログ）
 * - harvest: 育った作物を持つ（所有者だけが収穫できる）
 */
export function applyTileAction(
  current: TileOverride | null,
  profile: PlayerProfile,
  map: TopDownMap,
  ownerKey: string,
  action: unknown,
  xRaw: unknown,
  yRaw: unknown,
  seedIdRaw: unknown,
  now: number,
): TileActionResult {
  if (action !== "chop" && action !== "mine" && action !== "till" && action !== "plant" && action !== "harvest") {
    return { ok: false, error: "invalid_action" };
  }
  const tile = checkedTile(xRaw, yRaw);
  if (!tile) return { ok: false, error: "invalid_tile" };
  const { x, y } = tile;
  const key = tileKey(x, y);
  const overrides: TileOverridesMap = current ? { [key]: current } : {};
  const active = isOverrideActive(current, now) ? current : null;
  const base = mapTileAt(map, x, y);
  const eff = active?.tile !== undefined ? active.tile : base;
  const selfId = presenceIdFor(ownerKey);
  const done = (
    override: TileOverride | null,
    nextProfile: PlayerProfile,
    gained: Record<string, number>,
  ): TileActionResult => ({
    ok: true,
    override,
    profile: nextProfile,
    view: viewAfter(map, overrides, key, override, x, y, now, ownerKey),
    gained,
  });

  switch (action) {
    case "chop": {
      if (eff !== T_TREE && eff !== T_SNOW_TREE) return { ok: false, error: "tile_blocked" };
      if (!hasTool(profile, "axe")) return { ok: false, error: "tool_required" };
      const next: TileOverride = {
        tile: eff === T_SNOW_TREE ? T_SNOW : T_GRASS,
        stump: true,
        ownerId: selfId,
        until: now + TREE_REGROW_MS,
      };
      return done(next, addItem(profile, "wood", CHOP_WOOD_COUNT), { wood: CHOP_WOOD_COUNT });
    }
    case "mine": {
      if (eff !== T_ROCK) return { ok: false, error: "tile_blocked" };
      if (!hasTool(profile, "pickaxe")) return { ok: false, error: "tool_required" };
      const next: TileOverride = { tile: T_DIRT, ownerId: selfId };
      return done(next, addItem(profile, "stone", MINE_STONE_COUNT), { stone: MINE_STONE_COUNT });
    }
    case "till": {
      if (eff !== T_GRASS && eff !== T_DIRT) return { ok: false, error: "tile_blocked" };
      if (active?.farmland) return { ok: false, error: "tile_blocked" };
      if (active?.crop) return { ok: false, error: "tile_blocked" };
      if (!hasTool(profile, "hoe")) return { ok: false, error: "tool_required" };
      const next: TileOverride = {
        ...(active?.tile !== undefined ? { tile: active.tile } : {}),
        farmland: true,
        crop: null,
        ownerId: selfId,
      };
      return done(next, profile, {});
    }
    case "plant": {
      if (!active?.farmland || active.crop) return { ok: false, error: "tile_blocked" };
      const cropDef = cropBySeedId(seedIdRaw);
      if (!cropDef) return { ok: false, error: "unknown_seed" };
      const removed = removeItem(profile, cropDef.seedId, 1);
      if (!removed) return { ok: false, error: "not_enough_items" };
      const next: TileOverride = {
        ...active,
        farmland: true,
        crop: {
          cropId: cropDef.id,
          plantedAt: now,
          readyAt: now + cropDef.growthMinutes * 60_000,
        },
        ownerId: selfId,
      };
      return done(next, removed, {});
    }
    case "harvest": {
      const crop = active?.crop ?? null;
      if (!crop) return { ok: false, error: "no_crop" };
      if (active && active.ownerId !== selfId) return { ok: false, error: "not_owner" };
      if (now < crop.readyAt) return { ok: false, error: "not_ready" };
      const cropDef = cropById(crop.cropId);
      if (!cropDef) return { ok: false, error: "no_crop" };
      const next: TileOverride = { ...active, farmland: true, crop: null, ownerId: selfId };
      return done(
        next,
        addItem(profile, cropDef.produceId, cropDef.produceCount),
        { [cropDef.produceId]: cropDef.produceCount },
      );
    }
  }
}

// ---------------------------------------------------------------- 保存形式
function parseCropState(raw: unknown): CropState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const def = cropById(v.cropId);
  if (!def) return null;
  if (typeof v.plantedAt !== "number" || !Number.isFinite(v.plantedAt)) return null;
  if (typeof v.readyAt !== "number" || !Number.isFinite(v.readyAt)) return null;
  return { cropId: def.id, plantedAt: v.plantedAt, readyAt: v.readyAt };
}

/** bot_kv の1値から上書きを復元する。壊れていれば null。 */
export function parseTileOverride(raw: unknown): TileOverride | null {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const v = data as Record<string, unknown>;
  if (typeof v.ownerId !== "string" || v.ownerId.length === 0) return null;
  const out: TileOverride = { ownerId: v.ownerId };
  if (typeof v.tile === "number" && Number.isFinite(v.tile) && v.tile >= 0 && v.tile <= T_SNOW_TREE) {
    out.tile = Math.floor(v.tile);
  }
  if (v.farmland === true) out.farmland = true;
  if (v.stump === true) out.stump = true;
  if (v.crop === null) out.crop = null;
  else if (v.crop !== undefined) {
    const crop = parseCropState(v.crop);
    if (crop) out.crop = crop;
  }
  if (typeof v.until === "number" && Number.isFinite(v.until)) out.until = v.until;
  return out;
}

/** 名前空間まるごとの値（キー→値）から上書きマップを復元する。 */
export function parseTileOverrides(rows: ReadonlyMap<string, unknown>): TileOverridesMap {
  const out: TileOverridesMap = {};
  for (const [key, raw] of rows) {
    if (!parseTileKey(key)) continue;
    const ov = parseTileOverride(raw);
    if (ov) out[key] = ov;
  }
  return out;
}

// ---------------------------------------------------------------- クライアント判定
export type TileContextAction =
  | { action: TileActionKind; seedId?: string }
  | { action: "plant-picker" }
  | null;

/**
 * 選択中の枠（道具 or 種）とタイルの状態から、タップで起きる行為を決める。
 * 優先順: 収穫（育っていれば素手でも）→ 作付け → 道具ごとの行為。
 */
export function actionForTile(
  view: TileView,
  selected: { tool?: ToolKind; seedId?: string } | null,
): TileContextAction {
  if (view.crop?.ready) return { action: "harvest" };
  if (view.farmland && !view.crop) {
    if (selected?.seedId) return { action: "plant", seedId: selected.seedId };
    return { action: "plant-picker" };
  }
  if (view.crop) return null; // 育ちきるまでは何もしない
  const tool = selected?.tool;
  if (!tool) return null;
  if ((view.tile === T_TREE || view.tile === T_SNOW_TREE) && tool === "axe") return { action: "chop" };
  if (view.tile === T_ROCK && tool === "pickaxe") return { action: "mine" };
  if ((view.tile === T_GRASS || view.tile === T_DIRT) && !view.farmland && tool === "hoe") {
    return { action: "till" };
  }
  return null;
}
