// 分散コンピューティング用 Web Worker。
// UI スレッドを塞がないよう、perft 計算はこのワーカー内だけで行う。
// ※ このファイルは .js でなければならない: ビルド成果物のファイル名が
//   元ファイルの拡張子を引き継ぎ、.ts だと配信サーバーが video/mp2t を
//   返してモジュールワーカーとして読み込めなくなるため。
import { perftFen } from "./chess-perft";

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
