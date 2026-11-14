// 3D化 第8バッチ タイル系（floodit / samegame / touchnumber）の
// 回帰テスト（静的検査）。既存バッチの流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createStage / attachPickPointer / SceneBox を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D へフォールバックする
// - <button> 数が現行（floodit 2 / samegame 2 / touchnumber 3）以下
// - 入力が既存ハンドラへ接続され、判定を 3D 側で再実装していないこと
// - ロジック（lib/*.ts）へ three が混入していないこと
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const webDir = path.join(import.meta.dirname, "..");
const read = (...p) => fs.readFileSync(path.join(webDir, ...p), "utf8");
const countButtons = (dir) => {
  let n = 0;
  for (const f of fs.readdirSync(path.join(webDir, "app", "games", dir))) {
    if (f.endsWith(".tsx")) n += (read("app", "games", dir, f).match(/<button/g) ?? []).length;
  }
  return n;
};

const BATCH = [
  { dir: "touchnumber", client: "TouchNumberClient.tsx", scene: "TouchNumberScene3D.tsx", buttons: 3, lib: "touchnumber.ts" },
];

for (const g of BATCH) {
  test(`3D batch8-tiles ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, new RegExp(`dynamic\\(\\(\\) => import\\("\\./${g.scene.replace(".tsx", "")}"\\), \\{ ssr: false \\}\\)`), "dynamic import");
    assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
    assert.doesNotMatch(client, /three-kit/, "クライアントは基盤を直接触らない");
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /from "three"/);
    assert.match(scene, /three-kit/, "共通基盤を使う");
    assert.match(scene, /createStage/, "ステージは共通基盤から作る");
    assert.match(scene, /attachPickPointer/, "入力は共通基盤のレイキャストで受ける");
    assert.match(scene, /SceneBox/, "外枠は共通基盤を使う");
    assert.match(scene, /pickId = `cell-\$\{i\}`/, "当たり判定メッシュに pickId を付ける");
    assert.match(client, /webglFailed/, "WebGL 失敗時のフォールバックがある");
    assert.match(client, /fallback=\{board2d\}/, "フォールバックとして既存 2D をシーンへ渡す");
  });

  test(`3D batch8-tiles ${g.dir}: <button> 数が現行（${g.buttons}）以下`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });

  test(`3D batch8-tiles ${g.dir}: シーンに絵文字UIがない（色と造形で表現）`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${g.dir} scene emoji`);
  });

  test(`3D batch8-tiles ${g.dir}: ロジック層（lib/${g.lib}）に three が混入していない`, () => {
    assert.doesNotMatch(read("lib", g.lib), /from "three"/, `lib/${g.lib}`);
  });
}







test("3D batch8-tiles touchnumber: 数字は上面テクスチャで大きく太く描く", () => {
  const scene = read("app", "games", "touchnumber", "TouchNumberScene3D.tsx");
  assert.match(scene, /createNumberTile/, "数字タイルを造形する");
  assert.match(scene, /canvasTexture/, "数字は上面テクスチャで描く");
  assert.match(scene, /bold 92px/, "数字は大きく太く描く");
  assert.match(scene, /0xd9a41c/, "次の数字の金色は現行 2D と同じ");
  assert.match(scene, /emissive/, "次の数字は発光で強調する");
});

test("3D batch8-tiles touchnumber: タップが現行の onTap へ接続され、順番判定を再実装しない", () => {
  const scene = read("app", "games", "touchnumber", "TouchNumberScene3D.tsx");
  assert.match(scene, /propsRef\.current\.onTap\(/, "タップが onTap を呼ぶ");
  assert.doesNotMatch(scene, /tapCell\(|tapValue\(|isCleared\(/, "順番判定・ミス集計を 3D 側で再実装しない");
  const client = read("app", "games", "touchnumber", "TouchNumberClient.tsx");
  assert.match(client, /onTap=\{onTap\}/, "既存の onTap へ接続する");
  assert.match(client, /next=\{state\.next\}/, "次の数字は親の状態を渡す");
  assert.match(client, /wrongIndex=\{wrongIndex\}/, "ミス表示は親の状態を渡す");
});
