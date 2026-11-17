// AGO WORLD BOX: relay の bot_kv watch（Phase 1）のテスト。
// - watch-core: 差分検出 / パーティ通知先の解決 / チャットのスコープ解決
// - presenceIdFor が lib/worldbox/presence.ts の実装と一致すること
// - botkv: /v1/query へのリクエスト形式が lib/bot-api.ts と同じこと
// - 配線: ラッパーの watch 起動 / クライアントの push 適用と間引き
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const rootDir = path.join(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const watch = require(path.join(rootDir, "realtime", "watch-core.js"));
const botkv = require(path.join(rootDir, "realtime", "botkv.js"));

function transpile(name, base = path.join(rootDir, "lib")) {
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
const presenceTs = new Function(
  `${stripModuleSyntax(transpile("worldbox/presence.ts"))}\nreturn { presenceIdFor };`,
)();

test("watch: presenceIdFor は presence.ts の実装と一致する", () => {
  for (const key of ["discord:123456789", "discord:1", "guest:xyz", "discord:1320705325686587408"]) {
    assert.equal(watch.presenceIdFor(key), presenceTs.presenceIdFor(key), key);
  }
});

test("watch: diffKv は追加・変更・削除だけを返す（初回はベースライン）", () => {
  const prev = new Map([["a", "1"], ["b", "2"], ["c", "3"]]);
  const next = new Map([["a", "1"], ["b", "22"], ["d", "4"]]);
  assert.deepEqual(watch.diffKv(null, next), []);
  const changes = watch.diffKv(prev, next);
  assert.deepEqual(
    changes.map((c) => [c.key, c.value]),
    [["b", "22"], ["d", "4"], ["c", null]],
  );
  // オブジェクト値も JSON 化して比較する
  const p2 = new Map([["k", { x: 1 }]]);
  assert.deepEqual(watch.diffKv(p2, new Map([["k", { x: 1 }]])), []);
  assert.equal(watch.diffKv(p2, new Map([["k", { x: 2 }]])).length, 1);
});

test("watch: WATCH_PLAN は対象系統の名前空間と間隔を持つ", () => {
  const byKind = new Map(watch.WATCH_PLAN.map((p) => [p.kind, p]));
  assert.equal(byKind.get("chat").namespace, "worldbox_chat");
  assert.equal(byKind.get("unionChat").namespace, "worldbox_union_board");
  assert.equal(byKind.get("party").namespace, "worldbox_party");
  assert.equal(byKind.get("requests").namespace, "worldbox_requests");
  assert.equal(byKind.get("tiles").namespace, "worldbox_tiles");
  assert.equal(byKind.get("mobs").namespace, "worldbox_mobs");
  assert.equal(byKind.get("board").namespace, "worldbox_board");
  assert.equal(byKind.get("nations").namespace, "worldbox_nations");
  assert.equal(byKind.get("economy").namespace, "worldbox_economy");
  assert.equal(byKind.get("economy").intervalMs, 2_000);
  for (const p of watch.WATCH_PLAN) assert.ok(p.intervalMs >= 2_000 && p.intervalMs <= 5_000);
});

test("watch: economyTargetPids は確定遷移だけを本人と関係者へ絞る", () => {
  const pid = watch.presenceIdFor;
  const op = (extra = {}) => JSON.stringify({ id: "op1", kind: "earn", userKey: "discord:111", discordId: "111", amount: 500, status: "pending", ...extra });
  // pending → done: 本人のみ（userKey と discordId は同一人）
  assert.deepEqual([...watch.economyTargetPids(op(), op({ status: "done" }))], [pid("discord:111")]);
  // pending → failed も通知する
  assert.deepEqual([...watch.economyTargetPids(op(), op({ status: "failed" }))], [pid("discord:111")]);
  // 遷移なし（pending のまま・done のまま）は通知しない
  assert.equal(watch.economyTargetPids(op(), op()).size, 0);
  assert.equal(watch.economyTargetPids(op({ status: "done" }), op({ status: "done" })).size, 0);
  // 送金: 受け手にも届く
  const transfer = (status) => JSON.stringify({ id: "op2", kind: "transfer", userKey: "discord:111", discordId: "222", toDiscordId: "222", amount: 10, status });
  assert.deepEqual(
    [...watch.economyTargetPids(transfer("pending"), transfer("done"))].sort(),
    [pid("discord:111"), pid("discord:222")].sort(),
  );
  // steal: 奪い元にも届く
  const steal = (status) => JSON.stringify({ id: "op3", kind: "steal", userKey: "discord:111", discordId: "111", fromDiscordId: "333", amount: 10, status });
  assert.deepEqual(
    [...watch.economyTargetPids(steal("pending"), steal("done"))].sort(),
    [pid("discord:111"), pid("discord:333")].sort(),
  );
  // 壊れた値・削除では通知しない
  assert.equal(watch.economyTargetPids(null, null).size, 0);
  assert.equal(watch.economyTargetPids(op(), "{oops").size, 0);
});

test("watch: partyTargetPids は本体と索引の両方から関係者を引く", () => {
  const party = JSON.stringify({
    id: "p1", leaderKey: "discord:111",
    members: [{ ownerKey: "discord:111" }, { ownerKey: "discord:222" }],
    invites: [{ toKey: "discord:333" }],
  });
  const pids = watch.partyTargetPids("p1", party);
  assert.deepEqual(
    [...pids].sort(),
    [watch.presenceIdFor("discord:111"), watch.presenceIdFor("discord:222"), watch.presenceIdFor("discord:333")].sort(),
  );
  // 索引キーは本人のみ
  assert.deepEqual([...watch.partyTargetPids("member:discord:999", "p1")], [watch.presenceIdFor("discord:999")]);
  assert.deepEqual([...watch.partyTargetPids("invite:discord:888", "p1")], [watch.presenceIdFor("discord:888")]);
  // 壊れた値・削除では本体からは引けない（呼び出し側が prev でも引く）
  assert.equal(watch.partyTargetPids("p1", null).size, 0);
  assert.equal(watch.partyTargetPids("p1", "{oops").size, 0);
});

test("watch: チャットのスコープ解決", () => {
  assert.deepEqual(watch.chatKeyScope("proximity:world"), { channel: "proximity", space: "world" });
  assert.deepEqual(watch.chatKeyScope("global:cave:1,2:0"), { channel: "global", space: "cave:1,2:0" });
  assert.equal(watch.chatKeyScope("union:123"), null);
  assert.equal(watch.unionBoardGuildId("union:123456"), "123456");
  assert.equal(watch.unionBoardGuildId("proximity:world"), null);
});

test("botkv: kvList/kvSet は bot-api.ts と同じ /v1/query 形式で叩く", async () => {
  const cfg = botkv.botKvConfig({ BOT_API_BASE_URL: "http://bot.local/", BOT_API_KEY: "secret" });
  assert.deepEqual(cfg, { base: "http://bot.local", key: "secret" });
  assert.equal(botkv.botKvConfig({}), null);
  const seen = [];
  const stub = async (url, init) => {
    seen.push({ url, init });
    return {
      ok: true,
      json: async () => ({ data: [{ key: "a", value: "1" }, { key: "b", value: null }] }),
    };
  };
  const map = await botkv.kvList(cfg, "worldbox_tiles", stub);
  assert.deepEqual([...map.entries()], [["a", "1"], ["b", null]]);
  const listBody = JSON.parse(seen[0].init.body);
  assert.equal(seen[0].url, "http://bot.local/v1/query");
  assert.equal(seen[0].init.headers.Authorization, "Bearer secret");
  assert.equal(listBody.table, "bot_kv");
  assert.equal(listBody.action, "select");
  assert.deepEqual(listBody.filters, [{ column: "namespace", op: "eq", value: "worldbox_tiles" }]);

  await botkv.kvSet(cfg, "worldbox_presence", "discord:1", "{\"x\":1}", stub);
  const setBody = JSON.parse(seen[1].init.body);
  assert.equal(setBody.action, "upsert");
  assert.equal(setBody.on_conflict, "namespace,key");
  assert.equal(setBody.values.namespace, "worldbox_presence");
  assert.equal(setBody.values.key, "discord:1");
  assert.equal(setBody.values.value, "{\"x\":1}");
});

test("watch 配線: ラッパーが watch を起動し、クライアントが push を適用する", () => {
  const server = fs.readFileSync(path.join(rootDir, "realtime-server.js"), "utf8");
  assert.ok(server.includes('require(path.join(__dirname, "realtime", "botkv.js"))'), "botkv を読んでいない");
  assert.ok(server.includes('require(path.join(__dirname, "realtime", "watch-core.js"))'), "watch-core を読んでいない");
  assert.ok(server.includes("WATCH_PLAN"), "watch 計画を使っていない");
  assert.ok(server.includes("routeWatchChanges"), "差分配信が無い");
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes('msg.kind === "tiles"'), "タイル push 適用が無い");
  assert.ok(client.includes('msg.kind === "mobs"'), "モブ push 適用が無い");
  assert.ok(client.includes('msg.kind === "board"'), "掲示板 push 適用が無い");
  assert.ok(client.includes('msg.kind === "nations"'), "国家 poke が無い");
  assert.ok(client.includes('msg.kind === "party"'), "パーティ poke が無い");
  assert.ok(client.includes('msg.kind === "chat"'), "チャット poke が無い");
  assert.ok(client.includes('msg.kind === "economy"'), "経済 poke が無い");
  assert.ok(client.includes("notifyEconomyApplied()"), "パネルへの合図が無い");
  assert.ok(server.includes("economyTargetPids"), "経済の宛先解決が無い");
  for (const panel of ["WorldBoxCasinoPanel.tsx", "WorldBoxArenaPanel.tsx", "WorldBoxEconomyPanel.tsx"]) {
    const src = fs.readFileSync(path.join(rootDir, "app/games/worldbox", panel), "utf8");
    assert.ok(src.includes("onEconomyApplied("), `${panel} が経済 push を購読していない`);
  }
  assert.ok(client.includes("parseTileOverride(c.value)"), "タイル parse が無い");
  assert.ok(client.includes("parseMobState(c.value)"), "モブ parse が無い");
  assert.ok(client.includes("parseBoardPosts(msg.value ?? null)"), "掲示板 parse が無い");
  // 再接続時の再同期
  assert.ok(client.includes("if (reconnected)"), "再接続時の再同期が無い");
  // WS 健全時の間引き（チャット/パーティ/掲示板/15秒束）
  assert.ok(client.includes("if (!force && wsHealthyNow()) return;"), "チャットの間引きが無い");
  assert.ok(client.includes("if (!wsHealthyNow()) void refreshPartyRef.current()"), "パーティの間引きが無い");
  assert.ok(client.includes("if (!wsHealthyNow()) void refreshBoard()"), "掲示板の間引きが無い");
});
