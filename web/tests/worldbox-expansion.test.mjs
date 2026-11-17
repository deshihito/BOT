// AGO WORLD BOX 拡充（物量・特殊オブジェクト・マップロジック）の検証:
// - アイテムカタログ 250種以上（ブロック60種以上・作物20種以上・道具4種×4段）、
//   レシピ/作物の参照整合、アイコン実在
// - バイオーム分類（生成地形との一致・雪原・水域）
// - チャンク座標系（往復・負座標）とスーパーセル方式の構造物配置
// - 決定的ランダムスポーン
// - 特殊オブジェクト（定義整合・決定的配置・ルート・再出現）
// - モブ（定義整合・時間帯/バイオームで決まる決定的出現・サイズ規定 1〜20 マス）
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

const cat = await loadBundle(
  ["worldbox/items.ts"],
  ["ITEMS", "RECIPES", "CROPS", "ITEM_ICON_IDS", "itemById", "itemsWithTool", "cropBySeedId"],
);
const ml = await loadBundle(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/maplogic.ts"],
  [
    "BIOMES", "biomeById", "biomeAt", "classifyBiome", "elevationAt", "moistureAt",
    "isSnowZone", "CHUNK_SIZE", "chunkOf", "chunkKey", "parseChunkKey",
    "chunkLocal", "STRUCTURES", "structureById", "structuresForChunk",
    "generateMap", "mapTileAt", "T_GRASS", "T_WATER", "T_SNOW", "MAP_SEED",
  ],
);
const ob = await loadBundle(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/maplogic.ts", "worldbox/items.ts", "worldbox/objects.ts", "worldbox/mobs.ts"],
  [
    "SPECIAL_OBJECTS", "specialObjectById", "validateSpecialObjects", "objectsForChunk",
    "rollObjectLoot", "lootForObjectAt", "objectRespawned", "makeRng",
    "MOBS", "mobById", "validateMobs", "mobsForChunk",
    "MOB_SIZE_MIN", "MOB_SIZE_MAX", "LARGE_MOB_SIZE", "MOB_SIZE_CLASSES", "mobSizeClass",
    "mobFootprintBounds", "mobOccupiesTile", "largeMobsForChunk",
  ],
);

// ---------------------------------------------------------------- カタログ
test("カタログ: 250種以上・ID一意・価格と説明が揃う", () => {
  assert.ok(cat.ITEMS.length >= 250, `items=${cat.ITEMS.length}`);
  const ids = new Set(cat.ITEMS.map((i) => i.id));
  assert.equal(ids.size, cat.ITEMS.length);
  for (const item of cat.ITEMS) {
    assert.ok(item.price > 0, item.id);
    assert.ok(item.name.length > 0 && item.desc.length > 0, item.id);
  }
});

test("カタログ: ブロック60種以上（全て耐久つき）・作物20種以上", () => {
  const blocks = cat.ITEMS.filter((i) => i.category === "block");
  assert.ok(blocks.length >= 60, `blocks=${blocks.length}`);
  for (const b of blocks) assert.ok(typeof b.durability === "number" && b.durability > 0, b.id);
  const bedrock = cat.itemById("bedrock_block");
  assert.ok(bedrock.durability >= Math.max(...blocks.map((b) => b.durability)));
  assert.ok(cat.CROPS.length >= 20, `crops=${cat.CROPS.length}`);
});

test("カタログ: 道具は4種×4段（木/石/鉄/ミスリル）", () => {
  for (const kind of ["axe", "pickaxe", "sword", "hoe"]) {
    const tools = cat.itemsWithTool(kind);
    assert.deepEqual(tools.map((t) => t.tier), [1, 2, 3, 4], kind);
  }
});

test("カタログ: レシピと作物の参照が全て実在アイテムを指す", () => {
  const recipeIds = new Set();
  for (const r of cat.RECIPES) {
    assert.ok(!recipeIds.has(r.id), `dup recipe ${r.id}`);
    recipeIds.add(r.id);
    assert.ok(cat.itemById(r.output), `recipe ${r.id} output`);
    assert.ok(r.outputCount >= 1);
    for (const input of Object.keys(r.inputs)) assert.ok(cat.itemById(input), `recipe ${r.id} input ${input}`);
    if (r.rareItem) assert.ok(cat.itemById(r.rareItem), `recipe ${r.id} rare`);
  }
  assert.ok(cat.RECIPES.length >= 100, `recipes=${cat.RECIPES.length}`);
  for (const crop of cat.CROPS) {
    assert.ok(cat.itemById(crop.seedId), `crop ${crop.id} seed`);
    assert.ok(cat.itemById(crop.produceId), `crop ${crop.id} produce`);
    assert.equal(cat.cropBySeedId(crop.seedId)?.id, crop.id);
  }
});

