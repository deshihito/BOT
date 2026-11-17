// AGO WORLD BOX の場所制約（施設ゲート）の検証:
// - 純粋ロジック: 固定式スティック（基点・当たり判定・倒し量）
// - サーバー検証: 売買=ショップ前、合成=作業台（鍛冶屋）前、送金=銀行前、
//   掲示板投稿=掲示板前。位置の正はプレゼンス（ロビーの実配置で判定し、
//   ワールド・広場・別の施設・プレゼンス無しはすべて 409）
// - クライアント配線: 経済パネルへステーションを渡す、スティックは固定式
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

// ---------- 固定式スティック（純粋ロジック） ----------

const stick = await import(dataUrl(transpile("worldbox/stick.ts")));

test("stick: 基点はキャンバス左下の固定位置（タッチした場所に出ない）", () => {
  assert.deepEqual(stick.stickBase(800, 600), { x: 78, y: 522 });
  assert.deepEqual(stick.stickBase(390, 700), { x: 78, y: 622 });
  // 小さいキャンバスでも基点が上端より上へ出ない
  assert.equal(stick.stickBase(300, 100).y, 78);
});

test("stick: スティックになるのは基点の円の中から始まったタッチだけ", () => {
  const base = stick.stickBase(800, 600);
  assert.equal(stick.isStickTouch(base.x, base.y, base), true);
  assert.equal(stick.isStickTouch(base.x + stick.STICK_HIT_RADIUS, base.y, base), true);
  // 画面中央や右側のタッチ（ブロック設置・採掘のタップ）はスティックにならない
  assert.equal(stick.isStickTouch(400, 300, base), false);
  assert.equal(stick.isStickTouch(700, 100, base), false);
  assert.equal(stick.isStickTouch(base.x, 100, base), false);
});

test("stick: 倒し量は基点からの相対量で、長さ1でクランプされる", () => {
  const base = { x: 78, y: 522 };
  assert.deepEqual(stick.stickVector(base.x, base.y, base), { dx: 0, dy: 0 });
  const half = stick.stickVector(base.x + stick.STICK_RADIUS / 2, base.y, base);
  assert.equal(half.dx, 0.5);
  assert.equal(half.dy, 0);
  const over = stick.stickVector(base.x + stick.STICK_RADIUS * 3, base.y, base);
  assert.equal(over.dx, 1);
  assert.equal(over.dy, 0);
});

// ---------- API（実モジュール配線: プレゼンス→ステーション判定→各ルート） ----------

