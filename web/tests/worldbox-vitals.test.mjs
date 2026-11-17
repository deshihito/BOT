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
    "HP_MAX", "HUNGER_MAX", "stepVitals", "applyMobDamage", "applyPoison", "curePoison",
    "isPoisoned", "consumeEffect", "applyDeath", "resolveRespawnPoint", "setBedRespawn",
    "applyRest", "eatItem", "POISON_DURATION_MS", "MOB_DAMAGE_COOLDOWN_MS",
    "applyBuff", "classifyActivity", "activityForWindow", "hungerDrainPerSec",
    "HUNGER_DRAIN_IDLE_PER_SEC", "HUNGER_MOVE_MULT", "HUNGER_DASH_MULT",
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
  };
  const back = v.parseProfile(v.serializeProfile(p));
  assert.equal(back.hp, 37);
  assert.deepEqual(back.status, [{ kind: "poison", until: T0 + 5000 }]);
  assert.deepEqual(back.respawn, { x: 10.5, y: 20.5 });
  assert.deepEqual(back.restPoint, { x: 3.5, y: 4.5 });
  assert.equal(back.deaths, 2);
});

test("vitals: 空腹は活動で減り方が変わり、0 が続くと HP が減る", () => {
  const p = { ...fresh(), vitalAt: T0 };
  // 放置（既定）: 10分でもわずかしか減らない（満腹→空まで約4時間）
  const idle10 = v.stepVitals(p, T0 + 600_000);
  assert.equal(idle10.profile.hunger, 95.833);
  assert.equal(idle10.profile.hp, v.HP_MAX);
  assert.equal(idle10.died, false);
  // 移動は放置の1.6倍、ダッシュは2.5倍の速さで減る
  assert.equal(v.stepVitals(p, T0 + 600_000, "move").profile.hunger, 93.333);
  assert.equal(v.stepVitals(p, T0 + 600_000, "dash").profile.hunger, 89.583);
  // 空腹が窓の途中で尽きると、残り時間ぶん飢えダメージが入る
  const almost = { ...fresh(), vitalAt: T0, hunger: 10 };
  const starved = v.stepVitals(almost, T0 + 1800_000, "dash");
  assert.equal(starved.profile.hunger, 0);
  assert.equal(starved.died, true);
});

test("vitals: 放置レートは満腹→空まで約4時間、活動倍率は 1.6 / 2.5", () => {
  assert.ok(Math.abs(v.hungerDrainPerSec("idle") * 14400 - 100) < 1e-9);
  assert.ok(Math.abs(v.hungerDrainPerSec("move") / v.hungerDrainPerSec("idle") - v.HUNGER_MOVE_MULT) < 1e-9);
  assert.ok(Math.abs(v.hungerDrainPerSec("dash") / v.hungerDrainPerSec("idle") - v.HUNGER_DASH_MULT) < 1e-9);
  assert.equal(v.HUNGER_DRAIN_IDLE_PER_SEC, 100 / 14400);
  // 30分精算を7回つなげると（=3.5時間放置）空腹は残りわずかで HP は無事
  let p = { ...fresh(), vitalAt: T0, hunger: 100 };
  for (let i = 1; i <= 7; i++) p = v.stepVitals(p, T0 + i * 1800_000).profile;
  assert.equal(p.hunger, 12.5); // 1回 12.5 ずつ、端数は保持される
  assert.equal(p.hp, v.HP_MAX);
});

test("vitals: warm は活動レートにも掛かる", () => {
  const base = { ...fresh(), vitalAt: T0, hunger: 100 };
  const warmed = v.applyBuff(base, "warm", T0);
  // ダッシュ10分: 素では 89.583、warm 中は実効レート ×0.6 で 93.75
  assert.equal(v.stepVitals(base, T0 + 600_000, "dash").profile.hunger, 89.583);
  assert.equal(v.stepVitals(warmed, T0 + 600_000, "dash").profile.hunger, 93.75);
});

test("vitals: 飢えの開始は warm 込みの実効レートで決まる", () => {
  const base = { ...fresh(), vitalAt: T0, hunger: 3, hp: 100 };
  // ダッシュ: 空腹 3 は 3 / (100/14400×2.5) = 172.8秒で尽きる
  // → 315秒の窓で飢えは 142.2秒、HP は 0.5 × 142.2 = 71.1 減る
  const plain = v.stepVitals(base, T0 + 315_000, "dash");
  assert.equal(plain.profile.hunger, 0);
  assert.equal(plain.profile.hp, 28.9);
  // warm が窓全体を覆うと実効レート ×0.6 で 288秒に尽き、飢えは 27秒だけ
  const warmed = v.applyBuff(base, "warm", T0);
  const withWarm = v.stepVitals(warmed, T0 + 315_000, "dash");
  assert.equal(withWarm.profile.hunger, 0);
  assert.equal(withWarm.profile.hp, 86.5); // 100 - 0.5 × 27
});

