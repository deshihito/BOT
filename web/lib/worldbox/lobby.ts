// AGO WORLD BOX のロビー（純粋ロジック、DOM 非依存）。
// ロビーはワールドとは別の空間で、形は長方形ではなく図形の組み合わせ:
// 中央=大円（交流広場）、左=矩形の翼（ショップ）、右=矩形の翼（カジノ）、
// 上=半円のアプス（闘技場）、下=小円+矩形（鍛冶屋）、カジノ翼の南に
// 矩形の別室（取引所ホール）。床グリッドはこれらの
// 図形の和集合で、和集合の境界セルが壁になる。ショップ翼の2階（ギルド
// ショップ）は同じグリッド内の別領域（サブエリア）として持ち、階段タイルで
// 往復する。カジノ翼の東には通路の先に競馬場（大きな矩形＋楕円トラック）を
// 拡張してある（ロビーのまま歩いて行ける一続きの空間）。全てマス目管理:
// 配置・占有・判定はタイル単位。
import { T_GRASS, T_ROCK, tilesSource, type TopDownMap } from "./mapgen";
import type { ShopGenreId } from "./shops";

/** 座れる家具のスプライト（=アイテム ID。タイル側 tiles.ts の SEAT_ITEM_IDS と一致させること）。
 * 座席は上に乗って座るため、室内の blocked（固体）には入れない。 */
export const SEAT_SPRITES: ReadonlySet<string> = new Set(["bench", "chair", "sofa"]);

export function isSeatSprite(sprite: string): boolean {
  return SEAT_SPRITES.has(sprite);
}

export const LOBBY_W = 224;
export const LOBBY_H = 136;

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

/** 競馬場のトラック楕円（外周と内周。間の帯がコース、内側がインフィールド）。 */
export const RACETRACK = { cx: 93, cy: 26, rx: 29, ry: 18, innerRx: 24, innerRy: 13 };
/** カジノ翼から競馬場への通路（外形に含まれる矩形）。 */
export const RACE_CORRIDOR = { x0: 54, y0: 21, x1: 59, y1: 27 };
/** 取引所ホール（カジノ翼の南の別室）。 */
export const EXCHANGE_HALL = { x0: 36, y0: 33, x1: 54, y1: 46 };
/** カジノ翼から取引所ホールへの通路（外形に含まれる矩形）。 */
export const EXCHANGE_CORRIDOR = { x0: 44, y0: 31, x1: 46, y1: 32 };
/** 競馬場エリア（外形に含まれる矩形）。 */
export const RACECOURSE = { x0: 60, y0: 4, x1: 125, y1: 47 };

function ellipseRatio(cx: number, cy: number, rx: number, ry: number, x: number, y: number): number {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy;
}

/** そのセルが競馬場のトラック（楕円の帯）の上か。 */
export function isRaceTrackTile(x: number, y: number): boolean {
  return (
    ellipseRatio(RACETRACK.cx, RACETRACK.cy, RACETRACK.rx, RACETRACK.ry, x, y) <= 1 &&
    ellipseRatio(RACETRACK.cx, RACETRACK.cy, RACETRACK.innerRx, RACETRACK.innerRy, x, y) >= 1
  );
}

/** そのセルがトラック内側のインフィールドか。 */
export function isRaceInfieldTile(x: number, y: number): boolean {
  return ellipseRatio(RACETRACK.cx, RACETRACK.cy, RACETRACK.innerRx, RACETRACK.innerRy, x, y) < 1;
}

