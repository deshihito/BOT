// lib/fast-html.ts（fastHTML 配信ヘルパー）の純粋な部分を確かめる。
// サーバーは実体を保存せず、署名付きトークンを検証して Discord CDN から
// 中継するだけ。CDN fetch は差し替えて、外部ネットワークには依存しない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const src = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "fast-html.ts"), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

const KEY = "test-key";
process.env.BOT_API_KEY = KEY;

const CDN_URL =
  "https://cdn.discordapp.com/attachments/1234567890123456789/1234567890123456789/page.html" +
  "?ex=6735abcd1234ef56&is=67345abc1234ef56&hm=" +
  "a".repeat(64);
const MEDIA_URL =
  "https://media.discordapp.net/attachments/1234567890123456789/1234567890123456789/page.html" +
  "?ex=6735abcd&is=67345abc&hm=" +
  "b".repeat(64);

// Bot 側と同じ仕様でトークンを作る: v1.<base64url(payload)>.<base64url(HMAC)>
function makeToken(payload, key = KEY) {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", key).update(`v1.${payloadB64}`, "utf8").digest("base64url");
  return `v1.${payloadB64}.${sig}`;
}

const futureExp = () => Math.floor(Date.now() / 1000) + 3600;
const validToken = (url = CDN_URL) => makeToken({ u: url, exp: futureExp() });

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

test("専用ホスト（fast.agobot.app）でのみ allow-same-origin が付く", () => {
  const dedicated = m.fastHtmlContentHeaders("fast.agobot.app");
  const csp = dedicated["Content-Security-Policy"];
  assert.match(csp, /^sandbox /);
  assert.ok(csp.includes("allow-same-origin"), "専用ホストでは allow-same-origin を付ける");
  assert.ok(!csp.includes("allow-top-navigation"), "allow-top-navigation は付けない");
  // ポート付き・大文字の Host でも専用ホストとして扱う
  assert.ok(
    m.fastHtmlContentHeaders("FAST.agobot.app:3000")["Content-Security-Policy"].includes("allow-same-origin"),
  );
  // 本体ホスト・ホスト不明では付けない（従来どおり opaque origin で隔離）
  assert.ok(!m.fastHtmlContentHeaders("agobot.app")["Content-Security-Policy"].includes("allow-same-origin"));
  assert.ok(!m.fastHtmlContentHeaders(null)["Content-Security-Policy"].includes("allow-same-origin"));
  assert.ok(!m.fastHtmlContentHeaders()["Content-Security-Policy"].includes("allow-same-origin"));
});

test("fetchFastHtml: 正しい署名なら CDN から中継し、認証情報は付けない", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response("<html>ok</html>", { status: 200 });
  };
  const result = await m.fetchFastHtml(validToken(), fetchImpl);
  assert.equal(result.status, 200);
  assert.equal(new TextDecoder().decode(result.body), "<html>ok</html>");
  assert.equal(seen.url, CDN_URL);
  assert.equal(seen.init.headers, undefined);
});

test("fetchFastHtml: media.discordapp.net の URL も中継できる", async () => {
  const result = await m.fetchFastHtml(
    validToken(MEDIA_URL),
    async () => new Response("<html>m</html>", { status: 200 }),
  );
  assert.equal(result.status, 200);
});

test("fetchFastHtml: 改竄された payload は署名不一致で 404（CDN を叩かない）", async () => {
  const [version, _payload, sig] = validToken().split(".");
  const forgedPayload = Buffer.from(
    JSON.stringify({ u: CDN_URL, exp: 9999999999 }),
    "utf8",
  ).toString("base64url");
  let called = false;
  const result = await m.fetchFastHtml(`${version}.${forgedPayload}.${sig}`, async () => {
    called = true;
    return new Response("", { status: 200 });
  });
  assert.equal(result.status, 404);
  assert.equal(called, false);
});

