// WORLD BOX バッチ7残件: ギルドショップの純粋ロジックテスト。
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

const G = await loadBundle(
  ["worldbox/guild-shop.ts"],
  [
    "GUILD_PLOT_COUNT", "GUILD_PLOT_FEE", "GUILD_PLOT_ANCHORS", "emptyGuildShopState",
    "parseGuildShopState", "listingAvailable", "sellerProceeds", "plotOfGuild", "findListing",
  ],
);

test("guild-shop: anchors match the 6 lobby plots", () => {
  assert.equal(G.GUILD_PLOT_ANCHORS.length, G.GUILD_PLOT_COUNT);
  assert.equal(G.GUILD_PLOT_FEE, 500);
});

test("guild-shop: seller proceeds take the 5% fee (floored)", () => {
  assert.equal(G.sellerProceeds(100, 1), 95);
  assert.equal(G.sellerProceeds(100, 3), 285);
  assert.equal(G.sellerProceeds(33, 1), 31);
  assert.equal(G.sellerProceeds(1, 1), 0);
});

test("guild-shop: state parse keeps valid plots/listings only", () => {
  const state = G.parseGuildShopState({
    plots: [
      { idx: 2, guildId: "g1", listings: [
        { id: "l1", sellerKey: "discord:1", itemId: "wood", count: 5, sold: 2, price: 40 },
        { id: "bad", sellerKey: "discord:1", itemId: "wood", count: 0, sold: 0, price: 40 },
        { id: "bad2", sellerKey: "discord:1", itemId: "wood", count: 3, sold: 9, price: 40 },
      ] },
      { idx: 99, guildId: "gX", listings: [] },
      null,
    ],
    listingSeq: 7,
    feeSeq: 2,
  });
  assert.equal(state.plots.length, G.GUILD_PLOT_COUNT);
  assert.equal(state.plots[2].guildId, "g1");
  assert.equal(state.plots[2].listings.length, 1);
  assert.equal(G.listingAvailable(state.plots[2].listings[0]), 3);
  assert.equal(state.listingSeq, 7);
  assert.equal(state.feeSeq, 2);
  const found = G.findListing(state, "l1");
  assert.equal(found.plot.idx, 2);
  assert.equal(G.plotOfGuild(state, "g1").idx, 2);
  assert.equal(G.plotOfGuild(state, "nope"), null);
  assert.deepEqual(G.parseGuildShopState("junk"), G.emptyGuildShopState());
  // JSON 文字列からも復元できる
  const back = G.parseGuildShopState(JSON.stringify(state));
  assert.deepEqual(back, state);
});