function inCircle(cx: number, cy: number, r: number, x: number, y: number): boolean {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
function inRect(x0: number, y0: number, x1: number, y1: number, x: number, y: number): boolean {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

const INTERIOR_COURTYARDS: readonly [number, number, number, number][] = [
  [9, 8, 13, 11], // 北西・グルメ夜市の中庭
  [46, 8, 50, 11], // 北東・金融取引街の金庫中庭
  [28, 53, 32, 57], // エメラルド迷宮・西アトリウム
  [38, 58, 42, 62], // エメラルド迷宮・南中庭（40,60 VOID保持）
  [50, 52, 54, 56], // エメラルド迷宮・東アトリウム
  [30, 74, 34, 79], // 祭り小路・西入り江
  [46, 75, 51, 80], // 祭り小路・東入り江
  [8, 76, 14, 83], // ハーバー桟橋・中央ラグーン
  // 東回廊リゾート・大中庭（中央を secret room 1 として抜く、y=26 が左右隠し通路）
  [136, 16, 145, 18],
  [136, 34, 145, 36],
  [136, 19, 137, 24],
  [136, 28, 137, 33],
  [144, 19, 145, 24],
  [144, 28, 145, 33],
  [71, 56, 76, 61], // ロイヤル迷宮・西石庭
  [85, 67, 92, 74], // ロイヤル迷宮・王立中庭
  [102, 76, 109, 82], // 商業アトリウム・石庭
  [122, 56, 129, 64], // サンセット城・北堀（125,60 VOID保持）
  [136, 70, 144, 78], // 屋外劇場・内庭
  [59, 80, 66, 85], // ハーバー南東・入り江石庭
  [74, 80, 81, 86], // 南バラ庭園・中庭
  [96, 54, 98, 61], // ロイヤル迷宮・商業街の境界柱中庭
  [114, 76, 118, 83], // 商業東・回廊石庭
  [128, 70, 132, 74], // サンセット城・西回廊石庭

  // ===== 拡張デパート＆テーマパークウィング 中庭・迷宮隔壁 =====
  [164, 14, 170, 20], // ワンダーランド遊園地・観覧車プラザ吹抜
  [178, 25, 184, 32], // ワンダーランド・サーカス中庭
  [194, 11, 198, 23], // ワンダーランド生垣迷路・北隔壁
  [194, 32, 200, 41], // ワンダーランド生垣迷路・お化け屋敷中庭
  // 秘密部屋3「妖精の森の隠れ祠」(206..220, 8..19) を囲う壕（y=12..14 が秘密通路）
  [202, 4, 221, 7],
  [202, 8, 205, 11],
  [202, 15, 205, 22],
  [206, 20, 221, 22],

  // デパート中央アトリウム・総合案内 (156..191, 48..91)
  [164, 56, 168, 60], // デパート西吹抜
  [178, 56, 182, 60], // デパート東吹抜
  [170, 72, 176, 77], // デパート中央エスカレーター吹抜

  // 秘密部屋4「館長と王家の秘密書庫」(205..220, 49..62) 隔壁（x=214..216 / x=209..211 が裏通路）
  [192, 46, 213, 49], // 遊園地〜アクアリウム境界壁（214..216 が隠し通気口）
  [217, 46, 221, 49],
  [202, 50, 204, 62], // 書庫西隔壁
  [194, 63, 208, 66], // アクアリウム南隔壁（209..211 が隠し扉）
  [212, 63, 221, 66],
  [204, 77, 209, 85], // クリスタル迷宮・アクアリウム大水槽中庭

  // 地下商店街・デパート大迷宮モール (4..100, 93..133)
  [18, 97, 23, 102], // モール西・吹き抜け柱
  [36, 107, 42, 112], // モール中央西・食料品アトリウム
  [68, 106, 74, 112], // モール中央東・玩具広場アトリウム
  // 秘密部屋5 & バックヤード裏通路隔壁（3箇所の隠し扉 18..20, 49..51, 87..89 のみ開放）
  [6, 116, 17, 119],
  [21, 116, 48, 119],
  [52, 116, 86, 119],
  [90, 116, 98, 119],
  [12, 123, 32, 126], // バックヤード西ループ柱
  [74, 123, 84, 126], // バックヤード東ループ柱

  // スターライト展望モール＆シアターテラス (101..191, 93..133)
  [116, 102, 123, 108], // シアター西中庭
  [142, 104, 150, 110], // ミュージックドーム石庭
  [166, 106, 174, 114], // 展望テラス中庭
];

export type LobbySecretRoom = {
  id: string;
  name: string;
  hint: string;
  riddle: string;
  bounds: readonly [number, number, number, number];
  cx: number;
  cy: number;
};

export const LOBBY_SECRET_ROOMS: readonly LobbySecretRoom[] = [
  {
    id: "vault_smithy",
    name: "東回廊の秘宝金庫室",
    hint: "東回廊リゾートの大きな石壁中庭、展示ケース裏や東ソファ向かいの壁に隙間がある",
    riddle: "「白亜のリゾート中庭に隠された二重壁の奥、金庫の歯車が静かに回る小部屋」",
    bounds: [138, 19, 143, 33],
    cx: 140,
    cy: 26,
  },
  {
    id: "planetarium",
    name: "星読みの隠れプラネタリウム",
    hint: "グランドバザールの南壁、または鍛冶場西回廊の壁をすり抜けられる",
    riddle: "「道具屋台の裏手、暗い石壁の向こうに星々の記録が眠る」",
    bounds: [3, 33, 19, 44],
    cx: 11,
    cy: 39,
  },
  {
    id: "fairy_shrine",
    name: "妖精の森の隠れ祠",
    hint: "東のワンダーランド遊園地・生垣迷路の北東、行き止まりの壁を抜けた先",
    riddle: "「遊園地の迷路の果て、古き鳥居と小さな音楽が精霊を呼ぶ」",
    bounds: [206, 8, 220, 19],
    cx: 213,
    cy: 13,
  },
  {
    id: "curator_archive",
    name: "館長と王家の秘密書庫",
    hint: "アクアリウム迷宮館北側の偽の壁、または遊園地南東の通気口から侵入可能",
    riddle: "「大水槽の北裏、閉ざされた書庫に古の遺物と暗号金庫が隠されている」",
    bounds: [205, 49, 220, 62],
    cx: 212,
    cy: 55,
  },
  {
    id: "backstage_vault",
    name: "怪盗と支配人の隠し金庫室",
    hint: "地下商店街モールの南壁にある3つの偽装壁・タペストリーの先の裏通路の奥",
    riddle: "「賑やかな地下モールの一枚裏、バックヤード迷路の奥に怪盗の秘密基地がある」",
    bounds: [41, 120, 68, 132],
    cx: 54,
    cy: 126,
  },
  {
    id: "vip_club",
    name: "地下VIP秘密クラブ（星屑の隠れラウンジ）",
    hint: "スターライト展望モール南東隅の隠しタペストリー裏にある秘密階段からワープ",
    riddle: "「地上と切り離された漆黒の密室。真紅の幕をくぐった階段の先だけが辿り着く」",
    bounds: [196, 108, 221, 133],
    cx: 209,
    cy: 121,
  },
];

export type LobbyDistrictInfo = {
  id: string;
  name: string;
  areaHint: string;
  cx: number;
  cy: number;
};

export const LOBBY_DISTRICTS: readonly LobbyDistrictInfo[] = [
  { id: "plaza", name: "中央噴水広場", areaHint: "中央 (28,24)", cx: 28, cy: 24 },
  { id: "colosseum", name: "コロッセオ闘技場", areaHint: "北 (28,8)", cx: 28, cy: 8 },
  { id: "gourmet", name: "北西・グルメ夜市通り", areaHint: "北西 (11,12)", cx: 11, cy: 12 },
  { id: "bazaar", name: "グランドバザール", areaHint: "西 (11,24)", cx: 11, cy: 24 },
  { id: "finance", name: "金融・取引街", areaHint: "北東 (48,10)", cx: 48, cy: 10 },
  { id: "casino", name: "モンテカルロ・カジノ", areaHint: "中央東 (45,24)", cx: 45, cy: 24 },
  { id: "smithy", name: "スチーム鍛冶街", areaHint: "中央南 (28,39)", cx: 28, cy: 39 },
  { id: "race", name: "グランド競馬場", areaHint: "北中東 (93,26)", cx: 93, cy: 26 },
  { id: "emerald", name: "エメラルド迷宮庭園", areaHint: "南中 (45,58)", cx: 45, cy: 58 },
  { id: "harbor", name: "ハーバー祭り小路", areaHint: "南西 (32,78)", cx: 32, cy: 78 },
  { id: "resort", name: "東回廊リゾート", areaHint: "東 (140,24)", cx: 140, cy: 24 },
  { id: "royal", name: "ロイヤル迷宮庭園", areaHint: "南中 (80,68)", cx: 80, cy: 68 },
  { id: "guild_town", name: "南東・商業ギルド街", areaHint: "南東 (108,68)", cx: 108, cy: 68 },
  { id: "sunset", name: "サンセット城・屋外劇場", areaHint: "南東 (138,70)", cx: 138, cy: 70 },
  { id: "guild_2f", name: "ギルドモール（擬似2F）", areaHint: "西階段上 (11,56)", cx: 11, cy: 56 },
  {
    id: "wonderland",
    name: "ワンダーランド遊園地＆縁日通り",
    areaHint: "極東・北 (176,26)",
    cx: 176,
    cy: 26,
  },
  {
    id: "atrium",
    name: "デパート中央アトリウム・総合案内",
    areaHint: "極東・中 (174,66)",
    cx: 174,
    cy: 66,
  },
  {
    id: "aquarium",
    name: "アクアリウム＆クリスタル迷宮館",
    areaHint: "極東・東 (206,84)",
    cx: 206,
    cy: 84,
  },
  {
    id: "basement_mall",
    name: "地下商店街・デパート大迷宮モール",
    areaHint: "最南西 (52,104)",
    cx: 52,
    cy: 104,
  },
  {
    id: "starlight",
    name: "スターライト展望モール＆シアターテラス",
    areaHint: "最南東 (146,114)",
    cx: 146,
    cy: 114,
  },
];

const SECRET_PASSAGE_RECTS: readonly [number, number, number, number][] = [
  [136, 25, 138, 27], // 東回廊リゾート西〜秘宝金庫室 抜け道
  [143, 25, 145, 27], // 東回廊リゾート東〜秘宝金庫室 抜け道
  [5, 29, 7, 34], // グランドバザール〜星読みプラネタリウム 抜け道
  [18, 37, 23, 39], // 鍛冶場西回廊〜星読みプラネタリウム 抜け道
  [201, 12, 207, 14], // ワンダーランド迷路〜妖精の隠れ祠 抜け道
  [214, 46, 216, 50], // 遊園地〜秘密書庫 通気口抜け道
  [209, 62, 211, 67], // アクアリウム館〜秘密書庫 裏扉
  [18, 115, 20, 120], // 地下モール西 隠し裏口
  [49, 115, 51, 120], // 地下モール中央 隠し裏口
  [87, 115, 89, 120], // 地下モール東 隠し裏口
  [6, 120, 40, 132], // バックヤード西・地下秘密通路
  [69, 120, 98, 132], // バックヤード東・地下秘密通路
];

export function lobbySecretRoomAt(x: number, y: number): LobbySecretRoom | null {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  for (const room of LOBBY_SECRET_ROOMS) {
    const [x0, y0, x1, y1] = room.bounds;
    if (inRect(x0, y0, x1, y1, tx, ty)) return room;
  }
  return null;
}

export function isSecretPassageTile(x: number, y: number): boolean {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  for (const [x0, y0, x1, y1] of SECRET_PASSAGE_RECTS) {
    if (inRect(x0, y0, x1, y1, tx, ty)) return true;
  }
  return false;
}

/** そのセルがロビーの外形（図形の和集合）に含まれるか。 */
export function inLobbyShape(x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= LOBBY_W || y >= LOBBY_H) return false;
  // ショップ翼2階: ギルドショップ（別領域のサブエリア）
  // （周囲2タイル以上の VOID で 1F と分離）
  if (inRect(2, 48, 19, 63, x, y)) return true;
  if (inRect(0, 46, 21, 66, x, y)) return false;
  // 秘密部屋6「地下VIP秘密クラブ」は周囲 VOID で他エリアと完全分離（ワープ階段専用）
  if (inRect(196, 108, 221, 133, x, y)) return true;
  if (inRect(193, 105, 223, 135, x, y)) return false;
  for (const [x0, y0, x1, y1] of INTERIOR_COURTYARDS) {
    if (inRect(x0, y0, x1, y1, x, y)) return false;
  }
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
  // 取引所ホール（カジノ翼の南の別室）と、カジノ翼からの通路
  if (inRect(EXCHANGE_HALL.x0, EXCHANGE_HALL.y0, EXCHANGE_HALL.x1, EXCHANGE_HALL.y1, x, y)) return true;
  if (inRect(EXCHANGE_CORRIDOR.x0, EXCHANGE_CORRIDOR.y0, EXCHANGE_CORRIDOR.x1, EXCHANGE_CORRIDOR.y1, x, y)) return true;
  // 東: カジノ翼から競馬場への通路と、競馬場エリア
  if (inRect(RACE_CORRIDOR.x0, RACE_CORRIDOR.y0, RACE_CORRIDOR.x1, RACE_CORRIDOR.y1, x, y)) return true;
  if (inRect(RACECOURSE.x0, RACECOURSE.y0, RACECOURSE.x1, RACECOURSE.y1, x, y)) return true;

  // 北西・グルメ夜市通り ＆ アーチ連絡橋
  if (inRect(2, 4, 22, 16, x, y)) return true;
  if (inRect(6, 15, 8, 19, x, y)) return true;
  if (inRect(14, 15, 17, 19, x, y)) return true;
  if (inRect(20, 10, 24, 14, x, y)) return true;

  // 北東・金融取引街 ＆ アーチ連絡橋
  if (inRect(39, 4, 58, 16, x, y)) return true;
  if (inRect(34, 10, 40, 14, x, y)) return true;
  if (inRect(43, 15, 46, 19, x, y)) return true;
  if (inRect(57, 7, 61, 11, x, y)) return true;

  // 鍛冶場ツイン回廊・取引所南〜エメラルド迷宮庭園連絡通路
  if (inRect(22, 36, 25, 49, x, y)) return true;
  if (inRect(31, 36, 34, 49, x, y)) return true;
  if (inRect(45, 45, 49, 49, x, y)) return true;

  // 秘密部屋2「星読みの隠れプラネタリウム」＆ 2方向隠し通路
  if (inRect(3, 33, 19, 44, x, y)) return true;
  if (inRect(5, 29, 7, 34, x, y)) return true;
  if (inRect(18, 37, 23, 39, x, y)) return true;

  // 中央南・エメラルド迷宮庭園
  if (inRect(22, 48, 59, 69, x, y)) return true;

  // 南西・ハーバー祭り小路＆桟橋
  if (inRect(22, 68, 59, 90, x, y)) return true;
  if (inRect(2, 70, 23, 90, x, y)) return true;

  // 東回廊リゾート ＆ 競馬場東ツイン橋（x=125, y=26 の壁は維持）
  if (inRect(127, 6, 154, 47, x, y)) return true;
  if (inRect(124, 12, 128, 16, x, y)) return true;
  if (inRect(124, 34, 128, 38, x, y)) return true;

  // 南東・ロイヤル迷宮・商業広場・サンセット城
  if (inRect(59, 49, 154, 90, x, y)) return true;
  if (inRect(65, 46, 70, 50, x, y)) return true;
  if (inRect(110, 46, 114, 50, x, y)) return true;
  if (inRect(132, 46, 136, 50, x, y)) return true;
  if (inRect(147, 46, 151, 50, x, y)) return true;

  // ===== 新規拡張デパート＆テーマパークウィング =====
  if (inRect(153, 11, 157, 14, x, y)) return true;
  if (inRect(153, 35, 157, 38, x, y)) return true;
  if (inRect(153, 54, 157, 57, x, y)) return true;
  if (inRect(153, 81, 157, 84, x, y)) return true;

  // Wing A: ワンダーランド遊園地＆縁日通り (156..221, 4..47)
  if (inRect(156, 4, 221, 47, x, y)) return true;
  if (inRect(160, 46, 165, 50, x, y)) return true;
  if (inRect(182, 46, 187, 50, x, y)) return true;

  // Wing B: デパート中央アトリウム・総合案内 (156..191, 48..91)
  if (inRect(156, 48, 191, 91, x, y)) return true;

  // Wing C: アクアリウム＆クリスタル迷宮館 (192..221, 48..101)
  if (inRect(192, 48, 221, 101, x, y)) return true;
  if (inRect(190, 70, 194, 74, x, y)) return true;
  if (inRect(190, 84, 194, 88, x, y)) return true;

  // 南連絡ブリッジ (y=89..95)
  if (inRect(22, 89, 25, 95, x, y)) return true;
  if (inRect(55, 89, 58, 95, x, y)) return true;
  if (inRect(94, 89, 98, 95, x, y)) return true;
  if (inRect(121, 89, 124, 95, x, y)) return true;
  if (inRect(146, 89, 150, 95, x, y)) return true;
  if (inRect(171, 89, 176, 95, x, y)) return true;

  // Wing D: 地下商店街・デパート大迷宮モール (4..100, 93..133)
  if (inRect(4, 93, 100, 133, x, y)) return true;

  // Wing E: スターライト展望モール＆シアターテラス (101..191, 93..133)
  if (inRect(101, 93, 191, 133, x, y)) return true;
  if (inRect(189, 95, 194, 99, x, y)) return true;

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
  if (inRect(2, 4, 22, 16, x, y)) floor = y >= 13 ? L_CHECK : L_WOOD;
  if (inRect(39, 4, 58, 16, x, y)) {
    floor = x >= 52 ? L_CHECK : L_DARK;
    if (y <= 6) floor = L_MARBLE;
  }
  if (inRect(37, 18, 53, 30, x, y)) floor = L_CARPET;
  if (inRect(2, 18, 19, 30, x, y)) floor = L_WOOD;
  if (inRect(24, 34, 32, 41, x, y) || inCircle(SMITH_CIRCLE.cx, SMITH_CIRCLE.cy, SMITH_CIRCLE.r, x, y)) floor = L_DARK;
  if (inRect(22, 36, 25, 49, x, y) || inRect(31, 36, 34, 49, x, y)) {
    floor = L_DARK;
  }
  if (inRect(2, 48, 19, 63, x, y)) floor = L_CHECK;
  // 秘密部屋2・隠し通路
  if (inRect(3, 33, 19, 44, x, y) || inRect(5, 29, 7, 34, x, y) || inRect(18, 37, 23, 39, x, y)) {
    floor = inRect(8, 36, 14, 40, x, y) ? L_RING : L_DARK;
  }
  if (inRect(22, 48, 59, 69, x, y)) {
    floor = (x + y) % 8 <= 1 ? L_WOOD : L_PLAZA;
    if (inRect(42, 52, 48, 58, x, y)) floor = L_RING;
  }
  if (inRect(22, 68, 59, 90, x, y)) floor = inRect(36, 81, 45, 89, x, y) ? L_CHECK : L_WOOD;
  if (inRect(2, 70, 23, 90, x, y)) {
    floor = y >= 84 ? L_CHECK : L_WOOD;
    if (inRect(7, 74, 16, 85, x, y) && !inRect(8, 76, 14, 83, x, y)) floor = L_SAND;
  }
  // 競馬場への通路はカジノのカーペットを引き、場内はトラック=砂、内側=広場床
  if (inRect(RACE_CORRIDOR.x0, RACE_CORRIDOR.y0, RACE_CORRIDOR.x1, RACE_CORRIDOR.y1, x, y)) floor = L_CARPET;
  if (inRect(RACECOURSE.x0, RACECOURSE.y0, RACECOURSE.x1, RACECOURSE.y1, x, y)) {
    floor = L_MARBLE;
    if (isRaceInfieldTile(x, y)) floor = L_PLAZA;
    else if (isRaceTrackTile(x, y)) floor = L_SAND;
    if (isRaceInfieldTile(x, y) && inRect(83, 23, 99, 29, x, y) && !inRect(91, 24, 95, 28, x, y)) {
      floor = L_CARPET;
    } else if (!isRaceInfieldTile(x, y) && !isRaceTrackTile(x, y)) {
      if (x <= 70 && y <= 14) floor = L_WOOD;
      else if (x >= 115 && y <= 14) floor = L_CARPET;
    }
  }
  if (inRect(127, 6, 154, 47, x, y)) {
    floor = x >= 147 ? L_WOOD : L_MARBLE;
    if (y <= 14) floor = L_CARPET;
    // 秘密部屋1「東回廊の秘宝金庫室」＆ 2方向隠し通路
    if (inRect(136, 19, 145, 33, x, y)) {
      floor = inRect(139, 24, 142, 28, x, y) ? L_RING : L_DARK;
    }
  }
  if (inRect(59, 49, 154, 90, x, y)) {
    if (x <= 96) {
      floor = inRect(78, 56, 84, 62, x, y) ? L_RING : L_PLAZA;
    } else if (x <= 120) {
      floor = L_CHECK;
    } else {
      floor = y >= 79 ? L_WOOD : L_CARPET;
      if (inRect(131, 79, 137, 85, x, y)) floor = L_RING;
    }
  }
  // ===== 新規ウィング床 =====
  if (inRect(156, 4, 221, 47, x, y)) {
    floor = (x + y) % 6 === 0 ? L_PLAZA : L_CHECK;
    if (inRect(158, 6, 188, 12, x, y)) floor = L_WOOD;
    if (inRect(186, 23, 219, 46, x, y)) floor = L_PLAZA;
    if (inRect(206, 8, 220, 19, x, y)) floor = L_SAND;
  }
  if (inRect(156, 48, 191, 91, x, y)) {
    floor = L_MARBLE;
    if (inRect(169, 61, 178, 69, x, y)) floor = L_RING;
    if (x <= 162 || x >= 184) floor = L_CARPET;
  }
  if (inRect(192, 48, 221, 101, x, y)) {
    floor = inRect(205, 49, 220, 62, x, y) ? L_DARK : L_PLAZA;
    if (inRect(202, 75, 211, 87, x, y)) floor = L_MARBLE;
  }
  if (inRect(4, 93, 100, 133, x, y)) {
    floor = y >= 117 ? L_DARK : L_CHECK;
    if (inRect(44, 96, 53, 106, x, y)) floor = L_RING;
    if (inRect(43, 121, 66, 130, x, y)) floor = L_CARPET;
  }
  if (inRect(101, 93, 191, 133, x, y)) {
    floor = L_CARPET;
    if (inRect(126, 98, 140, 126, x, y)) floor = L_DARK;
    if (inRect(154, 98, 164, 110, x, y)) floor = L_RING;
    if (inRect(172, 98, 186, 114, x, y)) floor = L_MARBLE;
  }
  if (inRect(196, 108, 221, 133, x, y)) {
    floor = inRect(203, 113, 216, 125, x, y) ? L_RING : L_CARPET;
  }
  if (inCircle(PLAZA.cx, PLAZA.cy, PLAZA.r, x, y)) {
    floor = dist2(PLAZA.cx, PLAZA.cy, x, y) <= 100 ? L_PLAZA : L_RING;
  }
  // 取引所ホールと通路はチェック床（広場・カジノと区別する）
  if (inRect(EXCHANGE_HALL.x0, EXCHANGE_HALL.y0, EXCHANGE_HALL.x1, EXCHANGE_HALL.y1, x, y)) floor = L_CHECK;
  if (inRect(EXCHANGE_CORRIDOR.x0, EXCHANGE_CORRIDOR.y0, EXCHANGE_CORRIDOR.x1, EXCHANGE_CORRIDOR.y1, x, y)) floor = L_CHECK;
  if (inRect(45, 45, 49, 49, x, y)) floor = L_CHECK;
  return floor;
}

export function lobbyDistrictAt(x: number, y: number): string {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  const secret = lobbySecretRoomAt(tx, ty);
  if (secret) return `秘密部屋：${secret.name}`;
  if (isSecretPassageTile(tx, ty)) return "秘密の隠し通路";

  if (tx <= 21 && ty >= 46 && ty <= 66) return "ギルドモール（擬似2F）";
  if (inRect(20, 0, 36, 14, tx, ty)) return "コロッセオ闘技場";
  if (inRect(2, 4, 22, 16, tx, ty)) return "北西・グルメ夜市通り";
  if (inRect(2, 17, 19, 31, tx, ty)) return "グランドバザール";
  if (inRect(38, 4, 58, 16, tx, ty)) return "金融・取引街";
  if (inRect(37, 17, 54, 31, tx, ty)) return "モンテカルロ・カジノ";
  if (inRect(EXCHANGE_HALL.x0, EXCHANGE_HALL.y0, EXCHANGE_HALL.x1, EXCHANGE_HALL.y1, tx, ty)) return "金融・取引街";
  if (inRect(22, 34, 36, 48, tx, ty)) return "スチーム鍛冶街";
  if (inRect(60, 4, 125, 47, tx, ty)) {
    return isRaceInfieldTile(tx, ty) ? "競馬場インフィールド庭園" : "グランド競馬場";
  }
  if (inRect(22, 48, 59, 69, tx, ty)) return "エメラルド迷宮庭園";
  if (inRect(2, 68, 59, 90, tx, ty)) return "ハーバー祭り小路";
  if (inRect(126, 6, 154, 48, tx, ty)) return "東回廊リゾート";
  if (inRect(59, 49, 96, 90, tx, ty)) return "ロイヤル迷宮庭園";
  if (inRect(97, 49, 120, 90, tx, ty)) return "南東・商業ギルド街";
  if (inRect(121, 49, 154, 90, tx, ty)) return "サンセット城・屋外劇場";
  if (inRect(155, 4, 222, 48, tx, ty)) return "ワンダーランド遊園地＆縁日通り";
  if (inRect(155, 48, 191, 91, tx, ty)) return "デパート中央アトリウム・総合案内";
  if (inRect(191, 48, 222, 102, tx, ty)) return "アクアリウム＆クリスタル迷宮館";
  if (inRect(4, 92, 100, 134, tx, ty)) return "地下商店街・デパート大迷宮モール";
  if (inRect(101, 92, 194, 134, tx, ty)) return "スターライト展望モール＆シアターテラス";

  return "中央噴水広場";
}

// ---------- オブジェクト配置 ----------

export type LobbyStation = "board" | "shop" | "bank" | "casino" | "arena" | "smith" | "guild" | "fountain" | "rest" | "arcade" | "race" | "sell" | "telescope" | "piano" | "exchange" | "shrine" | "jukebox" | "shooting" | "vault_puzzle" | "stamp" | "archive";

export type LobbyObject = {
  sprite: string;
  x: number;
  y: number;
  w: number;
  h: number;
  solid: boolean;
  station?: LobbyStation;
  /** 店（station "shop"）の品目ジャンル。店員ごとに扱う品目が違う（shops.ts）。 */
  genre?: ShopGenreId;
  /** アーケード筐体（station "arcade"）のゲーム ID（ONLINE_GAMES のキー、arcade.ts）。 */
  arcade?: string;
  /** 隠し通路を覆う偽装壁・本棚・タペストリー（近づくと半透明に透ける）。 */
  secret?: boolean;
};

const objects: LobbyObject[] = [];
const occupied = new Set<string>();

type PutOpts = { w?: number; h?: number; solid?: boolean; station?: LobbyStation; genre?: ShopGenreId };

function put(sprite: string, x: number, y: number, opts: PutOpts & { secret?: boolean } = {}): void {
  const w = opts.w ?? 1;
  const h = opts.h ?? 1;
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const key = `${x + dx},${y + dy}`;
      if (occupied.has(key)) throw new Error(`lobby object overlap at ${key} (${sprite})`);
      occupied.add(key);
    }
  }
  objects.push({ sprite, x, y, w, h, solid: opts.solid ?? true, station: opts.station, genre: opts.genre });
  if (opts.secret) objects[objects.length - 1].secret = true;
}
function row(sprite: string, x0: number, x1: number, y: number, opts: PutOpts = {}): void {
  for (let x = x0; x <= x1; x++) put(sprite, x, y, opts);
}
function col(sprite: string, x: number, y0: number, y1: number, opts: PutOpts = {}): void {
  for (let y = y0; y <= y1; y++) put(sprite, x, y, opts);
}

