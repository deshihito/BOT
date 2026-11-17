// AGO WORLD BOX のタイル上書き（純粋ロジック、DOM 非依存）。
// 地形そのものは固定シードから決定的に生成されるため保存しない。ここで
// 扱うのはプレイヤーの行為で変わった差分だけ: 伐採・採掘・耕作・作付け。
// 農業は「畑を設置」するのではなく、地面を耕して好きな作物を植える。
// 保存は tiles-online.ts（bot_kv、タイルごとのキー）が担う。
import { ITEMS, cropById, cropBySeedId, itemById, type ItemDef, type ToolKind } from "./items";
import {
  T_DIRT, T_GRASS, T_ROCK, T_SAND, T_SNOW, T_SNOW_TREE, T_TREE, T_WATER, WORLD_COORD_LIMIT,
  mapTileAt, type TopDownMap,
} from "./mapgen";
import {
  addItem, bestToolItem, countItem, removeItem, wearTool, type PlayerProfile,
} from "./profile";
import { presenceIdFor } from "./presence";
import { seasonGrowthMult } from "./seasons";

/** 伐採した木が再生するまでの時間（6時間）。 */
export const TREE_REGROW_MS = 6 * 3600 * 1000;
/** 掘った岩が戻るまでの時間（資源の再成長）。 */
export const ROCK_REGROW_MS = 3 * 3600 * 1000;
/** 伐採・採掘の収穫数。伐採は素手でもでき、斧があると収量が2倍になる。 */
export const CHOP_WOOD_COUNT = 2;
export const CHOP_WOOD_BAREHAND = 1;
export const MINE_STONE_COUNT = 2;
/**
 * 地形の岩・木の耐久（HP制、2026-11-17 ユーザー指示「岩殴ったら1発で
 * 壊れた、耐久値が欲しい」）。ダメージは設置ブロックと同じ
 * BLOCK_MINE_DAMAGE（道具ティア依存）を使うため、岩はミスリル（40）でも
 * 2ヒット、木は斧が育つほど速く倒れる。素手の伐採は 6 ダメージ。
 */
export const TERRAIN_ROCK_HP = 60;
export const TERRAIN_TREE_HP = 30;

/** 地形タイルの最大 HP（HP制の対象でなければ 0）。 */
export function terrainMaxHp(tile: number): number {
  if (tile === T_ROCK) return TERRAIN_ROCK_HP;
  if (tile === T_TREE || tile === T_SNOW_TREE) return TERRAIN_TREE_HP;
  return 0;
}

export type CropState = {
  cropId: string;
  plantedAt: number;
  readyAt: number;
};

/** 設置されたブロック/施設（自由建築）。掘れるのは設置者だけ（後述）。 */
export type PlacedBlock = {
  /** ブロック/施設カテゴリのアイテム ID。 */
  itemId: string;
  /** 設置者の不透明 ID。 */
  ownerId: string;
  /**
   * 残り耐久（HP制: 採掘1ヒットごとに減り、0で壊れる）。
   * 未設定は満タン扱い（HP制より前の旧データ互換）。
   */
  hp?: number;
};

/**
 * 設置物が移動の当たり判定を持つか。固体ブロックは true、施設
 * （ItemDef.facility: 作業台・家具など）は false — 施設はそのマスを
 * 占有する（他のブロック/施設は置けない）が、プレイヤーは通過できる。
 * 床ブロック（小道・氷・はちみつ・スライム・橋）も false で、上に乗れる。
 * 区別はアイテム定義のデータで持つ。
 */
export function placedBlockSolid(itemId: string): boolean {
  if (isFloorItem(itemId)) return false;
  if (isFenceItem(itemId)) return true;
  const def = itemById(itemId);
  return def !== null && def.facility !== true;
}

/** 設置した施設が提供する作業種別（レシピ種別＋強化）。 */
export type StationKind = "craft" | "smelt" | "cook" | "weave" | "enhance";

/** 設置物 → 近くでできる作業種別。作業台=合成、鍛冶台=合成+強化、金床=強化、
 * かまど=精錬、焚き火・調理鍋=調理、織り機=織り。 */
export const PLACED_STATION_KINDS: Readonly<Record<string, readonly StationKind[]>> = {
  workbench: ["craft"],
  smithing_table: ["craft", "enhance"],
  anvil: ["enhance"],
  furnace: ["smelt"],
  campfire: ["cook"],
  cooking_pot: ["cook"],
  loom: ["weave"],
};

export function placedStationKinds(itemId: unknown): readonly StationKind[] {
  if (typeof itemId !== "string") return [];
  return PLACED_STATION_KINDS[itemId] ?? [];
}

/** 床ブロック: 固体にせず、上に乗ると効果がある（橋は水上に置けて渡れる）。 */
export const FLOOR_ITEM_IDS: ReadonlySet<string> = new Set([
  "path_block", "ice_block", "honey_block", "slime_block", "bridge_block",
]);

