// 3D化 第5バッチ 物体系（cube / mole）の回帰テスト（静的検査）。
// 既存バッチの流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createStage / attachPickPointer を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D へフォールバックする
// - <button> 数が現行（cube 3 / mole 3）以下
// - 入力が既存ハンドラ（cube: doMove / mole: whack）へ接続される
// - ロジック（lib/cube.ts, lib/mole.ts）へ three が混入していないこと
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
  { dir: "cube", client: "CubeClient.tsx", scene: "CubeScene3D.tsx", buttons: 3 },
  { dir: "mole", client: "MoleClient.tsx", scene: "MoleScene3D.tsx", buttons: 3 },
];

for (const g of BATCH) {
  test(`3D batch5-objects ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
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
  });

  test(`3D batch5-objects ${g.dir}: <button> 数が現行（${g.buttons}）以下`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });
}

test("3D batch5-objects cube: 立方体造形とステッカー色が lib の状態に従い、回転は lastMove の差分で追従する", () => {
  const scene = read("app", "games", "cube", "CubeScene3D.tsx");
  assert.match(scene, /SLOTS/, "ステッカーのスロット配置を持つ");
  assert.match(scene, /COLOR_INT/, "ステッカー色は lib の色名から引く");
  assert.match(scene, /next\[s\.slot\]/, "色は props の stickers から差分同期する");
  assert.match(scene, /lastMove\.seq/, "回転アニメーションは lastMove の連番で遷移を検出する");
  assert.match(scene, /pivot\.attach/, "該当レイヤーの小キューブをピボットへ移して回す");
  assert.match(scene, /MOVE_VISUAL/, "面ごとの回転軸・符号は見た目パラメータとして持つ");
  assert.doesNotMatch(scene, /CW_PERMUTATION|applyCubeMove|isCubeSolved/, "置換・勝敗判定を 3D 側で再実装しない");
  const client = read("app", "games", "cube", "CubeClient.tsx");
  assert.match(client, /onMove=\{doMove\}/, "3D の操作が既存の doMove へ接続される");
  assert.match(client, /lastMove=\{lastMove\}/, "適用した手をシーンへ渡す");
  assert.match(client, /applyCubeMove\(s, move\)/, "状態遷移は lib の applyCubeMove のまま");
});

test("3D batch5-objects cube: 入力分岐は掴んだ対象で決まる（面=面操作 / 背景=視点回転）", () => {
  const scene = read("app", "games", "cube", "CubeScene3D.tsx");
  assert.match(scene, /pickId = "background"/, "背景に視点回転用の当たり判定を持つ");
  assert.match(scene, /dragMode = "orbit"/, "背景を掴んだら視点回転モードになる");
  assert.match(scene, /dragMode = "face"/, "面を掴んだら面操作モードになる");
  assert.match(scene, /onTap:/, "面タップが時計回りの入力になる");
  assert.match(scene, /faceFromNormal/, "掴んだ面の法線から操作する面を決める");
  assert.match(scene, /crossVectors\(slot\.normal, d\)/, "スワイプは法線×方向で回転軸を決める");
  assert.match(scene, /onMove\(\(isCw \? face : /, "スワイプ方向で CW / CCW を出し分ける");
});

test("3D batch5-objects mole: 立体モグラと穴が造形され、出現は active の差分で上下する", () => {
  const scene = read("app", "games", "mole", "MoleScene3D.tsx");
  assert.match(scene, /hole-\$\{hole\}/, "穴に pickId を付ける");
  assert.match(scene, /SphereGeometry/, "モグラは球などのプリミティブで造形する");
  assert.match(scene, /targetY = entry\.hit \? HIT_Y : UP_Y/, "出現/ヒットで目標の高さを切り替える");
  assert.match(scene, /targetScaleY = entry\.hit \? 0\.45 : 1/, "ヒット時は扁平で反応する");
  assert.match(scene, /onWhack\(Number\(/, "穴タップが onWhack へ接続される");
  const client = read("app", "games", "mole", "MoleClient.tsx");
  assert.match(client, /onWhack=\{whack\}/, "既存の whack ハンドラへ接続する");
  assert.match(client, /applyMoleHit\(scoreRef\.current/, "得点計算は lib の applyMoleHit のまま");
  assert.match(client, /createMoleSchedule/, "出現スケジュールは lib のまま");
});

test("3D batch5-objects mole: 金モグラは色とリングで区別する（現行の視覚区別を維持）", () => {
  const scene = read("app", "games", "mole", "MoleScene3D.tsx");
  assert.match(scene, /GOLD_COLOR/, "金モグラの色を持つ");
  assert.match(scene, /entry\.kind === "gold"/, "種類で色とリングを切り替える");
  assert.match(scene, /ring\.visible = entry\.kind === "gold" && !entry\.hit/, "金モグラは穴まわりのリングでも示す");
});

test("3D batch5-objects: ロジック層（lib/cube.ts, lib/mole.ts）に three が混入していない", () => {
  for (const f of ["cube.ts", "mole.ts"]) {
    assert.doesNotMatch(read("lib", f), /from "three"/, `lib/${f}`);
  }
});

test("3D batch5-objects: three-kit は無変更前提でシーン側にだけ three がある", () => {
  for (const g of BATCH) {
    const client = read("app", "games", g.dir, g.client);
    assert.doesNotMatch(client, /three-kit/, `${g.dir} client は基盤を直接触らない`);
  }
});

test("3D batch5-objects: シーンに絵文字UIがない（色は材質で表現）", () => {
  for (const g of BATCH) {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${g.dir} scene emoji`);
  }
});
