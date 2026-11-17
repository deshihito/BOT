// AGO WORLD BOX フィールド PvP（プレイヤー同士の攻撃）のテスト。
// 闘技場のターン制決闘（pvp.ts）とは別物で、こちらはフィールドで
// 他プレイヤーをタップして殴る経路（vitals ルート action "pvp"）。
// - applyPvpDamage: 精算→スポーン保護→被弾クールダウン（モブと共有）→HP 減→死亡
// - pvpSpaceAllowed: ワールド/洞窟/遺跡のみ可、ロビー系/テント/ダンジョン不可
// - profile の lastDeath（PvP 死亡通知）の往復
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
  ["worldbox/items.ts", "worldbox/profile.ts", "worldbox/vitals.ts"],
  [
    "parseProfile", "serializeProfile", "applyPvpDamage", "applyMobDamage",
    "pvpSpaceAllowed", "PVP_ATTACK_MAX_DISTANCE", "MOB_DAMAGE_COOLDOWN_MS", "HP_MAX",
  ],
);

const T0 = 1_700_000_000_000;
const fresh = () => v.parseProfile(null);

test("pvp: ダメージが式どおり HP から引かれ、被弾時刻が残る", () => {
  const r = v.applyPvpDamage(fresh(), 20, T0);
  assert.equal(r.applied, true);
  assert.equal(r.damage, 20);
  assert.equal(r.died, false);
  assert.equal(r.profile.hp, v.HP_MAX - 20);
  assert.equal(r.profile.lastDamageAt, T0);
});

test("pvp: ダメージは整数へ切り捨てる（剣士倍率の端数）", () => {
  const r = v.applyPvpDamage(fresh(), 10.9, T0);
  assert.equal(r.damage, 10);
  assert.equal(r.profile.hp, v.HP_MAX - 10);
});

test("pvp: スポーン保護中は無効", () => {
  const p = { ...fresh(), spawnProtectedUntil: T0 + 60_000 };
  const r = v.applyPvpDamage(p, 20, T0);
  assert.equal(r.applied, false);
  assert.equal(r.damage, 0);
  assert.equal(r.profile.hp, v.HP_MAX);
});

test("pvp: 被弾クールダウンはモブ接触と共有する", () => {
  const first = v.applyPvpDamage(fresh(), 10, T0);
  assert.equal(first.applied, true);
  // クールダウン中は PvP もモブ接触も通らない
  const again = v.applyPvpDamage(first.profile, 10, T0 + v.MOB_DAMAGE_COOLDOWN_MS - 1);
  assert.equal(again.applied, false);
  assert.equal(again.profile.hp, v.HP_MAX - 10);
  const mob = v.applyMobDamage(first.profile, "slime", 10, T0 + 500);
  assert.equal(mob.applied, false);
  // クールダウン明けは通る
  const after = v.applyPvpDamage(first.profile, 10, T0 + v.MOB_DAMAGE_COOLDOWN_MS);
  assert.equal(after.applied, true);
  assert.equal(after.profile.hp, v.HP_MAX - 20);
});

test("pvp: HP が 0 になると died", () => {
  const p = { ...fresh(), hp: 15 };
  const r = v.applyPvpDamage(p, 20, T0);
  assert.equal(r.applied, true);
  assert.equal(r.died, true);
  assert.equal(r.profile.hp, 0);
});

test("pvp: 毒は付かない", () => {
  const r = v.applyPvpDamage(fresh(), 10, T0);
  assert.deepEqual(r.profile.status, []);
});

test("pvp: 適用前にバイタル精算が走る（vitalAt が進む）", () => {
  const p = { ...fresh(), vitalAt: T0 - 60_000 };
  const r = v.applyPvpDamage(p, 10, T0);
  assert.equal(r.profile.vitalAt, T0);
});

test("pvp: 許可空間はワールドと洞窟・遺跡だけ", () => {
  assert.equal(v.PVP_ATTACK_MAX_DISTANCE, 2.5);
  assert.equal(v.pvpSpaceAllowed("world"), true);
  assert.equal(v.pvpSpaceAllowed("cave:10,20:0"), true);
  assert.equal(v.pvpSpaceAllowed("cave:-5,-5:2"), true);
  assert.equal(v.pvpSpaceAllowed("ruins:0,0:0"), true);
  // ロビー系・テント・ダンジョン（パーティ協力）は不可
  assert.equal(v.pvpSpaceAllowed("lobby"), false);
  assert.equal(v.pvpSpaceAllowed("lobby2"), false);
  assert.equal(v.pvpSpaceAllowed("lobby3"), false);
  assert.equal(v.pvpSpaceAllowed("tent"), false);
  assert.equal(v.pvpSpaceAllowed("dungeon:1,2:0"), false);
  // 不正な形式は不可
  assert.equal(v.pvpSpaceAllowed(""), false);
  assert.equal(v.pvpSpaceAllowed("cave:1,2"), false);
  assert.equal(v.pvpSpaceAllowed("cave:a,b:0"), false);
  assert.equal(v.pvpSpaceAllowed(undefined), false);
  assert.equal(v.pvpSpaceAllowed(null), false);
  assert.equal(v.pvpSpaceAllowed(42), false);
});