export function isFloorItem(itemId: string): boolean {
  return FLOOR_ITEM_IDS.has(itemId);
}

/** 床の歩行速度倍率（小道は速く、はちみつは遅い。それ以外は等倍）。 */
export function floorSpeedMultiplier(itemId: string | null): number {
  if (itemId === "path_block") return 1.3;
  if (itemId === "honey_block") return 0.5;
  return 1;
}

/** 柵: 家具扱い（facility）だが、区切りとして固体にする（placedBlockSolid の例外）。 */
export const FENCE_ITEM_IDS: ReadonlySet<string> = new Set([
  "fence_wood", "stone_fence", "iron_fence",
]);

export function isFenceItem(itemId: string): boolean {
  return FENCE_ITEM_IDS.has(itemId);
}

/** 開閉できる門。閉じている間は固体、開けば通過できる（固体判定は上書きの gateOpen と併せて行う）。 */
export const GATE_ITEM_IDS: ReadonlySet<string> = new Set(["wooden_gate"]);

export function isGateItem(itemId: string): boolean {
  return GATE_ITEM_IDS.has(itemId);
}

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
  /** 設置されたブロック/施設。固体ブロックのタイルは立てない。施設は占有のみで通過できる。 */
  block?: PlacedBlock;
  /** 地形（岩・木）の残り HP。未設定は満タン。壊れるまで tile は変わらない。 */
  hp?: number;
  /** 植木鉢・プランターに植えた飾りのアイテム ID（現在は "flower" のみ）。 */
  deco?: string;
  /** 門（wooden_gate）の開閉状態。true は開いている（通過できる）。 */
  gateOpen?: boolean;
  /** 看板（sign_board）に書かれたテキスト。所有者だけが編集できる。 */
  signText?: string;
  /** 棚（item_shelf）に展示中のアイテム ID。 */
  display?: string;
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
  if (Math.abs(x) > WORLD_COORD_LIMIT || Math.abs(y) > WORLD_COORD_LIMIT) return null;
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
  /** 設置されたブロック（自分のものかどうか・残り HP 割合・門の開閉・看板・展示つき）。 */
  block: { itemId: string; mine: boolean; hpFrac: number; gateOpen?: boolean; signText?: string; display?: string } | null;
  /** 地形（岩・木）の残り HP 割合（1 = 無傷。HP制の対象でないタイルは 1）。 */
  hpFrac: number;
  /** 自分の作物・作業かどうか。 */
  mine: boolean;
};

/** 地形の残り HP 割合（1 = 無傷）。hp 未設定・対象外タイルは 1。 */
export function terrainHpFraction(ov: TileOverride | null | undefined, tile: number): number {
  const max = terrainMaxHp(tile);
  if (max <= 0) return 1;
  const hp = ov?.hp === undefined ? max : ov.hp;
  return Math.max(0, Math.min(1, hp / max));
}

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
  const selfId = selfKey !== null ? presenceIdFor(selfKey) : null;
  const effTile = effectiveTile(map, overrides, x, y, now);
  return {
    x,
    y,
    tile: effTile,
    hpFrac: terrainHpFraction(active, effTile),
    farmland: active?.farmland === true,
    stump: active?.stump === true,
    crop: crop
      ? { cropId: crop.cropId, stage: cropStage(crop, now), ready: now >= crop.readyAt }
      : null,
    block: active?.block
      ? {
          itemId: active.block.itemId,
          mine: selfId !== null && active.block.ownerId === selfId,
          hpFrac: blockHpFraction(active.block),
          ...(active.gateOpen !== undefined ? { gateOpen: active.gateOpen } : {}),
          ...(active.signText ? { signText: active.signText } : {}),
          ...(active.display ? { display: active.display } : {}),
        }
      : null,
    mine: selfId !== null && active !== null && active.ownerId === selfId,
  };
}

// ---------------------------------------------------------------- 検証・適用
/** その種類の道具をどれか持っているか。 */
export function hasTool(profile: PlayerProfile, kind: ToolKind): boolean {
  return ITEMS.some((i) => i.tool === kind && countItem(profile, i.id) > 0);
}

export type TileActionKind =
  | "chop" | "mine" | "till" | "plant" | "harvest"
  | "place_block" | "mine_block" | "plant_flower" | "remove_flower" | "toggle_gate"
  | "set_sign" | "set_display" | "clear_display" | "draw_water";

export type TileActionResult =
  | {
      ok: true;
      /** そのタイルの新しい上書き（null は上書き削除）。 */
      override: TileOverride | null;
      profile: PlayerProfile;
      view: TileView;
      /** 得たアイテム（収穫・伐採・採掘）。 */
      gained: Record<string, number>;
      /** この行為で壊れた道具のアイテム ID（無ければ null/未設定）。 */
      broke?: string | null;
    }
  | { ok: false; error: string };

