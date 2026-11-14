// Discord Activity 連携の純粋ロジック（lib/discord-activity.ts）と、
// 配線（middleware / GamesShell / OnlineShell / BALKU / games-auth）の検証。
// ローダは balku-room.test.mjs と同じ transpile + strip 方式。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const webDir = path.join(import.meta.dirname, "..");

function transpile(relPath) {
  const src = fs.readFileSync(path.join(webDir, relPath), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function stripModuleSyntax(code) {
  const lines = code.split("\n");
  const out = [];
  let skippingImport = false;
  for (const line of lines) {
    if (skippingImport) {
      if (line.includes(";")) skippingImport = false;
      continue;
    }
    if (/^import\s/.test(line)) {
      if (!line.includes(";")) skippingImport = true;
      continue;
    }
    out.push(
      line
        .replace(/^export\s+(?=(const|let|var|function|class)\s)/, "")
        .replace(/^export\s+(?=async\s+function)/, "")
        .replace(/^export\s*\{[^}]*\};?\s*$/, ""),
    );
  }
  return out.join("\n");
}

async function loadBundle(relPaths, exportNames) {
  const code =
    relPaths.map((p) => stripModuleSyntax(transpile(p))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const lib = await loadBundle(
  ["lib/site.ts", "lib/discord-activity.ts"],
  [
    "discordAvatarUrl",
    "buildDiscordIdentity",
    "normalizeRoomCode",
    "inviteUrlForGame",
    "roomCodeFromSearch",
    "shareCustomIdForRoom",
    "roomFromShareCustomId",
    "activityLandingPath",
  ],
);

test("アバター URL は CDN 形式で、ハッシュ無しはデフォルトアバターに倒す", () => {
  assert.equal(
    lib.discordAvatarUrl("1320705325686587408", "a_abcd1234"),
    "https://cdn.discordapp.com/avatars/1320705325686587408/a_abcd1234.png?size=64",
  );
  // (1320705325686587408 >> 22) % 6 = 0
  assert.equal(lib.discordAvatarUrl("1320705325686587408", null), "https://cdn.discordapp.com/embed/avatars/0.png");
  assert.equal(lib.discordAvatarUrl("1320705325686587408"), "https://cdn.discordapp.com/embed/avatars/0.png");
});

test("identity は global_name 優先で、名前は24文字に丸め、不正な形は null", () => {
  const identity = lib.buildDiscordIdentity({
    id: "1320705325686587408",
    username: "deshihito",
    global_name: "でし",
    avatar: "hash1",
  });
  assert.deepEqual(identity, {
    id: "1320705325686587408",
    name: "でし",
    avatarUrl: "https://cdn.discordapp.com/avatars/1320705325686587408/hash1.png?size=64",
  });
  // global_name が1文字なら username に倒す
  assert.equal(lib.buildDiscordIdentity({ id: "123", username: "player1", global_name: "あ" })?.name, "player1");
  // 24文字超は丸める
  const long = lib.buildDiscordIdentity({ id: "123", username: "x".repeat(40) });
  assert.equal(long?.name.length, 24);
  // ID が snowflake でない / 名前が取れないものは null
  assert.equal(lib.buildDiscordIdentity({ id: "abc", username: "player1" }), null);
  assert.equal(lib.buildDiscordIdentity({ id: "123", username: "" }), null);
  assert.equal(lib.buildDiscordIdentity(null), null);
  assert.equal(lib.buildDiscordIdentity(undefined), null);
});

test("招待リンクは公開オリジンで作られ、コードを往復できる", () => {
  assert.equal(lib.inviteUrlForGame("reversi", "abc234"), "https://agobot.app/games/reversi?room=ABC234");
  assert.equal(lib.inviteUrlForGame("balku", "ZZZ999"), "https://agobot.app/games/balku?room=ZZZ999");
  // コード規則（6文字・数字は2〜9）から外れるものや不正なゲーム ID は作らない
  assert.equal(lib.inviteUrlForGame("reversi", "ABC123"), null);
  assert.equal(lib.inviteUrlForGame("Bad Game", "ABC234"), null);
  assert.equal(lib.inviteUrlForGame("reversi", "ABC23"), null);

  assert.equal(lib.roomCodeFromSearch("?room=abc234&frame_id=x"), "ABC234");
  assert.equal(lib.roomCodeFromSearch("?frame_id=x"), null);
  assert.equal(lib.roomCodeFromSearch("?room=toolongcode"), null);
  assert.equal(lib.roomCodeFromSearch(""), null);

  assert.equal(lib.normalizeRoomCode("  abc234 "), "ABC234");
  assert.equal(lib.normalizeRoomCode(123456), null);
});

test("shareLink の custom_id にルーム宛先を運び、起動側で復元できる", () => {
  assert.equal(lib.shareCustomIdForRoom("daifugo", "abc234"), "room:daifugo:ABC234");
  assert.deepEqual(lib.roomFromShareCustomId("room:daifugo:ABC234"), { gameId: "daifugo", code: "ABC234" });
  assert.equal(lib.roomFromShareCustomId("room:daifugo:ABC123"), null);
  assert.equal(lib.roomFromShareCustomId("other:daifugo:ABC234"), null);
  assert.equal(lib.roomFromShareCustomId("room:daifugo"), null);
  assert.equal(lib.roomFromShareCustomId(null), null);
  assert.equal(lib.roomFromShareCustomId(""), null);
});

test("Activity 起動の着地は既定で /games、music 明示だけ /activity/music", () => {
  assert.equal(lib.activityLandingPath({ frameId: "f", instanceId: "i", activity: null }), "/games");
  assert.equal(lib.activityLandingPath({ frameId: "f", instanceId: "i", activity: "music" }), "/activity/music");
  assert.equal(lib.activityLandingPath({ frameId: "f", instanceId: "i", activity: "games" }), "/games");
  // Activity 起動パラメータが無ければ振り分けない
  assert.equal(lib.activityLandingPath({ frameId: null, instanceId: "i", activity: null }), null);
  assert.equal(lib.activityLandingPath({ frameId: "f", instanceId: null, activity: "music" }), null);
  assert.equal(lib.activityLandingPath({ frameId: undefined, instanceId: undefined, activity: undefined }), null);
});

// --- 配線の確認（ソースレベルの回帰防止） ---

function readSource(relPath) {
  return fs.readFileSync(path.join(webDir, relPath), "utf8");
}

test("middleware は Activity 着地を lib の振り分けで決める", () => {
  const src = readSource("middleware.ts");
  assert.ok(src.includes("activityLandingPath"), "middleware が activityLandingPath を使っていない");
  assert.ok(!src.includes('activityUrl.pathname = "/activity/music"'), "音楽への固定リダイレクトが残っている");
});

test("GamesShell は本人確認と shareLink 共有、custom_id 直送を持つ", () => {
  const src = readSource("app/games/GamesShell.tsx");
  assert.ok(src.includes("authenticateDiscordIdentity"), "GamesShell が本人確認を呼んでいない");
  assert.ok(src.includes("shareLink"), "GamesShell が shareLink を使っていない");
  assert.ok(src.includes("roomFromShareCustomId"), "GamesShell が custom_id を解釈していない");
  assert.ok(src.includes("/activity/music"), "埋め込みバーから音楽への導線が無い");
});

test("games-auth ルートはコード交換だけを行い、音楽用トークンを発行しない", () => {
  const src = readSource("app/api/activity/games-auth/route.ts");
  assert.ok(src.includes("exchangeDiscordActivityCode"), "コード交換ヘルパーを使っていない");
  assert.ok(src.includes("buildDiscordIdentity"), "identity を組み立てていない");
  assert.ok(!src.includes("createActivityToken"), "音楽用トークン発行が混入している");
});

test("OnlineShell は招待リンク・ディープリンク参加・ロビーのアバターを持つ", () => {
  const src = readSource("app/games/online/OnlineShell.tsx");
  assert.ok(src.includes("招待リンクをコピー"), "招待リンクのコピーが無い");
  assert.ok(src.includes("Discordで招待"), "Discord 共有ボタンが無い");
  assert.ok(src.includes("roomCodeFromSearch"), "?room= の解釈が無い");
  assert.ok(src.includes("このルームに参加"), "招待パネルが無い");
  assert.ok(src.includes("og-avatar"), "ロビーのアバター表示が無い");
  assert.ok(src.includes("avatarUrl: identity.avatarUrl"), "作成時にアバターを渡していない");
});

test("BALKU は招待リンクとディープリンク参加を持つ", () => {
  const src = readSource("app/games/balku/BalkuClient.tsx");
  assert.ok(src.includes("招待リンクをコピー"), "BALKU に招待リンクのコピーが無い");
  assert.ok(src.includes("roomCodeFromSearch"), "BALKU が ?room= を解釈していない");
  assert.ok(src.includes("への招待"), "BALKU に招待パネルが無い");
  assert.ok(src.includes('inviteUrlForGame("balku"'), "BALKU の招待 URL が balku 向けでない");
});

test("ハブに Discord 導線（DiscordPlayCta）がある", () => {
  const page = readSource("app/games/page.tsx");
  assert.ok(page.includes("DiscordPlayCta"), "/games ハブに Discord 導線が置かれていない");
  const cta = readSource("app/games/DiscordPlayCta.tsx");
  assert.ok(cta.includes("Discordで遊ぶ"), "通常ブラウザ向けの案内が無い");
  assert.ok(cta.includes("Discordアクティビティでプレイ中"), "Activity 内向けの表示が無い");
});