test("vitals: 活動クラスは平均速度で決まる（上限で頭打ち）", () => {
  assert.equal(v.classifyActivity(0), "idle");
  assert.equal(v.classifyActivity(0.29), "idle");
  assert.equal(v.classifyActivity(0.3), "move");
  assert.equal(v.classifyActivity(4.4), "move"); // 歩行
  assert.equal(v.classifyActivity(5.4), "move"); // ダッシュ泳
  assert.equal(v.classifyActivity(5.6), "dash");
  assert.equal(v.classifyActivity(7), "dash"); // ダッシュ
  assert.equal(v.classifyActivity(10000), "dash"); // テレポート等の跳びは上限で頭打ち
  assert.equal(v.classifyActivity(Number.NaN), "idle");
});

test("vitals: activityForWindow は位置の無い窓・空間変更を idle にする", () => {
  const prev = { x: 0, y: 0, space: "world" };
  assert.equal(v.activityForWindow(null, { x: 0, y: 0, space: "world" }, 15), "idle");
  assert.equal(v.activityForWindow(prev, null, 15), "idle");
  assert.equal(v.activityForWindow(prev, { x: 0, y: 0, space: "lobby" }, 15), "idle");
  assert.equal(v.activityForWindow(prev, { x: 1, y: 0, space: "world" }, 15), "idle"); // 0.07/秒
  assert.equal(v.activityForWindow(prev, { x: 66, y: 0, space: "world" }, 15), "move"); // 4.4/秒=歩行
  assert.equal(v.activityForWindow(prev, { x: 105, y: 0, space: "world" }, 15), "dash"); // 7/秒=ダッシュ
  assert.equal(v.activityForWindow(prev, { x: 105, y: 0, space: "world" }, 0), "idle");
});

test("vitals: 前回精算位置（vitalX/vitalY/vitalSpace）が往復し、旧データでは未設定", () => {
  const p = { ...fresh(), vitalX: 12.5, vitalY: -30.25, vitalSpace: "world" };
  const back = v.parseProfile(v.serializeProfile(p));
  assert.equal(back.vitalX, 12.5);
  assert.equal(back.vitalY, -30.25);
  assert.equal(back.vitalSpace, "world");
  const old = v.parseProfile(JSON.stringify({ coins: 5, hunger: 40 }));
  assert.equal(old.vitalX, undefined);
  assert.equal(old.vitalY, undefined);
  assert.equal(old.vitalSpace, undefined);
  // 位置が無いプロフィールは serialize しても位置キーを持たない
  assert.equal("vitalX" in JSON.parse(v.serializeProfile(fresh())), false);
  // 死亡すると前回精算位置は捨てられる（リスポーン=テレポートを活動に数えない）
  const died = v.applyDeath(p, T0);
  assert.equal(died.profile.vitalX, undefined);
  assert.equal(died.profile.vitalSpace, undefined);
});

test("vitals: 精算は30分で頭打ち（長期離脱で飢え死にしない）", () => {
  const p = { ...fresh(), hunger: 100, hp: 100, vitalAt: T0 };
  const after = v.stepVitals(p, T0 + 24 * 3600_000);
  // 30分ぶんだけ精算する: 放置レートで 1800秒 × 100/14400 = 12.5 減るだけ
  assert.equal(after.profile.hunger, 87.5);
  assert.equal(after.profile.vitalAt, T0 + 24 * 3600_000);
  assert.equal(after.died, false);
  const safe = v.stepVitals(p, T0 + 900_000); // 15分: 空腹 93.75、HP 無事
  assert.equal(safe.profile.hunger, 93.75);
  assert.equal(safe.died, false);
});

test("vitals: 15秒間隔の精算でも空腹レートは仕様どおり（端数を捨てない）", () => {
  // クライアントは15秒ごとに sync する。精算のたびに整数化すると
  // 放置でも1回 -1 ずつ減り約25分で空になる（活動倍率の差も消える）。
  let idle = { ...fresh(), vitalAt: T0, hunger: 100 };
  let dash = { ...fresh(), vitalAt: T0, hunger: 100 };
  for (let i = 1; i <= 100; i++) {
    idle = v.stepVitals(idle, T0 + i * 15_000, "idle").profile;
    dash = v.stepVitals(dash, T0 + i * 15_000, "dash").profile;
  }
  // 1500秒: 放置 = 100 - 100×1500/14400、ダッシュはその2.5倍の減少
  // （小数第3位までの保持のため、累積の丸め誤差は許容する）
  assert.ok(Math.abs(idle.hunger - 89.583) < 0.05);
  assert.ok(Math.abs(dash.hunger - 73.958) < 0.05);
  assert.equal(idle.hp, v.HP_MAX);
});

