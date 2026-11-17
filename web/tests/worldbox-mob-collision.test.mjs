// AGO WORLD BOX モブの占有当たり判定と接触のテスト。
// - 占有タイル列挙と BlockedTiles 合成（combat.ts の純粋関数）
// - 敵対接触時のノックバック先（占有の外へ出る）
// - クライアントの配線（移動衝突・接触・fx）
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

const url = bundleModule(
  ["worldbox/rng.ts", "worldbox/mapgen.ts", "worldbox/maplogic.ts", "worldbox/items.ts", "worldbox/mobs.ts", "worldbox/combat.ts"],
  ["mobFootprintTiles", "mobBlockedTiles", "knockbackTarget", "mobOccupiesTile", "mobFootprintBounds"],
);
const wb = await import(url);

test("mobFootprintTiles: サイズぶんのタイルをアンカー中心に列挙する", () => {
  assert.deepEqual(wb.mobFootprintTiles(1, 10, 20), ["10,20"]);
  const two = wb.mobFootprintTiles(2, 10, 20);
  assert.equal(two.length, 4);
  // 偶数サイズは左上が anchor - size/2（mobFootprintBounds の規則）
  assert.ok(two.includes("10,20") && two.includes("9,19"));
  assert.equal(wb.mobFootprintTiles(3, 0, 0).length, 9);
  assert.equal(wb.mobFootprintTiles(20, 100, 100).length, 400);
});

test("mobBlockedTiles: 複数モブの占有を重複なく合成する", () => {
  const blocked = wb.mobBlockedTiles([
    { size: 1, x: 5, y: 5 },
    { size: 3, x: 6, y: 5 },
    { size: 1, x: 5, y: 5 },
  ]);
  // size3 at (6,5) covers x 5..7, y 4..6 = 9 tiles; size1 (5,5) is inside it
  assert.equal(blocked.size, 9);
  assert.ok(blocked.has("5,5") && blocked.has("7,6"));
  assert.ok(!blocked.has("8,5"));
  assert.equal(wb.mobBlockedTiles([]).size, 0);
});

test("knockbackTarget: モブから離れる方向へ押し出し、着地点は占有の外", () => {
  // size1 モブの東にいるプレイヤーはさらに東へ
  const t1 = wb.knockbackTarget({ x: 10, y: 10, size: 1 }, { x: 11.5, y: 10.5 });
  assert.ok(t1.x > 11.5, `x=${t1.x}`);
  assert.equal(wb.mobOccupiesTile(1, 10, 10, Math.floor(t1.x), Math.floor(t1.y)), false);
  // size5 の占有中心にいるプレイヤーは占有の外まで伸びる
  const t2 = wb.knockbackTarget({ x: 20, y: 20, size: 5 }, { x: 20.6, y: 20.5 });
  assert.equal(wb.mobOccupiesTile(5, 20, 20, Math.floor(t2.x), Math.floor(t2.y)), false);
  // ちょうど中心でも壊れず有限の着地点を返す
  const t3 = wb.knockbackTarget({ x: 0, y: 0, size: 1 }, { x: 0.5, y: 0.5 });
  assert.ok(Number.isFinite(t3.x) && Number.isFinite(t3.y));
});

test("クライアント: 占有が移動判定へ合成され、接触でノックバックと hit fx が発火する", () => {
  const client = fs.readFileSync(path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"), "utf8");
  assert.ok(client.includes("mobBlockedTiles("), "占有タイルの合成が無い");
  assert.ok(client.includes("mobFrameBlocked"), "フレーム上書きが activeBlocked に繋がっていない");
  assert.ok(client.includes("mobFootprintTiles("), "真上に立つモブの占有除外が無い");
  assert.ok(client.includes("contactMobKeyNow"), "接触状態の保持が無い");
  assert.ok(client.includes("knockbackTarget("), "ノックバックが配線されていない");
  assert.ok(client.includes("contactFiredAt"), "接触の再発火間隔が無い");
  // ノックバックは瞬間移動でなく初速＋減衰（kbVel を stepMove で適用する）
  assert.ok(client.includes("kbVel"), "ノックバックの速度適用が無い");
  assert.ok(!client.includes("const free = findFreeNear(activeMap(), target.x, target.y"), "接触で瞬間移動している");
  // stepMove の呼び出し形（時間ステップはヒットストップ対応の sdt）
  assert.ok(
    client.includes('stepMove(activeMap(), player, vel, sdt, activeBlocked(), { swim: space === "world" })'),
    "stepMove の呼び出しが変わっている",
  );
});
