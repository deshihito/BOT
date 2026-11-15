// AGO WORLD BOX v2 の検証:
// - ジョイスティック（アナログ入力）と長押しコピー対策のソースガード
// - 昼夜サイクルと敵（出現ゲート・移動・攻撃・夜明け燃焼）
// - 体力（接触/落下ダメージ・無敵時間・死亡ドロップ）
// - 5枠インベントリと満杯時の掘削不可
// - 道具段階のゲート、クラフト、精錬
// - 崩落（緩いブロックの落下・連鎖・構造材は落ちない・潰し）
// - セーブ v1→v2 移行、保存先選択、オンラインセーブ API（認証・往復）
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

const wb = await loadBundle(
  [
    "worldbox/blocks.ts", "worldbox/items.ts", "worldbox/worldgen.ts", "worldbox/inventory.ts",
    "worldbox/physics.ts", "worldbox/rules.ts", "worldbox/daynight.ts", "worldbox/light.ts", "worldbox/pickups.ts",
    "worldbox/enemies.ts", "worldbox/health.ts", "worldbox/craft.ts", "worldbox/collapse.ts",
    "worldbox/save.ts", "worldbox/save-source.ts",
  ],
  [
    "AIR", "GRASS", "DIRT", "STONE", "WOOD", "LEAVES", "SAND", "COAL_ORE", "COPPER_ORE", "BEDROCK",
    "COPPER_INGOT", "WOODEN_PICKAXE", "STONE_PICKAXE", "COPPER_PICKAXE", "SWORD",
    "isLooseBlock", "canDigWith", "requiredTier", "digSecondsFor", "tierOfTool",
    "WORLD_W", "WORLD_H", "generateWorld", "getTile", "setTile", "findSpawn", "makeRng",
    "SLOT_COUNT", "createInventory", "countOf", "addItem", "removeItem", "canAdd", "isInventoryFull",
    "createBody", "stepPlayer", "RUN_SPEED", "STICK_DEADZONE",
    "digTile", "placeTile",
    "advancePhase", "nightAmount", "isNightPhase", "DAY_CYCLE_SEC",
    "buildLightField", "isDarkAt", "lightLevelAt",
    "ENEMY_MAX_HP", "MAX_ENEMIES", "CONTACT_DAMAGE", "createEnemy", "trySpawnEnemy", "stepEnemy", "attackEnemy", "burnEnemiesAtDawn",
    "PLAYER_MAX_HP", "createHealth", "damagePlayer", "healPlayer", "fallDamageFor", "deathDrops",
    "RECIPES", "recipeById", "checkCraft", "applyCraft", "createFurnace", "canStartSmelt", "startSmelt", "tickFurnace", "collectSmelt", "SMELT_SECONDS",
    "settleAfterChange", "stepFalling", "FALL_BLOCK_DAMAGE",
    "serializeSave", "parseSave", "encodeTiles", "SAVE_VERSION",
    "chooseInitialSave",
  ],
);

const clientSrc = fs.readFileSync(path.join(rootDir, "app", "games", "worldbox", "WorldBoxClient.tsx"), "utf8");

// ---------- PART 1: モバイル操作 ----------

test("クライアント: 長押しコピー/コールアウト対策が全面に入っている", () => {
  assert.ok(clientSrc.includes('WebkitTouchCallout: "none"'), "-webkit-touch-callout: none がない");
  assert.ok(clientSrc.includes('userSelect: "none"'), "user-select: none がない");
  assert.ok(clientSrc.includes('WebkitUserSelect: "none"'), "-webkit-user-select がない");
  assert.ok(clientSrc.includes('touchAction: "none"'), "touch-action: none がない");
  assert.ok(clientSrc.includes("onContextMenu"), "contextmenu の preventDefault がない");
});

test("クライアント: D-pad は廃止され、フローティング・ジョイスティックに置き換わった", () => {
  assert.ok(!clientSrc.includes("左へ移動"), "D-pad（左）が残っている");
  assert.ok(!clientSrc.includes("右へ移動"), "D-pad（右）が残っている");
  assert.ok(!clientSrc.includes('holdBtn("←"'), "D-pad ボタンが残っている");
  assert.ok(clientSrc.includes("joyRef"), "ジョイスティックの状態管理がない");
  assert.ok(clientSrc.includes("ジョイスティック"), "ジョイスティックの説明がない");
  assert.ok(clientSrc.includes("JOY_RADIUS"), "スティック半径がない");
  // 右側ボタンは掘る/置く/跳の3つだけ
  assert.ok(clientSrc.includes('holdBtn("掘る"'));
  assert.ok(clientSrc.includes('holdBtn("置く"'));
  assert.ok(clientSrc.includes('holdBtn("跳"'));
});

