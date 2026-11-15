// WORLD BOX バッチ7a: ユニオン戦争・日次ローテーション・戦争採掘の純粋ロジックテスト。
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

async function loadBundle(files, exportNames) {
  const code =
    files.map((name) => stripModuleSyntax(transpile(name))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  return import(dataUrl(code));
}

const W = await loadBundle(
  ["worldbox/war.ts"],
  [
    "emptyWarState", "parseWarState", "pruneWars", "activeWarBetween", "declareError",
    "declareWar", "isRepairing", "markHpNow", "applyMarkAttack", "warMineDamage",
    "WAR_DURATION_MS", "WAR_COOLDOWN_MS", "MARK_HP_MAX", "MARK_ATTACK_DAMAGE", "RAID_REPAIR_MS",
  ],
);

const S = await loadBundle(
  ["worldbox/items.ts", "worldbox/shops.ts"],
  ["shopDayKeyOf", "dailyPriceFor", "dailyStockForGenre", "checkDailyStock", "itemsForGenre", "itemById"],
);

test("war: declare rules (self / duplicate / cooldown)", () => {
  let st = W.emptyWarState();
  assert.equal(W.declareError(st, "g1", "g1", 1000), "self_war");
  assert.equal(W.declareError(st, "g1", "g2", 1000), null);
  st = W.declareWar(st, "g1", "g2", 1000);
  assert.equal(W.declareError(st, "g1", "g2", 2000), "already_at_war");
  assert.equal(W.declareError(st, "g2", "g1", 2000), "already_at_war");
  assert.ok(W.activeWarBetween(st, "g2", "g1", 2000));
  // 期限切れ後は prune で消え、クールダウンが効く
  const after = 1000 + W.WAR_DURATION_MS + 1;
  st = W.pruneWars(st, after);
  assert.equal(st.wars.length, 0);
  assert.equal(W.declareError(st, "g1", "g3", after), "cooldown");
  assert.equal(W.declareError(st, "g1", "g3", after + W.WAR_COOLDOWN_MS), null);
});

test("war: mark hp regen and raid flow", () => {
  let st = W.declareWar(W.emptyWarState(), "g1", "g2", 0);
  // 1時間で +10 回復する前提で、削ってから回復を見る
  let r = W.applyMarkAttack(st, "g1", "g2", 0);
  assert.equal(r.hp, W.MARK_HP_MAX - W.MARK_ATTACK_DAMAGE);
  st = r.state;
  assert.equal(W.markHpNow(st, "g2", 3_600_000), W.MARK_HP_MAX);
  // 削り切るとレイド成立・戦争終了・修復期間
  for (let i = 0; i < 10; i++) {
    r = W.applyMarkAttack(st, "g1", "g2", 1000 + i);
    st = r.state;
  }
  assert.equal(r.destroyed, true);
  assert.equal(st.raids.length, 1);
  assert.equal(W.activeWarBetween(st, "g1", "g2", 2000), null);
  assert.equal(W.isRepairing(st, "g2", 2000), true);
  assert.equal(W.markHpNow(st, "g2", 2000), 0);
  assert.equal(W.isRepairing(st, "g2", 1009 + W.RAID_REPAIR_MS + 1), false);
  assert.equal(W.declareError(st, "g3", "g2", 2000), "repairing");
});

test("war: parse roundtrip and junk rejection", () => {
  let st = W.declareWar(W.emptyWarState(), "g1", "g2", 500);
  st = W.applyMarkAttack(st, "g1", "g2", 600).state;
  const back = W.parseWarState(JSON.parse(JSON.stringify(st)));
  assert.deepEqual(back, st);
  assert.deepEqual(W.parseWarState("junk"), W.emptyWarState());
  assert.deepEqual(W.parseWarState(null), W.emptyWarState());
});

test("war: mine damage scales with pickaxe tier", () => {
  assert.equal(W.warMineDamage(0), 20);
  assert.equal(W.warMineDamage(4), 80);
  assert.equal(W.warMineDamage(9), 80);
});

test("shops: daily price is deterministic and within ±10%", () => {
  const item = S.itemById("wooden_axe");
  const day = "2026-11-16";
  const p1 = S.dailyPriceFor(item, day);
  assert.equal(p1, S.dailyPriceFor(item, day));
  assert.ok(p1 >= Math.floor(item.price * 0.9) - 1 && p1 <= Math.ceil(item.price * 1.1) + 1);
  // 5日分で少なくとも2種類の価格が出る（揺れが存在する）
  const prices = new Set(
    ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"].map((d) => S.dailyPriceFor(item, d)),
  );
  assert.ok(prices.size >= 2);
});

test("shops: daily stock rotates but stays within the genre list", () => {
  const day = "2026-11-16";
  const all = S.itemsForGenre("tools");
  const stock = S.dailyStockForGenre("tools", day);
  assert.deepEqual(S.dailyStockForGenre("tools", day), stock);
  assert.ok(stock.length <= all.length);
  for (const item of stock) assert.ok(all.some((a) => a.id === item.id));
  if (all.length > 8) assert.ok(stock.length < all.length);
  assert.equal(S.checkDailyStock("tools", stock[0].id, day), null);
  const missing = all.find((a) => !stock.some((s) => s.id === a.id));
  if (missing) assert.equal(S.checkDailyStock("tools", missing.id, day), "not_sold");
  assert.equal(S.checkDailyStock(null, "anything", day), null);
});

const T = await loadBundle(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/items.ts", "worldbox/profile.ts", "worldbox/presence.ts", "worldbox/tiles.ts"],
  ["applyMineBlock", "parseProfile", "presenceIdFor", "worldTileSource"],
);

test("tiles: war mining chips durability then breaks with loot", () => {
  const owner = "discord:111";
  const attacker = "discord:222";
  const map = T.worldTileSource();
  const prof = T.parseProfile(null);
  // stone_block の耐久は 40。ダメージ 20 では残り、2回で壊れる
  const current = {
    ownerId: T.presenceIdFor(owner),
    block: { itemId: "stone_block", ownerId: T.presenceIdFor(owner) },
  };
  const r1 = T.applyMineBlock(current, prof, map, attacker, 5, 5, 1000, 0);
  assert.equal(r1.ok, false);
  assert.equal(r1.error, "not_owner");
  const r2 = T.applyMineBlock(current, prof, map, attacker, 5, 5, 1000, 20);
  assert.equal(r2.ok, true);
  assert.equal(r2.warDmg.hpLeft, 20);
  assert.deepEqual(r2.gained, {});
  const r3 = T.applyMineBlock(r2.override, prof, map, attacker, 5, 5, 1000, 20);
  assert.equal(r3.ok, true);
  assert.deepEqual(r3.gained, { stone_block: 1 });
  assert.equal(r3.override, null);
});
