// AGO WORLD BOX のロビー 2F（ラウンジ）・3F（展望）（純粋ロジック、DOM 非依存）。
// 1F と同じく別空間（space "lobby2" / "lobby3"）の本物のマップで、形は
// 図形の和集合（長方形だけにしない）。既存の擬似2F（1F グリッド内の
// ギルドショップ区画 y48-63）は残置する: ギルドショップは feat タスクの
// F4 が触るため、今夜は移設しない。2F はラウンジ＋休憩、3F は展望＋休憩。
// 3F 北の本棚 2 つは L5 の隠し部屋の入口アンカー候補（今はただの家具）。
// 階段の遷移は L2b で配線済み: 判定はこのファイルの floorWarpAt（純粋ロジック）、
// 実行（フェード遷移）は WorldBoxClient.tsx の doFloorWarp が担う。
// アーケード筐体（L3 第1弾6台・L6 第2弾20台）は新規スプライト arcade_<id>.png を使う（textures.ts に登録）。
// 筐体パネル・ルーム起動は L4 で配線済み: put2/put3 が arcade_ スプライトに
// station "arcade" とゲーム ID を自動で付ける（WorldBoxArcadePanel が起動する）。
import { T_GRASS, T_ROCK, tilesSource, type TopDownMap } from "./mapgen";
import {
  L_CARPET,
  L_MARBLE,
  L_PLAZA,
  L_WALL,
  L_WOOD,
  LOBBY_2F_LANDING,
  LOBBY_STAIRS_2F,
  isSolidLobbyTile,
  type LobbyData,
  type LobbyObject,
  type LobbyStation,
  isSeatSprite,
} from "./lobby";
import type { ShopGenreId } from "./shops";

export const LOBBY2_W = 40;
export const LOBBY2_H = 28;
export const LOBBY3_W = 32;
export const LOBBY3_H = 24;

// ---------- 2F: ラウンジ ----------

const L2_CIRCLE = { cx: 20, cy: 14, r: 8 };

function inCircle2(cx: number, cy: number, r: number, x: number, y: number): boolean {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
function inRect2(x0: number, y0: number, x1: number, y1: number, x: number, y: number): boolean {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

/** 2F の外形（図形の和集合）: 中央円＋東西の翼＋南北の階段踊り場。 */
export function inLobby2Shape(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= LOBBY2_W || y >= LOBBY2_H) return false;
  // 中央: ラウンジの円
  if (inCircle2(L2_CIRCLE.cx, L2_CIRCLE.cy, L2_CIRCLE.r, x, y)) return true;
  // 西: ギルド談話の翼 / 東: 休憩の翼
  if (inRect2(2, 9, 12, 19, x, y)) return true;
  if (inRect2(28, 9, 38, 19, x, y)) return true;
  // 北: 1F への階段の踊り場 / 南: 3F への階段の踊り場
  if (inRect2(17, 3, 23, 7, x, y)) return true;
  if (inRect2(17, 21, 23, 25, x, y)) return true;
  return false;
}

function floor2At(x: number, y: number): number {
  let floor = L_MARBLE;
  if (inRect2(2, 9, 12, 19, x, y) || inRect2(28, 9, 38, 19, x, y)) floor = L_WOOD;
  if (inCircle2(L2_CIRCLE.cx, L2_CIRCLE.cy, L2_CIRCLE.r, x, y)) floor = L_CARPET;
  return floor;
}

const objects2: LobbyObject[] = [];
const occupied2 = new Set<string>();

type PutOpts = { w?: number; h?: number; solid?: boolean; station?: LobbyStation; genre?: ShopGenreId; arcade?: string };

/** 筐体スプライト（arcade_<id>）なら station とゲーム ID を補う（L4）。明示指定が優先。 */
function arcadeFields(sprite: string, opts: PutOpts): { station?: LobbyStation; arcade?: string } {
  if (!sprite.startsWith("arcade_")) return { station: opts.station, arcade: opts.arcade };
  return { station: opts.station ?? "arcade", arcade: opts.arcade ?? sprite.slice("arcade_".length) };
}

function put2(sprite: string, x: number, y: number, opts: PutOpts = {}): void {
  const w = opts.w ?? 1;
  const h = opts.h ?? 1;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const key = `${x + dx},${y + dy}`;
      if (occupied2.has(key)) throw new Error(`lobby2 object overlap at ${key} (${sprite})`);
      occupied2.add(key);
    }
  }
  const af = arcadeFields(sprite, opts);
  objects2.push({ sprite, x, y, w, h, solid: opts.solid ?? true, station: af.station, genre: opts.genre, arcade: af.arcade });
}

