// AGO WORLD BOX 開拓のコンパスの検証:
// - カタログ: 価格 10,000・道具カテゴリ・販売対象（レア除外に掛からない、
//   道具屋の品目に含まれる）・アイコン登録と実在
// - 最寄り探索: スーパーセル候補のリング探索が、全チャンク走査の
//   ブルートフォースと一致する（既知シード・複数座標）
// - 探索上限と決定性、方位角の整合
// - クライアント配線: 所持時のみ・ワールド空間でのみ HUD が出る分岐
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

const cat = await loadBundle(
  ["worldbox/items.ts", "worldbox/shops.ts"],
  ["ITEMS", "ITEM_ICON_IDS", "itemById", "isShopExcluded", "itemsForGenre", "genreOfItem"],
);
const cp = await loadBundle(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/maplogic.ts", "worldbox/compass.ts"],
  ["MAP_SEED", "CHUNK_SIZE", "structuresForChunk", "nearestEntrance", "nearestEntrances", "COMPASS_MAX_TILES"],
);

test("compass: カタログ（価格10,000・道具・販売対象・アイコン）", () => {
  const def = cat.itemById("explorer_compass");
  assert.ok(def, "開拓のコンパスがカタログに無い");
  assert.equal(def.name, "開拓のコンパス");
  assert.equal(def.price, 10000);
  assert.equal(def.category, "tool");
  // tool 種別は持たない（伐採等の道具判定に使わない）
  assert.equal(def.tool, undefined);
  // レア品の販売除外に掛からず、道具屋で買える
  assert.equal(cat.isShopExcluded(def), false);
  assert.equal(cat.genreOfItem("explorer_compass"), "tools");
  assert.ok(cat.itemsForGenre("tools").some((i) => i.id === "explorer_compass"));
  // アイコン登録と実在
  assert.ok(cat.ITEM_ICON_IDS.includes("explorer_compass"));
  assert.equal(def.icon, "/img/worldbox/items/explorer_compass.png");
  assert.ok(
    fs.existsSync(path.join(rootDir, "public/img/worldbox/items/explorer_compass.png")),
    "アイコン PNG が無い",
  );
});

/** 全チャンク走査のブルートフォース（探索の正）。 */
function bruteForce(x, y, radiusChunks) {
  const pcx = Math.floor(x / cp.CHUNK_SIZE);
  const pcy = Math.floor(y / cp.CHUNK_SIZE);
  let cave = null;
  let dungeon = null;
  for (let cy = pcy - radiusChunks; cy <= pcy + radiusChunks; cy++) {
    for (let cx = pcx - radiusChunks; cx <= pcx + radiusChunks; cx++) {
      for (const st of cp.structuresForChunk(cp.MAP_SEED, cx, cy)) {
        const tx = st.x + 0.5;
        const ty = st.y + 0.5;
        const dist = Math.hypot(tx - x, ty - y);
        if (st.structureId === "cave_entrance" && (!cave || dist < cave.dist)) cave = { x: tx, y: ty, dist };
        if (st.structureId === "dungeon_entrance" && (!dungeon || dist < dungeon.dist)) dungeon = { x: tx, y: ty, dist };
      }
    }
  }
  return { cave, dungeon };
}

test("compass: 最寄り探索がブルートフォースと一致する", () => {
  const points = [
    [0.5, 0.5], [100.5, 100.5], [-500.5, 300.5], [1234.5, -987.5],
    [50.5, -2200.5], [-3000.5, -3000.5], [777.5, 555.5], [-64.5, 2048.5],
  ];
  for (const [x, y] of points) {
    const near = cp.nearestEntrances(cp.MAP_SEED, x, y);
    const bf = bruteForce(x, y, 48); // ±48チャンク = ±1536タイル
    for (const kind of ["cave", "dungeon"]) {
      assert.ok(bf[kind], `ブルートフォース側で ${kind} が見つからない (${x},${y})`);
      assert.ok(near[kind], `リング探索で ${kind} が見つからない (${x},${y})`);
      assert.equal(near[kind].x, bf[kind].x, `${kind} の x が一致しない (${x},${y})`);
      assert.equal(near[kind].y, bf[kind].y, `${kind} の y が一致しない (${x},${y})`);
      assert.ok(Math.abs(near[kind].dist - bf[kind].dist) < 1e-9, `${kind} の距離が一致しない (${x},${y})`);
      assert.equal(near[kind].kind, kind);
      // 方位角は対象への atan2 と一致する
      const ang = Math.atan2(near[kind].y - y, near[kind].x - x);
      assert.ok(Math.abs(near[kind].angle - ang) < 1e-9, `${kind} の方位角が一致しない (${x},${y})`);
    }
  }
});

test("compass: 決定性と探索上限", () => {
  const a = cp.nearestEntrances(cp.MAP_SEED, 0.5, 0.5);
  const b = cp.nearestEntrances(cp.MAP_SEED, 0.5, 0.5);
  assert.deepEqual(a, b);
  // 上限 10 タイルでは原点付近の入口（最寄りでも数百タイル先）に届かない
  assert.equal(cp.nearestEntrance(cp.MAP_SEED, "cave", 0.5, 0.5, 10), null);
  assert.equal(cp.nearestEntrance(cp.MAP_SEED, "dungeon", 0.5, 0.5, 10), null);
  // 既定上限は十分に大きく、両方とも見つかる
  assert.ok(cp.COMPASS_MAX_TILES >= 1024);
  assert.ok(a.cave && a.dungeon);
  assert.ok(a.cave.dist <= cp.COMPASS_MAX_TILES && a.dungeon.dist <= cp.COMPASS_MAX_TILES);
});

test("compass: クライアント配線（所持時のみ・ワールドのみ HUD が出る）", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  // 純粋ロジックを読み、最寄り探索を呼ぶ
  assert.match(client, /from "@\/lib\/worldbox\/compass"/);
  assert.match(client, /nearestEntrances\(MAP_SEED, player\.x, player\.y\)/);
  // 所持判定（プロフィールの所持数）でのみ表示する
  assert.match(client, /countItem\(invProfile, "explorer_compass"\) > 0/);
  assert.match(client, /countItem\(invRef\.current, "explorer_compass"\) > 0/);
  // HUD はワールド空間＋所持時のみ（ロビー/テント/インスタンスでは出さない）
  assert.match(client, /spaceUi === "world" && hasCompass/);
  assert.match(client, /aria-label="開拓のコンパス"/);
  // ミニマップへのマーカー/矢印描画
  assert.match(client, /drawCompassOnMinimap/);
});
