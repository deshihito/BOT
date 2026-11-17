import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// AGO WORLD BOX の線路（仕様書E2）の検証。
// 線路は床ブロックとして置かれ、4近傍の連結成分が路線になる。
// サプライライン（首都接続で収穫/採掘+1）と線路ワープ（同成分内移動）の
// 純粋ロジック、および tiles へのボーナス配線を確かめる。

function transpile(rel) {
  const src = readFileSync(new URL(`../lib/${rel}`, import.meta.url), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function stripModuleSyntax(code) {
  const kept = [];
  let skippingImport = false;
  for (const line of code.split("\n")) {
    const t = line.trimStart();
    if (skippingImport) {
      if (line.includes(";")) skippingImport = false;
      continue;
    }
    if (t.startsWith("import ")) {
      if (!line.includes(";")) skippingImport = true;
      continue;
    }
    if (t.startsWith("export default ")) {
      kept.push(line.replace(/^(\s*)export\s+default\s+/, "$1"));
      continue;
    }
    if (t.startsWith("export ")) {
      kept.push(line.replace(/^(\s*)export\s+/, "$1"));
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function bundleModule(files, names) {
  const code = files.map((name) => stripModuleSyntax(transpile(name))).join("\n");
  return `data:text/javascript,${encodeURIComponent(`${code}\nexport { ${names.join(", ")} };`)}`;
}

const T = await import(bundleModule(
  [
    "worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/items.ts", "worldbox/profile.ts",
    "worldbox/presence.ts", "worldbox/seasons.ts", "worldbox/tiles.ts", "worldbox/rails.ts",
  ],
  [
    "worldTileSource", "mapTileAt", "T_GRASS", "T_ROCK",
    "itemById", "RECIPES", "recipeById", "parseProfile", "countItem",
    "applyTileAction", "tileKey", "isFloorItem",
    "RAIL_ITEM_ID", "railKeysOf", "isRailAt", "railComponent",
    "componentTouchesCapital", "isSupplyConnected", "railStops", "railRideError",
  ],
));

const NOW = 1_700_000_000_000;
const ME_KEY = "discord:111111111111111111";

function withItems(items) {
  return T.parseProfile({ items });
}

function railOv(x, y) {
  return { ownerId: "p", block: { itemId: "rail", ownerId: "p" } };
}

/** テスト用の線路配置: 本線A（曲がり＋分岐）・独立線B・斜めだけの組C。 */
function sampleOverrides() {
  const ov = {};
  const put = (x, y) => { ov[T.tileKey(x, y)] = railOv(x, y); };
  // 本線A: (0,0)-(1,0)-(2,0)-(2,1)-(2,2) と分岐 (3,0)
  for (const [x, y] of [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [3, 0]]) put(x, y);
  // 独立線B
  put(10, 10); put(11, 10);
  // 斜めだけの組C（4近傍ではつながらない）
  put(5, 5); put(6, 6);
  return ov;
}

const CAPITAL = { x: 2, y: 3 };

// ---------- カタログ ----------

test("カタログ: 線路はブロックで、レシピは木材2＋鉄インゴット1→4本", () => {
  const rail = T.itemById("rail");
  assert.ok(rail);
  assert.equal(rail.category, "block");
  const recipe = T.recipeById("rail");
  assert.ok(recipe);
  assert.equal(recipe.output, "rail");
  assert.equal(recipe.outputCount, 4);
  assert.deepEqual({ ...recipe.inputs }, { wood: 2, iron_ingot: 1 });
});

test("カタログ: 線路は床ブロック（上に乗れる）", () => {
  assert.equal(T.isFloorItem("rail"), true);
  assert.equal(T.RAIL_ITEM_ID, "rail");
});

// ---------- 連結成分 ----------

test("成分: 本線Aは分岐込みで6タイル、独立線とは混ざらない", () => {
  const ov = sampleOverrides();
  const comp = T.railComponent(ov, T.tileKey(0, 0));
  assert.equal(comp.size, 6);
  assert.ok(comp.has(T.tileKey(3, 0)), "分岐も同じ成分");
  assert.ok(comp.has(T.tileKey(2, 2)));
  assert.ok(!comp.has(T.tileKey(10, 10)), "独立線は別成分");
});

test("成分: 斜めだけではつながらない（4近傍）", () => {
  const ov = sampleOverrides();
  const comp = T.railComponent(ov, T.tileKey(5, 5));
  assert.equal(comp.size, 1);
  assert.ok(!comp.has(T.tileKey(6, 6)));
});

test("成分: 線路でないタイルからは空集合", () => {
  const ov = sampleOverrides();
  assert.equal(T.railComponent(ov, T.tileKey(0, 1)).size, 0);
  assert.equal(T.railKeysOf(ov).size, 10);
  assert.equal(T.isRailAt(ov, 2, 1), true);
  assert.equal(T.isRailAt(ov, 2, 3), false);
});

// ---------- 首都接続とサプライライン ----------

test("首都接続: 本線Aは首都 (2,3) に触れ、独立線Bは触れない", () => {
  const ov = sampleOverrides();
  assert.equal(T.componentTouchesCapital(T.railComponent(ov, T.tileKey(0, 0)), CAPITAL), true);
  assert.equal(T.componentTouchesCapital(T.railComponent(ov, T.tileKey(10, 10)), CAPITAL), false);
});

test("サプライ: 首都接続した線路に隣接する資源マスだけが接続扱い", () => {
  const ov = sampleOverrides();
  // (1,2) は線路 (2,2) に隣接し、その成分は首都に触れる
  assert.equal(T.isSupplyConnected(ov, CAPITAL, 1, 2), true);
  // (11,11) は線路 (11,10) に隣接するが、その成分は首都に触れない
  assert.equal(T.isSupplyConnected(ov, CAPITAL, 11, 11), false);
  // 線路が近くに無い場所
  assert.equal(T.isSupplyConnected(ov, CAPITAL, 50, 50), false);
});

// ---------- 線路ワープ ----------

test("行き先: 自分のタイルを除き近い順、首都隣接にはフラグ", () => {
  const ov = sampleOverrides();
  const stops = T.railStops(ov, T.tileKey(0, 0), CAPITAL);
  assert.equal(stops.length, 5);
  assert.deepEqual([stops[0].x, stops[0].y], [1, 0], "一番近いのは隣のタイル");
  const at22 = stops.find((s) => s.x === 2 && s.y === 2);
  assert.ok(at22);
  assert.equal(at22.capital, true, "(2,2) は首都 (2,3) に隣接");
  const at10 = stops.find((s) => s.x === 1 && s.y === 0);
  assert.equal(at10.capital, false);
});

test("行き先: 首都が無ければフラグは全部 false", () => {
  const ov = sampleOverrides();
  const stops = T.railStops(ov, T.tileKey(0, 0), null);
  assert.ok(stops.every((s) => s.capital === false));
});

test("乗車検証: 同成分なら null、別成分は not_connected、線路外は not_on_rail", () => {
  const ov = sampleOverrides();
  assert.equal(T.railRideError(ov, T.tileKey(0, 0), T.tileKey(2, 2)), null);
  assert.equal(T.railRideError(ov, T.tileKey(0, 0), T.tileKey(10, 10)), "not_connected");
  assert.equal(T.railRideError(ov, T.tileKey(5, 5), T.tileKey(6, 6)), "not_connected");
  assert.equal(T.railRideError(ov, T.tileKey(0, 1), T.tileKey(2, 2)), "not_on_rail");
  assert.equal(T.railRideError(ov, T.tileKey(0, 0), T.tileKey(9, 9)), "not_on_rail");
});

// ---------- tiles へのボーナス配線 ----------

function findTile(map, id, limit = 300) {
  for (let y = -limit; y < limit; y++) {
    for (let x = -limit; x < limit; x++) {
      if (T.mapTileAt(map, x, y) === id) return { x, y };
    }
  }
  throw new Error("tile not found");
}

test("配線: 補給接続した畑は収穫+1、岩は石材+1", () => {
  const map = T.worldTileSource();
  // 畑: 耕す→植える→収穫（接続あり/なしで比較）
  const grass = findTile(map, T.T_GRASS);
  const farmer = () => withItems({ wooden_hoe: 1, wheat_seed: 1 });
  const tilled = T.applyTileAction(null, farmer(), map, ME_KEY, "till", grass.x, grass.y, undefined, NOW);
  assert.equal(tilled.ok, true);
  const planted = T.applyTileAction(tilled.override, tilled.profile, map, ME_KEY, "plant", grass.x, grass.y, "wheat_seed", NOW);
  assert.equal(planted.ok, true);
  const readyAt = planted.override.crop.readyAt;
  const plain = T.applyTileAction(planted.override, planted.profile, map, ME_KEY, "harvest", grass.x, grass.y, undefined, readyAt);
  const supplied = T.applyTileAction(planted.override, planted.profile, map, ME_KEY, "harvest", grass.x, grass.y, undefined, readyAt, { supplyConnected: true });
  assert.equal(plain.ok, true);
  assert.equal(supplied.ok, true);
  assert.equal(supplied.gained.wheat, plain.gained.wheat + 1, "補給で収穫+1");

  // 岩: ミスリル2ヒットで破壊（接続あり/なしで比較）
  const rock = findTile(map, T.T_ROCK);
  const mineAll = (opts) => {
    let r = T.applyTileAction(null, withItems({ mithril_pickaxe: 1 }), map, ME_KEY, "mine", rock.x, rock.y, undefined, NOW, opts);
    assert.equal(r.ok, true);
    r = T.applyTileAction(r.override, r.profile, map, ME_KEY, "mine", rock.x, rock.y, undefined, NOW, opts);
    assert.equal(r.ok, true);
    return r;
  };
  const plainRock = mineAll(undefined);
  const suppliedRock = mineAll({ supplyConnected: true });
  assert.equal(suppliedRock.gained.stone, plainRock.gained.stone + 1, "補給で石材+1");
});
