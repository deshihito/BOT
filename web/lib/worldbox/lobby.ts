// AGO WORLD BOX のロビー（純粋ロジック、DOM 非依存）。
// ロビーはワールドとは別の空間で、形は長方形ではなく図形の組み合わせ:
// 中央=大円（交流広場）、左=矩形の翼（ショップ）、右=矩形の翼（カジノ）、
// 上=半円のアプス（闘技場）、下=小円+矩形（鍛冶屋）。床グリッドはこれらの
// 図形の和集合で、和集合の境界セルが壁になる。ショップ翼の2階（ギルド
// ショップ）は同じグリッド内の別領域（サブエリア）として持ち、階段タイルで
// 往復する。全てマス目管理: 配置・占有・判定はタイル単位。
import { T_GRASS, T_ROCK, type TopDownMap } from "./mapgen";

export const LOBBY_W = 56;
export const LOBBY_H = 64;

/** ロビーの床タイル種。将来の床追加はここに足す（描画側は sprite / 色で対応）。 */
export const L_VOID = 0;
export const L_WALL = 1;
export const L_MARBLE = 2;
export const L_PLAZA = 3;
export const L_RING = 4;
export const L_CARPET = 5;
export const L_WOOD = 6;
export const L_SAND = 7;
export const L_DARK = 8;
export const L_CHECK = 9;

/** 床タイル → ロビースプライト名（null はワールド側テクスチャ等で描く）。 */
export const LOBBY_FLOOR_SPRITE: Record<number, string | null> = {
  [L_WALL]: "wall_stone",
  [L_MARBLE]: "floor_marble",
  [L_PLAZA]: "floor_marble",
  [L_RING]: "carpet_red",
  [L_CARPET]: "carpet_plain",
  [L_WOOD]: "floor_wood",
  [L_SAND]: null,
  [L_DARK]: "floor_marble_dark",
  [L_CHECK]: "floor_check",
};

/** スプライト未読込時の平色フォールバック。 */
export const LOBBY_FLOOR_FALLBACK: Record<number, string> = {
  [L_WALL]: "#5c6076",
  [L_MARBLE]: "#e4e2de",
  [L_PLAZA]: "#eceae6",
  [L_RING]: "#922a34",
  [L_CARPET]: "#922a34",
  [L_WOOD]: "#ac7c4e",
  [L_SAND]: "#ddd29a",
  [L_DARK]: "#434854",
  [L_CHECK]: "#cfd0d4",
};

export function isSolidLobbyTile(id: number): boolean {
  return id === L_VOID || id === L_WALL;
}

// ---------- 図形プリミティブ（和集合がロビーの外形） ----------

const PLAZA = { cx: 28, cy: 24, r: 11 };
const APSE = { cx: 28, cy: 10, r: 10 };
const SMITH_CIRCLE = { cx: 28, cy: 39, r: 4 };

