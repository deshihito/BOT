// WORLD BOX バッチ9a: 計測基盤（日次・ファネル・継続率）とスポーン保護のテスト。
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

const M = await loadBundle(
  ["worldbox/metrics.ts"],
  [
    "emptyDayMetrics", "parseDayMetrics", "parseUserFirstSteps", "dayKeyOf",
    "funnelRates", "retentionRate", "FUNNEL_WINDOW_MS",
  ],
);

test("metrics: day parse keeps counters and caps dau", () => {
  const day = M.parseDayMetrics(
    { dau: ["a", "b", 42], peak: 7, blocksPlaced: 12, guildShopVolume: 900 },
    "2026-11-16",
  );
  assert.deepEqual(day.dau, ["a", "b"]);
  assert.equal(day.peak, 7);
  assert.equal(day.blocksPlaced, 12);
  assert.equal(day.guildShopVolume, 900);
  assert.deepEqual(M.parseDayMetrics("junk", "2026-11-16"), M.emptyDayMetrics("2026-11-16"));
  assert.equal(M.dayKeyOf(Date.UTC(2026, 10, 16, 23, 59)), "2026-11-16");
});

test("metrics: funnel counts only steps within 5 minutes of first seen", () => {
  const base = 1_000_000;
  const users = [
    { firstAt: base, gatherAt: base + 60_000, placeAt: base + 120_000, lobbyAt: base + 180_000 },
    { firstAt: base, gatherAt: base + M.FUNNEL_WINDOW_MS + 1 },
    { firstAt: base },
  ];
  const rates = M.funnelRates(users.map((u) => M.parseUserFirstSteps(u)));
  assert.equal(rates.users, 3);
  assert.ok(Math.abs(rates.gather - 1 / 3) < 1e-9);
  assert.ok(Math.abs(rates.place - 1 / 3) < 1e-9);
  assert.ok(Math.abs(rates.lobby - 1 / 3) < 1e-9);
  assert.deepEqual(M.funnelRates([]), { users: 0, gather: 0, place: 0, lobby: 0 });
});

test("metrics: retention is the share of day-A users also in day-B", () => {
  const a = { ...M.emptyDayMetrics("d1"), dau: ["a", "b", "c", "d"] };
  const b = { ...M.emptyDayMetrics("d2"), dau: ["b", "d", "x"] };
  assert.equal(M.retentionRate(a, b), 0.5);
  assert.equal(M.retentionRate(M.emptyDayMetrics("d1"), b), null);
});

const V = await loadBundle(
  ["worldbox/items.ts", "worldbox/profile.ts", "worldbox/vitals.ts"],
  ["applyMobDamage", "parseProfile"],
);

test("spawn protection: new players take no mob damage during the window", () => {
  const now = 2_000_000;
  const fresh = {
    ...V.parseProfile(null),
    hp: 100, hunger: 100, vitalAt: now - 1000, lastDamageAt: 0,
    spawnProtectedUntil: now + 60_000,
  };
  const hit = V.applyMobDamage(fresh, "slime", 10, now, () => 0);
  assert.equal(hit.applied, false);
  assert.equal(hit.profile.hp, 100);
  const expired = { ...fresh, spawnProtectedUntil: now - 1 };
  const hit2 = V.applyMobDamage(expired, "slime", 10, now, () => 0);
  assert.equal(hit2.applied, true);
  assert.equal(hit2.profile.hp, 90);
});