function checkedTile(xRaw: unknown, yRaw: unknown): { x: number; y: number } | null {
  if (typeof xRaw !== "number" || typeof yRaw !== "number") return null;
  if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) return null;
  const x = Math.floor(xRaw);
  const y = Math.floor(yRaw);
  if (Math.abs(x) > WORLD_COORD_LIMIT || Math.abs(y) > WORLD_COORD_LIMIT) return null;
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
 * - chop: 木/雪の木 → 草/雪＋木材（素手可。斧所持で収量2倍）。切り株が残り、6時間で再生する
 * - mine: ツルハシで岩 → 土＋石材（再生しない。ツルハシ必須）
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
    broke: string | null = null,
  ): TileActionResult => ({
    ok: true,
    override,
    profile: nextProfile,
    view: viewAfter(map, overrides, key, override, x, y, now, ownerKey),
    gained,
    broke,
  });

  switch (action) {
    case "chop": {
      if (eff !== T_TREE && eff !== T_SNOW_TREE) return { ok: false, error: "tile_blocked" };
      // HP制: 1タップ = 1ヒット。ダメージは斧の実効ティア（素手は最低段 6）。
      // 伐採は素手でもできる。道具は必須ではなく効率と収量に効く。
      const axe = bestToolItem(profile, "axe");
      const dmg = BLOCK_MINE_DAMAGE[Math.max(0, Math.min(BLOCK_MINE_DAMAGE.length - 1, bestToolTier(profile, "axe")))];
      const worn = axe ? wearTool(profile, "axe") : { profile, brokeItemId: null };
      const hpNow = Math.min(active?.hp ?? TERRAIN_TREE_HP, TERRAIN_TREE_HP);
      if (hpNow - dmg > 0) {
        // 倒れるまでは HP が減った上書きだけを返す（地形は木のまま）
        const next: TileOverride = { ...(active ?? { ownerId: selfId }), hp: hpNow - dmg, ownerId: selfId };
        return done(next, worn.profile, {}, worn.brokeItemId);
      }
      const count = axe ? CHOP_WOOD_COUNT : CHOP_WOOD_BAREHAND;
      const next: TileOverride = {
        tile: eff === T_SNOW_TREE ? T_SNOW : T_GRASS,
        stump: true,
        ownerId: selfId,
        until: now + TREE_REGROW_MS,
      };
      return done(next, addItem(worn.profile, "wood", count), { wood: count }, worn.brokeItemId);
    }
    case "mine": {
      if (eff !== T_ROCK) return { ok: false, error: "tile_blocked" };
      if (!hasTool(profile, "pickaxe")) return { ok: false, error: "tool_required" };
      // HP制: 1タップ = 1ヒット。ダメージはツルハシの実効ティア。
      // 岩はミスリル（40）でも 2 ヒットかかる（TERRAIN_ROCK_HP = 60）。
      const dmg = BLOCK_MINE_DAMAGE[Math.max(0, Math.min(BLOCK_MINE_DAMAGE.length - 1, bestToolTier(profile, "pickaxe")))];
      const worn = wearTool(profile, "pickaxe");
      const hpNow = Math.min(active?.hp ?? TERRAIN_ROCK_HP, TERRAIN_ROCK_HP);
      if (hpNow - dmg > 0) {
        const next: TileOverride = { ...(active ?? { ownerId: selfId }), hp: hpNow - dmg, ownerId: selfId };
        return done(next, worn.profile, {}, worn.brokeItemId);
      }
      // 掘った岩は一定時間で戻る（資源の再成長。until を過ぎれば地形どおり岩になる）
      const next: TileOverride = { tile: T_DIRT, ownerId: selfId, until: now + ROCK_REGROW_MS };
      return done(next, addItem(worn.profile, "stone", MINE_STONE_COUNT), { stone: MINE_STONE_COUNT }, worn.brokeItemId);
    }
    case "till": {
      if (eff !== T_GRASS && eff !== T_DIRT) return { ok: false, error: "tile_blocked" };
      if (active?.farmland) return { ok: false, error: "tile_blocked" };
      if (active?.crop) return { ok: false, error: "tile_blocked" };
      if (active?.block) return { ok: false, error: "tile_blocked" };
      if (!hasTool(profile, "hoe")) return { ok: false, error: "tool_required" };
      const worn = wearTool(profile, "hoe");
      const next: TileOverride = {
        ...(active?.tile !== undefined ? { tile: active.tile } : {}),
        farmland: true,
        crop: null,
        ownerId: selfId,
      };
      return done(next, worn.profile, {}, worn.brokeItemId);
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
          readyAt: now + Math.round(cropDef.growthMinutes * 60_000 * seasonGrowthMult(cropDef.season, now)),
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

// ---------------------------------------------------------------- 自由建築
/** ブロックを置ける地形（更地のみ。畑・作物・再生待ちの上には置けない）。 */
const PLACEABLE_TERRAIN: ReadonlySet<number> = new Set([T_GRASS, T_DIRT, T_SAND, T_SNOW]);
/** この耐久以上のブロックは、素材に合った道具がないと掘れない。 */
export const HARD_BLOCK_DURABILITY = 50;

/** 硬いブロックを掘るのに要る道具（柔らかいブロックは素手で掘れる）。 */
export function blockMineTool(def: ItemDef): ToolKind | null {
  if ((def.durability ?? 0) < HARD_BLOCK_DURABILITY) return null;
  return def.mineTool ?? "pickaxe";
}

/** 耐久が未定義の設置物（家具など）の最大 HP。 */
export const DEFAULT_BLOCK_HP = 10;
/** ブロック採掘の1ヒットのダメージ（実効ティア 0〜4 = 素手・木・石・鉄・ミスリル）。 */
export const BLOCK_MINE_DAMAGE: readonly number[] = [6, 10, 16, 25, 40];

/** 設置ブロックの最大 HP（= アイテムの耐久。未定義は既定値）。 */
export function blockMaxHp(def: ItemDef): number {
  return def.durability ?? DEFAULT_BLOCK_HP;
}

/** 設置ブロックの残り HP 割合（1 = 無傷）。hp 未設定の旧データは満タン。 */
export function blockHpFraction(block: PlacedBlock): number {
  const def = itemById(block.itemId);
  if (!def) return 1;
  const max = blockMaxHp(def);
  if (max <= 0) return 1;
  const hp = block.hp === undefined ? max : block.hp;
  return Math.max(0, Math.min(1, hp / max));
}

/**
 * その種類の道具の所持最高ティア（持っていなければ 0）。
 * 強化レベルはティアに加算する（剣の playerAttack と同じ実効ティアの規則:
 * ティア + 強化レベル）。ツルハシ・斧の強化はここを通して採掘ダメージに効く。
 */
export function bestToolTier(profile: PlayerProfile, kind: ToolKind): number {
  const best = bestToolItem(profile, kind);
  if (!best) return 0;
  return (best.tier ?? 0) + (profile.enhance?.[best.id] ?? 0);
}

/**
 * ブロック採掘の1ヒットのダメージ。道具を要求するブロックはその道具の
 * 所持最高ティアで、道具不要のブロックは斧/ツルハシの高い方のティアで決まる。
 */
export function blockMineDamage(profile: PlayerProfile, def: ItemDef): number {
  const tool = blockMineTool(def);
  const tier = tool
    ? bestToolTier(profile, tool)
    : Math.max(bestToolTier(profile, "axe"), bestToolTier(profile, "pickaxe"));
  const idx = Math.max(0, Math.min(BLOCK_MINE_DAMAGE.length - 1, tier));
  return BLOCK_MINE_DAMAGE[idx];
}

/** 設置の文脈（ユニオンマークはルート側が真値を持つ）。 */
export type PlaceBlockContext = {
  onCapital: boolean;
};

/**
 * ブロック設置: ブロック/施設カテゴリのアイテムを1つ消費し、更地に置く。
 * 家は「設置」ではなくブロックを積んで作る、が自由建築の前提。
 * 施設も同じ枠で置く（占有あり・当たり判定なし）。
 */
export function applyPlaceBlock(
  current: TileOverride | null,
  profile: PlayerProfile,
  map: TopDownMap,
  ownerKey: string,
  xRaw: unknown,
  yRaw: unknown,
  itemIdRaw: unknown,
  now: number,
  ctx: PlaceBlockContext,
): TileActionResult {
  const held = itemById(itemIdRaw);
  // 基本素材（木材・石材）はそのままブロックとして置ける: 消費は素材、
  // 設置されるのは placesBlock のブロック定義（描画・耐久・回収はブロック側）
  const def = held?.placesBlock ? itemById(held.placesBlock) : held;
  if (!held || !def || (def.category !== "block" && def.facility !== true)) {
    return { ok: false, error: "unknown_block" };
  }
  const tile = checkedTile(xRaw, yRaw);
  if (!tile) return { ok: false, error: "invalid_tile" };
  const { x, y } = tile;
  const key = tileKey(x, y);
  if (ctx.onCapital) return { ok: false, error: "on_capital" };
  const active = isOverrideActive(current, now) ? current : null;
  if (active?.block) return { ok: false, error: "tile_blocked" };
  if (active?.crop) return { ok: false, error: "tile_blocked" };
  if (active?.farmland) return { ok: false, error: "tile_blocked" };
  if (active?.stump) return { ok: false, error: "tile_blocked" }; // 木の再生待ち（切り株）
  // 岩の再生待ちの土は設置できる（下地として保持され、until は引き継ぐ）
  const eff = active?.tile !== undefined ? active.tile : mapTileAt(map, x, y);
  // 橋だけは水の上にも置ける（渡れる板）。それ以外の設置物は陸地のみ。
  const placeable = PLACEABLE_TERRAIN.has(eff) || (def.id === "bridge_block" && eff === T_WATER);
  if (!placeable) return { ok: false, error: "tile_blocked" };
  const removed = removeItem(profile, held.id, 1);
  if (!removed) return { ok: false, error: "not_enough_items" };
  const selfId = presenceIdFor(ownerKey);
  const next: TileOverride = {
    ...(active ?? { ownerId: selfId }),
    block: { itemId: def.id, ownerId: selfId, hp: blockMaxHp(def) },
    ownerId: selfId,
  };
  const overrides: TileOverridesMap = current ? { [key]: current } : {};
  return {
    ok: true,
    override: next,
    profile: removed,
    view: viewAfter(map, overrides, key, next, x, y, now, ownerKey),
    gained: {},
  };
}

/**
 * ブロック採掘: 設置者だけが掘れる。ただしユニオン戦争中は、攻撃側の国民が
 * 防衛側の首都の WAR_TERRITORY_RADIUS 以内にある他者ブロックを掘れる
 * （ルート側が戦争状態を検証して warBreakAllowed を渡す。掘ったブロックは
 * 掘った者の所持品に入る＝略奪ルール）。硬いブロックは道具が要る。
 * 収納コンテナ（樽・木箱・宝箱）は中身が全員共有の仕様に合わせて、回収も
 * 誰でもできる（ルート側がコンテナ判定して containerBreakAllowed を渡す。
 * 中身が空のときだけ、はルート側の not_empty 検証が担保する）。
 * HP制: 1回 = 1ヒットで、ダメージは道具のティアで変わる。HP が残れば
 * ブロックは残り（アイテムは得られない）、0 以下で壊れてアイテムに戻る。
 * 戦争破壊も同じ HP 経路を通る（1ヒット即消しにはしない）。
 */
export type MineBlockContext = {
  /** 戦争中の他者ブロック破壊がこの1回で許可されているか。 */
  warBreakAllowed?: boolean;
  /** 収納コンテナの回収（中身は共有仕様のため所有者以外も可）。 */
  containerBreakAllowed?: boolean;
};

export function applyMineBlock(
  current: TileOverride | null,
  profile: PlayerProfile,
  map: TopDownMap,
  ownerKey: string,
  xRaw: unknown,
  yRaw: unknown,
  now: number,
  ctx: MineBlockContext = {},
): TileActionResult {
  const tile = checkedTile(xRaw, yRaw);
  if (!tile) return { ok: false, error: "invalid_tile" };
  const { x, y } = tile;
  const key = tileKey(x, y);
  const active = isOverrideActive(current, now) ? current : null;
  const block = active?.block;
  if (!active || !block) return { ok: false, error: "no_block" };
  const selfId = presenceIdFor(ownerKey);
  if (block.ownerId !== selfId && !ctx.warBreakAllowed && !ctx.containerBreakAllowed) return { ok: false, error: "not_owner" };
  const def = itemById(block.itemId);
  if (!def) return { ok: false, error: "no_block" };
  const tool = blockMineTool(def);
  if (tool && !hasTool(profile, tool)) return { ok: false, error: "tool_required" };
  // 道具の耐久: ダメージ源になった道具が1ヒットぶん摩耗する。要求道具が
  // あるブロックはその道具、無いブロックはダメージの出典（斧/ツルハシの
  // 実効ティアが高い方）。どちらも持っていなければ素手で、摩耗しない。
  const wearKind: ToolKind | null = tool ?? (
    bestToolItem(profile, "axe") || bestToolItem(profile, "pickaxe")
      ? (bestToolTier(profile, "axe") >= bestToolTier(profile, "pickaxe") ? "axe" : "pickaxe")
      : null
  );
  const worn = wearKind ? wearTool(profile, wearKind) : { profile, brokeItemId: null };
  // HP制: 1ヒット分のダメージを適用する。残れば hp が減った上書きを返す
  const maxHp = blockMaxHp(def);
  const hpNow = Math.min(block.hp ?? maxHp, maxHp);
  const hpNext = hpNow - blockMineDamage(profile, def);
  if (hpNext > 0) {
    const next: TileOverride = { ...active, block: { ...block, hp: hpNext }, ownerId: selfId };
    const overrides: TileOverridesMap = { [key]: active };
    return {
      ok: true,
      override: next,
      profile: worn.profile,
      view: viewAfter(map, overrides, key, next, x, y, now, ownerKey),
      gained: {},
      broke: worn.brokeItemId,
    };
  }
  const rest: TileOverride = { ...active, ownerId: selfId };
  delete rest.block;
  delete rest.deco; // 植えた花は鉢ごと失われる
  delete rest.signText; // 看板の文字も板ごと失われる
  delete rest.display; // 展示品は棚ごと失われる（アイテムは戻らない）
  const empty =
    rest.tile === undefined && rest.farmland !== true && rest.crop === undefined &&
    rest.stump !== true && rest.until === undefined;
  const next = empty ? null : rest;
  const overrides: TileOverridesMap = { [key]: active };
  return {
    ok: true,
    override: next,
    profile: addItem(worn.profile, def.id, 1),
    view: viewAfter(map, overrides, key, next, x, y, now, ownerKey),
    gained: { [def.id]: 1 },
    broke: worn.brokeItemId,
  };
}

/** 花を植えられる施設（植木鉢・プランター）。 */
export const FLOWER_POT_ITEM_IDS: readonly string[] = ["planter", "flower_pot"];

export function isFlowerPotItem(itemId: unknown): boolean {
  return typeof itemId === "string" && FLOWER_POT_ITEM_IDS.includes(itemId);
}

/** 座れる家具（ベンチ・椅子・ソファ）。座る動作はクライアント側の見た目だけ。 */
export const SEAT_ITEM_IDS: readonly string[] = ["bench", "chair", "sofa"];

export function isSeatItem(itemId: unknown): boolean {
  return typeof itemId === "string" && SEAT_ITEM_IDS.includes(itemId);
}

/** テキストを書ける看板。 */
export const SIGN_ITEM_IDS: readonly string[] = ["sign_board"];

export function isSignItem(itemId: unknown): boolean {
  return typeof itemId === "string" && SIGN_ITEM_IDS.includes(itemId);
}

/** 看板テキストの最大文字数。 */
export const SIGN_TEXT_MAX = 40;

/** 看板テキストの整形: 制御文字と改行を空白にし、前後を整えて最大長で切る。 */
export function sanitizeSignText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, SIGN_TEXT_MAX);
}

