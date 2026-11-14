// 3D化 第5バッチ A系その1（penalty / missile）の回帰テスト（静的検査）。
// 既存バッチの流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createStage / attachPickPointer を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D へフォールバックする
// - <button> 数が現行（penalty 2 / missile 1）以下
// - 入力が既存ハンドラ（penalty: choose 経由 playerShoot/playerDive、
//   missile: fireAtPoint 経由 fireAt）へ接続される
// - ロジック（lib/*.ts）へ three が混入していないこと
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
  { dir: "penalty", client: "PenaltyClient.tsx", scene: "PenaltyScene3D.tsx", buttons: 2 },
  { dir: "missile", client: "MissileClient.tsx", scene: "MissileScene3D.tsx", buttons: 1 },
];

for (const g of BATCH) {
  test(`3D batch5-action1 ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
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

  test(`3D batch5-action1 ${g.dir}: <button> 数が現行（${g.buttons}）以下`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });
}

test("3D batch5-action1 penalty: ゴール面タップがゾーンへ正規化され既存 choose へ接続され、結果へ追従する", () => {
  const scene = read("app", "games", "penalty", "PenaltyScene3D.tsx");
  assert.match(scene, /zoneFromPoint/, "ワールド点をゾーンへ変換する");
  assert.match(scene, /onChoose\(zoneFromPoint\(hit\.point\)\)/, "タップ点がゾーンとして onChoose へ渡る");
  assert.match(scene, /createBall/, "ボールは createBall で造形する");
  assert.match(scene, /penalty-net/, "ネットは格子テクスチャで表現する");
  assert.match(scene, /zoneCenter\(last\.zone\)/, "ボールは lib のキックの zone へ飛ぶ");
  assert.match(scene, /last\.keeperZone/, "キーパーは lib の keeperZone へ飛ぶ");
  assert.match(scene, /last\.outcome/, "結果（ゴール/セーブ/ミス）でボールの行き先を変える");
  const client = read("app", "games", "penalty", "PenaltyClient.tsx");
  assert.match(client, /onChoose=\{choose\}/, "既存の choose ハンドラへ接続する");
  assert.match(client, /playerShoot\(state, zoneId\)/, "攻撃ターンは lib の playerShoot のまま");
  assert.match(client, /playerDive\(state, zoneId\)/, "守備ターンは lib の playerDive のまま");
  assert.match(client, /state=\{state\}/, "状態は props でシーンへ渡す");
});

test("3D batch5-action1 missile: 空タップが既存 fireAt 座標系へ接続され、状態へ onFrame 補間追従する", () => {
  const scene = read("app", "games", "missile", "MissileScene3D.tsx");
  assert.match(scene, /getState/, "親ループの状態は getState で読む");
  assert.match(scene, /onFire\(toGameX\(hit\.point\.x\), toGameY\(hit\.point\.y\)\)/, "レイキャスト点がゲーム座標へ変換され onFire へ渡る");
  assert.match(scene, /enemyPosition\(m\)/, "敵ミサイル位置は lib の enemyPosition を使う");
  assert.match(scene, /interceptorPosition\(m\)/, "迎撃弾位置は lib の interceptorPosition を使う");
  assert.match(scene, /blastRadius\(b\.ageSteps\)/, "爆風半径は lib の blastRadius を使う");
  assert.match(scene, /\.lerp\(/, "表示位置は onFrame で補間追従する");
  assert.match(scene, /pickId = "sky"/, "空の面がピック対象");
  const client = read("app", "games", "missile", "MissileClient.tsx");
  assert.match(client, /getState=\{\(\) => stateRef\.current\}/, "既存の stateRef を getState として渡す");
  assert.match(client, /onFire=\{fireAtPoint\}/, "既存の fireAtPoint ハンドラへ接続する");
  assert.match(client, /fireAt\(cur, x, y\)/, "発射は lib の fireAt のまま");
  assert.match(client, /stepMissile\(s\)/, "固定ステップは lib の stepMissile のまま");
});

test("3D batch5-action1: ロジック層（lib/penalty.ts, lib/missile.ts）に three が混入していない", () => {
  for (const f of ["penalty.ts", "missile.ts"]) {
    assert.doesNotMatch(read("lib", f), /from "three"/, `lib/${f}`);
  }
});

test("3D batch5-action1: シーンに絵文字UIがない（造形と材質で表現）", () => {
  for (const g of BATCH) {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${g.dir} scene emoji`);
  }
});
