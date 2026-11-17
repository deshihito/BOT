// AGO WORLD BOX のインスタンス空間（洞窟など別枠マップ）の純粋ロジック。
// 空間 ID は "cave:<入口x>,<入口y>:<層>" の文字列で、セーブ/プレゼンスの
// space にそのまま乗る（入口タイルのワールド座標がインスタンスの識別子）。
// 中身はワールドシード + 入口座標 + 層から決定的に生成され、保存しない。
// 枯渇状態（鉱脈・宝箱）だけをサーバーが持つ（instances ルート）。
import { L_DARK, L_MARBLE, L_SAND, L_WALL, isSolidLobbyTile, type LobbyData, type LobbyObject } from "./lobby";
import { T_GRASS, T_ROCK, tilesSource, type TopDownMap } from "./mapgen";
import { makeRng } from "./rng";
import { specialObjectById, type SpecialObjectDef } from "./objects";
import { mobById, type PlacedMob } from "./mobs";

export type InstanceKind = "cave" | "ruins" | "dungeon";

export type InstanceSpaceRef = {
  kind: InstanceKind;
  entranceX: number;
  entranceY: number;
  layer: number;
};

const INSTANCE_SPACE_RE = /^(cave|ruins|dungeon):(-?\d+),(-?\d+):(\d+)$/;

export function makeInstanceSpace(kind: InstanceKind, entranceX: number, entranceY: number, layer: number): string {
  return `${kind}:${Math.floor(entranceX)},${Math.floor(entranceY)}:${Math.max(0, Math.floor(layer))}`;
}

export function parseInstanceSpace(space: unknown): InstanceSpaceRef | null {
  if (typeof space !== "string") return null;
  const m = INSTANCE_SPACE_RE.exec(space);
  if (!m) return null;
  return {
    kind: m[1] as InstanceKind,
    entranceX: Number(m[2]),
    entranceY: Number(m[3]),
    layer: Number(m[4]),
  };
}

export function isInstanceSpace(space: unknown): boolean {
  return parseInstanceSpace(space) !== null;
}

// ---------------------------------------------------------------- 明かり
/** 明かりの半径（タイル）。松明 6 / ランプ 9 が基準、無しは足元のみ。 */
export function lightRadiusTiles(inventory: Readonly<Record<string, number>> | null | undefined): number {
  if (!inventory) return 2.5;
  if ((inventory["lamp"] ?? 0) > 0) return 9;
  if ((inventory["torch"] ?? 0) > 0) return 6;
  return 2.5;
}

/** 設置物が周りを照らす半径（タイル）。0 は光らない。 */
export const PLACED_LIGHT_RADIUS: Readonly<Record<string, number>> = {
  lamp: 9,
  glowstone_block: 7,
  torch: 6,
  lava_block: 6,
  campfire: 5,
  magma_block: 5,
};

export function placedLightRadiusTiles(itemId: unknown): number {
  if (typeof itemId !== "string") return 0;
  return PLACED_LIGHT_RADIUS[itemId] ?? 0;
}

// ---------------------------------------------------------------- 洞窟
export const CAVE_W = 64;
export const CAVE_H = 64;
export const CAVE_LAYERS = 3;

export type CaveVein = {
  /** 枯渇状態のキー（層内で一意）。 */
  key: string;
  objectId: string;
  x: number;
  y: number;
};

export type CaveLayer = {
  data: LobbyData;
  /** 帰還ポータル（入口）タイル。出現位置でもある。 */
  portal: { x: number; y: number };
  stairsUp: { x: number; y: number } | null;
  stairsDown: { x: number; y: number } | null;
  /** 温泉タイル（踏むと休憩）。1層目のみ。 */
  onsen: readonly { x: number; y: number }[];
  veins: readonly CaveVein[];
  chest: { x: number; y: number } | null;
  mobs: readonly PlacedMob[];
};

/** 層ごとの鉱脈プール（浅い=石炭/銅、深い=希少、水晶、最深=ミスリル）。 */
const CAVE_VEIN_POOLS: readonly (readonly { objectId: string; count: number }[])[] = [
  [
    { objectId: "coal_vein", count: 6 },
    { objectId: "copper_vein", count: 6 },
  ],
  [
    { objectId: "coal_vein", count: 3 },
    { objectId: "copper_vein", count: 3 },
    { objectId: "rare_vein", count: 3 },
    { objectId: "crystal_cluster", count: 2 },
  ],
  [
    { objectId: "rare_vein", count: 3 },
    { objectId: "crystal_cluster", count: 3 },
    { objectId: "mithril_vein", count: 2 },
  ],
];

