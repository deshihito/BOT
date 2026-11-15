// AGO WORLD BOX のテント内装（純粋ロジック、DOM 非依存）。
// 置いたテントを踏むと入れる小さな室内空間。形は LobbyData と同じにして、
// ロビーの描画・移動・ステーション判定をそのまま使う。最低限の設備として
// 作業台とかまど（どちらも station: "smith" = 合成の場所）を持つ。
import { T_GRASS, T_ROCK, type TopDownMap } from "./mapgen";
import { L_WALL, L_WOOD, isSolidLobbyTile, type LobbyData, type LobbyObject } from "./lobby";

export const TENT_W = 13;
export const TENT_H = 10;

/** 入室直後の位置（出入口の内側）。 */
export const TENT_ENTRY = { x: 6.5, y: 8.5 };
/** 出入口タイル（南壁の中央。踏むとワールドへ戻る）。 */
export const TENT_EXIT = { x: 6, y: 9 };

const TENT_OBJECTS: readonly LobbyObject[] = [
  // 左上の鍛冶コーナー
  { sprite: "furnace", x: 1, y: 1, w: 1, h: 1, solid: true, station: "smith" },
  { sprite: "anvil", x: 2, y: 1, w: 1, h: 1, solid: true, station: "smith" },
  // 右上の小物
  { sprite: "lamp", x: 11, y: 1, w: 1, h: 1, solid: true },
  { sprite: "bookshelf", x: 10, y: 1, w: 1, h: 1, solid: true },
  // 左下の収納コーナー
  { sprite: "crate", x: 1, y: 8, w: 1, h: 1, solid: true },
  { sprite: "barrel", x: 2, y: 8, w: 1, h: 1, solid: true },
  // 右下の休憩コーナー
  { sprite: "sofa", x: 11, y: 8, w: 1, h: 1, solid: true },
  // 出入口の脇の作業台（入ってすぐ合成できる）
  { sprite: "workbench", x: 7, y: 8, w: 1, h: 1, solid: true, station: "smith" },
  // 出入口（平置き・通過可）
  { sprite: "warp_pad", x: TENT_EXIT.x, y: TENT_EXIT.y, w: 1, h: 1, solid: false },
];

export function tentTileAt(tiles: Uint8Array, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= TENT_W || y >= TENT_H) return 0;
  return tiles[y * TENT_W + x];
}

let cachedTent: LobbyData | null = null;

/** テント内装を構築する（決定的。結果はキャッシュする）。 */
export function buildTent(): LobbyData {
  if (cachedTent) return cachedTent;
  const tiles = new Uint8Array(TENT_W * TENT_H);
  for (let y = 0; y < TENT_H; y++) {
    for (let x = 0; x < TENT_W; x++) {
      const border = x === 0 || y === 0 || x === TENT_W - 1 || y === TENT_H - 1;
      const door = x === TENT_EXIT.x && y === TENT_EXIT.y;
      tiles[y * TENT_W + x] = border && !door ? L_WALL : L_WOOD;
    }
  }
  const blocked = new Set<string>();
  for (const o of TENT_OBJECTS) {
    if (!o.solid) continue;
    for (let dy = 0; dy < o.h; dy++) {
      for (let dx = 0; dx < o.w; dx++) blocked.add(`${o.x + dx},${o.y + dy}`);
    }
  }
  const moveTiles = new Uint8Array(TENT_W * TENT_H);
  for (let i = 0; i < tiles.length; i++) {
    moveTiles[i] = isSolidLobbyTile(tiles[i]) ? T_ROCK : T_GRASS;
  }
  const moveMap: TopDownMap = { seed: 0, width: TENT_W, height: TENT_H, tiles: moveTiles };
  cachedTent = {
    width: TENT_W,
    height: TENT_H,
    tiles,
    objects: TENT_OBJECTS,
    npcs: [],
    blocked,
    moveMap,
  };
  return cachedTent;
}
