// AGO WORLD BOX 収納コンテナ（樽・宝箱）の検証:
// - 定義（容量・判定）と状態の解釈（parse/serialize）
// - プロフィール⇔コンテナ間のスロット移動（移動・合算・入替・総量保存）
// - コンテナ API（所有者だけが開ける/出し入れできる、隣接検証）
// - タイル API（中身がある間は mine_block が not_empty で拒否、空なら回収＋状態削除）
// - クライアント配線（タップで開く・パネル・回収ボタン）
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
    out.push(line.replace(/^export\s+/, ""));
  }
  return out.join("\n");
}

function bundleModule(files, names) {
  const code = files.map((name) => stripModuleSyntax(transpile(name))).join("\n");
  return dataUrl(`${code}\nexport { ${names.join(", ")} };`);
}

const invUrl = bundleModule(
  ["worldbox/items.ts", "worldbox/profile.ts"],
  ["parseProfile", "serializeProfile", "countItem"],
);
const inv = await import(invUrl);

const containersUrl = bundleModule(
  ["worldbox/items.ts", "worldbox/profile.ts", "worldbox/containers.ts"],
  [
    "CONTAINER_DEFS", "containerCapacity", "isContainerItem", "emptyContainer",
    "containerIsEmpty", "parseContainerState", "serializeContainerState",
    "parseContainerSlotRef", "moveContainerSlot",
  ],
);
const C = await import(containersUrl);

const tilesUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/items.ts", "worldbox/profile.ts", "worldbox/presence.ts", "worldbox/seasons.ts", "worldbox/tiles.ts"],
  [
    "worldTileSource", "mapTileAt", "T_GRASS",
    "applyTileAction", "applyPlaceBlock", "applyMineBlock", "applyFlowerAction", "applyToggleGate",
    "applySetSign", "applyDisplayAction", "applyDrawWater",
    "tileKey", "parseTileOverride", "parseTileOverrides",
    "presenceIdFor", "isOverrideActive",
  ],
);
const T = await import(tilesUrl);

const mapgenUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts"],
  ["worldTileSource", "WORLD_COORD_LIMIT"],
);

// ---------- 定義・状態 ----------

const ME_ID = "p-me";
const slot = (id, count) => ({ id, count });
const emptySlots = (n) => Array.from({ length: n }, () => null);

test("定義: 樽は10枠・宝箱は15枠、それ以外はコンテナでない", () => {
  assert.equal(C.CONTAINER_DEFS.barrel.capacity, 10);
  assert.equal(C.CONTAINER_DEFS.chest_box.capacity, 15);
  assert.equal(C.containerCapacity("barrel"), 10);
  assert.equal(C.containerCapacity("chest_box"), 15);
  assert.equal(C.isContainerItem("barrel"), true);
  assert.equal(C.isContainerItem("chest_box"), true);
  assert.equal(C.isContainerItem("bench"), false, "ただの家具はコンテナでない");
  assert.equal(C.isContainerItem("wood"), false);
  assert.equal(C.isContainerItem("nope"), false);
  assert.equal(C.isContainerItem(null), false);
  assert.equal(C.containerCapacity("nope"), 0);
});

test("定義: 木箱は8枠・収納箱は20枠のコンテナ", () => {
  assert.equal(C.CONTAINER_DEFS.crate.capacity, 8);
  assert.equal(C.CONTAINER_DEFS.storage_chest.capacity, 20);
  assert.equal(C.containerCapacity("crate"), 8);
  assert.equal(C.containerCapacity("storage_chest"), 20);
  assert.equal(C.isContainerItem("crate"), true);
  assert.equal(C.isContainerItem("storage_chest"), true);
  assert.equal(C.emptyContainer(ME_ID, "crate").slots.length, 8);
  assert.equal(C.emptyContainer(ME_ID, "storage_chest").slots.length, 20);
});

test("状態: 空コンテナの生成と serialize/parse の往復", () => {
  const empty = C.emptyContainer(ME_ID, "barrel");
  assert.equal(empty.ownerId, ME_ID);
  assert.equal(empty.slots.length, 10);
  assert.ok(empty.slots.every((s) => s === null));
  assert.equal(C.emptyContainer(ME_ID, "chest_box").slots.length, 15);

  const state = C.emptyContainer(ME_ID, "chest_box");
  state.slots[3] = slot("wood", 12);
  const parsed = C.parseContainerState(C.serializeContainerState(state), "chest_box");
  assert.deepEqual(parsed, state);
  // オブジェクトのまま渡しても読める
  assert.deepEqual(C.parseContainerState(JSON.parse(C.serializeContainerState(state)), "chest_box"), state);
});

test("状態: 壊れたデータは null、枠は容量に整えられ不正な中身は落ちる", () => {
  assert.equal(C.parseContainerState("not json", "barrel"), null);
  assert.equal(C.parseContainerState(null, "barrel"), null);
  assert.equal(C.parseContainerState({ ownerId: "", slots: [] }, "barrel"), null);
  assert.equal(C.parseContainerState({ ownerId: ME_ID }, "barrel"), null, "slots が無い");
  assert.equal(C.parseContainerState({ ownerId: ME_ID, slots: [] }, "bench"), null, "コンテナでない");
  const wide = C.parseContainerState(
    { ownerId: ME_ID, slots: [...emptySlots(9), slot("wood", 500), slot("stone", 1), slot("nope_item", 1)] },
    "barrel",
  );
  assert.equal(wide.slots.length, 10, "容量を超えた分は切る");
  assert.deepEqual(wide.slots[9], { id: "wood", count: 99 }, "個数は上限にクランプ");
  const short = C.parseContainerState({ ownerId: ME_ID, slots: [slot("nope_item", 1)] }, "barrel");
  assert.equal(short.slots.length, 10, "短い場合は空き枠で埋める");
  assert.equal(short.slots[0], null, "存在しないアイテムは落ちる");
});

