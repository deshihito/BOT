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
  ["makeInstanceSpace", "parseInstanceSpace", "isInstanceSpace", "buildCaveLayer", "lightRadiusTiles", "CAVE_LAYERS", "CAVE_W", "CAVE_H", "isCaveSafeTile", "parseSave", "serializeSave", "sanitizePresenceSpace", "validateSpecialObjects", "specialObjectById"],
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
