// 3D化 第2バッチ（物理・空間系: billiards / airhockey / curling）の回帰テスト（静的検査）。
// 第1期 games-3d-batch1.test.mjs のスタイルに倣う:
// - 対象ゲームが dynamic import (ssr:false) でシーンを遅延読み込みしていること
// - クライアント側に three の直接 import がないこと（シーン側だけに閉じる）
// - <button> 数が現行値から増えていないこと
// - シーンが共通基盤 (createStage / attachPickPointer 等) を使うこと
// - ロジック（lib/*.ts 本体）へ three が混入していないこと
// - 実時間系 (airhockey) は onFrame の dt で補間し、状態は親の getState 経由で読むこと
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
  { dir: "billiards", client: "BilliardsClient.tsx", scene: "BilliardsScene3D.tsx", buttons: 2 },
  { dir: "airhockey", client: "AirHockeyClient.tsx", scene: "AirHockeyScene3D.tsx", buttons: 4 },
  { dir: "curling", client: "CurlingClient.tsx", scene: "CurlingScene3D.tsx", buttons: 3 },
];

for (const g of BATCH) {
  test(`3D batch2 ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, new RegExp(`dynamic\\(\\(\\) => import\\("\\./${g.scene.replace(".tsx", "")}"\\), \\{ ssr: false \\}\\)`), "dynamic import");
    assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /from "three"/);
    assert.match(scene, /three-kit/, "共通基盤を使う");
    assert.match(scene, /createStage/, "ステージは共通基盤から作る");
    assert.match(scene, /attachPickPointer/, "入力は共通ポインタ基盤を使う");
    assert.match(scene, /SceneBox/, "外枠は共通 SceneBox を使う");
    assert.match(client, /onFail|webglFailed/, "WebGL 失敗時のフォールバックがある");
  });

  test(`3D batch2 ${g.dir}: <button> 数が現行値（${g.buttons}）から増えていない`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });

  test(`3D batch2 ${g.dir}: シーンはロジック層を変更せず、判定を独自に行わない`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    // 物理・勝敗の真実の源である lib 本体をシーンから書き換える import がないこと
    assert.doesNotMatch(scene, /simulateShot|simulateThrow|stepAirHockey\(/, "シーンが物理シミュレーションを再実行しない");
  });
}

test("3D batch2 billiards: テーブル・球・キューと平面ドラッグ狙いがある", () => {
  const scene = read("app", "games", "billiards", "BilliardsScene3D.tsx");
  assert.match(scene, /createBall/, "球は createBall");
  assert.match(scene, /canvasTexture/, "番号テクスチャは canvasTexture");
  assert.match(scene, /BL_POCKETS/, "ポケット配置は lib の定数に従う");
  assert.match(scene, /planeY/, "ドラッグ平面を指定する");
  assert.match(scene, /onDragMove/, "ドラッグで狙う");
  assert.match(scene, /onShoot/, "フリック等で打つ操作を親へ返す");
  assert.match(scene, /cue/i, "キューの表現がある");
});

test("3D batch2 airhockey: 状態は getState で読み、dt 補間とゴール発光がある", () => {
  const scene = read("app", "games", "airhockey", "AirHockeyScene3D.tsx");
  assert.match(scene, /getState/, "親のフレーム状態を読む");
  assert.match(scene, /onFrame/, "フレーム追従する");
  assert.match(scene, /dt/, "dt で補間する");
  assert.match(scene, /planePoint|planeY/, "平面ポインタでマレットを接続する");
  assert.match(scene, /onTarget/, "マレット目標を親へ返す");
  assert.match(scene, /emissive/, "ゴール時の発光演出がある");
  const client = read("app", "games", "airhockey", "AirHockeyClient.tsx");
  assert.match(client, /stepAirHockey/, "物理は従来どおり lib のステップで進める");
});

test("3D batch2 curling: ハウス円・ストーンとフリック投げ、最終位置への収束補間がある", () => {
  const scene = read("app", "games", "curling", "CurlingScene3D.tsx");
  assert.match(scene, /CU_HOUSE_RADII/, "ハウス円は lib の定数に従う");
  assert.match(scene, /CU_BUTTON/, "ボタン位置は lib の定数に従う");
  assert.match(scene, /onFlick/, "フリックで投げる");
  assert.match(scene, /onThrow/, "投げ操作を親へ返す");
  assert.match(scene, /onDragMove/, "ドラッグで強さ/カールを決める");
  const client = read("app", "games", "curling", "CurlingClient.tsx");
  assert.match(client, /playerThrow/, "投げの適用は lib の playerThrow");
});

test("3D batch2: ロジック層（lib/*.ts 本体）に three が混入していない", () => {
  for (const f of fs.readdirSync(path.join(webDir, "lib"))) {
    if (!f.endsWith(".ts")) continue;
    const src = read("lib", f);
    assert.doesNotMatch(src, /from "three"/, `lib/${f}`);
  }
  for (const name of ["billiards.ts", "airhockey.ts", "curling.ts"]) {
    assert.doesNotMatch(read("lib", name), /three/, `lib/${name}`);
  }
});
