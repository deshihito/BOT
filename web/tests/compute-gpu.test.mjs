// lib/compute-gpu.ts のホスト側（分割・エンコード）の検証。
// GPU 本体は Node では動かないため、分割した部分局面を CPU の perft で
// 数え直し、合計が元の perft やカタログの正解値と一致することを確かめる。
// WGSL 側は chess-perft.ts の移植なので、文面の存在チェックのみ行う。
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
// compute-gpu.ts の相対 import は data URL では解決できないため、
// 先に読み込んだ chess-perft モジュールへの参照に置き換える。
const gpu = await loadLib("compute-gpu.ts", (src) =>
  src.replace(
    /import\s*\{[^}]*\}\s*from\s*"\.\/chess-perft";/,
    "const { applyMove, generateLegalMoves, parseFen } = globalThis.__chessPerft;",
  ),
);
const catalog = await loadLib("compute-catalog.ts");

function sumSplit(fen, depth, target) {
  const { subs, baseCount } = gpu.splitForGpu(fen, depth, target);
  let total = baseCount;
  for (const sub of subs) {
    const pos = {
      board: Int8Array.from(sub.board),
      side: sub.side,
      castling: sub.castling,
      ep: sub.ep,
    };
    total += perft.perft(pos, sub.depth);
  }
  return { total, subs };
}

const STARTPOS = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const KIWIPETE = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";
const POS3 = "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1";

test("分割した部分局面の合計が元の perft と一致する", () => {
  assert.equal(sumSplit(STARTPOS, 4).total, 197281);
  assert.equal(sumSplit(KIWIPETE, 3).total, 97862);
  assert.equal(sumSplit(POS3, 5).total, 674624);
});

test("部分局面は十分な数に分かれ、残り深さが GPU の範囲に収まる", () => {
  const { subs } = gpu.splitForGpu(STARTPOS, 4);
  assert.ok(subs.length >= 100, `subs=${subs.length}`);
  for (const sub of subs) {
    assert.ok(sub.depth >= 1 && sub.depth <= gpu.MAX_GPU_DEPTH, `depth=${sub.depth}`);
    assert.equal(sub.board.length, 128);
  }
});

test("深さ0は baseCount=1 で確定し、ステイルメイトは0になる", () => {
  const zero = gpu.splitForGpu(STARTPOS, 0);
  assert.equal(zero.baseCount, 1);
  assert.equal(zero.subs.length, 0);
  // 黒番のステイルメイト（合法手なし）
  const mate = sumSplit("7k/5Q2/7K/8/8/8/8/8 b - - 0 1", 2);
  assert.equal(mate.total, 0);
  assert.equal(mate.subs.length, 0);
});

test("カタログの実タスクでも分割合計が正解値と一致する", () => {
  const task = catalog.COMPUTE_CATALOG.find((t) => t.expected <= 500000);
  assert.ok(task, "対象タスクが見つからない");
  assert.equal(sumSplit(task.fen, task.depth).total, task.expected);
});

test("エンコード形式が WGSL 側のレイアウトと一致する", () => {
  const { subs } = gpu.splitForGpu(STARTPOS, 2, 8);
  const data = gpu.encodeSubPositions(subs);
  assert.equal(data.length, 1 + subs.length * gpu.SUB_STRIDE);
  assert.equal(data[0], subs.length);
  const sub = subs[0];
  const base = 1;
  for (const sq of [0, 4, 27, 60, 119]) {
    assert.equal(data[base + sq], sub.board[sq], `sq=${sq}`);
  }
  assert.equal(data[base + 128], sub.side);
  assert.equal(data[base + 129], sub.castling);
  assert.equal(data[base + 130], sub.ep + 1);
  assert.equal(data[base + 131], sub.depth);
});

test("WGSL ソースに compute エントリポイントがある", () => {
  assert.match(gpu.WGSL_SOURCE, /@compute/);
  assert.match(gpu.WGSL_SOURCE, /@workgroup_size\(64\)/);
  assert.match(gpu.WGSL_SOURCE, /fn main\(/);
});

test("Node 環境では WebGPU 非対応と判定される", () => {
  assert.equal(gpu.isWebGpuSupported(), false);
});
