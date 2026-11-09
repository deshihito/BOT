// lib/chess-perft.ts / lib/compute-catalog.ts / lib/compute-core.ts の検証。
// perft は公開されている既知値（chessprogramming wiki の Perft Results）と突き合わせる。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

async function loadLib(name) {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", name), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

const perft = await loadLib("chess-perft.ts");
const catalog = await loadLib("compute-catalog.ts");
const core = await loadLib("compute-core.ts");

const SUITES = [
  ["startpos", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", { 1: 20, 2: 400, 3: 8902, 4: 197281 }],
  ["kiwipete", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", { 1: 48, 2: 2039, 3: 97862 }],
  ["pos3", "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", { 1: 14, 2: 191, 3: 2812, 4: 43238, 5: 674624 }],
  ["pos4", "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", { 1: 6, 2: 264, 3: 9467, 4: 422333 }],
  ["pos5", "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", { 1: 44, 2: 1486, 3: 62379 }],
  ["pos6", "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10", { 1: 46, 2: 2079, 3: 89890 }],
];

test("perft が公開既知値と一致する（6局面×複数深さ）", () => {
  for (const [name, fen, table] of SUITES) {
    for (const [depth, expected] of Object.entries(table)) {
      assert.equal(perft.perftFen(fen, Number(depth)), expected, `${name} depth ${depth}`);
    }
  }
});

test("perft の初期局面 depth 5 が既知値 4,865,609 と一致する", () => {
  assert.equal(perft.perftFen(SUITES[0][1], 5), 4865609);
});

test("divide: 初期局面の合法手は20通りで、深さ3の合計が 8,902 になる", () => {
  const pos = perft.parseFen(SUITES[0][1]);
  const moves = perft.generateLegalMoves(pos);
  assert.equal(moves.length, 20);
  let sum = 0;
  for (const { move } of moves) {
    const copy = perft.parseFen(SUITES[0][1]);
    const legal = perft.generateLegalMoves(copy).find((m) => m.uci === perft.moveToUci(move));
    perft.applyMove(copy, legal.move);
    sum += perft.perft(copy, 2);
  }
  assert.equal(sum, 8902);
});

const PUBLISHED_SUITE_TOTALS = {
  startpos: 4865609,
  kiwipete: 4085603,
  pos3: 11030083,
  pos4: 15833292,
  pos5: 2103487,
  pos6: 3894594,
};

test("カタログのスイート別合計が公開 perft 値と一致する", () => {
  const sums = {};
  for (const task of catalog.COMPUTE_CATALOG) {
    sums[task.suite] = (sums[task.suite] ?? 0) + task.expected;
  }
  assert.deepEqual(sums, PUBLISHED_SUITE_TOTALS);
  assert.equal(catalog.COMPUTE_CATALOG.length, catalog.COMPUTE_CATALOG_TOTAL_TASKS);
  assert.equal(
    catalog.COMPUTE_CATALOG.reduce((sum, t) => sum + t.expected, 0),
    catalog.COMPUTE_CATALOG_TOTAL_NODES,
  );
  assert.equal(new Set(catalog.COMPUTE_CATALOG.map((t) => t.id)).size, catalog.COMPUTE_CATALOG.length);
});

test("カタログの expected が実計算と一致する（サンプル検証）", () => {
  const tasks = catalog.COMPUTE_CATALOG;
  const samples = new Set();
  for (const suite of Object.keys(PUBLISHED_SUITE_TOTALS)) {
    const first = tasks.find((t) => t.suite === suite);
    if (first) samples.add(first);
  }
  for (let i = 0; i < tasks.length; i += 97) samples.add(tasks[i]);
  for (const task of samples) {
    assert.equal(perft.perftFen(task.fen, task.depth), task.expected, task.id);
  }
});

test("parsePoolState は壊れたデータを落として安全な形にする", () => {
  assert.deepEqual(core.parsePoolState(null), { version: 1, done: {}, leases: {} });
  assert.deepEqual(core.parsePoolState("x"), { version: 1, done: {}, leases: {} });
  const parsed = core.parsePoolState({
    done: { a: 100, b: -1, c: 1.5, d: "10" },
    leases: { a: { exp: 123, token: "tok" }, b: { exp: "x", token: "tok" }, c: { exp: 1, token: "" } },
  });
  assert.deepEqual(parsed.done, { a: 100 });
  assert.deepEqual(parsed.leases, { a: { exp: 123, token: "tok" } });
});

test("leaseNextTask は順に貸し出し、期限切れを再配布し、完了済みを飛ばす", () => {
  const tasks = [
    { id: "t1", suite: "s", fen: "f", depth: 1, expected: 10 },
    { id: "t2", suite: "s", fen: "f", depth: 1, expected: 20 },
  ];
  const state = core.emptyPoolState();
  const first = core.leaseNextTask(state, tasks, 1000, "token-a", 100);
  assert.equal(first.task.id, "t1");
  assert.equal(first.expiresAt, 1100);
  const second = core.leaseNextTask(state, tasks, 1000, "token-b", 100);
  assert.equal(second.task.id, "t2");
  // 両方リース中は貸し出し不可
  assert.equal(core.leaseNextTask(state, tasks, 1050, "token-c", 100), null);
  // 期限切れ後は t1 から再配布される
  const re = core.leaseNextTask(state, tasks, 1200, "token-c", 100);
  assert.equal(re.task.id, "t1");
  assert.equal(state.leases.t1.token, "token-c");
  // 完了済みは貸し出されない
  state.done = { t1: 10, t2: 20 };
  assert.equal(core.leaseNextTask(state, tasks, 2000, "token-d", 100), null);
});

test("submitVerifiedResult は正解だけを採用し、冪等で、不一致はリース保持者のリースだけ解放する", () => {
  const task = { id: "t1", suite: "s", fen: "f", depth: 1, expected: 42 };
  const state = core.emptyPoolState();
  state.leases = { t1: { exp: 9999, token: "owner-token-1" } };
  // 他人のトークンでの不一致: リースは残る
  assert.equal(core.submitVerifiedResult(state, task, 41, "other-token-1"), "mismatch");
  assert.equal(state.leases.t1?.token, "owner-token-1");
  assert.deepEqual(state.done, {});
  // 本人のトークンでの不一致: リース解放
  assert.equal(core.submitVerifiedResult(state, task, 41, "owner-token-1"), "mismatch");
  assert.equal(state.leases.t1, undefined);
  // 正解: 採用
  state.leases = { t1: { exp: 9999, token: "owner-token-1" } };
  assert.equal(core.submitVerifiedResult(state, task, 42, "owner-token-1"), "accepted");
  assert.deepEqual(state.done, { t1: 42 });
  assert.equal(state.leases.t1, undefined);
  // 二重送信: 冪等に duplicate（値が違っても完了済みが優先）
  assert.equal(core.submitVerifiedResult(state, task, 42, "owner-token-1"), "duplicate");
  assert.equal(core.submitVerifiedResult(state, task, 7, "owner-token-1"), "duplicate");
});

test("poolProgress は完了数とノード合計を集計する", () => {
  const state = core.emptyPoolState();
  state.done = { a: 100, b: 250 };
  const progress = core.poolProgress(state, 10, 1000);
  assert.deepEqual(progress, {
    totalTasks: 10,
    completedTasks: 2,
    totalNodes: 350,
    targetNodes: 1000,
    percent: 20,
  });
});

test("parseResultBody は正しいボディだけを通す", () => {
  assert.deepEqual(core.parseResultBody({ taskId: "t1", nodes: 42, token: "12345678" }), {
    taskId: "t1",
    nodes: 42,
    token: "12345678",
  });
  assert.equal(core.parseResultBody(null), null);
  assert.equal(core.parseResultBody({ taskId: "t1", nodes: -1, token: "12345678" }), null);
  assert.equal(core.parseResultBody({ taskId: "t1", nodes: 1.5, token: "12345678" }), null);
  assert.equal(core.parseResultBody({ taskId: "t1", nodes: "42", token: "12345678" }), null);
  assert.equal(core.parseResultBody({ taskId: "", nodes: 42, token: "12345678" }), null);
  assert.equal(core.parseResultBody({ taskId: "t1", nodes: 42, token: "short" }), null);
  assert.equal(core.parseResultBody({ taskId: "t1", nodes: Number.MAX_SAFE_INTEGER, token: "12345678" }), null);
});

test("sanitizePoolState はカタログ外の記録と完了済みのリースを掃除する", () => {
  const tasks = [{ id: "t1", suite: "s", fen: "f", depth: 1, expected: 10 }];
  const state = core.emptyPoolState();
  state.done = { t1: 10, ghost: 5 };
  state.leases = { t1: { exp: 1, token: "tok" }, ghost: { exp: 1, token: "tok" } };
  core.sanitizePoolState(state, tasks);
  assert.deepEqual(state.done, { t1: 10 });
  assert.deepEqual(state.leases, {});
});

test("isRateLimited はウィンドウ内の件数で判定する", () => {
  const now = 100_000;
  assert.equal(core.isRateLimited([now - 1000, now - 2000], now, 3, 60_000), false);
  assert.equal(core.isRateLimited([now - 1000, now - 2000, now - 3000], now, 3, 60_000), true);
  assert.equal(core.isRateLimited([now - 120_000], now, 1, 60_000), false);
});