test("カタログ: 施設（作業台・鍛冶台・かまど）は facility で置ける", () => {
  for (const id of ["workbench", "smithing_table", "furnace", "anvil", "storage_chest", "torch", "campfire", "well"]) {
    const def = cat.itemById(id);
    assert.ok(def && def.facility === true, id);
  }
});

test("カタログ: アイコン ID は全て実在し PNG が置かれている", () => {
  assert.ok(cat.ITEM_ICON_IDS.length >= 220, `icons=${cat.ITEM_ICON_IDS.length}`);
  const dir = path.join(rootDir, "public", "img", "worldbox", "items");
  for (const id of cat.ITEM_ICON_IDS) {
    assert.ok(cat.itemById(id), `icon for unknown item ${id}`);
    assert.ok(fs.existsSync(path.join(dir, `${id}.png`)), `missing icon file ${id}`);
  }
});

// ---------------------------------------------------------------- バイオーム
test("バイオーム: 分類の基本形（水=湖・砂=浜・岩=岩場・雪）", () => {
  assert.equal(ml.classifyBiome(0.2, 0.5, false, ml.T_WATER), "lake");
  assert.equal(ml.classifyBiome(0.9, 0.5, false, 4), "highland"); // T_ROCK
  assert.equal(ml.classifyBiome(0.5, 0.5, true, ml.T_SNOW), "snowfield");
  assert.equal(ml.classifyBiome(0.5, 0.9, false, 3), "dense_forest"); // T_TREE + 高湿度
  assert.equal(ml.classifyBiome(0.5, 0.2, false, 0), "dryland");
});

test("バイオーム: 座標関数は決定的で、標高/湿度は [0,1]", () => {
  for (const [x, y] of [[0, 0], [512, 512], [100, 900], [1023, 40]]) {
    assert.equal(ml.biomeAt(ml.MAP_SEED, x, y), ml.biomeAt(ml.MAP_SEED, x, y));
    const e = ml.elevationAt(ml.MAP_SEED, x, y);
    const m = ml.moistureAt(ml.MAP_SEED, x, y);
    assert.ok(e >= 0 && e <= 1 && m >= 0 && m <= 1, `${x},${y}`);
  }
});

test("バイオーム: 生成マップと一致する（水タイルは湖、北の雪タイルは雪系）", () => {
  const map = ml.generateMap();
  let water = 0;
  let snow = 0;
  for (let y = 0; y < map.height; y += 7) {
    for (let x = 0; x < map.width; x += 7) {
      const tile = ml.mapTileAt(map, x, y);
      const biome = ml.biomeAt(map.seed, x, y, tile);
      assert.ok(ml.biomeById(biome), `${x},${y} -> ${biome}`);
      if (tile === ml.T_WATER) { assert.equal(biome, "lake"); water++; }
      if (tile === ml.T_SNOW) { assert.ok(["snowfield", "highland", "lake", "beach"].includes(biome), `${x},${y} ${biome}`); snow++; }
    }
  }
  assert.ok(water > 50 && snow > 50, `water=${water} snow=${snow}`);
  for (const b of ml.BIOMES) {
    for (const r of b.resources) assert.ok(cat.itemById(r), `biome ${b.id} resource ${r}`);
  }
});

// ---------------------------------------------------------------- チャンク/構造物
test("チャンク: 座標の往復（負座標含む）", () => {
  for (const [x, y] of [[0, 0], [31, 31], [32, 0], [-1, -1], [-33, 65], [1023, 1023]]) {
    const { cx, cy } = ml.chunkOf(x, y);
    const { lx, ly } = ml.chunkLocal(x, y);
    assert.equal(cx * ml.CHUNK_SIZE + lx, x);
    assert.equal(cy * ml.CHUNK_SIZE + ly, y);
    assert.ok(lx >= 0 && lx < ml.CHUNK_SIZE && ly >= 0 && ly < ml.CHUNK_SIZE);
    assert.deepEqual(ml.parseChunkKey(ml.chunkKey(cx, cy)), { cx, cy });
  }
  assert.equal(ml.parseChunkKey("a,b"), null);
});

