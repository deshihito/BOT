// A36フェーズ: パズル問題集の増量分の機械検証（lib のみ、UI 非依存）。
// - lib/tsume.ts: 全10題（1手詰め5・3手詰め5）がソルバーで「初期局面で玉に王手なし・
//   指定手数ちょうどで詰み・初手が1つだけ」を満たす
// - lib/chesspuzzle.ts: 全15題（1手詰め7・2手詰め8）が verifyProblem を通る
// - lib/river.ts: 全12題が BFS で解け、最短手数が既知の値と一致する
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const webDir = path.join(import.meta.dirname, "..");
const libDir = path.join(webDir, "lib");

async function loadLib(name) {
  const src = fs.readFileSync(path.join(libDir, name), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

const tsume = await loadLib("tsume.ts");
const cp = await loadLib("chesspuzzle.ts");
const rv = await loadLib("river.ts");

// ------------------------------------------------------------ tsume

test("詰将棋: 全14題（1手詰め7・3手詰め7）があり、ID が重複しない", () => {
  assert.equal(tsume.TSUME_PROBLEMS.length, 14);
  const ids = new Set(tsume.TSUME_PROBLEMS.map((p) => p.id));
  assert.equal(ids.size, 14);
  const counts = { 1: 0, 3: 0 };
  for (const p of tsume.TSUME_PROBLEMS) counts[p.moves] += 1;
  assert.deepEqual(counts, { 1: 7, 3: 7 });
});

test("詰将棋: 全問題が機械検証を通る（王手なし初期局面・指定手数ちょうど・初手一意）", () => {
  for (const p of tsume.TSUME_PROBLEMS) {
    const pos = tsume.problemPosition(p);
    assert.equal(tsume.inCheck(pos, "D"), false, `${p.id}: 初期局面で玉が王手状態ではいけない`);
    const sol = tsume.solveTsume(pos, p.moves);
    assert.equal(sol.mate, true, `${p.id}: 詰むはず`);
    assert.equal(sol.moves, p.moves, `${p.id}: ${p.moves}手詰めのはず`);
    assert.equal(sol.winningFirstMoves.length, 1, `${p.id}: 初手は1つだけのはず`);
  }
});

test("詰将棋: 増量3題が含まれ、正解手順で実際にクリアできる", () => {
  for (const id of ["atama-kin-3", "ryu-yose", "kaku-hi-kin"]) {
    assert.ok(tsume.TSUME_PROBLEM_MAP[id], `${id} が収録されている`);
    let state = tsume.createTsumeGame(id);
    let guard = 0;
    while (state.status === "playing" && guard++ < 10) {
      const sol = tsume.solveTsume(state.pos, state.problem.moves - state.movesUsed);
      assert.ok(sol.mate && sol.winningFirstMoves.length >= 1, `${id}: 手順が続く`);
      state = tsume.playAttackerMove(state, sol.winningFirstMoves[0]);
    }
    assert.equal(state.status, "cleared", `${id}: クリアできるはず`);
    assert.equal(state.movesUsed, state.problem.moves, `${id}: 指定手数でクリア`);
  }
});

// ------------------------------------------------------------ chesspuzzle

test("詰めチェス: 全15題（1手詰め7・2手詰め8）があり、ID と局面が重複しない", () => {
  assert.equal(cp.CHESS_PROBLEMS.length, 15);
  const ids = new Set(cp.CHESS_PROBLEMS.map((p) => p.id));
  assert.equal(ids.size, 15);
  const fens = new Set(cp.CHESS_PROBLEMS.map((p) => p.fen));
  assert.equal(fens.size, 15);
  const counts = { 1: 0, 2: 0 };
  for (const p of cp.CHESS_PROBLEMS) counts[p.mateIn] += 1;
  assert.deepEqual(counts, { 1: 7, 2: 8 });
});

test("詰めチェス: 全問題が verifyProblem を通る（王手なし初期局面・指定手数ちょうど・初手一意）", () => {
  for (const p of cp.CHESS_PROBLEMS) {
    const v = cp.verifyProblem(p);
    assert.ok(v.ok, `${p.id} (${p.title}): ${v.reason}`);
    assert.equal(v.firstMoveCount, 1, `${p.id}: 初手は1つだけのはず`);
  }
});

test("詰めチェス: 増量3題が含まれ、ヒント手順でクリアできる", () => {
  for (const id of ["cp8", "cp9", "cp10"]) {
    let state = cp.createChessPuzzleGame(id);
    let guard = 0;
    while (state.status === "playing" && guard++ < 10) {
      const hint = cp.hintMove(state);
      assert.ok(hint, `${id}: ヒントが存在する`);
      state = cp.playPuzzleMove(state, hint);
    }
    assert.equal(state.status, "solved", `${id}: クリアできるはず`);
    const problem = cp.problemById(id);
    assert.equal(state.plies.length, problem.mateIn * 2 - 1, `${id}: 棋譜長が手数と一致`);
    assert.ok(state.plies[state.plies.length - 1].endsWith("#"), `${id}: 最終手に #`);
  }
});

// ------------------------------------------------------------ river

const RIVER_EXPECTED = {
  classic: 7, fox: 7, bigboat: 3, pets: 3, catfish: 7, flower: 3, bear: 7, farmpets: 5,
  doublechain: 7, herd: 7, pasture: 7, foxhole: 7,
};

test("川渡り: 全12題があり、ID が重複しない", () => {
  assert.equal(rv.RIVER_PROBLEMS.length, 12);
  const ids = new Set(rv.RIVER_PROBLEMS.map((p) => p.id));
  assert.equal(ids.size, 12);
});

test("川渡り: 全問題が BFS で解け、最短手数が既知の値と一致する", () => {
  for (const p of rv.RIVER_PROBLEMS) {
    const min = rv.riverMinCrossings(p);
    assert.ok(min > 0, `${p.id}: 解けるはず`);
    assert.equal(min, RIVER_EXPECTED[p.id], `${p.id}: 最短 ${RIVER_EXPECTED[p.id]} 回のはず`);
  }
});

test("川渡り: 増量3題の危険ペアが実在の荷物だけを指している", () => {
  for (const id of ["flower", "bear", "farmpets"]) {
    const p = rv.getRiverProblem(id);
    assert.equal(p.id, id);
    const itemIds = new Set(p.items.map((i) => i.id));
    assert.equal(itemIds.size, p.items.length, `${id}: 荷物 ID が重複しない`);
    for (const [x, y] of p.dangerPairs) {
      assert.ok(itemIds.has(x) && itemIds.has(y), `${id}: 危険ペア ${x}/${y} が実在する`);
      assert.notEqual(x, y, `${id}: 危険ペアは相異なる2つ`);
    }
    assert.ok(p.capacity >= 1 && p.capacity < p.items.length, `${id}: 定員が妥当`);
  }
});