// --- 階段（通過可） ---
put2("stairs", 19, 4, { solid: false }); // 1F への階段
put2("stairs", 20, 4, { solid: false });
put2("stairs", 19, 24, { solid: false }); // 3F への階段
put2("stairs", 20, 24, { solid: false });

// --- 中央ラウンジ ---
put2("planter", 20, 8);
put2("pillar", 15, 11);
put2("pillar", 25, 11);
put2("pillar", 15, 17);
put2("pillar", 25, 17);
put2("bench", 17, 12);
put2("bench", 18, 12);
put2("bench", 22, 12);
put2("bench", 23, 12);
put2("table_round", 20, 14);
put2("chair", 19, 14);
put2("chair", 21, 14);
put2("lamp", 18, 6);
put2("lamp", 22, 6);
put2("lamp", 18, 22);
put2("lamp", 22, 22);

// --- 中央ラウンジ北弧: アーケード筐体（L3 第1弾・1タイル1ゲーム） ---
// 対面3＋パーティ3を ARCADE_FIRST_WAVE の順に左から並べる（カジノの
// 機器列と同じく1マス空け）。前に立つのは南側の y=10（円の中心側）。
// station "arcade" とゲーム ID は put2 がスプライト名から自動で付ける。
put2("arcade_reversi", 15, 9);
put2("arcade_connect4", 17, 9);
put2("arcade_battleship", 19, 9);
put2("arcade_werewolf", 21, 9);
put2("arcade_wordwolf", 23, 9);
put2("arcade_majority", 25, 9);

// --- 中央ラウンジ南弧: アーケード筐体（L6 第2弾・1タイル1ゲーム） ---
// 第2弾の先頭6台を ARCADE_SECOND_WAVE_2F の順に左から並べる（北弧と同じく
// 1マス空け）。前に立つのは北側の y=18（円の中心側）。南踊り場（y=21-25）
// への動線は列の隙間（x=16,18,20,22,24）で通す。
put2("arcade_territory", 15, 19);
put2("arcade_drawguess", 17, 19);
put2("arcade_daifugo", 19, 19);
put2("arcade_babanuki", 21, 19);
put2("arcade_quizbattle", 23, 19);
put2("arcade_bombpass", 25, 19);

// --- 西翼: ギルド談話 ---
put2("bench", 4, 11);
put2("bench", 5, 11);
put2("table_round", 7, 14);
put2("sofa", 4, 17);
put2("chair", 5, 17);
put2("planter", 11, 10);
put2("lamp", 3, 18);
put2("lamp", 11, 18);

// --- 東翼: 休憩 ---
put2("bookshelf", 31, 11, { station: "rest" });
put2("bookshelf", 32, 11, { station: "rest" });
put2("bookshelf", 33, 11, { station: "rest" });
put2("sofa", 35, 17, { station: "rest" });
put2("table_round", 34, 17);
put2("chair", 35, 18);
put2("planter", 29, 18);
put2("lamp", 37, 10);
put2("tapestry", 37, 14, { solid: false });

export const LOBBY2_OBJECTS: readonly LobbyObject[] = objects2;

/** 1F の階段を上がった先の着地点（2F 北踊り場）。 */
export const LOBBY2_ENTRY = { x: 19.5, y: 6.5 };
/** 2F の階段タイル（踏むと 1F へ）。 */
export const LOBBY2_STAIRS_DOWN: readonly { x: number; y: number }[] = [{ x: 19, y: 4 }, { x: 20, y: 4 }];
/** 2F の階段タイル（踏むと 3F へ）。 */
export const LOBBY2_STAIRS_UP: readonly { x: number; y: number }[] = [{ x: 19, y: 24 }, { x: 20, y: 24 }];
/** 3F の階段を下りた先の着地点（2F 南踊り場）。 */
export const LOBBY2_UP_LANDING = { x: 19.5, y: 22.5 };