test("構造物: 決定的・チャンク内・バイオーム一致・セル内に同種は最大1つ", () => {
  const seenCells = new Map();
  let found = 0;
  for (let cy = 0; cy < 30; cy++) {
    for (let cx = 0; cx < 30; cx++) {
      const a = ml.structuresForChunk(ml.MAP_SEED, cx, cy);
      assert.deepEqual(a, ml.structuresForChunk(ml.MAP_SEED, cx, cy));
      assert.ok(a.length <= 1);
      for (const s of a) {
        found++;
        const def = ml.structureById(s.structureId);
        assert.ok(def.biomes.includes(s.biome), `${s.structureId} in ${s.biome}`);
        const { cx: scx, cy: scy } = ml.chunkOf(s.x, s.y);
        assert.equal(scx, cx);
        assert.equal(scy, cy);
        const cellKey = `${s.structureId}:${Math.floor(cx / def.cellChunks)},${Math.floor(cy / def.cellChunks)}`;
        assert.ok(!seenCells.has(cellKey), `same structure twice in a cell: ${cellKey}`);
        seenCells.set(cellKey, true);
      }
    }
  }
  assert.ok(found >= 5, `structures found=${found}`);
  const entrances = ml.STRUCTURES.filter((s) => s.kind === "entrance");
  assert.deepEqual(entrances.map((s) => s.targetSpace).sort(), ["cave", "dungeon", "ruins"]);
});

// ---------------------------------------------------------------- 特殊オブジェクト
test("特殊オブジェクト: 20種以上・定義整合（ルートは実在アイテム）", () => {
  assert.ok(ob.SPECIAL_OBJECTS.length >= 20, `objects=${ob.SPECIAL_OBJECTS.length}`);
  const ids = new Set(ob.SPECIAL_OBJECTS.map((o) => o.id));
  assert.equal(ids.size, ob.SPECIAL_OBJECTS.length);
  assert.deepEqual(ob.validateSpecialObjects(), []);
  for (const def of ob.SPECIAL_OBJECTS) {
    if (def.interaction === "enter") {
      assert.ok(def.targetSpace && def.density === 0, def.id);
    }
    if (def.interaction === "open") assert.ok(def.trapChance > 0, def.id);
  }
});

test("特殊オブジェクト: チャンク配置は決定的・バイオーム一致・重複なし", () => {
  let total = 0;
  for (let cy = 0; cy < 12; cy++) {
    for (let cx = 0; cx < 12; cx++) {
      const a = ob.objectsForChunk(ml.MAP_SEED, cx, cy);
      assert.deepEqual(a, ob.objectsForChunk(ml.MAP_SEED, cx, cy));
      const tiles = new Set(a.map((o) => `${o.x},${o.y}`));
      assert.equal(tiles.size, a.length);
      for (const placed of a) {
        total++;
        const def = ob.specialObjectById(placed.objectId);
        assert.ok(def.biomes.includes(placed.biome), `${placed.objectId} in ${placed.biome}`);
        assert.ok(def.density > 0, "entrances are placed by structures, not objects");
        const { cx: pcx, cy: pcy } = ml.chunkOf(placed.x, placed.y);
        assert.equal(pcx, cx);
        assert.equal(pcy, cy);
      }
    }
  }
  assert.ok(total >= 100, `placed objects=${total}`);
});

test("特殊オブジェクト: ルートは決定的で範囲内、再出現規則が効く", () => {
  const bush = ob.specialObjectById("berry_bush");
  const r1 = ob.rollObjectLoot(bush, ob.makeRng(42));
  const r2 = ob.rollObjectLoot(bush, ob.makeRng(42));
  assert.deepEqual(r1, r2);
  assert.ok(r1.gained.berry >= 1 && r1.gained.berry <= 3);
  assert.equal(r1.trapped, false);
  const at1 = ob.lootForObjectAt(ml.MAP_SEED, "berry_bush", 10, 20, 0);
  const at2 = ob.lootForObjectAt(ml.MAP_SEED, "berry_bush", 10, 20, 0);
  assert.deepEqual(at1, at2);
  assert.equal(ob.lootForObjectAt(ml.MAP_SEED, "nope", 0, 0, 0), null);
  assert.equal(ob.objectRespawned(bush, null, 1000), true);
  assert.equal(ob.objectRespawned(bush, 1000, 1000 + bush.respawnMs - 1), false);
  assert.equal(ob.objectRespawned(bush, 1000, 1000 + bush.respawnMs), true);
  const chest = ob.specialObjectById("ruins_chest");
  assert.equal(ob.objectRespawned(chest, 1000, Number.MAX_SAFE_INTEGER), false);
});

