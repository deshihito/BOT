// AGO WORLD BOX プレイヤーバイタル（バッチ1）のテスト。
// - profile の HP/状態異常/リスポーン点の往復と旧形式の互換
// - stepVitals: 空腹の減少・飢え・毒 tick・精算キャップ
// - モブ接触ダメージ: クールダウン・毒付与・死亡
// - 食事/薬: economy.eatItem の HP 回復と解毒
// - 死亡処理: 道具は落とさない、それ以外は半分
// - リスポーン優先順: ベッド → 休憩 → 国マーク → スポーン
// - API ルートとクライアントの配線（ソース確認）
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

const v = loadBundle(
  ["worldbox/items.ts", "worldbox/profile.ts", "worldbox/roles.ts", "worldbox/vitals.ts", "worldbox/economy.ts"],
  [
    "ITEMS", "itemById", "DEFAULT_PROFILE", "parseProfile", "serializeProfile", "addItem",
    "HP_MAX", "HUNGER_MAX", "stepVitals", "applyMobDamage", "applyPlayerDamage", "applyPoison", "curePoison",
    "isPoisoned", "consumeEffect", "applyDeath", "resolveRespawnPoint", "setBedRespawn",
    "applyRest", "eatItem", "POISON_DURATION_MS", "MOB_DAMAGE_COOLDOWN_MS",
  ],
);

const T0 = 1_700_000_000_000;
const fresh = () => v.parseProfile(null);

test("vitals: 旧形式プロフィールは HP 満タン・状態なしで読める", () => {
  const old = v.parseProfile(JSON.stringify({ coins: 5, hunger: 40, items: { wood: 2 }, stealActorAt: 0, stealTargetAt: 0 }));
  assert.equal(old.hp, v.HP_MAX);
  assert.deepEqual(old.status, []);
  assert.equal(old.respawn, null);
  assert.equal(old.deaths, 0);
});

test("vitals: HP・毒・リスポーン点が往復する", () => {
  const p = {
    ...fresh(), hp: 37, hunger: 55,
    status: [{ kind: "poison", until: T0 + 5000 }],
    respawn: { x: 10.5, y: 20.5 }, restPoint: { x: 3.5, y: 4.5 }, deaths: 2,
    pendingDeath: { x: 7.5, y: 8.5 },
  };
  const back = v.parseProfile(v.serializeProfile(p));
  assert.equal(back.hp, 37);
  assert.deepEqual(back.status, [{ kind: "poison", until: T0 + 5000 }]);
  assert.deepEqual(back.pendingDeath, { x: 7.5, y: 8.5 });
  assert.deepEqual(back.respawn, { x: 10.5, y: 20.5 });
  assert.deepEqual(back.restPoint, { x: 3.5, y: 4.5 });
  assert.equal(back.deaths, 2);
});

test("vitals: 空腹は時間で減り、0 が続くと HP が減る", () => {
  const p = { ...fresh(), vitalAt: T0 };
  const after10min = v.stepVitals(p, T0 + 600_000);
  assert.equal(after10min.profile.hunger, 50);
  assert.equal(after10min.profile.hp, v.HP_MAX);
  assert.equal(after10min.died, false);
  // 満腹→空腹まで20分、その後10分飢えると HP は 0.5/秒 × 600秒で全損…ではなくキャップ内では 300 → 死亡
  const starved = v.stepVitals(p, T0 + 1800_000);
  assert.equal(starved.profile.hunger, 0);
  assert.equal(starved.died, true);
});

test("vitals: 精算は30分で頭打ち（長期離脱で飢え死にしない）", () => {
  const p = { ...fresh(), hunger: 100, hp: 100, vitalAt: T0 };
  const after = v.stepVitals(p, T0 + 24 * 3600_000);
  // 30分精算: 空腹は 20分で 0、残り10分の飢えで HP -300 → それでも死亡はする
  // （キャップは「数日分を一気に引かない」ためのもので、30分放置は死亡圏内）
  assert.equal(after.profile.vitalAt, T0 + 24 * 3600_000);
  const half = v.stepVitals(p, T0 + 1500_000); // 25分: 空腹0到達は20分、飢え5分で -150 → 死亡
  assert.equal(half.died, true);
  const safe = v.stepVitals(p, T0 + 900_000); // 15分: 空腹 25、HP 無事
  assert.equal(safe.profile.hunger, 25);
  assert.equal(safe.died, false);
});

