// AGO WORLD BOX（lib/worldbox/*）の検証。games.test.mjs と同じ loadBundle 方式で
// TS を同梱して読み込む（worldgen → rules → physics → save の依存順）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const libDir = path.join(import.meta.dirname, "..", "lib");

function transpile(name) {
  const src = fs.readFileSync(path.join(libDir, name), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function stripModuleSyntax(code) {
  return code
    .split("\n")
    .filter((line) => !/^import\s/.test(line))
    .map((line) =>
      line
        .replace(/^export\s+(?=(const|let|var|function|class)\s)/, "")
        .replace(/^export\s+(?=async\s+function)/, "")
        .replace(/^export\s*\{[^}]*\};?\s*$/, ""),
    )
    .join("\n");
}

async function loadBundle(files, exportNames) {
  const code =
    files.map((name) => stripModuleSyntax(transpile(name))).join("\n") +
    `\nexport { ${exportNames.join(", ")} };\n`;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const wb = await loadBundle(
  ["worldbox/blocks.ts", "worldbox/worldgen.ts", "worldbox/rules.ts", "worldbox/physics.ts", "worldbox/save.ts"],
  [
    "AIR", "GRASS", "DIRT", "STONE", "WOOD", "LEAVES", "SAND", "COAL_ORE", "COPPER_ORE", "BEDROCK",
    "BLOCKS", "HOTBAR_BLOCKS", "canDigBlock",
    "WORLD_W", "WORLD_H", "generateWorld", "getTile", "findSpawn",
    "digTile", "placeTile", "withinReach",
    "createBody", "stepPlayer", "bodyCollides", "PLAYER_H", "PLAYER_W",
    "serializeSave", "parseSave",
  ],
);

const { WORLD_W, WORLD_H } = wb;

test("生成: 同じシードでは同一ワールド、違うシードでは異なる", () => {
  const a = wb.generateWorld(42);
  const b = wb.generateWorld(42);
  const c = wb.generateWorld(43);
  assert.deepEqual(Array.from(a.tiles), Array.from(b.tiles));
  assert.deepEqual(Array.from(a.surfaces), Array.from(b.surfaces));
  assert.notDeepEqual(Array.from(a.tiles), Array.from(c.tiles));
  assert.equal(a.width, WORLD_W);
  assert.equal(a.height, WORLD_H);
  assert.equal(a.tiles.length, WORLD_W * WORLD_H);
});

test("生成: 地表タイルは全列で草か砂、最下行は全面岩盤", () => {
  const world = wb.generateWorld(42);
  for (let x = 0; x < WORLD_W; x++) {
    const surf = world.surfaces[x];
    const top = wb.getTile(world, x, surf);
    assert.ok(top === wb.GRASS || top === wb.SAND, `x=${x}: 地表が草/砂でない (${top})`);
    // 地表の上は空気か木（幹・葉）だけ
    const above = wb.getTile(world, x, surf - 1);
    assert.ok(above === wb.AIR || above === wb.WOOD || above === wb.LEAVES, `x=${x}: 地表の上が想定外 (${above})`);
    assert.equal(wb.getTile(world, x, WORLD_H - 1), wb.BEDROCK, `x=${x}: 最下行が岩盤でない`);
  }
});

test("生成: 木が生えている（原木と葉が存在する）", () => {
  const world = wb.generateWorld(42);
  let wood = 0;
  let leaves = 0;
  for (const t of world.tiles) {
    if (t === wb.WOOD) wood++;
    if (t === wb.LEAVES) leaves++;
  }
  assert.ok(wood > 0, "原木が1つもない");
  assert.ok(leaves > wood, "葉が幹より少ない");
});

test("生成: 鉱石は石の層の中だけにあり、石炭と銅の両方が出る", () => {
  const world = wb.generateWorld(42);
  let coal = 0;
  let copper = 0;
  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      const id = wb.getTile(world, x, y);
      if (id !== wb.COAL_ORE && id !== wb.COPPER_ORE) continue;
      if (id === wb.COAL_ORE) coal++;
      else copper++;
      // 土の帯（地表+4まで）より下、最下行より上にあること
      assert.ok(y >= world.surfaces[x] + 4, `鉱石が浅すぎる x=${x} y=${y} surf=${world.surfaces[x]}`);
      assert.ok(y < WORLD_H - 1, "鉱石が岩盤行にある");
      // 周囲は石か鉱石（石の中に埋まっている）
      const neighbors = [
        wb.getTile(world, x + 1, y),
        wb.getTile(world, x - 1, y),
        wb.getTile(world, x, y + 1),
        wb.getTile(world, x, y - 1),
      ];
      assert.ok(
        neighbors.some((n) => n === wb.STONE || n === wb.COAL_ORE || n === wb.COPPER_ORE || n === wb.BEDROCK),
        `鉱石が石に接していない x=${x} y=${y}`,
      );
    }
  }
  assert.ok(coal > 0, "石炭鉱石が出ていない");
  assert.ok(copper > 0, "銅鉱石が出ていない");
});

