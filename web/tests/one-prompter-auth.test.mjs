// One Prompter のログイン（共通セッションへの provider 追加・OAuth の戻り先・
// Google 認可フロー）を、ネットワークなしで確かめる。
// lib/auth.ts は "next/headers" と "./subdomain" を import するので、
// transpile 後に specifier をスタブ／実モジュールの data URL へ差し替えて読み込む。
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
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

const subdomainUrl = dataUrl(transpile("lib/subdomain.ts"));
const headersStubUrl = dataUrl("export async function cookies() { throw new Error('tests do not use cookies()'); }");
const authJs = transpile("lib/auth.ts")
  .replaceAll('"./subdomain"', JSON.stringify(subdomainUrl))
  .replaceAll('"next/headers"', JSON.stringify(headersStubUrl));
const auth = await import(dataUrl(authJs));

const SECRET = "op-test-secret";
process.env.DISCORD_SESSION_SECRET = SECRET;

function craftCookie(payload, secret = SECRET) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

test("createSession → readSessionInfo が往復し、provider 未指定は discord になる", () => {
  const value = auth.createSession({ id: "1320705325686587408", username: "ひと", avatar: "abc" });
  const info = auth.readSessionInfo(value);
  assert.equal(info.id, "1320705325686587408");
  assert.equal(info.username, "ひと");
  assert.equal(info.avatar, "abc");
  assert.equal(info.provider, "discord");
  assert.equal(info.sid, undefined);
});

test("Google ログインのセッションは provider=google を保持し、所有者キーがプロバイダで分かれる", () => {
  const value = auth.createSession({
    id: "123456789012345678901",
    username: "Google User",
    avatar: "https://example.com/picture.png",
    provider: "google",
  });
  const info = auth.readSessionInfo(value);
  assert.equal(info.provider, "google");
  assert.equal(info.avatar, "https://example.com/picture.png");
  assert.equal(auth.sessionOwnerKey(info), "google:123456789012345678901");
  assert.equal(auth.sessionOwnerKey({ provider: "discord", id: "123" }), "discord:123");
  // readSession 側にも provider が伝わる
  assert.equal(auth.readSession(value).provider, "google");
});

test("provider の無い旧セッションは discord として読める（後方互換）", () => {
  const legacy = craftCookie({ id: "999", username: "旧ユーザー", expiresAt: Date.now() + 60_000 });
  const info = auth.readSessionInfo(legacy);
  assert.equal(info.provider, "discord");
  assert.equal(info.avatar, null);
});

test("改ざん・期限切れ・形式不正のセッションは弾く", () => {
  const value = auth.createSession({ id: "123", username: "x" });
  const [encoded] = value.split(".");
  assert.equal(auth.readSessionInfo(`${encoded}.invalidsignature`), null);
  assert.equal(auth.readSessionInfo("not-a-session"), null);
  assert.equal(auth.readSessionInfo(undefined), null);
  assert.equal(auth.readSessionInfo(""), null);
  const expired = craftCookie({ id: "123", username: "x", expiresAt: Date.now() - 1000 });
  assert.equal(auth.readSessionInfo(expired), null);
  const badId = craftCookie({ id: "abc", username: "x", expiresAt: Date.now() + 60_000 });
  assert.equal(auth.readSessionInfo(badId), null);
  // 別シークレットで署名したものは通らない
  const foreign = craftCookie({ id: "123", username: "x", expiresAt: Date.now() + 60_000 }, "other-secret");
  assert.equal(auth.readSessionInfo(foreign), null);
});

test("resolveOAuthNext は同一サイト内のパスだけを許可する", () => {
  assert.equal(auth.resolveOAuthNext("/one-prompter"), "/one-prompter");
  assert.equal(auth.resolveOAuthNext("/dashboard"), "/dashboard");
  assert.equal(auth.resolveOAuthNext(undefined), "/dashboard");
  assert.equal(auth.resolveOAuthNext(null), "/dashboard");
  assert.equal(auth.resolveOAuthNext(""), "/dashboard");
  assert.equal(auth.resolveOAuthNext("https://evil.example/steal"), "/dashboard");
  assert.equal(auth.resolveOAuthNext("//evil.example/steal"), "/dashboard");
  assert.equal(auth.resolveOAuthNext("/\\evil.example"), "/dashboard");
  assert.equal(auth.resolveOAuthNext("/one prompter"), "/dashboard");
  assert.equal(auth.resolveOAuthNext("one-prompter"), "/dashboard");
  // fallback を差し替えられる（Google は /one-prompter、ログアウトは /）
  assert.equal(auth.resolveOAuthNext(undefined, "/one-prompter"), "/one-prompter");
  assert.equal(auth.resolveOAuthNext(undefined, "/"), "/");
  assert.equal(auth.resolveOAuthNext("/x", "/"), "/x");
});