test("vitals: 毒の tick は毒の有効窓で数える（vitalAt が古くても過剰に引かない）", () => {
  // 罠は精算なしで毒を付けるため、vitalAt が古いまま毒が付くことがある。
  // 旧実装は vitalAt 起点で tick を数え、15分ぶりの罠毒で即死した（S5）。
  let p = { ...fresh(), vitalAt: T0 - 15 * 60_000, hp: 100, hunger: 100 };
  p = v.applyPoison(p, T0);
  const after = v.stepVitals(p, T0 + 15_000);
  assert.equal(after.profile.hp, v.HP_MAX - 10); // 15秒で 5 tick
  assert.equal(after.died, false);
  // 毒の全窓（30秒）でも最大 10 tick まで
  const full = v.stepVitals(p, T0 + v.POISON_DURATION_MS);
  assert.equal(full.profile.hp, v.HP_MAX - 20);
  assert.deepEqual(full.profile.status, []);
});

test("vitals: 毒は3秒ごとに2減り、期限で消える", () => {
  let p = { ...fresh(), vitalAt: T0 };
  p = v.applyPoison(p, T0);
  assert.equal(v.isPoisoned(p, T0 + 1000), true);
  const ticked = v.stepVitals(p, T0 + 9000);
  assert.equal(ticked.profile.hp, v.HP_MAX - 6);
  const expired = v.stepVitals(ticked.profile, T0 + v.POISON_DURATION_MS + 1000);
  assert.deepEqual(expired.profile.status, []);
});

test("vitals: モブ接触ダメージとクールダウン", () => {
  const p = { ...fresh(), vitalAt: T0 };
  const hit = v.applyMobDamage(p, "wolf", 6, T0 + 1000, () => 0.99);
  assert.equal(hit.applied, true);
  assert.equal(hit.profile.hp, v.HP_MAX - 6);
  const again = v.applyMobDamage(hit.profile, "wolf", 6, T0 + 1000 + v.MOB_DAMAGE_COOLDOWN_MS - 1, () => 0.99);
  assert.equal(again.applied, false);
  assert.equal(again.profile.hp, v.HP_MAX - 6);
  const third = v.applyMobDamage(hit.profile, "wolf", 6, T0 + 1000 + v.MOB_DAMAGE_COOLDOWN_MS, () => 0.99);
  assert.equal(third.applied, true);
  assert.equal(third.profile.hp, v.HP_MAX - 12);
});

test("vitals: プレイヤー攻撃ダメージはモブ接触と同じクールダウンで適用される", () => {
  const p = { ...fresh(), vitalAt: T0 };
  const hit = v.applyPlayerDamage(p, 12, T0 + 1000);
  assert.equal(hit.applied, true);
  assert.equal(hit.died, false);
  assert.equal(hit.profile.hp, v.HP_MAX - 12);
  // 被弾クールダウン中は通らない（モブ接触と共有）
  const again = v.applyPlayerDamage(hit.profile, 12, T0 + 1000 + v.MOB_DAMAGE_COOLDOWN_MS - 1);
  assert.equal(again.applied, false);
  assert.equal(again.profile.hp, v.HP_MAX - 12);
  const third = v.applyPlayerDamage(hit.profile, 12, T0 + 1000 + v.MOB_DAMAGE_COOLDOWN_MS);
  assert.equal(third.applied, true);
  assert.equal(third.profile.hp, v.HP_MAX - 24);
});

test("vitals: プレイヤー攻撃はスポーン保護中は通らず、HP を 0 にすると死亡する", () => {
  const prot = { ...fresh(), vitalAt: T0, spawnProtectedUntil: T0 + 60_000 };
  const blocked = v.applyPlayerDamage(prot, 12, T0 + 1000);
  assert.equal(blocked.applied, false);
  assert.equal(blocked.profile.hp, v.HP_MAX);
  const weak = { ...fresh(), vitalAt: T0, hp: 8 };
  const dead = v.applyPlayerDamage(weak, 12, T0 + 1000);
  assert.equal(dead.applied, true);
  assert.equal(dead.died, true);
  assert.equal(dead.profile.hp, 0);
});

test("vitals: クモは毒を与え、毒で死ぬこともある", () => {
  const p = { ...fresh(), vitalAt: T0, hp: 10 };
  const hit = v.applyMobDamage(p, "spider", 5, T0 + 1000, () => 0);
  assert.equal(hit.poisoned, true);
  assert.equal(v.isPoisoned(hit.profile, T0 + 2000), true);
  const weak = { ...fresh(), vitalAt: T0, hp: 3 };
  const dead = v.applyMobDamage(weak, "slime", 3, T0 + 1000, () => 0.99);
  assert.equal(dead.died, true);
  assert.equal(dead.profile.hp, 0);
});

test("vitals: 食事は空腹と HP、薬は解毒もする（eatItem）", () => {
  let p = { ...fresh(), hp: 40, hunger: 30 };
  p = v.addItem(p, "bread", 1);
  p = v.addItem(p, "bandage", 1);
  p = v.addItem(p, "antidote", 1);
  const ate = v.eatItem(p, "bread");
  assert.equal(ate.ok, true);
  assert.equal(ate.profile.hunger, 50);
  const healed = v.eatItem(ate.profile, "bandage");
  assert.equal(healed.ok, true);
  assert.equal(healed.profile.hp, 65);
  const poisoned = v.applyPoison(healed.profile, Date.now());
  const cured = v.eatItem(poisoned, "antidote");
  assert.equal(cured.ok, true);
  assert.deepEqual(cured.profile.status, []);
  // 満腹・HP満タン・毒なしでは食べられない
  const full = v.eatItem({ ...fresh(), hp: 100, hunger: 100, items: { bread: 1 } }, "bread");
  assert.equal(full.ok, false);
});

