// AGO WORLD BOX 地面ドロップの検証:
// - 純粋ロジック（parse / TTL / 上限 / 回収 / 距離）
// - dropItem 遷移（かばんから減る、コインは動かない）
// - ground-items ルート（GET 一覧 / pickup の距離・空間・二重拾い）
// - クライアント配線（描画・タップ・パネルの捨てるボタン）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const rootDir = path.join(import.meta.dirname, "..");
const libDir = path.join(rootDir, "lib");

function transpile(name, base = libDir) {
  const src = fs.readFileSync(path.join(base, name), "utf8");
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
function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}
function bundleUrl(files, exportNames) {
  const code =
    files.map((name) => stripModuleSyntax(transpile(name))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  return dataUrl(code);
}
async function loadBundle(files, exportNames) {
  return import(bundleUrl(files, exportNames));
}

const gi = await loadBundle(
  ["worldbox/ground-items.ts"],
  ["GROUND_ITEMS_CAP", "GROUND_ITEM_TTL_MS", "parseGroundItems", "serializeGroundItems", "pruneGroundItems", "addGroundItem", "takeGroundItem", "groundItemAt", "canPickupAt"],
);
const eco = await loadBundle(
  ["worldbox/items.ts", "worldbox/profile.ts", "worldbox/vitals.ts", "worldbox/economy.ts"],
  ["dropItem", "parseProfile"],
);

const item = (id, at = 1000) => ({ id, itemId: "wood", count: 2, x: 10, y: 10, at });

test("parse: 不正な形は捨て、座標と個数は整数化する", () => {
  const list = gi.parseGroundItems({
    items: [
      { id: "a", itemId: "wood", count: 2.7, x: 10.4, y: 9.6, at: 100 },
      { id: "", itemId: "wood", count: 1, x: 0, y: 0, at: 0 },
      { id: "b", itemId: "wood", count: 0, x: 0, y: 0, at: 0 },
      "junk",
    ],
  });
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { id: "a", itemId: "wood", count: 2, x: 10, y: 9, at: 100 });
  assert.deepEqual(gi.parseGroundItems(null), []);
  assert.deepEqual(gi.parseGroundItems({ items: "x" }), []);
  const round = gi.parseGroundItems(gi.serializeGroundItems([item("z")]));
  assert.equal(round.length, 1);
  assert.equal(round[0].id, "z");
});

test("prune / add: TTL で消え、上限を超えたら古い順に落ちる", () => {
  const now = gi.GROUND_ITEM_TTL_MS + 5000;
  const pruned = gi.pruneGroundItems([item("old", 1000), item("new", now)], now);
  assert.deepEqual(pruned.map((i) => i.id), ["new"]);
  let list = [];
  for (let i = 0; i < gi.GROUND_ITEMS_CAP + 5; i++) list = gi.addGroundItem(list, item(`d${i}`, 2000), 2000);
  assert.equal(list.length, gi.GROUND_ITEMS_CAP);
  assert.equal(list[0].id, "d5");
});

test("take / at / canPickup: 回収と距離判定", () => {
  const list = [item("a"), { ...item("b"), x: 20, y: 20 }];
  const taken = gi.takeGroundItem(list, "a");
  assert.equal(taken.item.id, "a");
  assert.equal(taken.rest.length, 1);
  assert.equal(gi.takeGroundItem(list, "missing"), null);
  assert.equal(gi.groundItemAt(list, 20, 20).id, "b");
  assert.equal(gi.groundItemAt(list, 0, 0), null);
  assert.equal(gi.canPickupAt(list[0], 12, 8), true); // チェビシェフ 2
  assert.equal(gi.canPickupAt(list[0], 13, 10), false); // 3 は届かない
});

test("dropItem: かばんから減り、コインは動かない", () => {
  const profile = eco.parseProfile({ items: { wood: 5 } });
  const ok = eco.dropItem(profile, "wood", 2);
  assert.equal(ok.ok, true);
  assert.equal(ok.coin, undefined);
  assert.deepEqual(ok.dropped, { itemId: "wood", count: 2 });
  assert.equal(ok.profile.items.wood, 3);
  assert.equal(eco.dropItem(profile, "wood", 6).error, "not_enough_items");
  assert.equal(eco.dropItem(profile, "nope", 1).error, "unknown_item");
  assert.equal(eco.dropItem(profile, "wood", 0).error, "invalid_count");
});

// ---------- ground-items ルート（オンライン層はメモリスタブ） ----------

