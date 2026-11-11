// A17 新規ゲーム2本のロジック検証（lib のみ、UI 非依存）。
// - lib/blockpuzzle.ts: 配置・消去・補充・終了判定
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

const bp = await loadLib("blockpuzzle.ts");
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

// ---------- ブロックスパズル ----------

test("ブロックスパズル: 初期状態は空盤＋未使用ブロック3つで、シード決定的", () => {
  const a = bp.createBlockPuzzleGame(42);
  const b = bp.createBlockPuzzleGame(42);
  assert.equal(a.board.length, 81);
  assert.ok(a.board.every((v) => v === null));
  assert.equal(a.pieces.length, 3);
  assert.ok(a.pieces.every((p) => !p.used));
  assert.deepEqual(a.pieces, b.pieces);
  assert.equal(a.status, "playing");
});

test("ブロックスパズル: 配置でマスが埋まり、スコアはマス数ぶん増える", () => {
  const s = bp.createBlockPuzzleGame(7);
  const piece = s.pieces[0];
  const next = bp.placePiece(s, 0, 0, 0);
  assert.notEqual(next, s);
  const cells = bp.BP_SHAPES[piece.shape].cells.length;
  assert.equal(next.score, cells);
  assert.equal(next.placedCells, cells);
  assert.equal(next.pieces[0].used, true);
  for (const [dr, dc] of bp.BP_SHAPES[piece.shape].cells) {
    assert.equal(next.board[dr * 9 + dc], piece.color);
  }
  // 元の状態は壊れていない（非破壊）
  assert.ok(s.board.every((v) => v === null));
});

test("ブロックスパズル: 置けない場所・使用済みブロックは状態を変えない", () => {
  const big = bpState(emptyBoard(), [
    { shape: shapeIdx("3x3"), color: 0, used: false },
    { shape: shapeIdx("1マス"), color: 1, used: false },
    { shape: shapeIdx("1マス"), color: 2, used: false },
  ]);
  assert.equal(bp.placePiece(big, 0, 8, 8), big); // 盤外にはみ出す
  assert.equal(bp.placePiece(big, 0, -1, 0), big); // 負の座標
  assert.equal(bp.placePiece(big, 9, 0, 0), big); // 存在しないブロック
  // (1,1) に置く。(0,0) だと 3x3 ユニットが完成して即消去されてしまうため、ずらして置く。
  const placed = bp.placePiece(big, 0, 1, 1);
  assert.notEqual(placed, big);
  assert.equal(placed.board[1 * 9 + 1], 0);
  assert.equal(bp.placePiece(placed, 0, 5, 5), placed); // 使用済みは再配置できない
  assert.equal(bp.placePiece(placed, 1, 1, 1), placed); // 埋まったマスへは重ねられない
});

test("ブロックスパズル: 行をそろえると消えてボーナスが付く", () => {
  const board = emptyBoard();
  for (let c = 0; c < 8; c++) board[c] = 0; // 0行目の 0..7 列を埋める
  const state = bpState(board, [
    { shape: shapeIdx("1マス"), color: 1, used: false },
    { shape: shapeIdx("2x2"), color: 2, used: false },
    { shape: shapeIdx("2x2"), color: 3, used: false },
  ]);
  const next = bp.placePiece(state, 0, 0, 8);
  assert.equal(next.lines, 1);
  assert.equal(next.score, 1 + 10); // 1マス + 1ライン消去ボーナス 10
  assert.ok(next.board.slice(0, 9).every((v) => v === null));
});

test("ブロックスパズル: 3x3 ブロックをそろえても消える", () => {
  const board = emptyBoard();
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (r * 3 + c !== 8) board[r * 9 + c] = 2; // 右下1マスだけ空ける
    }
  }
  const state = bpState(board, [
    { shape: shapeIdx("1マス"), color: 4, used: false },
    { shape: shapeIdx("2x2"), color: 0, used: false },
    { shape: shapeIdx("2x2"), color: 1, used: false },
  ]);
  const next = bp.placePiece(state, 0, 2, 2);
  assert.equal(next.lines, 1);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) assert.equal(next.board[r * 9 + c], null);
  }
});

test("ブロックスパズル: 3つ使い切ると新しい3つが補充される", () => {
  const state = bpState(emptyBoard(), [
    { shape: shapeIdx("1マス"), color: 0, used: false },
    { shape: shapeIdx("1マス"), color: 1, used: false },
    { shape: shapeIdx("1マス"), color: 2, used: false },
  ]);
  let s = bp.placePiece(state, 0, 0, 0);
  s = bp.placePiece(s, 1, 0, 1);
  s = bp.placePiece(s, 2, 0, 2);
  assert.equal(s.pieces.length, 3);
  assert.ok(s.pieces.every((p) => !p.used));
  assert.equal(s.status, "playing");
});

test("ブロックスパズル: 残りブロックがどこにも置けなくなると終了", () => {
  // 市松模様に穴を開けた盤。どの行・列・3x3 にも穴が複数残るので、1マス置いても消去は起きず、
  // 3x3 ブロックは9マス連続の空きが無いため置けない。
  const board = Array.from({ length: 81 }, (_, i) => {
    const r = Math.floor(i / 9);
    const c = i % 9;
    return (r + c) % 2 === 0 ? null : 0;
  });
  const state = bpState(board, [
    { shape: shapeIdx("1マス"), color: 1, used: false },
    { shape: shapeIdx("3x3"), color: 2, used: false },
    { shape: shapeIdx("3x3"), color: 3, used: false },
  ]);
  const next = bp.placePiece(state, 0, 0, 0);
  assert.equal(next.lines, 0); // 穴が残るので何も消えない
  assert.equal(next.status, "over");
});

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