test("物理: ジョイスティックのアナログ入力は傾きで速さが変わり、デッドゾーンでは止まる", () => {
  const world = wb.generateWorld(7);
  const spawn = wb.findSpawn(world);
  const surf = world.surfaces[spawn.x];
  const mkBody = () => {
    const b = wb.createBody(spawn.x + 0.1, surf - 8);
    const idle = { left: false, right: false, jump: false, fastFall: false };
    for (let i = 0; i < 300; i++) wb.stepPlayer(world, b, idle, 1 / 60);
    return b;
  };
  const half = mkBody();
  wb.stepPlayer(world, half, { left: false, right: false, jump: false, fastFall: false, moveX: 0.5 }, 1 / 60);
  assert.ok(Math.abs(half.vx - wb.RUN_SPEED * 0.5) < 0.01, `半分の傾きで半速にならない vx=${half.vx}`);
  const full = mkBody();
  wb.stepPlayer(world, full, { left: false, right: false, jump: false, fastFall: false, moveX: 1 }, 1 / 60);
  assert.ok(Math.abs(full.vx - wb.RUN_SPEED) < 0.01, "最大の傾きで全速にならない");
  const dead = mkBody();
  wb.stepPlayer(world, dead, { left: false, right: false, jump: false, fastFall: false, moveX: wb.STICK_DEADZONE - 0.05 }, 1 / 60);
  assert.equal(dead.vx, 0, "デッドゾーン内で動いてしまう");
  const left = mkBody();
  wb.stepPlayer(world, left, { left: false, right: false, jump: false, fastFall: false, moveX: -1 }, 1 / 60);
  assert.equal(left.face, -1, "左傾きで左を向かない");
});

// ---------- PART 2a: 昼夜と敵 ----------

test("昼夜: 夜の位相だけ isNightPhase が立ち、位相は循環する", () => {
  assert.equal(wb.isNightPhase(0.0), true);
  assert.equal(wb.isNightPhase(0.5), false);
  assert.equal(wb.isNightPhase(0.97), true);
  assert.equal(wb.nightAmount(0.5), 0);
  const wrapped = wb.advancePhase(0.99, wb.DAY_CYCLE_SEC * 0.02);
  assert.ok(wrapped >= 0 && wrapped < 0.02, `位相が循環しない ${wrapped}`);
});

test("敵: スポーンは暗さで決まる（v2.2）・上限つき・プレイヤーから離れる", () => {
  const world = wb.generateWorld(11);
  const field = wb.buildLightField(world);
  const spawn = wb.findSpawn(world);
  const player = { x: spawn.x + 0.1, y: spawn.y + 2 - 1.8 };
  const rng = wb.makeRng(123);
  // 昼: 出るとしても暗い場所（洞窟）だけ
  for (let i = 0; i < 30; i++) {
    const day = wb.trySpawnEnemy(world, field, 0.5, player, 0, rng);
    if (day) {
      assert.ok(
        wb.isDarkAt(field, world, Math.floor(day.x + 0.45), Math.floor(day.y), 0.5),
        "昼に明るい場所へスポーンした",
      );
    }
  }
  // 夜: スポーンし、上限と最低距離を守る
  let e = null;
  for (let i = 0; i < 40 && !e; i++) e = wb.trySpawnEnemy(world, field, 0.0, player, 0, rng);
  assert.ok(e, "夜なのにスポーンしない");
  assert.equal(e.hp, wb.ENEMY_MAX_HP);
  const d = Math.hypot(e.x + 0.45 - (player.x + 0.4), e.y + 0.45 - (player.y + 0.9));
  assert.ok(d >= 6.4, `プレイヤーに近すぎる d=${d}`);
  assert.equal(wb.trySpawnEnemy(world, field, 0.0, player, wb.MAX_ENEMIES, rng), null, "上限を超えてスポーンした");
});

