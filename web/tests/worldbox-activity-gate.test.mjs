// AGO WORLD BOX の Discord Activity 入場の検証:
// - games-auth（Activity の SDK 認証のコード交換）が通常ログインと同じ
//   セッション Cookie を張ること
// - そのセッションで WORLD BOX の入場ゲートが通ること（Activity 内で
//   ゲートのログインリンクを押して白画面で詰まる問題の回帰防止）
// - クライアント配線（Activity 内では OAuth リンクを出さず、認証完了で
//   ゲートを引き直す）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const rootDir = path.join(import.meta.dirname, "..");
const libDir = path.join(rootDir, "lib");
const appDir = path.join(rootDir, "app");

function transpile(name, base = libDir) {
  const src = fs.readFileSync(path.join(base, name), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}

process.env.DISCORD_CLIENT_ID = "123456789012345678";
process.env.DISCORD_CLIENT_SECRET = ["unit", "test", "secret"].join("-");

const ME = "611111111111111111";

// next/server スタブ（cookies jar つき）
const nextServerStubUrl = dataUrl(`
class CookieJar {
  constructor() { this.map = new Map(); }
  set(name, value, options) { this.map.set(name, { name, value, options }); }
  get(name) { return this.map.get(name); }
}
export class NextResponse extends Response {
  constructor(body, init = {}) {
    super(body, init);
    this.cookies = new CookieJar();
  }
  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("Content-Type", "application/json");
    return new NextResponse(JSON.stringify(body), { status: init.status || 200, headers });
  }
  static redirect(url, init = {}) {
    const status = typeof init === "number" ? init : (init.status || 307);
    return new NextResponse(null, { status, headers: { Location: String(url) } });
  }
}
`);

const nextHeadersStubUrl = dataUrl(`
export function cookies() { throw new Error("not in request scope"); }
export function headers() { throw new Error("not in request scope"); }
`);

const siteUrl = dataUrl(transpile("site.ts"));
const subdomainUrl = dataUrl(transpile("subdomain.ts"));
const authUrl = dataUrl(
  transpile("auth.ts")
    .replaceAll('"next/headers"', JSON.stringify(nextHeadersStubUrl))
    .replaceAll('"./subdomain"', JSON.stringify(subdomainUrl)),
);
const discordActivityUrl = dataUrl(
  transpile("discord-activity.ts").replaceAll('"./site"', JSON.stringify(siteUrl)),
);

const activityAuthStubUrl = dataUrl(`
export async function exchangeDiscordActivityCode() {
  return {
    accessToken: "tok-test",
    user: { id: "${ME}", username: "tester", global_name: "Tester", avatar: null },
  };
}
`);
const dashboardStubUrl = dataUrl(`
export async function createWebSession() { return "sid-test"; }
`);

const gamesAuthRoute = await import(
  dataUrl(
    transpile("api/activity/games-auth/route.ts", appDir)
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/activity-auth"', JSON.stringify(activityAuthStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/dashboard"', JSON.stringify(dashboardStubUrl))
      .replaceAll('"@/lib/discord-activity"', JSON.stringify(discordActivityUrl)),
  ),
);
const gateRoute = await import(
  dataUrl(
    transpile("api/worldbox/gate/route.ts", appDir)
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl)),
  ),
);

const VERIFIER = "a".repeat(43);

test("activity: games-auth は identity を返し、通常ログインと同じセッションを張る", async () => {
  const res = await gamesAuthRoute.POST(new Request("https://example.test/api/activity/games-auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "code-1", codeVerifier: VERIFIER }),
  }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.user.id, ME);
  assert.equal(data.accessToken, "tok-test");
  const session = res.cookies.get("ago_session");
  assert.ok(session?.value, "ago_session Cookie が張られる");
});

test("activity: games-auth のセッションで WORLD BOX ゲートが通る", async () => {
  const res = await gamesAuthRoute.POST(new Request("https://example.test/api/activity/games-auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "code-1", codeVerifier: VERIFIER }),
  }));
  const session = res.cookies.get("ago_session");
  assert.ok(session?.value);
  const cookie = `ago_session=${encodeURIComponent(session.value)}`;
  const gateRes = await gateRoute.GET(new Request("https://example.test/api/worldbox/gate", {
    headers: { Cookie: cookie },
  }));
  assert.equal(gateRes.status, 200);
  assert.equal((await gateRes.json()).allowed, true, "Activity 認証のセッションでゲートが開く");
  const anonRes = await gateRoute.GET(new Request("https://example.test/api/worldbox/gate"));
  assert.equal((await anonRes.json()).allowed, false, "未ログインは従来どおり閉じる");
});