test("状態: 空判定", () => {
  assert.equal(C.containerIsEmpty(null), true);
  assert.equal(C.containerIsEmpty(C.emptyContainer(ME_ID, "barrel")), true);
  const state = C.emptyContainer(ME_ID, "barrel");
  state.slots[0] = slot("wood", 1);
  assert.equal(C.containerIsEmpty(state), false);
});

// ---------- スロット移動 ----------

const profWith = (hotbar, storage) => {
  const base = inv.parseProfile(null);
  return inv.parseProfile(JSON.parse(JSON.stringify({ ...base, hotbar, storage })));
};
const containerWith = (itemId, entries) => {
  const state = C.emptyContainer(ME_ID, itemId);
  for (const [i, s] of entries) state.slots[i] = s;
  return state;
};
const containerTotal = (state, id) =>
  state.slots.reduce((n, s) => n + (s && s.id === id ? s.count : 0), 0);

test("移動: プロフィール→コンテナ（枠ごと移動し、集計も減る）", () => {
  const p = profWith(emptySlots(5), [null, null, slot("wood", 5), null, null, null, null, null, null, null]);
  const c = C.emptyContainer(ME_ID, "barrel");
  const r = C.moveContainerSlot(p, c, { side: "profile_storage", index: 2 }, { side: "container", index: 0 });
  assert.deepEqual(r.container.slots[0], { id: "wood", count: 5 });
  assert.equal(r.profile.storage[2], null);
  assert.equal(inv.countItem(r.profile, "wood"), 0, "プロフィールの集計からも消える");
  // 元のオブジェクトは壊さない
  assert.deepEqual(p.storage[2], { id: "wood", count: 5 });
  assert.equal(c.slots[0], null);
});

test("移動: コンテナ→プロフィール（ホットバーへ戻り、集計も増える）", () => {
  const p = profWith(emptySlots(5), emptySlots(10));
  const c = containerWith("chest_box", [[4, slot("stone", 7)]]);
  const r = C.moveContainerSlot(p, c, { side: "container", index: 4 }, { side: "profile_hotbar", index: 1 });
  assert.deepEqual(r.profile.hotbar[1], { id: "stone", count: 7 });
  assert.equal(r.container.slots[4], null);
  assert.equal(inv.countItem(r.profile, "stone"), 7);
  assert.equal(C.containerIsEmpty(r.container), true);
});

test("移動: 同種は合算し、上限を超えた分は元の枠に残る", () => {
  const p = profWith([slot("wood", 20), null, null, null, null], emptySlots(10));
  const c = containerWith("barrel", [[0, slot("wood", 90)]]);
  const r = C.moveContainerSlot(p, c, { side: "profile_hotbar", index: 0 }, { side: "container", index: 0 });
  assert.deepEqual(r.container.slots[0], { id: "wood", count: 99 });
  assert.deepEqual(r.profile.hotbar[0], { id: "wood", count: 11 });
  assert.equal(inv.countItem(r.profile, "wood") + containerTotal(r.container, "wood"), 110, "総量は保存される");
});

test("移動: 異種は入れ替え、コンテナ内・プロフィール内の移動もできる", () => {
  const p = profWith([slot("wood", 5), null, null, null, null], emptySlots(10));
  const c = containerWith("barrel", [[0, slot("stone", 3)]]);
  const swapped = C.moveContainerSlot(p, c, { side: "profile_hotbar", index: 0 }, { side: "container", index: 0 });
  assert.deepEqual(swapped.container.slots[0], { id: "wood", count: 5 });
  assert.deepEqual(swapped.profile.hotbar[0], { id: "stone", count: 3 });
  assert.equal(inv.countItem(swapped.profile, "wood"), 0);
  assert.equal(inv.countItem(swapped.profile, "stone"), 3);

  const within = C.moveContainerSlot(swapped.profile, swapped.container, { side: "container", index: 0 }, { side: "container", index: 9 });
  assert.equal(within.container.slots[0], null);
  assert.deepEqual(within.container.slots[9], { id: "wood", count: 5 });

  const inProfile = C.moveContainerSlot(within.profile, within.container, { side: "profile_hotbar", index: 0 }, { side: "profile_storage", index: 6 });
  assert.equal(inProfile.profile.hotbar[0], null);
  assert.deepEqual(inProfile.profile.storage[6], { id: "stone", count: 3 });
  assert.equal(inv.countItem(inProfile.profile, "stone"), 3, "プロフィール内移動では集計は不変");
});

test("移動: 空枠から・同枠は現状維持、不正な住所は null", () => {
  const p = profWith([slot("wood", 5), null, null, null, null], emptySlots(10));
  const c = C.emptyContainer(ME_ID, "barrel");
  const noop1 = C.moveContainerSlot(p, c, { side: "container", index: 0 }, { side: "profile_hotbar", index: 1 });
  assert.equal(noop1.profile, p, "空枠からは動かない");
  assert.equal(noop1.container, c);
  const noop2 = C.moveContainerSlot(p, c, { side: "profile_hotbar", index: 0 }, { side: "profile_hotbar", index: 0 });
  assert.equal(noop2.profile, p, "同枠は現状維持");
  assert.equal(C.moveContainerSlot(p, c, { side: "vault", index: 0 }, { side: "container", index: 0 }), null);
  assert.equal(C.moveContainerSlot(p, c, { side: "container", index: 10 }, { side: "container", index: 0 }), null, "樽の容量は10枠");
  assert.equal(C.moveContainerSlot(p, c, { side: "profile_hotbar", index: 5 }, { side: "container", index: 0 }), null);
  assert.equal(C.moveContainerSlot(p, c, null, { side: "container", index: 0 }), null);
  assert.deepEqual(C.parseContainerSlotRef({ side: "container", index: 14 }, 15), { side: "container", index: 14 });
  assert.equal(C.parseContainerSlotRef({ side: "container", index: 15 }, 15), null);
});

// ---------- S4: コンテナ保存の空間修飾キー ----------

