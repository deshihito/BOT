// アクションゲーム3本のロジック検証（lib のみ、UI 非依存）。
// - lib/snake.ts: 初期状態・進行・食事/成長・壁/自分衝突・方向反転防止・速度段階
// - lib/breakout.ts: 配置生成・レベル定義・得点・ダメージ/破壊・クリア判定
// - lib/mole.ts: スケジュール・種別・コンボ得点・出現間隔
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const libDir = path.join(import.meta.dirname, "..", "lib");

async function loadLib(name) {
  const src = fs.readFileSync(path.join(libDir, name), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

const snake = await loadLib("snake.ts");
const breakout = await loadLib("breakout.ts");
const mole = await loadLib("mole.ts");

// ---------------- snake ----------------

test("スネーク: 初期状態は長さ3・ready・餌が蛇の上に無い", () => {
  const s = snake.createSnakeGame(20, 20, 42);
  assert.equal(s.snake.length, 3);
  assert.equal(s.status, "ready");
  assert.equal(s.score, 0);
  assert.ok(s.food);
  assert.ok(!s.snake.some((p) => p.x === s.food.x && p.y === s.food.y));
});

test("スネーク: 同じシードでは同じ餌位置になる", () => {
  const a = snake.createSnakeGame(20, 20, 7);
  const b = snake.createSnakeGame(20, 20, 7);
  assert.deepEqual(a.food, b.food);
  assert.deepEqual(a.snake, b.snake);
});

test("スネーク: playing で tick すると頭が進行方向へ1マス進み長さは変わらない", () => {
  let s = snake.createSnakeGame(20, 20, 1);
  s = snake.startSnake(s);
  const head = s.snake[0];
  s = snake.tickSnake(s);
  assert.equal(s.snake.length, 3);
  assert.equal(s.snake[0].x, head.x + 1); // 初期方向は right
  assert.equal(s.snake[0].y, head.y);
});

test("スネーク: ready のまま tick しても動かない", () => {
  const s = snake.createSnakeGame(20, 20, 1);
  assert.equal(snake.tickSnake(s), s);
});

test("スネーク: 真逆への方向転換は無効", () => {
  let s = snake.createSnakeGame(20, 20, 1);
  s = snake.startSnake(s); // dir = right
  const after = snake.setSnakeDirection(s, "left");
  assert.equal(after.pendingDir, "right");
  const ok = snake.setSnakeDirection(s, "up");
  assert.equal(ok.pendingDir, "up");
});

test("スネーク: 壁にぶつかると gameover", () => {
  let s = snake.createSnakeGame(5, 5, 3);
  // 頭を右端へ寄せた状態を手組みする（純粋関数の検証用）
  s = {
    ...s,
    status: "playing",
    dir: "right",
    pendingDir: "right",
    snake: [
      { x: 4, y: 2 },
      { x: 3, y: 2 },
      { x: 2, y: 2 },
    ],
    food: { x: 0, y: 0 },
  };
  s = snake.tickSnake(s);
  assert.equal(s.status, "gameover");
});

test("スネーク: 自分の体にぶつかると gameover（末尾の離れるマスは除く）", () => {
  let s = snake.createSnakeGame(10, 10, 3);
  s = {
    ...s,
    status: "playing",
    dir: "down",
    pendingDir: "down",
    // U字: 頭 (2,2) の下 (2,3) は体（末尾ではない）
    snake: [
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 3, y: 3 },
      { x: 2, y: 3 },
      { x: 1, y: 3 },
    ],
    food: { x: 9, y: 9 },
  };
  s = snake.tickSnake(s);
  assert.equal(s.status, "gameover");
});

test("スネーク: 餌を食べると長さ+1・得点・foodsEaten が増え、新しい餌が出る", () => {
  let s = snake.createSnakeGame(10, 10, 5);
  s = {
    ...s,
    status: "playing",
    dir: "right",
    pendingDir: "right",
    snake: [
      { x: 5, y: 5 },
      { x: 4, y: 5 },
      { x: 3, y: 5 },
    ],
    food: { x: 6, y: 5 },
  };
  const before = s.score;
  s = snake.tickSnake(s);
  assert.equal(s.snake.length, 4);
  assert.equal(s.snake[0].x, 6);
  assert.equal(s.foodsEaten, 1);
  assert.ok(s.score > before);
  assert.ok(s.food);
  assert.ok(!s.snake.some((p) => p.x === s.food.x && p.y === s.food.y));
});

test("スネーク: ポーズ切替と速度段階（5個ごとに速くなる）", () => {
  let s = snake.startSnake(snake.createSnakeGame(20, 20, 1));
  s = snake.pauseSnake(s);
  assert.equal(s.status, "paused");
  s = snake.pauseSnake(s);
  assert.equal(s.status, "playing");
  assert.equal(snake.snakeSpeedLevel({ foodsEaten: 0 }), 0);
  assert.equal(snake.snakeSpeedLevel({ foodsEaten: 5 }), 1);
  assert.ok(snake.snakeIntervalMs({ foodsEaten: 10 }) < snake.snakeIntervalMs({ foodsEaten: 0 }));
  assert.ok(snake.snakeIntervalMs({ foodsEaten: 999 }) >= 70);
});

test("スネーク: 状態は JSON 化できる", () => {
  const s = snake.createSnakeGame(20, 20, 9);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

// ---------------- breakout ----------------

test("ブロック崩し: 全レベルにブロックがあり矩形がフィールド内にある", () => {
  assert.equal(breakout.BREAKOUT_LEVELS.length, 3);
  for (let lvl = 0; lvl < breakout.BREAKOUT_LEVELS.length; lvl++) {
    const bricks = breakout.bricksForLevel(lvl);
    assert.ok(bricks.length > 0, `level ${lvl}`);
    for (const b of bricks) {
      assert.ok(b.x >= 0 && b.x + b.w <= breakout.BREAKOUT_FIELD_W, `x in field lv${lvl}`);
      assert.ok(b.y >= 0 && b.y + b.h <= breakout.BREAKOUT_FIELD_H, `y in field lv${lvl}`);
      assert.ok(b.hp >= 1 && b.alive);
      assert.ok(b.points > 0);
    }
  }
});

test("ブロック崩し: レベル1は 5行x10列 = 50個", () => {
  assert.equal(breakout.bricksForLevel(0).length, 50);
});

test("ブロック崩し: 上の行ほど1個の得点が高い", () => {
  assert.ok(breakout.scoreForBrick(0, 5) > breakout.scoreForBrick(4, 5));
});

test("ブロック崩し: ダメージで hp が減り、0で破壊され得点が入る／元配列は不変", () => {
  const bricks = breakout.bricksForLevel(1); // レベル2には hp2 ブロックがある
  const idx = bricks.findIndex((b) => b.maxHp === 2);
  assert.ok(idx >= 0);
  const once = breakout.damageBrick(bricks, idx);
  assert.equal(once.destroyed, false);
  assert.equal(once.gained, 0);
  assert.equal(once.bricks[idx].hp, 1);
  assert.equal(once.bricks[idx].alive, true);
  assert.equal(bricks[idx].hp, 2); // 元は変わらない
  const twice = breakout.damageBrick(once.bricks, idx);
  assert.equal(twice.destroyed, true);
  assert.ok(twice.gained > 0);
  assert.equal(twice.bricks[idx].alive, false);
});

test("ブロック崩し: 全破壊でクリア判定、最大スコアは正", () => {
  let bricks = breakout.bricksForLevel(0);
  assert.equal(breakout.isBreakoutCleared(bricks), false);
  assert.ok(breakout.levelMaxScore(0) > 0);
  for (let i = 0; i < bricks.length; i++) {
    bricks = breakout.damageBrick(bricks, i).bricks;
  }
  assert.equal(breakout.isBreakoutCleared(bricks), true);
  assert.equal(breakout.aliveBrickCount(bricks), 0);
});

test("ブロック崩し: 次レベルの有無", () => {
  assert.equal(breakout.hasNextLevel(0), true);
  assert.equal(breakout.hasNextLevel(breakout.BREAKOUT_LEVELS.length - 1), false);
});

// ---------------- mole ----------------

test("モグラ: 基本点は通常10・金30、コンボで増える", () => {
  assert.equal(mole.pointsForKind("normal"), 10);
  assert.equal(mole.pointsForKind("gold"), 30);
  assert.equal(mole.pointsWithCombo("normal", 0), 10);
  assert.ok(mole.pointsWithCombo("normal", 5) > mole.pointsWithCombo("normal", 0));
  assert.ok(mole.pointsWithCombo("gold", 10) > mole.pointsWithCombo("gold", 0));
});

test("モグラ: ヒットでコンボとスコアが増え、ミスでコンボが切れる", () => {
  const h1 = mole.applyMoleHit(0, 0, "normal");
  assert.equal(h1.score, 10);
  assert.equal(h1.combo, 1);
  const h2 = mole.applyMoleHit(h1.score, h1.combo, "gold");
  assert.equal(h2.score, 40);
  assert.equal(h2.combo, 2);
  const miss = mole.applyMoleMiss(h2.score);
  assert.equal(miss.score, 40);
  assert.equal(miss.combo, 0);
});

test("モグラ: 種別判定は金率の境界で決まる", () => {
  assert.equal(mole.decideMoleKind(0), "gold");
  assert.equal(mole.decideMoleKind(0.149), "gold");
  assert.equal(mole.decideMoleKind(0.15), "normal");
  assert.equal(mole.decideMoleKind(0.99), "normal");
});

test("モグラ: 終盤ほど出現間隔と出現時間が短い", () => {
  assert.ok(mole.spawnIntervalMs(25_000) < mole.spawnIntervalMs(0));
  assert.ok(mole.moleDurationMs(25_000) < mole.moleDurationMs(0));
});

test("モグラ: スケジュールは決定的で、30秒以内・穴0-8・金が少数混ざる", () => {
  const a = mole.createMoleSchedule(42);
  const b = mole.createMoleSchedule(42);
  assert.deepEqual(a, b);
  assert.ok(a.length >= 20, `spawn count ${a.length}`);
  for (const m of a) {
    assert.ok(m.hole >= 0 && m.hole < 9);
    assert.ok(m.spawnAtMs >= 0 && m.spawnAtMs < mole.MOLE_GAME_MS);
    assert.ok(m.durationMs > 0);
    assert.ok(m.kind === "normal" || m.kind === "gold");
  }
  // 出現時刻は単調増加
  for (let i = 1; i < a.length; i++) assert.ok(a[i].spawnAtMs > a[i - 1].spawnAtMs);
  const golds = a.filter((m) => m.kind === "gold").length;
  assert.ok(golds >= 1 && golds < a.length / 2, `golds ${golds}/${a.length}`);
});

test("モグラ: 連続出現で同じ穴が続かない", () => {
  const schedule = mole.createMoleSchedule(123);
  for (let i = 1; i < schedule.length; i++) {
    assert.notEqual(schedule[i].hole, schedule[i - 1].hole);
  }
});
