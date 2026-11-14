// 3D化 第4バッチ 盤系B（battleship / territory / fifteen / lightsout）の
// 回帰テスト（静的検査）。第1〜3バッチのスタイルに倣う:
// - 対象ゲームが dynamic import (ssr:false) でシーンを遅延読み込みしていること
// - クライアント側に three の直接 import がないこと（シーン側だけに閉じる）
// - シーンが three-kit の共通基盤（createStage / attachPickPointer / SceneBox）を使うこと
// - <button> 数が現行値から増えていないこと
// - ロジック（lib/*.ts）へ three が混入していないこと
// - 各ゲームの入力接続（タップ/スワイプ）が既存ハンドラへ繋がっていること
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
  { dir: "battleship", client: "BattleshipClient.tsx", scene: "BattleshipScene3D.tsx", buttons: 0 },
  { dir: "territory", client: "TerritoryClient.tsx", scene: "TerritoryScene3D.tsx", buttons: 0 },
  { dir: "fifteen", client: "FifteenClient.tsx", scene: "FifteenScene3D.tsx", buttons: 3 },
  { dir: "lightsout", client: "LightsOutClient.tsx", scene: "LightsOutScene3D.tsx", buttons: 1 },
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

test("3D battleship: 艦船は船体＋艦橋の造形、命中/はずれは造形マーカーで表す", () => {
  const scene = read("app", "games", "battleship", "BattleshipScene3D.tsx");
  assert.match(scene, /createShip/, "艦船の造形がある");
  assert.match(scene, /bridge/, "艦橋を持つ");
  assert.match(scene, /createHitMarker/, "命中マーカーは造形で表す");
  assert.match(scene, /createMissMarker/, "はずれ（着水）マーカーは造形で表す");
  assert.match(scene, /TorusGeometry/, "水しぶきの輪をトーラスで表す");
  assert.match(scene, /sunk/, "沈没表現がある");
  const client = read("app", "games", "battleship", "BattleshipClient.tsx");
  assert.match(client, /onCell=\{tryPlace\}/, "配置盤タップは既存の配置/取消ハンドラへ接続する");
  assert.match(client, /onCell=\{fire\}/, "敵盤タップは既存の射撃ハンドラへ接続する");
  assert.match(client, /interactive=\{!confirmed\}/, "配置確定後は配置盤を操作不可にする");
  assert.match(client, /interactive=\{myTurn\}/, "敵盤は自分の手番だけ操作可にする");
  assert.match(client, /sunkShips\.map/, "敵盤には沈没した艦だけを渡す（未沈没の艦は隠す）");
  assert.match(client, /shots=\{state\.you\.incoming\}/, "自盤には被弾履歴を渡す");
});

test("3D territory: 陣地は席色の立体タイル、プレビューはゴースト、スワイプは親の useGesture が担う", () => {
  const scene = read("app", "games", "territory", "TerritoryScene3D.tsx");
  assert.match(scene, /SEAT_COLORS_3D/, "席色は現行 2D と同じ色を使う");
  assert.match(scene, /previewLegal/, "プレビューの合法/非合法でゴースト色を変える");
  assert.match(scene, /lastMove/, "直近の着手を強調する");
  const client = read("app", "games", "territory", "TerritoryClient.tsx");
  assert.match(client, /onCell=\{onCell\}/, "盤タップは既存のアンカー/配置ハンドラへ接続する");
  assert.match(client, /preview=\{previewSet\}/, "プレビュー計算は親（placementCells）側のまま");
  assert.match(client, /lastMove=\{lastMoveSet\}/, "直近の着手集合は親から渡す");
  assert.match(client, /\{\.\.\.boardGesture\} style=\{\{ touchAction: "none", width: "min\(92vw, 420px\)" \}\}/, "3D 盤のラッパーにも現行の盤スワイプ（回転/反転/パス）を付ける");
});

test("3D fifteen: 数字は上面テクスチャに大きく描き、タイルはスライドアニメーションする", () => {
  const scene = read("app", "games", "fifteen", "FifteenScene3D.tsx");
  assert.match(scene, /canvasTexture/, "数字テクスチャは canvasTexture で作る");
  assert.match(scene, /fifteen-tile-/, "数字テクスチャのキーがタイルごとにある");
  assert.match(scene, /createTileMesh/, "タイルは立体タイルにする");
  assert.match(scene, /onFrame/, "スライドアニメーションはフレーム補間で追従させる");
  assert.match(scene, /t\.tx|tx: x/, "タイルの目標位置を持つ");
  const client = read("app", "games", "fifteen", "FifteenClient.tsx");
  assert.match(client, /onTile=\{handleTile\}/, "タップは既存のスライド処理（canSlide 判定含む）へ接続する");
});

test("3D lightsout: 点灯は発光＋盛り上がり、消灯は沈み込みで表す", () => {
  const scene = read("app", "games", "lightsout", "LightsOutScene3D.tsx");
  assert.match(scene, /LIT_TOP/, "点灯時の盛り上がり高さを持つ");
  assert.match(scene, /UNLIT_TOP/, "消灯時の沈み込み高さを持つ");
  assert.match(scene, /emissive/, "点灯は emissive で発光させる");
  assert.match(scene, /onFrame/, "高さの遷移はフレーム補間で滑らかにする");
  const client = read("app", "games", "lightsout", "LightsOutClient.tsx");
  assert.match(client, /onPress=\{handlePress\}/, "タップは既存の反転処理（pressCell）へ接続する");
  assert.match(client, /won=\{state\.status === "won"\}/, "全消灯後は 3D 盤も操作不可にする");
});

test("3D batch4-board: ロジック層に three が混入していない", () => {
  for (const f of [["fifteen.ts"], ["lightsout.ts"], ["online", "games", "territory.ts"], ["online", "games", "battleship.ts"]]) {
    assert.doesNotMatch(read("lib", ...f), /from "three"/, `lib/${f.join("/")}`);
    assert.doesNotMatch(read("lib", ...f), /three-kit/, `lib/${f.join("/")}`);
  }
});