/** アイテムを展示できる棚。 */
export const SHELF_ITEM_IDS: readonly string[] = ["item_shelf"];

export function isShelfItem(itemId: unknown): boolean {
  return typeof itemId === "string" && SHELF_ITEM_IDS.includes(itemId);
}

/** 水を汲める井戸。 */
export const WELL_ITEM_IDS: readonly string[] = ["well"];

export function isWellItem(itemId: unknown): boolean {
  return typeof itemId === "string" && WELL_ITEM_IDS.includes(itemId);
}

/**
 * 井戸で水を汲む（誰でも可）: バケツを1つ消費して水入りバケツを1つ得る。
 * 水入りバケツは飲むと空のバケツに戻る（economy.eatItem の containerReturn）。
 * 売買の対象にしないため、汲み取りでコインは生まれない。
 */
export function applyDrawWater(
  current: TileOverride | null,
  profile: PlayerProfile,
  map: TopDownMap,
  ownerKey: string,
  xRaw: unknown,
  yRaw: unknown,
  now: number,
): TileActionResult {
  const tile = checkedTile(xRaw, yRaw);
  if (!tile) return { ok: false, error: "invalid_tile" };
  const { x, y } = tile;
  const key = tileKey(x, y);
  const active = isOverrideActive(current, now) ? current : null;
  if (!active?.block || !isWellItem(active.block.itemId)) return { ok: false, error: "no_block" };
  const removed = removeItem(profile, "bucket", 1);
  if (!removed) return { ok: false, error: "not_enough_items" };
  const overrides: TileOverridesMap = { [key]: active };
  return {
    ok: true,
    override: active,
    profile: addItem(removed, "water_bucket", 1),
    view: viewAfter(map, overrides, key, active, x, y, now, ownerKey),
    gained: { water_bucket: 1 },
  };
}