// 実モジュール（bot-api だけスタブ）を空間ごとに分けて検証する
const s4BotApiStubUrl = dataUrl(`
const store = new Map();
export function isBotApiConfigured() { return true; }
export async function kvGet(ns, key) { const v = store.get(ns + " " + key); return v === undefined ? null : v; }
export async function kvSet(ns, key, value) { store.set(ns + " " + key, value); }
export async function kvDelete(ns, key) { store.delete(ns + " " + key); }
export async function kvList(ns) { const m = new Map(); for (const [k, v] of store) if (k.startsWith(ns + " ")) m.set(k.slice(ns.length + 1), v); return m; }
export function __rawKeys() { return [...store.keys()]; }
export function __seedRaw(ns, key, value) { store.set(ns + " " + key, value); }
export function __clear() { store.clear(); }
`);
const s4BotApi = await import(s4BotApiStubUrl);
const containersOnlineUrl = dataUrl(
  transpile("worldbox/containers-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(s4BotApiStubUrl))
    .replaceAll('"./containers"', JSON.stringify(containersUrl))
    .replaceAll('"./tiles"', JSON.stringify(tilesUrl)),
);
const CONLINE = await import(containersOnlineUrl);

test("containers-online(S4): 同座標でも空間が違えば中身は衝突しない", async () => {
  s4BotApi.__clear();
  const worldState = C.emptyContainer(ME_ID, "barrel");
  worldState.slots[0] = slot("wood", 5);
  const caveState = C.emptyContainer(ME_ID, "barrel");
  caveState.slots[0] = slot("stone", 7);
  assert.equal(await CONLINE.storeContainer("world", 3, 4, worldState), true);
  assert.equal(await CONLINE.storeContainer("cave:10,20:0", 3, 4, caveState), true);
  assert.deepEqual(await CONLINE.loadContainer("world", 3, 4, "barrel"), worldState);
  assert.deepEqual(await CONLINE.loadContainer("cave:10,20:0", 3, 4, "barrel"), caveState);
  assert.deepEqual(await CONLINE.loadContainer("tent", 3, 4, "barrel"), null);
  assert.equal(CONLINE.containerKey("world", 3, 4), "world|3,4");
  assert.equal(CONLINE.containerKey("cave:10,20:0", 3, 4), "cave:10,20:0|3,4");
});

test("containers-online(S4): 旧形式のワールド分は読めて、書き込みで新キーへ移行する", async () => {
  s4BotApi.__clear();
  const legacy = C.emptyContainer(ME_ID, "barrel");
  legacy.slots[1] = slot("wood", 2);
  s4BotApi.__seedRaw("worldbox_containers", "3,4", C.serializeContainerState(legacy));
  // 旧キーだけの状態でも読める
  assert.deepEqual(await CONLINE.loadContainer("world", 3, 4, "barrel"), legacy);
  // 他空間からは旧キーを見ない
  assert.deepEqual(await CONLINE.loadContainer("cave:10,20:0", 3, 4, "barrel"), null);
  // 書き込むと新キーへ移行する
  const next = C.emptyContainer(ME_ID, "barrel");
  next.slots[1] = slot("wood", 3);
  assert.equal(await CONLINE.storeContainer("world", 3, 4, next), true);
  assert.deepEqual(await CONLINE.loadContainer("world", 3, 4, "barrel"), next);
  assert.ok(s4BotApi.__rawKeys().includes("worldbox_containers world|3,4"));
  // 削除は新旧両方のキーを消す
  assert.equal(await CONLINE.storeContainer("world", 3, 4, null), true);
  assert.deepEqual(await CONLINE.loadContainer("world", 3, 4, "barrel"), null);
  assert.equal(s4BotApi.__rawKeys().length, 0, "旧キーも残らない");
});

// ---------- API（コンテナ＋タイルの not_empty） ----------

const subdomainUrl = dataUrl(transpile("subdomain.ts"));
const headersStubUrl = dataUrl("export async function cookies() { throw new Error('tests do not use cookies()'); }");
const authUrl = dataUrl(
  transpile("auth.ts").replaceAll('"./subdomain"', JSON.stringify(subdomainUrl)).replaceAll('"next/headers"', JSON.stringify(headersStubUrl)),
);
const auth = await import(authUrl);

const presenceBundleUrl = bundleModule(["worldbox/presence.ts"], ["presenceIdFor"]);
const profileOnlineStubUrl = dataUrl(`
import { parseProfile, serializeProfile } from ${JSON.stringify(invUrl)};
const store = (globalThis.__wbContainerProfiles ??= new Map());
export function isProfileEnabled() { return true; }
export async function loadProfile(key) { const raw = store.get(key); return raw ? parseProfile(raw) : parseProfile(null); }
export async function storeProfile(key, profile) { store.set(key, serializeProfile(profile)); return true; }
`);
const presenceOnlineStubUrl = dataUrl(`
export function isPresenceEnabled() { return true; }
export async function listPresence() { return globalThis.__wbContainerPresence ?? []; }
`);
const saveStubUrl = dataUrl("export function parseSave() { return null; }");
const saveOnlineStubUrl = dataUrl("export async function loadWorldBoxSave() { return null; }");
const tilesOnlineStubUrl = dataUrl(`
import { parseTileOverride, parseTileOverrides } from ${JSON.stringify(tilesUrl)};
const store = (globalThis.__wbContainerTiles ??= new Map());
export function isTilesEnabled() { return true; }
export async function loadTileOverrides() { return parseTileOverrides(store); }
export async function loadTileOverride(x, y) { const v = store.get(x + "," + y); return v === undefined ? null : parseTileOverride(v); }
export async function storeTileOverride(x, y, ov) { if (ov === null) store.delete(x + "," + y); else store.set(x + "," + y, JSON.stringify(ov)); return true; }
`);
const containersOnlineStubUrl = dataUrl(`
import { parseContainerState, serializeContainerState } from ${JSON.stringify(containersUrl)};
const store = (globalThis.__wbContainers ??= new Map());
export function isContainersEnabled() { return true; }
export async function loadContainer(space, x, y, itemId) { const v = store.get(space + "|" + x + "," + y); return v === undefined ? null : parseContainerState(v, itemId); }
export async function storeContainer(space, x, y, state) { if (state === null) store.delete(space + "|" + x + "," + y); else store.set(space + "|" + x + "," + y, serializeContainerState(state)); return true; }
`);
const nationsOnlineStubUrl = dataUrl(`
export function isNationsEnabled() { return true; }
export async function loadNationsState() { return { nations: {} }; }
`);
// 戦争のスタブ: 空の戦争状態を返す（平時＝他者ブロックは掘れない）。
const warUrl = bundleModule(["worldbox/war.ts"], ["canBreakOthersBlock"]);
const warsOnlineStubUrl = dataUrl(`
export async function loadWarState() { return globalThis.__wbContainersWars ?? { v: 1, wars: {}, history: [], lastDeclaredAt: {} }; }
`);
const nextServerStubUrl = dataUrl(`
export class NextResponse {
  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(body), { status: init.status || 200, headers });
  }
}
`);
function routeImport(file, replacements) {
  let code = transpile(file, rootDir + "/app");
  for (const [from, to] of replacements) code = code.replaceAll(from, JSON.stringify(to));
  return import(dataUrl(code));
}
const userLockUrl = dataUrl(transpile("worldbox/user-lock.ts"));
const tentUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/items.ts", "worldbox/profile.ts", "worldbox/presence.ts", "worldbox/seasons.ts", "worldbox/tiles.ts", "worldbox/lobby.ts", "worldbox/tent.ts"],
  ["buildTent", "TENT_H", "SEAT_SPRITES"],
);
const lobbyUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/items.ts", "worldbox/profile.ts", "worldbox/presence.ts", "worldbox/seasons.ts", "worldbox/tiles.ts", "worldbox/lobby.ts", "worldbox/shops.ts"],
  ["buildLobby"],
);
const lobbyFloorsUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/items.ts", "worldbox/profile.ts", "worldbox/presence.ts", "worldbox/seasons.ts", "worldbox/tiles.ts", "worldbox/lobby.ts", "worldbox/shops.ts", "worldbox/lobby-floors.ts"],
  ["buildLobby2", "buildLobby3"],
);
const tentMod = await import(tentUrl);
const containersRoute = await routeImport("api/worldbox/containers/route.ts", [
  ['"next/server"', nextServerStubUrl],
  ['"@/lib/auth"', authUrl],
  ['"@/lib/worldbox/mapgen"', mapgenUrl],
  ['"@/lib/worldbox/profile-online"', profileOnlineStubUrl],
  ['"@/lib/worldbox/presence-online"', presenceOnlineStubUrl],
  ['"@/lib/worldbox/presence"', presenceBundleUrl],
  ['"@/lib/worldbox/save"', saveStubUrl],
  ['"@/lib/worldbox/save-online"', saveOnlineStubUrl],
  ['"@/lib/worldbox/tiles"', tilesUrl],
  ['"@/lib/worldbox/tiles-online"', tilesOnlineStubUrl],
  ['"@/lib/worldbox/containers"', containersUrl],
  ['"@/lib/worldbox/containers-online"', containersOnlineStubUrl],
  ['"@/lib/worldbox/tent"', tentUrl],
  ['"@/lib/worldbox/lobby"', lobbyUrl],
  ['"@/lib/worldbox/lobby-floors"', lobbyFloorsUrl],
  ['"@/lib/worldbox/user-lock"', userLockUrl],
]);
const machinesUrl = bundleModule(["worldbox/items.ts", "worldbox/machines.ts"], ["isMachineItem", "machineBufferCount"]);
const opsOnlineStubUrl = dataUrl(`
export async function loadFrozen() { return false; }
export async function appendTileJournal() {}
`);
const metricsOnlineStubUrl = dataUrl(`
export async function recordPresenceMetric() {}
export async function recordFirstStep() {}
export async function bumpMetric() {}
export async function loadDayMetrics() { return null; }
export async function loadUserFirstSteps() { return null; }
export async function loadEconDay() { return null; }
`);
const machinesOnlineStubUrl = dataUrl(`
export async function loadMachine() { return null; }
export async function deleteMachine() {}
`);
const stallsUrl = bundleModule(["worldbox/items.ts", "worldbox/stalls.ts"], ["isStallItem"]);
const stallsOnlineStubUrl = dataUrl(`
export async function loadStall() { return null; }
export async function storeStall() { return true; }
`);
const tilesRoute = await routeImport("api/worldbox/tiles/route.ts", [
  ['"next/server"', nextServerStubUrl],
  ['"@/lib/auth"', authUrl],
  ['"@/lib/worldbox/mapgen"', mapgenUrl],
  ['"@/lib/worldbox/profile-online"', profileOnlineStubUrl],
  ['"@/lib/worldbox/presence-online"', presenceOnlineStubUrl],
  ['"@/lib/worldbox/presence"', presenceBundleUrl],
  ['"@/lib/worldbox/save"', saveStubUrl],
  ['"@/lib/worldbox/save-online"', saveOnlineStubUrl],
  ['"@/lib/worldbox/tiles"', tilesUrl],
  ['"@/lib/worldbox/tiles-online"', tilesOnlineStubUrl],
  ['"@/lib/worldbox/nations-online"', nationsOnlineStubUrl],
  ['"@/lib/worldbox/war"', warUrl],
  ['"@/lib/worldbox/war-online"', warsOnlineStubUrl],
  ['"@/lib/worldbox/containers"', containersUrl],
  ['"@/lib/worldbox/containers-online"', containersOnlineStubUrl],
  ['"@/lib/worldbox/machines"', machinesUrl],
  ['"@/lib/worldbox/machines-online"', machinesOnlineStubUrl],
  ['"@/lib/worldbox/stalls"', stallsUrl],
  ['"@/lib/worldbox/stalls-online"', stallsOnlineStubUrl],
  ['"@/lib/worldbox/metrics-online"', metricsOnlineStubUrl],
  ['"@/lib/worldbox/ops-online"', opsOnlineStubUrl],
  ['"@/lib/worldbox/user-lock"', userLockUrl],
]);

