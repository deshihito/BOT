// AGO WORLD BOX ギルド依頼の検証:
// - 純粋ロジック（投稿=spend預かり・納品=アイテム移動+earn報酬・取消=earn返金、
//   上限と検証、保存形式の読み書き）
// - ロビーのギルドボード（station "guild" のオブジェクト配置）
// - クライアント配線（ステーションチップ→ギルドボードパネル、役職の移設）
// - API ルート（投稿/納品/取消の3アクションとブリッジの理由ホワイトリスト）
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
    out.push(line.replace(/^export\s+/, ""));
  }
  return out.join("\n");
}

function loadBundle(files, names) {
  const code = files.map((name) => stripModuleSyntax(transpile(name))).join("\n");
  return new Function(`${code}\nreturn { ${names.join(", ")} };`)();
}

const rq = loadBundle(
  ["worldbox/items.ts", "worldbox/profile.ts", "worldbox/economy.ts", "worldbox/requests.ts"],
  [
    "itemById", "parseProfile", "countItem",
    "emptyRequestsState", "postRequest", "fulfillRequest", "cancelRequest",
    "requestsForGuild", "parseRequestsState", "serializeRequestsState",
    "MAX_OPEN_PER_GUILD", "MAX_OPEN_PER_POSTER",
  ],
);

const POSTER = "discord:111";
const MEMBER = "discord:222";
const GUILD = "guild-1";

function post(state, over = {}, balance = 1000) {
  return rq.postRequest(state, {
    id: "req-00000001",
    guildId: GUILD,
    posterKey: POSTER,
    posterName: "投稿者",
    itemId: "wood",
    count: 3,
    reward: 150,
    now: 1000,
    ...over,
  }, balance);
}

test("投稿: 依頼が載り、報酬は spend（guild_request_escrow）で預かる", () => {
  const result = post(rq.emptyRequestsState());
  assert.equal(result.ok, true);
  assert.deepEqual(result.coin, { kind: "spend", amount: 150, reason: "guild_request_escrow" });
  const list = rq.requestsForGuild(result.state, GUILD);
  assert.equal(list.length, 1);
  assert.equal(list[0].itemId, "wood");
  assert.equal(rq.requestsForGuild(result.state, "other-guild").length, 0);
});

test("投稿の検証: 不正なアイテム・個数・報酬・残高不足を弾く", () => {
  const s = rq.emptyRequestsState();
  assert.equal(post(s, { itemId: "nope" }).error, "unknown_item");
  assert.equal(post(s, { count: 0 }).error, "invalid_count");
  assert.equal(post(s, { count: 100 }).error, "invalid_count");
  assert.equal(post(s, { reward: 0 }).error, "invalid_reward");
  assert.equal(post(s, { reward: 1_000_001 }).error, "invalid_reward");
  assert.equal(post(s, {}, 100).error, "not_enough_coins");
});

test("投稿の上限: 1人5件・ユニオン20件", () => {
  let state = rq.emptyRequestsState();
  for (let i = 0; i < rq.MAX_OPEN_PER_POSTER; i++) {
    const r = post(state, { id: `req-0000000${i}` });
    assert.equal(r.ok, true);
    state = r.state;
  }
  assert.equal(post(state, { id: "req-00000009" }).error, "too_many_poster");
  // 別々の投稿者でユニオン上限まで
  let s2 = rq.emptyRequestsState();
  for (let i = 0; i < rq.MAX_OPEN_PER_GUILD; i++) {
    const r = post(s2, {
      id: `req-x${String(i).padStart(6, "0")}`,
      posterKey: `discord:${1000 + i}`,
    });
    assert.equal(r.ok, true);
    s2 = r.state;
  }
  assert.equal(
    post(s2, { id: "req-x999999", posterKey: "discord:9999" }).error,
    "too_many_guild",
  );
});

test("納品: アイテムが投稿者へ動き、報酬は earn（guild_request_reward）、依頼は消える", () => {
  const posted = post(rq.emptyRequestsState());
  const fulfiller = rq.parseProfile(null);
  fulfiller.items = { wood: 5 };
  const poster = rq.parseProfile(null);
  const result = rq.fulfillRequest(posted.state, "req-00000001", GUILD, MEMBER, fulfiller, poster);
  assert.equal(result.ok, true);
  assert.deepEqual(result.coin, { kind: "earn", amount: 150, reason: "guild_request_reward" });
  assert.equal(rq.countItem(result.fulfillerProfile, "wood"), 2);
  assert.equal(rq.countItem(result.posterProfile, "wood"), 3);
  assert.equal(rq.requestsForGuild(result.state, GUILD).length, 0);
});

