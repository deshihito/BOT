// 3D化 第7バッチ 数字グリッド系（sudoku / kenken / kakuro / binairo）の
// 回帰テスト（静的検査）。既存バッチの流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createStage / attachPickPointer / SceneBox を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D へフォールバックする
// - <button> 数が現行（sudoku 1 / kenken 1 / kakuro 1 / binairo 2）以下
// - 入力が既存ハンドラ（選択・ヒント・チェック・循環）へ接続される
// - 判定・合法性を 3D 側で再実装していないこと
// - ロジック（lib/sudoku.ts 等）へ three が混入していないこと
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
  { dir: "sudoku", client: "SudokuClient.tsx", scene: "SudokuScene3D.tsx", buttons: 1, lib: "sudoku.ts" },
];

for (const g of BATCH) {
  test(`3D batch7-numbers ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
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
    assert.match(scene, /canvasTexture/, "数字は上面テクスチャで大きく描く");
    assert.match(scene, /pickId = `cell-\$\{i\}`/, "当たり判定メッシュに pickId を付ける");
    assert.match(client, /webglFailed/, "WebGL 失敗時のフォールバックがある");
    assert.match(client, /fallback=\{board2d\}/, "フォールバックとして既存 2D をシーンへ渡す");
  });

  test(`3D batch7-numbers ${g.dir}: <button> 数が現行（${g.buttons}）以下`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });

  test(`3D batch7-numbers ${g.dir}: シーンに絵文字UIがない（数字と造形で表現）`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${g.dir} scene emoji`);
  });

  test(`3D batch7-numbers ${g.dir}: ロジック層（lib/${g.lib}）に three が混入していない`, () => {
    assert.doesNotMatch(read("lib", g.lib), /from "three"/, `lib/${g.lib}`);
  });
}

test("3D batch7-numbers sudoku: タップが選択、上フリックがヒントへ接続される", () => {
  const scene = read("app", "games", "sudoku", "SudokuScene3D.tsx");
  assert.match(scene, /propsRef\.current\.onCell\(Number\(id\.slice\(5\)\)\)/, "タップが onCell を呼ぶ");
  assert.match(scene, /onFlick/, "フリックを受け付ける");
  assert.match(scene, /flick\.dir === "up"/, "上フリックでヒント");
  assert.match(scene, /propsRef\.current\.onHint\(\)/, "上フリックが onHint を呼ぶ");
  const client = read("app", "games", "sudoku", "SudokuClient.tsx");
  assert.match(client, /onCell=\{selectCell\}/, "既存の選択ハンドラへ接続する");
  assert.match(client, /onHint=\{onHint\}/, "既存のヒントへ接続する");
  assert.match(client, /applyHint\(state\)/, "ヒント適用は既存 lib 経路のまま");
  assert.doesNotMatch(scene, /setCell|toggleNote|applyHint|conflictIndexes/, "入力・判定を 3D 側で再実装しない");
});

test("3D batch7-numbers sudoku: 数字は大きく、メモは細字でなくドットで表す", () => {
  const scene = read("app", "games", "sudoku", "SudokuScene3D.tsx");
  assert.match(scene, /86px|84px/, "数字は 84px 級の大きなフォントで描く");
  assert.match(scene, /notes/, "メモを受け取る");
  assert.match(scene, /arc\(dx, dy/, "メモはドットで表す");
  assert.match(scene, /mistakes/, "ミス判定済みの集合を親から受け取る");
  assert.match(scene, /conflicts/, "矛盾の集合を親から受け取る");
  const client = read("app", "games", "sudoku", "SudokuClient.tsx");
  assert.match(client, /mistakes=\{mistakes\}/, "ミス集合をシーンへ渡す");
  assert.match(client, /conflicts=\{conflicts\}/, "矛盾集合をシーンへ渡す");
  assert.match(client, /notesSummary/, "メモの正を DOM 注記でも担保する");
});



