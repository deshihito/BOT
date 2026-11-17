// AGO WORLD BOX ユニオン戦争（バッチ7a）の検証:
// - レイド宣言（別国・1国1戦争・24時間クールダウン・決定的 ID）
// - マーク攻撃/修復（ダメージ・回復・個人クールダウン・破壊で勝利確定）
// - 期限切れ（24時間で引き分け）
// - 他者ブロック破壊ルール（戦争中・防衛側首都の12タイル以内のみ）
// - 繁栄ランキング（繁栄度順・同値は建国順）
// - タイル採掘への配線（warBreakAllowed があるときだけ他者ブロックを掘れる）
// - ルート配線（宣言はギルドボード前・王/大臣、破壊で防衛国を解散）
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

const warUrl = dataUrl(transpile("worldbox/war.ts"));
const W = await import(warUrl);

const NOW = 1_700_000_000_000;
const A = { id: "111111111111111111", name: "あごサーバー" };
const B = { id: "222222222222222222", name: "もちサーバー" };
const C = { id: "333333333333333333", name: "さくらサーバー" };

function declared(now = NOW) {
  const r = W.declareWar(W.emptyWarState(), A, B, now);
  assert.equal(r.ok, true);
  return r;
}

// ---------- レイド宣言 ----------

test("war: 宣言で戦争状態になり、決定的 ID と 24時間の期限が付く", () => {
  const { state, war } = declared();
  assert.equal(war.id, `war-${A.id}-${B.id}-${NOW}`);
  assert.equal(war.status, "active");
  assert.equal(war.markHp, W.WAR_MARK_MAX_HP);
  assert.equal(war.endsAt, NOW + W.WAR_DURATION_MS);
  assert.equal(war.outcome, null);
  assert.ok(state.wars[war.id]);
});

test("war: 自国への宣言はできない", () => {
  const r = W.declareWar(W.emptyWarState(), A, A, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.error, "same_nation");
});

test("war: 1国が同時に関わる戦争は1件まで（攻撃側・防衛側どちらも）", () => {
  const { state } = declared();
  assert.equal(W.declareWar(state, A, C, NOW + 1000).error, "already_at_war");
  assert.equal(W.declareWar(state, C, A, NOW + 1000).error, "already_at_war");
  assert.equal(W.declareWar(state, C, B, NOW + 1000).error, "already_at_war");
});

test("war: 宣言は24時間に1回まで（早期終結してもクールダウンが残る）", () => {
  const { state, war } = declared();
  // マーク破壊で早期終結させる（10回攻撃で 100 → 0）
  let s = state;
  for (let i = 0; i < 10; i++) {
    const r = W.attackMark(s, war.id, `presence-attacker-${i}`, NOW + i * 11_000);
    assert.equal(r.ok, true, `attack ${i}`);
    s = r.state;
    if (i === 9) assert.equal(r.destroyed, true);
  }
  const endedAt = NOW + 10 * 11_000;
  const blocked = W.declareWar(s, A, C, endedAt + 60_000);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "declare_cooldown");
  const ok = W.declareWar(s, A, C, NOW + W.WAR_DECLARE_COOLDOWN_MS + 1);
  assert.equal(ok.ok, true);
});

// ---------- マーク攻撃・修復 ----------

test("war: マーク攻撃は1回 -10、個人クールダウン10秒、破壊で攻撃側の勝利", () => {
  const { state, war } = declared();
  const me = "presence-attacker-1";
  const hit1 = W.attackMark(state, war.id, me, NOW);
  assert.equal(hit1.ok, true);
  assert.equal(hit1.war.markHp, 90);
  assert.equal(hit1.destroyed, false);
  const soon = W.attackMark(hit1.state, war.id, me, NOW + 5_000);
  assert.equal(soon.ok, false);
  assert.equal(soon.error, "too_soon");
  // 他人は自分のクールダウンで攻撃できる
  const other = W.attackMark(hit1.state, war.id, "presence-attacker-2", NOW + 5_000);
  assert.equal(other.ok, true);
  assert.equal(other.war.markHp, 80);
  // 残りを削り切る（10回攻撃で 100 → 0）
  let s = other.state;
  for (let i = 0; i < 8; i++) {
    const r = W.attackMark(s, war.id, `presence-attacker-${i + 3}`, NOW + 11_000 + i * 11_000);
    assert.equal(r.ok, true, `attack ${i + 3}`);
    s = r.state;
    if (i === 7) {
      assert.equal(r.destroyed, true);
      assert.equal(r.war.status, "closed");
      assert.equal(r.war.outcome, "attacker_win");
      assert.equal(r.war.markHp, 0);
      assert.equal(s.history[0].outcome, "attacker_win");
    }
  }
  // 終わった戦争は攻撃できない
  assert.equal(W.attackMark(s, war.id, me, NOW + 200_000).error, "not_at_war");
});

