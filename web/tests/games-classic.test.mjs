// 追加した定番ゲーム3本のロジック検証（lib のみ、UI 非依存）。
// - lib/minesweeper.ts: 初手安全・フラッドフィル・旗・勝敗
// - lib/slider2048.ts: 合体・スポーン・勝敗
// - lib/memory-match.ts: ペア構成・照合・手数・勝利
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

const ms = await loadLib("minesweeper.ts");
const slide = await loadLib("slider2048.ts");
const mem = await loadLib("memory-match.ts");

test("マインスイーパー: 初手は地雷を踏まず、そのマスと周囲に地雷が無い", () => {
  let state = ms.createMsGame(9, 9, 10, 42);
  state = ms.revealCell(state, 40);
  assert.notEqual(state.status, "lost");
  assert.equal(state.cells[40].mine, false);
  assert.equal(state.cells.filter((c) => c.mine).length, 10);
  assert.ok(state.opened >= 1);
});

test("マインスイーパー: 同じシードでは同じ配置になる", () => {
  const a = ms.revealCell(ms.createMsGame(9, 9, 10, 7), 0);
  const b = ms.revealCell(ms.createMsGame(9, 9, 10, 7), 0);
  assert.deepEqual(
    a.cells.map((c) => c.mine),
    b.cells.map((c) => c.mine),
  );
});

test("マインスイーパー: 旗を立てたマスは開けない／旗は付け外しできる", () => {
  let state = ms.createMsGame(9, 9, 10, 3);
  state = ms.toggleFlag(state, 5);
  assert.equal(state.flags, 1);
  const after = ms.revealCell(state, 5);
  assert.equal(after.cells[5].open, false);
  state = ms.toggleFlag(state, 5);
  assert.equal(state.flags, 0);
});

test("マインスイーパー: 地雷の無い小さい盤は1手で全開して勝ち", () => {
  let state = ms.createMsGame(3, 3, 0, 1);
  state = ms.revealCell(state, 4);
  assert.equal(state.status, "won");
  assert.equal(state.opened, 9);
});

test("マインスイーパー: 地雷を踏むと負けになり全地雷が見える", () => {
  let state = ms.createMsGame(9, 9, 10, 9);
  state = ms.revealCell(state, 0);
  const mineIndex = state.cells.findIndex((c) => c.mine);
  assert.ok(mineIndex >= 0);
  state = ms.revealCell(state, mineIndex);
  assert.equal(state.status, "lost");
  assert.equal(state.exploded, mineIndex);
  assert.ok(state.cells.filter((c) => c.mine).every((c) => c.open));
});

test("2048: 初期盤にはタイルが2枚だけある", () => {
  const state = slide.createSlideGame(11);
  assert.equal(state.tiles.filter((v) => v !== 0).length, 2);
  assert.ok(state.tiles.every((v) => v === 0 || v === 2 || v === 4));
});

test("2048: 同じ数字が合体して得点になり、新しいタイルが1枚増える", () => {
  const base = {
    tiles: [2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    score: 0,
    status: "playing",
    keepGoing: false,
    rng: 5,
    moves: 0,
  };
  const { state, moved } = slide.moveSlide(base, "left");
  assert.equal(moved, true);
  assert.equal(state.tiles[0], 4);
  assert.equal(state.score, 4);
  // 合体で1枚減り、スポーンで1枚増えるので合計2枚
  assert.equal(state.tiles.filter((v) => v !== 0).length, 2);
});

test("2048: 動けない方向への移動は無効でスポーンしない", () => {
  const base = {
    tiles: [2, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    score: 0,
    status: "playing",
    keepGoing: false,
    rng: 5,
    moves: 0,
  };
  const { state, moved } = slide.moveSlide(base, "left");
  assert.equal(moved, false);
  assert.equal(state, base);
});

test("2048: 1024+1024 で 2048 ができると勝ち", () => {
  const base = {
    tiles: [1024, 1024, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    score: 0,
    status: "playing",
    keepGoing: false,
    rng: 5,
    moves: 0,
  };
  const { state } = slide.moveSlide(base, "left");
  assert.equal(state.status, "won");
  const cont = slide.continueSlide(state);
  assert.equal(cont.status, "playing");
  assert.equal(cont.keepGoing, true);
});

test("2048: 空きも合体も無い盤では負け判定になる", () => {
  const full = {
    tiles: [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2],
    score: 0,
    status: "playing",
    keepGoing: false,
    rng: 5,
    moves: 0,
  };
  assert.equal(slide.canMove(full), false);
  const almost = { ...full, tiles: [...full.tiles] };
  almost.tiles[1] = 2; // 左上 [2,2,...] で合体可能
  assert.equal(slide.canMove(almost), true);
});

test("メモリー: デッキは全絵柄がちょうど2枚ずつ", () => {
  const state = mem.createMemoryGame(21);
  assert.equal(state.cards.length, 16);
  const counts = new Map();
  for (const card of state.cards) counts.set(card.icon, (counts.get(card.icon) ?? 0) + 1);
  assert.equal(counts.size, 8);
  assert.ok([...counts.values()].every((n) => n === 2));
});

test("メモリー: 一致ペアは matched になり手数が1増える", () => {
  let state = mem.createMemoryGame(21);
  const pairIndex = state.cards.findIndex((c, i) => i !== 0 && c.icon === state.cards[0].icon);
  assert.ok(pairIndex > 0);
  state = mem.flipCard(state, 0);
  state = mem.flipCard(state, pairIndex);
  assert.equal(mem.isPairPending(state), true);
  assert.equal(mem.pendingIsMatch(state), true);
  state = mem.settlePair(state);
  assert.equal(state.moves, 1);
  assert.equal(state.matchedPairs, 1);
  assert.equal(state.cards[0].matched, true);
  assert.equal(state.faceUp.length, 0);
});

test("メモリー: 不一致ペアは裏に戻り matched にならない", () => {
  let state = mem.createMemoryGame(33);
  const other = state.cards.findIndex((c) => c.icon !== state.cards[0].icon);
  state = mem.flipCard(state, 0);
  state = mem.flipCard(state, other);
  assert.equal(mem.pendingIsMatch(state), false);
  state = mem.settlePair(state);
  assert.equal(state.moves, 1);
  assert.equal(state.matchedPairs, 0);
  assert.equal(state.faceUp.length, 0);
});

test("メモリー: 全部そろえると勝ち", () => {
  let state = mem.createMemoryGame(8);
  const byIcon = new Map();
  state.cards.forEach((card, i) => {
    if (!byIcon.has(card.icon)) byIcon.set(card.icon, []);
    byIcon.get(card.icon).push(i);
  });
  for (const [, [a, b]] of byIcon) {
    state = mem.flipCard(state, a);
    state = mem.flipCard(state, b);
    state = mem.settlePair(state);
  }
  assert.equal(state.status, "won");
  assert.equal(state.matchedPairs, 8);
  assert.equal(state.moves, 8);
});

test("メモリー: 3枚目はめくれない／同じマスは二度めくれない", () => {
  let state = mem.createMemoryGame(4);
  state = mem.flipCard(state, 0);
  state = mem.flipCard(state, 0);
  assert.equal(state.faceUp.length, 1);
  state = mem.flipCard(state, 1);
  state = mem.flipCard(state, 2);
  assert.equal(state.faceUp.length, 2);
});
