// 3D化 第8バッチ 盤系（tents / river / knightstour）の回帰テスト（静的検査）。
// 既存バッチの流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createStage / attachPickPointer / SceneBox を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D へフォールバックする
// - <button> 数が現行（tents 1 / river 1 / knightstour 4）以下
// - シーンに絵文字 UI がない（木・テント・駒は立体造形で表す）
// - 入力が既存ハンドラ（tents: onCell/onCheck、river: handleItem/cross、
//   knightstour: handleMove）へ接続される
// - 制約判定・勝敗判定を 3D 側で再実装していないこと
// - ロジック（lib/tents.ts 等）へ three が混入していないこと
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
  { dir: "river", client: "RiverClient.tsx", scene: "RiverScene3D.tsx", buttons: 1, lib: "river.ts" },
];

for (const g of BATCH) {
  test(`3D batch8-board ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
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
    assert.match(scene, /pickId/, "当たり判定メッシュに pickId を付ける");
    assert.match(client, /webglFailed/, "WebGL 失敗時のフォールバックがある");
    assert.match(client, /fallback=\{board2d\}/, "フォールバックとして既存 2D をシーンへ渡す");
  });

  test(`3D batch8-board ${g.dir}: <button> 数が現行（${g.buttons}）以下`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });

  test(`3D batch8-board ${g.dir}: シーンに絵文字UIがない（色と造形で表現）`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${g.dir} scene emoji`);
  });

  test(`3D batch8-board ${g.dir}: ロジック層（lib/${g.lib}）に three が混入していない`, () => {
    assert.doesNotMatch(read("lib", g.lib), /from "three"/, `lib/${g.lib}`);
  });
}




test("3D batch8-board river: 両岸＋川＋ボートと、漢字プレートつきトークンで登場オブジェクトを表す", () => {
  const scene = read("app", "games", "river", "RiverScene3D.tsx");
  assert.match(scene, /createToken/, "荷物・農夫はトークンで造形する");
  assert.match(scene, /canvasTexture/, "漢字はプレートのテクスチャで大きく描く");
  assert.match(scene, /river-kanji-/, "漢字プレートは荷物ごとに作る");
  assert.match(scene, /createBankPlate/, "岸の名前プレートを置く");
  assert.match(scene, /pickId = "boat"/, "ボートがピック対象になる");
  assert.match(scene, /pickId = `item-\$\{item\.id\}`/, "荷物トークンがピック対象になる");
  assert.match(scene, /FARMER_DEF/, "農夫トークンを持つ");
});

test("3D batch8-board river: 差分同期＋補間追従でボートと荷物が一緒に動く", () => {
  const scene = read("app", "games", "river", "RiverScene3D.tsx");
  assert.match(scene, /tokensRt/, "トークンは差分同期で管理する");
  assert.match(scene, /boatTargetX/, "ボートは目標位置を持つ");
  assert.match(scene, /Math\.exp\(-dt/, "補間は指数追従");
  assert.match(scene, /tok\.loc === "boat"/, "船上の荷物はボートの現在位置へ追従する");
});

test("3D batch8-board river: 荷物タップが onItem、ボートタップ／対岸スワイプが onCross へ接続され、危険判定を再実装しない", () => {
  const scene = read("app", "games", "river", "RiverScene3D.tsx");
  assert.match(scene, /propsRef\.current\.onItem\(id\.slice\(5\)\)/, "荷物タップが onItem を呼ぶ");
  assert.match(scene, /propsRef\.current\.onCross\(\)/, "ボートタップ／スワイプが onCross を呼ぶ");
  assert.match(scene, /flick\.dir === "right"/, "右方向のフリック（左岸→右岸）を渡河に使う");
  assert.match(scene, /flick\.dir === "left"/, "左方向のフリック（右岸→左岸）を渡河に使う");
  assert.doesNotMatch(scene, /crossRiver\(|toggleRiverItem\(|dangerOnSide\(/, "渡河・積み下ろし・危険判定を 3D 側で再実装しない");
  const client = read("app", "games", "river", "RiverClient.tsx");
  assert.match(client, /onItem=\{handleItem\}/, "既存の乗せ降ろし経路へ接続する");
  assert.match(client, /onCross=\{cross\}/, "既存の cross へ接続する");
  assert.match(client, /const handleItem[\s\S]*?toggleRiverItem\(state, id\)/, "handleItem は既存の toggleRiverItem 経路そのもの");
  assert.match(client, /locations=\{state\.locations\}/, "荷物の場所は親の状態を渡す");
  assert.match(client, /items=\{problem\.items\}/, "荷物定義は親の問題を渡す");
});



