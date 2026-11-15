// AGO WORLD BOX v2.2 の検証:
// - 本物の光（空光＋松明光、昼夜連動、地下は昼でも暗い）
// - 敵の出現は「暗さ」で決まる（昼の洞窟・夜の地表、松明の範囲内は安全）
// - 松明のクラフト/設置/回収とセーブ往復（v2 形式のまま互換）
// - 洞窟生成（地表は無傷、決定性）と固定シード WORLD_SEED
// - 掘りのヒビ段階
// - 透過（one-way）ブロック: 横・下の通過、上面着地、すり抜け、敵・落下ブロックの着地
// - 作業台（クラフト/設置/回収/タップ導線）
// - 他作品名（Minecraft / マイクラ）をユーザー向け文字列に入れない固定チェック
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
    "AIR", "GRASS", "DIRT", "STONE", "WOOD", "LEAVES", "SAND", "COAL_ORE", "COPPER_ORE", "BEDROCK", "TORCH", "WORKBENCH",
    "isSolidBlock", "isOneWayBlock", "isFullSolidBlock",
    "WORLD_W", "WORLD_H", "WORLD_SEED", "generateWorld", "getTile", "setTile", "findSpawn", "makeRng",
    "SLOT_COUNT", "createInventory", "countOf", "addItem", "removeItem", "canAdd",
    "createBody", "stepPlayer", "bodyCollides", "PLAYER_H", "PLAYER_W", "DROP_THROUGH_SEC",
    "digTile", "placeTile", "placeTorch", "pressModeFor", "crackStage", "CRACK_STAGES",
    "advancePhase", "nightAmount", "isNightPhase",
    "buildLightField", "lightLevelAt", "isDarkAt", "isSkyExposed", "skyLevelAt", "SPAWN_DARK_THRESHOLD", "TORCH_RADIUS",
    "ENEMY_MAX_HP", "MAX_ENEMIES", "createEnemy", "trySpawnEnemy", "stepEnemy", "burnEnemiesAtDawn", "ENEMY_H",
    "RECIPES", "recipeById", "checkCraft", "applyCraft",
    "settleAfterChange", "stepFalling",
    "serializeSave", "parseSave", "encodeTiles", "SAVE_VERSION",
    "digSecondsFor",
  ],
);

const clientSrc = fs.readFileSync(path.join(rootDir, "app", "games", "worldbox", "WorldBoxClient.tsx"), "utf8");
const catalogSrc = fs.readFileSync(path.join(libDir, "games-catalog.ts"), "utf8");

const NOON = 0.5;
const MIDNIGHT = 0.0;

/** 平らな実験ワールド（y=30 から下が全部石、地表は y=30）。 */
function flatWorld() {
  const world = wb.generateWorld(3);
  for (let x = 0; x < wb.WORLD_W; x++) {
    world.surfaces[x] = 30;
    for (let y = 0; y < wb.WORLD_H; y++) {
      wb.setTile(world, x, y, y < 30 ? wb.AIR : wb.STONE);
    }
  }
  return world;
}

// ---------- 光 ----------

test("光: 昼の地表は明るく、夜は空光が下がって出現できる暗さになる", () => {
  const world = wb.generateWorld(42);
  const field = wb.buildLightField(world);
  // 木の天蓋に覆われていない列を探す（天蓋の下は正しく陰になる）
  let col = -1;
  for (let x = 8; x < wb.WORLD_W - 8; x++) {
    const surf = world.surfaces[x];
    let open = wb.getTile(world, x, surf) === wb.GRASS;
    for (let dy = 1; dy <= 8 && open; dy++) open = wb.getTile(world, x, surf - dy) === wb.AIR;
    if (open) { col = x; break; }
  }
  assert.ok(col > 0, "開けた列が見つからない");
  const surf = world.surfaces[col];
  assert.ok(wb.lightLevelAt(field, world, col, surf, NOON) >= 0.9, "昼の地表タイルが暗い");
  assert.ok(wb.lightLevelAt(field, world, col, surf - 2, NOON) >= 0.9, "昼の地表上が暗い");
  assert.ok(wb.skyLevelAt(MIDNIGHT) < wb.skyLevelAt(NOON), "夜に空光が下がらない");
  const night = wb.lightLevelAt(field, world, col, surf, MIDNIGHT);
  assert.ok(night < wb.SPAWN_DARK_THRESHOLD, `真夜中の地表が出現しきい値より明るい ${night}`);
  assert.ok(!wb.isDarkAt(field, world, col, surf, NOON), "昼の地表が暗い扱い");
  assert.ok(wb.isDarkAt(field, world, col, surf, MIDNIGHT), "真夜中の地表が暗い扱いにならない");
});

