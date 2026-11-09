// 分散コンピューティング用 Web Worker (WASM 実行方式)。
// compute.worker.ts と同じメッセージプロトコルで、計算だけ WASM で行う。
import { perftFenWasm } from "./compute-wasm";

type RunMessage = { type: "run"; taskId: string; fen: string; depth: number };
type ResultMessage = { type: "result"; taskId: string; nodes: number; elapsedMs: number };
type ErrorMessage = { type: "error"; taskId: string; message: string };

const ctx = self as unknown as {
  addEventListener: (type: "message", listener: (event: MessageEvent) => void) => void;
  postMessage: (message: ResultMessage | ErrorMessage) => void;
};

ctx.addEventListener("message", (event) => {
  const data = event.data as RunMessage | undefined;
  if (!data || data.type !== "run") return;
  const started = Date.now();
  perftFenWasm(data.fen, data.depth)
    .then((nodes) => {
      ctx.postMessage({ type: "result", taskId: data.taskId, nodes, elapsedMs: Date.now() - started });
    })
    .catch((error: unknown) => {
      ctx.postMessage({
        type: "error",
        taskId: data.taskId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
});