/** 層ごとのモブ（洞窟コウモリとゴーレム）。 */
const CAVE_MOB_POOLS: readonly (readonly string[])[] = [
  ["cave_bat", "cave_bat", "cave_bat", "cave_bat"],
  ["cave_bat", "cave_bat", "cave_bat", "golem"],
  ["cave_bat", "cave_bat", "golem", "golem"],
];

/** 宝箱の再出現（共有マップなので有限にし、6時間で戻る）。 */
export const CAVE_CHEST_RESPAWN_MS = 6 * 60 * 60 * 1000;

function hashSeed(seed: number, ex: number, ey: number, layer: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (const v of [ex, ey, layer]) {
    h ^= (v * 2654435761) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 16777619) >>> 0;
  }
  return h >>> 0;
}

const caveCache = new Map<string, CaveLayer>();

/** 洞窟の1層を決定的に生成する（結果はキャッシュ）。 */
export function buildCaveLayer(seed: number, entranceX: number, entranceY: number, layer: number): CaveLayer {
  const cacheKey = `${seed}:${entranceX},${entranceY}:${layer}`;
  const cached = caveCache.get(cacheKey);
  if (cached) return cached;

  const rng = makeRng(hashSeed(seed, entranceX, entranceY, layer));
  const tiles = new Uint8Array(CAVE_W * CAVE_H).fill(L_WALL);
  const floor = new Set<string>();
  const carve = (x: number, y: number) => {
    if (x < 1 || y < 1 || x >= CAVE_W - 1 || y >= CAVE_H - 1) return;
    tiles[y * CAVE_W + x] = L_DARK;
    floor.add(`${x},${y}`);
  };

  // 入口（ポータル）は南寄り中央。ランダムウォークで通路を掘り、部屋を繋ぐ。
  const portal = { x: 32, y: CAVE_H - 6 };
  for (let dy = 0; dy < 3; dy++) for (let dx = -1; dx <= 1; dx++) carve(portal.x + dx, portal.y + dy - 1);
  const walkers: { x: number; y: number }[] = [{ ...portal }];
  const roomCenters: { x: number; y: number }[] = [{ ...portal }];
  for (let w = 0; w < 5; w++) {
    let { x, y } = walkers[0];
    const steps = 260 + Math.floor(rng() * 160);
    for (let s = 0; s < steps; s++) {
      carve(x, y);
      carve(x + (rng() < 0.3 ? 1 : 0), y);
      const dir = Math.floor(rng() * 4);
      if (dir === 0) x += 1;
      else if (dir === 1) x -= 1;
      else if (dir === 2) y += 1;
      else y -= 1;
      x = Math.max(2, Math.min(CAVE_W - 3, x));
      y = Math.max(2, Math.min(CAVE_H - 3, y));
      if (s % 90 === 89) {
        // 部屋を掘って中心を記録（階段・宝箱・温泉の置き場候補）
        const rw = 3 + Math.floor(rng() * 3);
        const rh = 3 + Math.floor(rng() * 3);
        for (let dy = 0; dy < rh; dy++) for (let dx = 0; dx < rw; dx++) carve(x + dx - 1, y + dy - 1);
        roomCenters.push({ x, y });
      }
    }
    walkers[0] = { x, y };
  }
  const floorList = [...floor].map((k) => {
    const [x, y] = k.split(",").map(Number);
    return { x, y };
  });
  const farFrom = (p: { x: number; y: number }, min: number) =>
    floorList.filter((t) => Math.hypot(t.x - p.x, t.y - p.y) >= min);
  const pickFar = (from: { x: number; y: number }, min: number, used: Set<string>) => {
    const cand = farFrom(from, min).filter((t) => !used.has(`${t.x},${t.y}`));
    if (cand.length === 0) return null;
    const t = cand[Math.floor(rng() * cand.length)];
    used.add(`${t.x},${t.y}`);
    return t;
  };
  const used = new Set<string>([`${portal.x},${portal.y}`]);

  // 階段: 下りは入口から遠く、上りは入口の隣。
  const stairsDown = layer < CAVE_LAYERS - 1 ? pickFar(portal, 24, used) : null;
  const stairsUp = layer > 0 ? { x: portal.x + 2, y: portal.y } : null;
  if (stairsUp) used.add(`${stairsUp.x},${stairsUp.y}`);

  // 温泉（1層目のみ、入口近くの小部屋タイルを砂地にして目印にする）
  const onsen: { x: number; y: number }[] = [];
  if (layer === 0) {
    const base = { x: portal.x - 3, y: portal.y - 1 };
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const t = { x: base.x + dx, y: base.y + dy };
        if (floor.has(`${t.x},${t.y}`)) {
          tiles[t.y * CAVE_W + t.x] = L_SAND;
          onsen.push(t);
          used.add(`${t.x},${t.y}`);
        }
      }
    }
  }

  // 宝箱は最深の部屋へ。
  const chest = pickFar(portal, 18, used);

  // 鉱脈: 床に隣接する壁タイルへ貼る。
  const veins: CaveVein[] = [];
  const wallUsed = new Set<string>();
  const pool = CAVE_VEIN_POOLS[layer] ?? CAVE_VEIN_POOLS[0];
  for (const entry of pool) {
    for (let i = 0; i < entry.count; i++) {
      for (let tries = 0; tries < 40; tries++) {
        const f = floorList[Math.floor(rng() * floorList.length)];
        const dirs = [
          { x: f.x + 1, y: f.y },
          { x: f.x - 1, y: f.y },
          { x: f.x, y: f.y + 1 },
          { x: f.x, y: f.y - 1 },
        ];
        const w = dirs[Math.floor(rng() * dirs.length)];
        const key = `${w.x},${w.y}`;
        if (w.x < 1 || w.y < 1 || w.x >= CAVE_W - 1 || w.y >= CAVE_H - 1) continue;
        if (tiles[w.y * CAVE_W + w.x] !== L_WALL || wallUsed.has(key)) continue;
        wallUsed.add(key);
        veins.push({ key: `${entry.objectId}:${veins.length}`, objectId: entry.objectId, x: w.x, y: w.y });
        break;
      }
    }
  }

  // モブ: 入口の安全圏（半径6）より外の床へ。
  const mobs: PlacedMob[] = [];
  for (const mobId of CAVE_MOB_POOLS[layer] ?? []) {
    const t = pickFar(portal, 8, used);
    if (t) mobs.push({ mobId, x: t.x, y: t.y, biome: "highland", size: mobId === "golem" ? 3 : 1 });
  }

  // LobbyData として組み立てる（ロビー描画・移動をそのまま使う）。
  const objects: LobbyObject[] = [
    { sprite: "warp_pad", x: portal.x, y: portal.y, w: 1, h: 1, solid: false },
  ];
  if (stairsDown) objects.push({ sprite: "stairs", x: stairsDown.x, y: stairsDown.y, w: 1, h: 1, solid: false });
  if (stairsUp) objects.push({ sprite: "stairs", x: stairsUp.x, y: stairsUp.y, w: 1, h: 1, solid: false });
  for (const v of veins) objects.push({ sprite: v.objectId, x: v.x, y: v.y, w: 1, h: 1, solid: true });
  if (chest) objects.push({ sprite: "cave_chest", x: chest.x, y: chest.y, w: 1, h: 1, solid: true });
  const blocked = new Set<string>();
  for (const o of objects) if (o.solid) blocked.add(`${o.x},${o.y}`);
  const moveTiles = new Uint8Array(CAVE_W * CAVE_H);
  for (let i = 0; i < tiles.length; i++) moveTiles[i] = isSolidLobbyTile(tiles[i]) ? T_ROCK : T_GRASS;
  const moveMap: TopDownMap = tilesSource(0, CAVE_W, CAVE_H, moveTiles);
  const result: CaveLayer = {
    data: { width: CAVE_W, height: CAVE_H, tiles, objects, npcs: [], blocked, moveMap },
    portal,
    stairsUp,
    stairsDown,
    onsen,
    veins,
    chest,
    mobs,
  };
  caveCache.set(cacheKey, result);
  return result;
}

