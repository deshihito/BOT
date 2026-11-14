// 3D化 第3バッチ（ソリティア系: solitaire / spider / freecell）の回帰テスト（静的検査）。
// games-3d-batch2-cards.test.mjs のスタイルに倣う:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createCard / createStage / attachPickPointer を使う
// - カードは差分同期（スロットキー＋カードキーの Map = entries）で管理する
// - <button> 数が現行（solitaire 1 / spider 1 / freecell 2）から増えていないこと
// - ロジック（lib/solitaire.ts, lib/spider.ts, lib/freecell.ts）へ three が混入していないこと
// - 主要ハンドラ（山札タップ・移動・ドラッグ・ダブルタップ等）へ接続していること
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
  { dir: "solitaire", client: "SolitaireClient.tsx", scene: "SolitaireScene3D.tsx", buttons: 1 },
  { dir: "spider", client: "SpiderClient.tsx", scene: "SpiderScene3D.tsx", buttons: 1 },
  { dir: "freecell", client: "FreeCellClient.tsx", scene: "FreeCellScene3D.tsx", buttons: 2 },
];

for (const g of BATCH) {
  test(`3D solitaire-family ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, new RegExp(`dynamic\\(\\(\\) => import\\("\\./${g.scene.replace(".tsx", "")}"\\), \\{ ssr: false \\}\\)`), "dynamic import");
    assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /from "three"/);
    assert.match(scene, /three-kit/, "共通基盤を使う");
    assert.match(client, /onFail|webglFailed/, "WebGL 失敗時のフォールバックがある");
    assert.match(client, /board2d/, "フォールバック用の既存 2D 盤を保持する");
  });

  test(`3D solitaire-family ${g.dir}: シーンはカード系の型（createCard/createStage/attachPickPointer/SceneBox）を使う`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    for (const name of ["createCard", "createStage", "attachPickPointer", "SceneBox"]) {
      assert.match(scene, new RegExp(name), name);
    }
    // 差分同期: スロットキー＋カードキーの Map で管理し、毎回全生成しない
    assert.match(scene, /entries/, "スロット単位でカードを差分管理する");
    assert.match(scene, /lastPosByCard/, "移動元の最終位置を引き継いで滑らかに動かす");
    // ドラッグは attachPickPointer のドラッグ経路＋平面座標で追従させる
    assert.match(scene, /onDragStart/, "ドラッグ開始を拾う");
    assert.match(scene, /onDragMove/, "ドラッグ中は平面上の点で束を追従させる");
    assert.match(scene, /onDragEnd/, "ドラッグ終了で落下を判定する");
    assert.match(scene, /planeY/, "ドラッグ平面の高さを指定する");
    assert.match(scene, /onDragDrop/, "落下はクライアントの既存ハンドラへ接続する");
  });

  test(`3D solitaire-family ${g.dir}: <button> 数が現行（${g.buttons}）から増えていない`, () => {
    assert.equal(countButtons(g.dir), g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });
}

test("3D solitaire: 山札タップ・場札タップ・組札タップ・ダブルタップが既存ハンドラへ接続される", () => {
  const client = read("app", "games", "solitaire", "SolitaireClient.tsx");
  assert.match(client, /onStockTap=\{onStockTap\}/, "山札タップ = 既存のめくる処理");
  assert.match(client, /drawFromStock/, "山札は lib の drawFromStock を使う");
  assert.match(client, /onTableauTap=\{onTableauCard\}/, "場札タップ = 既存の選択/移動処理");
  assert.match(client, /onFoundationTap=\{onFoundation\}/, "組札タップ = 既存処理");
  assert.match(client, /onEmptyTableauTap=\{moveSelectionToTableau\}/, "空列タップ = 既存の移動処理");
  assert.match(client, /tryMoveToFoundation/, "ダブルタップ = 組札への自動移動");
  assert.match(client, /onDragDrop=\{onDragDrop\}/, "ドラッグ落下が接続される");
  assert.match(client, /onBoardSwipe=\{handleBoardSwipe\}/, "左右フリック = 盤面スワイプ（もどる/自動移動）");
  const scene = read("app", "games", "solitaire", "SolitaireScene3D.tsx");
  assert.match(scene, /FACE_DOWN/, "伏せ札の裏向き表現がある");
  assert.match(scene, /FACE_UP/, "めくれで表向きへ遷移する");
  assert.match(scene, /tableauOffsets/, "重なり間隔は列の長さに応じて調整する");
});

test("3D spider: カードタップ・空列タップ・配布が既存ハンドラへ接続される", () => {
  const client = read("app", "games", "spider", "SpiderClient.tsx");
  assert.match(client, /onCardTap=\{onCardClick\}/, "カードタップ = 既存の選択/移動処理");
  assert.match(client, /onEmptyColumnTap=\{onEmptyColumnClick\}/, "空列タップ = 既存処理");
  assert.match(client, /onDealTap=\{tryDeal\}/, "山札タップ/下フリック = 既存の配布処理");
  assert.match(client, /onDragDrop=\{onDragDrop\}/, "ドラッグ落下が接続される");
  assert.match(client, /canMoveSpiderRun/, "移動判定は lib の canMoveSpiderRun を使う");
  const scene = read("app", "games", "spider", "SpiderScene3D.tsx");
  assert.match(scene, /SPIDER_COLUMNS/, "10列の配置は lib の列数定義を使う");
  assert.match(scene, /columnOffsets/, "重なり間隔は列の長さに応じて圧縮する");
  assert.match(scene, /spiderStockDeals/, "山札の残り配布回数は lib から取る");
});

test("3D freecell: 列・フリーセル・組札タップが既存ハンドラへ接続される", () => {
  const client = read("app", "games", "freecell", "FreeCellClient.tsx");
  assert.match(client, /onColumnCardTap=\{onColumnCard\}/, "場札タップ = 既存の選択/移動処理");
  assert.match(client, /onEmptyColumnTap=\{onEmptyColumn\}/, "空列タップ = 既存処理");
  assert.match(client, /onFreeCellTap=\{onFreeCell\}/, "フリーセルタップ = 既存処理");
  assert.match(client, /onFoundationTap=\{onFoundation\}/, "組札タップ = 既存処理");
  assert.match(client, /onDragDrop=\{onDragDrop\}/, "ドラッグ落下が接続される");
  assert.match(client, /onBoardSwipe=\{handleBoardSwipe\}/, "左右フリック = 盤面スワイプ（もどる/自動送り）");
  assert.match(client, /tryMove/, "移動判定は既存の tryMove（moveFreecell）を通す");
  const scene = read("app", "games", "freecell", "FreeCellScene3D.tsx");
  assert.match(scene, /freecell-/, "フリーセル枠を持つ");
  assert.match(scene, /foundation-/, "組札枠を持つ（フリーセルと別枠で区別する）");
  assert.match(scene, /FC_COLUMNS/, "8列の配置は lib の列数定義を使う");
});

test("3D solitaire-family: ロジック層（lib/solitaire.ts, lib/spider.ts, lib/freecell.ts）に three が混入していない", () => {
  for (const f of ["solitaire.ts", "spider.ts", "freecell.ts"]) {
    assert.doesNotMatch(read("lib", f), /from "three"/, `lib/${f}`);
    assert.doesNotMatch(read("lib", f), /three-kit/, `lib/${f}`);
  }
});