/**
 * 看板テキストの設定（所有者だけ）。空文字はテキストの消去。
 * 状態はタイル上書きの signText に持つ（板が壊れたら文字も失われる）。
 */
export function applySetSign(
  current: TileOverride | null,
  profile: PlayerProfile,
  map: TopDownMap,
  ownerKey: string,
  xRaw: unknown,
  yRaw: unknown,
  textRaw: unknown,
  now: number,
): TileActionResult {
  const tile = checkedTile(xRaw, yRaw);
  if (!tile) return { ok: false, error: "invalid_tile" };
  const { x, y } = tile;
  const key = tileKey(x, y);
  const active = isOverrideActive(current, now) ? current : null;
  if (!active?.block || !isSignItem(active.block.itemId)) return { ok: false, error: "no_block" };
  const selfId = presenceIdFor(ownerKey);
  if (active.block.ownerId !== selfId) return { ok: false, error: "not_owner" };
  const text = sanitizeSignText(textRaw);
  const next: TileOverride = { ...active };
  if (text) next.signText = text;
  else delete next.signText;
  const overrides: TileOverridesMap = { [key]: active };
  return {
    ok: true,
    override: next,
    profile,
    view: viewAfter(map, overrides, key, next, x, y, now, ownerKey),
    gained: {},
  };
}

