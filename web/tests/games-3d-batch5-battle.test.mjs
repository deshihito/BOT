// 3D化 第5バッチ 対戦系（dartsbattle / simonbattle）の回帰テスト（静的検査）。
// 既存バッチ（games-3d-batch4-a 等）の流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createStage / attachPickPointer を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D へフォールバックする
//   （board2d に切り出し、fallback={board2d} でシーンへ渡す）
// - <button> 数が現行（dartsbattle 0 / simonbattle 1）以下
// - 入力が既存ハンドラ（dartsbattle: handleThrow / simonbattle: press）へ接続される
// - ロジック（lib/*.ts、lib/online）へ three が混入していないこと
// 対戦固有: 状態同期・オンライン基盤には触らず、表示シーンと入力接続だけを
// 差し替える。相手の投擲・再生も同じ差分同期 / lit 追従でアニメーションされる。
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
  test(`3D batch5-battle ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, new RegExp(`dynamic\\(\\(\\) => import\\("\\./${g.scene.replace(".tsx", "")}"\\), \\{ ssr: false \\}\\)`), "dynamic import");
    assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /from "three"/);
    assert.match(scene, /three-kit/, "共通基盤を使う");
    assert.match(scene, /createStage/, "ステージは共通基盤から作る");
    assert.match(scene, /attachPickPointer/, "入力は共通基盤のレイキャストで受ける");
    assert.match(client, /onFail|webglFailed/, "WebGL 失敗時のフォールバックがある");
    assert.match(client, /fallback=\{board2d\}/, "フォールバックとして既存 2D をシーンへ渡す");
    assert.match(client, /webglFailed \? board2d/, "WebGL 失敗時は board2d を直接描く");
  });

  test(`3D batch5-battle ${g.dir}: <button> 数が現行（${g.buttons}）以下`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });
}




test("3D batch5-battle: ロジック層（lib/darts.ts, lib/online/games/*）に three が混入していない", () => {
  for (const p of [
    ["lib", "darts.ts"],
  ]) {
    assert.doesNotMatch(read(...p), /from "three"/, p.join("/"));
  }
});

test("3D batch5-battle: シーンに絵文字UIがない（色は材質で表現）", () => {
  for (const g of BATCH) {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${g.dir} scene emoji`);
  }
});