test("war: マーク修復は1回 +10、上限まで、個人クールダウン30秒", () => {
  const { state, war } = declared();
  const hit = W.attackMark(state, war.id, "presence-attacker-1", NOW);
  assert.equal(hit.war.markHp, 90);
  const repaired = W.repairMark(hit.state, war.id, "presence-defender-1", NOW);
  assert.equal(repaired.ok, true);
  assert.equal(repaired.war.markHp, 100);
  assert.equal(W.repairMark(repaired.state, war.id, "presence-defender-1", NOW).error, "mark_full");
  const hit2 = W.attackMark(repaired.state, war.id, "presence-attacker-1", NOW + 11_000);
  const soon = W.repairMark(hit2.state, war.id, "presence-defender-1", NOW + 12_000);
  assert.equal(soon.ok, false);
  assert.equal(soon.error, "too_soon");
  const later = W.repairMark(hit2.state, war.id, "presence-defender-1", NOW + 31_000);
  assert.equal(later.ok, true);
  assert.equal(later.war.markHp, 100);
});

test("war: 期限を過ぎた戦争は引き分けで閉じる", () => {
  const { state } = declared();
  const same = W.expireWars(state, NOW + W.WAR_DURATION_MS);
  assert.equal(same, state, "期限内は同一の状態を返す");
  const expired = W.expireWars(state, NOW + W.WAR_DURATION_MS + 1);
  const war = expired.wars[Object.keys(expired.wars)[0]];
  assert.equal(war.status, "closed");
  assert.equal(war.outcome, "expired");
  assert.equal(expired.history[0].outcome, "expired");
});

// ---------- 他者ブロック破壊ルール ----------

test("war: 他者ブロックは戦争中・防衛側首都の12タイル以内だけ掘れる", () => {
  const { state } = declared();
  const capital = { x: 100, y: 100 };
  assert.equal(W.canBreakOthersBlock(state, A.id, B.id, 100, 100, capital), true);
  assert.equal(W.canBreakOthersBlock(state, A.id, B.id, 112, 100, capital), true);
  assert.equal(W.canBreakOthersBlock(state, A.id, B.id, 113, 100, capital), false);
  assert.equal(W.canBreakOthersBlock(state, A.id, B.id, 100, 100, { x: 0, y: 0 }), false);
  // 逆向き（防衛側が攻撃側のブロックを掘る）は不可
  assert.equal(W.canBreakOthersBlock(state, B.id, A.id, 100, 100, capital), false);
  // 平時（戦争なし）は不可
  assert.equal(W.canBreakOthersBlock(W.emptyWarState(), A.id, B.id, 100, 100, capital), false);
  // 無関係の国同士は不可
  assert.equal(W.canBreakOthersBlock(state, C.id, B.id, 100, 100, capital), false);
});

test("war: 期限切れの戦争では他者ブロックを掘れない（now 付き判定）", () => {
  const { state } = declared();
  const capital = { x: 100, y: 100 };
  const war = Object.values(state.wars)[0];
  assert.equal(war.endsAt, NOW + W.WAR_DURATION_MS);
  // 期限内は掘れる（境界は expireWars と同じ: endsAt ちょうどは有効）
  assert.equal(W.warLiveAt(war, NOW + W.WAR_DURATION_MS), true);
  assert.equal(W.canBreakOthersBlock(state, A.id, B.id, 100, 100, capital, NOW + 1000), true);
  assert.equal(W.canBreakOthersBlock(state, A.id, B.id, 100, 100, capital, NOW + W.WAR_DURATION_MS), true);
  // 期限を過ぎたら、status が "active" のまま（expireWars 未精算）でも掘れない
  assert.equal(W.warLiveAt(war, NOW + W.WAR_DURATION_MS + 1), false);
  assert.equal(W.canBreakOthersBlock(state, A.id, B.id, 100, 100, capital, NOW + W.WAR_DURATION_MS + 1), false);
});

// ---------- 繁栄ランキング ----------

test("war: 繁栄ランキングは繁栄度順、同値は建国順、順位は1始まり", () => {
  const ranking = W.prosperityRanking([
    { id: "1", name: "a", color: "#e5484d", members: 2, prosperity: 10, createdAt: 300 },
    { id: "2", name: "b", color: "#f76b15", members: 6, prosperity: 30, createdAt: 200 },
    { id: "3", name: "c", color: "#ffb224", members: 2, prosperity: 10, createdAt: 100 },
    { id: "4", name: "d", color: "#46a758", members: 0, prosperity: 0, createdAt: 400 },
  ]);
  assert.deepEqual(ranking.map((r) => r.id), ["2", "3", "1", "4"]);
  assert.deepEqual(ranking.map((r) => r.rank), [1, 2, 3, 4]);
});

// ---------- 保存形式 ----------

