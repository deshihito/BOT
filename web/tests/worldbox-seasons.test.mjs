// WORLD BOX バッチ8a: 季節・作物適季・インスタンスバイオームのテスト。
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

const S = await loadBundle(
  ["worldbox/seasons.ts"],
  ["seasonOf", "seasonDaysLeft", "seasonGrowthMult", "SEASON_LENGTH_MS", "SEASON_IDS"],
);

const WEEK = 7 * 24 * 3600 * 1000;

test("seasons: 7-day rotation through all four seasons", () => {
  assert.equal(S.seasonOf(0), "spring");
  assert.equal(S.seasonOf(WEEK), "summer");
  assert.equal(S.seasonOf(2 * WEEK), "autumn");
  assert.equal(S.seasonOf(3 * WEEK), "winter");
  assert.equal(S.seasonOf(4 * WEEK), "spring");
  assert.equal(S.seasonDaysLeft(0), 6);
  assert.equal(S.seasonDaysLeft(WEEK - 1), 0);
});

test("seasons: growth multiplier favors the preferred season", () => {
  assert.equal(S.seasonGrowthMult("spring", 0), 0.7);
  assert.equal(S.seasonGrowthMult("spring", WEEK), 1);
  assert.equal(S.seasonGrowthMult("spring", 2 * WEEK), 1.4);
  assert.equal(S.seasonGrowthMult("spring", 3 * WEEK), 1);
  assert.equal(S.seasonGrowthMult(null, 0), 1);
  assert.equal(S.seasonGrowthMult(undefined, 2 * WEEK), 1);
});

const M = await loadBundle(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/maplogic.ts"],
  ["BIOMES", "biomeForInstanceSpace", "biomeById"],
);

test("biomes: cave layers and ruins belt are registered", () => {
  assert.equal(M.biomeById("cave_deep")?.name, "洞窟");
  assert.equal(M.biomeById("ruins_belt")?.name, "遺跡帯");
  assert.ok(M.BIOMES.length >= 12);
  assert.equal(M.biomeForInstanceSpace("cave:3,4:2"), "cave_deep");
  assert.equal(M.biomeForInstanceSpace("dungeon:3,4:0"), "cave_deep");
  assert.equal(M.biomeForInstanceSpace("ruins:-9999,-9999:0"), "ruins_belt");
  assert.equal(M.biomeForInstanceSpace("world"), null);
  assert.equal(M.biomeForInstanceSpace(42), null);
});

const I = await loadBundle(
  ["worldbox/items.ts"],
  ["CROPS", "cropById"],
);

test("crops: every crop has a preferred season", () => {
  for (const crop of I.CROPS) {
    assert.ok(S.SEASON_IDS.includes(crop.season), `${crop.id} has no season`);
  }
  assert.equal(I.cropById("wheat").season, "spring");
  assert.equal(I.cropById("pumpkin").season, "autumn");
});
