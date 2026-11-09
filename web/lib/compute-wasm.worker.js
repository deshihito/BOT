// 分散コンピューティング用 Web Worker (WASM 実行方式)。
// compute.worker.js と同じメッセージプロトコルで、計算だけ WASM で行う。
// ※ .js でなければならない理由は compute.worker.js のコメントを参照。
import { perftFenWasm } from "./compute-wasm";

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