test("war: 保存→復元の往復で戦争と履歴が残り、壊れた値は落とす", () => {
  const { state } = declared();
  const hit = W.attackMark(state, Object.keys(state.wars)[0], "presence-attacker-1", NOW);
  const roundtripped = W.parseWarState(JSON.stringify(hit.state));
  assert.equal(Object.keys(roundtripped.wars).length, 1);
  assert.equal(roundtripped.wars[Object.keys(roundtripped.wars)[0]].markHp, 90);
  assert.equal(roundtripped.lastDeclaredAt[A.id], NOW);
  assert.deepEqual(W.parseWarState("{壊れたjson"), W.emptyWarState());
  assert.deepEqual(W.parseWarState({ v: 99, wars: {} }), W.emptyWarState());
  const partial = W.parseWarState({
    v: 1,
    wars: { bad: { id: "bad" }, ok: hit.state.wars[Object.keys(hit.state.wars)[0]] },
    history: [{ id: "x" }, { id: "h1", attackerId: A.id, defenderId: B.id, attackerName: "a", defenderName: "b", outcome: "expired", endedAt: NOW }],
    lastDeclaredAt: { [A.id]: NOW, bad: "x" },
  });
  assert.equal(Object.keys(partial.wars).length, 1);
  assert.equal(partial.history.length, 1);
});

// ---------- タイル採掘への配線 ----------

const tilesUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/items.ts", "worldbox/profile.ts", "worldbox/presence.ts", "worldbox/seasons.ts", "worldbox/tiles.ts"],
  [
    "worldTileSource", "mapTileAt", "T_GRASS",
    "parseProfile", "addItem", "countItem",
    "applyPlaceBlock", "applyMineBlock", "tileKey", "presenceIdFor",
  ],
);
const T = await import(tilesUrl);

const map = T.worldTileSource();
function findTile(id) {
  for (let y = 0; y < 1024; y++) {
    for (let x = 0; x < 1024; x++) {
      if (T.mapTileAt(map, x, y) === id) return { x, y };
    }
  }
  throw new Error(`tile ${id} not found`);
}
const grassAt = findTile(T.T_GRASS);
const ME_KEY = "discord:611111111111111111";
const OTHER_KEY = "discord:622222222222222222";
const NO_CTX = { onCapital: false };
const withItems = (items) => T.parseProfile({ items });

test("war: 採掘は warBreakAllowed があるときだけ他者ブロックを掘れる", () => {
  const placed = T.applyPlaceBlock(null, withItems({ dirt_block: 1 }), map, OTHER_KEY, grassAt.x, grassAt.y, "dirt_block", NOW, NO_CTX);
  assert.equal(placed.ok, true);
  const denied = T.applyMineBlock(placed.override, withItems({}), map, ME_KEY, grassAt.x, grassAt.y, NOW);
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "not_owner");
  const allowed = T.applyMineBlock(
    placed.override, withItems({}), map, ME_KEY, grassAt.x, grassAt.y, NOW, { warBreakAllowed: true },
  );
  assert.equal(allowed.ok, true);
  assert.equal(T.countItem(allowed.profile, "dirt_block"), 1, "掘ったブロックは掘った者の所持品に入る");
  assert.equal(allowed.override, null);
});

// ---------- ルート配線 ----------

test("war: ルート配線（宣言はギルドボード前・王/大臣、破壊で防衛国を解散）", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/war/route.ts"), "utf8");
  for (const needle of [
    "loadMyLobbyStation", "not_at_guild_board",
    "forbidden_role", "disbandNation",
    "attack_mark", "repair_mark", "declare",
    "expireWars", "prosperityRanking",
  ]) {
    assert.ok(route.includes(needle), `war ルートに ${needle} が無い`);
  }
  assert.ok(!route.includes("enqueueEconomyOp"), "戦争にコインの流れを作らない");
  const tilesRoute = fs.readFileSync(path.join(rootDir, "app/api/worldbox/tiles/route.ts"), "utf8");
  for (const needle of ["canBreakOthersBlock", "warBreakAllowed", "loadWarState"]) {
    assert.ok(tilesRoute.includes(needle), `tiles ルートに ${needle} が無い`);
  }
});

test("war: ルート配線（state は全体ロックで直列化、解散は冪等回復、タイルは期限を見る）", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/war/route.ts"), "utf8");
  for (const needle of ["withWarLock", "settleDisbands", "loadWarStateSettled", "handlePost"]) {
    assert.ok(route.includes(needle), `war ルートに ${needle} が無い`);
  }
  const warOnline = fs.readFileSync(path.join(libDir, "worldbox/war-online.ts"), "utf8");
  assert.ok(warOnline.includes("withWarLock"), "war-online に withWarLock が無い");
  assert.ok(warOnline.includes("withUserLock"), "war-online が全体ロックを使っていない");
  const tilesRoute = fs.readFileSync(path.join(rootDir, "app/api/worldbox/tiles/route.ts"), "utf8");
  assert.ok(
    tilesRoute.includes("defender.capital, Date.now()"),
    "tiles ルートの略奪判定が現在時刻を渡していない",
  );
});