// --- 中央広場 ---
put("fountain", 27, 23, { w: 3, h: 3, station: "fountain" }); // 噴水（3×3・固体、コイン投げ）
put("telescope", 28, 27, { station: "telescope" }); // 中央広場・噴水の南の望遠鏡
row("bulletin_board", 27, 29, 15, { station: "board" }); // 掲示板は広場の北縁
row("guild_board", 24, 25, 15, { station: "guild" }); // ギルドボードは掲示板の西隣（依頼・役職）
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

// --- 取引所ホール（カジノ翼の南の別室）: アゴトークンの売買 ---
// 北壁沿いの長いカウンターが取引所。係員はカウンター背面（北側）に立つ。
// 南壁の掲示板は価格ボード（飾り、ステーションなし）。
row("shop_counter", 40, 47, 35, { station: "exchange" });
put("vault", 52, 34);
put("sign_board", 37, 34);
put("lamp", 53, 34);
put("lamp", 37, 40);
row("bench", 41, 43, 40);
row("bench", 45, 47, 40);
row("bulletin_board", 38, 40, 45);
put("planter", 37, 45);
put("planter", 53, 45);

// --- ショップ翼（左）: カウンター2列＋店員レーン、什器の間仕切りで小部屋状に ---
// 店ごとに品目ジャンルが違う（左上から 道具屋・建築屋・家具屋・食料屋・種素材屋）。
// 陳列棚・棚は属する店の帯（列）のジャンルを引き継ぐ。
row("shop_counter", 4, 6, 20, { station: "shop", genre: "tools" });
row("shop_counter", 8, 10, 20, { station: "shop", genre: "blocks" });
row("shop_counter", 12, 14, 20, { station: "shop", genre: "furniture" });
row("shop_counter", 4, 6, 27, { station: "shop", genre: "food" });
row("shop_counter", 12, 14, 27, { station: "shop", genre: "farm" });
row("shop_counter", 15, 16, 27, { station: "sell" }); // 売却専用（買取）カウンター: 売るだけの店。かばんを開かずここで売る
put("sign_board", 16, 20);
put("planter", 3, 19);
put("planter", 17, 19);
col("item_shelf", 3, 23, 24, { station: "shop", genre: "tools" });
col("display_case", 7, 23, 24, { station: "shop", genre: "blocks" });
col("display_case", 11, 23, 24, { station: "shop", genre: "blocks" });
row("display_case", 8, 10, 27, { station: "shop", genre: "farm" });
put("sign_board", 9, 26);
row("display_case", 8, 10, 29, { station: "shop", genre: "farm" });
put("crate", 16, 23);
put("crate", 16, 24);
put("barrel", 15, 24);
put("barrel", 3, 29);
put("stairs", 17, 29, { solid: false }); // 2階（ギルドショップ）への階段
put("stairs", 18, 29, { solid: false });