/** 入口・階段まわりの安全圏か（モブ配置と接触判定の除外に使う）。 */
export function isCaveSafeTile(cave: CaveLayer, x: number, y: number): boolean {
  const near = (p: { x: number; y: number } | null) => p !== null && Math.hypot(x - p.x, y - p.y) <= 1.5;
  return near(cave.portal) || near(cave.stairsUp) || near(cave.stairsDown);
}

// ---------------------------------------------------------------- 遺跡
export const RUINS_W = 48;
export const RUINS_H = 48;

/** 罠の種類（ダメージ/毒/警報/転移）。 */
export type RuinsTrapKind = "damage" | "poison" | "alarm" | "teleport";
export const RUINS_TRAP_KINDS: readonly RuinsTrapKind[] = ["damage", "poison", "alarm", "teleport"];

export type RuinsChest = {
  idx: number;
  x: number;
  y: number;
  /** 主宝箱（最奥）。 */
  main: boolean;
  /** 金の鍵の扉の先にある（扉を開けた者だけ開けられる）。 */
  requiresKey: boolean;
};

export type RuinsDoor = { idx: number; x: number; y: number };
export type RuinsTrap = { idx: number; x: number; y: number; kind: RuinsTrapKind };

export type RuinsMap = {
  data: LobbyData;
  portal: { x: number; y: number };
  chests: readonly RuinsChest[];
  doors: readonly RuinsDoor[];
  traps: readonly RuinsTrap[];
  /** 部屋の中心（転移罠の行き先候補）。 */
  roomCenters: readonly { x: number; y: number }[];
};