test("敵: プレイヤーへ歩き、攻撃でノックバックして倒れる", () => {
  const world = wb.generateWorld(11);
  const spawn = wb.findSpawn(world);
  const surf = world.surfaces[spawn.x];
  // 平らな闘技場を整地する（生成地形の凹凸・木に依存しない）
  for (let x = spawn.x; x <= spawn.x + 8; x++) {
    for (let y = 0; y < surf; y++) world.tiles[y * wb.WORLD_W + x] = wb.AIR;
    for (let y = surf; y < surf + 3; y++) world.tiles[y * wb.WORLD_W + x] = wb.STONE;
  }
  const e = wb.createEnemy(spawn.x + 6, surf - 0.9);
  const x0 = e.x;
  for (let i = 0; i < 60; i++) wb.stepEnemy(world, e, spawn.x + 0.5, 1 / 60);
  assert.ok(e.x < x0, "プレイヤー方向へ歩いていない");
  const hpBefore = e.hp;
  const died = wb.attackEnemy(e, 2, spawn.x);
  assert.equal(died, false);
  assert.equal(e.hp, hpBefore - 2);
  assert.ok(e.kx > 0, "プレイヤーと反対側へノックバックしていない");
  assert.equal(wb.attackEnemy(e, 99, spawn.x), true, "倒れていない");
});

test("敵: 夜明けの燃焼は空に開けた場所だけ、夜は燃えない（v2.2）", () => {
  const world = wb.generateWorld(11);
  const field = wb.buildLightField(world);
  const e = wb.createEnemy(10, 10); // 地表より上 = 空に開けている
  assert.deepEqual(wb.burnEnemiesAtDawn(world, field, [e], 0.0, 1), []);
  assert.equal(e.hp, wb.ENEMY_MAX_HP);
  let dead = [];
  for (let i = 0; i < 10 && dead.length === 0; i++) dead = wb.burnEnemiesAtDawn(world, field, [e], 0.5, 0.5);
  assert.deepEqual(dead, [e.id], "昼に燃え尽きない");
});

// ---------- PART 2b: 体力 ----------

test("体力: 無敵時間中は連続ダメージを受けず、回復は上限まで", () => {
  const h = wb.createHealth();
  assert.equal(h.hp, wb.PLAYER_MAX_HP);
  assert.equal(wb.damagePlayer(h, wb.CONTACT_DAMAGE, 100), true);
  assert.equal(h.hp, wb.PLAYER_MAX_HP - wb.CONTACT_DAMAGE);
  assert.equal(wb.damagePlayer(h, wb.CONTACT_DAMAGE, 100.5), false, "無敵時間中にダメージを受けた");
  assert.equal(wb.damagePlayer(h, wb.CONTACT_DAMAGE, 101.5), true);
  assert.equal(wb.healPlayer(h, 99), wb.CONTACT_DAMAGE * 2, "回復量が上限で止まらない");
  assert.equal(h.hp, wb.PLAYER_MAX_HP);
});

test("体力: 落下ダメージは安全な高さを超えた分だけ", () => {
  assert.equal(wb.fallDamageFor(0), 0);
  assert.equal(wb.fallDamageFor(3.5), 0);
  assert.equal(wb.fallDamageFor(4.5), 1);
  assert.equal(wb.fallDamageFor(10), 6);
  assert.equal(wb.fallDamageFor(100), wb.PLAYER_MAX_HP);
});

test("体力: 物理の着地計測が落下距離を返す（高い落下ほど大きい）", () => {
  const world = wb.generateWorld(7);
  const spawn = wb.findSpawn(world);
  const surf = world.surfaces[spawn.x];
  // スポーン列の上空を空けて、木に引っかからない落下にする
  for (let x = spawn.x - 1; x <= spawn.x + 1; x++) {
    for (let y = 0; y < surf; y++) world.tiles[y * wb.WORLD_W + x] = wb.AIR;
  }
  const dropFrom = (height) => {
    const b = wb.createBody(spawn.x + 0.1, surf - height);
    const idle = { left: false, right: false, jump: false, fastFall: false };
    let landed = 0;
    for (let i = 0; i < 600 && landed === 0; i++) {
      wb.stepPlayer(world, b, idle, 1 / 60);
      if (b.landedFall > 0) landed = b.landedFall;
    }
    return landed;
  };
  const small = dropFrom(3);
  const big = dropFrom(12);
  assert.ok(small > 0 && small <= 3.5, `低い落下の計測がおかしい ${small}`);
  assert.ok(big > 8, `高い落下の計測がおかしい ${big}`);
  assert.equal(wb.fallDamageFor(small), 0);
  assert.ok(wb.fallDamageFor(big) > 0);
});

