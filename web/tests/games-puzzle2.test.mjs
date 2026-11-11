// ソロパズル第2弾のロジック検証（lib のみ、UI 非依存）。
// - lib/sudoku.ts: 唯一解・完成判定・ヒント・矛盾チェック
// - lib/fifteen.ts: 解可能性・スライド・完成判定
// - lib/lightsout.ts: 生成盤が解けること・十字反転・全消灯判定
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

const sudoku = await loadLib("sudoku.ts");
const fifteen = await loadLib("fifteen.ts");
const lights = await loadLib("lightsout.ts");

// ---- 数独 ----

test("数独: 生成盤は唯一解を持ち、解答は正しい完成盤", () => {
  for (const diff of ["easy", "normal", "hard"]) {
    const state = sudoku.createSudokuGame(diff, 42);
    assert.equal(state.solution.length, 81);
    assert.equal(sudoku.isValidCompleteBoard(state.solution), true);
    assert.equal(sudoku.countSolutions(state.puzzle, 2), 1, `${diff} は唯一解`);
    // 与えられた数字は解答と一致する
    for (let i = 0; i < 81; i++) {
      if (state.puzzle[i] !== 0) assert.equal(state.puzzle[i], state.solution[i]);
      assert.equal(state.givens[i], state.puzzle[i] !== 0);
      assert.equal(state.board[i], state.puzzle[i]);
    }
    assert.equal(state.status, "playing");
  }
});

test("数独: 難易度で穴数が増える（目安の範囲内）", () => {
  const holes = (diff) => {
    const s = sudoku.createSudokuGame(diff, 7);
    return s.puzzle.filter((v) => v === 0).length;
  };
  const e = holes("easy");
  const n = holes("normal");
  const h = holes("hard");
  assert.ok(e >= 30 && e <= 40, `easy holes=${e}`);
  assert.ok(n >= 40 && n <= 50, `normal holes=${n}`);
  assert.ok(h >= 46, `hard holes=${h}`);
  assert.ok(e < n && n <= h + 2);
});

test("数独: 同じシードでは同じ盤になる", () => {
  const a = sudoku.createSudokuGame("normal", 123);
  const b = sudoku.createSudokuGame("normal", 123);
  assert.deepEqual(a.solution, b.solution);
  assert.deepEqual(a.puzzle, b.puzzle);
});

test("数独: 正しい入力で埋めると完成判定になり、完成後は操作できない", () => {
  let state = sudoku.createSudokuGame("easy", 99);
  for (let i = 0; i < 81; i++) {
    if (!state.givens[i]) state = sudoku.setCell(state, i, state.solution[i]);
  }
  assert.equal(sudoku.isComplete(state), true);
  assert.equal(state.status, "won");
  assert.equal(state.mistakes, 0);
  const after = sudoku.setCell(state, 0, 1);
  assert.equal(after, state);
});

test("数独: 誤った入力はミスとして数えられ、与えられたマスは変更できない", () => {
  let state = sudoku.createSudokuGame("easy", 5);
  const givenIdx = state.givens.findIndex(Boolean);
  const afterGiven = sudoku.setCell(state, givenIdx, (state.board[givenIdx] % 9) + 1);
  assert.equal(afterGiven, state);
  const emptyIdx = state.givens.findIndex((g) => !g);
  const wrong = (state.solution[emptyIdx] % 9) + 1;
  state = sudoku.setCell(state, emptyIdx, wrong);
  assert.equal(state.mistakes, 1);
  assert.equal(sudoku.isMistake(state, emptyIdx), true);
  assert.equal(state.status, "playing");
});

test("数独: 重複入力は矛盾として検出される", () => {
  let state = sudoku.createSudokuGame("easy", 11);
  // 同じ行の空き2マスにあえて同じ数字を入れる
  outer: for (let r = 0; r < 9; r++) {
    const empties = [];
    for (let c = 0; c < 9; c++) if (!state.givens[r * 9 + c]) empties.push(r * 9 + c);
    if (empties.length >= 2) {
      state = sudoku.setCell(state, empties[0], 1);
      state = sudoku.setCell(state, empties[1], 1);
      const conflicts = sudoku.conflictIndexes(state);
      assert.ok(conflicts.has(empties[0]) || state.board[empties[0]] === 1);
      // 1 が解答と一致して given 的に正しくても、重複があればどちらかが矛盾側に出る
      assert.ok(conflicts.size >= 1, "重複を検出できる");
      break outer;
    }
  }
});

