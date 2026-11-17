// WORLD BOX 修正4: 地表オブジェクト接続（描画・タップ・採取API・
// 枯渇共有・衝突・釣りの再出現同期）のテスト。
// ロジックは objects.ts の純粋関数を、配線はソースの実在で裏付ける。
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

const O = await loadBundle(
  [
    "worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/maplogic.ts", "worldbox/items.ts",
    "worldbox/objects.ts",
  ],
  [
    "SPECIAL_OBJECTS", "specialObjectById", "validateSpecialObjects", "objectsForChunk",
    "surfaceObjectAt", "surfaceSolidTilesInRect", "parseObjectStates", "objectRespawned",
    "rollObjectLoot", "makeRng", "MAP_SEED", "CHUNK_SIZE",
  ],
);

function scanObjects() {
  // ワールド全域（64×64チャンク）。highland が希少なため cave_chest 等は
  // 全域で数個しか出ない（定義由来）ので、狭い範囲では見つからない。
  const found = new Map();
  for (let cy = -32; cy < 32; cy++) {
    for (let cx = -32; cx < 32; cx++) {
      for (const o of O.objectsForChunk(O.MAP_SEED, cx, cy)) {
        if (!found.has(o.objectId)) found.set(o.objectId, o);
      }
    }
  }
  return found;
}

test("surface-objects: 入口系のデッド定義は除去され、定義の整合性が保たれる", () => {
  assert.equal(O.specialObjectById("cave_mouth"), null);
  assert.equal(O.specialObjectById("dungeon_gate"), null);
  assert.equal(O.specialObjectById("ruins_gate"), null);
  assert.ok(O.SPECIAL_OBJECTS.every((d) => d.interaction !== "enter"));
  assert.deepEqual(O.validateSpecialObjects(), []);
});

test("surface-objects: 全種が地表に配置され、座標から逆引きできる", () => {
  const found = scanObjects();
  const expected = [
    "berry_bush", "herb_patch", "mushroom_patch", "flower_meadow", "beehive",
    "bird_nest", "sulfur_vent", "copper_vein", "coal_vein", "rare_vein",
    "crystal_cluster", "ruins_chest", "cave_chest", "dungeon_chest",
    "hot_spring", "ancient_pillar", "fallen_log", "driftwood", "fishing_spot",
  ];
  for (const id of expected) {
    const placed = found.get(id);
    assert.ok(placed, `${id} が地表に配置されていない`);
    const back = O.surfaceObjectAt(O.MAP_SEED, placed.x, placed.y);
    assert.ok(back, `${id} が座標から引けない`);
    assert.equal(back.objectId, id);
  }
  // オブジェクトの無い座標は null（原点付近に何も無いことは釣りテストでも前提）
  assert.equal(O.surfaceObjectAt(O.MAP_SEED, 0, 0), null);
});

test("surface-objects: 再出現は定義の respawnMs が正（0 は一回きり）", () => {
  const now = 1_700_000_000_000;
  const bush = O.specialObjectById("berry_bush");
  assert.equal(O.objectRespawned(bush, null, now), true);
  assert.equal(O.objectRespawned(bush, now - 29 * 60 * 1000, now), false);
  assert.equal(O.objectRespawned(bush, now - 30 * 60 * 1000, now), true);
  const chest = O.specialObjectById("ruins_chest");
  assert.equal(chest.respawnMs, 0);
  assert.equal(O.objectRespawned(chest, now - 365 * 24 * 3600 * 1000, now), false);
  const spring = O.specialObjectById("hot_spring");
  assert.equal(spring.interaction, "rest");
  assert.equal(spring.heal, 50);
  assert.equal(O.objectRespawned(spring, now, now + 1000), false);
});

test("surface-objects: 宝箱の罠とルートは定義どおりにロールされる", () => {
  for (const id of ["ruins_chest", "cave_chest", "dungeon_chest"]) {
    const def = O.specialObjectById(id);
    assert.ok(def.trapChance > 0, `${id} に罠が無い`);
    const lootIds = new Set(def.loot.map((e) => e.itemId));
    let trappedSeen = false;
    let cleanSeen = false;
    for (let s = 1; s <= 60; s++) {
      const r = O.rollObjectLoot(def, O.makeRng(s * 7919));
      if (r.trapped) trappedSeen = true;
      else cleanSeen = true;
      for (const itemId of Object.keys(r.gained)) {
        assert.ok(lootIds.has(itemId), `${id} のルート外アイテム ${itemId}`);
      }
    }
    assert.ok(trappedSeen && cleanSeen, `${id} の罠ロールが偏っている`);
  }
});