test("死亡ドロップ: ブロックは半分落とし、道具とインゴットは残る", () => {
  const inv = wb.createInventory();
  wb.addItem(inv, wb.DIRT, 10);
  wb.addItem(inv, wb.STONE, 3);
  wb.addItem(inv, wb.WOODEN_PICKAXE, 1);
  wb.addItem(inv, wb.COPPER_INGOT, 5);
  const drops = wb.deathDrops(inv);
  assert.deepEqual(drops, [
    { blockId: wb.DIRT, count: 5 },
    { blockId: wb.STONE, count: 1 },
  ]);
  assert.equal(wb.countOf(inv, wb.DIRT), 5);
  assert.equal(wb.countOf(inv, wb.STONE), 2);
  assert.equal(wb.countOf(inv, wb.WOODEN_PICKAXE), 1);
  assert.equal(wb.countOf(inv, wb.COPPER_INGOT), 5);
});

// ---------- PART 2c: 5枠インベントリ・道具ゲート・クラフト・精錬 ----------

test("インベントリ: 5枠固定、スタックは無制限、道具は1つまで", () => {
  const inv = wb.createInventory();
  assert.equal(inv.slots.length, wb.SLOT_COUNT);
  assert.equal(wb.SLOT_COUNT, 5);
  assert.equal(wb.addItem(inv, wb.DIRT, 500), 500);
  assert.equal(wb.countOf(inv, wb.DIRT), 500);
  assert.equal(inv.slots.filter(Boolean).length, 1, "スタックが枠を増やした");
  assert.equal(wb.addItem(inv, wb.WOODEN_PICKAXE, 1), 1);
  assert.equal(wb.addItem(inv, wb.WOODEN_PICKAXE, 1), 0, "同じ道具を2つ持てた");
  for (const id of [wb.GRASS, wb.STONE, wb.WOOD]) assert.equal(wb.addItem(inv, id, 1), 1);
  assert.equal(wb.isInventoryFull(inv), true);
  assert.equal(wb.addItem(inv, wb.SAND, 1), 0, "満杯なのに新しい種類が入った");
  assert.equal(wb.canAdd(inv, wb.SAND, 1), false);
  assert.equal(wb.canAdd(inv, wb.DIRT, 1), true, "既存スタックへは満杯でも入るはず");
  assert.equal(wb.removeItem(inv, wb.DIRT, 9999), false, "足りないのに取り除けた");
  assert.equal(wb.countOf(inv, wb.DIRT), 500, "失敗した取り除きで数が変わった");
});

test("掘削: 満杯で受け取れないブロックは掘れない（ブロックは残る）", () => {
  const world = wb.generateWorld(7);
  const inv = wb.createInventory();
  for (const id of [wb.GRASS, wb.DIRT, wb.STONE, wb.WOOD, wb.LEAVES]) wb.addItem(inv, id, 1);
  // 砂のパッチを探して掘る（砂は未所持 → 満杯で受け取れない）
  let sandCell = null;
  for (let y = 0; y < wb.WORLD_H && !sandCell; y++) {
    for (let x = 0; x < wb.WORLD_W; x++) {
      if (wb.getTile(world, x, y) === wb.SAND) { sandCell = { x, y }; break; }
    }
  }
  assert.ok(sandCell, "テスト用ワールドに砂がない");
  assert.equal(wb.digTile(world, inv, sandCell.x, sandCell.y), null, "満杯なのに掘れた");
  assert.equal(wb.getTile(world, sandCell.x, sandCell.y), wb.SAND, "掘れなかったのにブロックが消えた");
  // 既に持っている種類（スタック先がある）は満杯でも掘れる
  const spawn = wb.findSpawn(world);
  const surfTile = wb.getTile(world, spawn.x, world.surfaces[spawn.x]);
  assert.ok(wb.digTile(world, inv, spawn.x, world.surfaces[spawn.x]) === surfTile || surfTile === wb.SAND);
});