// --- カジノ翼（右）: 1台1ゲーム。北=スロット/セブン列、中央=テーブル3種、南=ダブル列 ---
for (const x of [39, 41, 43]) put("slot_machine", x, 19, { station: "casino" });
for (const x of [46, 48, 50]) put("slot7_machine", x, 19, { station: "casino" });
put("roulette_table", 40, 24, { station: "casino" });
put("dice_table", 44, 24, { station: "casino" });
put("blackjack_table", 48, 24, { station: "casino" });
put("chair", 40, 25);
put("chair", 44, 25);
put("chair", 48, 25);
for (const x of [40, 43, 46]) put("double_machine", x, 29, { station: "casino" });
put("slot_machine", 50, 29, { station: "casino" });
put("table_round", 44, 22);
put("sofa", 51, 24);
put("sofa", 51, 25);
put("table_round", 50, 22);
put("piano", 39, 26, { station: "piano" }); // ロビーのピアノ（弾ける・音はロビー全体に届く）
put("hedge", 44, 21);
put("hedge", 44, 27);
put("planter", 52, 19);
put("lamp", 38, 19);
put("lamp", 52, 29);
put("tapestry", 52, 22, { solid: false });

// --- 競馬場（東・カジノ翼の通路の先）: 楕円トラック＋インフィールドの施設 ---
// 馬券カウンターと結果掲示板はインフィールド西側（通路を抜けて最初に着く側）。
row("shop_counter", 72, 77, 25, { station: "race" }); // 馬券カウンター
row("bulletin_board", 72, 75, 21, { station: "race" }); // 着順・結果の掲示板
put("sign_board", 61, 21, { station: "race" }); // 通路を抜けた先の入口の看板
col("arena_gate", 65, 23, 28); // 西直線のスタートゲート（ランドマーク、固体）
row("bench", 84, 102, 5); // 北側スタンド
put("telescope", 93, 6, { station: "telescope" }); // 北スタンド中央の望遠鏡（トラック観戦用）
row("bench", 84, 102, 46); // 南側スタンド
// パドック（インフィールド東の柵囲い、西側が開口）
row("fence_wood", 104, 111, 22);
row("fence_wood", 104, 111, 30);
col("fence_wood", 111, 23, 29);
put("planter", 107, 26);
put("hedge", 84, 34);
put("hedge", 102, 34);
put("lamp", 61, 5);
put("lamp", 124, 5);
put("lamp", 61, 46);
put("lamp", 124, 46);
// スタンド増設: 東側は縦列（東端の観覧ポイント y26 は空ける）、南側は本列を
// x78〜108 へ延長し、両翼だけ2列目を足す（中央の y45 はスタンド前として空ける）
col("bench", 124, 14, 21); // 東側スタンド（北寄り）
col("bench", 124, 31, 38); // 東側スタンド（南寄り）
row("bench", 78, 83, 46);
row("bench", 103, 108, 46);
row("bench", 78, 83, 45);
row("bench", 103, 108, 45);
// インフィールド南の植栽と小道: 生垣で小道（x87〜99）を挟み、灯りと植木で区切る
row("hedge", 82, 86, 36);
row("hedge", 100, 104, 36);
put("lamp", 93, 34);
put("planter", 90, 34);
put("planter", 96, 34);
put("planter", 89, 38);
put("planter", 97, 38);
// 厩舎（南東アプロンの一角）: 柵囲いに北側の入口（x120〜121）を開ける
put("sign_board", 114, 39); // 厩舎の看板（入口の西）
row("fence_wood", 116, 119, 39);
row("fence_wood", 122, 124, 39);
col("fence_wood", 115, 40, 45);
row("fence_wood", 116, 124, 45);
col("fence_wood", 124, 40, 44);
put("lamp", 116, 40); // 厩舎内の灯り（北西）
put("crate", 116, 44); // 餌・飼料置き場（南西）
put("barrel", 117, 44);
put("fence_wood", 119, 43); // 馬房の仕切り
put("fence_wood", 119, 44);
put("fence_wood", 122, 43);
put("fence_wood", 122, 44);
put("workbench", 123, 40); // 装蹄・手入れ台（北東）
put("planter", 123, 44);

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
  for (const [x0, genre] of [[3, "tools"], [8, "blocks"], [13, "furniture"]] as const) {
    row("shop_counter", x0, x0 + 2, y, { station: "shop", genre });
    put("sign_board", x0 + 3, y);
  }
}
row("bookshelf", 3, 5, 54, { station: "rest" });
row("item_shelf", 8, 10, 54, { station: "shop", genre: "blocks" });
row("bookshelf", 13, 15, 54, { station: "rest" });
put("sofa", 3, 60, { station: "rest" });
put("chair", 4, 60, { station: "rest" });
put("table_round", 4, 61, { station: "rest" });
put("planter", 18, 49);
put("lamp", 3, 49);
put("stairs", 17, 50, { solid: false }); // 本物の2F（ラウンジ）への階段（L2b）。1階への階段と同じ東の階段室の続き
put("stairs", 18, 50, { solid: false });
put("stairs", 17, 62, { solid: false }); // 1階への階段
put("stairs", 18, 62, { solid: false });