test("光: 深い場所は昼でも暗く、密閉した洞窟は縦穴でつながる浅い部屋より暗い", () => {
  const world = wb.generateWorld(42);
  const field = wb.buildLightField(world);
  // 深い岩盤の中（y=56）は昼でもほぼ真っ暗
  assert.ok(wb.lightLevelAt(field, world, 30, 56, NOON) < 0.1, "深部が暗くない");
  const cx = 100;
  const surf = world.surfaces[cx];
  // 浅い部屋: 縦穴で地表とつなぐ（光が入る）
  for (let y = surf - 6; y <= surf + 9; y++) wb.setTile(world, cx, y, wb.AIR);
  for (let dy = 7; dy <= 9; dy++) for (let dx = -1; dx <= 1; dx++) wb.setTile(world, cx + dx, surf + dy, wb.AIR);
  // 深い部屋: 密閉（光が入らない）
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) wb.setTile(world, cx + dx, 54 + dy, wb.AIR);
  const f2 = wb.buildLightField(world);
  const shallow = wb.lightLevelAt(f2, world, cx, surf + 8, NOON);
  const deep = wb.lightLevelAt(f2, world, cx, 54, NOON);
  assert.ok(shallow > 0.4, `縦穴の部屋が明るくない ${shallow}`);
  assert.ok(deep < wb.SPAWN_DARK_THRESHOLD, `深い洞窟が明るすぎる ${deep}`);
  assert.ok(deep < shallow, `深い洞窟(${deep})が浅い部屋(${shallow})より明るい`);
});

test("光: 松明は周囲を照らし、半径の外は暗さに戻る", () => {
  const world = flatWorld();
  // 閉じた小部屋（x 38..44, y 36..38、床 y=39）
  for (let x = 38; x <= 44; x++) for (let y = 36; y <= 38; y++) wb.setTile(world, x, y, wb.AIR);
  const dark = wb.buildLightField(world);
  assert.ok(wb.isDarkAt(dark, world, 41, 37, NOON), "松明なしの小部屋が暗くない");
  wb.setTile(world, 41, 37, wb.TORCH);
  const lit = wb.buildLightField(world);
  assert.ok(wb.lightLevelAt(lit, world, 41, 37, NOON) >= 0.8, "松明の中心が明るくない");
  const near = wb.lightLevelAt(lit, world, 44, 37, NOON);
  assert.ok(near >= 0.3, `松明から3タイルが暗すぎる ${near}`);
  assert.ok(!wb.isDarkAt(lit, world, 41, 38, MIDNIGHT), "松明の足元が夜に暗い扱いになる");
  const far = wb.lightLevelAt(lit, world, 41 + wb.TORCH_RADIUS + 3, 37, NOON);
  assert.ok(far < wb.SPAWN_DARK_THRESHOLD, `松明の半径外まで明るい ${far}`);
});

// ---------- 出現（暗さベース） ----------

