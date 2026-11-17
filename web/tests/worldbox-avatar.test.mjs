// WORLD BOX アバター = ユーザーアイコン（Discord アバター）のテスト。
// - avatar はサーバーがセッションから付与する（クライアント申告は通さない）
// - REST: プレゼンスルートが付与 → bot_kv → parsePresenceEntry が復元
// - WS: 中継トークンの av クレーム → relay がエントリへ付与 → snap/up/集約書き込み
// - クライアント: 自分は /api/auth/me、他者は entry.avatar で円形アイコン描画
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const rootDir = path.join(import.meta.dirname, "..");
const libDir = path.join(rootDir, "lib");
const require = createRequire(import.meta.url);
const core = require(path.join(rootDir, "realtime", "relay-core.js"));

function transpile(name, base = libDir) {
  const src = fs.readFileSync(path.join(base, name), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}

const presence = await import(dataUrl(transpile("worldbox/presence.ts")));

const NOW = 1_700_000_000_000;
const AV = "https://cdn.discordapp.com/avatars/123456789/abcdef.png?size=64";
const BOUNDS = { minX: -100, maxX: 100, minY: -100, maxY: 100 };

test("sanitizeHeartbeat: クライアント申告の avatar は通さない", () => {
  const hb = presence.sanitizeHeartbeat({ x: 1, y: 2, space: "world", avatar: AV }, BOUNDS);
  assert.ok(hb);
  assert.equal("avatar" in hb, false);
});

test("sanitizeAvatarUrl: https の素直な URL だけ通す", () => {
  assert.equal(presence.sanitizeAvatarUrl(AV), AV);
  assert.equal(presence.sanitizeAvatarUrl("https://lh3.googleusercontent.com/a/abc"), "https://lh3.googleusercontent.com/a/abc");
  assert.equal(presence.sanitizeAvatarUrl("http://cdn.discordapp.com/avatars/1/a.png"), null);
  assert.equal(presence.sanitizeAvatarUrl("javascript:alert(1)"), null);
  assert.equal(presence.sanitizeAvatarUrl("https://example.com/a b.png"), null);
  assert.equal(presence.sanitizeAvatarUrl('https://example.com/a".png'), null);
  assert.equal(presence.sanitizeAvatarUrl("https://example.com/" + "a".repeat(300)), null);
  assert.equal(presence.sanitizeAvatarUrl(42), null);
  assert.equal(presence.sanitizeAvatarUrl(null), null);
});

test("parsePresenceEntry: 保存済み avatar を復元し、不正値は落とす", () => {
  const stored = JSON.stringify({ name: "n", x: 1, y: 2, vx: 0, vy: 0, face: 1, space: "world", avatar: AV, ts: NOW });
  const e = presence.parsePresenceEntry("p1", stored);
  assert.ok(e);
  assert.equal(e.avatar, AV);
  const bad = JSON.stringify({ name: "n", x: 1, y: 2, vx: 0, vy: 0, face: 1, space: "world", avatar: "http://evil.example/x.png", ts: NOW });
  const e2 = presence.parsePresenceEntry("p1", bad);
  assert.ok(e2);
  assert.equal("avatar" in e2, false);
  const none = JSON.stringify({ name: "n", x: 1, y: 2, vx: 0, vy: 0, face: 1, space: "world", ts: NOW });
  const e3 = presence.parsePresenceEntry("p1", none);
  assert.ok(e3);
  assert.equal("avatar" in e3, false);
});

const SECRET = "avatar-test-secret";
const tokenWith = (payload) => core.signToken({ exp: NOW + 60_000, ...payload }, SECRET);

test("verifyToken: av クレームを検証して返す（旧トークン・不正値は null）", () => {
  const ok = core.verifyToken(tokenWith({ pid: "p1", name: "n", ok: "k", av: AV }), SECRET, NOW);
  assert.equal(ok.av, AV);
  const legacy = core.verifyToken(tokenWith({ pid: "p1", name: "n", ok: "k" }), SECRET, NOW);
  assert.equal(legacy.av, null);
  const bad = core.verifyToken(tokenWith({ pid: "p1", name: "n", ok: "k", av: "http://evil.example/x" }), SECRET, NOW);
  assert.equal(bad.av, null);
});

test("acceptHeartbeat + snapshot + presenceKvValue: avatar がエントリと集約書き込みに載る", () => {
  const room = core.createRoom();
  const entry = core.acceptHeartbeat(room, "p1", "n", { x: 5, y: 5, space: "world" }, NOW, null, AV);
  assert.equal(entry.avatar, AV);
  const snap = core.snapshot(room, "world", "someone-else", NOW);
  assert.equal(snap.length, 1);
  assert.equal(snap[0].avatar, AV);
  const kv = JSON.parse(core.presenceKvValue(entry));
  assert.equal(kv.avatar, AV);
  // avatar 無しでは載らない
  const room2 = core.createRoom();
  const plain = core.acceptHeartbeat(room2, "p2", "m", { x: 5, y: 5, space: "world" }, NOW, null, null);
  assert.equal("avatar" in plain, false);
  assert.equal("avatar" in JSON.parse(core.presenceKvValue(plain)), false);
});

test("配線: ルート/トークン/ラッパー/クライアント", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/presence/route.ts"), "utf8");
  assert.match(route, /sessionAvatarUrl\(session\)/);
  assert.match(route, /\{ \.\.\.heartbeat, name, \.\.\.\(avatar \? \{ avatar \} : \{\}\) \}/);
  const token = fs.readFileSync(path.join(libDir, "worldbox/realtime-token.ts"), "utf8");
  assert.match(token, /av: avatarUrl/);
  const wrapper = fs.readFileSync(path.join(rootDir, "realtime-server.js"), "utf8");
  assert.match(wrapper, /avatar: auth\.av \?\? null/);
  assert.match(wrapper, /info\.baseline, info\.avatar\)/);
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.match(client, /iconFor\(o\.track\.entry\.avatar\)/);
  assert.match(client, /iconFor\(myIconUrl\)/);
  assert.match(client, /fetch\("\/api\/auth\/me"\)/);
  // NPC の描画はアイコン無し（従来キャラのまま）
  assert.match(client, /draw: \(\) => drawAvatar\(ctx, Math\.round\(lobbyOx \+ \(n\.x \+ 0\.5\) \* TILE\), Math\.round\(lobbyOy \+ \(n\.y \+ 1\) \* TILE\), 1, 0, 0, null\)/);
});