const nextServerStubUrl = dataUrl(`
export const NextResponse = {
  json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(body), { status: init.status || 200, headers });
  },
};
`);
const authUrl = dataUrl(`
export function getRequestSession(request) {
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/ago_session=([^;]+)/);
  if (!m) return null;
  const [provider, userId] = decodeURIComponent(m[1]).split(":");
  return { provider, userId, name: "tester" };
}
export function sessionOwnerKey(session) { return session.provider + ":" + session.userId; }
`);
const groundOnlineStubUrl = dataUrl(`
const spaces = (globalThis.__wbGroundSpaces = new Map());
export function isGroundItemsEnabled() { return true; }
export function isValidGroundSpace(space) { return typeof space === "string" && /^[a-z0-9_:,-]{1,64}$/.test(space); }
export async function loadGroundItems(space) { return [...(spaces.get(space) ?? [])]; }
export async function addGroundItemDrop(space, item) { const l = spaces.get(space) ?? []; l.push(item); spaces.set(space, l); return true; }
export async function takeGroundItemDrop(space, id) {
  const l = spaces.get(space) ?? [];
  const i = l.findIndex((g) => g.id === id);
  if (i < 0) return null;
  const [taken] = l.splice(i, 1);
  spaces.set(space, l);
  return taken;
}
export async function loadMyPosition() { return globalThis.__wbMyPosition ?? null; }
`);
const profileUrl = bundleUrl(["worldbox/items.ts", "worldbox/profile.ts"], ["addItem"]);
const profileOnlineStubUrl = dataUrl(`
const store = (globalThis.__wbGroundProfiles = new Map());
export async function loadProfile(key) { return store.get(key) ?? { coins: 0, hunger: 100, items: {} }; }
export async function storeProfile(key, profile) { store.set(key, profile); return true; }
`);

const groundRoute = await import(
  dataUrl(
    transpile("api/worldbox/ground-items/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/worldbox/ground-items"', JSON.stringify(bundleUrl(["worldbox/ground-items.ts"], ["canPickupAt"])))
      .replaceAll('"@/lib/worldbox/ground-items-online"', JSON.stringify(groundOnlineStubUrl))
      .replaceAll('"@/lib/worldbox/profile"', JSON.stringify(profileUrl))
      .replaceAll('"@/lib/worldbox/profile-online"', JSON.stringify(profileOnlineStubUrl)),
  ),
);

function apiRequest(url, method, cookie, body) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const COOKIE = "ago_session=" + encodeURIComponent("discord:111111111111111111");
const URL_G = "http://localhost/api/worldbox/ground-items";

test("API(ground): GET は空間のドロップ一覧を返し、未ログインは 401", async () => {
  globalThis.__wbGroundSpaces.clear();
  globalThis.__wbGroundSpaces.set("world", [item("g1")]);
  const ok = await groundRoute.GET(apiRequest(`${URL_G}?space=world`, "GET", COOKIE));
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].id, "g1");
  const denied = await groundRoute.GET(apiRequest(`${URL_G}?space=world`, "GET", null));
  assert.equal(denied.status, 401);
  const bad = await groundRoute.GET(apiRequest(`${URL_G}?space=!!`, "GET", COOKIE));
  assert.equal(bad.status, 400);
});

test("API(ground): pickup は近くのドロップだけ拾え、二重拾いはできない", async () => {
  globalThis.__wbGroundSpaces.clear();
  globalThis.__wbGroundProfiles.clear();
  globalThis.__wbGroundSpaces.set("world", [item("g1"), { ...item("g2"), x: 40, y: 40 }]);
  globalThis.__wbMyPosition = { space: "world", tx: 11, ty: 10 };
  const far = await groundRoute.POST(apiRequest(URL_G, "POST", COOKIE, { action: "pickup", space: "world", id: "g2" }));
  assert.equal(far.status, 409);
  assert.equal((await far.json()).error, "too_far");
  const res = await groundRoute.POST(apiRequest(URL_G, "POST", COOKIE, { action: "pickup", space: "world", id: "g1" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.picked, { itemId: "wood", count: 2 });
  assert.equal(body.profile.items.wood, 2);
  const again = await groundRoute.POST(apiRequest(URL_G, "POST", COOKIE, { action: "pickup", space: "world", id: "g1" }));
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error, "already_taken");
  const wrongSpace = await groundRoute.POST(apiRequest(URL_G, "POST", COOKIE, { action: "pickup", space: "lobby", id: "g2" }));
  assert.equal(wrongSpace.status, 409);
  assert.equal((await wrongSpace.json()).error, "wrong_space");
});

test("クライアント配線: 描画・タップ・ポーリングとパネルの捨てるボタンがある", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("groundItemsRef"));
  assert.ok(client.includes("/api/worldbox/ground-items?space="));
  assert.ok(client.includes('action: "pickup"'));
  const panel = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxEconomyPanel.tsx"), "utf8");
  assert.ok(panel.includes('action: "drop"'));
  assert.ok(panel.includes("捨てる"));
});