test("isGoogleConfigured は3つの env が揃ったときだけ true", () => {
  const keys = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    assert.equal(auth.isGoogleConfigured(), false);
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    assert.equal(auth.isGoogleConfigured(), false);
    process.env.GOOGLE_REDIRECT_URI = "https://agobot.app/api/auth/google/callback";
    assert.equal(auth.isGoogleConfigured(), true);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("canonicalAuthorizeRedirect は別ホストからだけ正規ホストへ寄せ、クエリを引き継ぐ", () => {
  const redirectUri = "https://agobot.app/api/auth/discord/callback";
  const sub = new Request("https://localhost:3000/api/auth/discord/authorize?next=%2Fone-prompter", {
    headers: { "x-forwarded-host": "oneprompter.agobot.app" },
  });
  assert.equal(
    auth.canonicalAuthorizeRedirect(sub, "/api/auth/discord/authorize", redirectUri),
    "https://agobot.app/api/auth/discord/authorize?next=%2Fone-prompter",
  );
  const canonical = new Request("https://localhost:3000/api/auth/discord/authorize?next=%2Fone-prompter", {
    headers: { "x-forwarded-host": "agobot.app" },
  });
  assert.equal(auth.canonicalAuthorizeRedirect(canonical, "/api/auth/discord/authorize", redirectUri), null);
  // redirect_uri が不正・未設定なら寄せない（呼び出し側の未設定エラーに倒す）
  assert.equal(auth.canonicalAuthorizeRedirect(sub, "/api/auth/discord/authorize", undefined), null);
  assert.equal(auth.canonicalAuthorizeRedirect(sub, "/api/auth/discord/authorize", "not a url"), null);
});

test("Discord 認可・コールバックは next を運び、未指定では従来どおり /dashboard に着地する", () => {
  const authorize = read("app/api/auth/discord/authorize/route.ts");
  assert.match(authorize, /OAUTH_NEXT_COOKIE/);
  assert.match(authorize, /resolveOAuthNext\(new URL\(request\.url\)\.searchParams\.get\("next"\)\)/);
  assert.match(authorize, /canonicalAuthorizeRedirect/);
  const callback = read("app/api/auth/discord/callback/route.ts");
  assert.match(callback, /resolveOAuthNext\(readCookie\(request, OAUTH_NEXT_COOKIE\)\)/);
  assert.match(callback, /new URL\(next, publicOrigin\(request\)\)/);
  // 失敗時はダッシュボード経由だけ /login のエラー表示へ（それ以外は戻り先へ）
  assert.match(callback, /next === "\/dashboard" \? `\/login\?error=\$\{codeName\}` : next/);
  assert.match(callback, /provider: "discord" as const/);
});

test("Google 認可は最小スコープで、コールバックは userinfo から google セッションを作る", () => {
  const authorize = read("app/api/auth/google/authorize/route.ts");
  assert.match(authorize, /accounts\.google\.com\/o\/oauth2\/v2\/auth/);
  assert.match(authorize, /"openid profile email"/);
  assert.match(authorize, /GOOGLE_STATE_COOKIE/);
  assert.match(authorize, /isGoogleConfigured\(\)/);
  assert.match(authorize, /canonicalAuthorizeRedirect/);
  const callback = read("app/api/auth/google/callback/route.ts");
  assert.match(callback, /oauth2\.googleapis\.com\/token/);
  assert.match(callback, /openidconnect\.googleapis\.com\/v1\/userinfo/);
  assert.match(callback, /provider: "google" as const/);
  // Google ではダッシュボード用セッションレコードを作らない
  assert.ok(!callback.includes("createWebSession"));
  // クライアントシークレットをレスポンスやログへ出していない
  assert.ok(!callback.includes("console."));
  assert.ok(!authorize.includes("console."));
});

test("ログアウトは next を検証して戻り先に使い、未指定では従来どおりトップへ", () => {
  const logout = read("app/api/auth/logout/route.ts");
  assert.match(logout, /resolveOAuthNext\(new URL\(request\.url\)\.searchParams\.get\("next"\), "\/"\)/);
});