test("surface-objects: 固体集合は solid 定義だけを含み、範囲で絞れる", () => {
  const ext = 32 * O.CHUNK_SIZE;
  const all = O.surfaceSolidTilesInRect(O.MAP_SEED, -ext, -ext, ext - 1, ext - 1);
  assert.ok(all.size > 0);
  // 固体のはずの種が含まれる
  const found = scanObjects();
  for (const id of ["copper_vein", "beehive", "ruins_chest", "ancient_pillar", "fallen_log"]) {
    const p = found.get(id);
    assert.ok(all.has(`${p.x},${p.y}`), `${id} が固体集合に無い`);
  }
  // 固体でない種は含まれない
  for (const id of ["berry_bush", "hot_spring", "driftwood", "fishing_spot", "bird_nest"]) {
    const p = found.get(id);
    assert.ok(!all.has(`${p.x},${p.y}`), `${id} が固体集合に入っている`);
  }
  // 狭い範囲は広い範囲の部分集合
  const narrow = O.surfaceSolidTilesInRect(O.MAP_SEED, 0, 0, 31, 31);
  for (const k of narrow) assert.ok(all.has(k));
});

test("surface-objects: 枯渇状態のパースは不正値を捨てる", () => {
  const parsed = O.parseObjectStates(new Map([
    ["3,4", "1700000000000"],
    ["-5,6", 1700000000001],
    ["junk", "1700000000000"],
    ["7,8", "not-a-number"],
    ["9,10", 0],
    ["11,12", null],
  ]));
  assert.deepEqual(parsed, { "3,4": 1700000000000, "-5,6": 1700000000001 });
});

// ---- 配線（ソースの実在） -------------------------------------------------

const routeSrc = fs.readFileSync(
  path.join(rootDir, "app/api/worldbox/objects/route.ts"), "utf8",
);
const fishingRouteSrc = fs.readFileSync(
  path.join(rootDir, "app/api/worldbox/fishing/route.ts"), "utf8",
);
const clientSrc = fs.readFileSync(
  path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8",
);
const watchSrc = fs.readFileSync(path.join(rootDir, "realtime/watch-core.js"), "utf8");
const serverSrc = fs.readFileSync(path.join(rootDir, "realtime-server.js"), "utf8");

test("surface-objects wiring: 採取APIが検証と永続化を持つ", () => {
  assert.ok(routeSrc.includes("export async function GET"));
  assert.ok(routeSrc.includes("export async function POST"));
  for (const needle of [
    "surfaceObjectAt", "objectRespawned", "storeHarvestedAt", "loadObjectStates",
    "withUserLock", "bestToolTier", "too_far", "depleted", "needs_pickaxe",
    "pickaxe_tier", "TRAP_DAMAGE", "MINER_BONUS_CHANCE", "addMasteryXp",
  ]) {
    assert.ok(routeSrc.includes(needle), `objects route に ${needle} が無い`);
  }
  // 魚影は釣り専用ルートの担当（地表APIでは弾く）
  assert.ok(routeSrc.includes('placed.objectId === "fishing_spot"'));
});

test("surface-objects wiring: 釣りに状態取得の経路がある", () => {
  assert.ok(fishingRouteSrc.includes("export async function GET"));
  assert.ok(fishingRouteSrc.includes("loadAllCaughtAt"));
});

test("surface-objects wiring: クライアントが描画・タップ・衝突・同期を持つ", () => {
  for (const needle of [
    "drawSurfaceObject", "surfaceObjectAt", "postSurfaceObject",
    "surfaceObjStateRef", "refreshSurfaceStates", "surfaceSolidTilesInRect",
    'msg.kind === "objects"', 'msg.kind === "fishing"',
    'fetch("/api/worldbox/objects"', "/api/worldbox/fishing?",
  ]) {
    assert.ok(clientSrc.includes(needle), `client に ${needle} が無い`);
  }
});

test("surface-objects wiring: relay が枯渇と釣果を差分配信する", () => {
  assert.ok(watchSrc.includes('"worldbox_objects"'));
  assert.ok(watchSrc.includes('"worldbox_fishing"'));
  assert.ok(serverSrc.includes('kind === "objects"'));
  assert.ok(serverSrc.includes('kind === "fishing"'));
});
