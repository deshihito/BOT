// WORLD BOX バッチ2: インスタンス基盤 + 洞窟の純粋ロジックテスト。
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

const T = await loadBundle(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/lobby.ts", "worldbox/items.ts", "worldbox/mobs.ts", "worldbox/objects.ts", "worldbox/instances.ts", "worldbox/save.ts", "worldbox/presence.ts"],
  ["makeInstanceSpace", "parseInstanceSpace", "isInstanceSpace", "buildCaveLayer", "lightRadiusTiles", "CAVE_LAYERS", "CAVE_W", "CAVE_H", "isCaveSafeTile", "parseSave", "serializeSave", "sanitizePresenceSpace", "validateSpecialObjects", "specialObjectById", "ruinsCompleteOpId"],
);

test("space id roundtrip", () => {
  const id = T.makeInstanceSpace("cave", 12, -34, 2);
  assert.equal(id, "cave:12,-34:2");
  const parsed = T.parseInstanceSpace(id);
  assert.equal(parsed?.kind, "cave");
  assert.equal(parsed?.entranceX, 12);
  assert.equal(parsed?.entranceY, -34);
  assert.equal(parsed?.layer, 2);
});

test("space id rejects junk", () => {
  assert.equal(T.parseInstanceSpace("cave:1,2"), null);
  assert.equal(T.parseInstanceSpace("world"), null);
  assert.equal(T.isInstanceSpace("lobby"), false);
});

test("save keeps instance space", () => {
  const raw = T.serializeSave({ space: "cave:5,6:1", x: 10, y: 10, worldReturn: { x: 5.5, y: 6.5 } });
  assert.equal(T.parseSave(raw)?.space, "cave:5,6:1");
});

test("save clamps cave coords", () => {
  const back = T.parseSave(T.serializeSave({ space: "cave:5,6:1", x: 9999, y: -3, worldReturn: null }));
  assert.ok(back && back.x <= T.CAVE_W && back.y >= 0.5);
});

test("presence keeps instance space", () => {
  assert.equal(T.sanitizePresenceSpace("ruins:1,2:0"), "ruins:1,2:0");
  assert.equal(T.sanitizePresenceSpace("bogus"), "world");
});

test("light radius lamp>torch>none", () => {
  assert.equal(T.lightRadiusTiles({ lamp: 1 }), 9);
  assert.equal(T.lightRadiusTiles({ torch: 1 }), 6);
  assert.equal(T.lightRadiusTiles({}), 2.5);
  assert.equal(T.lightRadiusTiles(null), 2.5);
});

const SEED = 12345;
const layers = [0, 1, 2].map((l) => T.buildCaveLayer(SEED, 100, 200, l));

test("cave deterministic", () => {
  const again = T.buildCaveLayer(SEED, 100, 200, 0);
  assert.equal(again.portal.x, layers[0].portal.x);
  assert.equal(again.veins.length, layers[0].veins.length);
  assert.ok(again.veins.every((v, i) => v.x === layers[0].veins[i].x && v.y === layers[0].veins[i].y));
});

test("stairs chain", () => {
  assert.equal(layers[0].stairsUp, null);
  assert.ok(layers[0].stairsDown);
  assert.ok(layers[1].stairsUp && layers[1].stairsDown);
  assert.ok(layers[2].stairsUp);
  assert.equal(layers[2].stairsDown, null);
});

test("onsen only layer 1", () => {
  assert.ok(layers[0].onsen.length > 0);
  assert.equal(layers[1].onsen.length, 0);
  assert.equal(layers[2].onsen.length, 0);
});

test("chest every layer", () => {
  assert.ok(layers.every((c) => c.chest !== null));
});