test("掘る: 地表を掘ると所持品が増え、岩盤は掘れない", () => {
  const world = wb.generateWorld(7);
  const inv = {};
  const spawn = wb.findSpawn(world);
  const surf = world.surfaces[spawn.x];
  const got = wb.digTile(world, inv, spawn.x, surf);
  assert.ok(got === wb.GRASS || got === wb.SAND);
  assert.equal(inv[got], 1);
  assert.equal(wb.getTile(world, spawn.x, surf), wb.AIR);
  // 空気は掘れない
  assert.equal(wb.digTile(world, inv, spawn.x, surf), null);
  // 岩盤は掘れない
  assert.equal(wb.canDigBlock(wb.BEDROCK), false);
  assert.equal(wb.digTile(world, inv, 0, WORLD_H - 1), null);
  assert.equal(wb.getTile(world, 0, WORLD_H - 1), wb.BEDROCK);
});

test("置く: 占有セル・所持ゼロ・体と重なる場所には置けない", () => {
  const world = wb.generateWorld(7);
  const inv = {};
  const spawn = wb.findSpawn(world);
  const surf = world.surfaces[spawn.x];
  // 所持ゼロでは置けない
  assert.equal(wb.placeTile(world, inv, spawn.x, surf - 3, wb.DIRT), false);
  // 掘って1つ手に入れる
  const got = wb.digTile(world, inv, spawn.x, surf);
  assert.ok(got !== null);
  // 占有済み（隣の地表）には置けない
  assert.equal(wb.placeTile(world, inv, spawn.x + 1, world.surfaces[spawn.x + 1], got), false);
  assert.equal(inv[got], 1);
  // 体と重なる空セルには置けない
  const body = { x: spawn.x, y: surf - 3, w: wb.PLAYER_W, h: wb.PLAYER_H };
  assert.equal(wb.placeTile(world, inv, spawn.x, surf - 3, got, body), false);
  assert.equal(inv[got], 1);
  // 空いた元地表セルには置けて、所持が減る
  assert.equal(wb.placeTile(world, inv, spawn.x, surf, got), true);
  assert.equal(inv[got], 0);
  assert.equal(wb.getTile(world, spawn.x, surf), got);
});

test("範囲: withinReach は約4.5タイルまで", () => {
  assert.equal(wb.withinReach(10.5, 10.5, 14, 10), true);
  assert.equal(wb.withinReach(10.5, 10.5, 15, 10), false);
  assert.equal(wb.withinReach(10.5, 10.5, 10, 10), true);
});

test("物理: 落下して地面に立ち、地面にめり込まない", () => {
  const world = wb.generateWorld(7);
  const spawn = wb.findSpawn(world);
  const surf = world.surfaces[spawn.x];
  const body = wb.createBody(spawn.x + 0.1, surf - 8);
  const input = { left: false, right: false, jump: false, fastFall: false };
  for (let i = 0; i < 300; i++) wb.stepPlayer(world, body, input, 1 / 60);
  assert.equal(body.onGround, true, "着地していない");
  const bottom = body.y + wb.PLAYER_H;
  assert.ok(bottom <= surf + 0.01 && bottom > surf - 0.1, `足元が地表に合っていない bottom=${bottom} surf=${surf}`);
  assert.equal(wb.bodyCollides(world, body.x, body.y), false, "静止状態で地面と重なっている");
});

