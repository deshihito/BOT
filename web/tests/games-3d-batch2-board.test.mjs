// 3D化 第2バッチ（backgammon / checkers / halma）の回帰テスト（静的検査）。
// 第1期（games-3d-batch1.test.mjs）のスタイルに倣う:
// - 対象ゲームが dynamic import (ssr:false) でシーンを遅延読み込みしていること
// - クライアント側に three の直接 import がないこと（シーン側だけに閉じる）
// - <button> 数が現行値（各1）から増えていないこと
// - シーンが three-kit の共通基盤（createStage / attachPickPointer 等）を使うこと
// - ロジック（lib/*.ts）へ three が混入していないこと
import { test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const webDir = path.join(import.meta.dirname, "..");
const read = (...p) => fs.readFileSync(path.join(webDir,...p), "utf8");
const countButtons = (dir) => {
let n = 0;
for (const f of fs.readdirSync(path.join(webDir, "app", "games", dir))) {
if (f.endsWith(".tsx")) n += (read("app", "games", dir, f).match(/<button/g)?? []).length;
}
return n;
};

const BATCH = [
{ dir: "backgammon", client: "BackgammonClient.tsx", scene: "BackgammonScene3D.tsx", buttons: 1},
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

test("3D backgammon: チェッカーは createDisc、ダイスは DiceSet、バー/上がりも表現する", () => {
const scene = read("app", "games", "backgammon", "BackgammonScene3D.tsx");
assert.match(scene, /createDisc/, "チェッカーは共通プリミティブで作る");
assert.match(scene, /DiceSet/, "ダイスは共通 DiceSet で盤上に表示する");
assert.match(scene, /from "@\/lib\/three-kit\/dice"/, "DiceSet は three-kit から import する");
assert.match(scene, /barPos/, "バー上の駒を表現する");
assert.match(scene, /offPos/, "上がった駒（ボードオフ）を表現する");
const client = read("app", "games", "backgammon", "BackgammonClient.tsx");
assert.match(client, /onPoint=\{onPointClick\}/, "入力は既存のマスタップ処理へ接続する");
assert.match(client, /onBearOff=\{bearOff\}/, "上がりは既存処理へ接続する");
});




test("3D batch2: ロジック層（backgammon）に three が混入していない", () => {
for (const f of ["backgammon.ts"]) {
assert.doesNotMatch(read("lib", f), /from "three"/, `lib/${f}`);
assert.doesNotMatch(read("lib", f), /three-kit/, `lib/${f}`);
}
});