function reachable(cave) {
  const seen = new Set([`${cave.portal.x},${cave.portal.y}`]);
  const queue = [{ ...cave.portal }];
  while (queue.length) {
    const cur = queue.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const key = `${nx},${ny}`;
      if (seen.has(key) || cave.data.blocked.has(key)) continue;
      if (nx < 0 || ny < 0 || nx >= T.CAVE_W || ny >= T.CAVE_H) continue;
      if (cave.data.tiles[ny * T.CAVE_W + nx] === 1) continue; // L_WALL
      seen.add(key);
      queue.push({ x: nx, y: ny });
    }
  }
  return seen;
}

for (const [i, cave] of layers.entries()) {
  test(`layer ${i + 1} connectivity`, () => {
    const seen = reachable(cave);
    const near = (p) => p && [...seen].some((k) => {
      const [x, y] = k.split(",").map(Number);
      return Math.abs(x - p.x) + Math.abs(y - p.y) <= 1;
    });
    assert.ok(near(cave.stairsDown ?? cave.stairsUp ?? cave.portal), "stairs");
    assert.ok(near(cave.chest), "chest");
    assert.ok(cave.mobs.every((m) => near(m)), "mobs");
    assert.ok(T.isCaveSafeTile(cave, cave.portal.x, cave.portal.y));
    assert.ok(cave.mobs.every((m) => Math.hypot(m.x - cave.portal.x, m.y - cave.portal.y) > 4));
  });
}

test("vein pools per layer", () => {
  const kinds = (l) => new Set(layers[l].veins.map((v) => v.objectId));
  assert.ok([...kinds(0)].every((k) => k === "coal_vein" || k === "copper_vein"));
  assert.ok(kinds(1).has("rare_vein") || kinds(1).has("crystal_cluster"));
  assert.ok(kinds(2).has("mithril_vein"));
});

test("vein gates and respawn", () => {
  assert.equal(T.specialObjectById("mithril_vein")?.minTier, 3);
  assert.equal(T.specialObjectById("rare_vein")?.minTier, 2);
  assert.equal(T.specialObjectById("coal_vein")?.respawnMs, 3 * 3600 * 1000);
  assert.equal(T.specialObjectById("mithril_vein")?.respawnMs, 6 * 3600 * 1000);
  assert.equal(T.validateSpecialObjects().length, 0);
});

test("cave mobs and vein walls", () => {
  assert.ok(layers.every((c) => c.mobs.every((m) => m.mobId === "cave_bat" || m.mobId === "golem")));
  assert.ok(layers.every((c) => c.veins.every((v) => c.data.tiles[v.y * T.CAVE_W + v.x] === 1)));
});

// ---- 遺跡（バッチ3） ----
const R = await loadBundle(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/lobby.ts", "worldbox/items.ts", "worldbox/mobs.ts", "worldbox/objects.ts", "worldbox/instances.ts"],
  ["buildRuins", "RUINS_W", "RUINS_H", "weekKeyOf", "RUINS_MAIN_CHEST_LOOT", "RUINS_TRAP_KINDS"],
);

test("ruins deterministic + 48x48", () => {
  const a = R.buildRuins(SEED, 300, 400);
  const b = R.buildRuins(SEED, 300, 400);
  assert.equal(a.portal.x, b.portal.x);
  assert.equal(a.chests.length, b.chests.length);
  assert.equal(a.data.width, 48);
  assert.equal(a.data.height, 48);
});

test("ruins main chest at deepest + key door", () => {
  const ruins = R.buildRuins(SEED, 300, 400);
  const main = ruins.chests.find((c) => c.main);
  assert.ok(main);
  assert.equal(main.requiresKey, ruins.doors.length > 0);
});

