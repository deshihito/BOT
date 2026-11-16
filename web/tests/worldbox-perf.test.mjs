// AGO WORLD BOX のラグ対策の配線テスト:
// - オンラインセーブは3秒に1回へ間引く（keepalive は即時）
// - キャンバスの解像度は最大1.5倍に抑える
// - 地形タイルは整数ピクセルへスナップして描く（地形と上書きで同じ座標）
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await readFile(new URL("../app/games/worldbox/WorldBoxClient.tsx", import.meta.url), "utf8");

test("オンラインセーブは間引かれ、keepalive は即時送信される", () => {
  assert.match(client, /const wait = 3000 - \(performance\.now\(\) - lastOnlineSaveAt\)/);
  assert.match(client, /onlineSaveTimer = window\.setTimeout/);
  assert.match(client, /if \(keepalive\) \{[\s\S]{0,200}sendOnlineSave\(true\)/);
  // 間引きタイマーは破棄時に止める
  assert.match(client, /if \(onlineSaveTimer !== null\) window\.clearTimeout\(onlineSaveTimer\)/);
});

test("キャンバスの DPR は最大1.5倍（リサイズと描画で一致）", () => {
  const hits = client.match(/Math\.min\(1\.5, window\.devicePixelRatio \|\| 1\)/g) ?? [];
  assert.equal(hits.length, 2);
});

test("地形とタイル上書きは整数スナップした同じ原点で描く", () => {
  assert.match(client, /const tileOriginX = Math\.round\(toScreenX\(tx0\)\)/);
  assert.match(client, /const tileSx = \(tx: number\) => tileOriginX \+ \(tx - tx0\) \* TILE/);
  const uses = client.match(/const sx = tileSx\(tx\);/g) ?? [];
  assert.equal(uses.length, 2);
});
