// 3D化 第3バッチ B系タイル・盤（minesweeper / pentomino / blockpuzzle / mahjong）の
// 回帰テスト（静的検査）。第1・2バッチのスタイルに倣う:
// - 対象ゲームが dynamic import (ssr:false) でシーンを遅延読み込みしていること
// - クライアント側に three の直接 import がないこと（シーン側だけに閉じる）
// - シーンが three-kit の共通基盤（createStage / attachPickPointer / SceneBox）を使うこと
// - <button> 数が現行値から増えていないこと
// - ロジック（lib/*.ts）へ three が混入していないこと
// - 各ゲームの入力接続（タップ/長押し/ドラッグ/ホバー）が既存ハンドラへ繋がっていること
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
  { dir: "minesweeper", client: "MinesweeperClient.tsx", scene: "MinesweeperScene3D.tsx", buttons: 1 },
  { dir: "pentomino", client: "PentominoClient.tsx", scene: "PentominoScene3D.tsx", buttons: 1 },
  { dir: "mahjong", client: "MahjongClient.tsx", scene: "MahjongScene3D.tsx", buttons: 3 },
];

for (const g of BATCH) {
  test(`3D ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, new RegExp(`dynamic\\(\\(\\) => import\\("\\./${g.scene.replace(".tsx", "")}"\\), \\{ ssr: false \\}\\)`), "dynamic import");
    assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /from "three"/);
    assert.match(scene, /three-kit/, "共通基盤を使う");
    assert.match(scene, /createStage/, "ステージは共通基盤から作る");
    assert.match(scene, /attachPickPointer/, "入力は共通のレイキャスト橋渡しを使う");
    assert.match(scene, /SceneBox/, "WebGL 失敗時の枠を使う");
    assert.match(client, /onFail|webglFailed/, "WebGL 失敗時のフォールバックがある");
    assert.match(client, /board2d/, "フォールバック用の既存 2D 盤を保持する");
  });

  test(`3D ${g.dir}: <button> 数が現行値（${g.buttons}）から増えていない`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });
}

test("3D minesweeper: 数字は上面テクスチャに大きく描き、旗立ては長押しと右クリックの経路がある", () => {
  const scene = read("app", "games", "minesweeper", "MinesweeperScene3D.tsx");
  assert.match(scene, /canvasTexture/, "数字テクスチャは canvasTexture で作る");
  assert.match(scene, /ms-count-/, "数字テクスチャのキーが数字ごとにある");
  assert.match(scene, /NUMBER_COLOR/, "数字色は現行 2D の色に合わせる");
  assert.match(scene, /createNumberPlate/, "開いたマスは数字つき平板にする");
  assert.match(scene, /createFlag/, "旗は立体造形で表す");
  assert.match(scene, /createMine/, "地雷は球＋棘の造形で表す");
  assert.match(scene, /LONG_PRESS_MS/, "長押しで旗を立てる経路がある");
  assert.match(scene, /contextmenu/, "右クリックでも旗を立てる（現行 DOM と同じ）");
  assert.match(scene, /onToggleFlag/, "旗立ては既存の toggleFlag 経路へ接続する");
  assert.match(scene, /fitCamera/, "難易度で盤が大きい場合はカメラを引いて全体を収める");
  const client = read("app", "games", "minesweeper", "MinesweeperClient.tsx");
  assert.match(client, /onCell=\{onCell\}/, "タップは既存のマス処理（旗モード・コード入力含む）へ接続する");
  assert.match(client, /onToggleFlag=\{toggleFlagWithSound\}/, "旗立ては既存ハンドラへ接続する");
});

test("3D pentomino: ピースは立体ブロック、入力はタップ配置とホバープレビュー", () => {
  const scene = read("app", "games", "pentomino", "PentominoScene3D.tsx");
  assert.match(scene, /pentPieceDef/, "ピース色は lib の定義を使う");
  assert.match(scene, /previewCells/, "配置プレビューを盤上に表示する");
  assert.match(scene, /hover: true/, "ホバーでプレビュー位置を親へ伝える");
  const client = read("app", "games", "pentomino", "PentominoClient.tsx");
  assert.match(client, /onCell=\{onCell\}/, "盤タップは既存の配置/取り外し処理へ接続する");
  assert.match(client, /onHover=\{setHover\}/, "ホバーは既存の hover 状態へ接続する");
  assert.match(client, /previewCells=\{previewCells\}/, "プレビュー計算は親（canPlacePent）側のまま");
});


test("3D mahjong: 牌は MJ_KINDS の上面テクスチャつき直方体で、layer が段差になる", () => {
  const scene = read("app", "games", "mahjong", "MahjongScene3D.tsx");
  assert.match(scene, /MJ_KINDS/, "牌の種別は現行 2D と同じ表示文字を使う");
  assert.match(scene, /canvasTexture/, "牌文字は canvasTexture で上面に大きく描く");
  assert.match(scene, /tileTopTexture/, "上面テクスチャ生成がある");
  assert.match(scene, /LAYER_STEP/, "積層は layer の段差で表現する");
  assert.match(scene, /createGoldFrame/, "選択中・ヒントは金縁で示す");
  assert.match(scene, /position\.y \+= 0\.24/, "選択中の牌は持ち上げる");
  const client = read("app", "games", "mahjong", "MahjongClient.tsx");
  assert.match(client, /onTile=\{onTile\}/, "牌タップは既存の選択/ペア確定ハンドラへ接続する");
  assert.match(client, /free=\{free\}/, "フリー判定は親（freeTileIds）のまま");
});