test("出現: 昼でも暗い洞窟には出て、松明で照らした部屋には出ない", () => {
  const world = flatWorld();
  for (let x = 38; x <= 44; x++) for (let y = 36; y <= 38; y++) wb.setTile(world, x, y, wb.AIR);
  const player = { x: 30.1, y: 30 - wb.PLAYER_H };
  const inRoom = (e) => Math.floor(e.x) >= 38 && Math.floor(e.x) <= 44 && Math.floor(e.y) >= 35 && Math.floor(e.y) <= 39;

  // 昼・無灯: 洞窟内にスポーンする個体がいる（地表は明るいので出ない）
  const field = wb.buildLightField(world);
  let caveSpawn = null;
  for (let s = 1; s <= 60 && !caveSpawn; s++) {
    const e = wb.trySpawnEnemy(world, field, NOON, player, 0, wb.makeRng(s));
    if (e && inRoom(e)) caveSpawn = e;
    else if (e) assert.fail(`昼に洞窟外（明るい場所）へスポーンした x=${e.x} y=${e.y}`);
  }
  assert.ok(caveSpawn, "昼の洞窟にスポーンしない");

  // 部屋を松明で照らすと、その部屋には出なくなる
  wb.setTile(world, 41, 37, wb.TORCH);
  const litField = wb.buildLightField(world);
  for (let s = 1; s <= 60; s++) {
    const e = wb.trySpawnEnemy(world, litField, NOON, player, 0, wb.makeRng(1000 + s));
    assert.ok(!e || !inRoom(e), "松明で照らした部屋にスポーンした");
  }

  // 洞窟なしの平地では昼は一切出ず、夜は地表に出る
  const plain = flatWorld();
  const plainField = wb.buildLightField(plain);
  for (let s = 1; s <= 20; s++) {
    assert.equal(wb.trySpawnEnemy(plain, plainField, NOON, player, 0, wb.makeRng(s)), null, "昼の平地にスポーンした");
  }
  let nightSpawn = null;
  for (let s = 1; s <= 20 && !nightSpawn; s++) {
    nightSpawn = wb.trySpawnEnemy(plain, plainField, MIDNIGHT, player, 0, wb.makeRng(500 + s));
  }
  assert.ok(nightSpawn, "夜の地表にスポーンしない");
});

test("出現: 洞窟の敵は昼でも燃えず、地表の敵は燃える", () => {
  const world = flatWorld();
  for (let x = 38; x <= 44; x++) for (let y = 36; y <= 38; y++) wb.setTile(world, x, y, wb.AIR);
  const field = wb.buildLightField(world);
  const caveEnemy = wb.createEnemy(41, 38 - 0.9 + 1 - wb.ENEMY_H + 0.9); // 部屋の中
  caveEnemy.y = 39 - wb.ENEMY_H;
  assert.deepEqual(wb.burnEnemiesAtDawn(world, field, [caveEnemy], NOON, 1), []);
  assert.equal(caveEnemy.hp, wb.ENEMY_MAX_HP, "洞窟の敵が燃えている");
  const surfEnemy = wb.createEnemy(20, 30 - wb.ENEMY_H);
  let dead = [];
  for (let i = 0; i < 10 && dead.length === 0; i++) dead = wb.burnEnemiesAtDawn(world, field, [surfEnemy], NOON, 0.5);
  assert.deepEqual(dead, [surfEnemy.id], "地表の敵が燃え尽きない");
});

// ---------- 松明 ----------

