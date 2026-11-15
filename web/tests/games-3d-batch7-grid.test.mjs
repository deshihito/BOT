// 3D化 第7バッチ グリッド描画系（nonogram / nurikabe / shikaku / akari / slant）の
// 回帰テスト（静的検査）。既存バッチの流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createStage / attachPickPointer / SceneBox を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D へフォールバックする
// - <button> 数が現行（nonogram 1 / nurikabe 1 / shikaku 1 / akari 2 / slant 1）以下
// - 入力が既存ハンドラへ接続され、判定を 3D 側で再実装していないこと
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
  { dir: "nonogram", client: "NonogramClient.tsx", scene: "NonogramScene3D.tsx", buttons: 1, lib: "nonogram.ts" },
];

for (const g of BATCH) {
  test(`3D batch7-grid ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, new RegExp(`dynamic\\(\\(\\) => import\\("\\./${g.scene.replace(".tsx", "")}"\\), \\{ ssr: false \\}\\)`), "dynamic import");
    assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
    assert.doesNotMatch(client, /three-kit/, "クライアントは基盤を直接触らない");
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /from "three"/);
    assert.match(scene, /three-kit/, "共通基盤を使う");
    assert.match(scene, /createStage/, "ステージは共通基盤から作る");
    assert.match(scene, /attachPickPointer/, "入力は共通基盤のレイキャストで受ける");
    assert.match(scene, /SceneBox/, "外枠は共通基盤を使う");
    assert.match(scene, /pickId = `cell-\$\{i\}`/, "当たり判定メッシュに pickId を付ける");
    assert.match(client, /webglFailed/, "WebGL 失敗時のフォールバックがある");
    assert.match(client, /fallback=\{board2d\}/, "フォールバックとして既存 2D をシーンへ渡す");
  });

  test(`3D batch7-grid ${g.dir}: <button> 数が現行（${g.buttons}）以下`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });

  test(`3D batch7-grid ${g.dir}: シーンに絵文字UIがない（色と造形で表現）`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${g.dir} scene emoji`);
  });

  test(`3D batch7-grid ${g.dir}: ロジック層（lib/${g.lib}）に three が混入していない`, () => {
    assert.doesNotMatch(read("lib", g.lib), /from "three"/, `lib/${g.lib}`);
  });
}

test("3D batch7-grid nonogram: ヒント数字は DOM 併記が正で、3D は盤面マスのみを対象にする", () => {
  const scene = read("app", "games", "nonogram", "NonogramScene3D.tsx");
  assert.match(scene, /ヒント数字は盤外/, "ヒントを DOM 併記に委ねる旨をシーン冒頭に明記する");
  const client = read("app", "games", "nonogram", "NonogramClient.tsx");
  assert.match(client, /col3d-/, "3D レイアウトでも列ヒントを DOM で併記する");
  assert.match(client, /row3d-/, "3D レイアウトでも行ヒントを DOM で併記する");
  assert.match(client, /satisfaction\.cols/, "ヒントの消し込み表示を 3D 側でも維持する");
});

test("3D batch7-grid nonogram: 塗り=立方体 / ×印=平板＋斜めバー / 空=平板で3状態を造形する", () => {
  const scene = read("app", "games", "nonogram", "NonogramScene3D.tsx");
  assert.match(scene, /createCrossCell/, "×印マスを造形する");
  assert.match(scene, /rotation\.y = rot/, "×印は細いバーを斜めに交差させる");
  assert.match(scene, /0x33415c/, "塗りは現行 2D と同じ濃色");
  assert.match(scene, /0xe5484d/, "間違い塗りは現行 2D と同じ赤");
  assert.match(scene, /0x2f6db3/, "完成時の塗りは現行 2D と同じ青");
});

test("3D batch7-grid nonogram: 押下とドラッグ継続が現行の startPaint / continuePaint へ接続される", () => {
  const scene = read("app", "games", "nonogram", "NonogramScene3D.tsx");
  assert.match(scene, /onTap: startFromHit/, "タップが塗り開始へ接続される");
  assert.match(scene, /onDragStart: startFromHit/, "ドラッグ開始も塗り開始へ接続される");
  assert.match(scene, /onDragMove/, "ドラッグ継続を受け付ける");
  assert.match(scene, /pointToIndex\(point/, "planePoint をセルへ変換する");
  assert.match(scene, /propsRef\.current\.onPaintStart\(/, "開始は親ハンドラへ渡す");
  assert.match(scene, /propsRef\.current\.onPaintContinue\(/, "継続は親ハンドラへ渡す");
  assert.doesNotMatch(scene, /setNonoMark\(/, "印の決定を 3D 側で再実装しない");
  const client = read("app", "games", "nonogram", "NonogramClient.tsx");
  assert.match(client, /onPaintStart=\{startPaint\}/, "既存の startPaint へ接続する");
  assert.match(client, /onPaintContinue=\{continuePaint\}/, "既存の continuePaint へ接続する");
});








