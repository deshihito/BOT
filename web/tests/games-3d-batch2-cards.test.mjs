// 3D化 第2バッチ（カード系B）の回帰テスト（静的検査）。
// blackjack で確定した「カード系の型」を baccarat が再利用していること:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createCard / createChip / createStage / attachPickPointer を使う
//   （配布アニメーション・めくれ・手札配置・チップ連携の共通基盤）
// - <button> 数が現行（両ゲームとも 0）から増えていないこと
// - ロジック（lib/*.ts）へ three が混入していないこと
// - createCard の複合ラベル（ランク+スート）が文字数でフォント調整されること
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
  { dir: "blackjack", client: "BlackjackClient.tsx", scene: "BlackjackScene3D.tsx", buttons: 0 },
  { dir: "baccarat", client: "BaccaratClient.tsx", scene: "BaccaratScene3D.tsx", buttons: 0 },
];

for (const g of BATCH) {
  test(`3D cards ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, new RegExp(`dynamic\\(\\(\\) => import\\("\\./${g.scene.replace(".tsx", "")}"\\), \\{ ssr: false \\}\\)`), "dynamic import");
    assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /from "three"/);
    assert.match(scene, /three-kit/, "共通基盤を使う");
    assert.match(client, /onFail|webglFailed/, "WebGL 失敗時のフォールバックがある");
  });

  test(`3D cards ${g.dir}: シーンはカード系の型（createCard/createStage/attachPickPointer/createChip）を使う`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    for (const name of ["createCard", "createStage", "attachPickPointer", "createChip"]) {
      assert.match(scene, new RegExp(name), name);
    }
    // 配布の差分同期（新しいカードだけが山札位置から飛ぶ型）であること
    assert.match(scene, /DECK_POS/, "山札位置を起点に配る");
    assert.match(scene, /entries/, "スロット単位で手札を差分管理する");
  });

  test(`3D cards ${g.dir}: <button> 数が現行（${g.buttons}）から増えていない`, () => {
    assert.equal(countButtons(g.dir), g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });
}

test("3D cards blackjack: ディーラーの伏せカードがめくれる（hidden の差分でフリップする）", () => {
  const scene = read("app", "games", "blackjack", "BlackjackScene3D.tsx");
  assert.match(scene, /hidden/, "伏せ状態を持つ");
  assert.match(scene, /FACE_DOWN/, "裏向きの回転を持つ");
  assert.match(scene, /FACE_UP/, "表向きの回転へ遷移する");
  // スタンドは下方向ジェスチャ、ダブルはダブルタップ/チップタップに接続される
  assert.match(scene, /onStand/);
  assert.match(scene, /onDouble/);
  assert.match(scene, /pickId = "chip"|pickId: "chip"|"chip"/, "チップがピック対象になる");
});

test("3D cards: createCard の複合ラベルは文字数に応じてフォントサイズが調整される", () => {
  const prim = read("lib", "three-kit", "primitives.ts");
  assert.match(prim, /label\.length/, "ランク+スート等の複数文字ラベル対応");
});

test("3D cards: ロジック層（lib/blackjack.ts, lib/baccarat.ts, lib/drawpoker.ts）に three が混入していない", () => {
  for (const f of ["blackjack.ts", "baccarat.ts", "drawpoker.ts"]) {
    assert.doesNotMatch(read("lib", f), /from "three"/, `lib/${f}`);
  }
});
