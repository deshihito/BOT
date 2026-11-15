// AGO WORLD BOX フィールド戦闘のテスト。
// - 個体キー/状態のパース
// - 攻撃の適用（HP・死亡・ドロップ・再出現）
// - 配置の再計算による実在検証と視認範囲の列挙
// - 占有範囲までの距離
// - API ルートとクライアントの配線
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

const combatUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/maplogic.ts", "worldbox/items.ts", "worldbox/mobs.ts", "worldbox/combat.ts", "worldbox/arena.ts"],
  [
    "mobById", "MOBS",
    "mobKeyOf", "parseMobKey", "parseMobState", "parseMobStates", "mobHpNow",
    "visibleMobs", "mobExistsAt", "mobDistance", "applyMobAttack", "MOB_RESPAWN_MS",
    "attackTarget", "playerAttack",
  ],
);
const bundled = await import(combatUrl);
const combat = bundled;
const mobs = bundled;
const arena = bundled;

const SEED = 20251115;
const always = () => 0; // chance を必ず通し、個数は min になる乱数
const never = () => 0.999999;

test("combat モジュールが存在する", () => {
  assert.ok(combat, "lib/worldbox/combat.ts が無い");
  assert.ok(mobs && arena);
});

test("個体キーの往復と検証", () => {
  const key = combat.mobKeyOf({ mobId: "slime", x: 512, y: 300 });
  assert.equal(key, "slime@512,300");
  assert.deepEqual(combat.parseMobKey(key), { mobId: "slime", x: 512, y: 300 });
  assert.equal(combat.parseMobKey("unknown_mob@1,2"), null);
  assert.equal(combat.parseMobKey("slime@x,y"), null);
  assert.equal(combat.parseMobKey(42), null);
});

test("状態パース: 不正値は捨てる、deadUntil は保持する", () => {
  assert.deepEqual(combat.parseMobState('{"hp":7}'), { hp: 7 });
  assert.deepEqual(combat.parseMobState({ hp: 0, deadUntil: 123 }), { hp: 0, deadUntil: 123 });
  assert.equal(combat.parseMobState('{"hp":"7"}'), null);
  assert.equal(combat.parseMobState("not json"), null);
  const states = combat.parseMobStates({ "slime@1,2": { hp: 3 }, "bad": { hp: 1 }, "wolf@5,5": "xx" });
  assert.deepEqual(Object.keys(states), ["slime@1,2"]);
});

test("HP の現在値: 未保存は満タン、deadUntil 経過で復活", () => {
  const slime = mobs.mobById("slime");
  assert.deepEqual(combat.mobHpNow(slime, null, 1000), { hp: slime.hp, alive: true });
  assert.deepEqual(combat.mobHpNow(slime, { hp: 4 }, 1000), { hp: 4, alive: true });
  assert.deepEqual(combat.mobHpNow(slime, { hp: 0, deadUntil: 2000 }, 1000), { hp: 0, alive: false });
  assert.deepEqual(combat.mobHpNow(slime, { hp: 0, deadUntil: 2000 }, 2000), { hp: slime.hp, alive: true });
});

test("攻撃: ダメージで HP が減り、0 で倒れてドロップと再出現時刻が付く", () => {
  const slime = mobs.mobById("slime"); // hp 10
  const r1 = combat.applyMobAttack(slime, null, 8, 1000, always);
  assert.equal(r1.hp, 2);
  assert.equal(r1.dead, false);
  assert.deepEqual(r1.gained, {});
  const r2 = combat.applyMobAttack(slime, r1.state, 8, 2000, always);
  assert.equal(r2.dead, true);
  assert.equal(r2.state.deadUntil, 2000 + combat.MOB_RESPAWN_MS);
  // slime の loot: slime 1-2 (chance 1) は min=1、slime_core (chance 0.2) も always では通る
  assert.equal(r2.gained.slime, 1);
  assert.equal(r2.gained.slime_core, 1);
  // 死亡中は殴れない
  assert.deepEqual(combat.applyMobAttack(slime, r2.state, 8, 3000, always), { error: "mob_dead" });
  // ドロップ抽選が外れれば何も落ちない
  const chicken = mobs.mobById("chicken");
  const r3 = combat.applyMobAttack(chicken, null, 99, 0, never);
  assert.equal(r3.dead, true);
  assert.deepEqual(r3.gained, { feather: 2 }); // feather は chance 1・max 2（never では max 側）
});

test("ダメージ式は闘技場と一致する（素手8 + 最良の剣 tier×4）", () => {
  assert.equal(arena.playerAttack({}), 8);
  assert.equal(arena.playerAttack({ wooden_sword: 1 }), 12);
  assert.equal(arena.playerAttack({ wooden_sword: 1, mithril_sword: 1 }), 24);
  // 素手8ではスライム(10)を2発、ミスリル剣(24)では1発で倒せる
  const slime = mobs.mobById("slime");
  assert.equal(combat.applyMobAttack(slime, null, arena.playerAttack({}), 0, always).dead, false);
  assert.equal(combat.applyMobAttack(slime, null, arena.playerAttack({ mithril_sword: 1 }), 0, always).dead, true);
});