// ---------------------------------------------------------------- モブ
test("モブ: 48種・ドロップ整合・出現は時間帯とバイオームで決まる", () => {
  assert.equal(ob.MOBS.length, 48);
  assert.deepEqual(ob.validateMobs(), []);
  const day = ob.mobsForChunk(ml.MAP_SEED, 16, 16, false);
  const day2 = ob.mobsForChunk(ml.MAP_SEED, 16, 16, false);
  assert.deepEqual(day, day2);
  for (const placed of [...day, ...ob.mobsForChunk(ml.MAP_SEED, 16, 16, true)]) {
    const def = ob.mobById(placed.mobId);
    assert.ok(!def.instanceOnly, def.id);
    assert.ok(placed.size < ob.LARGE_MOB_SIZE, "density spawn excludes large mobs");
    assert.ok(def.biomes.includes(placed.biome), `${def.id} in ${placed.biome}`);
  }
  const nightIds = new Set();
  for (let c = 0; c < 40; c++) {
    for (const p of ob.mobsForChunk(ml.MAP_SEED, c, 20, true)) nightIds.add(p.mobId);
    for (const p of ob.mobsForChunk(ml.MAP_SEED, c, 20, false)) {
      assert.notEqual(ob.mobById(p.mobId).time, "night", "night-only mob in day chunk");
    }
  }
  const dungeonOnly = ob.MOBS.filter((m) => m.instanceOnly === "dungeon");
  assert.ok(dungeonOnly.length >= 2);
});

test("モブ: サイズは 1〜20 マスで規定され、全サイズ帯に実在する", () => {
  assert.equal(ob.MOB_SIZE_MIN, 1);
  assert.equal(ob.MOB_SIZE_MAX, 20);
  for (const def of ob.MOBS) {
    assert.ok(Number.isInteger(def.size) && def.size >= 1 && def.size <= 20, def.id);
    assert.ok(ob.mobSizeClass(def.size), def.id);
  }
  assert.equal(Math.max(...ob.MOBS.map((m) => m.size)), 20);
  for (const cls of ob.MOB_SIZE_CLASSES) {
    assert.ok(ob.MOBS.some((m) => ob.mobSizeClass(m.size) === cls.id), cls.id);
  }
  assert.equal(ob.mobSizeClass(1), "small");
  assert.equal(ob.mobSizeClass(3), "medium");
  assert.equal(ob.mobSizeClass(6), "large");
  assert.equal(ob.mobSizeClass(12), "huge");
  assert.equal(ob.mobSizeClass(20), "colossal");
  assert.equal(ob.mobSizeClass(0), null);
  assert.equal(ob.mobSizeClass(21), null);
});

test("モブ: 占有範囲は size×size で、アンカー中心", () => {
  assert.deepEqual(ob.mobFootprintBounds(1, 10, 10), { minX: 10, minY: 10, maxX: 10, maxY: 10 });
  const b20 = ob.mobFootprintBounds(20, 100, 100);
  assert.equal(b20.maxX - b20.minX + 1, 20);
  assert.equal(b20.maxY - b20.minY + 1, 20);
  assert.ok(ob.mobOccupiesTile(20, 100, 100, b20.minX, b20.maxY));
  assert.ok(!ob.mobOccupiesTile(20, 100, 100, b20.maxX + 1, 100));
  assert.ok(ob.mobOccupiesTile(2, 5, 5, 4, 4));
  assert.ok(!ob.mobOccupiesTile(2, 5, 5, 6, 5));
});

test("モブ: 大型はスーパーセル配置で決定的・同種はセルに最大1体", () => {
  let found = 0;
  for (let cx = 0; cx < 40; cx++) {
    for (let cy = 0; cy < 40; cy++) {
      const placed = ob.largeMobsForChunk(9, cx, cy, false);
      assert.deepEqual(placed, ob.largeMobsForChunk(9, cx, cy, false));
      assert.ok(placed.length <= 1);
      for (const p of placed) {
        const def = ob.mobById(p.mobId);
        assert.ok(def.size >= ob.LARGE_MOB_SIZE);
        assert.equal(def.instanceOnly, undefined);
        assert.ok(def.biomes.includes(p.biome));
        found++;
      }
    }
  }
  assert.ok(found > 0, "large mobs spawn somewhere");
  const cells = new Set();
  for (let cx = 0; cx < 80; cx++) {
    for (let cy = 0; cy < 80; cy++) {
      for (const p of ob.largeMobsForChunk(9, cx, cy, false)) {
        const def = ob.mobById(p.mobId);
        const cell = Math.floor(cx / (def.size * 2)) + "," + Math.floor(cy / (def.size * 2)) + "," + p.mobId;
        assert.ok(!cells.has(cell), cell);
        cells.add(cell);
      }
    }
  }
});
