// 生成済みワーカー（lib/compute.worker.js / lib/compute-wasm.worker.js）が
// 自己完結していて、メッセージプロトコルで正しく計算できることを確かめる。
// 本番では相対 import の実ファイルが成果物に無く 404 で起動しなかった
// 事故があるため、import/export が無いこと自体もここで固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const libDir = path.join(import.meta.dirname, "..", "lib");

async function runWorker(file, fen, depth) {
  const code = fs.readFileSync(path.join(libDir, file), "utf8");
  assert.doesNotMatch(code, /^\s*(import|export)\s/m, `${file} に import/export が残っている`);
  let handler = null;
  const posted = new Promise((resolve) => {
    globalThis.self = {
      addEventListener: (type, fn) => {
        if (type === "message") handler = fn;
      },
      postMessage: resolve,
    };
  });
  try {
    // 同一コードの data URL は Node のモジュールキャッシュで再実行されない
    // ため、末尾にランダムなコメントを付けて毎回新しいモジュールとして読む
    const unique = code + `\n// test-run:${Math.random()}`;
    await import("data:text/javascript;base64," + Buffer.from(unique).toString("base64"));
    assert.ok(handler, `${file} が message ハンドラを登録していない`);
    handler({ data: { type: "run", taskId: "t1", fen, depth } });
    return await posted;
  } finally {
    delete globalThis.self;
  }
}

const STARTPOS = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const KIWIPETE = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1";

test("CPU ワーカーが既知値を返す", async () => {
  const result = await runWorker("compute.worker.js", STARTPOS, 3);
  assert.equal(result.type, "result");
  assert.equal(result.nodes, 8902);
  const result2 = await runWorker("compute.worker.js", KIWIPETE, 3);
  assert.equal(result2.nodes, 97862);
});

test("WASM ワーカーが既知値を返す", async () => {
  const result = await runWorker("compute-wasm.worker.js", STARTPOS, 3);
  assert.equal(result.type, "result");
  assert.equal(result.nodes, 8902);
  const result2 = await runWorker("compute-wasm.worker.js", KIWIPETE, 3);
  assert.equal(result2.nodes, 97862);
});