function inCircle(cx: number, cy: number, r: number, x: number, y: number): boolean {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
function inRect(x0: number, y0: number, x1: number, y1: number, x: number, y: number): boolean {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

/** そのセルがロビーの外形（図形の和集合）に含まれるか。 */
export function inLobbyShape(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= LOBBY_W || y >= LOBBY_H) return false;
  // 上: 半円のアプス（闘技場）。中心を通る直径より上だけの半円
  if (y <= APSE.cy && inCircle(APSE.cx, APSE.cy, APSE.r, x, y)) return true;
  // アプスと広場をつなぐ首の通路
  if (inRect(26, 8, 30, 15, x, y)) return true;
  // 中央: 大円（交流広場）
  if (inCircle(PLAZA.cx, PLAZA.cy, PLAZA.r, x, y)) return true;
  // 左: ショップ翼 / 右: カジノ翼
  if (inRect(2, 18, 19, 30, x, y)) return true;
  if (inRect(37, 18, 53, 30, x, y)) return true;
  // 下: 鍛冶屋（矩形＋小円）
  if (inRect(24, 34, 32, 41, x, y)) return true;
  if (inCircle(SMITH_CIRCLE.cx, SMITH_CIRCLE.cy, SMITH_CIRCLE.r, x, y)) return true;
  // ショップ翼2階: ギルドショップ（別領域のサブエリア）
  if (inRect(2, 48, 19, 63, x, y)) return true;
  return false;
}

function dist2(cx: number, cy: number, x: number, y: number): number {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy;
}

/** ゾーンごとの床種を決める（境界壁は後段で上書きする）。 */
function floorAt(x: number, y: number): number {
  let floor = L_MARBLE;
  if (y <= APSE.cy && inCircle(APSE.cx, APSE.cy, APSE.r, x, y)) {
    floor = dist2(APSE.cx, APSE.cy, x, y) <= 49 ? L_SAND : L_MARBLE;
  }
  if (inRect(37, 18, 53, 30, x, y)) floor = L_CARPET;
  if (inRect(2, 18, 19, 30, x, y)) floor = L_WOOD;
  if (inRect(24, 34, 32, 41, x, y) || inCircle(SMITH_CIRCLE.cx, SMITH_CIRCLE.cy, SMITH_CIRCLE.r, x, y)) floor = L_DARK;
  if (inRect(2, 48, 19, 63, x, y)) floor = L_CHECK;
  if (inCircle(PLAZA.cx, PLAZA.cy, PLAZA.r, x, y)) {
    floor = dist2(PLAZA.cx, PLAZA.cy, x, y) <= 100 ? L_PLAZA : L_RING;
  }
  return floor;
}

// ---------- オブジェクト配置 ----------

export type LobbyStation = "board" | "shop" | "bank" | "casino" | "arena" | "smith";

export type LobbyObject = {
  sprite: string;
  x: number;
  y: number;
  w: number;
  h: number;
  solid: boolean;
  station?: LobbyStation;
};

const objects: LobbyObject[] = [];
const occupied = new Set<string>();

function put(sprite: string, x: number, y: number, opts: { w?: number; h?: number; solid?: boolean; station?: LobbyStation } = {}): void {
  const w = opts.w ?? 1;
  const h = opts.h ?? 1;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const key = `${x + dx},${y + dy}`;
      if (occupied.has(key)) throw new Error(`lobby object overlap at ${key} (${sprite})`);
      occupied.add(key);
    }
  }
  objects.push({ sprite, x, y, w, h, solid: opts.solid ?? true, station: opts.station });
}
function row(sprite: string, x0: number, x1: number, y: number, opts: { solid?: boolean; station?: LobbyStation } = {}): void {
  for (let x = x0; x <= x1; x++) put(sprite, x, y, opts);
}
function col(sprite: string, x: number, y0: number, y1: number, opts: { solid?: boolean; station?: LobbyStation } = {}): void {
  for (let y = y0; y <= y1; y++) put(sprite, x, y, opts);
}

// --- 中央広場 ---
put("fountain", 27, 23, { w: 3, h: 3 }); // 噴水（3×3・固体）
row("bulletin_board", 27, 29, 15, { station: "board" }); // 掲示板は広場の北縁
put("warp_pad", 28, 34, { solid: false }); // ワープパッドは広場の南縁（踏むとワールドへ）
row("bench", 23, 24, 17);
row("bench", 30, 31, 17);
for (const [x, y] of [[19, 19], [37, 19], [19, 29], [37, 29]] as const) put("lamp", x, y);
for (const [x, y] of [[21, 21], [35, 21], [21, 27], [35, 27]] as const) put("pillar", x, y);
for (const [x, y] of [[25, 32], [31, 32]] as const) put("planter", x, y);
put("vending", 24, 32);
put("vending", 32, 32);

// --- 銀行（広場の北東の弧） ---
row("bank_counter", 33, 34, 17, { station: "bank" });
put("vault", 35, 17, { station: "bank" });
put("atm", 35, 18, { station: "bank" });