test("松明: クラフト（石炭鉱石1＋原木1→4つ）→設置→掘って回収、の往復", () => {
  const recipe = wb.recipeById("torch");
  assert.ok(recipe, "松明レシピがない");
  assert.equal(recipe.output, wb.TORCH);
  assert.equal(recipe.outputCount, 4);
  const inv = wb.createInventory();
  wb.addItem(inv, wb.COAL_ORE, 1);
  wb.addItem(inv, wb.WOOD, 1);
  assert.equal(wb.checkCraft(inv, recipe), "ok");
  assert.equal(wb.applyCraft(inv, recipe), true);
  assert.equal(wb.countOf(inv, wb.TORCH), 4, "松明が4つ得られていない");
  assert.equal(wb.countOf(inv, wb.COAL_ORE), 0);
  assert.equal(wb.countOf(inv, wb.WOOD), 0);
  // 繰り返し作れる（道具のような「所持済み」止めにならない）
  wb.addItem(inv, wb.COAL_ORE, 1);
  wb.addItem(inv, wb.WOOD, 1);
  assert.equal(wb.checkCraft(inv, recipe), "ok");
  assert.equal(wb.applyCraft(inv, recipe), true);
  assert.equal(wb.countOf(inv, wb.TORCH), 8);

  // 設置: 空セルに置ける。占有セルには置けない。自分の体と重なるセルにも置ける
  const world = flatWorld();
  assert.equal(wb.placeTorch(world, inv, 50, 20), true);
  assert.equal(wb.getTile(world, 50, 20), wb.TORCH);
  assert.equal(wb.countOf(inv, wb.TORCH), 7);
  assert.equal(wb.placeTorch(world, inv, 50, 20), false, "占有セルに置けた");
  const body = wb.createBody(60.1, 28.2);
  assert.equal(wb.placeTorch(world, inv, 60, 29), true, "体のセルに置けない");
  // 掘り戻し: ほぼ一瞬で掘れて、そのまま回収できる
  assert.ok(wb.digSecondsFor(wb.TORCH, 20, 0) <= 0.1, "松明の掘りが速くない");
  const before = wb.countOf(inv, wb.TORCH);
  assert.equal(wb.digTile(world, inv, 50, 20), wb.TORCH);
  assert.equal(wb.getTile(world, 50, 20), wb.AIR);
  assert.equal(wb.countOf(inv, wb.TORCH), before + 1, "掘った松明が戻っていない");
});

test("松明・作業台: 所持品は v3 セーブで往復し、置いたタイルはセーブに含まれない", () => {
  assert.equal(wb.SAVE_VERSION, 3, "セーブ形式は v3（プレイヤー状態のみ）");
  const inv = wb.createInventory();
  wb.addItem(inv, wb.TORCH, 5);
  wb.addItem(inv, wb.WORKBENCH, 2);
  const state = { inventory: inv, player: { x: 10, y: 20 }, hp: 10 };
  const json = wb.serializeSave(state);
  assert.ok(!json.includes("tilesB64"), "v3 セーブにタイルが含まれている");
  const back = wb.parseSave(json);
  assert.ok(back, "保存した状態が読み戻せない");
  assert.equal(wb.countOf(back.inventory, wb.TORCH), 5);
  assert.equal(wb.countOf(back.inventory, wb.WORKBENCH), 2);
  // v2 セーブ（タイル付き）もプレイヤー状態だけ移行して読める
  const world = flatWorld();
  wb.setTile(world, 50, 20, wb.TORCH);
  const v2json = JSON.stringify({
    version: 2,
    seed: world.seed,
    tilesB64: wb.encodeTiles(world.tiles),
    slots: inv.slots,
    player: { x: 10, y: 20 },
    hp: 7,
    dayPhase: 0.3,
  });
  const migrated = wb.parseSave(v2json);
  assert.ok(migrated, "v2 セーブが読めない");
  assert.equal(wb.countOf(migrated.inventory, wb.TORCH), 5);
  assert.equal(migrated.hp, 7);
  assert.equal(migrated.tiles, undefined, "v2 のタイルが移行で残ってしまった");
});

// ---------- 洞窟・固定シード ----------

