// 3D化 第4バッチ 将棋系（tsume / chesspuzzle）の回帰テスト（静的検査）。
// 第1〜3バッチのスタイルに倣う:
// - 対象ゲームが dynamic import (ssr:false) でシーンを遅延読み込みしていること
// - クライアント側に three の直接 import がないこと（シーン側だけに閉じる）
// - シーンが three-kit の共通基盤（createStage / attachPickPointer / SceneBox）を使うこと
// - <button> 数が現行値（各1個）から増えていないこと
// - ロジック（lib/tsume.ts / lib/chesspuzzle.ts）へ three が混入していないこと
// - 入力（タップ/フリック）が既存ハンドラへ繋がっていること
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
  { dir: "tsume", client: "TsumeClient.tsx", scene: "TsumeScene3D.tsx", buttons: 1 },
  { dir: "chesspuzzle", client: "ChessPuzzleClient.tsx", scene: "ChessPuzzleScene3D.tsx", buttons: 1 },
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

  test(`3D ${g.dir}: <button> 数が現行値（${g.buttons}）以下`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });
}

test("3D tsume: 駒は五角形プリズム＋上面の駒文字テクスチャ、持ち駒も立体配置", () => {
  const scene = read("app", "games", "tsume", "TsumeScene3D.tsx");
  assert.match(scene, /ExtrudeGeometry/, "駒は ExtrudeGeometry の楔形プリズム");
  assert.match(scene, /pentagonShape/, "五角形の輪郭がある");
  assert.match(scene, /canvasTexture/, "駒文字は canvasTexture で描く");
  assert.match(scene, /pieceTopTexture/, "上面テクスチャ生成がある");
  assert.match(scene, /PIECE_LABEL/, "駒文字は lib の PIECE_LABEL を使う");
  assert.match(scene, /ATTACK_COLOR/, "攻め方の色がある");
  assert.match(scene, /DEFEND_COLOR/, "玉方の色分けがある");
  assert.match(scene, /handEntries/, "持ち駒の立体配置がある");
  assert.match(scene, /fitCamera/, "小画面でも盤全体が収まるようカメラを調整する");
  const client = read("app", "games", "tsume", "TsumeClient.tsx");
  assert.match(client, /onCell=\{onCell\}/, "盤タップは既存のマス選択→移動ハンドラへ接続する");
  assert.match(client, /onHand=\{onHandPiece\}/, "持ち駒タップは既存の持ち駒選択ハンドラへ接続する");
  assert.match(client, /onSwipeLeft=\{undo\}/, "左フリックは既存の1手戻すへ接続する");
  assert.match(client, /targets=\{\[\.\.\.targets\.keys\(\)\]\}/, "移動先は既存の targets 計算のまま渡す");
});

test("3D chesspuzzle: 駒はプリミティブ造形で6種判別でき、盤はパズル専用シーン", () => {
  const scene = read("app", "games", "chesspuzzle", "ChessPuzzleScene3D.tsx");
  assert.match(scene, /createChessPiece/, "駒造形がある");
  for (const t of ['"P"', '"R"', '"N"', '"B"', '"Q"']) {
    assert.match(scene, new RegExp(`type === ${t}`), `駒種 ${t} の造形分岐`);
  }
  assert.match(scene, /ConeGeometry/, "ビショップは円錐で判別する");
  assert.match(scene, /十字/, "キングは十字で判別する旨がある");
  assert.doesNotMatch(scene, /GLYPHS/, "既存グリフ表示に依存しない（造形で判別する）");
  const client = read("app", "games", "chesspuzzle", "ChessPuzzleClient.tsx");
  assert.match(client, /onSquare=\{onSquare\}/, "盤タップは既存の手選択フローへ接続する");
  assert.match(client, /onSwipe=\{onBoardSwipe\}/, "フリックは既存のスワイプ操作（戻す/ヒント）へ接続する");
  assert.match(client, /hintFrom=\{hint\?\.from/, "ヒント表示は既存の hint 状態を渡す");
});

test("3D batch4-shogi: ロジック層（tsume / chesspuzzle）に three が混入していない", () => {
  for (const f of ["tsume.ts", "chesspuzzle.ts"]) {
    assert.doesNotMatch(read("lib", f), /from "three"/, `lib/${f}`);
    assert.doesNotMatch(read("lib", f), /three-kit/, `lib/${f}`);
  }
});
