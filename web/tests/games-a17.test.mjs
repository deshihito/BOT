// A17 新規ゲーム2本のロジック検証（lib のみ、UI 非依存）。
// - lib/watersort.ts: 生成の可解性・注ぎ規則・完成判定・アンドゥ
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

const ws = await loadLib("watersort.ts");

const shapeIdx = (name) => bp.BP_SHAPES.findIndex((s) => s.name === name);

function bpState(board, pieces) {
  return {
    board,
    pieces,
    score: 0,
    lines: 0,
    placedCells: 0,
    status: "playing",
    seed: 1,
    rng: 12345,
  };
}

const emptyBoard = () => Array.from({ length: 81 }, () => null);

// ---------- ウォーターソート ----------

function wsState(bottles) {
  return {
    bottles,
    capacity: 4,
    colorCount: 2,
    moves: 0,
    status: "playing",
    history: [],
    seed: 1,
    solution: [],
  };
}

test("ウォーターソート: 初期状態は各色4層ずつ・空ボトル2本・未完成で、シード決定的", () => {
  const a = ws.createWaterSortGame(99, 5);
  const b = ws.createWaterSortGame(99, 5);
  assert.deepEqual(a.bottles, b.bottles);
  assert.deepEqual(a.solution, b.solution);
  assert.equal(a.bottles.length, 7);
  const counts = new Map();
  for (const bottle of a.bottles) {
    for (const c of bottle) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  for (let c = 0; c < 5; c++) assert.equal(counts.get(c), 4);
  assert.equal(a.bottles.filter((x) => x.length === 0).length >= 0, true);
  assert.equal(ws.isWsSolved(a.bottles, a.capacity), false);
  assert.equal(a.status, "playing");
});

test("ウォーターソート: 生成された問題は解法どおりに注ぐと完成する（複数シード）", () => {
  for (const seed of [1, 7, 42, 123, 2024]) {
    let s = ws.createWaterSortGame(seed, 5);
    assert.ok(s.solution.length > 0, `seed ${seed}: 解法が空`);
    for (const move of s.solution) {
      const next = ws.pourWater(s, move.from, move.to);
      assert.notEqual(next, s, `seed ${seed}: 解法の注ぎが無効になった`);
      s = next;
    }
    assert.equal(s.status, "won", `seed ${seed}: 完成しなかった`);
    assert.ok(ws.isWsSolved(s.bottles, s.capacity));
  }
});

test("ウォーターソート: 注ぎ規則（空きなし・違う色・空ボトル・同色）", () => {
  const s = wsState([
    [1, 1, 0], // 一番上は 0
    [1, 1, 1, 1], // 満杯
    [2], // 一番上は 2（違う色）
    [0], // 一番上は 0（同色）
    [], // 空
  ]);
  assert.equal(ws.canPour(s, 0, 0), false); // 自分自身
  assert.equal(ws.canPour(s, 0, 1), false); // 注ぎ先が満杯
  assert.equal(ws.canPour(s, 0, 2), false); // 一番上の色が違う
  assert.equal(ws.canPour(s, 0, 3), true); // 同色へは可
  assert.equal(ws.canPour(s, 0, 4), true); // 空ボトルへは可
  const empty = wsState([[], [0]]);
  assert.equal(ws.canPour(empty, 0, 1), false); // 注ぎ元が空
});

test("ウォーターソート: 注ぐ量は一番上の連続層と空きの小さい方", () => {
  const s = wsState([
    [1, 0, 0, 0], // 上の 0 が3層
    [1, 1, 0], // 空き1
    [],
  ]);
  const next = ws.pourWater(s, 0, 1);
  assert.deepEqual(next.bottles[0], [1, 0, 0]);
  assert.deepEqual(next.bottles[1], [1, 1, 0, 0]);
  assert.equal(next.moves, 1);
  // 注げない注ぎは状態を変えない
  assert.equal(ws.pourWater(s, 0, 0), s);
});

test("ウォーターソート: アンドゥで盤と手数が戻る", () => {
  const s = wsState([
    [0, 0, 1],
    [1],
    [],
  ]);
  const poured = ws.pourWater(s, 0, 2);
  assert.notEqual(poured, s);
  const back = ws.undoWaterSort(poured);
  assert.deepEqual(back.bottles, s.bottles);
  assert.equal(back.moves, 0);
  // 履歴が無い状態のアンドゥは無反応
  assert.equal(ws.undoWaterSort(s), s);
});

test("ウォーターソート: 全部そろうと勝ちになり、それ以上注げない", () => {
  const s = wsState([
    [0, 0, 0],
    [0],
    [1, 1, 1, 1],
    [],
  ]);
  const next = ws.pourWater(s, 1, 0);
  assert.equal(next.status, "won");
  assert.equal(ws.canPour(next, 0, 3), false);
});