/**
 * 棚への展示/回収（所有者だけ）。
 * set_display: 手持ちのアイテムを1つ消費して展示する（既に展示中なら差し替えず不可）。
 * clear_display: 展示品を手元に戻す。
 * 状態はタイル上書きの display に持つ（棚が壊れたら展示品も失われる）。
 */
export function applyDisplayAction(
  current: TileOverride | null,
  profile: PlayerProfile,
  map: TopDownMap,
  ownerKey: string,
  xRaw: unknown,
  yRaw: unknown,
  action: "set_display" | "clear_display",
  itemIdRaw: unknown,
  now: number,
): TileActionResult {
  const tile = checkedTile(xRaw, yRaw);
  if (!tile) return { ok: false, error: "invalid_tile" };
  const { x, y } = tile;
  const key = tileKey(x, y);
  const active = isOverrideActive(current, now) ? current : null;
  if (!active?.block || !isShelfItem(active.block.itemId)) return { ok: false, error: "no_block" };
  const selfId = presenceIdFor(ownerKey);
  if (active.block.ownerId !== selfId) return { ok: false, error: "not_owner" };
  const overrides: TileOverridesMap = { [key]: active };
  if (action === "set_display") {
    if (active.display) return { ok: false, error: "tile_blocked" };
    const def = itemById(itemIdRaw);
    if (!def) return { ok: false, error: "unknown_block" };
    const removed = removeItem(profile, def.id, 1);
    if (!removed) return { ok: false, error: "not_enough_items" };
    const next: TileOverride = { ...active, display: def.id };
    return {
      ok: true,
      override: next,
      profile: removed,
      view: viewAfter(map, overrides, key, next, x, y, now, ownerKey),
      gained: {},
    };
  }
  if (!active.display) return { ok: false, error: "tile_blocked" };
  const shown = active.display;
  const next: TileOverride = { ...active };
  delete next.display;
  return {
    ok: true,
    override: next,
    profile: addItem(profile, shown, 1),
    view: viewAfter(map, overrides, key, next, x, y, now, ownerKey),
    gained: { [shown]: 1 },
  };
}