test("pvp: lastDeath（死亡通知）がプロフィールを往復する", () => {
  const p = { ...fresh(), lastDeath: { at: T0, dropped: { wood: 2 } } };
  const back = v.parseProfile(v.serializeProfile(p));
  assert.deepEqual(back.lastDeath, { at: T0, dropped: { wood: 2 } });
  // 既定は null、壊れた値は null に落ちる
  assert.equal(fresh().lastDeath, null);
  assert.equal(v.parseProfile(JSON.stringify({ lastDeath: { at: 0, dropped: {} } })).lastDeath, null);
  assert.equal(v.parseProfile(JSON.stringify({ lastDeath: "x" })).lastDeath, null);
  // 定義の無いアイテムは dropped から落ちる
  const mixed = v.parseProfile(JSON.stringify({ lastDeath: { at: T0, dropped: { wood: 1, no_such_item: 3 } } }));
  assert.deepEqual(mixed.lastDeath, { at: T0, dropped: { wood: 1 } });
});

test("pvp: API ルートが空間・距離・所有者解決つきで配線されている", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/vitals/route.ts"), "utf8");
  assert.match(route, /action === "pvp"/);
  assert.match(route, /listPresenceWithOwners/);
  assert.match(route, /applyPvpDamage/);
  assert.match(route, /pvpSpaceAllowed/);
  assert.match(route, /PVP_ATTACK_MAX_DISTANCE/);
  assert.match(route, /playerAttack\(current\.items, current\.enhance\)/);
  assert.match(route, /target_not_found/);
  assert.match(route, /invalid_target/);
  assert.match(route, /too_far/);
  // 被害者の死亡は被害者側プロフィールへ通知として残す
  assert.match(route, /settleVictimDeath/);
  assert.match(route, /lastDeath: \{ at: now, dropped \}/);
  // REST ハートビートには触らない
  assert.doesNotMatch(route, /worldbox_presence/);
});

test("pvp: 被害者の書き込みは被害者本人のロックで直列化する（B3）", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/vitals/route.ts"), "utf8");
  // 鍵は被害者本人の sync / damage と同じ素の ownerKey。別鍵（旧 vitals-pvp:）
  // だと被害者の sync が古いスナップショットで死亡通知を上書きし、
  // ドロップした所持品が復活する。
  assert.match(route, /withUserLock\(target\.ownerKey, async \(\) => \{/);
  assert.doesNotMatch(route, /vitals-pvp:/);
  // sync / damage / set_bed / hazard も同じ鍵で直列化し、ロック内で読み直す
  assert.equal(route.match(/withUserLock\(ownerKey, async \(\) => \{/g)?.length, 4);
  assert.match(route, /const current = await loadProfile\(ownerKey\);/);
});

test("pvp: sync が死亡通知を対で配送して消す", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/vitals/route.ts"), "utf8");
  assert.match(route, /profile\.lastDeath/);
  assert.match(route, /died: true, dropped: death\.dropped/);
  assert.match(route, /pendingTeleport: null, lastDeath: null/);
});

test("pvp: クライアントが他プレイヤーのタップを攻撃として配線している", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.match(client, /action: "pvp"/);
  assert.match(client, /attackPlayer/);
  assert.match(client, /pvpSpaceAllowed\(space\)/);
  assert.match(client, /from "@\/lib\/worldbox\/vitals"/);
});

test("pvp: クライアントのタップ振り分けは距離で分ける（範囲内=攻撃、範囲外=カード）", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  // 判定はサーバーの検証と同じユークリッド 2.5 タイル、両者の補間表示位置で測る
  assert.match(client, /PVP_ATTACK_MAX_DISTANCE/);
  assert.match(client, /Math\.hypot\(other\.track\.rx - player\.x, other\.track\.ry - player\.y\) <= PVP_ATTACK_MAX_DISTANCE/);
  // 攻撃は PvP 可能空間かつ近接範囲内のときだけ
  assert.match(client, /pvpSpaceAllowed\(space\) && inMeleeRange/);
  // 範囲外・PvP 不可空間は従来どおりプレイヤーカード（パーティ招待の導線）
  assert.match(client, /showPlayerCardRef\.current\(\{/);
});
