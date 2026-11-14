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
  { dir: "kenken", client: "KenkenClient.tsx", scene: "KenkenScene3D.tsx", buttons: 1, lib: "kenken.ts" },
  { dir: "kakuro", client: "KakuroClient.tsx", scene: "KakuroScene3D.tsx", buttons: 1, lib: "kakuro.ts" },
  { dir: "binairo", client: "BinairoClient.tsx", scene: "BinairoScene3D.tsx", buttons: 2, lib: "binairo.ts" },
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

test("3D batch7-numbers kenken: ケージ境界は壁、ラベルは先頭マスの上面に大きく描く", () => {
  const scene = read("app", "games", "kenken", "KenkenScene3D.tsx");
  assert.match(scene, /addWall/, "ケージ境界を壁（溝）で表現する");
  assert.match(scene, /cageOf\[i - size\] !== cageOf\[i\]/, "境界は cageOf の隣接比較で決める");
  assert.match(scene, /labelOf/, "ケージラベルを持つ");
  assert.match(scene, /cage\.target/, "ラベルは目標値と演算から作る");
  assert.match(scene, /34px/, "ラベルを大きく描く");
  assert.match(scene, /propsRef\.current\.onCell\(Number\(id\.slice\(5\)\)\)/, "タップが onCell を呼ぶ");
  assert.match(scene, /flick\.dir === "down"/, "下フリックでチェック");
  assert.match(scene, /propsRef\.current\.onCheck\(\)/, "下フリックが onCheck を呼ぶ");
  const client = read("app", "games", "kenken", "KenkenClient.tsx");
  assert.match(client, /onCell=\{selectCell\}/, "既存の選択ハンドラへ接続する");
  assert.match(client, /onCheck=\{onCheck\}/, "既存のチェックへ接続する");
  assert.doesNotMatch(scene, /setKenkenValue|checkKenken|evaluateCage/, "入力・判定を 3D 側で再実装しない");
});

test("3D batch7-numbers kakuro: 黒マスは 192px テクスチャに斜め仕切りと 2 合計を描く", () => {
  const scene = read("app", "games", "kakuro", "KakuroScene3D.tsx");
  assert.match(scene, /createBlackTile/, "黒マスを造形する");
  assert.match(scene, /192, 192/, "黒マスは大きめキャンバスで描く");
  assert.match(scene, /58px/, "合計を大きく描く");
  assert.match(scene, /cell\.across/, "右向き合計を描く");
  assert.match(scene, /cell\.down/, "下向き合計を描く");
  assert.match(scene, /propsRef\.current\.onCell\(Number\(id\.slice\(5\)\)\)/, "タップが onCell を呼ぶ");
  assert.match(scene, /flick\.dir === "down"/, "下フリックでチェック");
  assert.match(scene, /propsRef\.current\.onCheck\(\)/, "下フリックが onCheck を呼ぶ");
  const client = read("app", "games", "kakuro", "KakuroClient.tsx");
  assert.match(client, /onCell=\{selectCell\}/, "既存の選択ハンドラへ接続する");
  assert.match(client, /onCheck=\{handleCheck\}/, "既存のチェックへ接続する");
  assert.doesNotMatch(scene, /setKakuroValue|checkKakuro/, "入力・判定を 3D 側で再実装しない");
});

test("3D batch7-numbers binairo: タップが既存の循環ハンドラへ接続される", () => {
  const scene = read("app", "games", "binairo", "BinairoScene3D.tsx");
  assert.match(scene, /propsRef\.current\.onCell\(Number\(id\.slice\(5\)\)\)/, "タップが onCell を呼ぶ");
  assert.match(scene, /88px/, "0/1 を大きく描く");
  assert.doesNotMatch(scene, /cycleBinairoCell|setBinairoCell|checkBinairo/, "循環・判定を 3D 側で再実装しない");
  const client = read("app", "games", "binairo", "BinairoClient.tsx");
  assert.match(client, /onCell=\{cycleCell\}/, "既存の循環ハンドラへ接続する");
  assert.match(client, /cycleBinairoCell\(s, i\)/, "循環は既存 lib 経路のまま");
});
