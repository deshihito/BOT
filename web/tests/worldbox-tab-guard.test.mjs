// AGO WORLD BOX タブ世代管理（同一アカウントの分身防止）のテスト。
// - presence.ts の tabVerdict（REST プレゼンスの世代判定）
// - relay-core の admitTab（WS 中継の世代判定）
// - ルート / オンライン層 / 中継ラッパー / クライアントの配線
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
const entry = (tab, tabAt, ts = NOW) => ({
  id: "p1", name: "n", x: 0, y: 0, vx: 0, vy: 0, face: 1, space: "world", tab, tabAt, ts,
});

test("tabVerdict: 申告なし・記録なし・鮮度切れは受理する", () => {
  assert.equal(presence.tabVerdict(null, { tab: "a", tabAt: 100 }, NOW), "accept");
  assert.equal(presence.tabVerdict(entry("a", 100), {}, NOW), "accept");
  assert.equal(presence.tabVerdict(entry(undefined, undefined), { tab: "b", tabAt: 50 }, NOW), "accept");
  // 鮮度切れ（10秒超）の保存エントリは世代を握らない
  assert.equal(presence.tabVerdict(entry("a", 100, NOW - 60_000), { tab: "b", tabAt: 50 }, NOW), "accept");
});

test("tabVerdict: 同じタブは受理、古いタブは拒否、新しいタブは世代交代で受理", () => {
  const stored = entry("tab-a", 1_000);
  assert.equal(presence.tabVerdict(stored, { tab: "tab-a", tabAt: 1_000 }, NOW), "accept");
  assert.equal(presence.tabVerdict(stored, { tab: "tab-b", tabAt: 2_000 }, NOW), "accept");
  assert.equal(presence.tabVerdict(stored, { tab: "tab-b", tabAt: 500 }, NOW), "reject");
  // 世代交代後は旧タブが拒否される
  const next = entry("tab-b", 2_000);
  assert.equal(presence.tabVerdict(next, { tab: "tab-a", tabAt: 1_000 }, NOW), "reject");
});

test("tabVerdict: 開始時刻が同値ならタブ ID の辞書順で決定的に決まる", () => {
  const stored = entry("tab-m", 1_000);
  assert.equal(presence.tabVerdict(stored, { tab: "tab-z", tabAt: 1_000 }, NOW), "accept");
  assert.equal(presence.tabVerdict(stored, { tab: "tab-a", tabAt: 1_000 }, NOW), "reject");
});

test("sanitizeHeartbeat: タブ申告は整形されて通る（不正値は落とす）", () => {
  const bounds = { minX: -100, maxX: 100, minY: -100, maxY: 100 };
  const hb = presence.sanitizeHeartbeat({ x: 1, y: 2, tab: "abc", tabAt: 123 }, bounds);
  assert.equal(hb.tab, "abc");
  assert.equal(hb.tabAt, 123);
  const bad = presence.sanitizeHeartbeat({ x: 1, y: 2, tab: 42, tabAt: -5 }, bounds);
  assert.equal(bad.tab, undefined);
  assert.equal(bad.tabAt, undefined);
});

test("admitTab: 世代交代で evict、旧世代は reject、申告なしは素通し", () => {
  const room = core.createRoom();
  assert.deepEqual(core.admitTab(room, "p1", "tab-a", 1_000), { verdict: "accept", evict: false });
  assert.deepEqual(core.admitTab(room, "p1", "tab-a", 1_000), { verdict: "accept", evict: false });
  assert.deepEqual(core.admitTab(room, "p1", "tab-b", 2_000), { verdict: "accept", evict: true });
  assert.deepEqual(core.admitTab(room, "p1", "tab-a", 1_000), { verdict: "reject", evict: false });
  assert.deepEqual(core.admitTab(room, "p2", undefined, undefined), { verdict: "accept", evict: false });
  // removePlayer で世代の記録も消える
  core.removePlayer(room, "p1");
  assert.deepEqual(core.admitTab(room, "p1", "tab-a", 1_000), { verdict: "accept", evict: false });
});

test("配線: ルートは 409 を返し、クライアントはタブを申告して 409/4001 で止まる", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/presence/route.ts"), "utf8");
  assert.match(route, /putPresenceTabGuarded/);
  assert.match(route, /tab_superseded/);
  assert.match(route, /status: 409/);
  const online = fs.readFileSync(path.join(libDir, "worldbox/presence-online.ts"), "utf8");
  assert.match(online, /export async function putPresenceTabGuarded/);
  const server = fs.readFileSync(path.join(rootDir, "realtime-server.js"), "utf8");
  assert.match(server, /admitTab/);
  assert.match(server, /4001/);
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.match(client, /tab: tabSession\.tab/);
  assert.match(client, /res\.status === 409/);
  assert.match(client, /ev\.code === 4001/);
  assert.match(client, /別のタブで開いています/);
});