export function lobby2TileAt(tiles: Uint8Array, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= LOBBY2_W || y >= LOBBY2_H) return 0;
  return tiles[y * LOBBY2_W + x];
}

let cached2: LobbyData | null = null;

/** 2F ラウンジ全体を構築する（決定的。結果はキャッシュする）。 */
export function buildLobby2(): LobbyData {
  if (cached2) return cached2;
  const tiles = new Uint8Array(LOBBY2_W * LOBBY2_H);
  for (let y = 0; y < LOBBY2_H; y++) {
    for (let x = 0; x < LOBBY2_W; x++) {
      if (!inLobby2Shape(x, y)) continue; // 0 (L_VOID) のまま
      const boundary =
        !inLobby2Shape(x - 1, y) || !inLobby2Shape(x + 1, y) || !inLobby2Shape(x, y - 1) || !inLobby2Shape(x, y + 1);
      tiles[y * LOBBY2_W + x] = boundary ? L_WALL : floor2At(x, y);
    }
  }
  const blocked = new Set<string>();
  for (const o of LOBBY2_OBJECTS) {
    // オブジェクトは必ず床タイルの上に置く（壁の上は配置ミス）。
    for (let dy = 0; dy < o.h; dy++) {
      for (let dx = 0; dx < o.w; dx++) {
        if (tiles[(o.y + dy) * LOBBY2_W + o.x + dx] === L_WALL) {
          throw new Error(`lobby2 object on wall at ${o.x + dx},${o.y + dy} (${o.sprite})`);
        }
      }
    }
    if (!o.solid) continue;
    if (isSeatSprite(o.sprite)) continue; // 座席は上に乗って座るため固体にしない（lobby.ts と同じ）
    for (let dy = 0; dy < o.h; dy++) {
      for (let dx = 0; dx < o.w; dx++) blocked.add(`${o.x + dx},${o.y + dy}`);
    }
  }
  const moveTiles = new Uint8Array(LOBBY2_W * LOBBY2_H);
  for (let i = 0; i < tiles.length; i++) {
    moveTiles[i] = isSolidLobbyTile(tiles[i]) ? T_ROCK : T_GRASS;
  }
  cached2 = {
    width: LOBBY2_W,
    height: LOBBY2_H,
    tiles,
    objects: LOBBY2_OBJECTS,
    npcs: [],
    blocked,
    moveMap: tilesSource(0, LOBBY2_W, LOBBY2_H, moveTiles),
  };
  return cached2;
}

// ---------- 3F: 展望 ----------

const L3_CIRCLE = { cx: 16, cy: 13, r: 9 };

function inCircle3(cx: number, cy: number, r: number, x: number, y: number): boolean {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
function inRect3(x0: number, y0: number, x1: number, y1: number, x: number, y: number): boolean {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

/** 3F の外形（図形の和集合）: 展望の円＋北の見晴らしデッキ。 */
export function inLobby3Shape(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= LOBBY3_W || y >= LOBBY3_H) return false;
  // 展望の円
  if (inCircle3(L3_CIRCLE.cx, L3_CIRCLE.cy, L3_CIRCLE.r, x, y)) return true;
  // 北: 見晴らしデッキ
  if (inRect3(10, 2, 22, 5, x, y)) return true;
  return false;
}

function dist3Sq(cx: number, cy: number, x: number, y: number): number {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy;
}

function floor3At(x: number, y: number): number {
  let floor = L_MARBLE;
  if (inRect3(10, 2, 22, 5, x, y)) floor = L_WOOD;
  if (inCircle3(L3_CIRCLE.cx, L3_CIRCLE.cy, L3_CIRCLE.r, x, y)) {
    floor = dist3Sq(L3_CIRCLE.cx, L3_CIRCLE.cy, x, y) <= 16 ? L_PLAZA : L_MARBLE;
  }
  return floor;
}

const objects3: LobbyObject[] = [];
const occupied3 = new Set<string>();

function put3(sprite: string, x: number, y: number, opts: PutOpts = {}): void {
  const w = opts.w ?? 1;
  const h = opts.h ?? 1;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const key = `${x + dx},${y + dy}`;
      if (occupied3.has(key)) throw new Error(`lobby3 object overlap at ${key} (${sprite})`);
      occupied3.add(key);
    }
  }
  const af = arcadeFields(sprite, opts);
  objects3.push({ sprite, x, y, w, h, solid: opts.solid ?? true, station: af.station, genre: opts.genre, arcade: af.arcade });
}

