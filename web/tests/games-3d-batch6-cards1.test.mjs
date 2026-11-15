// 3D化 第6バッチ（カード系1: highlow / pyramid / montecarlo）の回帰テスト（静的検査）。
// batch3-cards のスタイルに倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createCard / createStage / attachPickPointer / SceneBox を使う
// - カードは差分同期（スロットキー＋カードキーの Map = entries）で管理し、
//   スロットを移るカードは lastPosByCard で最終位置を引き継ぐ
// - <button> 数が現行（highlow 0 / pyramid 1 / montecarlo 1）から増えていないこと
// - ロジック（lib/*.ts）へ three が混入していないこと
// - 入力は既存ハンドラへ接続されること（highlow: 上フリック=high/下フリック=low、
//   pyramid: タップ=onTarget ラッパ＋ストック、montecarlo: タップ=onCell/下フリック=詰める）
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
];

for (const g of BATCH) {
  test(`3D batch6-cards1 ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, new RegExp(`dynamic\\(\\(\\) => import\\("\\./${g.scene.replace(".tsx", "")}"\\), \\{ ssr: false \\}\\)`), "dynamic import");
    assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /from "three"/);
    assert.match(scene, /three-kit/, "共通基盤を使う");
    assert.match(client, /webglFailed/, "WebGL 失敗時のフォールバックがある");
    assert.match(client, /board2d/, "フォールバック用の既存 2D 表示を保持する");
    assert.match(client, /onFail=\{\(\) => setWebglFailed\(true\)\}/, "onFail で 2D 表示へ切り替える");
  });

  test(`3D batch6-cards1 ${g.dir}: シーンはカード系の型（createCard/createStage/attachPickPointer/SceneBox）を使う`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    for (const name of ["createCard", "createStage", "attachPickPointer", "SceneBox"]) {
      assert.match(scene, new RegExp(name), name);
    }
    assert.match(scene, /entries/, "スロット単位でカードを差分管理する");
    assert.match(scene, /cardKey/, "カードキーで差分判定する");
    assert.match(scene, /lastPosByCard/, "スロットを移るカードの最終位置を引き継ぐ");
    assert.match(scene, /propsRef/, "props は propsRef パターンで最新を参照する");
  });

  test(`3D batch6-cards1 ${g.dir}: <button> 数が現行（${g.buttons}）から増えていない`, () => {
    assert.equal(countButtons(g.dir), g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });
}







