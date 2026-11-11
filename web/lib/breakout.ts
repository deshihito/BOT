// ブロック崩しの純粋ロジック（UI 非依存）。
// ブロック配置生成・レベル定義・スコア計算など、描画や物理ループに
// 依存しない部分をここに寄せる。状態は JSON 化可能な値のみ。

export type BreakoutBrick = {
  row: number;
  col: number;
  /** 論理座標（フィールド 800x520 前提のピクセル矩形）。 */
  x: number;
  y: number;
  w: number;
  h: number;
  hp: number;
  maxHp: number;
  color: string;
  points: number;
  alive: boolean;
};

export type BreakoutLevelDef = {
  level: number;
  name: string;
  /** 1文字1ブロック。"." は空き、数字は耐久値。 */
  pattern: string[];
  ballSpeed: number;
  paddleWidth: number;
};

export const BREAKOUT_FIELD_W = 800;
export const BREAKOUT_FIELD_H = 520;
export const BREAKOUT_BRICK_TOP = 56;
export const BREAKOUT_BRICK_GAP = 4;
export const BREAKOUT_BRICK_H = 20;

const ROW_COLORS = ["#e85d4a", "#f08a2e", "#e8c832", "#4db56a", "#3f8fd2", "#7c5cff", "#d24da0", "#3fb5a8"];

export const BREAKOUT_LEVELS: BreakoutLevelDef[] = [
  {
    level: 1,
    name: "レベル1",
    pattern: [
      "1111111111",
      "1111111111",
      "1111111111",
      "1111111111",
      "1111111111",
    ],
    ballSpeed: 320,
    paddleWidth: 120,
  },
  {
    level: 2,
    name: "レベル2",
    pattern: [
      "1111111111",
      "1........1",
      "1222222221",
      "1222222221",
      "1........1",
      "1111111111",
    ],
    ballSpeed: 360,
    paddleWidth: 112,
  },
  {
    level: 3,
    name: "レベル3",
    pattern: [
      "....11....",
      "...1221...",
      "..123321..",
      ".12333321.",
      "12333333321".slice(0, 10),
      "1111111111",
      "2.2.22.2.2",
    ],
    ballSpeed: 400,
    paddleWidth: 104,
  },
];

/** 行に応じたブロック1個の得点。上の行ほど高い。 */
export function scoreForBrick(row: number, totalRows: number): number {
  const fromTop = Math.max(0, totalRows - 1 - row);
  return 10 + fromTop * 10;
}

export function brickColor(row: number): string {
  return ROW_COLORS[row % ROW_COLORS.length];
}

/** レベル定義からブロック配置を生成する。 */
export function bricksForLevel(levelIndex: number): BreakoutBrick[] {
  const def = BREAKOUT_LEVELS[levelIndex] ?? BREAKOUT_LEVELS[0];
  const rows = def.pattern.length;
  const cols = Math.max(...def.pattern.map((r) => r.length));
  const usableW = BREAKOUT_FIELD_W - 32;
  const bw = (usableW - BREAKOUT_BRICK_GAP * (cols - 1)) / cols;
  const bricks: BreakoutBrick[] = [];
  def.pattern.forEach((line, row) => {
    [...line].forEach((ch, col) => {
      if (ch === "." || ch === " ") return;
      const hp = Number.parseInt(ch, 10);
      if (!Number.isFinite(hp) || hp <= 0) return;
      bricks.push({
        row,
        col,
        x: 16 + col * (bw + BREAKOUT_BRICK_GAP),
        y: BREAKOUT_BRICK_TOP + row * (BREAKOUT_BRICK_H + BREAKOUT_BRICK_GAP),
        w: bw,
        h: BREAKOUT_BRICK_H,
        hp,
        maxHp: hp,
        color: brickColor(row),
        points: scoreForBrick(row, rows) * hp,
        alive: true,
      });
    });
  });
  return bricks;
}

/** レベルの最大スコア（全ブロック破壊時）。 */
export function levelMaxScore(levelIndex: number): number {
  return bricksForLevel(levelIndex).reduce((sum, b) => sum + b.points, 0);
}

export function aliveBrickCount(bricks: BreakoutBrick[]): number {
  return bricks.filter((b) => b.alive).length;
}

export function isBreakoutCleared(bricks: BreakoutBrick[]): boolean {
  return bricks.length > 0 && bricks.every((b) => !b.alive);
}

/**
 * ブロックに1ダメージ与える。破壊されたら破壊扱いと得点を返す。
 * 元の配列は変更しない。
 */
export function damageBrick(
  bricks: BreakoutBrick[],
  index: number,
): { bricks: BreakoutBrick[]; destroyed: boolean; gained: number } {
  const target = bricks[index];
  if (!target || !target.alive) return { bricks, destroyed: false, gained: 0 };
  const next = bricks.map((b, i) => (i === index ? { ...b, hp: b.hp - 1, alive: b.hp - 1 > 0 } : b));
  const destroyed = next[index].hp <= 0;
  return { bricks: next, destroyed, gained: destroyed ? target.points : 0 };
}

/** 次レベルがあるか。 */
export function hasNextLevel(levelIndex: number): boolean {
  return levelIndex + 1 < BREAKOUT_LEVELS.length;
}
