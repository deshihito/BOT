// AGO WORLD BOX ブロック動作B（設置した作業施設とレシピ種別）の検証:
// - レシピ種別（craft/smelt/cook/weave）の分類と新規レシピ（精錬・織り）
// - 設置物→作業種別の対応（PLACED_STATION_KINDS）
// - craftItem が新規レシピでも素材を消費して成果物を出すこと
// - サーバー配線（profile ルートの workGate、station-online のワールド検証）
// - クライアント/パネル配線（設置施設の検出と種別ごとのボタン）
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

function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
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
    out.push(line.replace(/^export\s+/, ""));
  }
  return out.join("\n");
}

function bundleModule(files, names) {
  const code = files.map((name) => stripModuleSyntax(transpile(name))).join("\n");
  return dataUrl(`${code}\nexport { ${names.join(", ")} };`);
}

const ecoUrl = bundleModule(
  ["worldbox/items.ts", "worldbox/profile.ts", "worldbox/roles.ts", "worldbox/vitals.ts", "worldbox/economy.ts"],
  ["RECIPES", "recipeById", "recipeKind", "parseProfile", "countItem", "craftItem"],
);
const E = await import(ecoUrl);

const tilesUrl = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/items.ts", "worldbox/profile.ts", "worldbox/presence.ts", "worldbox/seasons.ts", "worldbox/tiles.ts"],
  ["placedStationKinds", "PLACED_STATION_KINDS"],
);
const T = await import(tilesUrl);

// ---------- レシピ種別 ----------

test("種別: 既存レシピの分類（調理・織り・既定は合成）", () => {
  assert.equal(E.recipeKind(E.recipeById("grilled_meat")), "cook");
  assert.equal(E.recipeKind(E.recipeById("stew")), "cook");
  assert.equal(E.recipeKind(E.recipeById("bread")), "cook");
  assert.equal(E.recipeKind(E.recipeById("silk_cloth")), "weave");
  assert.equal(E.recipeKind(E.recipeById("tapestry")), "weave");
  assert.equal(E.recipeKind(E.recipeById("bench")), "craft", "未指定は craft");
  assert.equal(E.recipeKind(E.recipeById("salad")), "craft", "サラダは火を使わないので合成");
});

test("種別: 精錬レシピ（鉱石→インゴット、木→木炭）がある", () => {
  const iron = E.recipeById("iron_ingot");
  assert.equal(E.recipeKind(iron), "smelt");
  assert.deepEqual({ ...iron.inputs }, { iron_ore: 2, coal: 1 });
  assert.equal(iron.output, "iron_ingot");
  assert.equal(E.recipeKind(E.recipeById("gold_ingot")), "smelt");
  assert.equal(E.recipeKind(E.recipeById("copper_ingot")), "smelt");
  const charcoal = E.recipeById("charcoal");
  assert.equal(E.recipeKind(charcoal), "smelt");
  assert.equal(charcoal.output, "charcoal");
});

test("種別: 織りレシピ（繊維→糸・布）がある", () => {
  const cloth = E.recipeById("cloth");
  assert.equal(E.recipeKind(cloth), "weave");
  assert.deepEqual({ ...cloth.inputs }, { fiber: 3 });
  const string = E.recipeById("string");
  assert.equal(E.recipeKind(string), "weave");
  assert.deepEqual({ ...string.inputs }, { fiber: 2 });
});

test("種別: レシピ総数は 170（164 + 精錬4 + 織り2）", () => {
  assert.equal(E.RECIPES.length, 170);
  const kinds = { craft: 0, smelt: 0, cook: 0, weave: 0 };
  for (const r of E.RECIPES) kinds[E.recipeKind(r)] += 1;
  assert.equal(kinds.smelt, 4);
  assert.equal(kinds.cook, 12);
  assert.equal(kinds.weave, 5);
});

// ---------- 合成の実処理 ----------

test("精錬: craftItem が鉱石と石炭を消費してインゴットを出す", () => {
  const profile = E.parseProfile({ items: { iron_ore: 2, coal: 1 } });
  const r = E.craftItem(profile, "iron_ingot");
  assert.equal(r.ok, true);
  assert.equal(E.countItem(r.profile, "iron_ingot"), 1);
  assert.equal(E.countItem(r.profile, "iron_ore"), 0);
  assert.equal(E.countItem(r.profile, "coal"), 0);
});

test("織り: craftItem が繊維を消費して布を出す／素材不足は失敗", () => {
  const profile = E.parseProfile({ items: { fiber: 3 } });
  const r = E.craftItem(profile, "cloth");
  assert.equal(r.ok, true);
  assert.equal(E.countItem(r.profile, "cloth"), 1);
  const poor = E.craftItem(E.parseProfile({ items: { fiber: 2 } }), "cloth");
  assert.equal(poor.ok, false);
});

// ---------- 設置物 → 作業種別 ----------

test("設置施設: 作業種別の対応", () => {
  assert.deepEqual([...T.placedStationKinds("workbench")], ["craft"]);
  assert.deepEqual([...T.placedStationKinds("smithing_table")], ["craft", "enhance"]);
  assert.deepEqual([...T.placedStationKinds("anvil")], ["enhance"]);
  assert.deepEqual([...T.placedStationKinds("furnace")], ["smelt"]);
  assert.deepEqual([...T.placedStationKinds("campfire")], ["cook"]);
  assert.deepEqual([...T.placedStationKinds("cooking_pot")], ["cook"]);
  assert.deepEqual([...T.placedStationKinds("loom")], ["weave"]);
  assert.deepEqual([...T.placedStationKinds("bench")], []);
  assert.deepEqual([...T.placedStationKinds(null)], []);
  assert.deepEqual([...T.placedStationKinds("nope")], []);
});

// ---------- 配線 ----------

const routeSrc = fs.readFileSync(path.join(rootDir, "app/api/worldbox/profile/route.ts"), "utf8");
const stationSrc = fs.readFileSync(path.join(libDir, "worldbox/station-online.ts"), "utf8");
const clientSrc = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
const panelSrc = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxEconomyPanel.tsx"), "utf8");

test("配線: サーバーは設置施設でも作業を検証する", () => {
  assert.ok(stationSrc.includes("loadMyWorldStationKinds"), "ワールド設置施設の検証がある");
  assert.ok(stationSrc.includes("placedStationKinds"), "タイル上書きから種別を引く");
  assert.ok(routeSrc.includes("workGate"), "profile ルートに作業ゲートがある");
  assert.ok(routeSrc.includes('workGate("enhance")'), "強化は enhance 種別で検証");
  assert.ok(routeSrc.includes("recipeKind(recipe)"), "合成はレシピ種別で検証");
});

test("配線: クライアントとパネルが設置施設の種別で表示を合わせる", () => {
  assert.ok(clientSrc.includes("placedStationKinds(ov?.block?.itemId)"), "クライアントが近くの設置施設を検出する");
  assert.ok(clientSrc.includes("worldStationKinds={worldStationKinds}"), "パネルへ種別を渡す");
  assert.ok(panelSrc.includes("canWork"), "パネルが種別ごとに可否を出す");
  assert.ok(panelSrc.includes('canWork("enhance")'), "強化欄は enhance のときだけ");
});
