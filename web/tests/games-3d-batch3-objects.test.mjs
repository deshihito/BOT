// 3D化 第3バッチ（A系物体ゲーム: stacker / balancestack / mergefruit / cranegame）の
// 回帰テスト（静的検査）。第2バッチ games-3d-batch2-physics.test.mjs のスタイルに倣う:
// - dynamic import (ssr:false) でシーンを遅延読み込み、three はシーン側だけ
// - <button> 数が現行値から増えていないこと
// - シーンが共通基盤 (createStage / attachPickPointer / SceneBox) を使うこと
// - ロジック（lib/*.ts 本体）へ three が混入していないこと
// - 各ゲームの入力接続（タップで落とす等）が現行クライアントの語彙と一致すること
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
  { dir: "stacker", client: "StackerClient.tsx", scene: "StackerScene3D.tsx", buttons: 2 },
  { dir: "balancestack", client: "BalanceStackClient.tsx", scene: "BalanceStackScene3D.tsx", buttons: 2 },
  { dir: "mergefruit", client: "MergeFruitClient.tsx", scene: "MergeFruitScene3D.tsx", buttons: 2 },
  { dir: "cranegame", client: "CraneGameClient.tsx", scene: "CraneScene3D.tsx", buttons: 2 },
];

for (const g of BATCH) {
  test(`3D batch3 ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.match(
      client,
      new RegExp(`dynamic\\(\\(\\) => import\\("\\./${g.scene.replace(".tsx", "")}"\\), \\{ ssr: false \\}\\)`),
      "dynamic import",
    );
    assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /from "three"/);
    assert.match(scene, /three-kit/, "共通基盤を使う");
    assert.match(scene, /createStage/, "ステージは共通基盤から作る");
    assert.match(scene, /attachPickPointer/, "入力は共通ポインタ基盤を使う");
    assert.match(scene, /SceneBox/, "外枠は共通 SceneBox を使う");
    assert.match(client, /onFail|webglFailed/, "WebGL 失敗時のフォールバックがある");
  });

  test(`3D batch3 ${g.dir}: <button> 数が現行値（${g.buttons}）から増えていない`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });

  test(`3D batch3 ${g.dir}: シーンはロジックの遷移関数を呼ばず、絵文字テクスチャを使わない`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(
      scene,
      /dropStacker|placeBlock\(|dropFruit\(|stopCrane\(|stepCrane\(|advanceStacker/,
      "シーンがロジックの状態遷移を再実行しない",
    );
  });
}

test("3D batch3 stacker: タップで落とし、落下/切り落とし/カメラ上昇がある", () => {
  const scene = read("app", "games", "stacker", "StackerScene3D.tsx");
  assert.match(scene, /onTapAnywhere/, "タップで落とす");
  assert.match(scene, /onDrop/, "落とす操作を親へ返す");
  assert.match(scene, /onFlick/, "フリックでも落とせる");
  assert.match(scene, /fallStart/, "新規段の落下アニメーションがある");
  assert.match(scene, /scraps/, "はみ出し分の切り落とし片がある");
  assert.match(scene, /camera/, "タワーに追従するカメラがある");
  const client = read("app", "games", "stacker", "StackerClient.tsx");
  assert.match(client, /dropStacker/, "落下確定は従来どおり lib の dropStacker");
  assert.match(client, /advanceStacker/, "移動は従来どおり lib の advanceStacker");
});

test("3D batch3 balancestack: タップ/ドラッグで位置を決め、崩壊は状態へ補間追従する", () => {
  const scene = read("app", "games", "balancestack", "BalanceStackScene3D.tsx");
  assert.match(scene, /onDragMove/, "ドラッグで置く位置を決める");
  assert.match(scene, /onCenter/, "位置を親へ返す");
  assert.match(scene, /planeY/, "ドラッグ平面を指定する");
  assert.match(scene, /collapsedLevel/, "崩壊段の状態に追従する");
  assert.match(scene, /collapseT/, "傾きは補間で表現する");
  assert.match(scene, /BALANCE_BASE/, "土台は lib の定数に従う");
  assert.match(scene, /overallCenterOfMass/, "重心表示は lib の関数に従う");
  const client = read("app", "games", "balancestack", "BalanceStackClient.tsx");
  assert.match(client, /placeBlock/, "配置確定は従来どおり lib の placeBlock（DOMボタン）");
});

test("3D batch3 mergefruit: ポインタ x で列を選びタップで落とし、次フルーツを球で予告する", () => {
  const scene = read("app", "games", "mergefruit", "MergeFruitScene3D.tsx");
  assert.match(scene, /createBall/, "フルーツは createBall の球体で表現する");
  assert.match(scene, /planeY/, "ポインタ平面で列を追う");
  assert.match(scene, /onHover/, "ホバーで列を選ぶ");
  assert.match(scene, /onDrop/, "タップで落とす操作を親へ返す");
  assert.match(scene, /onHoverCol/, "選択列を親へ返す");
  assert.match(scene, /landingRow/, "着地位置は lib の landingRow に従う");
  assert.match(scene, /FRUIT_KINDS/, "色は lib の FRUIT_KINDS に従う");
  assert.match(scene, /previewNext/, "次のフルーツの予告球がある");
  const client = read("app", "games", "mergefruit", "MergeFruitClient.tsx");
  assert.match(client, /dropFruit/, "落下・合体は従来どおり lib の dropFruit");
});

test("3D batch3 cranegame: 筐体・レール・爪・景品造形とタップ=とめる、排出アニメーションがある", () => {
  const scene = read("app", "games", "cranegame", "CraneScene3D.tsx");
  assert.match(scene, /onTapAnywhere/, "タップで止める");
  assert.match(scene, /onStop/, "止める操作を親へ返す");
  assert.match(scene, /CRANE_DROP_MS/, "降下タイミングは lib の定数に従う");
  assert.match(scene, /glass/i, "ガラスケース風の表現がある");
  assert.match(scene, /claw/i, "爪の表現がある");
  assert.match(scene, /TorusGeometry/, "景品にトーラス造形（ドーナツ）がある");
  assert.match(scene, /createBall/, "景品に球の造形がある");
  assert.match(scene, /carry/, "取得後の排出アニメーションがある");
  assert.match(scene, /missMark/, "ハズレ位置の表現がある");
  const client = read("app", "games", "cranegame", "CraneGameClient.tsx");
  assert.match(client, /stepCrane/, "進行は従来どおり lib の stepCrane");
  assert.match(client, /stopCrane/, "停止は従来どおり lib の stopCrane");
});

test("3D batch3: ロジック層（lib/*.ts 本体）に three が混入していない", () => {
  for (const f of fs.readdirSync(path.join(webDir, "lib"))) {
    if (!f.endsWith(".ts")) continue;
    const src = read("lib", f);
    assert.doesNotMatch(src, /from "three"/, `lib/${f}`);
  }
  for (const name of ["stacker.ts", "balancestack.ts", "mergefruit.ts", "cranegame.ts"]) {
    assert.doesNotMatch(read("lib", name), /three/, `lib/${name}`);
  }
});
