// WORLD BOX 移民コントロール（経済仕様書 §7.2、バッチE3）の検証:
// - 入国料・出金料率の正規化（範囲・端数）と parse の往復
// - 出金料の金額計算（所持金 × 料率、切り捨て）
// - ルート配線（参加時の入国料徴収・離脱時の出金料徴収・設定 API・パネル）
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
        .replace(/^export\s*\{\[^}]*\};?\s*$/, ""),
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
  ["worldbox/nation-settings.ts"],
  [
    "ENTRY_FEE_MAX", "EXIT_FEE_RATE_MAX",
    "defaultNationSettings", "parseNationSettings",
    "normalizeEntryFee", "normalizeExitFeeRate",
    "entryFeeOf", "exitFeeRateOf", "exitFeeAmount",
  ],
);

test("immigration: 既定は入国料 0・出金料率 0・手数料収入 0", () => {
  const d = wb.defaultNationSettings();
  assert.equal(d.entryFee, 0);
  assert.equal(d.exitFeeRate, 0);
  assert.equal(d.feesCollected, 0);
  assert.equal(wb.entryFeeOf(null), 0);
  assert.equal(wb.exitFeeRateOf(undefined), 0);
});

test("immigration: 入国料の正規化（整数・上限・範囲外は 0）", () => {
  assert.equal(wb.normalizeEntryFee(500), 500);
  assert.equal(wb.normalizeEntryFee(500.9), 500);
  assert.equal(wb.normalizeEntryFee(wb.ENTRY_FEE_MAX), wb.ENTRY_FEE_MAX);
  assert.equal(wb.normalizeEntryFee(wb.ENTRY_FEE_MAX + 1), 0);
  assert.equal(wb.normalizeEntryFee(-1), 0);
  assert.equal(wb.normalizeEntryFee("500"), 0);
  assert.equal(wb.normalizeEntryFee(Number.NaN), 0);
});

test("immigration: 出金料率の正規化（0〜0.80、0.1% 単位、範囲外は 0）", () => {
  assert.equal(wb.normalizeExitFeeRate(0.8), 0.8);
  assert.equal(wb.normalizeExitFeeRate(0.1234), 0.123);
  assert.equal(wb.normalizeExitFeeRate(0.8001), 0);
  assert.equal(wb.normalizeExitFeeRate(0.81), 0);
  assert.equal(wb.normalizeExitFeeRate(-0.1), 0);
  assert.equal(wb.EXIT_FEE_RATE_MAX, 0.8);
});

test("immigration: 出金料の金額（所持金 × 料率、切り捨て）", () => {
  assert.equal(wb.exitFeeAmount(10000, 0.1), 1000);
  assert.equal(wb.exitFeeAmount(9999, 0.1), 999);
  assert.equal(wb.exitFeeAmount(10000, 0.8), 8000);
  assert.equal(wb.exitFeeAmount(10000, 0), 0);
  assert.equal(wb.exitFeeAmount(0, 0.5), 0);
  assert.equal(wb.exitFeeAmount(-100, 0.5), 0);
});

test("immigration: parse の往復（新フィールドが復元され、壊れた値は 0 に落ちる）", () => {
  const parsed = wb.parseNationSettings({
    entryFee: 3000, exitFeeRate: 0.25, feesCollected: 12345,
  });
  assert.equal(parsed.entryFee, 3000);
  assert.equal(parsed.exitFeeRate, 0.25);
  assert.equal(parsed.feesCollected, 12345);
  const broken = wb.parseNationSettings({ entryFee: -5, exitFeeRate: 2, feesCollected: -1 });
  assert.equal(broken.entryFee, 0);
  assert.equal(broken.exitFeeRate, 0);
  assert.equal(broken.feesCollected, 0);
  const legacy = wb.parseNationSettings({ taxRate: 0.05 });
  assert.equal(legacy.entryFee, 0);
  assert.equal(legacy.exitFeeRate, 0);
});

test("immigration: ルート配線（徴収・設定 API・パネル・ラベル）", () => {
  const nationsRoute = fs.readFileSync(path.join(rootDir, "app/api/worldbox/nations/route.ts"), "utf8");
  assert.ok(nationsRoute.includes("nation_entry_fee"), "参加時の入国料徴収が配線されていない");
  assert.ok(nationsRoute.includes("nation_exit_fee"), "離脱時の出金料徴収が配線されていない");
  assert.ok(nationsRoute.includes("chargeNationFee"), "手数料の交付ゲートが配線されていない");
  assert.ok(nationsRoute.includes("feesCollected"), "手数料収入の累計加算が配線されていない");
  assert.ok(nationsRoute.includes("entryFee"), "国一覧への入国料表示が配線されていない");
  const settingsRoute = fs.readFileSync(path.join(rootDir, "app/api/worldbox/nation-settings/route.ts"), "utf8");
  assert.ok(settingsRoute.includes("set_entry_fee"), "入国料の設定 API が配線されていない");
  assert.ok(settingsRoute.includes("set_exit_fee"), "出金料率の設定 API が配線されていない");
  const panel = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxGuildBoardPanel.tsx"), "utf8");
  assert.ok(panel.includes("入国料"), "パネルに入国料の表示がない");
  assert.ok(panel.includes("出金料"), "パネルに出金料の表示がない");
  assert.ok(panel.includes("手数料収入"), "パネルに手数料収入の表示がない");
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("insufficient_coins"), "残高不足のラベルがない");
});
