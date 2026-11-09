// ワーカーのエントリ（WASM 方式・本体）。perftFenWasm はバンドル時に
// compute-wasm.ts が同梱される前提で、import は書かない
// （scripts/build-workers.mjs が lib/compute-wasm.worker.js を生成する）。
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "run") return;
  const started = Date.now();
  perftFenWasm(data.fen, data.depth)
    .then((nodes) => {
      self.postMessage({ type: "result", taskId: data.taskId, nodes, elapsedMs: Date.now() - started });
    })
    .catch((error) => {
      self.postMessage({
        type: "error",
        taskId: data.taskId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
});