test("道具ゲート: 素手では石が掘れず、段階ごとに鉱石と深い石が開く", () => {
  const shallow = 30;
  const deep = 50;
  // 素手(0)
  assert.equal(wb.canDigWith(wb.GRASS, shallow, 0), true);
  assert.equal(wb.canDigWith(wb.DIRT, shallow, 0), true);
  assert.equal(wb.canDigWith(wb.WOOD, shallow, 0), true);
  assert.equal(wb.canDigWith(wb.STONE, shallow, 0), false, "素手で石が掘れた");
  assert.equal(wb.canDigWith(wb.COAL_ORE, shallow, 0), false);
  // 木のツルハシ(1)
  assert.equal(wb.canDigWith(wb.STONE, shallow, 1), true);
  assert.equal(wb.canDigWith(wb.COAL_ORE, shallow, 1), false, "木のツルハシで石炭が掘れた");
  assert.equal(wb.canDigWith(wb.COPPER_ORE, shallow, 1), false);
  // 石のツルハシ(2)
  assert.equal(wb.canDigWith(wb.COAL_ORE, shallow, 2), true);
  assert.equal(wb.canDigWith(wb.COPPER_ORE, shallow, 2), true);
  assert.equal(wb.canDigWith(wb.STONE, deep, 2), false, "石のツルハシで深い石が掘れた");
  // 銅のツルハシ(3)
  assert.equal(wb.canDigWith(wb.STONE, deep, 3), true);
  // 岩盤はどの段階でも不可
  assert.equal(wb.canDigWith(wb.BEDROCK, shallow, 3), false);
  assert.equal(wb.requiredTier(wb.STONE, deep), 3);
  // 速さ: 道具が良いほど短い。掘れない道具は Infinity
  assert.equal(wb.digSecondsFor(wb.STONE, shallow, null), Infinity);
  assert.ok(wb.digSecondsFor(wb.STONE, shallow, wb.WOODEN_PICKAXE) > wb.digSecondsFor(wb.STONE, shallow, wb.COPPER_PICKAXE));
  assert.ok(Math.abs(wb.digSecondsFor(wb.DIRT, shallow, null) - 0.4) < 1e-9);
});

test("クラフト: 素材を消費して道具ができ、不足・所持済・枠不足は作れない", () => {
  const inv = wb.createInventory();
  const wooden = wb.recipeById("wooden_pickaxe");
  assert.equal(wb.checkCraft(inv, wooden), "materials");
  assert.equal(wb.applyCraft(inv, wooden), false);
  wb.addItem(inv, wb.WOOD, 3);
  assert.equal(wb.checkCraft(inv, wooden), "ok");
  assert.equal(wb.applyCraft(inv, wooden), true);
  assert.equal(wb.countOf(inv, wb.WOOD), 0, "素材が消費されていない");
  assert.equal(wb.countOf(inv, wb.WOODEN_PICKAXE), 1);
  assert.equal(wb.checkCraft(inv, wooden), "owned", "同じ道具をもう1つ作れる判定になった");
  // 枠不足: 素材はあるが空き枠がなく、成果物が新しい種類
  const full = wb.createInventory();
  wb.addItem(full, wb.WOOD, 3);
  for (const id of [wb.GRASS, wb.DIRT, wb.STONE, wb.SAND]) wb.addItem(full, id, 1);
  assert.equal(wb.checkCraft(full, wooden), "no_slot");
  assert.equal(wb.applyCraft(full, wooden), false);
  assert.equal(wb.countOf(full, wb.WOOD), 3, "作れなかったのに素材が減った");
  // 石のツルハシ（素材2種）
  const inv2 = wb.createInventory();
  wb.addItem(inv2, wb.STONE, 3);
  wb.addItem(inv2, wb.WOOD, 2);
  assert.equal(wb.applyCraft(inv2, wb.recipeById("stone_pickaxe")), true);
  assert.equal(wb.countOf(inv2, wb.STONE_PICKAXE), 1);
  // 剣はインゴットが必要
  const inv3 = wb.createInventory();
  wb.addItem(inv3, wb.COPPER_INGOT, 2);
  wb.addItem(inv3, wb.WOOD, 1);
  assert.equal(wb.applyCraft(inv3, wb.recipeById("sword")), true);
  assert.equal(wb.countOf(inv3, wb.SWORD), 1);
});

test("精錬: 銅鉱石+石炭鉱石 → 時間で銅インゴット、満杯なら かまど に残る", () => {
  const inv = wb.createInventory();
  const furnace = wb.createFurnace();
  assert.equal(wb.canStartSmelt(furnace, inv), false);
  wb.addItem(inv, wb.COPPER_ORE, 1);
  wb.addItem(inv, wb.COAL_ORE, 1);
  assert.equal(wb.canStartSmelt(furnace, inv), true);
  assert.equal(wb.startSmelt(furnace, inv), true);
  assert.equal(wb.countOf(inv, wb.COPPER_ORE), 0);
  assert.equal(wb.countOf(inv, wb.COAL_ORE), 0);
  assert.equal(wb.startSmelt(furnace, inv), false, "精錬中にもう1回始められた");
  assert.equal(wb.tickFurnace(furnace, wb.SMELT_SECONDS - 0.1), false);
  assert.equal(wb.tickFurnace(furnace, 0.2), true, "焼き上がらない");
  assert.equal(furnace.output, 1);
  assert.equal(wb.collectSmelt(furnace, inv), 1);
  assert.equal(wb.countOf(inv, wb.COPPER_INGOT), 1);
  assert.equal(furnace.output, 0);
  // 満杯のときは受け取れず、かまどに残る
  const fullInv = wb.createInventory();
  for (const id of [wb.GRASS, wb.DIRT, wb.STONE, wb.WOOD, wb.LEAVES]) wb.addItem(fullInv, id, 1);
  furnace.output = 2;
  assert.equal(wb.collectSmelt(furnace, fullInv), 0);
  assert.equal(furnace.output, 2, "受け取れなかったのに かまど から消えた");
});

