// AGO WORLD BOX マップ表示モードの配線検証:
// - 全体マップを大きく描くキャンバスと、地形の事前描画がある
// - ミニマップと同じマーカー（首都・建物・他プレイヤー・自分）を描く
// - ボタンと ≡ メニューの両方から開ける
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const rootDir = path.join(import.meta.dirname, "..");
const client = fs.readFileSync(
  path.join(rootDir, "app/games/worldbox/WorldBoxClient.tsx"),
  "utf8",
);

test("マップ表示モードの状態とキャンバスがある", () => {
  assert.match(client, /mapView/);
  assert.match(client, /bigMapRef/);
  assert.match(client, /BIGMAP_SIZE = 512/);
  assert.match(client, /sampleMinimapTiles\(map, BIGMAP_SIZE\)/);
});

test("大きなマップにもマーカーを描く（首都・建物・他プレイヤー・自分）", () => {
  assert.match(client, /bigTerrainCanvas/);
  assert.match(client, /nationsRef\.current\.nations/);
  assert.match(client, /buildingsRef\.current\.buildings/);
  assert.match(client, /others\.values\(\)/);
});

test("左上の ≡ メニューから開ける（ボタン行には統合済み）", () => {
  assert.match(client, /id: "mapview"/);
  assert.match(client, /label: mapView \? "マップを閉じる" : "マップを見る"/);
  // 共有ノートの方針: 画面内に説明文を置かない（凡例も置かない）
  assert.ok(!client.includes("黄色い丸 = あなた"), "マップの凡例（説明文）が残っている");
});
