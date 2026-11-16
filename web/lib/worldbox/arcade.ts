// AGO WORLD BOX ロビーのアーケード筐体レジストリ（純粋ロジック、DOM 非依存）。
// 移植の正は web/lib/online/registry.ts の ONLINE_GAMES 26タイトル。
// このファイルは「どのタイトルをどの区分・どの順で筐体化するか」のデータだけを持つ。
// 人数・タイトルは registry 側（各ゲームモジュール）が正で、ここでは重複して持たない。
// ネットコードは作らない（既存の OnlineShell / useOnlineRoom のルーム基盤に載せる）。
// 筐体スプライトは L3/L6 で作成済み（web/public/img/worldbox/lobby/arcade_<id>.png、
// textures.ts の LOBBY_SPRITE_SRC に登録）。第1弾の配置は lobby-floors.ts の 2F 北弧、
// 第2弾は 2F 南弧＋3F 西弧・東弧・南弧・北デッキ（26タイトル全て）。
// 起動導線は L4/L4b で配線済み: 筐体は station "arcade" を持ち、前のプレイヤーには
// WorldBoxArcadePanel（筐体画面）が出て、ゲーム本体を WORLD BOX の中でそのまま
// 遊べる（ゲームページへは遷移しない。ゲーム本体は arcade-clients.tsx が遅延読込）。
// 経済: アーケードの対戦に AGO コインを賭ける機能は入れない（案Bのみ・ミント禁止）。

/** 筐体の区分。移植の優先順は faceoff → party → realtime。 */
export type ArcadeCategory = "faceoff" | "party" | "realtime";

export type ArcadeEntry = {
  /** ONLINE_GAMES のキーと一致（reversi 等）。 */
  id: string;
  category: ArcadeCategory;
  /** 区分内での移植順（1 から連番。小さいほど先）。 */
  order: number;
  /** 筐体スプライト名（web/public/img/worldbox/lobby/<sprite>.png）。 */
  sprite: string;
};

const entry = (id: string, category: ArcadeCategory, order: number): ArcadeEntry => ({
  id,
  category,
  order,
  sprite: `arcade_${id}`,
});

export const ARCADE_GAMES: readonly ArcadeEntry[] = [
  // 対面2人で完結し観戦が絵になるもの（盤面対戦・2人固定）
  entry("reversi", "faceoff", 1),
  entry("connect4", "faceoff", 2),
  entry("battleship", "faceoff", 3),
  entry("territory", "faceoff", 4),
  // パーティ大人数（ターン制・多人数）
  entry("werewolf", "party", 1),
  entry("wordwolf", "party", 2),
  entry("majority", "party", 3),
  entry("drawguess", "party", 4),
  entry("daifugo", "party", 5),
  entry("babanuki", "party", 6),
  entry("quizbattle", "party", 7),
  entry("bombpass", "party", 8),
  entry("shiritori", "party", 9),
  entry("nanja", "party", 10),
  entry("liarsdice", "party", 11),
  entry("cheat", "party", 12),
  entry("hagetaka", "party", 13),
  entry("burst", "party", 14),
  entry("texas", "party", 15),
  entry("countdown", "party", 16),
  entry("musicalchairs", "party", 17),
  entry("wordbasket", "party", 18),
  // リアルタイム（同時進行・時間勝負）
  entry("speed", "realtime", 1),
  entry("typerace", "realtime", 2),
  entry("calcrace", "realtime", 3),
  entry("stopbattle", "realtime", 4),
];

/** L3 で筐体を置く第1弾（対面3＋パーティ3）。 */
export const ARCADE_FIRST_WAVE: readonly string[] = [
  "reversi",
  "connect4",
  "battleship",
  "werewolf",
  "wordwolf",
  "majority",
];

/**
 * L6 で筐体を置く第2弾（残り20タイトル・全て）。並びは ARCADE_GAMES の
 * 区分・order 順（faceoff の残り → party の残り → realtime）。
 * 配置: 2F 南弧に先頭6台、3F 西弧・東弧・南弧・北デッキに残り14台。
 */
export const ARCADE_SECOND_WAVE: readonly string[] = [
  "territory",
  "drawguess",
  "daifugo",
  "babanuki",
  "quizbattle",
  "bombpass",
  "shiritori",
  "nanja",
  "liarsdice",
  "cheat",
  "hagetaka",
  "burst",
  "texas",
  "countdown",
  "musicalchairs",
  "wordbasket",
  "speed",
  "typerace",
  "calcrace",
  "stopbattle",
];

/** 第2弾のうち 2F 南弧（y=19）に置く6台。前に立つのは北側 y=18（円の中心側）。 */
export const ARCADE_SECOND_WAVE_2F: readonly string[] = [
  "territory",
  "drawguess",
  "daifugo",
  "babanuki",
  "quizbattle",
  "bombpass",
];

/** 第2弾のうち 3F に置く14台（西弧4・東弧4・南弧4・北デッキ2）。 */
export const ARCADE_SECOND_WAVE_3F: readonly string[] = [
  "shiritori",
  "nanja",
  "liarsdice",
  "cheat",
  "hagetaka",
  "burst",
  "texas",
  "countdown",
  "musicalchairs",
  "wordbasket",
  "speed",
  "typerace",
  "calcrace",
  "stopbattle",
];

export function arcadeById(id: string): ArcadeEntry | undefined {
  if (typeof id !== "string") return undefined;
  return ARCADE_GAMES.find((e) => e.id === id);
}

export function arcadeByCategory(category: ArcadeCategory): ArcadeEntry[] {
  return ARCADE_GAMES.filter((e) => e.category === category).sort((a, b) => a.order - b.order);
}