process.env["DISCORD_SESSION" + "_SECRET"] = "worldbox-containers-test-secret";
const ME = "611111111111111111";
const OTHER = "622222222222222222";
const MY_KEY = `discord:${ME}`;
const OTHER_KEY = `discord:${OTHER}`;
const MY_ID = T.presenceIdFor(MY_KEY);
function sessionCookie(id, username) {
  return `ago_session=${encodeURIComponent(auth.createSession({ id, username }))}`;
}
function apiRequest(url, method, cookie, body) {
  return new Request(url, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const URL_C = "http://localhost/api/worldbox/containers";
const URL_T = "http://localhost/api/worldbox/tiles";

const map = T.worldTileSource();
function findGrass() {
  for (let y = 0; y < 1024; y++) {
    for (let x = 0; x < 1024; x++) {
      if (T.mapTileAt(map, x, y) === T.T_GRASS) return { x, y };
    }
  }
  throw new Error("grass not found");
}
const GRASS = findGrass();
const KEY = T.tileKey(GRASS.x, GRASS.y);
// コンテナ保存のキーは空間修飾つき（S4）。タイル上書きのキーは素の "x,y" のまま。
const CKEY = `world|${KEY}`;

function resetStores() {
  globalThis.__wbContainerTiles?.clear();
  globalThis.__wbContainerProfiles?.clear();
  globalThis.__wbContainers?.clear();
  // 位置ゲート前提のプレゼンス（本人が樽の前に立っている）。遠方テストは
  // この後に上書きする。
  globalThis.__wbContainerPresence = [
    { id: MY_ID, space: "world", x: GRASS.x, y: GRASS.y, ts: Date.now() },
    { id: T.presenceIdFor(OTHER_KEY), space: "world", x: GRASS.x, y: GRASS.y, ts: Date.now() },
  ];
}
function seedBarrel(ownerId) {
  const ov = { block: { itemId: "barrel", ownerId }, ownerId };
  globalThis.__wbContainerTiles.set(KEY, JSON.stringify(ov));
}
function seedProfile(key, profile) {
  globalThis.__wbContainerProfiles.set(key, inv.serializeProfile(profile));
}

test("API(containers): 未ログインは 401、コンテナが無いタイルは 404", async () => {
  resetStores();
  const url = `${URL_C}?x=${GRASS.x}&y=${GRASS.y}`;
  const anon = await containersRoute.GET(apiRequest(url, "GET", null));
  assert.equal(anon.status, 401);
  const cookie = sessionCookie(ME, "owner");
  const none = await containersRoute.GET(apiRequest(url, "GET", cookie));
  assert.equal(none.status, 404);
  assert.equal((await none.json()).error, "no_container");
  // コンテナでないブロックも 404
  globalThis.__wbContainerTiles.set(KEY, JSON.stringify({
    block: { itemId: "dirt_block", ownerId: MY_ID }, ownerId: MY_ID,
  }));
  const notContainer = await containersRoute.GET(apiRequest(url, "GET", cookie));
  assert.equal(notContainer.status, 404);
  assert.equal((await notContainer.json()).error, "no_container");
});

test("API(containers): 樽の中身は全員共有（他人の設置した樽も開けて出し入れできる）", async () => {
  resetStores();
  seedBarrel(MY_ID);
  const cookie = sessionCookie(ME, "owner");
  const res = await containersRoute.GET(apiRequest(`${URL_C}?x=${GRASS.x}&y=${GRASS.y}`, "GET", cookie));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.itemId, "barrel");
  assert.equal(data.capacity, 10);
  assert.equal(data.container.ownerId, MY_ID);
  assert.equal(data.container.slots.length, 10);
  assert.ok(data.container.slots.every((s) => s === null));

  // 設置者以外も開ける（共有）
  seedProfile(OTHER_KEY, profWith([slot("stone", 3), null, null, null, null], emptySlots(10)));
  const otherCookie = sessionCookie(OTHER, "guest");
  const opened = await containersRoute.GET(apiRequest(`${URL_C}?x=${GRASS.x}&y=${GRASS.y}`, "GET", otherCookie));
  assert.equal(opened.status, 200, "他人の樽も開ける");
  // 設置者以外も出し入れでき、設置者にも同じ中身が見える
  const guestMove = await containersRoute.POST(apiRequest(URL_C, "POST", otherCookie, {
    action: "move", x: GRASS.x, y: GRASS.y,
    from: { side: "profile_hotbar", index: 0 }, to: { side: "container", index: 0 },
  }));
  assert.equal(guestMove.status, 200, "他人も出し入れできる");
  const ownerView = await containersRoute.GET(apiRequest(`${URL_C}?x=${GRASS.x}&y=${GRASS.y}`, "GET", cookie));
  assert.deepEqual((await ownerView.json()).container.slots[0], { id: "stone", count: 3 }, "中身は共有される");
});

test("API(containers): 出し入れが保存され、GET に反映される", async () => {
  resetStores();
  seedBarrel(MY_ID);
  seedProfile(MY_KEY, profWith([slot("wood", 5), null, null, null, null], emptySlots(10)));
  const cookie = sessionCookie(ME, "owner");
  const moved = await containersRoute.POST(apiRequest(URL_C, "POST", cookie, {
    action: "move", x: GRASS.x, y: GRASS.y,
    from: { side: "profile_hotbar", index: 0 }, to: { side: "container", index: 2 },
  }));
  assert.equal(moved.status, 200);
  const movedData = await moved.json();
  assert.deepEqual(movedData.container.slots[2], { id: "wood", count: 5 });
  assert.equal(inv.countItem(movedData.profile, "wood"), 0);
  assert.ok(globalThis.__wbContainers.has(CKEY), "コンテナ状態が保存される");

  const got = await containersRoute.GET(apiRequest(`${URL_C}?x=${GRASS.x}&y=${GRASS.y}`, "GET", cookie));
  assert.deepEqual((await got.json()).container.slots[2], { id: "wood", count: 5 });

  const back = await containersRoute.POST(apiRequest(URL_C, "POST", cookie, {
    action: "move", x: GRASS.x, y: GRASS.y,
    from: { side: "container", index: 2 }, to: { side: "profile_storage", index: 0 },
  }));
  assert.equal(back.status, 200);
  const backData = await back.json();
  assert.equal(backData.container.slots[2], null);
  assert.equal(inv.countItem(backData.profile, "wood"), 5);

  const bad = await containersRoute.POST(apiRequest(URL_C, "POST", cookie, {
    action: "move", x: GRASS.x, y: GRASS.y,
    from: { side: "vault", index: 0 }, to: { side: "container", index: 0 },
  }));
  assert.equal(bad.status, 400, "不正な住所は 400");
});

test("API(containers): 遠くのコンテナは隣接検証で 409", async () => {
  resetStores();
  seedBarrel(MY_ID);
  seedProfile(MY_KEY, profWith([slot("wood", 5), null, null, null, null], emptySlots(10)));
  globalThis.__wbContainerPresence = [
    { id: MY_ID, space: "world", x: GRASS.x + 10, y: GRASS.y, ts: Date.now() },
  ];
  const cookie = sessionCookie(ME, "owner");
  const res = await containersRoute.POST(apiRequest(URL_C, "POST", cookie, {
    action: "move", x: GRASS.x, y: GRASS.y,
    from: { side: "profile_hotbar", index: 0 }, to: { side: "container", index: 0 },
  }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "too_far");
});

test("API(tiles): 中身がある樽は掘れず、空にすると回収できて状態も消える", async () => {
  resetStores();
  seedProfile(MY_KEY, profWith([slot("barrel", 1), slot("wood", 5), null, null, null], emptySlots(10)));
  const cookie = sessionCookie(ME, "owner");
  const placed = await tilesRoute.POST(apiRequest(URL_T, "POST", cookie, {
    action: "place_block", x: GRASS.x, y: GRASS.y, itemId: "barrel",
  }));
  assert.equal(placed.status, 200);

  const put = await containersRoute.POST(apiRequest(URL_C, "POST", cookie, {
    action: "move", x: GRASS.x, y: GRASS.y,
    from: { side: "profile_hotbar", index: 1 }, to: { side: "container", index: 0 },
  }));
  assert.equal(put.status, 200);

  const blocked = await tilesRoute.POST(apiRequest(URL_T, "POST", cookie, {
    action: "mine_block", x: GRASS.x, y: GRASS.y,
  }));
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, "not_empty");
  assert.ok(globalThis.__wbContainerTiles.has(KEY), "ブロックは残る");

  const take = await containersRoute.POST(apiRequest(URL_C, "POST", cookie, {
    action: "move", x: GRASS.x, y: GRASS.y,
    from: { side: "container", index: 0 }, to: { side: "profile_hotbar", index: 1 },
  }));
  assert.equal(take.status, 200);

  // HP制: 樽（既定 HP10）は素手6で2ヒット。1ヒットでは残り、状態も消えない
  const hit = await tilesRoute.POST(apiRequest(URL_T, "POST", cookie, {
    action: "mine_block", x: GRASS.x, y: GRASS.y,
  }));
  assert.equal(hit.status, 200);
  assert.deepEqual((await hit.json()).gained, {});
  assert.ok(globalThis.__wbContainerTiles.has(KEY), "1ヒットではブロックは残る");

  const dug = await tilesRoute.POST(apiRequest(URL_T, "POST", cookie, {
    action: "mine_block", x: GRASS.x, y: GRASS.y,
  }));
  assert.equal(dug.status, 200);
  assert.deepEqual((await dug.json()).gained, { barrel: 1 });
  assert.equal(globalThis.__wbContainerTiles.has(KEY), false, "上書きが消える");
  assert.equal(globalThis.__wbContainers.has(CKEY), false, "コンテナ状態も消える");
});

test("API(tiles): 空の樽は設置者以外でも回収できる（中身があれば誰でも掘れない）", async () => {
  resetStores();
  seedBarrel(MY_ID);
  seedProfile(OTHER_KEY, profWith(emptySlots(5), emptySlots(10)));
  const otherCookie = sessionCookie(OTHER, "guest");
  // 中身がある間は設置者以外でも掘れない
  const filled = C.emptyContainer(MY_ID, "barrel");
  filled.slots[0] = slot("stone", 1);
  globalThis.__wbContainers.set(CKEY, C.serializeContainerState(filled));
  const blocked = await tilesRoute.POST(apiRequest(URL_T, "POST", otherCookie, {
    action: "mine_block", x: GRASS.x, y: GRASS.y,
  }));
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, "not_empty");
  // 空なら設置者以外でも回収でき、樽は掘った者のものになる
  globalThis.__wbContainers.set(CKEY, C.serializeContainerState(C.emptyContainer(MY_ID, "barrel")));
  const hit = await tilesRoute.POST(apiRequest(URL_T, "POST", otherCookie, {
    action: "mine_block", x: GRASS.x, y: GRASS.y,
  }));
  assert.equal(hit.status, 200, "他人の空樽でもヒットできる");
  const dug = await tilesRoute.POST(apiRequest(URL_T, "POST", otherCookie, {
    action: "mine_block", x: GRASS.x, y: GRASS.y,
  }));
  assert.equal(dug.status, 200);
  assert.deepEqual((await dug.json()).gained, { barrel: 1 }, "回収した樽は掘った者に入る");
  assert.equal(globalThis.__wbContainerTiles.has(KEY), false);
  // 対照: コンテナでない他人のブロックは従来どおり掘れない
  resetStores();
  seedProfile(MY_KEY, profWith([slot("dirt_block", 1), null, null, null, null], emptySlots(10)));
  const cookie = sessionCookie(ME, "owner");
  const placed = await tilesRoute.POST(apiRequest(URL_T, "POST", cookie, {
    action: "place_block", x: GRASS.x, y: GRASS.y, itemId: "dirt_block",
  }));
  assert.equal(placed.status, 200);
  const denied = await tilesRoute.POST(apiRequest(URL_T, "POST", otherCookie, {
    action: "mine_block", x: GRASS.x, y: GRASS.y,
  }));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, "not_owner");
});

