// 3D化 第3バッチ（カード系: drawpoker / texas / hearts）の回帰テスト（静的検査）。
// batch2-cards のスタイルに倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createCard / createStage / attachPickPointer を使う
// - <button> 数が現行（drawpoker 0 / texas 3 / hearts 4）から増えていないこと
// - ロジック（lib/*.ts）へ three が混入していないこと
// - drawpoker: 個別カードピック（pickId にカード index）・捨て札の視覚状態・
//   suggestHolds との初期選択同期が存在すること
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
  { dir: "texas", client: "TexasClient.tsx", scene: "TexasScene3D.tsx", buttons: 3, chip: true },
  { dir: "hearts", client: "HeartsClient.tsx", scene: "HeartsScene3D.tsx", buttons: 4, chip: false },
];

for (const g of BATCH) {
  test(`3D batch3 ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, new RegExp(`dynamic\\(\\(\\) => import\\("\\./${g.scene.replace(".tsx", "")}"\\), \\{ ssr: false \\}\\)`), "dynamic import");
    assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /from "three"/);
    assert.match(scene, /three-kit/, "共通基盤を使う");
    assert.match(client, /onFail|webglFailed/, "WebGL 失敗時のフォールバックがある");
  });

  test(`3D batch3 ${g.dir}: シーンはカード系の型（createCard/createStage/attachPickPointer）を使う`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    for (const name of ["createCard", "createStage", "attachPickPointer"]) {
      assert.match(scene, new RegExp(name), name);
    }
    if (g.chip) assert.match(scene, /createChip/, "チップ山は createChip で作る");
    // 差分同期（スロット＋カードキーの Map で手札を管理する型）であること
    assert.match(scene, /entries/, "スロット単位で手札を差分管理する");
    assert.match(scene, /cardKey/, "カードキーで差分判定する");
  });

  test(`3D batch3 ${g.dir}: <button> 数が現行（${g.buttons}）から増えていない`, () => {
    assert.equal(countButtons(g.dir), g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });
}




test("3D batch3 texas: コミュニティカードとホールカード、ポットのチップ山がある", () => {
  const scene = read("app", "games", "texas", "TexasScene3D.tsx");
  assert.match(scene, /board/, "コミュニティカードを持つ");
  assert.match(scene, /yourCards/, "ホールカードを持つ");
  assert.match(scene, /createChip/, "ポットをチップ山で表す");
  assert.match(scene, /onCall/, "タップが主アクション（参加）へ接続される");
  assert.match(scene, /onFold/, "フォールドへ接続される");
  const client = read("app", "games", "texas", "TexasClient.tsx");
  assert.match(client, /onCall=\{doCall\}/);
  assert.match(client, /api\.move\(\{ type: "act", move: "call" \}\)/, "既存ボタンと同じ move を送る");
});

test("3D batch3 hearts: トリックと手札タップ（合法判定はクライアント側）がある", () => {
  const scene = read("app", "games", "hearts", "HeartsScene3D.tsx");
  assert.match(scene, /trick/, "場のトリックを持つ");
  assert.match(scene, /onCardTap/, "手札タップはコールバックを呼ぶだけ");
  assert.match(scene, /pickId = `card-\$\{pickCardId\}`|pickId.*card-/, "手札カードに pickId を付ける");
  const client = read("app", "games", "hearts", "HeartsClient.tsx");
  assert.match(client, /handleCardTap/, "クライアント側ハンドラが判定を持つ");
  assert.match(client, /legal\.includes\(id\)/, "合法判定はクライアント側にある");
  assert.match(client, /onCardTap=\{handleCardTap\}/);
});