/** 植えられる飾りは花（素材）だけ。 */
export const PLANTABLE_DECO_ID = "flower";

/**
 * 植木鉢・プランターへの花の植え付け/取り除き（所有者だけ）。
 * 植える: 花（素材）を1つ消費して deco に記録する。取り除く: 花が手元に戻る。
 * 状態はタイル上書きの deco に持つ（鉢が壊れたら花も失われる）。
 */
export function applyFlowerAction(
  current: TileOverride | null,
  profile: PlayerProfile,
  map: TopDownMap,
  ownerKey: string,
  xRaw: unknown,
  yRaw: unknown,
  action: "plant_flower" | "remove_flower",
  now: number,
): TileActionResult {
  const tile = checkedTile(xRaw, yRaw);
  if (!tile) return { ok: false, error: "invalid_tile" };
  const { x, y } = tile;
  const key = tileKey(x, y);
  const active = isOverrideActive(current, now) ? current : null;
  const block = active?.block;
  if (!active || !block || !isFlowerPotItem(block.itemId)) return { ok: false, error: "no_block" };
  const selfId = presenceIdFor(ownerKey);
  if (block.ownerId !== selfId) return { ok: false, error: "not_owner" };
  const overrides: TileOverridesMap = { [key]: active };
  if (action === "plant_flower") {
    if (active.deco) return { ok: false, error: "tile_blocked" };
    const removed = removeItem(profile, PLANTABLE_DECO_ID, 1);
    if (!removed) return { ok: false, error: "not_enough_items" };
    const next: TileOverride = { ...active, deco: PLANTABLE_DECO_ID };
    return {
      ok: true,
      override: next,
      profile: removed,
      view: viewAfter(map, overrides, key, next, x, y, now, ownerKey),
      gained: {},
    };
  }
  if (!active.deco) return { ok: false, error: "tile_blocked" };
  const next: TileOverride = { ...active };
  delete next.deco;
  return {
    ok: true,
    override: next,
    profile: addItem(profile, PLANTABLE_DECO_ID, 1),
    view: viewAfter(map, overrides, key, next, x, y, now, ownerKey),
    gained: { [PLANTABLE_DECO_ID]: 1 },
  };
}

/**
 * 門の開閉: 門タイルの gateOpen を反転する。開閉は所有者でなくてもできる
 * （門は出入りのための物。掘って壊すのは従来どおり所有者だけ）。
 * アイテムの消費・獲得は無い。
 */
