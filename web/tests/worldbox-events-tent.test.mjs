// WORLD BOX バッチ10b: イベント基盤（日程判定・期間ダンジョン）と
// テント拡張段階のテスト。
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

const E = await loadBundle(
  ["worldbox/events.ts"],
  [
    "WORLD_EVENTS", "EVENT_DUNGEON_ENTRANCE", "isEventActive", "activeEvents",
    "activeLimitedDungeon", "isEventDungeonEntrance", "eventDaysLeft",
  ],
);

const utc = (y, m, d) => Date.UTC(y, m - 1, d, 12, 0, 0);

test("events: year-wrapping window (Dec 20 - Jan 5)", () => {
  const def = E.WORLD_EVENTS.find((e) => e.id === "stardust_festival");
  assert.equal(E.isEventActive(def, utc(2026, 12, 19)), false);
  assert.equal(E.isEventActive(def, utc(2026, 12, 20)), true);
  assert.equal(E.isEventActive(def, utc(2026, 12, 31)), true);
  assert.equal(E.isEventActive(def, utc(2027, 1, 5)), true);
  assert.equal(E.isEventActive(def, utc(2027, 1, 6)), false);
  assert.equal(E.isEventActive(def, utc(2026, 6, 1)), false);
  assert.equal(E.eventDaysLeft(def, utc(2026, 12, 20)), 16);
  assert.equal(E.eventDaysLeft(def, utc(2027, 1, 5)), 0);
  assert.equal(E.eventDaysLeft(def, utc(2026, 6, 1)), -1);
});

test("events: limited dungeon follows the same window; entrance is reserved", () => {
  assert.ok(E.activeLimitedDungeon(utc(2026, 12, 25)));
  assert.equal(E.activeLimitedDungeon(utc(2026, 3, 1)), null);
  assert.equal(E.activeEvents(utc(2026, 12, 25)).length, 2);
  assert.equal(E.isEventDungeonEntrance(E.EVENT_DUNGEON_ENTRANCE.x, E.EVENT_DUNGEON_ENTRANCE.y), true);
  assert.equal(E.isEventDungeonEntrance(0, 0), false);
});

const T = await loadBundle(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/lobby.ts", "worldbox/tent.ts"],
  [
    "TENT_TIERS", "TENT_MAX_TIER", "tentTierOf", "tentSizeForTier", "tentExitFor",
    "tentEntryFor", "buildTent", "tentTileAt", "TENT_ENTRY", "TENT_EXIT",
  ],
);

test("tent: tier 0 matches the legacy 13x10 layout", () => {
  const data = T.buildTent(0);
  assert.equal(data.width, 13);
  assert.equal(data.height, 10);
  assert.deepEqual(T.tentExitFor(0), T.TENT_EXIT);
  assert.deepEqual(T.tentEntryFor(0), T.TENT_ENTRY);
  const warp = data.objects.find((o) => o.sprite === "warp_pad");
  assert.equal(warp.x, T.TENT_EXIT.x);
  assert.equal(warp.y, T.TENT_EXIT.y);
});

test("tent: higher tiers are bigger, exit stays on the south wall center", () => {
  for (const tier of [1, 2]) {
    const size = T.tentSizeForTier(tier);
    const data = T.buildTent(tier);
    assert.equal(data.width, size.w);
    assert.equal(data.height, size.h);
    assert.equal(data.tiles.length, size.w * size.h);
    const exit = T.tentExitFor(tier);
    assert.equal(exit.y, size.h - 1);
    assert.equal(exit.x, Math.floor(size.w / 2));
    // 出入口は壁ではなく床、周囲は壁
    assert.notEqual(T.tentTileAt(data.tiles, data.width, data.height, exit.x, exit.y), 0);
    // 家具が範囲内に収まる
    for (const o of data.objects) {
      assert.ok(o.x + o.w <= size.w && o.y + o.h <= size.h, `${o.sprite} out of bounds`);
    }
    // 作業台（station: smith）は全段階にある
    assert.ok(data.objects.some((o) => o.station === "smith"));
  }
  assert.equal(T.tentTierOf(99), T.TENT_MAX_TIER);
  assert.equal(T.tentTierOf(-1), 0);
  assert.equal(T.tentTierOf("x"), 0);
});

const P = await loadBundle(
  ["worldbox/items.ts", "worldbox/profile.ts"],
  ["parseProfile", "serializeProfile"],
);

test("profile: tentTier roundtrips and clamps", () => {
  const prof = P.parseProfile(null);
  assert.equal(prof.tentTier, 0);
  const upgraded = { ...prof, tentTier: 2 };
  const back = P.parseProfile(JSON.parse(JSON.stringify(P.serializeProfile(upgraded))));
  assert.equal(back.tentTier, 2);
  const junk = P.parseProfile({ tentTier: 42 });
  assert.equal(junk.tentTier, 2);
});
