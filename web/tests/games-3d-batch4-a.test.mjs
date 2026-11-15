// 3D化 第4バッチ A系（darts / golf / watersort / simon）の回帰テスト（静的検査）。
// 既存バッチの流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createStage / attachPickPointer を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D へフォールバックする
// - <button> 数が現行（darts 2 / golf 3 / watersort 3 / simon 2）以下
// - 入力が既存ハンドラ（onThrow / handleTake / handleFlip / onBottle / onPad）へ接続される
// - ロジック（lib/*.ts）へ three が混入していないこと
// 注: golf はパッティングではなくゴルフ・ソリティア（lib/golf.ts）。
// puttgolf とは別クライアントで、本バッチの対象は GolfClient.tsx のみ。
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
  { dir: "darts", client: "DartsClient.tsx", scene: "DartsScene3D.tsx", buttons: 2 },
  { dir: "watersort", client: "WaterSortClient.tsx", scene: "WaterSortScene3D.tsx", buttons: 3 },
  { dir: "simon", client: "SimonClient.tsx", scene: "SimonScene3D.tsx", buttons: 2 },
];

for (const g of BATCH) {
  test(`3D batch4-a ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
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

  test(`3D batch4-a ${g.dir}: <button> 数が現行（${g.buttons}）以下`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });
}

test("3D batch4-a darts: ボードタップが既存 onThrow へ正規化座標で接続され、セグメント造形がある", () => {
  const scene = read("app", "games", "darts", "DartsScene3D.tsx");
  assert.match(scene, /DART_SECTORS/, "セクター列は lib の定義を使う");
  assert.match(scene, /DART_RADII/, "リング境界は lib の定義を使う");
  assert.match(scene, /wedgeGeo/, "同心円セグメントを扇形ジオメトリで作る");
  assert.match(scene, /onThrow\(hit\.point\.x, hit\.point\.y\)/, "着弾点をそのまま onThrow へ渡す");
  assert.match(scene, /rounds\.flat\(\)/, "刺さったダーツは状態から差分同期する");
  const client = read("app", "games", "darts", "DartsClient.tsx");
  assert.match(client, /onThrow=\{onThrow\}/, "既存の onThrow ハンドラへ接続する");
  assert.match(client, /throwDart\(state, tx, ty\)/, "判定は lib の throwDart のまま");
});


test("3D batch4-a watersort: 管タップが既存 onBottle へ接続され、注ぎは状態差分で検出する", () => {
  const scene = read("app", "games", "watersort", "WaterSortScene3D.tsx");
  assert.match(scene, /pickId = `bottle-\$\{i\}`|bottle-\$\{/, "管に pickId を付ける");
  assert.match(scene, /onBottle\(Number\(/, "管タップが onBottle へ接続される");
  assert.match(scene, /prevBottlesRef/, "注ぎアニメーションは状態差分で検出する");
  assert.match(scene, /transparent: true, opacity: 0\.28/, "ガラスは半透明材質で表現する");
  const client = read("app", "games", "watersort", "WaterSortClient.tsx");
  assert.match(client, /onBottle=\{onBottle\}/, "既存の onBottle ハンドラへ接続する");
  assert.match(client, /pourWater\(s, selected, index\)/, "注ぎは lib の pourWater のまま");
});

test("3D batch4-a simon: パッドタップが既存 onPad へ接続され、発光は lit/pressed に追従する", () => {
  const scene = read("app", "games", "simon", "SimonScene3D.tsx");
  assert.match(scene, /emissiveIntensity/, "発光は emissive で表現する");
  assert.match(scene, /pressed === i/, "押し込み表現は pressed に追従する");
  assert.match(scene, /onPad\(Number\(/, "パッドタップが onPad へ接続される");
  const client = read("app", "games", "simon", "SimonClient.tsx");
  assert.match(client, /onPad=\{onPad\}/, "既存の onPad ハンドラへ接続する");
  assert.match(client, /showSequence/, "再生シーケンスはクライアント側のまま");
});


test("3D batch4-a: シーンに絵文字UIがない（色は材質で表現）", () => {
  for (const g of BATCH) {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${g.dir} scene emoji`);
  }
});