// ---------- PART 2d: 崩落 ----------

/** 整地した列を作る（生成地形に依存しない崩落テスト用）。 */
function clearedColumn(world, x) {
  for (let y = 0; y < wb.WORLD_H; y++) wb.setTile(world, x, y, wb.AIR);
  wb.setTile(world, x, 40, wb.BEDROCK); // 受け皿
}

test("崩落: 支えを失った緩いブロックは連鎖して正しいセルに着地する", () => {
  const world = wb.generateWorld(7);
  const x = 60;
  clearedColumn(world, x);
  wb.setTile(world, x, 39, wb.STONE); // 床（構造材）
  wb.setTile(world, x, 36, wb.DIRT);
  wb.setTile(world, x, 37, wb.DIRT);
  wb.setTile(world, x, 38, wb.DIRT); // 床の上に積まれた土（支えあり）
  // 床の上の土を掘る想定: 38 を空にして settle（36,37 が連鎖して落ちる）
  wb.setTile(world, x, 38, wb.AIR);
  const spawned = wb.settleAfterChange(world, x, 38);
  assert.equal(spawned.length, 2, `連鎖が2つにならない: ${spawned.length}`);
  assert.ok(spawned.every((f) => f.blockId === wb.DIRT));
  const falling = [...spawned];
  for (let i = 0; i < 900 && falling.length > 0; i++) wb.stepFalling(world, falling, 1 / 60);
  assert.equal(falling.length, 0, "全部着地していない");
  assert.equal(wb.getTile(world, x, 38), wb.DIRT, "床の上に着地していない");
  assert.equal(wb.getTile(world, x, 37), wb.DIRT, "2つ目が積み上がっていない");
  assert.equal(wb.getTile(world, x, 36), wb.AIR, "元の場所に残っている");
});

test("崩落: 構造材（原木・石）は支えを失っても落ちない", () => {
  const world = wb.generateWorld(7);
  const x = 62;
  clearedColumn(world, x);
  wb.setTile(world, x, 30, wb.WOOD);
  wb.setTile(world, x, 29, wb.STONE);
  const spawned = wb.settleAfterChange(world, x, 31); // 真下を掘った想定
  assert.equal(spawned.length, 0, "構造材が落ちた");
  assert.equal(wb.getTile(world, x, 30), wb.WOOD);
  assert.equal(wb.getTile(world, x, 29), wb.STONE);
});

test("崩落: 宙に置いた緩いブロックは落ち、落ちたブロックは対象を潰す", () => {
  const world = wb.generateWorld(7);
  const x = 64;
  clearedColumn(world, x);
  wb.setTile(world, x, 39, wb.STONE);
  wb.setTile(world, x, 30, wb.SAND); // 宙に置いた砂
  const spawned = wb.settleAfterChange(world, x, 30);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].blockId, wb.SAND);
  // プレイヤーが受け皿の上に立っている状況で落とす → 潰しイベント
  const falling = [...spawned];
  const target = { key: "player", x: x - 0.4, y: 39 - 1.8, w: 0.8, h: 1.8 };
  let crushed = [];
  for (let i = 0; i < 900 && falling.length > 0 && crushed.length === 0; i++) {
    const ev = wb.stepFalling(world, falling, 1 / 60, [target]);
    crushed = ev.crushed;
  }
  assert.equal(crushed.length, 1, "潰しイベントが出ない");
  assert.equal(crushed[0].targetKey, "player");
  assert.equal(wb.FALL_BLOCK_DAMAGE, 3);
  assert.equal(wb.getTile(world, x, 38), wb.AIR, "潰したブロックがタイルとして残った");
  // 緩さの定義そのもの
  assert.equal(wb.isLooseBlock(wb.GRASS), true);
  assert.equal(wb.isLooseBlock(wb.LEAVES), true);
  assert.equal(wb.isLooseBlock(wb.STONE), false);
  assert.equal(wb.isLooseBlock(wb.WOOD), false);
});

// ---------- セーブ: 移行・保存先選択 ----------