test("API(tiles, S4): 同じ樽への並行 mine_block でも回収は1回だけ（二重掘りの回帰防止）", async () => {
  resetStores();
  seedProfile(MY_KEY, profWith([slot("barrel", 1), null, null, null, null], emptySlots(10)));
  const cookie = sessionCookie(ME, "owner");
  const placed = await tilesRoute.POST(apiRequest(URL_T, "POST", cookie, {
    action: "place_block", x: GRASS.x, y: GRASS.y, itemId: "barrel",
  }));
  assert.equal(placed.status, 200);
  // 二重タップ/リトライを再現して同時に掘る（HP制: 樽 HP10 を素手6で
  // 3連打すると ヒット→破壊→no_block になり、回収は1回だけ起きる）
  const responses = await Promise.all([0, 1, 2].map(() =>
    tilesRoute.POST(apiRequest(URL_T, "POST", cookie, { action: "mine_block", x: GRASS.x, y: GRASS.y })),
  ));
  const bodies = [];
  for (const res of responses) bodies.push({ status: res.status, body: await res.json() });
  assert.deepEqual(bodies.map((b) => b.status).sort(), [200, 200, 409], "ヒットと破壊が1回ずつ、残りは失敗する");
  assert.equal(bodies.filter((b) => b.body.gained?.barrel === 1).length, 1, "回収は1回だけ");
  assert.equal(bodies.find((b) => b.status === 409).body.error, "no_block", "掘られた後のブロックは無い");
});