export function applyToggleGate(
  current: TileOverride | null,
  profile: PlayerProfile,
  map: TopDownMap,
  ownerKey: string,
  xRaw: unknown,
  yRaw: unknown,
  now: number,
): TileActionResult {
  const tile = checkedTile(xRaw, yRaw);
  if (!tile) return { ok: false, error: "invalid_tile" };
  const { x, y } = tile;
  const key = tileKey(x, y);
  const active = isOverrideActive(current, now) ? current : null;
  if (!active?.block || !isGateItem(active.block.itemId)) return { ok: false, error: "no_block" };
  const next: TileOverride = { ...active, gateOpen: active.gateOpen !== true };
  const overrides: TileOverridesMap = { [key]: active };
  return {
    ok: true,
    override: next,
    profile,
    view: viewAfter(map, overrides, key, next, x, y, now, ownerKey),
    gained: {},
  };
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

function parsePlacedBlock(raw: unknown): PlacedBlock | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const def = itemById(v.itemId);
  if (!def || (def.category !== "block" && def.facility !== true)) return null;
  if (typeof v.ownerId !== "string" || v.ownerId.length === 0) return null;
  const out: PlacedBlock = { itemId: def.id, ownerId: v.ownerId };
  // hp は正の有限数だけ拾う（壊れた値は落として満タン扱いに戻す）
  if (typeof v.hp === "number" && Number.isFinite(v.hp) && v.hp > 0) {
    out.hp = Math.floor(v.hp);
  }
  return out;
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
  if (v.block !== undefined) {
    const block = parsePlacedBlock(v.block);
    if (block) out.block = block;
  }
  if (v.crop === null) out.crop = null;
  else if (v.crop !== undefined) {
    const crop = parseCropState(v.crop);
    if (crop) out.crop = crop;
  }
  if (v.deco === "flower") out.deco = "flower";
  if (v.gateOpen === true) out.gateOpen = true;
  if (typeof v.signText === "string") {
    const text = sanitizeSignText(v.signText);
    if (text) out.signText = text;
  }
  if (typeof v.display === "string" && itemById(v.display)) out.display = v.display;
  if (typeof v.hp === "number" && Number.isFinite(v.hp) && v.hp > 0) out.hp = Math.floor(v.hp);
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
  | { action: TileActionKind; seedId?: string; itemId?: string }
  | { action: "plant-picker" }
  | null;

/**
 * 選択中の枠（道具 or 種 or ブロック）とタイルの状態から、タップで起きる
 * 行為を決める。優先順: 収穫（育っていれば素手でも）→ ブロック採掘 →
 * 作付け → ブロック設置 → 道具ごとの行為。
 */
export function actionForTile(
  view: TileView,
  selected: { tool?: ToolKind; seedId?: string; blockId?: string } | null,
): TileContextAction {
  if (view.crop?.ready) return { action: "harvest" };
  if (view.block) {
    // ブロック採掘に使えるのは斧とツルハシだけ（道具の棲み分け、
    // 2026-11-17 ユーザー指摘「剣がピッケル枠になるのは良くない」）。
    // 剣・クワを選んでいるときは掘らない。サーバー側のダメージ計算も
    // 斧/ツルハシのティアしか見ないので、ここを揃えないと「剣で掘れる」
    // 見た目だけが残る。
    const miningTool = selected?.tool === "axe" || selected?.tool === "pickaxe";
    // 門はタップで開閉する。ただし所有者が採掘道具を選んでいるときは採掘を優先する（回収できるように）。
    if (isGateItem(view.block.itemId) && !(view.block.mine && miningTool)) return { action: "toggle_gate" };
    // 自分のブロックは採掘道具を持っているときだけ掘る。他人のブロックは触れない。
    if (view.block.mine && miningTool) return { action: "mine_block" };
    return null;
  }
  if (view.farmland && !view.crop) {
    if (selected?.seedId) return { action: "plant", seedId: selected.seedId };
    return { action: "plant-picker" };
  }
  if (view.crop) return null; // 育ちきるまでは何もしない
  if (selected?.blockId && !view.farmland && !view.stump) {
    // 通常の設置は陸地のみ。橋ブロックだけは水の上にも置ける。
    if (PLACEABLE_TERRAIN.has(view.tile) || (selected.blockId === "bridge_block" && view.tile === T_WATER)) {
      return { action: "place_block", itemId: selected.blockId };
    }
  }
  // 木は素手でも伐採できる（選択中の道具を問わない）
  if (view.tile === T_TREE || view.tile === T_SNOW_TREE) return { action: "chop" };
  const tool = selected?.tool;
  if (!tool) return null;
  if (view.tile === T_ROCK && tool === "pickaxe") return { action: "mine" };
  if ((view.tile === T_GRASS || view.tile === T_DIRT) && !view.farmland && tool === "hoe") {
    return { action: "till" };
  }
  return null;
}
