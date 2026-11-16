// AGO WORLD BOX 即時 spend の無担保交付の是正（B2・構造問題#4）の検証:
// - profile の売買・強化: 決済オプが failed なら交付したプロフィールを巻き戻す
// - テント拡張: failed なら段階を上げない。再試行は失敗オプを消して積み直す
// - 転職: failed なら役職を元へ戻す
// - pending のままなら従来どおり交付する（フォールバック維持）
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

function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}

process.env.DISCORD_SESSION_SECRET = "worldbox-delivery-gate-test";

const botStubUrl = dataUrl(`
const store = new Map();
const users = new Map();
globalThis.__wbDgStore = store;
globalThis.__wbDgUsers = users;
export function isBotApiConfigured() { return true; }
export async function kvGet(ns, key) { const v = store.get(ns + " " + key); return v === undefined ? null : v; }
export async function kvSet(ns, key, value) { store.set(ns + " " + key, value); }
export async function kvDelete(ns, key) { store.delete(ns + " " + key); }
export async function kvList(ns) {
  const m = new Map();
  for (const [k, v] of store) if (k.startsWith(ns + " ")) m.set(k.slice(ns.length + 1), v);
  return m;
}
export async function tableSelect(table, columns, filters, limit) {
  if (table !== "users") throw new Error("unexpected table " + table);
  const id = filters.find((f) => f.column === "user_id")?.value;
  if (!users.has(id)) return [];
  return [{ balance: users.get(id) }];
}
`);
const subdomainUrl = dataUrl(transpile("subdomain.ts"));
const headersStubUrl = dataUrl("export async function cookies() { throw new Error('tests do not use cookies()'); }");
const authUrl = dataUrl(
  transpile("auth.ts").replaceAll('"./subdomain"', JSON.stringify(subdomainUrl)).replaceAll('"next/headers"', JSON.stringify(headersStubUrl)),
);
const auth = await import(authUrl);
const rngUrl = dataUrl(transpile("worldbox/rng.ts"));
const mapgenUrl = dataUrl(transpile("worldbox/mapgen.ts").replaceAll('"./rng"', JSON.stringify(rngUrl)));
const maplogicUrl = dataUrl(
  transpile("worldbox/maplogic.ts")
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./rng"', JSON.stringify(rngUrl)),
);
const moveUrl = dataUrl(transpile("worldbox/move.ts").replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)));
const lobbyUrl = dataUrl(transpile("worldbox/lobby.ts").replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)));
const lobbyFloorsUrl = dataUrl(
  transpile("worldbox/lobby-floors.ts")
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./lobby"', JSON.stringify(lobbyUrl)),
);
const itemsUrl = dataUrl(transpile("worldbox/items.ts"));
const profileUrl = dataUrl(transpile("worldbox/profile.ts").replaceAll('"./items"', JSON.stringify(itemsUrl)));
const economyUrl = dataUrl(
  transpile("worldbox/economy.ts")
    .replaceAll('"./items"', JSON.stringify(itemsUrl))
    .replaceAll('"./profile"', JSON.stringify(profileUrl)),
);
const bridgeUrl = dataUrl(transpile("worldbox/economy-bridge.ts"));
const bridgeOnlineUrl = dataUrl(
  transpile("worldbox/economy-bridge-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botStubUrl))
    .replaceAll('"./economy-bridge"', JSON.stringify(bridgeUrl)),
);
const tentUrl = dataUrl(
  transpile("worldbox/tent.ts")
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./lobby"', JSON.stringify(lobbyUrl)),
);
const saveUrl = dataUrl(
  transpile("worldbox/save.ts")
    .replaceAll('"./lobby"', JSON.stringify(lobbyUrl))
    .replaceAll('"./tent"', JSON.stringify(tentUrl))
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)),
);
const saveOnlineUrl = dataUrl(
  transpile("worldbox/save-online.ts").replaceAll('"../bot-api"', JSON.stringify(botStubUrl)),
);
const presenceUrl = dataUrl(transpile("worldbox/presence.ts"));
const presenceOnlineUrl = dataUrl(
  transpile("worldbox/presence-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botStubUrl))
    .replaceAll('"./presence"', JSON.stringify(presenceUrl)),
);
const profileOnlineUrl = dataUrl(
  transpile("worldbox/profile-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botStubUrl))
    .replaceAll('"./profile"', JSON.stringify(profileUrl)),
);
const shopsUrl = dataUrl(transpile("worldbox/shops.ts").replaceAll('"./items"', JSON.stringify(itemsUrl)));
const stationOnlineUrl = dataUrl(
  transpile("worldbox/station-online.ts")
    .replaceAll('"./lobby"', JSON.stringify(lobbyUrl))
    .replaceAll('"./lobby-floors"', JSON.stringify(lobbyFloorsUrl))
    .replaceAll('"./tent"', JSON.stringify(tentUrl))
    .replaceAll('"./presence-online"', JSON.stringify(presenceOnlineUrl))
    .replaceAll('"./save"', JSON.stringify(saveUrl))
    .replaceAll('"./save-online"', JSON.stringify(saveOnlineUrl))
    .replaceAll('"./profile-online"', JSON.stringify(profileOnlineUrl)),
);
const rolesUrl = dataUrl(transpile("worldbox/roles.ts").replaceAll('"./profile"', JSON.stringify(profileUrl)));
const userLockUrl = dataUrl(transpile("worldbox/user-lock.ts"));
const arenaUrl = dataUrl(transpile("worldbox/arena.ts"));
const mobsUrl = dataUrl(
  transpile("worldbox/mobs.ts")
    .replaceAll('"./items"', JSON.stringify(itemsUrl))
    .replaceAll('"./maplogic"', JSON.stringify(maplogicUrl))
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)),
);
const combatUrl = dataUrl(
  transpile("worldbox/combat.ts")
    .replaceAll('"./mobs"', JSON.stringify(mobsUrl))
    .replaceAll('"./maplogic"', JSON.stringify(maplogicUrl)),
);
const mobsOnlineUrl = dataUrl(
  transpile("worldbox/mobs-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botStubUrl))
    .replaceAll('"./combat"', JSON.stringify(combatUrl)),
);
const nationsUrl = dataUrl(
  transpile("worldbox/nations.ts")
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./move"', JSON.stringify(moveUrl))
    .replaceAll('"./presence"', JSON.stringify(presenceUrl)),
);
const nationsOnlineUrl = dataUrl(
  transpile("worldbox/nations-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botStubUrl))
    .replaceAll('"./nations"', JSON.stringify(nationsUrl)),
);
const warpUrl = dataUrl(
  transpile("worldbox/warp.ts")
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./move"', JSON.stringify(moveUrl)),
);
const warpOnlineUrl = dataUrl(
  transpile("worldbox/warp-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botStubUrl))
    .replaceAll('"./warp"', JSON.stringify(warpUrl)),
);
const objectsUrl = dataUrl(
  transpile("worldbox/objects.ts")
    .replaceAll('"./items"', JSON.stringify(itemsUrl))
    .replaceAll('"./maplogic"', JSON.stringify(maplogicUrl))
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./rng"', JSON.stringify(rngUrl)),
);
const seasonsUrl = dataUrl(transpile("worldbox/seasons.ts"));
const tilesUrl = dataUrl(
  transpile("worldbox/tiles.ts")
    .replaceAll('"./items"', JSON.stringify(itemsUrl))
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./profile"', JSON.stringify(profileUrl))
    .replaceAll('"./presence"', JSON.stringify(presenceUrl))
    .replaceAll('"./seasons"', JSON.stringify(seasonsUrl)),
);
const tilesOnlineUrl = dataUrl(
  transpile("worldbox/tiles-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botStubUrl))
    .replaceAll('"./tiles"', JSON.stringify(tilesUrl)),
);
const instancesUrl = dataUrl(
  transpile("worldbox/instances.ts")
    .replaceAll('"./lobby"', JSON.stringify(lobbyUrl))
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./rng"', JSON.stringify(rngUrl))
    .replaceAll('"./objects"', JSON.stringify(objectsUrl))
    .replaceAll('"./mobs"', JSON.stringify(mobsUrl)),
);
const instancesOnlineUrl = dataUrl(
  transpile("worldbox/instances-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botStubUrl))
    .replaceAll('"./profile-online"', JSON.stringify(profileOnlineUrl))
    .replaceAll('"./roles"', JSON.stringify(rolesUrl))
    .replaceAll('"./instances"', JSON.stringify(instancesUrl)),
);
const partyUrl = dataUrl(transpile("worldbox/party.ts"));
const partyOnlineUrl = dataUrl(
  transpile("worldbox/party-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botStubUrl))
    .replaceAll('"./party"', JSON.stringify(partyUrl)),
);
const rolesOnlineUrl = dataUrl(
  transpile("worldbox/roles-online.ts").replaceAll('"../bot-api"', JSON.stringify(botStubUrl)),
);
const nextServerStubUrl = dataUrl(`
export class NextResponse {
  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(body), { status: init.status || 200, headers });
  }
}
`);
const profileRoute = await import(
  dataUrl(
    transpile("api/worldbox/profile/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/worldbox/roles"', JSON.stringify(rolesUrl))
      .replaceAll('"@/lib/worldbox/economy"', JSON.stringify(economyUrl))
      .replaceAll('"@/lib/worldbox/economy-bridge"', JSON.stringify(bridgeUrl))
      .replaceAll('"@/lib/worldbox/economy-bridge-online"', JSON.stringify(bridgeOnlineUrl))
      .replaceAll('"@/lib/worldbox/tent"', JSON.stringify(tentUrl))
      .replaceAll('"@/lib/worldbox/profile"', JSON.stringify(profileUrl))
      .replaceAll('"@/lib/worldbox/items"', JSON.stringify(itemsUrl))
      .replaceAll('"@/lib/worldbox/presence-online"', JSON.stringify(presenceOnlineUrl))
      .replaceAll('"@/lib/worldbox/shops"', JSON.stringify(shopsUrl))
      .replaceAll('"@/lib/worldbox/station-online"', JSON.stringify(stationOnlineUrl))
      .replaceAll('"@/lib/worldbox/profile-online"', JSON.stringify(profileOnlineUrl))
      .replaceAll('"@/lib/worldbox/user-lock"', JSON.stringify(userLockUrl)),
  ),
);
const rolesRoute = await import(
  dataUrl(
    transpile("api/worldbox/roles/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/worldbox/mapgen"', JSON.stringify(mapgenUrl))
      .replaceAll('"@/lib/worldbox/profile-online"', JSON.stringify(profileOnlineUrl))
      .replaceAll('"@/lib/worldbox/profile"', JSON.stringify(profileUrl))
      .replaceAll('"@/lib/worldbox/presence-online"', JSON.stringify(presenceOnlineUrl))
      .replaceAll('"@/lib/worldbox/presence"', JSON.stringify(presenceUrl))
      .replaceAll('"@/lib/worldbox/save"', JSON.stringify(saveUrl))
      .replaceAll('"@/lib/worldbox/save-online"', JSON.stringify(saveOnlineUrl))
      .replaceAll('"@/lib/worldbox/nations-online"', JSON.stringify(nationsOnlineUrl))
      .replaceAll('"@/lib/worldbox/warp"', JSON.stringify(warpUrl))
      .replaceAll('"@/lib/worldbox/warp-online"', JSON.stringify(warpOnlineUrl))
      .replaceAll('"@/lib/worldbox/tiles"', JSON.stringify(tilesUrl))
      .replaceAll('"@/lib/worldbox/tiles-online"', JSON.stringify(tilesOnlineUrl))
      .replaceAll('"@/lib/worldbox/instances"', JSON.stringify(instancesUrl))
      .replaceAll('"@/lib/worldbox/instances-online"', JSON.stringify(instancesOnlineUrl))
      .replaceAll('"@/lib/worldbox/party"', JSON.stringify(partyUrl))
      .replaceAll('"@/lib/worldbox/party-online"', JSON.stringify(partyOnlineUrl))
      .replaceAll('"@/lib/worldbox/roles-online"', JSON.stringify(rolesOnlineUrl))
      .replaceAll('"@/lib/worldbox/station-online"', JSON.stringify(stationOnlineUrl))
      .replaceAll('"@/lib/worldbox/roles"', JSON.stringify(rolesUrl))
      .replaceAll('"@/lib/worldbox/economy-bridge"', JSON.stringify(bridgeUrl))
      .replaceAll('"@/lib/worldbox/economy-bridge-online"', JSON.stringify(bridgeOnlineUrl))
      .replaceAll('"@/lib/worldbox/user-lock"', JSON.stringify(userLockUrl))
      .replaceAll('"@/lib/worldbox/arena"', JSON.stringify(arenaUrl))
      .replaceAll('"@/lib/worldbox/mobs"', JSON.stringify(mobsUrl))
      .replaceAll('"@/lib/worldbox/combat"', JSON.stringify(combatUrl))
      .replaceAll('"@/lib/worldbox/mobs-online"', JSON.stringify(mobsOnlineUrl)),
  ),
);

const shops = await import(shopsUrl);

const ME = "811111111111111111";
const PROFILE_URL = "http://localhost/api/worldbox/profile";
const ROLES_URL = "http://localhost/api/worldbox/roles";

function cookie(id, name = "dg-user") {
  return `ago_session=${encodeURIComponent(auth.createSession({ id, username: name }))}`;
}
function apiReq(url, ck, body) {
  return new Request(url, {
    method: "POST",
    headers: { cookie: ck, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function seedProfile(id, patch = {}) {
  globalThis.__wbDgStore.set(
    `worldbox_profiles discord:${id}`,
    JSON.stringify({ coins: 0, hunger: 100, items: {}, stealActorAt: 0, stealTargetAt: 0, ...patch }),
  );
}
function readProfile(id) {
  return JSON.parse(globalThis.__wbDgStore.get(`worldbox_profiles discord:${id}`));
}
function seedPresence(id, x, y) {
  globalThis.__wbDgStore.set(
    `worldbox_presence discord:${id}`,
    JSON.stringify({ name: "dg-user", x, y, vx: 0, vy: 0, face: 1, space: "lobby", ts: Date.now() }),
  );
}
function findOps(pred) {
  const out = [];
  for (const [k, v] of globalThis.__wbDgStore) {
    if (k.startsWith("worldbox_economy ") && v && typeof v === "object" && pred(v)) out.push(v);
  }
  return out;
}
/** Bot ワーカーがオプを終端させた状態を再現する。POST の最中に条件に合う
 * pending オプが現れたら即座に書き換える（server-side wait が拾う）。 */
function armFlip(pred, status, error = "insufficient_funds") {
  return new Promise((resolve) => {
    let timer;
    const timeout = setTimeout(() => { clearInterval(timer); resolve(false); }, 5000);
    timer = setInterval(() => {
      for (const [k, v] of globalThis.__wbDgStore) {
        if (k.startsWith("worldbox_economy ") && v && typeof v === "object" && v.status === "pending" && pred(v)) {
          globalThis.__wbDgStore.set(k, { ...v, status, error });
          clearInterval(timer);
          clearTimeout(timeout);
          resolve(true);
          return;
        }
      }
    }, 10);
  });
}
function reset() {
  globalThis.__wbDgStore.clear();
  globalThis.__wbDgUsers.clear();
  globalThis.__wbDgUsers.set(ME, 200000);
  seedProfile(ME);
}

// 本日の tools 棚で買える品目（日次ローテーション＋販売ホワイトリストの両方を満たすもの）。
const BUY_ITEM = shops.dailyStockForGenre("tools", shops.shopDayKeyOf(Date.now()))
  .find((i) => shops.checkBuySold(i.id) === null);
assert.ok(BUY_ITEM, "本日の tools 棚に買える品目がある");

test("API(profile): 購入の決済が failed ならアイテムは付かない（巻き戻し）", async () => {
  reset();
  seedPresence(ME, 5.5, 19.5);
  const flipped = armFlip((o) => o.kind === "spend" && o.reason === "shop_buy", "failed", "insufficient_funds");
  const res = await profileRoute.POST(apiReq(PROFILE_URL, cookie(ME), { action: "buy", itemId: BUY_ITEM.id, count: 1 }));
  assert.equal(await flipped, true, "ワーカーがオプを failed にした");
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.error, "economy_failed");
  assert.equal(data.opError, "insufficient_funds");
  assert.equal(readProfile(ME).items[BUY_ITEM.id] ?? 0, 0, "購入アイテムは付いていない");
  const ops = findOps((o) => o.reason === "shop_buy");
  assert.equal(ops.length, 1, "spend オプは1件だけ");
  assert.equal(ops[0].status, "failed");
});

test("API(profile): 購入の決済が done ならアイテムが付いて opStatus が返る", async () => {
  reset();
  seedPresence(ME, 5.5, 19.5);
  const flipped = armFlip((o) => o.kind === "spend" && o.reason === "shop_buy", "done", undefined);
  const res = await profileRoute.POST(apiReq(PROFILE_URL, cookie(ME), { action: "buy", itemId: BUY_ITEM.id, count: 1 }));
  assert.equal(await flipped, true, "ワーカーがオプを done にした");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.opStatus, "done");
  assert.equal(data.balance, 200000, "残高はワーカー適用前の読み取り値のまま（Web は残高を動かさない）");
  assert.equal(readProfile(ME).items[BUY_ITEM.id] ?? 0, 1, "購入アイテムが付いている");
});

test("API(profile): 購入の決済が pending のままなら従来どおり交付する", async () => {
  reset();
  seedPresence(ME, 5.5, 19.5);
  const res = await profileRoute.POST(apiReq(PROFILE_URL, cookie(ME), { action: "buy", itemId: BUY_ITEM.id, count: 1 }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.opStatus, undefined, "pending のままなら opStatus は付かない");
  assert.equal(readProfile(ME).items[BUY_ITEM.id] ?? 0, 1, "pending フォールバックで交付される");
});

test("API(profile): 売却の決済が failed ならアイテムは戻る（巻き戻し）", async () => {
  reset();
  seedProfile(ME, { items: { wood: 3 } });
  seedPresence(ME, 5.5, 19.5);
  const flipped = armFlip((o) => o.kind === "earn" && o.reason === "shop_sale", "failed", "credit_failed");
  const res = await profileRoute.POST(apiReq(PROFILE_URL, cookie(ME), { action: "sell", itemId: "wood", count: 1 }));
  assert.equal(await flipped, true, "ワーカーがオプを failed にした");
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "economy_failed");
  assert.equal(readProfile(ME).items.wood, 3, "売ったはずのアイテムが戻っている");
});

test("API(profile): 強化の決済が failed ならレベルも素材も戻る（巻き戻し）", async () => {
  reset();
  seedProfile(ME, { items: { wooden_sword: 1, wood: 5 } });
  seedPresence(ME, 25.5, 35.5);
  const flipped = armFlip((o) => o.kind === "spend" && o.reason === "tool_enhance", "failed", "insufficient_funds");
  const res = await profileRoute.POST(apiReq(PROFILE_URL, cookie(ME), { action: "enhance", itemId: "wooden_sword" }));
  assert.equal(await flipped, true, "ワーカーがオプを failed にした");
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "economy_failed");
  const after = readProfile(ME);
  assert.equal(after.enhance?.wooden_sword ?? 0, 0, "強化レベルは上がっていない");
  assert.equal(after.items.wood, 5, "消費したはずの素材が戻っている");
  assert.equal(after.items.wooden_sword, 1, "道具は残っている");
});

test("API(profile): 強化の決済が done ならレベルが上がって素材が減る", async () => {
  reset();
  seedProfile(ME, { items: { wooden_sword: 1, wood: 5 } });
  seedPresence(ME, 25.5, 35.5);
  const flipped = armFlip((o) => o.kind === "spend" && o.reason === "tool_enhance", "done", undefined);
  const res = await profileRoute.POST(apiReq(PROFILE_URL, cookie(ME), { action: "enhance", itemId: "wooden_sword" }));
  assert.equal(await flipped, true, "ワーカーがオプを done にした");
  assert.equal(res.status, 200);
  const after = readProfile(ME);
  assert.equal(after.enhance?.wooden_sword, 1, "強化レベルが上がっている");
  assert.equal(after.items.wood, 3, "素材が2個消費されている");
});

test("API(profile): テント拡張の決済が failed なら段階は上がらない。再試行は失敗オプを消して積み直す", async () => {
  reset();
  const first = armFlip((o) => o.kind === "spend" && o.reason === "tent_expand", "failed", "insufficient_funds");
  const res1 = await profileRoute.POST(apiReq(PROFILE_URL, cookie(ME), { action: "expand_tent" }));
  assert.equal(await first, true, "ワーカーがオプを failed にした");
  assert.equal(res1.status, 409);
  assert.equal((await res1.json()).error, "economy_failed");
  assert.equal(readProfile(ME).tentTier ?? 0, 0, "段階は上がっていない");
  // 再試行: 失敗オプが決定的 ID を塞がないこと。新しい試行が done になれば段階が上がる。
  const second = armFlip((o) => o.kind === "spend" && o.reason === "tent_expand", "done", undefined);
  const res2 = await profileRoute.POST(apiReq(PROFILE_URL, cookie(ME), { action: "expand_tent" }));
  assert.equal(await second, true, "再試行のオプが done になった");
  assert.equal(res2.status, 200);
  assert.equal(readProfile(ME).tentTier, 1, "再試行で段階が上がっている");
  const ops = findOps((o) => o.reason === "tent_expand");
  assert.equal(ops.length, 1, "失敗オプは消され、課金オプは1件だけ");
  assert.equal(ops[0].id, `tent-expand-${ME}-1`);
  assert.equal(ops[0].status, "done");
});

test("API(roles): 転職の決済が failed なら役職は変わらない（巻き戻し）", async () => {
  reset();
  seedProfile(ME, { role: "blade", rolePicked: true });
  seedPresence(ME, 24.5, 16.5);
  const flipped = armFlip((o) => o.kind === "spend" && o.reason === "role_change", "failed", "insufficient_funds");
  const res = await rolesRoute.POST(apiReq(ROLES_URL, cookie(ME), { action: "set_role", role: "guard" }));
  assert.equal(await flipped, true, "ワーカーがオプを failed にした");
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "economy_failed");
  assert.equal(readProfile(ME).role, "blade", "役職は変わっていない");
});

test("API(roles): 転職の決済が done なら役職が変わる", async () => {
  reset();
  seedProfile(ME, { role: "blade", rolePicked: true });
  seedPresence(ME, 24.5, 16.5);
  const flipped = armFlip((o) => o.kind === "spend" && o.reason === "role_change", "done", undefined);
  const res = await rolesRoute.POST(apiReq(ROLES_URL, cookie(ME), { action: "set_role", role: "guard" }));
  assert.equal(await flipped, true, "ワーカーがオプを done にした");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.cost, 100000);
  assert.equal(readProfile(ME).role, "guard", "役職が変わっている");
});