test("activity: クライアントは Activity 内で OAuth リンクを出さず、認証完了でゲートを引き直す", () => {
  const client = fs.readFileSync(path.join(appDir, "games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("useGamesNav()"), "Games の文脈を読む");
  assert.ok(client.includes("embedded"), "埋め込み判定を使う");
  assert.ok(client.includes("再試行"), "Activity 内は再試行ボタンを出す");
  assert.ok(client.includes("identityId"), "本人情報の到着でゲートを引き直す");
  assert.ok(client.includes("/api/auth/discord/authorize?next=/games/worldbox"), "通常 Web のログイン導線は残る");
});

test("activity: SDK 認証の本人情報が届いたらセッション確認を待たずにゲートを通す", () => {
  // ユーザー指示（2026-11-16）: Activity 経由では Discord ログイン済みが
  // 前提なので認証は要らないはず。この分岐が消えると、Cookie が保持
  // されない Activity の iframe で「ログインが必要」のまま詰まる
  // （2026-11-17 に実害が再発したため、文言ごと固定する）。
  const client = fs.readFileSync(path.join(appDir, "games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(
    client.includes('if (embedded && identityId) setGate("ok")'),
    "Activity では本人情報の到着でゲートを通す分岐が無い",
  );
  assert.ok(client.includes("retryIdentity"), "ゲート再試行が本人確認のやり直しに繋がっていない");
  const shell = fs.readFileSync(path.join(appDir, "games/GamesShell.tsx"), "utf8");
  assert.ok(shell.includes("retryIdentity"), "GamesShell が本人確認の再実行を提供していない");
});

// SDK 認証クライアント（lib/discord-activity-client.ts）を実物で読み、
// モック SDK + fetch で authorize のフォールバックを検証する。
const activityClient = await import(
  dataUrl(
    transpile("discord-activity-client.ts")
      .replaceAll('"./discord-activity"', JSON.stringify(discordActivityUrl)),
  ),
);

function fakeSdk(authorizeImpl) {
  return {
    commands: {
      authorize: authorizeImpl,
      authenticate: async () => ({
        user: { id: ME, username: "tester", global_name: "Tester", avatar: null },
      }),
    },
  };
}

async function withFetchStub(run) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ accessToken: "tok-test", user: { id: ME, name: "Tester", avatarUrl: "" } }),
  });
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("activity: 無言認証（prompt none）が失敗したら承認画面ありで再試行する", async () => {
  const prompts = [];
  const sdk = fakeSdk(async (args) => {
    prompts.push(args.prompt ?? null);
    if (args.prompt === "none") throw new Error("not authorized yet");
    return { code: "code-2" };
  });
  const identity = await withFetchStub(() => activityClient.authenticateDiscordIdentity(sdk, "123456789012345678"));
  assert.equal(identity?.id, ME, "初回ユーザーでも本人情報が届く");
  assert.deepEqual(prompts, ["none", null], "無言→承認画面ありの順で authorize する");
});

test("activity: 無言認証が通れば承認画面は出さない", async () => {
  const prompts = [];
  const sdk = fakeSdk(async (args) => {
    prompts.push(args.prompt ?? null);
    return { code: "code-1" };
  });
  const identity = await withFetchStub(() => activityClient.authenticateDiscordIdentity(sdk, "123456789012345678"));
  assert.equal(identity?.id, ME);
  assert.deepEqual(prompts, ["none"], "承認済みユーザーは無言認証だけで終わる");
});

test("activity: 承認画面ありでも失敗したら null（表示は通常どおり続ける）", async () => {
  const sdk = fakeSdk(async () => {
    throw new Error("user declined");
  });
  const identity = await withFetchStub(() => activityClient.authenticateDiscordIdentity(sdk, "123456789012345678"));
  assert.equal(identity, null);
});
