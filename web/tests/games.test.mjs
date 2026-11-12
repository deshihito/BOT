// WEB ゲーム（/games）の検証。
// - lib/games-catalog.ts: カタログの整合性
// - lib/chess-game.ts: 対局進行・終局判定・棋譜表記
// - lib/chess-engine.ts: 探索が詰みとタダ取りを見つけること
// - lib/chess-cpu.worker.js: 生成済みワーカーがプロトコルで正しく答えること
// chess-game / chess-engine は chess-perft への実行時 import を持つため、
// ワーカー生成（scripts/build-workers.mjs）と同じ「同梱」方式で読み込む。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const libDir = path.join(import.meta.dirname, "..", "lib");

function transpile(name) {
  const src = fs.readFileSync(path.join(libDir, name), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function stripModuleSyntax(code) {
  return code
    .split("\n")
    .filter((line) => !/^import\s/.test(line))
    .map((line) =>
      line
        .replace(/^export\s+(?=(const|let|var|function|class)\s)/, "")
        .replace(/^export\s+(?=async\s+function)/, "")
        .replace(/^export\s*\{[^}]*\};?\s*$/, ""),
    )
    .join("\n");
}

async function loadBundle(files, exportNames) {
  const code =
    files.map((name) => stripModuleSyntax(transpile(name))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

async function loadLib(name) {
  const js = transpile(name);
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

const catalog = await loadLib("games-catalog.ts");
const game = await loadBundle(
  ["chess-perft.ts", "chess-game.ts"],
  ["createGame", "applyUciMove", "legalMoves", "legalMovesFrom", "gameFen", "resignGame", "isInCheck", "positionToFen", "parseFen", "START_FEN", "WHITE", "BLACK"],
);
const engine = await loadBundle(
  ["chess-perft.ts", "chess-engine.ts"],
  ["findBestMove", "evaluatePosition", "parseFen"],
);

const START = game.START_FEN;

test("カタログ: スラッグが一意で、チェスがプレイ可能・アクティビティ対応", () => {
  const slugs = catalog.WEB_GAMES.map((g) => g.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  const chess = catalog.getWebGame("chess");
  assert.ok(chess);
  assert.equal(chess.status, "playable");
  assert.equal(chess.activity, true);
  assert.equal(catalog.getWebGame("does-not-exist"), undefined);
  assert.ok(catalog.playableGames().some((g) => g.slug === "chess"));
});

test("カタログ: glyph / accent フィールドは廃止され、参照も残っていない", () => {
  for (const g of catalog.WEB_GAMES) {
    assert.ok(!("glyph" in g), `${g.slug}: glyph が残っている`);
    assert.ok(!("accent" in g), `${g.slug}: accent が残っている`);
  }
  const gridSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "app", "games", "GamesGrid.tsx"), "utf8");
  assert.ok(!gridSrc.includes(".glyph"), "GamesGrid が glyph を参照している");
  assert.ok(!gridSrc.includes(".accent"), "GamesGrid が accent を参照している");
  const catalogSrc = fs.readFileSync(path.join(libDir, "games-catalog.ts"), "utf8");
  assert.ok(!catalogSrc.includes("glyph"), "カタログに glyph が残っている");
});

test("デイリー: jstDateKey は JST の日付を返す（UTC との境界）", () => {
  // 2026-11-11 16:00 UTC = 2026-11-12 01:00 JST
  assert.equal(catalog.jstDateKey(new Date(Date.UTC(2026, 10, 11, 16, 0))), "2026-11-12");
  // 2026-11-12 14:59 UTC = 2026-11-12 23:59 JST
  assert.equal(catalog.jstDateKey(new Date(Date.UTC(2026, 10, 12, 14, 59))), "2026-11-12");
  // 2026-11-12 15:00 UTC = 2026-11-13 00:00 JST
  assert.equal(catalog.jstDateKey(new Date(Date.UTC(2026, 10, 12, 15, 0))), "2026-11-13");
});

test("デイリー: dailyPicksFor は同じ日付で決定的に同じ3本を返す", () => {
  const day = new Date("2026-11-12T03:00:00+09:00");
  const a = catalog.dailyPicksFor(day).map((g) => g.slug);
  const b = catalog.dailyPicksFor(new Date("2026-11-12T23:30:00+09:00")).map((g) => g.slug);
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
  assert.equal(new Set(a).size, 3, "3本は互いに異なる");
  assert.ok(!a.includes("wordle"), "ワードルは別枠表示のため候補から除く");
  for (const slug of a) {
    assert.equal(catalog.getWebGame(slug).status, "playable", `${slug} は playable のみ`);
  }
  // 件数指定も効く
  assert.equal(catalog.dailyPicksFor(day, 5).length, 5);
  assert.deepEqual(
    catalog.dailyPicksFor(day, 5).slice(0, 3).map((g) => g.slug),
    a,
    "件数を増やしても先頭の顔ぶれは変わらない",
  );
});

test("デイリー: 日付が変われば顔ぶれが変わりうる", () => {
  const seen = new Set();
  for (let d = 0; d < 14; d++) {
    const day = new Date(Date.UTC(2026, 10, 12 + d, 3, 0)); // JST 正午
    seen.add(catalog.dailyPicksFor(day).map((g) => g.slug).join(","));
  }
  assert.ok(seen.size > 1, `14日とも同じ顔ぶれだった: ${[...seen][0]}`);
});

test("デイリー: ハブにデイリー帯とワードル連勝表示が配線されている", () => {
  const gridSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "app", "games", "GamesGrid.tsx"), "utf8");
  assert.ok(gridSrc.includes("今日のデイリー"), "デイリー帯の見出しが無い");
  assert.ok(gridSrc.includes("今日のワードル"), "ワードルのデイリー枠が無い");
  assert.ok(gridSrc.includes("dailyPicksFor"), "日替わり選出を使っていない");
  assert.ok(gridSrc.includes("ago-wordle-stats"), "ワードルの成績を読んでいない");
  assert.ok(gridSrc.includes("連勝中"), "連勝表示が無い");
});

test("初期局面: 合法手20・対局中・FEN が往復する", () => {
  const state = game.createGame();
  assert.equal(state.status, "playing");
  assert.equal(game.legalMoves(state).length, 20);
  assert.equal(game.gameFen(state), START);
  assert.equal(game.positionToFen(game.parseFen(START)), "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -");
});

test("着手の適用と SAN 表記（e4 e5 Nf3）", () => {
  let state = game.createGame();
  state = game.applyUciMove(state, "e2e4");
  assert.equal(state.position.side, game.BLACK);
  assert.deepEqual(state.sans, ["e4"]);
  state = game.applyUciMove(state, "e7e5");
  state = game.applyUciMove(state, "g1f3");
  assert.deepEqual(state.sans, ["e4", "e5", "Nf3"]);
  assert.equal(state.fullmoveNumber, 2);
});

test("合法手でない着手は例外になる", () => {
  assert.throws(() => game.applyUciMove(game.createGame(), "e2e5"));
});

test("フールズメイトでチェックメイト判定（黒の勝ち・棋譜に #）", () => {
  let state = game.createGame();
  for (const uci of ["f2f3", "e7e5", "g2g4", "d8h4"]) {
    state = game.applyUciMove(state, uci);
  }
  assert.equal(state.status, "checkmate");
  assert.equal(state.winner, game.BLACK);
  assert.equal(state.sans[state.sans.length - 1], "Qh4#");
  assert.equal(game.isInCheck(state.position, game.WHITE), true);
});

test("ステイルメイトは引き分け", () => {
  const state = game.createGame("k7/8/1Q6/8/8/8/8/K7 b - - 0 1");
  assert.equal(state.status, "draw");
  assert.equal(state.drawReason, "stalemate");
});

test("駒不足（K+N 対 K）は引き分け", () => {
  const state = game.createGame("8/8/4k3/8/8/3NK3/8/8 w - - 0 1");
  assert.equal(state.status, "draw");
  assert.equal(state.drawReason, "insufficient-material");
});

test("三度の同一局面で引き分け", () => {
  let state = game.createGame();
  for (const uci of ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"]) {
    state = game.applyUciMove(state, uci);
  }
  assert.equal(state.status, "draw");
  assert.equal(state.drawReason, "threefold-repetition");
});

test("50手ルール（半手 100）で引き分け", () => {
  let state = game.createGame("r3k3/8/8/8/8/8/8/R3K3 w Qq - 99 60");
  state = game.applyUciMove(state, "a1a2");
  assert.equal(state.status, "draw");
  assert.equal(state.drawReason, "fifty-move");
});

test("キャスリングの SAN は O-O", () => {
  let state = game.createGame("r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1");
  state = game.applyUciMove(state, "e1g1");
  assert.equal(state.sans[0], "O-O");
});

test("昇格の SAN は =Q を含む", () => {
  let state = game.createGame("8/P7/8/8/8/8/k6K/8 w - - 0 1");
  state = game.applyUciMove(state, "a7a8q");
  assert.match(state.sans[0], /^a8=Q\+?$/);
});

test("選択マスの合法手だけが返る", () => {
  const state = game.createGame();
  const e2 = 1 * 16 + 4; // e2 = rank2(1) file e(4)
  const moves = game.legalMovesFrom(state, e2).map((m) => m.uci).sort();
  assert.deepEqual(moves, ["e2e3", "e2e4"]);
});

test("投了で相手の勝ちになる", () => {
  const state = game.resignGame(game.createGame(), game.WHITE);
  assert.equal(state.status, "resigned");
  assert.equal(state.winner, game.BLACK);
});

test("エンジン: バックランクの1手詰めを見つける", () => {
  const pos = engine.parseFen("6k1/5ppp/8/8/8/8/8/R6K w - - 0 1");
  const result = engine.findBestMove(pos, { depth: 2, jitterCp: 0 });
  assert.ok(result);
  assert.equal(result.uci, "a1a8");
  assert.ok(result.score > 90_000, `詰みスコアのはず: ${result.score}`);
});

test("エンジン: タダのクイーンを取りに行く", () => {
  // e5 のナイトが d7 のクイーンを取れる（キングに取り返されても駒得）
  const pos = engine.parseFen("4k3/3q4/8/4N3/8/8/8/4K3 w - - 0 1");
  const result = engine.findBestMove(pos, { depth: 2, jitterCp: 0 });
  assert.ok(result);
  assert.equal(result.uci, "e5d7");
});

test("エンジン: 詰まされている局面では null を返す", () => {
  const pos = engine.parseFen("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3");
  assert.equal(engine.findBestMove(pos, { depth: 2, jitterCp: 0 }), null);
});

test("エンジン: 初期局面の評価は互角", () => {
  assert.equal(engine.evaluatePosition(engine.parseFen(START)), 0);
});

async function runChessWorker(fen, depth) {
  const code = fs.readFileSync(path.join(libDir, "chess-cpu.worker.js"), "utf8");
  assert.doesNotMatch(code, /^\s*(import|export)\s/m, "chess-cpu.worker.js に import/export が残っている");
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
    const unique = code + `\n// test-run:${Math.random()}`;
    await import("data:text/javascript;base64," + Buffer.from(unique).toString("base64"));
    assert.ok(handler, "chess-cpu.worker.js が message ハンドラを登録していない");
    handler({ data: { type: "search", requestId: 7, fen, depth, jitterCp: 0 } });
    return await posted;
  } finally {
    delete globalThis.self;
  }
}