// --- 階段（通過可） ---
put3("stairs", 15, 3, { solid: false }); // 2F への階段
put3("stairs", 16, 3, { solid: false });

// --- 北デッキ: 見晴らし（北向きのベンチ）＋ L5 隠し部屋のアンカー本棚 ---
put3("bench", 11, 3);
put3("bench", 12, 3);
put3("bench", 20, 3);
put3("bench", 21, 3);
put3("telescope", 18, 4, { station: "telescope" }); // 北デッキの望遠鏡（展望）
put3("bookshelf", 13, 4); // L5 の隠し部屋の入口アンカー候補（今はただの本棚）
put3("bookshelf", 14, 4);
put3("planter", 11, 4);
put3("planter", 21, 4);
put3("hedge", 12, 5);
put3("hedge", 20, 5);

// --- 展望の円 ---
put3("lamp", 11, 9);
put3("lamp", 21, 9);
put3("lamp", 11, 17);
put3("lamp", 21, 17);

// --- アーケード筐体（L6 第2弾・1タイル1ゲーム、残り14台） ---
// 西弧 x=9（前に立つのは東側 x=10、円の中心側）と東弧 x=23（前は x=22）は
// 1マス空けで縦に4台ずつ。南弧 y=18（前は北側 y=17）は x=10,12,20,22 の
// 4台（y=19 の休憩家具と干渉しない位置）。北デッキ y=3 は x=17,19 の2台
// （前は y=4、階段 x=15,16・ベンチ・L5 アンカー本棚 x=13,14 を避ける）。
// station "arcade" とゲーム ID は put3 がスプライト名から自動で付ける。
put3("arcade_shiritori", 9, 10);
put3("arcade_nanja", 9, 12);
put3("arcade_liarsdice", 9, 14);
put3("arcade_cheat", 9, 16);
put3("arcade_hagetaka", 23, 10);
put3("arcade_burst", 23, 12);
put3("arcade_texas", 23, 14);
put3("arcade_countdown", 23, 16);
put3("arcade_musicalchairs", 10, 18);
put3("arcade_wordbasket", 12, 18);
put3("arcade_speed", 20, 18);
put3("arcade_typerace", 22, 18);
put3("arcade_calcrace", 17, 3);
put3("arcade_stopbattle", 19, 3);

// --- 南の休憩コーナー ---
put3("sofa", 14, 19, { station: "rest" });
put3("table_round", 15, 19);
put3("chair", 16, 19);
put3("bookshelf", 18, 19, { station: "rest" });

export const LOBBY3_OBJECTS: readonly LobbyObject[] = objects3;

/** 2F の階段を上がった先の着地点（3F 北デッキ）。 */
export const LOBBY3_ENTRY = { x: 15.5, y: 5.5 };
/** 3F の階段タイル（踏むと 2F へ）。 */
export const LOBBY3_STAIRS_DOWN: readonly { x: number; y: number }[] = [{ x: 15, y: 3 }, { x: 16, y: 3 }];
/** 3F の階段を下りた先の着地点（2F 南踊り場）。 */
export const LOBBY3_DOWN_LANDING = { x: 19.5, y: 22.5 };

export function lobby3TileAt(tiles: Uint8Array, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= LOBBY3_W || y >= LOBBY3_H) return 0;
  return tiles[y * LOBBY3_W + x];
}

let cached3: LobbyData | null = null;