test("ruins connectivity: portal reaches all rooms (door excluded)", () => {
  const ruins = R.buildRuins(SEED, 300, 400);
  const seen = new Set([`${ruins.portal.x},${ruins.portal.y}`]);
  const queue = [{ ...ruins.portal }];
  while (queue.length) {
    const cur = queue.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const key = `${nx},${ny}`;
      if (seen.has(key) || ruins.data.blocked.has(key)) continue;
      if (nx < 0 || ny < 0 || nx >= 48 || ny >= 48) continue;
      if (ruins.data.tiles[ny * 48 + nx] === 1) continue;
      seen.add(key);
      queue.push({ x: nx, y: ny });
    }
  }
  // 扉以外の全小宝箱・部屋中心に届く
  for (const chest of ruins.chests) {
    if (chest.main) continue;
    assert.ok([...seen].some((k) => {
      const [x, y] = k.split(",").map(Number);
      return Math.abs(x - chest.x) + Math.abs(y - chest.y) <= 1;
    }), `chest ${chest.idx} reachable`);
  }
  assert.ok(ruins.roomCenters.length >= 8);
});

test("ruins traps: 4 kinds cycle, away from portal", () => {
  const ruins = R.buildRuins(SEED, 300, 400);
  assert.ok(ruins.traps.length >= 4);
  assert.ok(ruins.traps.every((t) => R.RUINS_TRAP_KINDS.includes(t.kind)));
  assert.ok(ruins.traps.every((t) => Math.hypot(t.x - ruins.portal.x, t.y - ruins.portal.y) > 4));
});

test("week key is Monday based", () => {
  // 2026-11-16 は月曜、2026-11-15 は日曜（前週の月曜=11-09）
  assert.equal(R.weekKeyOf(Date.UTC(2026, 10, 16)), "2026-11-16");
  assert.equal(R.weekKeyOf(Date.UTC(2026, 10, 15)), "2026-11-09");
  assert.equal(R.weekKeyOf(Date.UTC(2026, 10, 21)), "2026-11-16");
});

test("ruins main chest loot boosts relics", () => {
  const relic = R.RUINS_MAIN_CHEST_LOOT.find((e) => e.itemId === "ancient_relic");
  const map = R.RUINS_MAIN_CHEST_LOOT.find((e) => e.itemId === "star_map");
  assert.ok(relic && relic.chance > 0.25);
  assert.ok(map && map.chance > 0.2);
});

test("ruinsCompleteOpId: 決定的でブリッジの ID 形式に収まり、入口とプレイヤーで一意", () => {
  const a = T.ruinsCompleteOpId(12, -34, "611111111111111111");
  assert.equal(a, T.ruinsCompleteOpId(12, -34, "611111111111111111"), "同じ入力では同じ ID");
  assert.match(a, /^[A-Za-z0-9-]{8,64}$/);
  assert.notEqual(a, T.ruinsCompleteOpId(13, -34, "611111111111111111"), "入口が違えば別の ID");
  assert.notEqual(a, T.ruinsCompleteOpId(12, -34, "622222222222222222"), "プレイヤーが違えば別の ID");
});

test("冪等性の配線: instances ルートは空間ロックと決定的 ID の冪等登録を使う", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/instances/route.ts"), "utf8");
  assert.match(route, /withUserLock\(`instance:\$\{space\}`,/, "空間単位で直列化する");
  assert.match(route, /ruinsCompleteOpId/, "ruins_complete は決定的 ID");
  assert.match(route, /enqueueEconomyOpOnce/, "冪等登録を使う");
  assert.ok(!route.includes("crypto.randomUUID()"), "経済オプにランダム ID を使わない");
});

test("冪等性の配線: 共有ロックと冪等登録がブリッジ側に用意されている", () => {
  const lock = fs.readFileSync(path.join(libDir, "worldbox/user-lock.ts"), "utf8");
  assert.match(lock, /export async function withUserLock/);
  const online = fs.readFileSync(path.join(libDir, "worldbox/economy-bridge-online.ts"), "utf8");
  assert.match(online, /export async function enqueueEconomyOpOnce/);
  assert.match(online, /submitEconomyOp\(op\)/, "冪等登録は直接適用（submitEconomyOp）へ委譲する");
  assert.match(online, /existing\.status === "done"/, "既存オプが終端していれば作り直さない");
});
