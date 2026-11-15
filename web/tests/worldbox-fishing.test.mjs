// WORLD BOX バッチ8b-2: 釣り（魚影の配置・再出現・ルート）のテスト。
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

const F = await loadBundle(
  [
    "worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/maplogic.ts", "worldbox/items.ts",
    "worldbox/objects.ts", "worldbox/fishing.ts",
  ],
  ["fishingSpotAt", "fishingReady", "fishingNonce", "objectsForChunk", "lootForObjectAt", "MAP_SEED"],
);

test("fishing: spots exist on water biomes and are found by coordinate", () => {
  let found = 0;
  for (let cy = -2; cy <= 2 && found < 3; cy++) {
    for (let cx = -2; cx <= 2 && found < 3; cx++) {
      for (const o of F.objectsForChunk(F.MAP_SEED, cx, cy)) {
        if (o.objectId !== "fishing_spot") continue;
        const spot = F.fishingSpotAt(F.MAP_SEED, o.x, o.y);
        assert.ok(spot, `${o.x},${o.y}`);
        assert.equal(spot.objectId, "fishing_spot");
        found++;
      }
    }
  }
  assert.ok(found > 0, "魚影が1つも見つからない");
  assert.equal(F.fishingSpotAt(F.MAP_SEED, 0, 0), null);
});

test("fishing: respawn gate is 10 minutes and loot is deterministic per cycle", () => {
  const now = 1_700_000_000_000;
  assert.equal(F.fishingReady(null, now), true);
  assert.equal(F.fishingReady(now - 599_999, now), false);
  assert.equal(F.fishingReady(now - 600_000, now), true);
  const a = F.lootForObjectAt(F.MAP_SEED, "fishing_spot", 10, 20, F.fishingNonce(null, now));
  const b = F.lootForObjectAt(F.MAP_SEED, "fishing_spot", 10, 20, F.fishingNonce(null, now));
  assert.deepEqual(a.gained, b.gained);
  assert.ok((a.gained.fish ?? 0) >= 1, "魚は必ず釣れる");
});