test("fetchFastHtml: 違う鍵の署名・形式不正は 404", async () => {
  const wrongKey = makeToken({ u: CDN_URL, exp: futureExp() }, "another-key");
  const ok = async () => new Response("", { status: 200 });
  assert.equal((await m.fetchFastHtml(wrongKey, ok)).status, 404);
  assert.equal((await m.fetchFastHtml("not-a-token", ok)).status, 404);
  assert.equal((await m.fetchFastHtml("v1.onlytwo", ok)).status, 404);
  assert.equal((await m.fetchFastHtml("v2.x.y", ok)).status, 404);
  assert.equal((await m.fetchFastHtml("", ok)).status, 404);
});

test("fetchFastHtml: 期限切れは 410（CDN を叩かない）", async () => {
  const expired = makeToken({ u: CDN_URL, exp: Math.floor(Date.now() / 1000) - 10 });
  let called = false;
  const result = await m.fetchFastHtml(expired, async () => {
    called = true;
    return new Response("", { status: 200 });
  });
  assert.equal(result.status, 410);
  assert.equal(called, false);
});

test("fetchFastHtml: CDN allowlist 外の URL は署名が正しくても 404", async () => {
  const ok = async () => new Response("", { status: 200 });
  const evil = makeToken({ u: "https://example.com/attachments/1/2/a.html", exp: futureExp() });
  assert.equal((await m.fetchFastHtml(evil, ok)).status, 404);
  const wrongPath = makeToken({
    u: "https://cdn.discordapp.com/other/1/2/a.html",
    exp: futureExp(),
  });
  assert.equal((await m.fetchFastHtml(wrongPath, ok)).status, 404);
  const http = makeToken({
    u: "http://cdn.discordapp.com/attachments/1/2/a.html",
    exp: futureExp(),
  });
  assert.equal((await m.fetchFastHtml(http, ok)).status, 404);
});

test("fetchFastHtml: CDN の 404/403 は失効として 410", async () => {
  const notFound = await m.fetchFastHtml(
    validToken(),
    async () => new Response("", { status: 404 }),
  );
  assert.equal(notFound.status, 410);
  const forbidden = await m.fetchFastHtml(
    validToken(),
    async () => new Response("", { status: 403 }),
  );
  assert.equal(forbidden.status, 410);
});

test("fetchFastHtml: 5MB 超は 413（Content-Length 申告時）", async () => {
  const result = await m.fetchFastHtml(
    validToken(),
    async () =>
      new Response("x", {
        status: 200,
        headers: { "content-length": String(5 * 1024 * 1024 + 1) },
      }),
  );
  assert.equal(result.status, 413);
});

test("fetchFastHtml: 5MB 超は 413（ストリームで読みながら超過）", async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(120);
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(chunk);
    },
  });
  const result = await m.fetchFastHtml(
    validToken(),
    async () => new Response(stream, { status: 200 }),
  );
  assert.equal(result.status, 413);
});

test("fetchFastHtml: BOT_API_KEY 未設定は 503、CDN 接続失敗は 503", async () => {
  delete process.env.BOT_API_KEY;
  try {
    const unconfigured = await m.fetchFastHtml(
      validToken(),
      async () => new Response("", { status: 200 }),
    );
    assert.equal(unconfigured.status, 503);
  } finally {
    process.env.BOT_API_KEY = KEY;
  }
  const failed = await m.fetchFastHtml(validToken(), async () => {
    throw new Error("down");
  });
  assert.equal(failed.status, 503);
});

test("失効ページは固定文面で、ステータスで文言が変わる", () => {
  assert.match(m.fastHtmlGoneHtml(410), /期限切れ/);
  assert.match(m.fastHtmlGoneHtml(404), /見つかりません/);
  assert.match(m.fastHtmlGoneHtml(413), /大きすぎます/);
  assert.match(m.fastHtmlGoneHtml(410), /noindex/);
});
