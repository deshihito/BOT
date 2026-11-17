// WORLD BOX 国庫の引き出し（経済仕様書 §3、バッチE6）の検証:
// - earn 理由 nation_treasury_withdraw が TS / Python 両側の
//   ホワイトリストにあり、buildEconomyOp が earn を組み立てられる
// - 設定 API に withdraw_treasury（王のみ・先行差し引き・失敗/部分払い
//   の差額返金）の配線がある
// - ギルドボードの引き出し UI（王のみ・候補額＋全額）の配線がある
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

const bridge = await loadBundle(
  ["worldbox/economy-bridge.ts"],
  ["EARN_REASONS", "buildEconomyOp", "ECONOMY_AMOUNT_MAX"],
);

test("withdraw: 理由が TS / Python 両側の earn ホワイトリストにある", () => {
  assert.ok(bridge.EARN_REASONS.has("nation_treasury_withdraw"));
  const py = fs.readFileSync(
    path.join(rootDir, "..", "core", "general", "circulation", "worldbox_economy.py"),
    "utf8",
  );
  const m = /EARN_REASONS = frozenset\(\{([^}]*)\}\)/.exec(py);
  assert.ok(m, "Python 側に EARN_REASONS が見つからない");
  const pyReasons = new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  assert.ok(pyReasons.has("nation_treasury_withdraw"));
});

test("withdraw: buildEconomyOp が引き出し earn を組み立て、範囲外を弾く", () => {
  const op = bridge.buildEconomyOp(
    {
      kind: "earn",
      userKey: "discord:111111111111111111",
      discordId: "111111111111111111",
      amount: 5000,
      reason: "nation_treasury_withdraw",
    },
    "op-00000001",
    1_700_000_000_000,
  );
  assert.ok(op);
  assert.equal(op.kind, "earn");
  assert.equal(op.amount, 5000);
  const tooBig = bridge.buildEconomyOp(
    {
      kind: "earn",
      userKey: "discord:111111111111111111",
      discordId: "111111111111111111",
      amount: bridge.ECONOMY_AMOUNT_MAX + 1,
      reason: "nation_treasury_withdraw",
    },
    "op-00000002",
    1_700_000_000_000,
  );
  assert.equal(tooBig, null);
});

test("withdraw: 設定 API の配線（王のみ・差し引き→オプ→差額返金）", () => {
  const route = fs.readFileSync(
    path.join(rootDir, "app", "api", "worldbox", "nation-settings", "route.ts"),
    "utf8",
  );
  assert.ok(route.includes('fields.action === "withdraw_treasury"'));
  assert.ok(route.includes('err("king_only", 403)'), "王チェックが前提");
  assert.ok(route.includes('reason: "nation_treasury_withdraw"'));
  assert.ok(route.includes("insufficient_treasury"));
  assert.ok(route.includes("appliedAmount"), "部分払いの差額返金がある");
  assert.ok(route.includes("waitForOpDone"));
  const idx = route.indexOf('fields.action === "withdraw_treasury"');
  const kingIdx = route.indexOf('err("king_only", 403)');
  assert.ok(kingIdx >= 0 && kingIdx < idx, "引き出しは王チェックの後");
});

test("withdraw: ギルドボードの引き出し UI の配線", () => {
  const panel = fs.readFileSync(
    path.join(rootDir, "app", "games", "worldbox", "WorldBoxGuildBoardPanel.tsx"),
    "utf8",
  );
  assert.ok(panel.includes("TREASURY_WITHDRAW_STEPS"));
  assert.ok(panel.includes('action: "withdraw_treasury"'));
  assert.ok(panel.includes("全額"));
  assert.ok(panel.includes("insufficient_treasury"));
});