// ===== 追加デパート＆テーマパーク装飾・新規ウィング・隠し通路＆秘密部屋 =====
// --- 中央広場・西翼・カジノの追加装飾 ---
for (const [x, y] of [[25, 21], [31, 21], [25, 27], [31, 27]] as const) put("planter", x, y);
put("table_round", 22, 19);
put("chair", 23, 19);
put("bench", 20, 22);
put("table_round", 34, 23);
put("chair", 34, 24);
put("bench", 36, 22);
put("lamp", 24, 24);
put("lamp", 32, 24);
put("lamp", 7, 28);
put("lamp", 18, 22);
put("casino_table", 42, 27, { station: "casino" });
put("casino_table", 48, 27, { station: "casino" });
put("lamp", 38, 28);

// --- 北西・グルメ夜市通り（中庭 9..13, 8..11 を囲む商店街） ---
row("shop_counter", 4, 6, 6, { station: "shop", genre: "food" });
row("shop_counter", 16, 18, 6, { station: "shop", genre: "farm" });
put("sign_board", 15, 6);
put("barrel", 3, 8);
put("crate", 3, 9);
put("sign_board", 7, 8);
put("lamp", 3, 12);
put("table_round", 5, 12);
put("chair", 5, 13);
put("chair", 6, 12);
put("planter", 3, 15);
put("bench", 9, 13);
put("bench", 13, 13);
put("table_round", 11, 14);
put("chair", 10, 14);
put("chair", 12, 14);
put("lamp", 18, 15);
put("planter", 20, 15);
put("vending", 20, 14);
put("hedge", 16, 9);
put("hedge", 17, 9);
put("lamp", 21, 11);
put("planter", 21, 13);

// --- 北東・金融取引街（中庭 46..50, 8..11 を囲む金融回廊） ---
put("bank_counter", 42, 5, { station: "bank" });
put("atm", 43, 5, { station: "bank" });
put("bulletin_board", 45, 5, { station: "board" });
put("sign_board", 48, 5, { station: "board" });
put("bank_counter", 54, 5, { station: "bank" });
put("atm", 55, 5, { station: "bank" });
put("lamp", 40, 5);
put("lamp", 57, 5);
row("bank_counter", 40, 41, 9, { station: "bank" });
put("vault", 40, 10, { station: "bank" });
put("atm", 40, 11, { station: "bank" });
put("pillar", 43, 8);
put("pillar", 43, 12);
put("sofa", 41, 14);
put("table_round", 42, 14);
col("bookshelf", 57, 7, 8, { station: "rest" });
put("table_round", 54, 9);
put("chair", 53, 9);
put("chair", 55, 9);
put("sofa", 56, 12);
put("planter", 52, 14);
put("vending", 57, 15);
put("bench", 47, 13);
put("bench", 49, 13);
put("lamp", 47, 15);
put("lamp", 50, 15);

// --- 競馬場インフィールド庭園＆四隅コーナー ---
row("hedge", 82, 87, 16);
row("hedge", 99, 104, 16);
row("hedge", 87, 90, 19);
row("hedge", 96, 99, 19);
put("planter", 80, 17);
put("planter", 93, 15);
put("planter", 106, 17);
put("bench", 92, 16);
put("bench", 94, 16);
put("table_round", 93, 17);
put("chair", 92, 17);
put("chair", 94, 17);
put("lamp", 85, 18);
put("lamp", 101, 18);
put("pillar", 86, 23);
put("pillar", 100, 23);
put("pillar", 86, 29);
put("pillar", 100, 29);
put("display_case", 89, 23);
put("display_case", 97, 23);
put("display_case", 89, 29);
put("display_case", 97, 29);
put("sofa", 83, 24);
put("sofa", 83, 28);
put("table_round", 84, 26);
put("lamp", 93, 22);
put("lamp", 93, 30);
row("bookshelf", 62, 64, 5, { station: "rest" });
put("sofa", 62, 7);
put("table_round", 63, 7);
row("hedge", 65, 66, 8);
put("vending", 61, 10);
row("shop_counter", 62, 64, 45, { station: "shop", genre: "food" });
row("display_case", 62, 64, 41);
put("lamp", 66, 43);
put("planter", 66, 45);
row("bookshelf", 120, 122, 5, { station: "rest" });
put("sofa", 122, 7);
put("table_round", 121, 7);
row("hedge", 117, 119, 8);
put("planter", 123, 10);