test("数独: ヒントは正しい数字を埋めて残数が減り、尽きると使えない", () => {
  let state = sudoku.createSudokuGame("easy", 21);
  const before = state.hintsLeft;
  const hintIdx = sudoku.findHintIndex(state);
  assert.ok(hintIdx >= 0);
  state = sudoku.applyHint(state);
  assert.equal(state.hintsLeft, before - 1);
  assert.equal(state.board[hintIdx], state.solution[hintIdx]);
  assert.equal(state.lastHint, hintIdx);
  // 残数を 0 にした状態ではヒントが効かない
  const drained = { ...state, hintsLeft: 0 };
  assert.equal(sudoku.applyHint(drained), drained);
});

test("数独: メモはトグルでき、数字を入れるとそのマスのメモが消える", () => {
  let state = sudoku.createSudokuGame("easy", 31);
  const emptyIdx = state.givens.findIndex((g) => !g);
  state = sudoku.toggleNote(state, emptyIdx, 3);
  assert.deepEqual(state.notes[emptyIdx], [3]);
  state = sudoku.toggleNote(state, emptyIdx, 5);
  assert.deepEqual(state.notes[emptyIdx], [3, 5]);
  state = sudoku.toggleNote(state, emptyIdx, 3);
  assert.deepEqual(state.notes[emptyIdx], [5]);
  state = sudoku.setCell(state, emptyIdx, state.solution[emptyIdx]);
  assert.deepEqual(state.notes[emptyIdx], []);
  assert.equal(state.board[emptyIdx], state.solution[emptyIdx]);
});

test("数独: 不正な入力は無視される", () => {
  const state = sudoku.createSudokuGame("easy", 3);
  assert.equal(sudoku.setCell(state, -1, 5), state);
  assert.equal(sudoku.setCell(state, 81, 5), state);
  assert.equal(sudoku.setCell(state, 0, 10), state);
  assert.equal(sudoku.toggleNote(state, 0, 0), state);
});

// ---- 15パズル ----

test("15パズル: 生成盤は解可能で未完成、タイルは 0..N-1 の順列", () => {
  for (const size of [3, 4, 5]) {
    for (const seed of [1, 42, 777]) {
      const state = fifteen.createFifteenGame(size, seed);
      assert.equal(state.size, size);
      assert.equal(state.tiles.length, size * size);
      const sorted = [...state.tiles].sort((a, b) => a - b);
      assert.deepEqual(sorted, Array.from({ length: size * size }, (_, i) => i));
      assert.equal(fifteen.isSolvable(state.tiles, size), true, `size=${size} seed=${seed}`);
      assert.equal(fifteen.isComplete(state), false);
      assert.equal(state.status, "playing");
      assert.equal(state.moves, 0);
    }
  }
});

test("15パズル: 同じシードでは同じ盤になる", () => {
  const a = fifteen.createFifteenGame(4, 55);
  const b = fifteen.createFifteenGame(4, 55);
  assert.deepEqual(a.tiles, b.tiles);
});

test("15パズル: 解けない盤は isSolvable が false を返す", () => {
  // 14 と 15 を入れ替えた古典的な解けない盤
  const tiles = fifteen.solvedTiles(4);
  const i14 = tiles.indexOf(14);
  const i15 = tiles.indexOf(15);
  [tiles[i14], tiles[i15]] = [tiles[i15], tiles[i14]];
  assert.equal(fifteen.isSolvable(tiles, 4), false);
  assert.equal(fifteen.isSolvable(fifteen.solvedTiles(4), 4), true);
  assert.equal(fifteen.isSolvable(fifteen.solvedTiles(3), 3), true);
});

test("15パズル: 空白と隣接したタイルだけが1手で動き、手数が増える", () => {
  // 完成盤から1手ずらした盤を作り、元に戻せることを見る
  const solved = fifteen.solvedTiles(4);
  // 空白は末尾。左隣のタイル(15)をクリックすると完成するはず…ではなく空白へ動く
  let state = { size: 4, seed: 0, tiles: [...solved], moves: 0, status: "playing" };
  const blank = fifteen.blankIndex(state.tiles);
  const left = blank - 1;
  // 完成盤の空白の左は 15。そのタイルを押すと空白と入れ替わる（未完成になる）
  state = fifteen.slideTile(state, left);
  assert.equal(state.moves, 1);
  assert.equal(state.tiles[blank], 15);
  assert.equal(state.tiles[left], 0);
  // もう一度同じ位置（今はタイルのある場所）を押すと完成に戻る
  state = fifteen.slideTile(state, blank);
  assert.equal(state.status, "won");
  assert.equal(fifteen.isComplete(state), true);
  // 完成後は操作できない
  const after = fifteen.slideTile(state, 0);
  assert.equal(after, state);
});

