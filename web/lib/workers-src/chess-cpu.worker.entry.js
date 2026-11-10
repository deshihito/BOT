// ワーカーのエントリ（チェス CPU 対戦）。parseFen / findBestMove はバンドル時に
// chess-perft.ts / chess-engine.ts が同梱される前提で、import は書かない
// （scripts/build-workers.mjs が lib/chess-cpu.worker.js を生成する）。
// このファイルを直接編集対象とし、生成物は編集しないこと。
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "search") return;
  const started = Date.now();
  try {
    const pos = parseFen(data.fen);
    const result = findBestMove(pos, {
      depth: typeof data.depth === "number" ? data.depth : 3,
      jitterCp: typeof data.jitterCp === "number" ? data.jitterCp : 0,
    });
    self.postMessage({
      type: "bestmove",
      requestId: data.requestId,
      uci: result ? result.uci : null,
      score: result ? result.score : 0,
      elapsedMs: Date.now() - started,
    });
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId: data.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