test("保存: v1 セーブは5枠へ移行して読める（6種目は切り捨て、HP満タン）", () => {
  const world = wb.generateWorld(5);
  const v1 = JSON.stringify({
    version: 1,
    seed: 5,
    tilesB64: wb.encodeTiles(world.tiles),
    inventory: { "1": 3, "2": 10, "3": 7, "4": 2, "5": 9, "6": 4 },
    player: { x: 10, y: 12 },
  });
  const parsed = wb.parseSave(v1);
  assert.ok(parsed, "v1 セーブが読めない");
  assert.equal(parsed.inventory.slots.length, 5);
  assert.equal(wb.countOf(parsed.inventory, wb.GRASS), 3);
  assert.equal(wb.countOf(parsed.inventory, wb.DIRT), 10);
  assert.equal(wb.countOf(parsed.inventory, wb.STONE), 7);
  assert.equal(wb.countOf(parsed.inventory, wb.WOOD), 2);
  assert.equal(wb.countOf(parsed.inventory, wb.LEAVES), 9);
  assert.equal(wb.countOf(parsed.inventory, wb.SAND), 0, "6種目の砂が入ってしまった");
  assert.equal(parsed.hp, wb.PLAYER_MAX_HP);
  // 移行後に v3 で保存し直すと往復する
  const again = wb.parseSave(wb.serializeSave(parsed));
  assert.ok(again);
  assert.equal(wb.countOf(again.inventory, wb.DIRT), 10);
});

test("保存: v3 は道具とHPを往復保持し、タイルと位相は保存しない", () => {
  const inv = wb.createInventory();
  wb.addItem(inv, wb.COPPER_PICKAXE, 1);
  wb.addItem(inv, wb.COPPER_INGOT, 4);
  const state = { inventory: inv, player: { x: 3.5, y: 9.5 }, hp: 4 };
  const json = wb.serializeSave(state);
  assert.ok(!json.includes("tilesB64") && !json.includes("dayPhase"), "v3 セーブにタイル/位相が含まれている");
  const parsed = wb.parseSave(json);
  assert.ok(parsed);
  assert.equal(wb.countOf(parsed.inventory, wb.COPPER_PICKAXE), 1);
  assert.equal(wb.countOf(parsed.inventory, wb.COPPER_INGOT), 4);
  assert.equal(parsed.hp, 4);
  assert.deepEqual(parsed.player, { x: 3.5, y: 9.5 });
  assert.equal(wb.SAVE_VERSION, 3);
});

test("保存先選択: ログイン時はオンライン優先、無ければローカルを移行、ゲストはローカルのみ", () => {
  const mkState = (seed) => ({ seed, tiles: new Uint8Array(4), inventory: wb.createInventory(), player: { x: 0, y: 0 }, hp: 10, dayPhase: 0.3 });
  const online = mkState(1);
  const local = mkState(2);
  let c = wb.chooseInitialSave(online, local, true);
  assert.equal(c.source, "online");
  assert.equal(c.state, online);
  assert.equal(c.pushLocalToOnline, false);
  c = wb.chooseInitialSave(null, local, true);
  assert.equal(c.source, "local");
  assert.equal(c.pushLocalToOnline, true, "ログイン時にローカル採用なら移行保存すべき");
  c = wb.chooseInitialSave(online, local, false);
  assert.equal(c.source, "local", "ゲストはオンラインを使わない");
  assert.equal(c.pushLocalToOnline, false);
  c = wb.chooseInitialSave(null, null, true);
  assert.equal(c.source, "new");
  assert.equal(c.state, null);
});

test("クライアント: オンライン保存と5枠・キー1〜5の配線がある", () => {
  assert.ok(clientSrc.includes('fetch("/api/worldbox/save"'), "オンラインセーブ API を呼んでいない");
  assert.ok(clientSrc.includes('method: "PUT"'), "サーバー保存（PUT）がない");
  assert.ok(clientSrc.includes("chooseInitialSave"), "保存先選択ロジックを使っていない");
  assert.ok(clientSrc.includes("/^[1-5]$/"), "数字キーが1〜5になっていない");
  assert.ok(!clientSrc.includes("/^[1-8]$/"), "数字キー1〜8が残っている");
  assert.ok(clientSrc.includes("SLOT_COUNT"), "5枠インベントリを使っていない");
});

// ---------- オンラインセーブ API ルート ----------