test("visibleMobs: 決定的で、範囲内だけを返し、夜限定モブは昼に出ない", () => {
  const day1 = combat.visibleMobs(SEED, 448, 448, 575, 575, false);
  const day2 = combat.visibleMobs(SEED, 448, 448, 575, 575, false);
  assert.deepEqual(day1, day2);
  for (const m of day1) {
    assert.ok(m.x >= 448 && m.x <= 575 && m.y >= 448 && m.y <= 575);
    const def = mobs.mobById(m.mobId);
    assert.notEqual(def.time, "night", `昼に夜モブ ${m.mobId} が出た`);
    assert.equal(def.instanceOnly, undefined);
  }
  const night = combat.visibleMobs(SEED, 448, 448, 575, 575, true);
  for (const m of night) {
    assert.notEqual(mobs.mobById(m.mobId).time, "day", `夜に昼モブ ${m.mobId} が出た`);
  }
});

test("mobExistsAt: visibleMobs の個体は実在し、ずらすと実在しない", () => {
  const list = combat.visibleMobs(SEED, 448, 448, 575, 575, false);
  assert.ok(list.length > 0, "スポーン周辺にモブが1体もいない");
  const m = list[0];
  assert.equal(combat.mobExistsAt(SEED, m.mobId, m.x, m.y, false), true);
  assert.equal(combat.mobExistsAt(SEED, m.mobId, m.x + 1, m.y, false), false);
});

test("mobDistance: 占有範囲までのチェビシェフ距離", () => {
  const slime = { x: 100, y: 100, size: 1 };
  assert.equal(combat.mobDistance(100, 100, slime), 0);
  assert.equal(combat.mobDistance(101, 100, slime), 1);
  assert.equal(combat.mobDistance(103, 99, slime), 3);
  const bear = { x: 100, y: 100, size: 3 }; // 占有 99..101
  assert.equal(combat.mobDistance(102, 100, bear), 1);
  assert.equal(combat.mobDistance(98, 98, bear), 1);
  assert.equal(combat.mobDistance(105, 100, bear), 4);
});

test("attackTarget: 照準でなく範囲で当たる（タップがモブから外れても範囲内なら当たる）", () => {
  const slime = { mobId: "slime", x: 101, y: 100, size: 1 };
  // プレイヤー (100,100)、モブは右隣 (101,100)。タップはモブの上のマス (101,99) でも当たる
  assert.equal(combat.attackTarget(100, 100, 101, 99, [slime]), slime);
  // タップが自分のマスでも、範囲内のモブに当たる
  assert.equal(combat.attackTarget(100, 100, 100, 100, [slime]), slime);
  // 範囲外（2マス先）のモブには当たらない
  const far = { mobId: "slime", x: 102, y: 100, size: 1 };
  assert.equal(combat.attackTarget(100, 100, 102, 100, [far]), null);
  // 複数いる場合はタップを含む個体を優先する
  const a = { mobId: "slime", x: 101, y: 100, size: 1 };
  const b = { mobId: "chicken", x: 99, y: 100, size: 1 };
  assert.equal(combat.attackTarget(100, 100, 99, 100, [a, b]), b);
  // 大型は占有範囲で判定する（中心から離れた占有マスでも範囲内）
  const bear = { mobId: "bear", x: 103, y: 100, size: 3 }; // 占有 102..104
  assert.equal(combat.attackTarget(101, 100, 100, 100, [bear]), bear);
});

test("API ルート: 実在検証・距離検証・闘技場式ダメージ・状態保存が配線されている", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/mobs/route.ts"), "utf8");
  assert.ok(route.includes("mobExistsAt"), "配置の再計算による実在検証が無い");
  assert.ok(route.includes("actorWorldPosition"), "本人位置の検証が無い");
  assert.ok(route.includes("MOB_ATTACK_MAX_DISTANCE"), "距離上限が無い");
  assert.ok(route.includes("playerAttack"), "闘技場式のダメージ計算を使っていない");
  assert.ok(route.includes("storeMobState"), "個体状態を保存していない");
  assert.ok(route.includes("addItem"), "ドロップをプロフィールへ入れていない");
  const online = fs.readFileSync(path.join(rootDir, "lib/worldbox/mobs-online.ts"), "utf8");
  assert.ok(online.includes('"worldbox_mobs"'), "bot_kv 名前空間が違う");
});

test("クライアント: モブ描画・タップ攻撃・モーションが配線されている", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("visibleMobs"), "決定的配置を描画に使っていない");
  assert.ok(client.includes("drawMob"), "モブ描画が無い");
  assert.ok(client.includes("handleMobTap"), "タップ攻撃が無い");
  assert.ok(client.includes("attackTarget"), "剣の範囲方式ターゲットを使っていない");
  assert.ok(client.includes('selDef?.tool === "sword"'), "剣選択時の自由振り分岐が無い");
  assert.ok(client.includes('"/api/worldbox/mobs"'), "攻撃 API を呼んでいない");
  assert.ok(client.includes("refreshMobs"), "個体状態の取得が無い");
  // モーション: スイング・被弾フラッシュ・ノックバック・出現ポップ・HP バー
  assert.ok(client.includes("flashAt"), "被弾フラッシュが無い");
  assert.ok(client.includes("fleeUntil"), "被弾後の逃げが無い");
  assert.ok(client.includes("popScale(popProgress(r.seenAt"), "出現ポップが無い");
  assert.ok(client.includes("HP バー"), "HP バーが無い");
  assert.ok(client.includes('kind: "spawn"'), "出現エフェクトを発火していない");
  // UI に絵文字を使わない（モブ名のテキストも出さない: HP バーだけ）
  assert.ok(!client.includes("def.name"), "モブ名テキストを描画している");
});