test("API(containers): テントの備え付け樽が収納として開け、出し入れできる", async () => {
  resetStores();
  // tier 0 のテント内装: 樽は (2, 8)、木箱は (1, 8)
  globalThis.__wbContainerPresence = [
    { id: MY_ID, space: "tent", x: 2, y: 7, ts: Date.now() },
  ];
  seedProfile(MY_KEY, profWith([slot("wood", 5), null, null, null, null], emptySlots(10)));
  const cookie = sessionCookie(ME, "owner");
  const res = await containersRoute.GET(apiRequest(`${URL_C}?x=2&y=8&space=tent`, "GET", cookie));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.itemId, "barrel");
  assert.equal(data.capacity, 10);
  assert.equal(data.container.slots.length, 10);
  // 木箱も開ける（容量 8）
  const crate = await containersRoute.GET(apiRequest(`${URL_C}?x=1&y=8&space=tent`, "GET", cookie));
  assert.equal(crate.status, 200);
  assert.equal((await crate.json()).itemId, "crate");
  // 収納でない家具（ソファ）は 404（隣に立って確認する）
  globalThis.__wbContainerPresence = [
    { id: MY_ID, space: "tent", x: 11, y: 7, ts: Date.now() },
  ];
  const sofa = await containersRoute.GET(apiRequest(`${URL_C}?x=11&y=8&space=tent`, "GET", cookie));
  assert.equal(sofa.status, 404);
  globalThis.__wbContainerPresence = [
    { id: MY_ID, space: "tent", x: 2, y: 7, ts: Date.now() },
  ];
  // space 無し（world 扱い）ではテントの位置が無いので開けない
  const asWorld = await containersRoute.GET(apiRequest(`${URL_C}?x=2&y=8`, "GET", cookie));
  assert.equal(asWorld.status, 409);
  assert.equal((await asWorld.json()).error, "position_unknown");
  // 出し入れは tent キーで保存される
  const moved = await containersRoute.POST(apiRequest(URL_C, "POST", cookie, {
    action: "move", space: "tent", x: 2, y: 8,
    from: { side: "profile_hotbar", index: 0 }, to: { side: "container", index: 0 },
  }));
  assert.equal(moved.status, 200);
  assert.deepEqual((await moved.json()).container.slots[0], { id: "wood", count: 5 });
  assert.ok(globalThis.__wbContainers.has("tent|2,8"), "tent キーで保存される");
});