test("vitals: 毒は精算を細かく分けても一括と同じ総ダメージになる", () => {
  // 1秒間隔の精算では tick の端数（3秒未満）が毎回消え、毒が無力化した。
  let p = { ...fresh(), vitalAt: T0, hunger: 100 };
  p = v.applyPoison(p, T0);
  for (let i = 1; i <= 30; i++) p = v.stepVitals(p, T0 + i * 1000).profile;
  assert.ok(Math.abs(p.hp - (v.HP_MAX - 20)) < 0.05); // 30秒ぶん = 2 × (30000/3000)。端数丸めの誤差は許容
  assert.deepEqual(p.status, []);
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
  // 空腹の活動クラスはサーバー側で位置から判定し、精算位置を profile に残す
  assert.match(route, /activityForWindow/);
  assert.match(route, /stepVitals\(current, now, activity\)/);
  assert.match(route, /vitalX: cur\.x/);
  // REST ハートビートには触らない
  assert.doesNotMatch(route, /worldbox_presence/);
});

test("vitals: 死亡・蘇生の移動先へプレゼンスとセーブをそろえる（B4）", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/vitals/route.ts"), "utf8");
  // 死亡（自死）と蘇生配送の両方で、移動先が新しい連続性の基準になる
  assert.match(route, /movePresenceAndSave/);
  assert.match(route, /movePresenceAndSave\(ownerKey, \{ space: "world", x: front\.x, y: front\.y \}, now, name\)/);
  assert.match(route, /movePresenceAndSave\(ownerKey, \{ space: "world", x: point\.x, y: point\.y \}, now, name\)/);
  // 配送の更新に失敗したら pendingTeleport/lastDeath を残して次回再送する
  assert.match(route, /movePresenceAndSave\(ownerKey, teleport, now, session\.username/);
  // 失敗時は died:false で返し（通常 sync の返却と合わせて 3 箇所）、次回 sync で再送される
  assert.equal(route.match(/return NextResponse\.json\(\{ profile, died: false \}, \{ headers: NO_STORE \}\)/g)?.length, 3);
});

test("vitals: sync / damage / set_bed / hazard はユーザー単位ロック内で読み直す（B3）", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/vitals/route.ts"), "utf8");
  // ロック外のスナップショットで保存すると、並走する精算・被弾と
  // 上書きし合い、PvP の死亡通知が消えてドロップが復活する。
  // hazard も同じ RMW のためロック内（2026-11-17 に追加）。
  assert.equal(route.match(/withUserLock\(ownerKey, async \(\) => \{/g)?.length, 4);
  // 守護への熟練は別ユーザーの書き込みのため、攻撃者のロック外で
  // 守護本人のロックを取る（内側に入れると相互攻撃と循環待ちになる）。
  assert.match(route, /grantGuard = guards\[0\]\.ownerKey;/);
  assert.match(route, /withUserLock\(guardKey, async \(\) => \{/);
});

test("vitals: クライアントが HP バー・接触ダメージ・定期精算・ベッドを配線している", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.match(client, /\/api\/worldbox\/vitals/);
  assert.match(client, /postMobDamage/);
  assert.match(client, /action: "sync"/);
  assert.match(client, /action: "set_bed"/);
  assert.match(client, /HP_MAX/);
  assert.doesNotMatch(client, /プレイヤー HP は未実装/);
  // 定期精算は現在位置と空間を送る（活動判定はサーバー側）
  assert.match(client, /px: playerPosRef\.current\.x, py: playerPosRef\.current\.y/);
  assert.match(client, /space: spaceUiRef\.current/);
});

test("vitals: 蘇生のテレポートは死亡した空間へ戻す（S5）", () => {
  // 従来は respawnActionRef が space を "world" に固定していたため、
  // 洞窟・遺跡・ダンジョンで蘇生されるとワールドの同座標へ飛ばされた。
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.match(client, /parseInstanceSpace\(t\.space\)/);
  assert.match(client, /instanceWarpRef\.current\(t\.space/);
  assert.match(client, /instanceWarpRef\.current = warpToInstance/);
});