/** 主宝箱のルート（遺物・星の地図の確率を上げた ruins_chest 派生）。 */
export const RUINS_MAIN_CHEST_LOOT = [
  { itemId: "ancient_coin", min: 2, max: 3, chance: 1 },
  { itemId: "gold_ingot", min: 1, max: 2, chance: 0.6 },
  { itemId: "ancient_relic", min: 1, max: 1, chance: 0.5 },
  { itemId: "star_map", min: 1, max: 1, chance: 0.4 },
] as const;

/** ruins_complete の earn 額（暫定。Plan A の原資範囲内）。 */
export const RUINS_COMPLETE_EARN = 300;

/**
 * ruins_complete の earn オプの決定的 ID（入口座標＋プレイヤー）。
 * 主宝箱の初回開封はその遺跡につき1人1回だけ（completed フラグは
 * 週次リセットを跨いで残る）なので、オプ ID も1回きりの形にして
 * 冪等登録（enqueueEconomyOpOnce）と組み合わせる。再試行や並行
 * リクエストでも earn は最大1件しか積まれない（PR #943 の規則）。
 * 形式はブリッジの OP_ID_RE（[A-Za-z0-9-]{8,64}）に収める。
 */
export function ruinsCompleteOpId(entranceX: number, entranceY: number, discordId: string): string {
  return `ruins-done-${entranceX}-${entranceY}-${discordId}`;
}

