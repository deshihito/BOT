// AGO WORLD BOX マップ表示モードの配線検証:
// - プレイヤー中心の周辺図を大きく描くキャンバスと、地形の事前描画がある
// - ミニマップと同じマーカー（首都・他プレイヤー・自分）を描く
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
  // 周辺図: プレイヤー中心の範囲（BIGMAP_TILES）を地形キャンバスへ描く
  assert.match(client, /BIGMAP_TILES = 256/);
  assert.match(client, /paintLocalTerrain\(bigTerrainCanvas/);
});

test("ミニマップもプレイヤー中心の周辺図（全体図ではない）", () => {
  assert.match(client, /MINIMAP_TILES = 128/);
  assert.match(client, /paintLocalTerrain\(miniTerrainCanvas/);
  assert.ok(!client.includes("sampleMinimapTiles"), "全体マップの間引きが残っている");
  assert.ok(!client.includes("全体マップ"), "全体マップ表記が残っている");
});

test("大きなマップにもマーカーを描く（首都・他プレイヤー・自分。建物マーカーは廃止）", () => {
  assert.match(client, /bigTerrainCanvas/);
  assert.match(client, /nationsRef\.current\.nations/);
  assert.match(client, /others\.values\(\)/);
  // 旧プレハブ建物のマーカーは建物システムの廃止に伴い撤去済み
  assert.ok(!client.includes("buildingsRef"), "建物マーカーが残っている");
});

test("左上の ≡ メニューから開ける（ボタン行には統合済み）", () => {
  assert.match(client, /id: "mapview"/);
  assert.match(client, /label: mapView \? "マップを閉じる" : "マップを見る"/);
  // 共有ノートの方針: 画面内に説明文を置かない（凡例も置かない）
  assert.ok(!client.includes("黄色い丸 = あなた"), "マップの凡例（説明文）が残っている");
});