// --- ショップ翼（左）: カウンター2列＋店員レーン、什器の間仕切りで小部屋状に ---
for (const x0 of [4, 8, 12]) row("shop_counter", x0, x0 + 2, 20, { station: "shop" });
for (const x0 of [4, 12]) row("shop_counter", x0, x0 + 2, 27, { station: "shop" });
put("sign_board", 16, 20);
put("planter", 3, 19);
put("planter", 17, 19);
col("display_case", 7, 23, 24, { station: "shop" });
col("display_case", 11, 23, 24, { station: "shop" });
col("item_shelf", 3, 23, 24, { station: "shop" });
row("display_case", 8, 10, 27, { station: "shop" });
put("sign_board", 9, 26);
row("display_case", 8, 10, 29, { station: "shop" });
put("crate", 16, 23);
put("crate", 16, 24);
put("barrel", 15, 24);
put("barrel", 3, 29);
put("stairs", 17, 29, { solid: false }); // 2階（ギルドショップ）への階段
put("stairs", 18, 29, { solid: false });

// --- カジノ翼（右）: スロット列とテーブルの小集団、生垣とソファで隅を作る ---
for (const x of [39, 41, 43, 45, 47, 49, 51]) put("slot_machine", x, 19, { station: "casino" });
for (const x of [40, 42, 44, 46, 48, 50]) put("slot_machine", x, 29, { station: "casino" });
for (const [x, y] of [[41, 23], [42, 23], [47, 23], [48, 23], [41, 26], [47, 26]] as const) {
  put("casino_table", x, y, { station: "casino" });
}
put("table_round", 44, 24);
put("chair", 43, 24);
put("chair", 45, 24);
put("sofa", 51, 24);
put("sofa", 51, 25);
put("table_round", 50, 24);
put("piano", 39, 26, { station: "casino" });
put("hedge", 44, 21);
put("hedge", 44, 27);
put("planter", 52, 19);
put("lamp", 38, 19);
put("lamp", 52, 29);
put("tapestry", 52, 22, { solid: false });

// --- 闘技場（上・半円アプス）: 砂の土俵を柵の弧で囲む ---
for (let y = 0; y <= 9; y++) {
  for (let x = 0; x < LOBBY_W; x++) {
    const d2 = dist2(APSE.cx, APSE.cy, x, y);
    if (d2 >= 36 && d2 <= 52) put("arena_gate", x, y, { station: "arena" });
  }
}
for (const [x, y] of [[20, 6], [21, 5], [35, 6], [34, 5], [24, 2], [32, 2]] as const) {
  put("bench", x, y, { station: "arena" });
}
put("sign_board", 29, 13, { station: "arena" });

// --- 鍛冶屋（下・小円+矩形） ---
put("furnace", 25, 40, { station: "smith" });
put("furnace", 31, 40, { station: "smith" });
put("anvil", 28, 38, { station: "smith" });
put("workbench", 25, 36, { station: "smith" });
put("workbench", 31, 36, { station: "smith" });
put("fence_wood", 26, 38);
put("fence_wood", 30, 38);
put("crate", 26, 34);
put("barrel", 30, 34);
put("lamp", 28, 41);

// --- ショップ翼2階: ギルドショップ（屋台区画のグリッド、区画は空き） ---
for (const y of [51, 57]) {
  for (const x0 of [3, 8, 13]) {
    row("shop_counter", x0, x0 + 2, y, { station: "shop" });
    put("sign_board", x0 + 3, y);
  }
}
row("bookshelf", 3, 5, 54);
row("item_shelf", 8, 10, 54, { station: "shop" });
row("bookshelf", 13, 15, 54);
put("sofa", 3, 60);
put("chair", 4, 60);
put("table_round", 4, 61);
put("planter", 18, 49);
put("lamp", 3, 49);
put("stairs", 17, 62, { solid: false }); // 1階への階段
put("stairs", 18, 62, { solid: false });

export const LOBBY_OBJECTS: readonly LobbyObject[] = objects;

/** 店員NPC（あごむに）が立つタイル。カウンターの背面で、当たり判定なし。 */
export const LOBBY_NPCS: readonly { x: number; y: number }[] = [
  { x: 5, y: 19 }, { x: 9, y: 19 }, { x: 13, y: 19 }, // 北カウンターの店員レーン
  { x: 5, y: 28 }, { x: 13, y: 28 }, // 南カウンターの店員レーン
];

