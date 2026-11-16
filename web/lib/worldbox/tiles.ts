// AGO WORLD BOX のタイル上書き（純粋ロジック、DOM 非依存）。
// 地形そのものは固定シードから決定的に生成されるため保存しない。ここで
// 扱うのはプレイヤーの行為で変わった差分だけ: 伐採・採掘・耕作・作付け。
// 農業は「畑を設置」するのではなく、地面を耕して好きな作物を植える。
// 保存は tiles-online.ts（bot_kv、タイルごとのキー）が担う。
import { ITEMS, cropById, cropBySeedId, itemById, type ItemDef, type ToolKind } from "./items";
import {
  T_DIRT, T_GRASS, T_ROCK, T_SAND, T_SNOW, T_SNOW_TREE, T_TREE, WORLD_COORD_LIMIT,
  mapTileAt, type TopDownMap,
} from "./mapgen";
import { addItem, countItem, removeItem, type PlayerProfile } from "./profile";
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
 * 区別はアイテム定義のデータで持つ。
 */
export function placedBlockSolid(itemId: string): boolean {
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
  /** 植木鉢・プランターに植えた飾りのアイテム ID（現在は "flower" のみ）。 */
  deco?: string;
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
  /** 設置されたブロック（自分のものかどうか・残り HP 割合つき）。 */
  block: { itemId: string; mine: boolean; hpFrac: number } | null;
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
  const selfId = selfKey !== null ? presenceIdFor(selfKey) : null;
  return {
    x,
    y,
    tile: effectiveTile(map, overrides, x, y, now),
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
  | "place_block" | "mine_block" | "plant_flower" | "remove_flower";

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
      // 伐採は素手でもできる。道具は必須ではなく効率に効く（斧所持で2倍）
      const count = hasTool(profile, "axe") ? CHOP_WOOD_COUNT : CHOP_WOOD_BAREHAND;
      const next: TileOverride = {
        tile: eff === T_SNOW_TREE ? T_SNOW : T_GRASS,
        stump: true,
        ownerId: selfId,
        until: now + TREE_REGROW_MS,
      };
      return done(next, addItem(profile, "wood", count), { wood: count });
    }
    case "mine": {
      if (eff !== T_ROCK) return { ok: false, error: "tile_blocked" };
      if (!hasTool(profile, "pickaxe")) return { ok: false, error: "tool_required" };
      // 掘った岩は一定時間で戻る（資源の再成長。until を過ぎれば地形どおり岩になる）
      const next: TileOverride = { tile: T_DIRT, ownerId: selfId, until: now + ROCK_REGROW_MS };
      return done(next, addItem(profile, "stone", MINE_STONE_COUNT), { stone: MINE_STONE_COUNT });
    }
    case "till": {
      if (eff !== T_GRASS && eff !== T_DIRT) return { ok: false, error: "tile_blocked" };
      if (active?.farmland) return { ok: false, error: "tile_blocked" };
      if (active?.crop) return { ok: false, error: "tile_blocked" };
      if (active?.block) return { ok: false, error: "tile_blocked" };
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

/** その種類の道具の所持最高ティア（持っていなければ 0）。 */
export function bestToolTier(profile: PlayerProfile, kind: ToolKind): number {
  let best = 0;
  for (const i of ITEMS) {
    if (i.tool === kind && (i.tier ?? 0) > best && countItem(profile, i.id) > 0) {
      best = i.tier ?? 0;
    }
  }
  return best;
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
  if (!PLACEABLE_TERRAIN.has(eff)) return { ok: false, error: "tile_blocked" };
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
 * HP制: 1回 = 1ヒットで、ダメージは道具のティアで変わる。HP が残れば
 * ブロックは残り（アイテムは得られない）、0 以下で壊れてアイテムに戻る。
 * 戦争破壊も同じ HP 経路を通る（1ヒット即消しにはしない）。
 */
export type MineBlockContext = {
  /** 戦争中の他者ブロック破壊がこの1回で許可されているか。 */
  warBreakAllowed?: boolean;
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
  if (block.ownerId !== selfId && !ctx.warBreakAllowed) return { ok: false, error: "not_owner" };
  const def = itemById(block.itemId);
  if (!def) return { ok: false, error: "no_block" };
  const tool = blockMineTool(def);
  if (tool && !hasTool(profile, tool)) return { ok: false, error: "tool_required" };
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
      profile,
      view: viewAfter(map, overrides, key, next, x, y, now, ownerKey),
      gained: {},
    };
  }
  const rest: TileOverride = { ...active, ownerId: selfId };
  delete rest.block;
  delete rest.deco; // 植えた花は鉢ごと失われる
  const empty =
    rest.tile === undefined && rest.farmland !== true && rest.crop === undefined &&
    rest.stump !== true && rest.until === undefined;
  const next = empty ? null : rest;
  const overrides: TileOverridesMap = { [key]: active };
  return {
    ok: true,
    override: next,
    profile: addItem(profile, def.id, 1),
    view: viewAfter(map, overrides, key, next, x, y, now, ownerKey),
    gained: { [def.id]: 1 },
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
    // 自分のブロックは道具を持っているときだけ掘る。他人のブロックは触れない。
    if (view.block.mine && selected?.tool) return { action: "mine_block" };
    return null;
  }
  if (view.farmland && !view.crop) {
    if (selected?.seedId) return { action: "plant", seedId: selected.seedId };
    return { action: "plant-picker" };
  }
  if (view.crop) return null; // 育ちきるまでは何もしない
  if (selected?.blockId && PLACEABLE_TERRAIN.has(view.tile) && !view.farmland && !view.stump) {
    return { action: "place_block", itemId: selected.blockId };
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