const botApiStubUrl = dataUrl(`
const store = new Map();
const users = new Map();
globalThis.__wbGateStore = store;
globalThis.__wbGateUsers = users;
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
export class BotApiError extends Error { constructor(status, code) { super("api " + status); this.status = status; this.code = code; } }
export async function tableInsert(table, values) {
  if (table === "users") { if (!users.has(values.user_id)) users.set(values.user_id, values.balance); return; }
  if (table === "transaction_history") { (globalThis.__wbHistory ??= []).push(values); return; }
  throw new Error("unexpected table " + table);
}
export async function tableUpdate(table, values, filters) {
  if (table !== "users") throw new Error("unexpected table " + table);
  const id = filters.find((f) => f.column === "user_id")?.value;
  const bal = filters.find((f) => f.column === "balance")?.value;
  if (!users.has(id)) return [];
  if (bal !== undefined && users.get(id) !== bal) return [];
  users.set(id, values.balance);
  return [{ user_id: id, balance: values.balance }];
}
export async function rpc(name, params) {
  if (name !== "transfer_coins") throw new Error("unexpected rpc " + name);
  const senderBalance = users.get(params.p_sender_id) ?? 0;
  if (senderBalance < params.p_amount) throw new BotApiError(400, "P0001");
  users.set(params.p_sender_id, senderBalance - params.p_amount);
  users.set(params.p_receiver_id, (users.has(params.p_receiver_id) ? users.get(params.p_receiver_id) : params.p_new_user_balance) + params.p_amount);
  return users.get(params.p_sender_id);
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
const lobbyUrl = dataUrl(transpile("worldbox/lobby.ts").replaceAll('"./mapgen"', JSON.stringify(mapgenUrl)));
const itemsUrl = dataUrl(transpile("worldbox/items.ts"));
const shopsRealUrl = dataUrl(transpile("worldbox/shops.ts").replaceAll('"./items"', JSON.stringify(itemsUrl)));
// 日次ローテーションは日付依存なので、この場所ゲートテストでは中立化する。
const shopsUrl = dataUrl(`
import * as real from ${JSON.stringify(shopsRealUrl)};
export const checkBuyGenre = real.checkBuyGenre;
export const checkBuySold = real.checkBuySold;
export function checkDailyStock() { return null; }
export function dailyPriceFor(item) { return item.price; }
export function shopDayKeyOf() { return "test-day"; }
`);
const profileUrl = dataUrl(transpile("worldbox/profile.ts").replaceAll('"./items"', JSON.stringify(itemsUrl)));
const vitalsUrl = dataUrl(
  transpile("worldbox/vitals.ts").replaceAll('"./items"', JSON.stringify(itemsUrl)).replaceAll('"./profile"', JSON.stringify(profileUrl)),
);
const economyLogicUrl = dataUrl(
  transpile("worldbox/economy.ts").replaceAll('"./items"', JSON.stringify(itemsUrl)).replaceAll('"./profile"', JSON.stringify(profileUrl)).replaceAll('"./vitals"', JSON.stringify(vitalsUrl)),
);
const bridgeUrl = dataUrl(transpile("worldbox/economy-bridge.ts"));
const economyOnlineUrl = dataUrl(
  transpile("worldbox/economy-bridge-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./economy-bridge"', JSON.stringify(bridgeUrl)),
);
const presenceUrl = dataUrl(transpile("worldbox/presence.ts"));
const presenceOnlineUrl = dataUrl(
  transpile("worldbox/presence-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./presence"', JSON.stringify(presenceUrl)),
);
const tentUrl = dataUrl(
  transpile("worldbox/tent.ts")
    .replaceAll('"./mapgen"', JSON.stringify(mapgenUrl))
    .replaceAll('"./lobby"', JSON.stringify(lobbyUrl)),
);
const floorsUrl = dataUrl(
  transpile("worldbox/lobby-floors.ts")
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
  transpile("worldbox/save-online.ts").replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl)),
);
const profileOnlineUrl = dataUrl(
  transpile("worldbox/profile-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./profile"', JSON.stringify(profileUrl)),
);
const tilesStubUrl = dataUrl(`export function placedStationKinds() { return []; }`);
const tilesOnlineStubUrl = dataUrl(`export async function loadTileOverride() { return null; }`);
const stationOnlineUrl = dataUrl(
  transpile("worldbox/station-online.ts")
    .replaceAll('"./lobby"', JSON.stringify(lobbyUrl))
    .replaceAll('"./lobby-floors"', JSON.stringify(floorsUrl))
    .replaceAll('"./tent"', JSON.stringify(tentUrl))
    .replaceAll('"./presence-online"', JSON.stringify(presenceOnlineUrl))
    .replaceAll('"./save"', JSON.stringify(saveUrl))
    .replaceAll('"./save-online"', JSON.stringify(saveOnlineUrl))
    .replaceAll('"./profile-online"', JSON.stringify(profileOnlineUrl))
    .replaceAll('"./tiles"', JSON.stringify(tilesStubUrl))
    .replaceAll('"./tiles-online"', JSON.stringify(tilesOnlineStubUrl)),
);
const boardUrl = dataUrl(transpile("worldbox/board.ts"));
const boardOnlineUrl = dataUrl(
  transpile("worldbox/board-online.ts")
    .replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl))
    .replaceAll('"./board"', JSON.stringify(boardUrl)),
);
const userLockUrl = dataUrl(transpile("worldbox/user-lock.ts"));
const nextServerStubUrl = dataUrl(`
export class NextResponse {
  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(body), { status: init.status || 200, headers });
  }
}
`);
const rolesUrl = dataUrl(transpile("worldbox/roles.ts").replaceAll('"./profile"', JSON.stringify(profileUrl)));
const tentStubUrl = dataUrl(`export const TENT_MAX_TIER = 2; export const TENT_TIERS = [{ w: 13, h: 10, price: 0 }, { w: 17, h: 13, price: 3000 }, { w: 22, h: 17, price: 10000 }];`);
const profileRoute = await import(
  dataUrl(
    transpile("api/worldbox/profile/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/worldbox/economy"', JSON.stringify(economyLogicUrl))
      .replaceAll('"@/lib/worldbox/economy-bridge"', JSON.stringify(bridgeUrl))
      .replaceAll('"@/lib/worldbox/economy-bridge-online"', JSON.stringify(economyOnlineUrl))
      .replaceAll('"@/lib/worldbox/profile"', JSON.stringify(profileUrl))
      .replaceAll('"@/lib/worldbox/presence-online"', JSON.stringify(presenceOnlineUrl))
      .replaceAll('"@/lib/worldbox/shops"', JSON.stringify(shopsUrl))
      .replaceAll('"@/lib/worldbox/items"', JSON.stringify(itemsUrl))
      .replaceAll('"@/lib/worldbox/tent"', JSON.stringify(tentStubUrl))
      .replaceAll('"@/lib/worldbox/station-online"', JSON.stringify(stationOnlineUrl))
      .replaceAll('"@/lib/worldbox/profile-online"', JSON.stringify(profileOnlineUrl))
      .replaceAll('"@/lib/worldbox/user-lock"', JSON.stringify(userLockUrl))
      .replaceAll('"@/lib/worldbox/roles"', JSON.stringify(rolesUrl)),
  ),
);
const economyRoute = await import(
  dataUrl(
    transpile("api/worldbox/economy/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/worldbox/economy-bridge"', JSON.stringify(bridgeUrl))
      .replaceAll('"@/lib/worldbox/economy-bridge-online"', JSON.stringify(economyOnlineUrl))
      .replaceAll('"@/lib/worldbox/station-online"', JSON.stringify(stationOnlineUrl)),
  ),
);
const boardRoute = await import(
  dataUrl(
    transpile("api/worldbox/board/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/worldbox/board"', JSON.stringify(boardUrl))
      .replaceAll('"@/lib/worldbox/board-online"', JSON.stringify(boardOnlineUrl))
      .replaceAll('"@/lib/worldbox/station-online"', JSON.stringify(stationOnlineUrl)),
  ),
);

process.env.DISCORD_SESSION_SECRET = ["worldbox", "place", "gates", "test"].join("-");
const ME = "611111111111111111";
const OTHER = "622222222222222222";
const MY_KEY = `discord:${ME}`;
const cookie = `ago_session=${encodeURIComponent(auth.createSession({ id: ME, username: "gate-user" }))}`;

function apiRequest(url, method, body) {
  return new Request(url, {
    method,
    headers: { cookie, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
function setPresence(x, y, space = "lobby") {
  globalThis.__wbGateStore.set(`worldbox_presence ${MY_KEY}`, JSON.stringify({
    name: "gate-user", x, y, vx: 0, vy: 0, face: 1, space, ts: Date.now(),
  }));
}
function clearPresence() {
  globalThis.__wbGateStore.delete(`worldbox_presence ${MY_KEY}`);
}
function seedProfile(items) {
  globalThis.__wbGateStore.set(`worldbox_profiles ${MY_KEY}`, JSON.stringify({
    coins: 100, hunger: 100, items, stealActorAt: 0, stealTargetAt: 0,
  }));
}
function economyOpCount() {
  let n = 0;
  for (const k of globalThis.__wbGateStore.keys()) if (k.startsWith("worldbox_economy ")) n++;
  return n;
}

// ロビーの実配置での立つ位置（stationNear がその施設を返す座標）
const AT_SHOP = { x: 5.5, y: 21.5 }; // ショップカウンターの前
const AT_SMITH = { x: 25.5, y: 37.5 }; // 鍛冶屋の作業台の前
const AT_BANK = { x: 34.5, y: 18.5 }; // 銀行カウンターの前
const AT_BOARD = { x: 28.5, y: 16.5 }; // 掲示板の前
const AT_PLAZA = { x: 28.5, y: 28.5 }; // 広場（どの施設の前でもない）

const URL_P = "http://localhost/api/worldbox/profile";
const URL_E = "http://localhost/api/worldbox/economy";
const URL_B = "http://localhost/api/worldbox/board";

test("API(place): buy はショップの前でのみ通る", async () => {
  globalThis.__wbGateUsers.set(ME, 1000);
  seedProfile({});
  setPresence(AT_SHOP.x, AT_SHOP.y);
  // AT_SHOP は道具屋のカウンター前なので、買えるのは道具ジャンル
  const ok = await profileRoute.POST(apiRequest(URL_P, "POST", { action: "buy", itemId: "wooden_axe" }));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).profile.items.wooden_axe, 1);

  for (const [name, pos, space] of [
    ["広場", AT_PLAZA, "lobby"],
    ["銀行の前", AT_BANK, "lobby"],
    ["ワールド", { x: 512.5, y: 512.5 }, "world"],
  ]) {
    seedProfile({});
    setPresence(pos.x, pos.y, space);
    const res = await profileRoute.POST(apiRequest(URL_P, "POST", { action: "buy", itemId: "wood" }));
    assert.equal(res.status, 409, name);
    assert.equal((await res.json()).error, "not_at_shop", name);
  }
  clearPresence();
  const noPresence = await profileRoute.POST(apiRequest(URL_P, "POST", { action: "buy", itemId: "wood" }));
  assert.equal(noPresence.status, 409);
  assert.equal((await noPresence.json()).error, "not_at_shop");
});

test("API(place): sell はショップの前でのみ通る", async () => {
  seedProfile({ wood: 1 });
  setPresence(AT_BANK.x, AT_BANK.y);
  const ng = await profileRoute.POST(apiRequest(URL_P, "POST", { action: "sell", itemId: "wood" }));
  assert.equal(ng.status, 409);
  assert.equal((await ng.json()).error, "not_at_shop");
  setPresence(AT_SHOP.x, AT_SHOP.y);
  const ok = await profileRoute.POST(apiRequest(URL_P, "POST", { action: "sell", itemId: "wood" }));
  assert.equal(ok.status, 200);
});

test("API(place): buy は店のジャンルと合う品目だけ買える（wrong_shop）", async () => {
  globalThis.__wbGateUsers.set(ME, 1000);
  seedProfile({});
  // 道具屋の前で素材（種・素材屋の品目）は買えない
  setPresence(AT_SHOP.x, AT_SHOP.y);
  const wrong = await profileRoute.POST(apiRequest(URL_P, "POST", { action: "buy", itemId: "wood" }));
  assert.equal(wrong.status, 409);
  assert.equal((await wrong.json()).error, "wrong_shop");
  // 種・素材屋の前では買える
  setPresence(13.5, 26.5);
  const ok = await profileRoute.POST(apiRequest(URL_P, "POST", { action: "buy", itemId: "wood" }));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).profile.items.wood, 1);
  // 鍛冶屋は販売品目ゼロ（案C）: ジャンルが合う合成品でも not_sold、
  // ジャンル違いは wrong_shop が優先し、売却はジャンル不問で通る
  seedProfile({ wood: 1 });
  setPresence(AT_SMITH.x, AT_SMITH.y);
  const smithOk = await profileRoute.POST(apiRequest(URL_P, "POST", { action: "buy", itemId: "carving" }));
  assert.equal(smithOk.status, 409);
  assert.equal((await smithOk.json()).error, "not_sold");
  const smithWrong = await profileRoute.POST(apiRequest(URL_P, "POST", { action: "buy", itemId: "wood" }));
  assert.equal(smithWrong.status, 409);
  assert.equal((await smithWrong.json()).error, "wrong_shop");
  const sold = await profileRoute.POST(apiRequest(URL_P, "POST", { action: "sell", itemId: "wood" }));
  assert.equal(sold.status, 200);
});

test("API(place): ホワイトリスト外はジャンルが合っても買えない（not_sold）が、売却はできる", async () => {
  globalThis.__wbGateUsers.set(ME, 5000);
  seedProfile({});
  // 鍛冶屋で特殊（ジャンルは合う）を買おうとしても not_sold
  setPresence(AT_SMITH.x, AT_SMITH.y);
  const special = await profileRoute.POST(apiRequest(URL_P, "POST", { action: "buy", itemId: "star_shard" }));
  assert.equal(special.status, 409);
  assert.equal((await special.json()).error, "not_sold");
  // 道具屋でミスリル tier4（ジャンルは合う）も not_sold
  setPresence(AT_SHOP.x, AT_SHOP.y);
  const mithril = await profileRoute.POST(apiRequest(URL_P, "POST", { action: "buy", itemId: "mithril_axe" }));
  assert.equal(mithril.status, 409);
  assert.equal((await mithril.json()).error, "not_sold");
  // 建築屋カウンター前で宝石ブロックも not_sold
  setPresence(9.5, 21.5);
  const gem = await profileRoute.POST(apiRequest(URL_P, "POST", { action: "buy", itemId: "diamond_block" }));
  assert.equal(gem.status, 409);
  assert.equal((await gem.json()).error, "not_sold");
  // ジャンルも合わないレア品は wrong_shop が優先される
  setPresence(AT_SHOP.x, AT_SHOP.y);
  const both = await profileRoute.POST(apiRequest(URL_P, "POST", { action: "buy", itemId: "star_shard" }));
  assert.equal(both.status, 409);
  assert.equal((await both.json()).error, "wrong_shop");
  // レア品の売却はジャンル不問で通る
  seedProfile({ star_shard: 1 });
  setPresence(AT_SMITH.x, AT_SMITH.y);
  const sold = await profileRoute.POST(apiRequest(URL_P, "POST", { action: "sell", itemId: "star_shard" }));
  assert.equal(sold.status, 200);
});

test("API(place): craft は作業台（鍛冶屋）の前でのみ通る", async () => {
  seedProfile({ wood: 3 });
  setPresence(AT_SHOP.x, AT_SHOP.y);
  const ng = await profileRoute.POST(apiRequest(URL_P, "POST", { action: "craft", recipeId: "carving" }));
  assert.equal(ng.status, 409);
  assert.equal((await ng.json()).error, "not_at_workbench");
  setPresence(AT_SMITH.x, AT_SMITH.y);
  const ok = await profileRoute.POST(apiRequest(URL_P, "POST", { action: "craft", recipeId: "carving" }));
  assert.equal(ok.status, 200);
  const data = await ok.json();
  assert.equal(data.profile.items.carving, 1);
  assert.equal(data.profile.items.wood, undefined);
});

test("API(place): transfer は銀行の前でのみ通り、弾かれたらオプは積まれない", async () => {
  globalThis.__wbGateUsers.set(ME, 1000);
  const before = economyOpCount();
  setPresence(AT_SHOP.x, AT_SHOP.y);
  const ng = await economyRoute.POST(apiRequest(URL_E, "POST", { action: "transfer", toDiscordId: OTHER, amount: 100 }));
  assert.equal(ng.status, 409);
  assert.equal((await ng.json()).error, "not_at_bank");
  assert.equal(economyOpCount(), before, "場所が違う送金でオプが積まれている");
  setPresence(AT_BANK.x, AT_BANK.y);
  const ok = await economyRoute.POST(apiRequest(URL_E, "POST", { action: "transfer", toDiscordId: OTHER, amount: 100 }));
  assert.equal(ok.status, 200);
  assert.equal(economyOpCount(), before + 1);
});

test("API(place): 掲示板の投稿は掲示板の前でのみ通り、閲覧はどこでもよい", async () => {
  setPresence(AT_PLAZA.x, AT_PLAZA.y);
  const ng = await boardRoute.POST(apiRequest(URL_B, "POST", { text: "広場から投稿" }));
  assert.equal(ng.status, 409);
  assert.equal((await ng.json()).error, "not_at_board");
  setPresence(AT_BOARD.x, AT_BOARD.y);
  const ok = await boardRoute.POST(apiRequest(URL_B, "POST", { text: "掲示板から投稿" }));
  assert.equal(ok.status, 200);
  const list = await (await boardRoute.GET(apiRequest(URL_B, "GET"))).json();
  assert.equal(list.posts[0].text, "掲示板から投稿");
});

// ---------- クライアント配線 ----------

test("クライアント: スティックは固定式で、タイルタップと分離されている", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("stickBase"), "固定基点を使っていない");
  assert.ok(client.includes("isStickTouch"), "スティックの当たり判定を使っていない");
  assert.ok(client.includes("stickVector"), "固定基点からの倒し量を使っていない");
  assert.ok(!client.includes("joy.baseX"), "フローティング基点が残っている");
  assert.ok(!client.includes("p.w * 0.62"), "タッチ位置でスティックを出す旧判定が残っている");
});

test("クライアント: 施設パネルは離れたら閉じる（掲示板・カジノ・ギルドボード）", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes('if (stationUi !== "board") setBoardOpen(false);'));
  assert.ok(client.includes('if (stationUi !== "casino") setCasinoOpen(false);'));
  assert.ok(client.includes('if (stationUi !== "guild") setGuildBoardOpen(false);'), "ギルドボードが自動で閉じない");
  // 役職操作の場所エラーに専用ラベルがある
  assert.ok(client.includes('not_at_guild_board: "ギルドボードの前で操作してください"'));
  // サーバー側も役職の操作をギルドボード前で検証する
  const nationsRoute = fs.readFileSync(path.join(rootDir, "app/api/worldbox/nations/route.ts"), "utf8");
  assert.match(nationsRoute, /loadMyLobbyStation/);
  assert.match(nationsRoute, /not_at_guild_board/);
});

test("API(place): sell の並行リクエストでも earn オプは1件だけ（二重売却の回帰防止）", async () => {
  const store = globalThis.__wbGateStore;
  for (const k of [...store.keys()]) if (k.startsWith("worldbox_economy ")) store.delete(k);
  seedProfile({ wood: 1 });
  setPresence(AT_SHOP.x, AT_SHOP.y);
  const results = await Promise.all([
    profileRoute.POST(apiRequest(URL_P, "POST", { action: "sell", itemId: "wood" })),
    profileRoute.POST(apiRequest(URL_P, "POST", { action: "sell", itemId: "wood" })),
    profileRoute.POST(apiRequest(URL_P, "POST", { action: "sell", itemId: "wood" })),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 2);
  let earns = 0;
  for (const [k, v] of store) {
    if (k.startsWith("worldbox_economy ") && v && typeof v === "object" && v.kind === "earn" && v.reason === "shop_sale") earns++;
  }
  assert.equal(earns, 1, "売却の earn は1件だけ積まれる（同じ木材が二重に売れない）");
});