test("API(containers): テントを拡張しても樽の中身が付いてくる（保存キーの正規化）", async () => {
  resetStores();
  const seeded = C.emptyContainer(MY_ID, "barrel");
  seeded.slots[0] = slot("stone", 3);
  globalThis.__wbContainers.set("tent|2,8", C.serializeContainerState(seeded));
  const prof2 = profWith(emptySlots(5), emptySlots(10));
  prof2.tentTier = 2; // tier 2 では樽は (2, 15) に移る
  seedProfile(MY_KEY, prof2);
  globalThis.__wbContainerPresence = [
    { id: MY_ID, space: "tent", x: 2, y: 14, ts: Date.now() },
  ];
  const cookie = sessionCookie(ME, "owner");
  const res = await containersRoute.GET(apiRequest(`${URL_C}?x=2&y=15&space=tent`, "GET", cookie));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.itemId, "barrel");
  assert.deepEqual(data.container.slots[0], { id: "stone", count: 3 }, "拡張前の樽の中身が読める");
});

test("API(containers): ロビーの備え付け樽が収納として開け、中身は全員共有で保存される", async () => {
  resetStores();
  // ロビー1Fの備え付け樽は (15, 24)、木箱は (16, 23)
  globalThis.__wbContainerPresence = [
    { id: MY_ID, space: "lobby", x: 14, y: 24, ts: Date.now() },
  ];
  seedProfile(MY_KEY, profWith([slot("wood", 5), null, null, null, null], emptySlots(10)));
  const cookie = sessionCookie(ME, "owner");
  const res = await containersRoute.GET(apiRequest(`${URL_C}?x=15&y=24&space=lobby`, "GET", cookie));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.itemId, "barrel");
  assert.equal(data.capacity, 10);
  assert.ok(data.container.slots.every((s) => s === null));
  const moved = await containersRoute.POST(apiRequest(URL_C, "POST", cookie, {
    action: "move", space: "lobby", x: 15, y: 24,
    from: { side: "profile_hotbar", index: 0 }, to: { side: "container", index: 0 },
  }));
  assert.equal(moved.status, 200);
  assert.deepEqual((await moved.json()).container.slots[0], { id: "wood", count: 5 });
  // 保存キーは共有（lobby|15,24）
  assert.ok(globalThis.__wbContainers.has("lobby|15,24"), "共有キーで保存される");
  // 別のプレイヤーが同じ樽を開くと、入れた物が見える（全員共有）
  globalThis.__wbContainerPresence = [
    { id: T.presenceIdFor(OTHER_KEY), space: "lobby", x: 14, y: 24, ts: Date.now() },
  ];
  seedProfile(OTHER_KEY, profWith(emptySlots(5), emptySlots(10)));
  const otherCookie = sessionCookie(OTHER, "guest");
  const resB = await containersRoute.GET(apiRequest(`${URL_C}?x=15&y=24&space=lobby`, "GET", otherCookie));
  assert.equal(resB.status, 200);
  assert.deepEqual((await resB.json()).container.slots[0], { id: "wood", count: 5 }, "中身は全員に共有される");
  // 収納でない備え付け（ベンチ）は 404
  globalThis.__wbContainerPresence = [
    { id: MY_ID, space: "lobby", x: 9, y: 6, ts: Date.now() },
  ];
  const bench = await containersRoute.GET(apiRequest(`${URL_C}?x=9&y=7&space=lobby`, "GET", cookie));
  assert.equal(bench.status, 404);
});