test("洞窟: 石の層に埋まった空洞があり、地表と最下行は無傷で、決定的", () => {
  for (const seed of [1, 42, 777, wb.WORLD_SEED]) {
    const world = wb.generateWorld(seed);
    let buriedAir = 0;
    for (let x = 0; x < wb.WORLD_W; x++) {
      const surf = world.surfaces[x];
      const top = wb.getTile(world, x, surf);
      assert.ok(top === wb.GRASS || top === wb.SAND, `seed=${seed} x=${x} 地表が草/砂でない ${top}`);
      assert.equal(wb.getTile(world, x, wb.WORLD_H - 1), wb.BEDROCK, "最下行が岩盤でない");
      for (let y = surf + 6; y < wb.WORLD_H - 1; y++) {
        if (wb.getTile(world, x, y) === wb.AIR) buriedAir++;
      }
    }
    assert.ok(buriedAir > 400, `seed=${seed} 洞窟が少なすぎる buriedAir=${buriedAir}`);
  }
  const a = wb.generateWorld(wb.WORLD_SEED);
  const b = wb.generateWorld(wb.WORLD_SEED);
  assert.deepEqual(a.tiles, b.tiles, "固定シードの生成が決定的でない");
});

test("固定シード: WORLD_SEED が一元化され、クライアントにランダムシード生成が残っていない", () => {
  assert.equal(typeof wb.WORLD_SEED, "number");
  assert.ok(clientSrc.includes("WORLD_SEED"), "クライアントが WORLD_SEED を使っていない");
  assert.ok(clientSrc.includes("generateWorld(WORLD_SEED)"), "新規ワールドが固定シードで生成されていない");
  assert.ok(!clientSrc.includes("2 ** 31"), "ランダムシード生成の経路が残っている");
});

// ---------- ヒビ段階 ----------

test("ヒビ: 進捗から段階への写像（0→なし、以降4段階）", () => {
  assert.equal(wb.CRACK_STAGES, 4);
  assert.equal(wb.crackStage(0), 0);
  assert.equal(wb.crackStage(-1), 0);
  assert.equal(wb.crackStage(Number.NaN), 0);
  assert.equal(wb.crackStage(0.01), 1);
  assert.equal(wb.crackStage(0.25), 1);
  assert.equal(wb.crackStage(0.26), 2);
  assert.equal(wb.crackStage(0.5), 2);
  assert.equal(wb.crackStage(0.51), 3);
  assert.equal(wb.crackStage(0.75), 3);
  assert.equal(wb.crackStage(0.76), 4);
  assert.equal(wb.crackStage(1), 4);
});

// ---------- 透過（one-way） ----------

const IDLE = { left: false, right: false, jump: false, fastFall: false };

/** 床（上面 y=floorTop）だけの実験場。 */
function arenaWorld(floorTop) {
  const world = wb.generateWorld(3);
  for (let x = 0; x < wb.WORLD_W; x++) {
    world.surfaces[x] = floorTop;
    for (let y = 0; y < wb.WORLD_H; y++) wb.setTile(world, x, y, y < floorTop ? wb.AIR : wb.STONE);
  }
  return world;
}

test("one-way: 原木と葉は one-way で、全面固体ではない", () => {
  assert.equal(wb.isOneWayBlock(wb.WOOD), true);
  assert.equal(wb.isOneWayBlock(wb.LEAVES), true);
  assert.equal(wb.isOneWayBlock(wb.WORKBENCH), true);
  assert.equal(wb.isOneWayBlock(wb.STONE), false);
  assert.equal(wb.isFullSolidBlock(wb.WOOD), false);
  assert.equal(wb.isFullSolidBlock(wb.STONE), true);
  assert.equal(wb.isSolidBlock(wb.TORCH), false, "松明が固体になっている");
});

test("one-way: 横からは原木を通り抜け、石の壁にはぶつかる", () => {
  for (const [block, passes] of [[wb.WOOD, true], [wb.STONE, false]]) {
    const world = arenaWorld(40);
    wb.setTile(world, 12, 39, block);
    wb.setTile(world, 12, 38, block);
    const body = wb.createBody(8.1, 40 - wb.PLAYER_H);
    for (let i = 0; i < 240; i++) wb.stepPlayer(world, body, { ...IDLE, right: true }, 1 / 60);
    if (passes) assert.ok(body.x > 13, `原木を横から通り抜けられない x=${body.x}`);
    else assert.ok(body.x + wb.PLAYER_W <= 12.01, `石の壁を通り抜けた x=${body.x}`);
  }
});

