// ワーカーのエントリ（本体）。perftFen はバンドル時に chess-perft.ts が
// 同梱される前提で、import は書かない（scripts/build-workers.mjs が
// lib/compute.worker.js を生成する）。このファイルを直接編集対象とし、
// 生成物は編集しないこと。
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "run") return;
  const started = Date.now();
  try {
    const nodes = perftFen(data.fen, data.depth);
    self.postMessage({ type: "result", taskId: data.taskId, nodes, elapsedMs: Date.now() - started });
  } catch (error) {
    self.postMessage({
      type: "error",
      taskId: data.taskId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
