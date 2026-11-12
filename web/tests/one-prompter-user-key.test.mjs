// One Prompter の自前 API キー（暗号化保存・形式チェック・所有者分離）と
// キー管理ルート／生成ルートへの配線を、ネットワークなしで確かめる。
// lib/one-prompter-user-key.ts は "./bot-api"（→ "./dashboard-core"）を import
// するので、transpile 後に specifier を data URL へ差し替えて読み込む。
// bot_kv への実アクセスは行わない（暗号・検証などの純粋部分とソース配線を見る）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

function transpile(relPath) {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", relPath), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}

const read = (rel) => fs.readFileSync(path.join(import.meta.dirname, "..", rel), "utf8");

const coreUrl = dataUrl(transpile("lib/dashboard-core.ts"));
const botApiUrl = dataUrl(transpile("lib/bot-api.ts").replaceAll('"./dashboard-core"', JSON.stringify(coreUrl)));
const userKey = await import(
  dataUrl(transpile("lib/one-prompter-user-key.ts").replaceAll('"./bot-api"', JSON.stringify(botApiUrl)))
);

test("validateUserApiKey は形式が正しいキーだけを通す", () => {
  assert.equal(userKey.validateUserApiKey("sk-1234567890abcdef"), "sk-1234567890abcdef");
  assert.equal(userKey.validateUserApiKey("  sk-1234567890abcdef  "), "sk-1234567890abcdef");
  assert.equal(userKey.validateUserApiKey("short"), null);
  assert.equal(userKey.validateUserApiKey("x".repeat(201)), null);
  assert.equal(userKey.validateUserApiKey("has space in key"), null);
  assert.equal(userKey.validateUserApiKey("tab\tin\tkey"), null);
  assert.equal(userKey.validateUserApiKey(""), null);
  assert.equal(userKey.validateUserApiKey(undefined), null);
  assert.equal(userKey.validateUserApiKey(12345678), null);
  assert.equal(userKey.validateUserApiKey(null), null);
});

test("API キーは AES-256-GCM で暗号化され、復号が往復する。平文は保存形に含まれない", () => {
  const material = "op-test-" + "encryption-material";
  const apiKey = "dummy-" + "user-key-abcdefgh-wxyz";
  const stored = userKey.encryptApiKey(apiKey, material);
  assert.equal(stored.v, 1);
  assert.equal(stored.tail, "wxyz");
  assert.ok(!JSON.stringify(stored).includes(apiKey), "保存形に平文キーが含まれている");
  assert.equal(userKey.decryptApiKey(stored, material), apiKey);
  // 同じキーでも IV が毎回変わり、暗号文は一致しない
  const again = userKey.encryptApiKey(apiKey, material);
  assert.notEqual(again.data, stored.data);
  assert.notEqual(again.iv, stored.iv);
});

test("復号は鍵違い・改ざん・形式崩れで null に倒れる", () => {
  const stored = userKey.encryptApiKey("sk-abcdefgh-1234", "secret-A");
  assert.equal(userKey.decryptApiKey(stored, "secret-B"), null);
  assert.equal(userKey.decryptApiKey({ ...stored, data: Buffer.from("tampered!!").toString("base64") }, "secret-A"), null);
  assert.equal(userKey.decryptApiKey({ ...stored, tag: Buffer.from("0123456789abcdef").toString("base64") }, "secret-A"), null);
});

test("マスク表示は末尾4文字だけを出す", () => {
  assert.equal(userKey.maskUserApiKey("sk-1234567890wxyz"), "••••wxyz");
  assert.equal(userKey.maskFromTail("wxyz"), "••••wxyz");
});

test("isUserKeyEnabled は暗号鍵 env と Bot API 設定の両方が必要", () => {
  const names = ["ONE_PROMPTER_KEY_SECRET", "BOT_API_BASE_URL", "BOT_API_KEY"];
  const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  try {
    for (const k of names) delete process.env[k];
    assert.equal(userKey.isUserKeyEnabled(), false);
    process.env.ONE_PROMPTER_KEY_SECRET = "secret";
    assert.equal(userKey.isUserKeyEnabled(), false);
    process.env.BOT_API_BASE_URL = "http://localhost:9999";
    process.env.BOT_API_KEY = "bot-key";
    assert.equal(userKey.isUserKeyEnabled(), true);
    delete process.env.ONE_PROMPTER_KEY_SECRET;
    assert.equal(userKey.isUserKeyEnabled(), false);
  } finally {
    for (const k of names) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("キー管理ルートはログイン必須で、平文キーを返さない", () => {
  const route = read("app/api/one-prompter/key/route.ts");
  // 全ハンドラがセッションを要求する
  assert.equal((route.match(/getRequestSession\(request\)/g) || []).length, 3);
  assert.match(route, /status: 401/);
  // 所有者キーで出し分ける
  assert.match(route, /sessionOwnerKey\(session\)/);
  // 返すのは登録有無とマスクだけ
  assert.match(route, /maskFromTail\(meta\.tail\)/);
  assert.match(route, /maskUserApiKey\(apiKey\)/);
  assert.ok(!/NextResponse\.json\(\{[^}]*\bapiKey\s*:/.test(route), "レスポンスに平文キーが含まれている");
  // ログ出力でキーに触れない
  assert.ok(!route.includes("console."));
  // 登録は形式チェックのみ（外部 API を叩く検証をしない）
  assert.match(route, /validateUserApiKey\(body\.apiKey\)/);
  assert.ok(!route.includes("fetch("), "キー管理ルートが外部へ fetch している");
});

test("生成ルートはログイン中ユーザーの自前キーを読み、全 LLM 呼び出しへ渡す", () => {
  const route = read("app/api/one-prompter/route.ts");
  assert.match(route, /getRequestSession\(request\)/);
  assert.match(route, /loadUserApiKey\(sessionOwnerKey\(session\)\)/);
  // 共有キーも自前キーも無い場合だけフォールバックに倒す
  assert.match(route, /const hasAnyKey = logfareApiKeys\(\)\.length > 0 \|\| Boolean\(userApiKey\);/);
  assert.equal((route.match(/apiKey \}\)/g) || []).length, 4);
});

test("メニューのキーセクションはログイン中かつ機能有効時だけ出て、プロバイダ名を出さない", () => {
  const menu = read("app/one-prompter/OpMenu.tsx");
  assert.match(menu, /自分のAPIキー/);
  assert.match(menu, /userKeyEnabled && \(/);
  assert.match(menu, /fetch\("\/api\/one-prompter\/key"\)/);
  assert.match(menu, /method: "DELETE"/);
  assert.match(menu, /method: "POST"/);
  assert.match(menu, /type="password"/);
  assert.ok(!/logfare/i.test(menu), "メニューにプロバイダ名が出ている");
  const layout = read("app/one-prompter/layout.tsx");
  assert.match(layout, /userKeyEnabled={isUserKeyEnabled\(\)}/);
});