// --- 鍛冶屋ツイン回廊小道具 ---
put("barrel", 23, 41);
put("lamp", 23, 44);
put("planter", 23, 47);
put("crate", 33, 41);
put("lamp", 33, 44);
put("planter", 33, 47);

// --- 中央南・エメラルド迷宮庭園 ---
put("fountain", 44, 54, { w: 3, h: 3, station: "fountain" });
col("hedge", 25, 51, 56);
row("hedge", 25, 29, 60);
col("hedge", 25, 62, 65);
row("hedge", 34, 36, 51);
row("hedge", 34, 38, 55);
col("hedge", 42, 49, 51);
row("hedge", 46, 53, 49);
row("hedge", 31, 36, 65);
row("hedge", 44, 48, 65);
col("hedge", 56, 59, 65);
put("bookshelf", 24, 67, { station: "rest" });
put("sofa", 35, 67);
put("table_round", 36, 67);
put("vending", 57, 60);
put("lamp", 23, 50);
put("lamp", 43, 53);
put("lamp", 47, 58);
put("lamp", 57, 51);
put("planter", 35, 58);
put("planter", 57, 66);
put("bench", 45, 51);
put("bench", 45, 60);

// --- 南西・ハーバー祭り小路＆桟橋 ---
row("shop_counter", 26, 28, 71, { station: "shop", genre: "tools" });
row("shop_counter", 37, 39, 71, { station: "shop", genre: "food" });
row("shop_counter", 54, 55, 71, { station: "sell" });
row("shop_counter", 38, 40, 86, { station: "shop", genre: "furniture" });
put("sign_board", 29, 71);
put("sign_board", 40, 71);
put("crate", 25, 75);
put("barrel", 25, 76);
put("table_round", 27, 84);
put("chair", 26, 84);
put("chair", 28, 84);
put("lamp", 36, 75);
put("lamp", 56, 83);
put("vending", 43, 72);
put("planter", 36, 82);
put("bench", 42, 82);
put("bench", 43, 82);
row("bookshelf", 4, 6, 72, { station: "rest" });
row("display_case", 10, 12, 72);
put("sofa", 17, 72, { station: "rest" });
put("table_round", 18, 72);
put("chair", 19, 72);
put("lamp", 3, 71);
put("lamp", 20, 71);
put("bench", 4, 78);
put("bench", 4, 81);
put("planter", 3, 76);
put("planter", 3, 83);
put("lamp", 3, 80);
put("fountain", 10, 86, { w: 3, h: 3, station: "fountain" });
row("shop_counter", 17, 19, 86, { station: "shop", genre: "blocks" });
put("vending", 5, 88);
put("bench", 15, 88);
put("lamp", 19, 84);

// --- 東回廊リゾート ---
row("shop_counter", 139, 141, 8, { station: "shop", genre: "food" });
row("hedge", 136, 145, 13);
put("table_round", 132, 9);
put("chair", 131, 9);
put("chair", 133, 9);
put("table_round", 149, 9);
put("chair", 148, 9);
put("chair", 150, 9);
put("lamp", 129, 8);
put("lamp", 152, 8);
put("pillar", 130, 18);
put("pillar", 130, 24);
put("pillar", 130, 30);
put("pillar", 130, 36);
put("bench", 128, 21);
put("bench", 128, 29);
col("display_case", 133, 20, 22);
col("bookshelf", 152, 18, 20, { station: "rest" });
put("sofa", 152, 25, { station: "rest" });
put("sofa", 152, 26, { station: "rest" });
put("table_round", 151, 25);
put("bench", 152, 32);
put("lamp", 148, 16);
put("lamp", 148, 36);
row("hedge", 137, 143, 41);
row("bench", 139, 141, 39);
put("vending", 130, 45);
put("planter", 145, 42);

// --- 南東・ロイヤル迷宮・商業ギルド街・サンセット城 ---
put("fountain", 80, 58, { w: 3, h: 3, station: "fountain" });
col("hedge", 63, 52, 60);
col("hedge", 67, 55, 65);
row("hedge", 68, 72, 65);
col("hedge", 80, 52, 55);
row("hedge", 85, 92, 55);
col("hedge", 80, 64, 71);
row("hedge", 71, 76, 70);
row("hedge", 63, 67, 74);
put("lamp", 61, 51);
put("lamp", 79, 57);
put("lamp", 83, 61);
put("lamp", 94, 52);
put("planter", 73, 53);
put("planter", 94, 62);
put("bench", 88, 63);
put("bench", 89, 63);
row("hedge", 62, 66, 77);
row("hedge", 71, 76, 77);
row("hedge", 85, 92, 77);
row("hedge", 60, 65, 88);
row("hedge", 84, 91, 88);
put("table_round", 70, 83);
put("chair", 69, 83);
put("chair", 71, 83);
put("lamp", 68, 78);
put("lamp", 84, 83);
put("planter", 94, 82);
put("sofa", 87, 81, { station: "rest" });
put("table_round", 88, 81);
put("shop_counter", 49, 85, { station: "shop", genre: "farm" });
put("shop_counter", 50, 85, { station: "shop", genre: "farm" });
put("shop_counter", 51, 85, { station: "shop", genre: "farm" });
put("crate", 46, 86);
put("barrel", 47, 86);
put("hedge", 54, 83);
put("hedge", 55, 83);
put("lamp", 54, 87);
put("sign_board", 104, 52, { station: "bank" });
row("bank_counter", 106, 107, 52, { station: "bank" });
put("vault", 108, 52, { station: "bank" });
put("atm", 104, 53, { station: "bank" });
row("shop_counter", 101, 103, 60, { station: "shop", genre: "tools" });
row("shop_counter", 112, 114, 60, { station: "shop", genre: "blocks" });
row("shop_counter", 116, 117, 60, { station: "sell" });
put("sign_board", 100, 60);
put("crate", 100, 68);
put("barrel", 101, 68);
row("display_case", 112, 114, 66);
put("item_shelf", 116, 66);
put("vending", 118, 74);
put("table_round", 104, 72);
put("chair", 103, 72);
put("chair", 105, 72);
put("pillar", 103, 56);
put("pillar", 112, 56);
put("pillar", 103, 64);
put("pillar", 112, 64);
row("hedge", 102, 108, 86);
put("bench", 104, 87);
put("bench", 106, 87);
put("lamp", 99, 52);
put("lamp", 118, 52);
put("lamp", 99, 86);
put("lamp", 118, 86);
put("pillar", 134, 52);
put("pillar", 146, 52);
put("tapestry", 140, 51, { solid: false });
row("bookshelf", 138, 142, 53, { station: "rest" });
put("sofa", 136, 58, { station: "rest" });
put("sofa", 144, 58, { station: "rest" });
put("table_round", 140, 58);
row("display_case", 136, 144, 63);
put("lamp", 132, 52);
put("lamp", 151, 52);
put("pillar", 148, 56);
put("pillar", 148, 62);
put("pillar", 148, 72);
put("pillar", 148, 78);
put("bench", 151, 60);
put("bench", 151, 74);
put("fountain", 133, 81, { w: 3, h: 3, station: "fountain" });
row("bench", 126, 130, 83);
row("bench", 126, 130, 85);
row("bench", 138, 142, 83);
row("bench", 138, 142, 85);
put("lamp", 125, 81);
put("lamp", 144, 81);
put("vending", 151, 87);
put("planter", 148, 66);
put("planter", 148, 84);
row("hedge", 124, 130, 78);
put("table_round", 124, 67);
put("chair", 123, 67);
put("chair", 125, 67);

// --- 秘密部屋1「東回廊の秘宝金庫室」＆ 2方向隠し通路 ---
put("secret_wall", 136, 26, { solid: false, secret: true });
put("secret_wall", 145, 26, { solid: false, secret: true });
put("vault_puzzle", 140, 22, { station: "vault_puzzle" });
put("display_case", 141, 30);
put("lamp", 139, 20);
put("lamp", 142, 32);

// --- 秘密部屋2「星読みの隠れプラネタリウム」＆ 2方向隠し通路 ---
put("secret_wall", 6, 31, { solid: false, secret: true });
put("secret_wall", 20, 38, { solid: false, secret: true });
put("exhibit_pedestal", 11, 38, { station: "archive" });
put("shrine", 6, 36, { station: "shrine" });
col("bookshelf", 17, 35, 37, { station: "rest" });
put("sofa", 15, 41, { station: "rest" });
put("table_round", 14, 41);
put("display_case", 9, 35);
put("display_case", 13, 35);
put("lamp", 5, 41);
put("lamp", 17, 41);

