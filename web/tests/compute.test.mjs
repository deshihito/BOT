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
  ["kiwipete", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", { 1: 48, 2: 2039, 3: 97862, 4: 4085603 }],
  ["pos3", "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", { 1: 14, 2: 191, 3: 2812, 4: 43238, 5: 674624, 6: 11030083 }],
  ["pos4", "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", { 1: 6, 2: 264, 3: 9467, 4: 422333, 5: 15833292 }],
  ["pos5", "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", { 1: 44, 2: 1486, 3: 62379, 4: 2103487 }],
  ["pos6", "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10", { 1: 46, 2: 2079, 3: 89890, 4: 3894594 }],
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

// スイート2の局面別合計（chessprogramming wiki の Perft Results）:
// startpos depth 6 / kiwipete depth 5 / pos3 depth 7 / pos5 depth 5 / pos6 depth 5
const PUBLISHED_SUITE_TOTALS = {
  startpos: 119060324,
  kiwipete: 193690690,
  pos3: 178633661,
  pos5: 89941194,
  pos6: 164075551,
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

test("カタログ v2 の形: スイート識別子・ID接頭辞・粒度の上限を守る", () => {
  assert.equal(catalog.COMPUTE_SUITE_ID, "v2");
  assert.ok(catalog.COMPUTE_CATALOG_TOTAL_TASKS <= 10_000);
  // スイート1（613タスク / 41,812,668ノード）の10倍以上の規模
  assert.ok(catalog.COMPUTE_CATALOG_TOTAL_NODES >= 41812668 * 10);
  for (const task of catalog.COMPUTE_CATALOG) {
    assert.ok(task.id.startsWith("v2:"), task.id);
    assert.ok(task.expected >= 1 && task.expected <= 3_000_000, task.id);
    assert.ok(task.depth >= 1, task.id);
  }
  // スイート1のタスクIDは現行カタログに存在しない（旧結果は unknown として弾かれる）
  assert.equal(catalog.findComputeTask("startpos:e2e4"), undefined);
  assert.ok(catalog.findComputeTask("v2:startpos:e2e4/a7a6"));
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
  assert.deepEqual(core.parsePoolState(null), { version: 2, suite: "v1", done: {}, leases: {} });
  assert.deepEqual(core.parsePoolState("x"), { version: 2, suite: "v1", done: {}, leases: {} });
  const parsed = core.parsePoolState({
    done: { a: 100, b: -1, c: 1.5, d: "10" },
    leases: { a: { exp: 123, token: "tok" }, b: { exp: "x", token: "tok" }, c: { exp: 1, token: "" } },
  });
  assert.deepEqual(parsed.done, { a: 100 });
  assert.deepEqual(parsed.leases, { a: { exp: 123, token: "tok" } });
});

test("parsePoolState は旧形式（suiteなし）を v1 として読み、v2形式の suite を保持する", () => {
  assert.equal(core.parsePoolState({ version: 1, done: {}, leases: {} }).suite, "v1");
  assert.equal(core.parsePoolState({ version: 2, suite: "v2", done: {}, leases: {} }).suite, "v2");
  assert.equal(core.parsePoolState({ version: 2, suite: "", done: {}, leases: {} }).suite, "v1");
  assert.equal(core.parsePoolState({ version: 2, suite: 42, done: {}, leases: {} }).suite, "v1");
});

test("migratePoolState は旧スイートの実績を退避し、現行スイートの空状態を返す", () => {
  const legacy = core.emptyPoolState();
  legacy.done = { "startpos:a2a3": 100, "startpos:a2a4": 200 };
  legacy.leases = { "startpos:b2b3": { exp: 999, token: "tok" } };
  const { state, archive } = core.migratePoolState(legacy, "v2", 123456);
  assert.deepEqual(state, { version: 2, suite: "v2", done: {}, leases: {} });
  assert.deepEqual(archive, {
    suite: "v1",
    totalTasks: 613,
    completedTasks: 2,
    totalNodes: 300,
    targetNodes: 41812668,
    completed: false,
    archivedAt: 123456,
  });
});

test("migratePoolState は完走済みの旧スイートを completed として退避する", () => {
  const legacy = core.emptyPoolState();
  for (let i = 0; i < 613; i++) legacy.done[`t${i}`] = 1;
  const { archive } = core.migratePoolState(legacy, "v2", 1);
  assert.equal(archive.completed, true);
  assert.equal(archive.completedTasks, 613);
});

test("migratePoolState は空の旧状態を退避せず、現行スイートの状態には触れない", () => {
  const empty = core.emptyPoolState();
  const migrated = core.migratePoolState(empty, "v2", 1);
  assert.equal(migrated.archive, null);
  assert.deepEqual(migrated.state, { version: 2, suite: "v2", done: {}, leases: {} });
  const current = core.emptyPoolState("v2");
  current.done = { "v2:x": 5 };
  const same = core.migratePoolState(current, "v2", 1);
  assert.equal(same.archive, null);
  assert.deepEqual(same.state.done, { "v2:x": 5 });
});

test("parseSuiteHistory / appendSuiteHistory は冪等で壊れた項目を落とす", () => {
  const record = {
    suite: "v1",
    totalTasks: 613,
    completedTasks: 613,
    totalNodes: 41812668,
    targetNodes: 41812668,
    completed: true,
    archivedAt: 42,
  };
  let history = core.appendSuiteHistory([], record);
  assert.equal(history.length, 1);
  history = core.appendSuiteHistory(history, record);
  assert.equal(history.length, 1);
  history = core.appendSuiteHistory(history, null);
  assert.equal(history.length, 1);
  assert.deepEqual(core.parseSuiteHistory("x"), []);
  assert.deepEqual(core.parseSuiteHistory(null), []);
  assert.deepEqual(core.parseSuiteHistory([{ suite: "v1" }, record, record]), [record]);
  // totalTasks / targetNodes が null の記録（規模未知の世代）も保持する
  const partial = { suite: "v9", totalTasks: null, completedTasks: 3, totalNodes: 30, targetNodes: null, completed: false, archivedAt: 7 };
  assert.deepEqual(core.parseSuiteHistory([partial]), [partial]);
});

test("sanitizePoolState は旧スイートのタスク記録を掃除する", () => {
  const state = core.emptyPoolState("v2");
  const v2task = catalog.COMPUTE_CATALOG[0];
  state.done = { "startpos:e2e4": 405385, [v2task.id]: v2task.expected };
  state.leases = { "startpos:e2e4": { exp: 1, token: "tok" } };
  core.sanitizePoolState(state, catalog.COMPUTE_CATALOG);
  assert.deepEqual(state.done, { [v2task.id]: v2task.expected });
  assert.deepEqual(state.leases, {});
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
    suite: "v1",
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

test("leaseTaskBatch は最大件数までまとめて貸し出し、空きが無ければ止まる", () => {
  const tasks = [
    { id: "t1", suite: "s", fen: "f", depth: 1, expected: 10 },
    { id: "t2", suite: "s", fen: "f", depth: 1, expected: 20 },
    { id: "t3", suite: "s", fen: "f", depth: 1, expected: 30 },
  ];
  const state = core.emptyPoolState();
  const batch = core.leaseTaskBatch(state, tasks, 1000, "token-batch-1", 2, 100);
  assert.deepEqual(batch.map((b) => b.task.id), ["t1", "t2"]);
  assert.equal(batch[0].expiresAt, 1100);
  // 残り1件だけ貸せる
  const rest = core.leaseTaskBatch(state, tasks, 1000, "token-batch-2", 16, 100);
  assert.deepEqual(rest.map((b) => b.task.id), ["t3"]);
  // すべてリース中なら空
  assert.deepEqual(core.leaseTaskBatch(state, tasks, 1050, "token-batch-3", 16, 100), []);
  // 上限を超える要求は MAX_LEASE_BATCH に丸める（状態は期限切れで再配布される）
  const capped = core.leaseTaskBatch(state, tasks, 2000, "token-batch-4", 1000, 100);
  assert.equal(capped.length, 3);
});

test("parseBatchResultBody は各要素を検証し、上限を超えたら落とす", () => {
  const ok = core.parseBatchResultBody({
    results: [
      { taskId: "t1", nodes: 42, token: "12345678" },
      { taskId: "t2", nodes: 7, token: "abcdefgh" },
    ],
  });
  assert.equal(ok.length, 2);
  assert.equal(core.parseBatchResultBody({ results: [] }), null);
  assert.equal(core.parseBatchResultBody({ results: [{ taskId: "t1", nodes: -1, token: "12345678" }] }), null);
  assert.equal(core.parseBatchResultBody({ taskId: "t1", nodes: 42, token: "12345678" }), null);
  const tooMany = { results: Array.from({ length: 33 }, (_, i) => ({ taskId: `t${i}`, nodes: 1, token: "12345678" })) };
  assert.equal(core.parseBatchResultBody(tooMany), null);
});

test("parseLeaseBatchCount は 2〜16 の整数だけを通す", () => {
  assert.equal(core.parseLeaseBatchCount({ count: 8 }), 8);
  assert.equal(core.parseLeaseBatchCount({ count: 16 }), 16);
  assert.equal(core.parseLeaseBatchCount({ count: 1 }), null);
  assert.equal(core.parseLeaseBatchCount({ count: 17 }), null);
  assert.equal(core.parseLeaseBatchCount({ count: 2.5 }), null);
  assert.equal(core.parseLeaseBatchCount({ count: "8" }), null);
  assert.equal(core.parseLeaseBatchCount({}), null);
  assert.equal(core.parseLeaseBatchCount(null), null);
});
