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

test("ボタンとメニューの両方から開ける", () => {
  assert.match(client, /マップ\{mapView \? "を閉じる" : "を見る"\}/);
  assert.match(client, /id: "mapview"/);
  assert.match(client, /黄色い丸 = あなた/);
});