// --- 東翼A：ワンダーランド遊園地＆縁日通り ＆ 秘密部屋3「妖精の森の隠れ祠」 ---
put("shooting_booth", 160, 8, { station: "shooting" });
put("shooting_booth", 173, 8, { station: "shooting" });
put("jukebox", 176, 16, { station: "jukebox" });
put("stamp_desk", 160, 27, { station: "stamp" });
put("fountain", 166, 26, { w: 3, h: 3, station: "fountain" });
row("shop_counter", 185, 187, 8, { station: "shop", genre: "food" });
put("sign_board", 188, 8);
put("table_round", 181, 13);
put("chair", 180, 13);
put("chair", 182, 13);
put("table_round", 186, 13);
put("chair", 185, 13);
put("chair", 187, 13);
put("lamp", 158, 6);
put("lamp", 190, 6);
put("lamp", 158, 43);
put("planter", 162, 13);
put("planter", 172, 22);
put("bench", 165, 32);
put("bench", 168, 32);
put("vending", 175, 42);
col("hedge", 188, 25, 31);
row("hedge", 188, 192, 36);
col("hedge", 204, 26, 34);
row("hedge", 205, 214, 27);
col("hedge", 214, 28, 37);
row("hedge", 205, 211, 39);
put("bench", 210, 32);
put("lamp", 202, 26);
put("lamp", 217, 41);
put("planter", 190, 42);
put("hedge", 200, 13, { solid: false, secret: true });
put("secret_wall", 204, 13, { solid: false, secret: true });
put("shrine", 213, 11, { station: "shrine" });
put("jukebox", 216, 15, { station: "jukebox" });
put("planter", 208, 10);
put("planter", 218, 10);
put("bench", 211, 16);
put("lamp", 208, 17);
put("lamp", 218, 17);

// --- 東翼B：デパート中央アトリウム・総合案内 ---
put("stamp_desk", 171, 63, { station: "stamp" });
put("exhibit_pedestal", 175, 63, { station: "archive" });
put("jukebox", 173, 52, { station: "jukebox" });
row("bank_counter", 159, 160, 52, { station: "bank" });
put("vault", 161, 52, { station: "bank" });
put("atm", 162, 52, { station: "bank" });
row("shop_counter", 183, 185, 52, { station: "shop", genre: "tools" });
row("shop_counter", 159, 161, 80, { station: "shop", genre: "furniture" });
row("shop_counter", 183, 185, 80, { station: "shop", genre: "blocks" });
row("shop_counter", 169, 170, 86, { station: "sell" });
put("sign_board", 172, 65);
put("pillar", 162, 63);
put("pillar", 184, 63);
put("pillar", 162, 74);
put("pillar", 184, 74);
put("sofa", 160, 67, { station: "rest" });
put("sofa", 186, 67, { station: "rest" });
put("table_round", 161, 67);
put("table_round", 185, 67);
put("display_case", 172, 57);
put("display_case", 174, 57);
put("vending", 188, 61);
put("planter", 169, 53);
put("planter", 177, 53);
put("lamp", 158, 61);
put("lamp", 188, 76);

// --- 東翼C：アクアリウム＆クリスタル迷宮館 ＆ 秘密部屋4「館長と王家の秘密書庫」 ---
put("secret_wall", 215, 48, { solid: false, secret: true });
put("secret_wall", 210, 64, { solid: false, secret: true });
put("vault_puzzle", 212, 53, { station: "vault_puzzle" });
put("exhibit_pedestal", 208, 53, { station: "archive" });
put("exhibit_pedestal", 216, 53, { station: "archive" });
row("bookshelf", 207, 208, 59, { station: "rest" });
put("display_case", 217, 59);
put("lamp", 207, 51);
put("lamp", 218, 57);
put("exhibit_pedestal", 196, 54, { station: "archive" });
put("sofa", 195, 59, { station: "rest" });
put("lamp", 199, 53);
put("fountain", 205, 89, { w: 3, h: 3, station: "fountain" });
put("shooting_booth", 215, 70, { station: "shooting" });
put("jukebox", 215, 95, { station: "jukebox" });
put("exhibit_pedestal", 197, 73, { station: "archive" });
put("exhibit_pedestal", 215, 81, { station: "archive" });
col("display_case", 197, 78, 82);
col("display_case", 214, 75, 78);
put("pillar", 201, 72);
put("pillar", 211, 72);
put("pillar", 201, 89);
put("pillar", 211, 89);
put("bench", 197, 94);
put("lamp", 194, 69);
put("lamp", 218, 89);
put("planter", 212, 96);

// --- 南翼D＆E：地下大迷宮モール ＋ バックヤード秘密領域 ＋ スターライト展望 ＋ 秘密VIPクラブ ---
put("fountain", 47, 99, { w: 3, h: 3, station: "fountain" });
put("jukebox", 13, 102, { station: "jukebox" });
put("shooting_booth", 31, 100, { station: "shooting" });
put("shooting_booth", 81, 100, { station: "shooting" });
put("stamp_desk", 48, 104, { station: "stamp" });
put("exhibit_pedestal", 63, 101, { station: "archive" });
row("shop_counter", 8, 10, 96, { station: "shop", genre: "food" });
row("shop_counter", 29, 31, 96, { station: "shop", genre: "tools" });
row("shop_counter", 59, 61, 96, { station: "shop", genre: "furniture" });
row("shop_counter", 78, 80, 96, { station: "shop", genre: "blocks" });
row("shop_counter", 88, 89, 109, { station: "sell" });
put("table_round", 11, 109);
put("chair", 10, 109);
put("chair", 12, 109);
put("table_round", 28, 109);
put("chair", 27, 109);
put("chair", 29, 109);
put("sofa", 54, 109, { station: "rest" });
put("sofa", 56, 109, { station: "rest" });
put("vending", 96, 103);
put("planter", 44, 97);
put("planter", 52, 97);
put("lamp", 6, 95);
put("lamp", 44, 113);
put("lamp", 96, 95);

// 秘密部屋5「怪盗と支配人の隠し金庫室」＆ 3つの偽装裏通路
put("secret_wall", 19, 117, { solid: false, secret: true });
put("tapestry", 50, 117, { solid: false, secret: true });
put("bookshelf", 88, 117, { solid: false, secret: true });
put("vault_puzzle", 54, 125, { station: "vault_puzzle" });
put("shooting_booth", 46, 123, { station: "shooting" });
put("jukebox", 62, 123, { station: "jukebox" });
put("shrine", 54, 129, { station: "shrine" });
put("display_case", 46, 128);
put("display_case", 62, 128);
put("crate", 8, 122);
put("barrel", 9, 122);
put("crate", 35, 128);
put("barrel", 36, 128);
put("crate", 72, 129);
put("lamp", 10, 129);
put("lamp", 43, 121);
put("lamp", 65, 121);
put("lamp", 90, 129);

// Wing E: スターライト展望モール＆シアターテラス
put("fountain", 110, 117, { w: 3, h: 3, station: "fountain" });
put("jukebox", 132, 104, { station: "jukebox" });
put("shrine", 158, 104, { station: "shrine" });
put("exhibit_pedestal", 131, 121, { station: "archive" });
put("exhibit_pedestal", 135, 121, { station: "archive" });
put("stamp_desk", 177, 103, { station: "stamp" });
put("shooting_booth", 180, 120, { station: "shooting" });
row("shop_counter", 107, 109, 97, { station: "shop", genre: "food" });
row("shop_counter", 160, 162, 127, { station: "shop", genre: "furniture" });
put("sofa", 128, 104, { station: "rest" });
put("sofa", 136, 104, { station: "rest" });
row("bench", 154, 156, 114);
row("bench", 159, 161, 114);
put("table_round", 177, 108);
put("chair", 176, 108);
put("chair", 178, 108);
put("vending", 187, 102);
put("planter", 125, 120);
put("planter", 142, 120);
put("lamp", 105, 96);
put("lamp", 155, 96);
put("lamp", 187, 118);
put("lamp", 126, 129);
put("tapestry", 187, 126, { solid: false, secret: true });
put("tapestry", 188, 126, { solid: false, secret: true });
put("stairs", 187, 127, { solid: false });
put("stairs", 188, 127, { solid: false });

// 秘密部屋6「地下VIP秘密クラブ（星屑の隠れラウンジ）」
put("vault_puzzle", 203, 113, { station: "vault_puzzle" });
put("jukebox", 209, 113, { station: "jukebox" });
put("shrine", 215, 113, { station: "shrine" });
put("exhibit_pedestal", 209, 120, { station: "archive" });
put("shooting_booth", 203, 122, { station: "shooting" });
put("stamp_desk", 215, 122, { station: "stamp" });
put("sofa", 207, 125, { station: "rest" });
put("sofa", 211, 125, { station: "rest" });
put("table_round", 209, 125);
put("display_case", 200, 116);
put("display_case", 218, 116);
put("planter", 199, 110);
put("planter", 218, 110);
put("lamp", 199, 127);
put("lamp", 218, 127);
put("stairs", 199, 130, { solid: false });
put("stairs", 200, 130, { solid: false });