test("15パズル: 離れたタイルや空白自体は動かない", () => {
  const state = fifteen.createFifteenGame(4, 9);
  assert.equal(fifteen.slideTile(state, fifteen.blankIndex(state.tiles)), state);
  assert.equal(fifteen.slideTile(state, -1), state);
  assert.equal(fifteen.slideTile(state, 999), state);
});

test("15パズル: 同じ行・列のタイルはまとめてスライドし、解可能性が保たれる", () => {
  let state = { size: 3, seed: 0, tiles: fifteen.solvedTiles(3), moves: 0, status: "playing" };
  // 空白は index 8（右下）。同じ行の左端 index 6 を押すと2枚まとめて動く
  state = fifteen.slideTile(state, 6);
  assert.equal(state.moves, 1);
  assert.deepEqual(state.tiles, [1, 2, 3, 4, 5, 6, 0, 7, 8]);
  assert.equal(fifteen.isSolvable(state.tiles, 3), true);
});

// ---- ライツアウト ----

test("ライツアウト: 生成盤は未消灯で、生成手順の逆再生（同一手順）で消える", () => {
  for (const size of [3, 4, 5]) {
    for (const diff of ["easy", "normal", "hard"]) {
      const state = lights.createLightsOutGame(size, 42, diff);
      assert.equal(state.cells.length, size * size);
      assert.equal(lights.isAllOff(state.cells), false, `size=${size} diff=${diff}`);
      assert.equal(state.status, "playing");
      // 生成手順と同じマスを同じ回数押すと全消灯に戻る（押下は自己逆操作）
      let cur = state;
      for (const idx of state.generation) cur = lights.pressCell(cur, idx);
      assert.equal(lights.isAllOff(cur.cells), true, `size=${size} diff=${diff} は解ける`);
      assert.equal(cur.status, "won");
    }
  }
});

test("ライツアウト: solutionPresses を押しても消灯する", () => {
  const state = lights.createLightsOutGame(5, 123, "normal");
  let cur = state;
  for (const idx of lights.solutionPresses(state)) cur = lights.pressCell(cur, idx);
  assert.equal(lights.isAllOff(cur.cells), true);
  assert.equal(cur.status, "won");
});

test("ライツアウト: 押下で自分と上下左右だけが反転する", () => {
  const off = { size: 5, difficulty: "normal", seed: 0, cells: Array(25).fill(false), moves: 0, status: "playing", generation: [] };
  const center = lights.pressCell(off, 12); // 中央 (2,2)
  const lit = center.cells.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(lit.sort((a, b) => a - b), [7, 11, 12, 13, 17]);
  assert.equal(center.moves, 1);
  const corner = lights.pressCell(off, 0);
  const lit2 = corner.cells.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(lit2.sort((a, b) => a - b), [0, 1, 5]);
  // 同じマスをもう一度押すと元に戻る
  const back = lights.pressCell(center, 12);
  assert.equal(lights.isAllOff(back.cells), true);
});

test("ライツアウト: 同じシードでは同じ盤になる／全消灯後は操作できない", () => {
  const a = lights.createLightsOutGame(4, 8, "normal");
  const b = lights.createLightsOutGame(4, 8, "normal");
  assert.deepEqual(a.cells, b.cells);
  assert.deepEqual(a.generation, b.generation);
  let cur = a;
  for (const idx of a.generation) cur = lights.pressCell(cur, idx);
  assert.equal(cur.status, "won");
  assert.equal(lights.pressCell(cur, 0), cur);
  assert.equal(lights.pressCell(a, -1), a);
  assert.equal(lights.pressCell(a, 999), a);
});

test("ライツアウト: 難易度で生成手順の長さが変わる", () => {
  const easy = lights.createLightsOutGame(5, 3, "easy");
  const hard = lights.createLightsOutGame(5, 3, "hard");
  assert.ok(easy.generation.length < hard.generation.length);
  assert.ok(lights.litCount(easy.cells) >= 1);
  assert.ok(lights.litCount(hard.cells) >= 1);
});
