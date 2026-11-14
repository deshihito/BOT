// 3D化 第2バッチ（サイコロ系4本）の回帰テスト（静的検査）。
// 第1期（games-3d-batch1.test.mjs）と同じ観点:
// - 対象ゲームが dynamic import (ssr:false) でシーンを遅延読み込みしていること
// - クライアント側に three の直接 import がないこと（シーン側だけに閉じる）
// - <button> 数が現行値から増えていないこと
// - シーンが共通基盤（DiceSet / createStage / attachPickPointer）を使うこと
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
  { dir: "liarsdice", client: "LiarsDiceClient.tsx", scene: "LiarsDiceScene3D.tsx", buttons: 2 },
  { dir: "dicequest", client: "DiceQuestClient.tsx", scene: "DiceQuestScene3D.tsx", buttons: 1 },
];

for (const g of BATCH) {
  test(`3D batch2 ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, new RegExp(`dynamic\\(\\(\\) => import\\("\\./${g.scene.replace(".tsx", "")}"\\), \\{ ssr: false \\}\\)`), "dynamic import");
    assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
    assert.doesNotMatch(client, /three-kit/, "クライアントは three-kit も直接触らない");
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /from "three"/);
    assert.match(scene, /three-kit/, "共通基盤を使う");
    assert.match(scene, /createStage/, "ステージは共通基盤から作る");
    assert.match(scene, /attachPickPointer/, "入力はレイキャスト→既存ジェスチャ橋渡しを使う");
    assert.match(client, /onFail|webglFailed/, "WebGL 失敗時のフォールバックがある");
    assert.match(scene, /SceneBox/, "共通の外枠を使う");
  });

  test(`3D batch2 ${g.dir}: <button> 数が現行値（${g.buttons}）から増えていない`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });
}


test("3D batch2 liarsdice: 相手のダイスはカップで伏せ、自分のダイスだけ DiceSet で見せる", () => {
  const scene = read("app", "games", "liarsdice", "LiarsDiceScene3D.tsx");
  assert.match(scene, /createCup|カップ/);
  // 相手の値を描く経路がないこと（公開情報は個数だけ）。
  assert.doesNotMatch(scene, /opponent.*dice\[|opponents\[.*\]\.dice/, "相手の目を参照しない");
  const client = read("app", "games", "liarsdice", "LiarsDiceClient.tsx");
  assert.match(client, /diceCount/, "個数は DOM 併記のまま");
});



test("3D batch2 dicequest: 白2個＋色4個の6ダイス構成で DiceSet を使う", () => {
  const scene = read("app", "games", "dicequest", "DiceQuestScene3D.tsx");
  assert.match(scene, /DQ_COLORS/);
  assert.match(scene, /createDisc/, "色はダイス下の円盤で示す");
  const client = read("app", "games", "dicequest", "DiceQuestClient.tsx");
  assert.match(client, /白 \{state\.dice\.white/, "目は DOM 併記で読める");
});


test("3D batch2: ロジック層（lib/*.ts 本体）に three が混入していない", () => {
  for (const f of fs.readdirSync(path.join(webDir, "lib"))) {
    if (!f.endsWith(".ts")) continue;
    const src = read("lib", f);
    assert.doesNotMatch(src, /from "three"/, `lib/${f}`);
  }
});

test("3D batch2: 絵文字UIを持ち込んでいない（シーン内に絵文字がない）", () => {
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  for (const g of BATCH) {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, emoji, g.dir);
  }
});

test("3D batch2: サイコロ系シーンは DiceSet で転がす（diceroll を除く）", () => {
  for (const dir of ["liarsdice", "dicequest"]) {
    const files = fs.readdirSync(path.join(webDir, "app", "games", dir)).filter((f) => f.endsWith("Scene3D.tsx"));
    assert.equal(files.length, 1, dir);
    const scene = read("app", "games", dir, files[0]);
    assert.match(scene, /DiceSet/, dir);
    assert.match(scene, /\.roll\(/, `${dir} は DiceSet.roll で結果へ収束させる`);
  }
});
