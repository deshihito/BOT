// 分散コンピューティング用 Web Worker。
// UI スレッドを塞がないよう、perft 計算はこのワーカー内だけで行う。
import { perftFen } from "./chess-perft";

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
  try {
    const nodes = perftFen(data.fen, data.depth);
    ctx.postMessage({ type: "result", taskId: data.taskId, nodes, elapsedMs: Date.now() - started });
  } catch (error) {
    ctx.postMessage({
      type: "error",
      taskId: data.taskId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