test("one-way: 下から跳び上がって葉の上に乗れる", () => {
  const world = arenaWorld(42);
  for (let x = 8; x <= 16; x++) wb.setTile(world, x, 40, wb.LEAVES);
  const body = wb.createBody(12.1, 42 - wb.PLAYER_H);
  for (let i = 0; i < 30; i++) wb.stepPlayer(world, body, IDLE, 1 / 60);
  assert.ok(body.onGround, "床に立っていない");
  wb.stepPlayer(world, body, { ...IDLE, jump: true }, 1 / 60);
  for (let i = 0; i < 240; i++) wb.stepPlayer(world, body, IDLE, 1 / 60);
  assert.ok(body.onGround, "葉の上に着地していない");
  assert.ok(Math.abs(body.y + wb.PLAYER_H - 40) < 0.05, `足元が葉の上面にない bottom=${body.y + wb.PLAYER_H}`);
});

test("one-way: 上に立って下入力するとすり抜けて下の床まで落ちる", () => {
  const world = arenaWorld(44);
  for (let x = 8; x <= 16; x++) wb.setTile(world, x, 40, wb.LEAVES);
  const body = wb.createBody(12.1, 40 - wb.PLAYER_H);
  for (let i = 0; i < 60; i++) wb.stepPlayer(world, body, IDLE, 1 / 60);
  assert.ok(body.onGround && Math.abs(body.y + wb.PLAYER_H - 40) < 0.05, "葉の上に立っていない");
  for (let i = 0; i < 240; i++) wb.stepPlayer(world, body, { ...IDLE, fastFall: true, dropThrough: true }, 1 / 60);
  assert.ok(body.onGround, "下の床に着地していない");
  assert.ok(Math.abs(body.y + wb.PLAYER_H - 44) < 0.05, `床まで落ちていない bottom=${body.y + wb.PLAYER_H}`);
});

test("one-way: 敵は葉の上に着地し、落下ブロックは原木の上に止まる", () => {
  const world = arenaWorld(44);
  for (let x = 4; x <= 24; x++) wb.setTile(world, x, 40, wb.LEAVES);
  const e = wb.createEnemy(12.05, 36);
  // 目標は天蓋の中央（敵は中心へ歩き続けるが天蓋の上からは落ちない）
  for (let i = 0; i < 240; i++) wb.stepEnemy(world, e, 12.5, 1 / 60);
  assert.ok(e.onGround, "敵が葉の上に着地していない");
  assert.ok(Math.abs(e.y + wb.ENEMY_H - 40) < 0.05, `敵の足元が葉の上面にない bottom=${e.y + wb.ENEMY_H}`);

  const world2 = arenaWorld(44);
  wb.setTile(world2, 20, 40, wb.WOOD);
  const falling = [{ blockId: wb.DIRT, x: 20, y: 36, vy: 0 }];
  for (let i = 0; i < 600 && falling.length > 0; i++) wb.stepFalling(world2, falling, 1 / 60);
  assert.equal(falling.length, 0, "落下ブロックが着地していない");
  assert.equal(wb.getTile(world2, 20, 39), wb.DIRT, "原木の上に土が止まっていない");
});

// ---------- 作業台 ----------