/** 3F 展望全体を構築する（決定的。結果はキャッシュする）。 */
export function buildLobby3(): LobbyData {
  if (cached3) return cached3;
  const tiles = new Uint8Array(LOBBY3_W * LOBBY3_H);
  for (let y = 0; y < LOBBY3_H; y++) {
    for (let x = 0; x < LOBBY3_W; x++) {
      if (!inLobby3Shape(x, y)) continue; // 0 (L_VOID) のまま
      const boundary =
        !inLobby3Shape(x - 1, y) || !inLobby3Shape(x + 1, y) || !inLobby3Shape(x, y - 1) || !inLobby3Shape(x, y + 1);
      tiles[y * LOBBY3_W + x] = boundary ? L_WALL : floor3At(x, y);
    }
  }
  const blocked = new Set<string>();
  for (const o of LOBBY3_OBJECTS) {
    // オブジェクトは必ず床タイルの上に置く（壁の上は配置ミス）。
    for (let dy = 0; dy < o.h; dy++) {
      for (let dx = 0; dx < o.w; dx++) {
        if (tiles[(o.y + dy) * LOBBY3_W + o.x + dx] === L_WALL) {
          throw new Error(`lobby3 object on wall at ${o.x + dx},${o.y + dy} (${o.sprite})`);
        }
      }
    }
    if (!o.solid) continue;
    if (isSeatSprite(o.sprite)) continue; // 座席は上に乗って座るため固体にしない（lobby.ts と同じ）
    for (let dy = 0; dy < o.h; dy++) {
      for (let dx = 0; dx < o.w; dx++) blocked.add(`${o.x + dx},${o.y + dy}`);
    }
  }
  const moveTiles = new Uint8Array(LOBBY3_W * LOBBY3_H);
  for (let i = 0; i < tiles.length; i++) {
    moveTiles[i] = isSolidLobbyTile(tiles[i]) ? T_ROCK : T_GRASS;
  }
  cached3 = {
    width: LOBBY3_W,
    height: LOBBY3_H,
    tiles,
    objects: LOBBY3_OBJECTS,
    npcs: [],
    blocked,
    moveMap: tilesSource(0, LOBBY3_W, LOBBY3_H, moveTiles),
  };
  return cached3;
}

// ---------- 階段遷移（L2b） ----------

/** ロビーの階（1F / 2F / 3F）。 */
export type LobbyFloorSpace = "lobby" | "lobby2" | "lobby3";

/** 階段を踏んだときの遷移先。着地点は行き先の階段の前（再発火しないタイル）。 */
export type FloorWarp = { to: LobbyFloorSpace; entry: { x: number; y: number } };

const onTiles = (tiles: readonly { x: number; y: number }[], tx: number, ty: number): boolean =>
  tiles.some((t) => t.x === tx && t.y === ty);

/**
 * その空間・タイルが階段なら遷移先を返す。階段でなければ null。
 * 1F の階段はギルドショップ区画（擬似2F）の東の階段室の続き（LOBBY_STAIRS_2F）。
 * 擬似2F内の階段（LOBBY_STAIRS_UP / DOWN）とワープパッドは同一空間内の
 * 移動なのでここでは扱わない（クライアント側の従来処理のまま）。
 */
export function floorWarpAt(space: string, tx: number, ty: number): FloorWarp | null {
  if (space === "lobby") {
    if (onTiles(LOBBY_STAIRS_2F, tx, ty)) return { to: "lobby2", entry: LOBBY2_ENTRY };
    return null;
  }
  if (space === "lobby2") {
    if (onTiles(LOBBY2_STAIRS_DOWN, tx, ty)) return { to: "lobby", entry: LOBBY_2F_LANDING };
    if (onTiles(LOBBY2_STAIRS_UP, tx, ty)) return { to: "lobby3", entry: LOBBY3_ENTRY };
    return null;
  }
  if (space === "lobby3") {
    if (onTiles(LOBBY3_STAIRS_DOWN, tx, ty)) return { to: "lobby2", entry: LOBBY2_UP_LANDING };
    return null;
  }
  return null;
}