test("座席リスト: 室内（lobby の SEAT_SPRITES）とタイル側（tiles の SEAT_ITEM_IDS）が一致する", () => {
  const tilesSrc = fs.readFileSync(path.join(libDir, "worldbox/tiles.ts"), "utf8");
  const m = tilesSrc.match(/SEAT_ITEM_IDS[^=]*=\s*\[([^\]]+)\]/);
  assert.ok(m, "SEAT_ITEM_IDS が見つからない");
  const ids = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
  assert.deepEqual([...tentMod.SEAT_SPRITES].sort(), ids);
});

// ---------- クライアント配線 ----------

test("クライアント: コンテナのタップ分岐・パネル・回収が配線されている", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("isContainerItem(view.block.itemId)"), "タップ時のコンテナ判定が無い");
  assert.ok(client.includes("openContainerRef.current"), "コンテナを開く導線が無い");
  assert.ok(client.includes("/api/worldbox/containers"), "コンテナ API を呼んでいない");
  assert.ok(client.includes("containerPanel"), "コンテナパネルが無い");
  assert.ok(client.includes("renderPanelSlot"), "コンテナパネルのグリッドが無い");
  assert.ok(client.includes("tapPanelSlot"), "パネルのスロットタップが無い");
  // 室内タップ: 座席に座る配線と、室内の収納家具を開く配線
  assert.ok(client.includes("handleIndoorTap"), "室内タップ処理が無い");
  assert.ok(client.includes("openContainerRef.current("), "室内収納を開く導線が無い");
  assert.ok(client.includes("space as \"tent\" | \"lobby\" | \"lobby2\" | \"lobby3\""), "室内の空間がコンテナ取得に渡っていない");
  const containersRouteSrc2 = fs.readFileSync(path.join(rootDir, "app/api/worldbox/containers/route.ts"), "utf8");
  assert.ok(containersRouteSrc2.includes("buildTent"), "コンテナルートがテント内装を解決していない");
  assert.ok(containersRouteSrc2.includes("buildLobby"), "コンテナルートがロビー内装を解決していない");
  assert.ok(containersRouteSrc2.includes("fixtureStoreSpace"), "備え付け収納の保存キーが無い");
  assert.ok(client.includes("not_empty"), "not_empty のラベルが無い");
  assert.ok(client.includes("中身が入っている"), "not_empty の文面が無い");
  // 空のときだけ回収ボタンを出し、mine_block を送る
  assert.ok(client.includes("containerEmpty"), "空判定が無い");
  assert.ok(client.includes('postTileAction("mine_block", p.x, p.y)'), "回収が mine_block を送っていない");
  const routeSrc = fs.readFileSync(path.join(rootDir, "app/api/worldbox/tiles/route.ts"), "utf8");
  assert.ok(routeSrc.includes("not_empty"), "タイルルートに not_empty 検証が無い");
  assert.ok(routeSrc.includes("loadContainer"), "タイルルートがコンテナ状態を見ていない");
  // S4: コンテナキーは空間修飾つき、出し入れはユーザー単位ロックで直列化する
  const containersRouteSrc = fs.readFileSync(path.join(rootDir, "app/api/worldbox/containers/route.ts"), "utf8");
  assert.ok(containersRouteSrc.includes("withUserLock(ownerKey"), "コンテナルートがユーザー単位で直列化されていない（S4）");
  assert.ok(containersRouteSrc.includes('loadContainer("world"'), "コンテナルートが空間つきキーを使っていない（S4）");
  const containersOnlineSrc = fs.readFileSync(path.join(libDir, "worldbox/containers-online.ts"), "utf8");
  assert.ok(containersOnlineSrc.includes("containerKey"), "空間修飾キー containerKey が無い（S4）");
});
