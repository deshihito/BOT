// WORLD BOX Phase 2 拡張（P2P 直接取引・ボス共闘/討伐速報・自宅ワープ）のテスト。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
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

function readWeb(relPath) {
  return fs.readFileSync(path.join(rootDir, relPath), "utf8");
}

async function loadBundle(files, exportNames) {
  const code =
    files.map((name) => stripModuleSyntax(transpile(name))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  return import(dataUrl(code));
}

const T = await loadBundle(
  ["worldbox/items.ts", "worldbox/profile.ts", "worldbox/trade.ts"],
  [
    "makeTradeId", "normalizeTradeOffer", "createTradeSession", "isTradeExpired",
    "setTradeOffer", "setTradeReady", "confirmTrade", "netCoinTransfer", "swapTradeItems",
    "parseTradeSession", "serializeTradeSession", "toTradeClientView",
    "TRADE_TTL_MS", "TRADE_MAX_COINS", "TRADE_MAX_DISTINCT_ITEMS",
    "parseProfile", "serializeProfile", "addItem", "countItem",
  ],
);

const C = await loadBundle(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/maplogic.ts", "worldbox/items.ts", "worldbox/mobs.ts", "worldbox/combat.ts"],
  [
    "BOSS_ASSIST_MIN_SIZE", "BOSS_ASSIST_MAX_RECIPIENTS",
    "mobById", "parseMobState", "applyMobAttack", "rollBossAssistLoot", "mobDistance",
  ],
);

const W = await loadBundle(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/move.ts", "worldbox/warp.ts"],
  [
    "HOME_WARP_COMBAT_COOLDOWN_MS", "HOME_WARP_COOLDOWN_MS", "homeDestination", "worldTileSource",
  ],
);

const watchCore = require("../realtime/watch-core.js");

test("trade: 招待・詐欺防止 ready リセット・純額送金・アイテム交換の原子性", () => {
  const now = 1_700_000_000_000;
  const tid = T.makeTradeId(now, "abcd1234");
  assert.match(tid, /^[A-Za-z0-9-]{8,48}$/);

  const session = T.createTradeSession(
    tid,
    "world",
    { ownerKey: "discord:11111", id: "aaaa1111", name: "Alice" },
    { ownerKey: "discord:22222", id: "bbbb2222", name: "Bob" },
    now,
  );
  assert.equal(session.status, "pending");
  assert.equal(T.isTradeExpired(session, now + T.TRADE_TTL_MS), false);
  assert.equal(T.isTradeExpired(session, now + T.TRADE_TTL_MS + 1), true);

  // open 遷移後に提示を変更すると、双方の ready / confirmed が自動で解除される
  let open = { ...session, status: "open" };
  open = T.setTradeOffer(open, "discord:11111", { items: { wood: 5 }, coins: 200 }, now + 100);
  assert.equal(open.a.offer.coins, 200);
  open = T.setTradeReady(open, "discord:11111", true, now + 200);
  open = T.setTradeReady(open, "discord:22222", true, now + 300);
  assert.equal(open.a.ready, true);
  assert.equal(open.b.ready, true);

  // 片方確認後に相手が提示を変えると ready/confirmed が両方消える（詐欺防止）
  const afterConfirmA = T.confirmTrade(open, "discord:11111", now + 400);
  assert.equal(afterConfirmA.a.confirmed, true);
  const edited = T.setTradeOffer(afterConfirmA, "discord:22222", { items: { stone: 3 }, coins: 50 }, now + 500);
  assert.equal(edited.a.ready, false);
  assert.equal(edited.b.ready, false);
  assert.equal(edited.a.confirmed, false);
  assert.equal(edited.b.confirmed, false);

  // 両者 ready → confirm → netCoinTransfer 計算
  let readyBoth = T.setTradeReady(edited, "discord:11111", true, now + 600);
  readyBoth = T.setTradeReady(readyBoth, "discord:22222", true, now + 700);
  let conf = T.confirmTrade(readyBoth, "discord:11111", now + 800);
  conf = T.confirmTrade(conf, "discord:22222", now + 900);
  assert.equal(conf.a.confirmed, true);
  assert.equal(conf.b.confirmed, true);
  const net = T.netCoinTransfer(conf);
  assert.equal(net?.from.ownerKey, "discord:11111");
  assert.equal(net?.to.ownerKey, "discord:22222");
  assert.equal(net?.amount, 150);

  // シリアライズ・パース往復＋クライアントビュー秘匿確認
  const round = T.parseTradeSession(T.serializeTradeSession(conf));
  assert.equal(round?.id, tid);
  const viewB = T.toTradeClientView(round, "discord:22222");
  assert.equal(viewB?.selfSide, "b");
  assert.equal("ownerKey" in viewB.partner, false);

  // normalizeTradeOffer の上限・不正検証
  assert.equal(T.normalizeTradeOffer({ items: { nonexistent: 1 }, coins: 0 }), null);
  assert.equal(T.normalizeTradeOffer({ items: {}, coins: T.TRADE_MAX_COINS + 1 }), null);

  // swapTradeItems: 在庫不足なら失敗し変更しない／十分なら交換
  const pA = T.addItem(T.parseProfile(null), "wood", 10);
  const pB = T.addItem(T.parseProfile(null), "stone", 2);
  const failSwap = T.swapTradeItems(pA, pB, { wood: 5 }, { stone: 3 });
  assert.equal(failSwap.ok, false);
  assert.equal(failSwap.side, "b");

  const okSwap = T.swapTradeItems(pA, pB, { wood: 5 }, { stone: 2 });
  assert.equal(okSwap.ok, true);
  assert.equal(T.countItem(okSwap.aProfile, "wood"), 5);
  assert.equal(T.countItem(okSwap.aProfile, "stone"), 2);
  assert.equal(T.countItem(okSwap.bProfile, "wood"), 5);
  assert.equal(T.countItem(okSwap.bProfile, "stone"), 0);
});

test("combat: フィールドボス与ダメ追跡・共闘報酬・mobDistance・死亡時 dmg 消去", () => {
  assert.equal(C.BOSS_ASSIST_MIN_SIZE, 7);
  const dragon = C.mobById("world_dragon");
  assert.ok(dragon && dragon.size >= C.BOSS_ASSIST_MIN_SIZE);
  const slime = C.mobById("slime");
  assert.ok(slime && slime.size < C.BOSS_ASSIST_MIN_SIZE);

  // mobDistance が x,y 独立して正しく動くこと
  assert.equal(C.mobDistance(10, 25, { x: 10, y: 20, size: 1 }), 5);

  const now = 1_700_000_000_000;
  // 通常モブには dmg を付けない
  const hitSlime = C.applyMobAttack(slime, null, 4, now, () => 0.5, "slime@0,0", "discord:1");
  assert.equal(hitSlime.state.dmg, undefined);

  // ボスへ複数人で攻撃 → dmg 蓄積
  let bossHit = C.applyMobAttack(dragon, null, 300, now, () => 0.5, "world_dragon@0,0", "discord:u1");
  assert.equal(bossHit.dead, false);
  assert.equal(bossHit.state.dmg["discord:u1"], 300);

  bossHit = C.applyMobAttack(dragon, bossHit.state, 500, now + 1000, () => 0.5, "world_dragon@0,0", "discord:u2");
  assert.equal(bossHit.dead, false);
  assert.equal(bossHit.state.dmg["discord:u1"], 300);
  assert.equal(bossHit.state.dmg["discord:u2"], 500);

  // u3 がトドメ → 貢献者は dmg 順で u2, u1 のみ（トドメの u3 は除く）、保存状態から dmg は消える
  const killBoss = C.applyMobAttack(dragon, bossHit.state, 300, now + 2000, () => 0.2, "world_dragon@0,0", "discord:u3");
  assert.equal(killBoss.dead, true);
  assert.deepEqual(killBoss.assisters, ["discord:u2", "discord:u1"]);
  assert.equal(killBoss.state.dmg, undefined);
  assert.ok(killBoss.state.deadUntil > now);

  // parseMobState: deadUntil を持つレコードでは dmg を引き継がない
  const parsedDead = C.parseMobState({ hp: 0, deadUntil: now + 60000, dmg: { "discord:u1": 100 } });
  assert.equal(parsedDead?.dmg, undefined);
  const parsedAlive = C.parseMobState({ hp: 500, dmg: { "discord:u1": 100, "discord:u2": 200 } });
  assert.deepEqual(parsedAlive?.dmg, { "discord:u1": 100, "discord:u2": 200 });

  // rollBossAssistLoot: ハズレ続きでも最低1個は保証される
  const minLoot = C.rollBossAssistLoot(dragon, () => 0.99);
  assert.equal(Object.values(minLoot).reduce((a, b) => a + b, 0) >= 1, true);
});

test("warp & profile: 自宅ワープ地点と homeWarpAt 後方互換", () => {
  assert.equal(W.HOME_WARP_COMBAT_COOLDOWN_MS, 15_000);
  assert.equal(W.HOME_WARP_COOLDOWN_MS, 60_000);
  const dest = W.homeDestination(W.worldTileSource(), { x: 10.5, y: 12.5 });
  assert.ok(Number.isFinite(dest.x) && Number.isFinite(dest.y));

  // fresh profile では homeWarpAt を JSON に書き出さない（後方互換）
  const freshJson = JSON.parse(T.serializeProfile(T.parseProfile(null)));
  assert.equal("homeWarpAt" in freshJson, false);

  const warped = T.parseProfile({ homeWarpAt: 1_700_000_000_123 });
  assert.equal(warped.homeWarpAt, 1_700_000_000_123);
  const round = T.parseProfile(T.serializeProfile(warped));
  assert.equal(round.homeWarpAt, 1_700_000_000_123);
});

test("watch-core: worldbox_trade watch と当事者2人への pid 解決", () => {
  const plan = watchCore.WATCH_PLAN.find((p) => p.kind === "trade");
  assert.ok(plan && plan.namespace === "worldbox_trade" && plan.intervalMs === 2_000);

  const pidsActive = watchCore.tradeTargetPids("active:discord:12345", "tr-abc-123");
  assert.deepEqual([...pidsActive], [watchCore.presenceIdFor("discord:12345")]);

  const pidsSession = watchCore.tradeTargetPids(
    "tr-abc-123",
    JSON.stringify({ a: { ownerKey: "discord:111" }, b: { ownerKey: "discord:222" } }),
  );
  assert.equal(pidsSession.has(watchCore.presenceIdFor("discord:111")), true);
  assert.equal(pidsSession.has(watchCore.presenceIdFor("discord:222")), true);
  assert.equal(pidsSession.size, 2);
});

test("Phase 2 配線確認: API ルート・クライアント・バックアップ・パネル規約", () => {
  const tradeRoute = readWeb("app/api/worldbox/trade/route.ts");
  assert.ok(tradeRoute.includes("withSortedUserLocks"), "trade API に辞書順ロックがある");
  assert.ok(tradeRoute.includes("swapTradeItems"), "trade API にアイテム原子的交換がある");
  assert.ok(tradeRoute.includes("submitEconomyOp"), "trade API に AGO コイン送金がある");

  const mobsRoute = readWeb("app/api/worldbox/mobs/route.ts");
  assert.ok(mobsRoute.includes("rollBossAssistLoot"), "mobs API にボス共闘報酬がある");
  assert.ok(mobsRoute.includes("enqueueUnionDiscordEvent"), "mobs API に討伐速報がある");

  const warpRoute = readWeb("app/api/worldbox/warp/route.ts");
  assert.ok(warpRoute.includes('"home"'), "warp API に自宅ワープがある");
  assert.ok(warpRoute.includes("combat_cooldown"), "warp API に戦闘中制限がある");
  assert.ok(warpRoute.includes("warp_cooldown"), "warp API にクールダウン制限がある");

  const realtimeServer = readWeb("realtime-server.js");
  assert.ok(realtimeServer.includes('kind === "trade"'), "realtime-server が trade push を配信する");

  const client = readWeb("app/games/worldbox/WorldBoxClient.tsx");
  assert.ok(client.includes("WorldBoxTradePanel"), "クライアントが取引パネルを持つ");
  assert.ok(client.includes("startTradeWith"), "クライアントがプレイヤーカード取引導線を持つ");
  assert.ok(client.includes("teleportToHome"), "クライアントがマップ自宅ワープを持つ");

  const tradePanel = readWeb("app/games/worldbox/WorldBoxTradePanel.tsx");
  assert.ok(tradePanel.includes('className="wb-panel"'), "取引パネルが wb-panel を持つ");
  assert.ok(tradePanel.includes("ItemSlotGrid"), "取引パネルが ItemSlotGrid を使う");

  const backupPy = fs.readFileSync(path.join(rootDir, "..", "tools", "worldbox_backup.py"), "utf8");
  assert.ok(backupPy.includes('"worldbox_trade"'), "バックアップ対象に worldbox_trade がある");
});