/** 週キー（月曜始まり、サーバー時刻=UTC 基準）。個人状態の週次リセット判定。 */
export function weekKeyOf(now: number): string {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7; // 月曜=0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

const ruinsCache = new Map<string, RuinsMap>();

/** 遺跡を決定的に生成する（部屋＋通路型、48×48、結果はキャッシュ）。 */
export function buildRuins(seed: number, entranceX: number, entranceY: number): RuinsMap {
  const cacheKey = `ruins:${seed}:${entranceX},${entranceY}`;
  const cached = ruinsCache.get(cacheKey);
  if (cached) return cached;

  const rng = makeRng(hashSeed(seed, entranceX, entranceY, 777));
  const tiles = new Uint8Array(RUINS_W * RUINS_H).fill(L_WALL);
  const floor = new Set<string>();
  const carve = (x: number, y: number) => {
    if (x < 1 || y < 1 || x >= RUINS_W - 1 || y >= RUINS_H - 1) return;
    tiles[y * RUINS_W + x] = L_MARBLE;
    floor.add(`${x},${y}`);
  };

  // 部屋をグリッド状に置き、隣接部屋を通路で繋ぐ。
  const COLS = 3;
  const ROWS = 3;
  const rooms: { x: number; y: number; w: number; h: number; cx: number; cy: number }[] = [];
  for (let ry = 0; ry < ROWS; ry++) {
    for (let rx = 0; rx < COLS; rx++) {
      const w = 7 + Math.floor(rng() * 3);
      const h = 6 + Math.floor(rng() * 3);
      const x = 2 + rx * 15 + Math.floor(rng() * 3);
      const y = 2 + ry * 15 + Math.floor(rng() * 3);
      for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) carve(x + dx, y + dy);
      rooms.push({ x, y, w, h, cx: x + Math.floor(w / 2), cy: y + Math.floor(h / 2) });
    }
  }
  const corridor = (x0: number, y0: number, x1: number, y1: number) => {
    let x = x0;
    let y = y0;
    while (x !== x1) { carve(x, y); carve(x, y + 1); x += Math.sign(x1 - x); }
    while (y !== y1) { carve(x, y); carve(x + 1, y); y += Math.sign(y1 - y); }
    carve(x, y);
  };
  for (let ry = 0; ry < ROWS; ry++) {
    for (let rx = 0; rx < COLS; rx++) {
      const room = rooms[ry * COLS + rx];
      if (rx + 1 < COLS) corridor(room.cx, room.cy, rooms[ry * COLS + rx + 1].cx, rooms[ry * COLS + rx + 1].cy);
      if (ry + 1 < ROWS) corridor(room.cx, room.cy, rooms[(ry + 1) * COLS + rx].cx, rooms[(ry + 1) * COLS + rx].cy);
    }
  }

  // 入口は最南の部屋。最奥は入口から BFS 最遠の部屋。
  const entranceRoom = rooms[(ROWS - 1) * COLS + 1];
  const portal = { x: entranceRoom.cx, y: entranceRoom.cy + 2 };
  carve(portal.x, portal.y);
  const dist = new Map<string, number>([[`${portal.x},${portal.y}`, 0]]);
  const queue = [{ ...portal }];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = dist.get(`${cur.x},${cur.y}`)!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const key = `${nx},${ny}`;
      if (dist.has(key) || !floor.has(key)) continue;
      dist.set(key, d + 1);
      queue.push({ x: nx, y: ny });
    }
  }
  const roomDist = rooms.map((r) => dist.get(`${r.cx},${r.cy}`) ?? 0);
  const deepestIdx = roomDist.indexOf(Math.max(...roomDist));
  const deepest = rooms[deepestIdx];

  // 金の鍵の扉: 最奥の部屋への通路の入口タイル（最奥部屋の境界に接する通路タイル）。
  const doors: RuinsDoor[] = [];
  {
    const candidates: { x: number; y: number }[] = [];
    for (const key of floor) {
      const [x, y] = key.split(",").map(Number);
      const inDeep = x >= deepest.x && x < deepest.x + deepest.w && y >= deepest.y && y < deepest.y + deepest.h;
      if (inDeep) continue;
      const touchesDeep = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        return nx >= deepest.x && nx < deepest.x + deepest.w && ny >= deepest.y && ny < deepest.y + deepest.h && floor.has(`${nx},${ny}`);
      });
      if (touchesDeep) candidates.push({ x, y });
    }
    candidates.sort((a, b) => (dist.get(`${b.x},${b.y}`) ?? 0) - (dist.get(`${a.x},${a.y}`) ?? 0));
    if (candidates.length > 0) doors.push({ idx: 0, x: candidates[0].x, y: candidates[0].y });
  }
  const doorSet = new Set(doors.map((d) => `${d.x},${d.y}`));

  // 宝箱: 主宝箱は最奥（扉の先）、小宝箱は各部屋に最大1つ。
  const chests: RuinsChest[] = [];
  chests.push({ idx: 0, x: deepest.cx, y: deepest.cy, main: true, requiresKey: doors.length > 0 });
  let chestIdx = 1;
  for (const [i, room] of rooms.entries()) {
    if (i === deepestIdx || room === entranceRoom) continue;
    if (rng() < 0.25) continue;
    chests.push({
      idx: chestIdx++,
      x: room.x + 1 + Math.floor(rng() * Math.max(1, room.w - 2)),
      y: room.y + 1 + Math.floor(rng() * Math.max(1, room.h - 2)),
      main: false,
      requiresKey: false,
    });
  }

  // 床罠: 通路と部屋の床から、入口まわりを避けて決定的に選ぶ。
  const traps: RuinsTrap[] = [];
  const floorList = [...floor]
    .map((k) => { const [x, y] = k.split(",").map(Number); return { x, y }; })
    .filter((t) => Math.hypot(t.x - portal.x, t.y - portal.y) > 4 && !doorSet.has(`${t.x},${t.y}`))
    .filter((t) => !chests.some((c) => c.x === t.x && c.y === t.y));
  for (let i = 0; i < 10 && floorList.length > 0; i++) {
    const pick = floorList.splice(Math.floor(rng() * floorList.length), 1)[0];
    traps.push({ idx: i, x: pick.x, y: pick.y, kind: RUINS_TRAP_KINDS[i % RUINS_TRAP_KINDS.length] });
  }

  const objects: LobbyObject[] = [
    { sprite: "warp_pad", x: portal.x, y: portal.y, w: 1, h: 1, solid: false },
    ...doors.map((d) => ({ sprite: "gold_door", x: d.x, y: d.y, w: 1, h: 1, solid: true })),
    ...chests.map((c) => ({ sprite: "ruins_chest", x: c.x, y: c.y, w: 1, h: 1, solid: true })),
  ];
  const blocked = new Set<string>();
  for (const o of objects) if (o.solid) blocked.add(`${o.x},${o.y}`);
  const moveTiles = new Uint8Array(RUINS_W * RUINS_H);
  for (let i = 0; i < tiles.length; i++) moveTiles[i] = isSolidLobbyTile(tiles[i]) ? T_ROCK : T_GRASS;
  const moveMap: TopDownMap = tilesSource(0, RUINS_W, RUINS_H, moveTiles);
  const result: RuinsMap = {
    data: { width: RUINS_W, height: RUINS_H, tiles, objects, npcs: [], blocked, moveMap },
    portal,
    chests,
    doors,
    traps,
    roomCenters: rooms.map((r) => ({ x: r.cx, y: r.cy })),
  };
  ruinsCache.set(cacheKey, result);
  return result;
}