export const LOBBY_OBJECTS: readonly LobbyObject[] = objects;

/** 店員NPC（あごむに）が立つタイル。カウンターの背面で、当たり判定なし。 */
export const LOBBY_NPCS: readonly { x: number; y: number }[] = [
  { x: 5, y: 19 }, { x: 9, y: 19 }, { x: 13, y: 19 }, // 北カウンターの店員レーン
  { x: 5, y: 28 }, { x: 13, y: 28 }, { x: 15, y: 28 }, // 南カウンターの店員レーン（15 は買取カウンター）
  { x: 74, y: 24 }, // 競馬場の馬券カウンターの係員レーン
  { x: 42, y: 34 }, { x: 45, y: 34 }, // 取引所ホールの係員レーン
  { x: 5, y: 5 }, // 北西・グルメ夜市（西屋台）
  { x: 17, y: 5 }, // 北西・グルメ夜市（東屋台）
  { x: 63, y: 46 }, // 競馬場南西スーベニア屋台
  { x: 27, y: 70 }, // ハーバー祭り小路・道具屋台
  { x: 38, y: 70 }, // ハーバー祭り小路・グルメ屋台
  { x: 54, y: 70 }, // ハーバー祭り小路・買取所
  { x: 39, y: 87 }, // ハーバー祭り小路・家具屋台
  { x: 18, y: 87 }, // ハーバー桟橋・ブロック屋台
  { x: 50, y: 84 }, // ハーバー南・青果屋台
  { x: 140, y: 7 }, // 東回廊リゾート・ティーカフェ
  { x: 102, y: 59 }, // 南東商業街・道具店
  { x: 113, y: 59 }, // 南東商業街・ブロック店
  { x: 116, y: 59 }, // 南東商業街・買取窓口
  { x: 186, y: 7 }, // ワンダーランド縁日・グルメ屋台
  { x: 184, y: 51 }, // デパートアトリウム・道具ブティック
  { x: 160, y: 81 }, // デパートアトリウム・家具ブティック
  { x: 184, y: 81 }, // デパートアトリウム・ブロックブティック
  { x: 169, y: 87 }, // デパートアトリウム・総合買取
  { x: 9, y: 95 }, // 地下モール・フードコート
  { x: 30, y: 95 }, // 地下モール・道具店
  { x: 60, y: 95 }, // 地下モール・家具店
  { x: 79, y: 95 }, // 地下モール・ブロック店
  { x: 88, y: 110 }, // 地下モール・買取窓口
  { x: 108, y: 96 }, // スターライトテラス・カフェ
  { x: 161, y: 128 }, // スターライトテラス・インテリアショップ
];

/** ロビー入場地点（ワープパッドの北、広場側）。 */
export const LOBBY_ENTRY = { x: 28.5, y: 32.5 };
/** ロビーのワープパッド（タイル座標）。ワールド→ロビーは ≡ メニューから。 */
export const LOBBY_WARP_PAD = { x: 28, y: 34 };
/** 1階の階段タイル（踏むと2階へ）。 */
export const LOBBY_STAIRS_UP: readonly { x: number; y: number }[] = [{ x: 17, y: 29 }, { x: 18, y: 29 }];
/** 2階の階段タイル（踏むと1階へ）。 */
export const LOBBY_STAIRS_DOWN: readonly { x: number; y: number }[] = [{ x: 17, y: 62 }, { x: 18, y: 62 }];
/** 階段を上がった先の着地点。 */
export const LOBBY_UP_LANDING = { x: 17.5, y: 60.5 };
/** 階段を下りた先の着地点。 */
export const LOBBY_DOWN_LANDING = { x: 17.5, y: 27.5 };
/** 本物の2F（ラウンジ、空間 "lobby2"）への階段タイル（ギルドショップ区画の北東）。 */
export const LOBBY_STAIRS_2F: readonly { x: number; y: number }[] = [{ x: 17, y: 50 }, { x: 18, y: 50 }];
/** 2F から下りてきた先の着地点（LOBBY_STAIRS_2F の南隣）。 */
export const LOBBY_2F_LANDING = { x: 17.5, y: 51.5 };
/** 秘密部屋6（地下VIP秘密クラブ）への隠し階段（スターライト南東・タペストリー裏）。 */
export const LOBBY_SECRET_STAIRS_IN: readonly { x: number; y: number }[] = [{ x: 187, y: 127 }, { x: 188, y: 127 }];
/** 地下VIP秘密クラブからの帰り階段。 */
export const LOBBY_SECRET_STAIRS_OUT: readonly { x: number; y: number }[] = [{ x: 199, y: 130 }, { x: 200, y: 130 }];
/** 地下VIP秘密クラブへの着地点。 */
export const LOBBY_SECRET_IN_LANDING = { x: 199.5, y: 128.5 };
/** スターライト展望モールへの帰り着地点。 */
export const LOBBY_SECRET_OUT_LANDING = { x: 187.5, y: 125.5 };

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
    for (let dy = 0; dy < o.h; dy++) {
      for (let dx = 0; dx < o.w; dx++) {
        const tx = o.x + dx;
        const ty = o.y + dy;
        const t = lobbyTileAt(tiles, tx, ty);
        if (t === L_WALL || t === L_VOID) {
          throw new Error(`lobby object on wall/void at ${tx},${ty} (${o.sprite})`);
        }
      }
    }
    if (!o.solid) continue;
    // 座席（ベンチ・椅子・ソファ）は上に乗って座るため固体にしない
    // （ワールドの設置家具＝facility が非固体なのと同じ扱い）。
    if (isSeatSprite(o.sprite)) continue;
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
    moveMap: tilesSource(0, LOBBY_W, LOBBY_H, moveTiles),
  };
  return cached;
}

/**
 * タイルとオブジェクトの接し方: 1 = 辺で接する（正面）, 2 = 角で接する,
 * 0 = 接していない。判定は従来どおりチェビシェフ距離1以内。
 * 複数の施設に接する位置では「正面」を優先する（角で接するだけの施設が
 * 正面の施設を奪わない。例: 3F で筐体の角と休憩ソファの正面が重なる位置）。
 */
function stationMatchTier(o: LobbyObject, tx: number, ty: number): 0 | 1 | 2 {
  const inX = tx >= o.x && tx < o.x + o.w;
  const inY = ty >= o.y && ty < o.y + o.h;
  if (inX && (ty === o.y - 1 || ty === o.y + o.h)) return 1;
  if (inY && (tx === o.x - 1 || tx === o.x + o.w)) return 1;
  if (tx >= o.x - 1 && tx <= o.x + o.w && ty >= o.y - 1 && ty <= o.y + o.h) return 2;
  return 0;
}

/** プレイヤーのタイルに隣接（チェビシェフ距離1以内）するステーション。無ければ null。 */
export function stationNear(objectsList: readonly LobbyObject[], tx: number, ty: number): LobbyStation | null {
  let diagonal: LobbyStation | null = null;
  for (const o of objectsList) {
    if (!o.station) continue;
    const tier = stationMatchTier(o, tx, ty);
    if (tier === 1) return o.station;
    if (tier === 2 && diagonal === null) diagonal = o.station;
  }
  return diagonal;
}

/**
 * プレイヤーのタイルに隣接する店（station "shop"）の品目ジャンル。
 * 店に接していない／接した店がジャンルを持たなければ null。
 * カウンターが陳列棚より先に並ぶため、両方に接する位置ではカウンターの
 * ジャンルが返る（棚のジャンルはカウンターの帯と一致させてある）。
 */
/**
 * プレイヤーのタイルに隣接するアーケード筐体（station "arcade"）のゲーム ID。
 * 筐体に接していない／接した筐体がゲーム ID を持たなければ null。
 */
export function stationArcadeNear(objectsList: readonly LobbyObject[], tx: number, ty: number): string | null {
  let diagonal: string | null = null;
  for (const o of objectsList) {
    if (o.station !== "arcade" || !o.arcade) continue;
    const tier = stationMatchTier(o, tx, ty);
    if (tier === 1) return o.arcade;
    if (tier === 2 && diagonal === null) diagonal = o.arcade;
  }
  return diagonal;
}

export function stationGenreNear(objectsList: readonly LobbyObject[], tx: number, ty: number): ShopGenreId | null {
  let diagonal: ShopGenreId | null = null;
  for (const o of objectsList) {
    if (o.station !== "shop" || !o.genre) continue;
    const tier = stationMatchTier(o, tx, ty);
    if (tier === 1) return o.genre;
    if (tier === 2 && diagonal === null) diagonal = o.genre;
  }
  return diagonal;
}