test("物理: 地面からジャンプすると上昇する", () => {
  const world = wb.generateWorld(7);
  const spawn = wb.findSpawn(world);
  const surf = world.surfaces[spawn.x];
  const body = wb.createBody(spawn.x + 0.1, surf - wb.PLAYER_H);
  const idle = { left: false, right: false, jump: false, fastFall: false };
  for (let i = 0; i < 120; i++) wb.stepPlayer(world, body, idle, 1 / 60);
  assert.equal(body.onGround, true);
  const y0 = body.y;
  wb.stepPlayer(world, body, { ...idle, jump: true }, 1 / 60);
  wb.stepPlayer(world, body, idle, 1 / 60);
  assert.ok(body.y < y0, `ジャンプで上昇していない y0=${y0} y=${body.y}`);
});

test("物理: 壁（原木）に横移動でぶつかって止まる", () => {
  const world = wb.generateWorld(7);
  // 人工的に平らな床と壁を作る（生成地形の凹凸に依存しないように整地する）
  const spawn = wb.findSpawn(world);
  const surf = world.surfaces[spawn.x];
  const wallX = spawn.x + 3;
  for (let x = spawn.x; x <= wallX; x++) {
    for (let y = surf - 5; y < surf; y++) world.tiles[y * WORLD_W + x] = wb.AIR;
    for (let y = surf; y < surf + 4; y++) world.tiles[y * WORLD_W + x] = wb.STONE;
  }
  for (let y = surf - 5; y < surf; y++) world.tiles[y * WORLD_W + wallX] = wb.STONE;
  const body = wb.createBody(spawn.x + 0.1, surf - wb.PLAYER_H);
  const input = { left: false, right: true, jump: false, fastFall: false };
  for (let i = 0; i < 240; i++) wb.stepPlayer(world, body, input, 1 / 60);
  assert.ok(body.x + wb.PLAYER_W <= wallX + 0.01, `壁をすり抜けた x=${body.x} wall=${wallX}`);
  assert.ok(body.x > spawn.x, "右へ進めていない");
});

test("保存: serialize → parse の往復で状態が一致する", () => {
  const world = wb.generateWorld(99);
  const inv = {};
  const got = wb.digTile(world, inv, 10, world.surfaces[10]);
  assert.ok(got !== null);
  const state = { seed: 99, tiles: world.tiles, inventory: inv, player: { x: 12.5, y: 15.25 } };
  const parsed = wb.parseSave(wb.serializeSave(state));
  assert.ok(parsed);
  assert.equal(parsed.seed, 99);
  assert.deepEqual(Array.from(parsed.tiles), Array.from(world.tiles));
  assert.deepEqual(parsed.inventory, inv);
  assert.deepEqual(parsed.player, { x: 12.5, y: 15.25 });
});

test("保存: 壊れたデータは null（新規ワールドへフォールバック）", () => {
  assert.equal(wb.parseSave(null), null);
  assert.equal(wb.parseSave(""), null);
  assert.equal(wb.parseSave("{not json"), null);
  assert.equal(wb.parseSave(JSON.stringify({ version: 999 })), null);
  // タイル長が合わない
  assert.equal(
    wb.parseSave(JSON.stringify({ version: 1, seed: 1, tilesB64: "AAAA", inventory: {}, player: { x: 0, y: 0 } })),
    null,
  );
});

test("カタログ: worldbox が playable で登録されている", async () => {
  const catalogSrc = fs.readFileSync(path.join(libDir, "games-catalog.ts"), "utf8");
  assert.ok(catalogSrc.includes('slug: "worldbox"'));
  assert.ok(catalogSrc.includes('title: "AGO WORLD BOX"'));
  const pageSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "app", "games", "[id]", "page.tsx"), "utf8");
  assert.ok(pageSrc.includes("WorldBoxClient"));
  const clientSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "app", "games", "worldbox", "WorldBoxClient.tsx"), "utf8");
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(clientSrc), "クライアントに絵文字が含まれている");
});
