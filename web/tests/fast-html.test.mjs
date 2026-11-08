// lib/fast-html.ts（fastHTML 配信ヘルパー）の純粋な部分を確かめる。
// Bot 自前 API への fetch は差し替えて、外部ネットワークには依存しない。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const src = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "fast-html.ts"), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

test("トークンは urlsafe な長さだけ許可し、パストラバーサルを弾く", () => {
  assert.equal(m.FAST_HTML_TOKEN.test("aB3-_xY9" + "q".repeat(24)), true);
  assert.equal(m.FAST_HTML_TOKEN.test("../secret"), false);
  assert.equal(m.FAST_HTML_TOKEN.test("short"), false);
  assert.equal(m.FAST_HTML_TOKEN.test("a".repeat(65)), false);
});

test("配信ヘッダは sandbox 隔離（same-origin / top-navigation なし）が必須", () => {
  const headers = m.fastHtmlContentHeaders();
  assert.equal(headers["Content-Type"], "text/html; charset=utf-8");
  const csp = headers["Content-Security-Policy"];
  assert.match(csp, /^sandbox /);
  assert.ok(csp.includes("allow-scripts"));
  assert.ok(!csp.includes("allow-same-origin"), "allow-same-origin は付けない");
  assert.ok(!csp.includes("allow-top-navigation"), "allow-top-navigation は付けない");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["Referrer-Policy"], "no-referrer");
  assert.equal(headers["Cache-Control"], "no-store");
  assert.equal(headers["X-Robots-Tag"], "noindex");
});

test("fetchFastHtml: 200 は生バイトを返し、認証ヘッダを付ける", async () => {
  process.env.BOT_API_BASE_URL = "http://127.0.0.1:8787";
  process.env.BOT_API_KEY = "test-key";
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response("<html>ok</html>", { status: 200 });
  };
  const result = await m.fetchFastHtml("a".repeat(32), fetchImpl);
  assert.equal(result.status, 200);
  assert.equal(new TextDecoder().decode(result.body), "<html>ok</html>");
  assert.equal(seen.url, "http://127.0.0.1:8787/v1/fast/" + "a".repeat(32));
  assert.equal(seen.init.headers.Authorization, "Bearer " + "test-key");
});

test("fetchFastHtml: 404/410 はそのまま伝播し、不正トークンは API を叩かない", async () => {
  process.env.BOT_API_BASE_URL = "http://127.0.0.1:8787";
  process.env.BOT_API_KEY = "test-key";
  const gone = await m.fetchFastHtml("b".repeat(32), async () => new Response("", { status: 410 }));
  assert.equal(gone.status, 410);
  const missing = await m.fetchFastHtml("c".repeat(32), async () => new Response("", { status: 404 }));
  assert.equal(missing.status, 404);
  let called = false;
  const invalid = await m.fetchFastHtml("../etc", async () => {
    called = true;
    return new Response("", { status: 200 });
  });
  assert.equal(invalid.status, 404);
  assert.equal(called, false);
});

test("fetchFastHtml: API 未設定・接続失敗は 503", async () => {
  delete process.env.BOT_API_BASE_URL;
  delete process.env.BOT_API_KEY;
  const unconfigured = await m.fetchFastHtml("d".repeat(32), async () => new Response("", { status: 200 }));
  assert.equal(unconfigured.status, 503);
  process.env.BOT_API_BASE_URL = "http://127.0.0.1:8787";
  process.env.BOT_API_KEY = "test-key";
  const failed = await m.fetchFastHtml("d".repeat(32), async () => {
    throw new Error("down");
  });
  assert.equal(failed.status, 503);
});

test("失効ページは固定文面で、ステータスで文言が変わる", () => {
  assert.match(m.fastHtmlGoneHtml(410), /期限切れ/);
  assert.match(m.fastHtmlGoneHtml(404), /見つかりません/);
  assert.match(m.fastHtmlGoneHtml(410), /noindex/);
});