/** ロビー入場地点（ワープパッドの北、広場側）。 */
export const LOBBY_ENTRY = { x: 28.5, y: 32.5 };
/** ロビーのワープパッド（タイル座標）。 */
export const LOBBY_WARP_PAD = { x: 28, y: 34 };
/** ワールド側スポーン広場のワープパッド（タイル座標）。 */
export const WORLD_WARP_PAD = { x: 514, y: 512 };
/** 1階の階段タイル（踏むと2階へ）。 */
export const LOBBY_STAIRS_UP: readonly { x: number; y: number }[] = [{ x: 17, y: 29 }, { x: 18, y: 29 }];
/** 2階の階段タイル（踏むと1階へ）。 */
export const LOBBY_STAIRS_DOWN: readonly { x: number; y: number }[] = [{ x: 17, y: 62 }, { x: 18, y: 62 }];
/** 階段を上がった先の着地点。 */
export const LOBBY_UP_LANDING = { x: 17.5, y: 60.5 };
/** 階段を下りた先の着地点。 */
export const LOBBY_DOWN_LANDING = { x: 17.5, y: 27.5 };

export type LobbyData = {
  width: number;
  height: number;
  /** 床タイル（行優先）。 */
  tiles: Uint8Array;
  objects: readonly LobbyObject[];
  npcs: readonly { x: number; y: number }[];
  /** 固体オブジェクトのタイル集合（"x,y"）。移動の blocked に渡す。 */
  blocked: ReadonlySet<string>;
  /** move.ts がそのまま使える形（固体セル=岩、それ以外=草）。 */
  moveMap: TopDownMap;
};

export function lobbyTileAt(tiles: Uint8Array, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= LOBBY_W || y >= LOBBY_H) return L_VOID;
  return tiles[y * LOBBY_W + x];
}

let cached: LobbyData | null = null;

/** ロビー全体を構築する（決定的。結果はキャッシュする）。 */
export function buildLobby(): LobbyData {
  if (cached) return cached;
  const tiles = new Uint8Array(LOBBY_W * LOBBY_H);
  for (let y = 0; y < LOBBY_H; y++) {
    for (let x = 0; x < LOBBY_W; x++) {
      if (!inLobbyShape(x, y)) continue; // L_VOID のまま
      const boundary =
        !inLobbyShape(x - 1, y) || !inLobbyShape(x + 1, y) || !inLobbyShape(x, y - 1) || !inLobbyShape(x, y + 1);
      tiles[y * LOBBY_W + x] = boundary ? L_WALL : floorAt(x, y);
    }
  }
  const blocked = new Set<string>();
  for (const o of LOBBY_OBJECTS) {
    if (!o.solid) continue;
    for (let dy = 0; dy < o.h; dy++) {
      for (let dx = 0; dx < o.w; dx++) blocked.add(`${o.x + dx},${o.y + dy}`);
    }
  }
  const moveTiles = new Uint8Array(LOBBY_W * LOBBY_H);
  for (let i = 0; i < tiles.length; i++) {
    moveTiles[i] = isSolidLobbyTile(tiles[i]) ? T_ROCK : T_GRASS;
  }
  cached = {
    width: LOBBY_W,
    height: LOBBY_H,
    tiles,
    objects: LOBBY_OBJECTS,
    npcs: LOBBY_NPCS,
    blocked,
    moveMap: { seed: 0, width: LOBBY_W, height: LOBBY_H, tiles: moveTiles },
  };
  return cached;
}

/** プレイヤーのタイルに隣接（チェビシェフ距離1以内）するステーション。無ければ null。 */
export function stationNear(objectsList: readonly LobbyObject[], tx: number, ty: number): LobbyStation | null {
  for (const o of objectsList) {
    if (!o.station) continue;
    if (tx >= o.x - 1 && tx <= o.x + o.w && ty >= o.y - 1 && ty <= o.y + o.h) return o.station;
  }
  return null;
}