test("作業台: 原木4つで作り、置いて、掘って回収できる（複数作れる）", () => {
  const recipe = wb.recipeById("workbench");
  assert.ok(recipe, "作業台レシピがない");
  assert.deepEqual(recipe.costs, [{ id: wb.WOOD, count: 4 }]);
  const inv = wb.createInventory();
  wb.addItem(inv, wb.WOOD, 9);
  assert.equal(wb.checkCraft(inv, recipe), "ok");
  assert.equal(wb.applyCraft(inv, recipe), true);
  assert.equal(wb.countOf(inv, wb.WORKBENCH), 1);
  assert.equal(wb.checkCraft(inv, recipe), "ok", "2つ目が作れない（所持済み止めになっている）");
  assert.equal(wb.applyCraft(inv, recipe), true);
  assert.equal(wb.countOf(inv, wb.WORKBENCH), 2);

  const world = flatWorld();
  assert.equal(wb.placeTile(world, inv, 50, 29, wb.WORKBENCH), true);
  assert.equal(wb.getTile(world, 50, 29), wb.WORKBENCH);
  assert.equal(wb.countOf(inv, wb.WORKBENCH), 1);
  assert.equal(wb.digTile(world, inv, 50, 29), wb.WORKBENCH, "掘って回収できない");
  assert.equal(wb.countOf(inv, wb.WORKBENCH), 2);
});

test("作業台: クライアントにタップで「つくる」を開く導線がある", () => {
  assert.ok(clientSrc.includes("WORKBENCH"), "クライアントが作業台を扱っていない");
  assert.ok(clientSrc.includes("benchTapRef"), "作業台タップ判定がない");
  assert.ok(clientSrc.includes("setCraftOpen(true)"), "タップでクラフトが開かない");
  assert.ok(clientSrc.includes("placeTorch"), "クライアントが松明の設置を使っていない");
  assert.ok(clientSrc.includes("buildLightField"), "クライアントが光フィールドを使っていない");
});

// ---------- プレスのモード固定（ラッチ） ----------

test("ラッチ: プレス開始時点の対象でモードが決まる", () => {
  // ブロック上で押し始めたら採掘モード（設置できる物を持っていても）
  assert.equal(wb.pressModeFor(wb.STONE, true, false), "dig");
  assert.equal(wb.pressModeFor(wb.TORCH, true, false), "dig");
  assert.equal(wb.pressModeFor(wb.WORKBENCH, false, false), "dig");
  // 空白から押し始めて設置できる物を持っていたら設置モード
  assert.equal(wb.pressModeFor(wb.AIR, true, false), "place");
  // 空白でも設置できる物がなければ無効、掘れない岩盤も無効
  assert.equal(wb.pressModeFor(wb.AIR, false, false), null);
  assert.equal(wb.pressModeFor(wb.BEDROCK, true, false), null);
  // 敵がいる場所は採掘（攻撃）モード優先
  assert.equal(wb.pressModeFor(wb.AIR, true, true), "dig");
});

test("ラッチ: クライアントはモードを固定し、設置は軌跡補間で続く", () => {
  assert.ok(clientSrc.includes("pressModeRef"), "プレスのモード固定がない");
  assert.ok(clientSrc.includes("pressModeFor("), "押し始めの対象でモードを決めていない");
  assert.ok(clientSrc.includes('pressModeRef.current === "dig"'), "採掘がモードで絞られていない");
  assert.ok(clientSrc.includes('pressModeRef.current === "place"'), "設置がモードで絞られていない");
  assert.ok(clientSrc.includes("lastPlaceRef"), "設置の軌跡補間がない");
  assert.ok(clientSrc.includes("touchRef.current.place"), "タッチの置く長押しがラッチ原則に合っていない");
});

// ---------- タイル描画の隙間対策 ----------

test("描画: タイルはピクセルスナップ＋1px重ねでシームレスに描く", () => {
  assert.ok(clientSrc.includes("Math.round((tx - camX) * tilePx)"), "タイル位置のピクセルスナップがない");
  assert.ok(clientSrc.includes("tilePx + 1"), "タイルの1px重ね描きがない");
});

// ---------- 他作品名の混入禁止 ----------

test("命名: クライアントとカタログの文字列に他作品名（Minecraft / マイクラ）が含まれない", () => {
  for (const [name, src] of [["クライアント", clientSrc], ["カタログ", catalogSrc]]) {
    assert.ok(!src.includes("Minecraft"), `${name}に Minecraft が混入している`);
    assert.ok(!src.includes("マイクラ"), `${name}に マイクラ が混入している`);
  }
});
