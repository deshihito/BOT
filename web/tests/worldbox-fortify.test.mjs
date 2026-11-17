// WORLD BOX 要塞化（経済仕様書 §8.4、バッチE5）の検証:
// - applyFortify: 所有者だけ・最大 HP の上乗せと現在 HP の回復・上限
// - 要塞化込みの最大 HP で採掘ダメージと HP 割合が計算される
// - parse の往復（fort の検証と上限丸め）
// - ルート配線（価格の徴収・理由・クライアントのパネル）
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

const T = await import(bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/items.ts", "worldbox/profile.ts", "worldbox/presence.ts", "worldbox/seasons.ts", "worldbox/tiles.ts"],
  [
    "worldTileSource", "mapTileAt", "T_GRASS",
    "itemById", "parseProfile", "countItem",
    "applyPlaceBlock", "applyMineBlock", "applyFortify",
    "tileView", "tileKey", "parseTileOverride", "presenceIdFor",
    "FORTIFY_COST", "FORTIFY_HP_STEP", "FORTIFY_MAX_BONUS",
    "fortBonus", "blockMaxHp", "blockMaxHpFor", "blockHpFraction",
  ],
));

const map = T.worldTileSource();
function findGrass() {
  for (let y = 0; y < 1024; y++) {
    for (let x = 0; x < 1024; x++) {
      if (T.mapTileAt(map, x, y) === T.T_GRASS) return { x, y };
    }
  }
  throw new Error("grass not found");
}
const at = findGrass();
const NOW = 1_700_000_000_000;
const ME_KEY = "discord:611111111111111111";
const OTHER_KEY = "discord:622222222222222222";
const withItems = (items) => T.parseProfile({ items });

function placedBlock() {
  const p = withItems({ stone_block: 1 });
  const ok = T.applyPlaceBlock(null, p, map, ME_KEY, at.x, at.y, "stone_block", NOW, { onCapital: false });
  assert.equal(ok.ok, true);
  return ok.override;
}

test("fortify: 自分のブロックの最大 HP が上がり、現在 HP も同じだけ回復する", () => {
  const ov = placedBlock();
  const baseMax = T.blockMaxHp(T.itemById("stone_block"));
  assert.equal(ov.block.hp, baseMax);
  const p = withItems({});
  const done = T.applyFortify(ov, p, map, ME_KEY, at.x, at.y, NOW);
  assert.equal(done.ok, true);
  assert.equal(done.override.block.fort, T.FORTIFY_HP_STEP);
  assert.equal(done.override.block.hp, baseMax + T.FORTIFY_HP_STEP);
  assert.equal(T.blockMaxHpFor(done.override.block, T.itemById("stone_block")), baseMax + T.FORTIFY_HP_STEP);
  assert.equal(done.view.block.fort, T.FORTIFY_HP_STEP);
  assert.equal(done.view.block.hpFrac, 1);
});

test("fortify: 他人のブロックはできない／ブロックが無ければできない", () => {
  const ov = placedBlock();
  const p = withItems({});
  const other = T.applyFortify(ov, p, map, OTHER_KEY, at.x, at.y, NOW);
  assert.equal(other.ok, false);
  assert.equal(other.error, "not_owner");
  const none = T.applyFortify(null, p, map, ME_KEY, at.x, at.y, NOW);
  assert.equal(none.ok, false);
  assert.equal(none.error, "no_block");
});

test("fortify: 上限まで強化でき、それ以上は fortify_max", () => {
  let ov = placedBlock();
  const p = withItems({});
  const times = T.FORTIFY_MAX_BONUS / T.FORTIFY_HP_STEP;
  for (let i = 0; i < times; i++) {
    const done = T.applyFortify(ov, p, map, ME_KEY, at.x, at.y, NOW);
    assert.equal(done.ok, true, `step ${i}`);
    ov = done.override;
  }
  assert.equal(ov.block.fort, T.FORTIFY_MAX_BONUS);
  const over = T.applyFortify(ov, p, map, ME_KEY, at.x, at.y, NOW);
  assert.equal(over.ok, false);
  assert.equal(over.error, "fortify_max");
});

test("fortify: 傷ついたブロックは強化で現在 HP も回復し、採掘は要塞化込みの最大 HP で進む", () => {
  let ov = placedBlock();
  const p = withItems({});
  const baseMax = T.blockMaxHp(T.itemById("stone_block"));
  // 素手で1ヒット（ダメージ 6）入れて傷つける
  const hit = T.applyMineBlock(ov, p, map, ME_KEY, at.x, at.y, NOW, {});
  assert.equal(hit.ok, true);
  ov = hit.override;
  assert.equal(ov.block.hp, baseMax - 6);
  // 要塞化: 最大 +10、現在 HP も +10
  const done = T.applyFortify(ov, p, map, ME_KEY, at.x, at.y, NOW);
  assert.equal(done.ok, true);
  assert.equal(done.override.block.hp, baseMax - 6 + T.FORTIFY_HP_STEP);
  assert.equal(T.blockHpFraction(done.override.block), (baseMax - 6 + T.FORTIFY_HP_STEP) / (baseMax + T.FORTIFY_HP_STEP));
  // さらに1ヒット: 要塞化込みの残量から減る
  const hit2 = T.applyMineBlock(done.override, p, map, ME_KEY, at.x, at.y, NOW, {});
  assert.equal(hit2.ok, true);
  assert.equal(hit2.override.block.hp, baseMax - 6 + T.FORTIFY_HP_STEP - 6);
  assert.equal(hit2.override.block.fort, T.FORTIFY_HP_STEP, "採掘しても要塞化は残る");
});

test("fortify: parse の往復（fort の検証・上限丸め）", () => {
  const base = {
    ownerId: T.presenceIdFor(ME_KEY),
    block: { itemId: "stone_block", ownerId: T.presenceIdFor(ME_KEY), hp: 10, fort: 50 },
  };
  const parsed = T.parseTileOverride(base);
  assert.equal(parsed.block.fort, 50);
  assert.equal(T.fortBonus(parsed.block), 50);
  const capped = T.parseTileOverride({ ...base, block: { ...base.block, fort: 9999 } });
  assert.equal(capped.block.fort, T.FORTIFY_MAX_BONUS);
  const broken = T.parseTileOverride({ ...base, block: { ...base.block, fort: -3 } });
  assert.equal(broken.block.fort, undefined);
  assert.equal(T.fortBonus(broken.block), 0);
});

test("fortify: ルート配線（価格の徴収・理由・クライアント）", () => {
  const route = fs.readFileSync(path.join(rootDir, "app/api/worldbox/tiles/route.ts"), "utf8");
  assert.ok(route.includes('"fortify"'), "タイルルートに fortify の分岐がない");
  assert.ok(route.includes("applyFortify"), "ルートが applyFortify を呼んでいない");
  assert.ok(route.includes("fortify_block"), "徴収の理由 fortify_block が配線されていない");
  assert.ok(route.includes("chargeFortifyFee"), "価格の交付ゲートが配線されていない");
  assert.ok(T.FORTIFY_COST > 0, "要塞化の価格が正でない");
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("要塞化"), "クライアントに要塞化パネルがない");
  assert.ok(client.includes('"fortify"'), "クライアントが fortify を送っていない");
});