test("vitals: ポーションは空腹+HP+解毒の複合（consumeEffect と一致）", () => {
  let p = { ...fresh(), hp: 50, hunger: 10 };
  p = v.applyPoison(p, Date.now());
  const eff = v.consumeEffect(p, "potion");
  assert.equal(eff.hpGain, 35);
  assert.equal(eff.hungerGain, 60);
  assert.equal(eff.cured, true);
  assert.equal(v.consumeEffect(p, "wood"), null);
});

test("vitals: 死亡ドロップは道具を落とさず、他を半分落とす", () => {
  let p = fresh();
  p = v.addItem(p, "iron_sword", 1);
  p = v.addItem(p, "wood", 10);
  p = v.addItem(p, "stone", 3);
  p = { ...p, hp: 0, hunger: 10 };
  const { profile: revived, dropped } = v.applyDeath(p, T0);
  assert.deepEqual(dropped, { wood: 5, stone: 1 });
  assert.equal(revived.items.iron_sword, 1);
  assert.equal(revived.items.wood, 5);
  assert.equal(revived.items.stone, 2);
  assert.equal(revived.hp, v.HP_MAX);
  assert.equal(revived.hunger, 50);
  assert.equal(revived.deaths, 1);
  assert.deepEqual(revived.status, []);
});

test("vitals: リスポーン優先順は ベッド → 休憩 → 国マーク → スポーン", () => {
  const mark = { x: 100.5, y: 100.5 };
  const fallback = { x: 512.5, y: 512.5 };
  let p = fresh();
  assert.deepEqual(v.resolveRespawnPoint(p, null, fallback), { point: fallback, source: "spawn" });
  assert.deepEqual(v.resolveRespawnPoint(p, mark, fallback), { point: mark, source: "mark" });
  p = { ...p, restPoint: { x: 7.5, y: 8.5 } };
  assert.equal(v.resolveRespawnPoint(p, mark, fallback).source, "rest");
  p = v.setBedRespawn(p, 20, 21);
  const r = v.resolveRespawnPoint(p, mark, fallback);
  assert.equal(r.source, "bed");
  assert.deepEqual(r.point, { x: 20.5, y: 21.5 });
});

test("vitals: 休憩は HP 全回復・毒消去・休憩地点の記録", () => {
  let p = { ...fresh(), hp: 12, vitalAt: T0 };
  p = v.applyPoison(p, T0);
  const rested = v.applyRest(p, { x: 9.5, y: 9.5 }, T0 + 1000);
  assert.equal(rested.hp, v.HP_MAX);
  assert.deepEqual(rested.status, []);
  assert.deepEqual(rested.restPoint, { x: 9.5, y: 9.5 });
});

test("vitals: 薬アイテムがカタログにある（解毒薬・包帯、レシピつき）", () => {
  assert.ok(v.itemById("antidote")?.curePoison);
  assert.ok((v.itemById("bandage")?.heal ?? 0) > 0);
  assert.ok((v.itemById("potion")?.heal ?? 0) > 0);
});

test("vitals: API ルートがサーバー検証つきで配線されている", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/vitals/route.ts"), "utf8");
  assert.match(route, /action === "damage"/);
  assert.match(route, /mobExistsAt/);
  assert.match(route, /applyMobDamage/);
  assert.match(route, /applyDeath/);
  assert.match(route, /resolveRespawnPoint/);
  assert.match(route, /set_bed/);
  // REST ハートビートには触らない
  assert.doesNotMatch(route, /worldbox_presence/);
});

test("vitals: クライアントが HP バー・接触ダメージ・定期精算・ベッドを配線している", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.match(client, /\/api\/worldbox\/vitals/);
  assert.match(client, /postMobDamage/);
  assert.match(client, /action: "sync"/);
  assert.match(client, /action: "set_bed"/);
  assert.match(client, /HP_MAX/);
  assert.doesNotMatch(client, /プレイヤー HP は未実装/);
});

test("vitals: 蘇生のテレポートは死亡した空間へ戻す（S5）", () => {
  // 従来は respawnActionRef が space を "world" に固定していたため、
  // 洞窟・遺跡・ダンジョンで蘇生されるとワールドの同座標へ飛ばされた。
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.match(client, /parseInstanceSpace\(t\.space\)/);
  assert.match(client, /instanceWarpRef\.current\(t\.space/);
  assert.match(client, /instanceWarpRef\.current = warpToInstance/);
});
