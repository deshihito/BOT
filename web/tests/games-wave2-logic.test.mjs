// 第2波・論理/推測系3本のロジック検証（lib のみ、UI 非依存）。
// - lib/maze.ts: 完全迷路（全到達・ループなし）・最短路・移動合法判定
// - lib/mastermind.ts: ヒット＆ブローの重複集計・10回制限・勝敗
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

const maze = await loadLib("maze.ts");
const mm = await loadLib("mastermind.ts");

// ---- めいろ ----

for (const size of ["small", "medium", "large"]) {
  test(`めいろ(${size}): 全マス到達可能でループが無い（完全迷路）`, () => {
    const state = maze.createMazeGame(size, 1234);
    assert.equal(state.walls.length, state.cols * state.rows);
    assert.equal(maze.reachableCount(state, state.start), state.cols * state.rows);
    assert.equal(maze.openPassageCount(state), state.cols * state.rows - 1);
  });
}

test("めいろ: 同じシードでは同じ迷路になる", () => {
  const a = maze.createMazeGame("medium", 77);
  const b = maze.createMazeGame("medium", 77);
  assert.deepEqual(a.walls, b.walls);
  assert.deepEqual(a.solution, b.solution);
});

test("めいろ: 最短路はスタートからゴールまで壁を越えずにたどれる", () => {
  const state = maze.createMazeGame("large", 99);
  const path = maze.solveMaze(state);
  assert.equal(path[0], state.start);
  assert.equal(path[path.length - 1], state.goal);
  assert.deepEqual(path, state.solution);
  const dirOf = (from, to) => {
    if (to === from - state.cols) return "up";
    if (to === from + state.cols) return "down";
    if (to === from - 1) return "left";
    return "right";
  };
  for (let i = 1; i < path.length; i++) {
    assert.equal(maze.canMoveDir(state, path[i - 1], dirOf(path[i - 1], path[i])), true);
  }
});

test("めいろ: 最短路どおりに進むとゴールして勝ち、手数が一致する", () => {
  let state = maze.createMazeGame("small", 5);
  const path = state.solution;
  const dirOf = (from, to) => {
    if (to === from - state.cols) return "up";
    if (to === from + state.cols) return "down";
    if (to === from - 1) return "left";
    return "right";
  };
  for (let i = 1; i < path.length; i++) {
    state = maze.movePlayer(state, dirOf(path[i - 1], path[i]));
  }
  assert.equal(state.player, state.goal);
  assert.equal(state.status, "won");
  assert.equal(state.moves, path.length - 1);
  // 終了後の移動は無効
  assert.equal(maze.movePlayer(state, "left"), state);
});

test("めいろ: 外周の壁には進めず、状態が変わらない", () => {
  const state = maze.createMazeGame("small", 3);
  assert.equal(maze.movePlayer(state, "up"), state);
  assert.equal(maze.movePlayer(state, "left"), state);
  assert.equal(maze.movePlayer(state, "warp"), state);
});

// ---- マスターマインド ----

test("マスターマインド: ヒット＆ブローの集計（重複あり）", () => {
  assert.deepEqual(mm.scoreGuess(["red", "red", "blue", "green"], ["red", "blue", "red", "red"]), {
    hits: 1,
    blows: 2,
  });
  assert.deepEqual(mm.scoreGuess(["red", "blue", "green", "yellow"], ["red", "blue", "green", "yellow"]), {
    hits: 4,
    blows: 0,
  });
  assert.deepEqual(mm.scoreGuess(["red", "red", "red", "red"], ["blue", "blue", "blue", "blue"]), {
    hits: 0,
    blows: 0,
  });
  assert.deepEqual(mm.scoreGuess(["red", "red", "blue", "blue"], ["blue", "blue", "red", "red"]), {
    hits: 0,
    blows: 4,
  });
});

test("マスターマインド: 正解は4ペグで色範囲内、同じシードで再現できる", () => {
  const a = mm.createMastermindGame(42, "normal");
  const b = mm.createMastermindGame(42, "normal");
  assert.equal(a.secret.length, 4);
  assert.deepEqual(a.secret, b.secret);
  const allowed = new Set(mm.mmPalette("normal").map((c) => c.id));
  assert.ok(a.secret.every((id) => allowed.has(id)));
  const easy = mm.createMastermindGame(42, "easy");
  assert.equal(easy.colorCount, 5);
  const easyAllowed = new Set(mm.mmPalette("easy").map((c) => c.id));
  assert.ok(easy.secret.every((id) => easyAllowed.has(id)));
});

test("マスターマインド: 正解を提出すると勝ち、終了後は提出できない", () => {
  let state = mm.createMastermindGame(9, "normal");
  state = mm.submitGuess(state, [...state.secret]);
  assert.equal(state.status, "won");
  assert.equal(state.guesses.length, 1);
  assert.equal(state.guesses[0].hits, 4);
  assert.equal(mm.submitGuess(state, [...state.secret]), state);
});

test("マスターマインド: 10回外すと負け、残り回数が0になる", () => {
  let state = mm.createMastermindGame(15, "normal");
  // 1番目と違う色で埋めれば位置1は絶対に当たらず、勝ちにはならない
  const wrongColor = mm.mmPalette("normal").find((c) => c.id !== state.secret[0]).id;
  const wrong = [wrongColor, wrongColor, wrongColor, wrongColor];
  for (let i = 0; i < 10; i++) state = mm.submitGuess(state, [...wrong]);
  assert.equal(state.guesses.length, 10);
  assert.equal(state.status, "lost");
  assert.equal(mm.remainingGuesses(state), 0);
  assert.equal(mm.submitGuess(state, [...wrong]), state);
});

test("マスターマインド: 不正な予想（長さ・色範囲外）は受理しない", () => {
  const state = mm.createMastermindGame(2, "easy");
  assert.equal(mm.submitGuess(state, ["red", "blue"]), state);
  // easy は5色なので6色目の orange は範囲外
  assert.equal(mm.submitGuess(state, ["red", "blue", "green", "orange"]), state);
  assert.equal(mm.submitGuess(state, ["red", "blue", "green", "pink"]), state);
  assert.equal(state.guesses.length, 0);
});
