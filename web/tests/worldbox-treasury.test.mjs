// WORLD BOX 国庫（経済仕様書 §3、バッチE4）の検証:
// - 国庫残高（treasury）の既定・parse の往復・treasuryOf
// - 税率上限が現行どおり 10% のまま（変えたのはシンク→国庫だけ）
// - 入金の配線（ギルドショップ税・入国料・出金料がすべて国庫へ）
// - 設定 API のビューとギルドボードの国庫表示
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

const wb = await loadBundle(
  ["worldbox/nation-settings.ts"],
  [
    "TAX_RATE_MAX", "TAX_RATE_DEFAULT",
    "defaultNationSettings", "parseNationSettings",
    "treasuryOf", "taxRateOf",
  ],
);

test("treasury: 既定は国庫 0、未設定国も 0", () => {
  assert.equal(wb.defaultNationSettings().treasury, 0);
  assert.equal(wb.treasuryOf(null), 0);
  assert.equal(wb.treasuryOf(undefined), 0);
  assert.equal(wb.treasuryOf(wb.defaultNationSettings()), 0);
});

test("treasury: parse の往復（正の値は切り捨て、壊れた値は 0）", () => {
  const parsed = wb.parseNationSettings({ treasury: 12345.9 });
  assert.equal(parsed.treasury, 12345);
  assert.equal(wb.parseNationSettings({ treasury: -100 }).treasury, 0);
  assert.equal(wb.parseNationSettings({ treasury: "500" }).treasury, 0);
  assert.equal(wb.parseNationSettings({}).treasury, 0);
  assert.equal(wb.parseNationSettings(null).treasury, 0);
});

test("treasury: 税率の現行決定は維持（上限 10%・既定 5%）", () => {
  assert.equal(wb.TAX_RATE_MAX, 0.1);
  assert.equal(wb.TAX_RATE_DEFAULT, 0.05);
});

test("treasury: 入金の配線（税・入国料・出金料が国庫へ積まれる）", () => {
  const shopRoute = fs.readFileSync(path.join(rootDir, "app/api/worldbox/guild-shop/route.ts"), "utf8");
  assert.ok(shopRoute.includes("treasury: cur.treasury + tax"), "ギルドショップの税が国庫へ積まれていない");
  assert.ok(shopRoute.includes("taxCollected: cur.taxCollected + tax"), "累計税収の加算が消えている");
  const nationsRoute = fs.readFileSync(path.join(rootDir, "app/api/worldbox/nations/route.ts"), "utf8");
  const feeAdds = nationsRoute.split("treasury: cur.treasury + fee").length - 1;
  assert.equal(feeAdds, 2, "入国料・出金料の両方が国庫へ積まれていない");
  assert.ok(nationsRoute.includes("feesCollected: cur.feesCollected + fee"), "手数料収入の累計加算が消えている");
});

test("treasury: 設定 API のビューとギルドボードの表示", () => {
  const settingsRoute = fs.readFileSync(path.join(rootDir, "app/api/worldbox/nation-settings/route.ts"), "utf8");
  assert.ok(settingsRoute.includes("treasury: settings.treasury"), "設定ビューの国庫残高が配線されていない");
  const panel = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxGuildBoardPanel.tsx"), "utf8");
  assert.ok(panel.includes("treasury: number"), "パネルの型に国庫がない");
  assert.ok(panel.includes("国庫"), "パネルに国庫の行がない");
  assert.ok(panel.includes("nsData.treasury"), "パネルが国庫残高を表示していない");
});