test("納品の検証: 自分の依頼・他ユニオン・所持不足・不存在を弾く", () => {
  const posted = post(rq.emptyRequestsState());
  const rich = rq.parseProfile(null);
  rich.items = { wood: 9 };
  const poster = rq.parseProfile(null);
  assert.equal(
    rq.fulfillRequest(posted.state, "req-00000001", GUILD, POSTER, rich, poster).error,
    "self_fulfill",
  );
  assert.equal(
    rq.fulfillRequest(posted.state, "req-00000001", "other", MEMBER, rich, poster).error,
    "wrong_guild",
  );
  const poor = rq.parseProfile(null);
  poor.items = { wood: 1 };
  assert.equal(
    rq.fulfillRequest(posted.state, "req-00000001", GUILD, MEMBER, poor, poster).error,
    "not_enough_items",
  );
  assert.equal(
    rq.fulfillRequest(posted.state, "req-99999999", GUILD, MEMBER, rich, poster).error,
    "not_found",
  );
});

test("取消: 投稿者だけができ、預かり金は earn（guild_request_refund）で戻る", () => {
  const posted = post(rq.emptyRequestsState());
  assert.equal(rq.cancelRequest(posted.state, "req-00000001", MEMBER).error, "not_poster");
  const result = rq.cancelRequest(posted.state, "req-00000001", POSTER);
  assert.equal(result.ok, true);
  assert.deepEqual(result.coin, { kind: "earn", amount: 150, reason: "guild_request_refund" });
  assert.equal(rq.requestsForGuild(result.state, GUILD).length, 0);
  assert.equal(rq.cancelRequest(result.state, "req-00000001", POSTER).error, "not_found");
});

test("保存形式: 直列化→復元で往復し、壊れた要素と旧版は捨てる", () => {
  const posted = post(rq.emptyRequestsState());
  const restored = rq.parseRequestsState(rq.serializeRequestsState(posted.state));
  assert.equal(rq.requestsForGuild(restored, GUILD).length, 1);
  const broken = rq.parseRequestsState(JSON.stringify({
    v: 1,
    requests: {
      a: { id: "req-00000001", guildId: GUILD, posterKey: POSTER, posterName: "x", itemId: "wood", count: 1, reward: 10, createdAt: 1 },
      b: { id: "bad", guildId: GUILD },
      c: { id: "req-00000002", guildId: GUILD, posterKey: POSTER, posterName: "x", itemId: "ghost_item", count: 1, reward: 10, createdAt: 1 },
    },
  }));
  assert.deepEqual(Object.keys(broken.requests), ["req-00000001"]);
  assert.deepEqual(rq.parseRequestsState(JSON.stringify({ v: 99, requests: {} })), { requests: {} });
  assert.deepEqual(rq.parseRequestsState("not json"), { requests: {} });
  assert.deepEqual(rq.parseRequestsState(null), { requests: {} });
});

test("ギルドボードの配線: ロビー配置・チップ・パネル・API・理由ホワイトリスト", () => {
  const lobby = fs.readFileSync(path.join(libDir, "worldbox/lobby.ts"), "utf8");
  assert.match(lobby, /"guild"/);
  assert.match(lobby, /guild_board.*station: "guild"/);
  const textures = fs.readFileSync(path.join(libDir, "worldbox/textures.ts"), "utf8");
  assert.match(textures, /guild_board: "\/img\/worldbox\/lobby\/guild_board\.png"/);
  assert.ok(fs.existsSync(path.join(rootDir, "public/img/worldbox/lobby/guild_board.png")));

  const client = fs.readFileSync(
    path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8",
  );
  assert.match(client, /guild: "ギルドボード"/);
  assert.match(client, /stationUi === "guild"/);
  assert.match(client, /WorldBoxGuildBoardPanel/);
  // 役職の home はギルドボード: ≡ の旧パネルには建国/参加ボタンを残さない
  assert.doesNotMatch(client, /action: "found"|action: "join"|action: "leave"/);

  const panel = fs.readFileSync(
    path.join(rootDir, "app/games/worldbox/WorldBoxGuildBoardPanel.tsx"), "utf8",
  );
  assert.match(panel, /\/api\/worldbox\/requests/);
  assert.match(panel, /依頼/);
  assert.match(panel, /役職/);

  const route = fs.readFileSync(
    path.join(rootDir, "app/api/worldbox/requests/route.ts"), "utf8",
  );
  for (const action of ["post", "fulfill", "cancel"]) {
    assert.match(route, new RegExp(`case "${action}"`));
  }
  // 場所制約: 操作はギルドボード前のみ（場所検証の共通方式）
  assert.match(route, /loadMyLobbyStation/);
  assert.match(route, /not_at_guild_board/);
  const bridge = fs.readFileSync(path.join(libDir, "worldbox/economy-bridge.ts"), "utf8");
  assert.match(bridge, /"guild_request_reward"/);
  assert.match(bridge, /"guild_request_refund"/);
  const botWorker = fs.readFileSync(
    path.join(rootDir, "../core/general/circulation/worldbox_economy.py"), "utf8",
  );
  assert.match(botWorker, /"guild_request_reward"/);
  assert.match(botWorker, /"guild_request_refund"/);
});