/* ================= ダンジョン（バッチ5） =================
 * パーティ別インスタンス。マップ自体は入口ごとに決定的生成（52×52、部屋＋通路）。
 * パーティ分離は状態キー（"#<partyKey>"）とプレゼンスの party フィールドで担保し、
 * 空間 ID は cave/ruins と同じ `dungeon:<入口x>,<入口y>:<フロア>` 形式を使う。
 * フロア 1〜3 + フロア 4 がボス部屋。各フロア: 鍵扉の先にフロアボス、
 * フロアボスを倒すと階段が開く。鍵は番人（ghost）が落とす。
 */

export const DUNGEON_W = 52;
export const DUNGEON_H = 52;
export const DUNGEON_FLOORS = 4;
/** dungeon_clear の earn 額（暫定。Plan A の原資範囲内、週1回）。 */
export const DUNGEON_CLEAR_EARN = 500;
/** パーティ人数ごとのモブ HP 倍率（攻撃は不変）。 */
export const DUNGEON_HP_SCALES = [1, 1.6, 2.2, 2.8] as const;

export function dungeonHpScale(partySize: number): number {
  const idx = Math.max(1, Math.min(4, Math.floor(partySize) || 1)) - 1;
  return DUNGEON_HP_SCALES[idx];
}

/** 入口ごとに決定的に選ばれるボス（3種）。 */
export const DUNGEON_BOSSES = ["ogre", "spider_queen", "dungeon_dragon"] as const;
export function dungeonBossForEntrance(seed: number, entranceX: number, entranceY: number): string {
  const h = hashSeed(seed, entranceX, entranceY, 4242) >>> 0;
  return DUNGEON_BOSSES[h % DUNGEON_BOSSES.length];
}

/** フロアボス（中ボス）は入口ハッシュとフロアで回す。 */
export function dungeonFloorBossFor(seed: number, entranceX: number, entranceY: number, floor: number): string {
  if (floor >= DUNGEON_FLOORS) return dungeonBossForEntrance(seed, entranceX, entranceY);
  const h = (hashSeed(seed, entranceX, entranceY, 5150) >>> 0) + floor;
  return h % 2 === 0 ? "ogre" : "spider_queen";
}

export type DungeonChest = { idx: number; x: number; y: number; bossChest: boolean };
export type DungeonDoor = { idx: number; x: number; y: number };
export type DungeonFloorData = {
  data: LobbyData;
  portal: { x: number; y: number };
  stairsDown: { x: number; y: number } | null;
  boss: { mobId: string; x: number; y: number };
  keyHolder: { mobId: string; x: number; y: number };
  chests: DungeonChest[];
  doors: DungeonDoor[];
  mobs: PlacedMob[];
  floor: number;
};

const dungeonCache = new Map<string, DungeonFloorData>();

