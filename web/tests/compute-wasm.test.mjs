// lib/compute-wasm.ts (WASM 実行方式) の検証。
// WASM は Node でもそのまま動くため、公開既知値とカタログの正解値で
// 実際のバイナリを直接突き合わせる。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

async function loadLib(name, patch) {
  let src = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", name), "utf8");
  if (patch) src = patch(src);
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

const perft = await loadLib("chess-perft.ts");
globalThis.__chessPerft = perft;
globalThis.__wasmBytes = await loadLib("compute-wasm-bytes.ts");
// 相対 import は data URL では解決できないため、読み込み済みモジュールへの
// 参照に置き換える。
const wasm = await loadLib("compute-wasm.ts", (src) =>
  src
    .replace(
      /import\s*\{[^}]*\}\s*from\s*"\.\/chess-perft";/,
      "const { parseFen } = globalThis.__chessPerft;",
    )
    .replace(
      /import\s*\{[^}]*\}\s*from\s*"\.\/compute-wasm-bytes";/,
      "const { WASM_BASE64 } = globalThis.__wasmBytes;",
    ),
);
const catalog = await loadLib("compute-catalog.ts");

const SUITES = [
  ["startpos", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", { 1: 20, 2: 400, 3: 8902, 4: 197281, 5: 4865609 }],
  ["kiwipete", "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", { 1: 48, 2: 2039, 3: 97862, 4: 4085603 }],
  ["pos3", "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", { 1: 14, 2: 191, 3: 2812, 4: 43238, 5: 674624, 6: 11030083 }],
  ["pos4", "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", { 1: 6, 2: 264, 3: 9467, 4: 422333, 5: 15833292 }],
  ["pos5", "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", { 1: 44, 2: 1486, 3: 62379, 4: 2103487 }],
  ["pos6", "r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10", { 1: 46, 2: 2079, 3: 89890, 4: 3894594 }],
];

test("WASM perft が公開既知値と一致する（6局面×複数深さ）", async () => {
  for (const [, fen, table] of SUITES) {
    for (const [depth, expected] of Object.entries(table)) {
      assert.equal(await wasm.perftFenWasm(fen, Number(depth)), expected);
    }
  }
});

test("WASM perft がカタログの実タスクの正解値と一致する", async () => {
  const tasks = catalog.COMPUTE_CATALOG;
  const step = Math.floor(tasks.length / 12);
  for (let i = 0; i < tasks.length; i += step) {
    const task = tasks[i];
    assert.equal(await wasm.perftFenWasm(task.fen, task.depth), task.expected, task.id);
  }
});

test("Node 環境では WASM 対応と判定される", () => {
  assert.equal(wasm.isWasmSupported(), true);
});