test("盤面 CSS: 全マスが中身に依存しない均一な正方形になる構造", () => {
  const css = fs.readFileSync(path.join(import.meta.dirname, "..", "app", "globals.css"), "utf8");
  const block = (selector) => {
    const start = css.indexOf(selector + " {");
    assert.notEqual(start, -1, `${selector} が globals.css に無い`);
    return css.slice(start, css.indexOf("}", start));
  };
  const board = block(".chess-board");
  // 行・列とも minmax(0,1fr) で固定し、盤の正方形（aspect-ratio）から等分する。
  // 行が auto だと駒グリフのある段だけ高くなり、中央の空きマス段が潰れる。
  assert.match(board, /grid-template-columns:\s*repeat\(8,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(board, /grid-template-rows:\s*repeat\(8,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(board, /aspect-ratio:\s*1/);
  const square = block(".chess-square");
  // セルの最小サイズを 0 にし、中身（駒グリフ）がトラック寸法を押し広げないようにする。
  assert.match(square, /min-width:\s*0/);
  assert.match(square, /min-height:\s*0/);
  assert.match(square, /overflow:\s*hidden/);
});

test("生成済み CPU ワーカーが1手詰めを返す", async () => {
  const result = await runChessWorker("6k1/5ppp/8/8/8/8/8/R6K w - - 0 1", 2);
  assert.equal(result.type, "bestmove");
  assert.equal(result.requestId, 7);
  assert.equal(result.uci, "a1a8");
});