export function buildDungeonFloor(seed: number, entranceX: number, entranceY: number, layer: number): DungeonFloorData {
  // layer は空間 ID の層（0 始まり。洞窟と同じ）。フロア番号は layer+1。
  const f = Math.max(1, Math.min(DUNGEON_FLOORS, (Math.floor(layer) || 0) + 1));
  const cacheKey = `dungeon:${seed}:${entranceX},${entranceY}:${f}`;
  const cached = dungeonCache.get(cacheKey);
  if (cached) return cached;

  const rng = makeRng(hashSeed(seed, entranceX, entranceY, 9000 + f * 131));
  const tiles = new Uint8Array(DUNGEON_W * DUNGEON_H).fill(L_WALL);
  const floorSet = new Set<string>();
  const carve = (x: number, y: number) => {
    if (x < 1 || y < 1 || x >= DUNGEON_W - 1 || y >= DUNGEON_H - 1) return;
    tiles[y * DUNGEON_W + x] = L_DARK;
    floorSet.add(`${x},${y}`);
  };
  const COLS = 3;
  const ROWS = 3;
  const rooms: { x: number; y: number; w: number; h: number; cx: number; cy: number }[] = [];
  for (let ry = 0; ry < ROWS; ry++) {
    for (let rx = 0; rx < COLS; rx++) {
      const w = 7 + Math.floor(rng() * 3);
      const h = 6 + Math.floor(rng() * 3);
      const x = 2 + rx * 16 + Math.floor(rng() * 3);
      const y = 2 + ry * 16 + Math.floor(rng() * 3);
      for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) carve(x + dx, y + dy);
      rooms.push({ x, y, w, h, cx: x + Math.floor(w / 2), cy: y + Math.floor(h / 2) });
    }
  }
  const corridor = (x0: number, y0: number, x1: number, y1: number) => {
    let x = x0;
    let y = y0;
    while (x !== x1) { carve(x, y); carve(x, y + 1); x += Math.sign(x1 - x); }
    while (y !== y1) { carve(x, y); carve(x + 1, y); y += Math.sign(y1 - y); }
    carve(x, y);
  };
  for (let ry = 0; ry < ROWS; ry++) {
    for (let rx = 0; rx < COLS; rx++) {
      const room = rooms[ry * COLS + rx];
      if (rx + 1 < COLS) corridor(room.cx, room.cy, rooms[ry * COLS + rx + 1].cx, rooms[ry * COLS + rx + 1].cy);
      if (ry + 1 < ROWS) corridor(room.cx, room.cy, rooms[(ry + 1) * COLS + rx].cx, rooms[(ry + 1) * COLS + rx].cy);
    }
  }
  const entranceRoom = rooms[(ROWS - 1) * COLS + 1];
  const portal = { x: entranceRoom.cx, y: entranceRoom.cy + 2 };
  carve(portal.x, portal.y);
  const dist = new Map<string, number>([[`${portal.x},${portal.y}`, 0]]);
  const queue = [{ ...portal }];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = dist.get(`${cur.x},${cur.y}`)!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const key = `${nx},${ny}`;
      if (dist.has(key) || !floorSet.has(key)) continue;
      dist.set(key, d + 1);
      queue.push({ x: nx, y: ny });
    }
  }
  const roomDist = rooms.map((r) => dist.get(`${r.cx},${r.cy}`) ?? 0);
  const bossRoomIdx = roomDist.indexOf(Math.max(...roomDist));
  const bossRoom = rooms[bossRoomIdx];

  // 鍵扉: ボス部屋の境界に接する通路タイル（遺跡と同じ方式）。
  const doors: DungeonDoor[] = [];
  {
    const candidates: { x: number; y: number }[] = [];
    for (const key of floorSet) {
      const [x, y] = key.split(",").map(Number);
      const inBoss = x >= bossRoom.x && x < bossRoom.x + bossRoom.w && y >= bossRoom.y && y < bossRoom.y + bossRoom.h;
      if (inBoss) continue;
      const touches = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        return nx >= bossRoom.x && nx < bossRoom.x + bossRoom.w && ny >= bossRoom.y && ny < bossRoom.y + bossRoom.h && floorSet.has(`${nx},${ny}`);
      });
      if (touches) candidates.push({ x, y });
    }
    candidates.sort((a, b) => (dist.get(`${b.x},${b.y}`) ?? 0) - (dist.get(`${a.x},${a.y}`) ?? 0));
    if (candidates.length > 0) doors.push({ idx: 0, x: candidates[0].x, y: candidates[0].y });
  }
  const doorSet = new Set(doors.map((d) => `${d.x},${d.y}`));

  const boss = {
    mobId: dungeonFloorBossFor(seed, entranceX, entranceY, f),
    x: bossRoom.cx,
    y: bossRoom.cy,
  };
  // 番人（鍵持ち）は入口とボス部屋の中間の部屋に置く。
  const sortedByDist = rooms.map((r, i) => ({ r, i, d: roomDist[i] })).sort((a, b) => a.d - b.d);
  const midRoom = sortedByDist[Math.floor(sortedByDist.length / 2)].r;
  const keyHolder = { mobId: "ghost", x: midRoom.cx, y: midRoom.cy };

  // 雑魚モブ: 部屋ごとに決定的に配置（入口部屋とボス部屋のボス以外は薄く）。
  const mobs: PlacedMob[] = [];
  const mobPool = f === 1 ? ["skeleton", "slime", "spider"] : f === 2 ? ["skeleton", "spider", "ghost"] : ["ghost", "skeleton", "spider"];
  for (const [i, room] of rooms.entries()) {
    if (room === entranceRoom) continue;
    const n = 1 + Math.floor(rng() * 2);
    for (let k = 0; k < n; k++) {
      const mobId = mobPool[Math.floor(rng() * mobPool.length)];
      const def = mobById(mobId);
      mobs.push({
        mobId,
        x: room.x + 1 + Math.floor(rng() * Math.max(1, room.w - 2)),
        y: room.y + 1 + Math.floor(rng() * Math.max(1, room.h - 2)),
        biome: "highland",
        size: def?.size ?? 1,
      });
    }
    void i;
  }
  mobs.push({ mobId: keyHolder.mobId, x: keyHolder.x, y: keyHolder.y, biome: "highland", size: mobById(keyHolder.mobId)?.size ?? 2 });
  mobs.push({ mobId: boss.mobId, x: boss.x, y: boss.y, biome: "highland", size: mobById(boss.mobId)?.size ?? 4 });

  const chests: DungeonChest[] = [];
  if (f >= DUNGEON_FLOORS) {
    chests.push({ idx: 0, x: bossRoom.cx + 2, y: bossRoom.cy, bossChest: true });
  } else {
    let idx = 0;
    for (const room of rooms) {
      if (room === entranceRoom || room === bossRoom) continue;
      if (rng() < 0.35) continue;
      chests.push({
        idx: idx++,
        x: room.x + 1 + Math.floor(rng() * Math.max(1, room.w - 2)),
        y: room.y + 1 + Math.floor(rng() * Math.max(1, room.h - 2)),
        bossChest: false,
      });
    }
  }
  const stairsDown = f < DUNGEON_FLOORS ? { x: bossRoom.cx - 2, y: bossRoom.cy } : null;

  const objects: LobbyObject[] = [
    { sprite: "warp_pad", x: portal.x, y: portal.y, w: 1, h: 1, solid: false },
    ...(stairsDown ? [{ sprite: "stairs", x: stairsDown.x, y: stairsDown.y, w: 1, h: 1, solid: false } as LobbyObject] : []),
    ...doors.map((d) => ({ sprite: "gold_door", x: d.x, y: d.y, w: 1, h: 1, solid: true })),
    ...chests.map((c) => ({ sprite: "dungeon_chest", x: c.x, y: c.y, w: 1, h: 1, solid: true })),
  ];
  const blocked = new Set<string>();
  for (const o of objects) if (o.solid) blocked.add(`${o.x},${o.y}`);
  const moveTiles = new Uint8Array(DUNGEON_W * DUNGEON_H);
  for (let i = 0; i < tiles.length; i++) moveTiles[i] = isSolidLobbyTile(tiles[i]) ? T_ROCK : T_GRASS;
  const moveMap: TopDownMap = tilesSource(0, DUNGEON_W, DUNGEON_H, moveTiles);
  const result: DungeonFloorData = {
    data: { width: DUNGEON_W, height: DUNGEON_H, tiles, objects, npcs: [], blocked, moveMap },
    portal,
    stairsDown,
    boss,
    keyHolder,
    chests,
    doors,
    mobs,
    floor: f,
  };
  dungeonCache.set(cacheKey, result);
  return result;
}