// bot_kv はインメモリスタブ、認証は実物の lib/auth（セッション署名を実際に検証する）
const botApiStubUrl = dataUrl(`
const store = new Map();
export function isBotApiConfigured() { return true; }
export async function kvGet(ns, key) { const v = store.get(ns + " " + key); return v === undefined ? null : v; }
export async function kvSet(ns, key, value) { store.set(ns + " " + key, value); }
export async function kvDelete(ns, key) { store.delete(ns + " " + key); }
`);
const subdomainUrl = dataUrl(transpile("subdomain.ts"));
const headersStubUrl = dataUrl("export async function cookies() { throw new Error('tests do not use cookies()'); }");
const authUrl = dataUrl(
  transpile("auth.ts").replaceAll('"./subdomain"', JSON.stringify(subdomainUrl)).replaceAll('"next/headers"', JSON.stringify(headersStubUrl)),
);
const auth = await import(authUrl);
const saveOnlineUrl = dataUrl(
  transpile("worldbox/save-online.ts").replaceAll('"../bot-api"', JSON.stringify(botApiStubUrl)),
);
const saveBundleUrl = dataUrl(
  [
    "worldbox/blocks.ts", "worldbox/items.ts", "worldbox/worldgen.ts", "worldbox/inventory.ts",
    "worldbox/daynight.ts", "worldbox/health.ts", "worldbox/save.ts",
  ]
    .map((name) => stripModuleSyntax(transpile(name)))
    .join("\n") + "\nexport { parseSave };\n",
);
const nextServerStubUrl = dataUrl(`
export class NextResponse {
  static json(body, init = {}) {
    const headers = new Headers(init.headers || {});
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(body), { status: init.status || 200, headers });
  }
}
`);
const route = await import(
  dataUrl(
    transpile("api/worldbox/save/route.ts", rootDir + "/app")
      .replaceAll('"next/server"', JSON.stringify(nextServerStubUrl))
      .replaceAll('"@/lib/auth"', JSON.stringify(authUrl))
      .replaceAll('"@/lib/worldbox/save-online"', JSON.stringify(saveOnlineUrl))
      .replaceAll('"@/lib/worldbox/save"', JSON.stringify(saveBundleUrl)),
  ),
);

process.env.DISCORD_SESSION_SECRET = "<MASKED_SECRET_001>";

function sessionCookie(id, username) {
  const value = auth.createSession({ id, username });
  return `ago_session=${encodeURIComponent(value)}`;
}

function apiRequest(method, cookie, body) {
  return new Request("http://localhost/api/worldbox/save", {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

test("API: 未ログインは GET/PUT ともに 401", async () => {
  const getRes = await route.GET(apiRequest("GET", null));
  assert.equal(getRes.status, 401);
  const putRes = await route.PUT(apiRequest("PUT", null, { save: "{}" }));
  assert.equal(putRes.status, 401);
  const badCookie = await route.GET(apiRequest("GET", "ago_session=forged.value"));
  assert.equal(badCookie.status, 401, "偽セッションが通った");
});

test("API: ログイン中ユーザーは保存→読込が往復し、他人には見えない", async () => {
  const cookieA = sessionCookie("111111111111111111", "user-a");
  const cookieB = sessionCookie("222222222222222222", "user-b");
  const world = wb.generateWorld(77);
  const saveJson = wb.serializeSave({
    seed: 77, tiles: world.tiles, inventory: wb.createInventory(), player: { x: 1, y: 2 }, hp: 10, dayPhase: 0.3,
  });
  // 最初は空
  const empty = await (await route.GET(apiRequest("GET", cookieA))).json();
  assert.equal(empty.save, null);
  // 保存
  const putRes = await route.PUT(apiRequest("PUT", cookieA, { save: saveJson }));
  assert.equal(putRes.status, 200);
  assert.deepEqual(await putRes.json(), { saved: true });
  // 読み戻し（完全一致）
  const got = await (await route.GET(apiRequest("GET", cookieA))).json();
  assert.equal(got.save, saveJson);
  // 別ユーザーには見えない
  const other = await (await route.GET(apiRequest("GET", cookieB))).json();
  assert.equal(other.save, null);
  // 壊れたセーブは 400 で拒否
  const broken = await route.PUT(apiRequest("PUT", cookieA, { save: "{not-a-save" }));
  assert.equal(broken.status, 400);
  const wrongType = await route.PUT(apiRequest("PUT", cookieA, { save: 42 }));
  assert.equal(wrongType.status, 400);
  // 拒否された後も元のセーブは無事
  const stillThere = await (await route.GET(apiRequest("GET", cookieA))).json();
  assert.equal(stillThere.save, saveJson);
});
