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
  { dir: "nurikabe", client: "NurikabeClient.tsx", scene: "NurikabeScene3D.tsx", buttons: 1, lib: "nurikabe.ts" },
  { dir: "shikaku", client: "ShikakuClient.tsx", scene: "ShikakuScene3D.tsx", buttons: 1, lib: "shikaku.ts" },
  { dir: "akari", client: "AkariClient.tsx", scene: "AkariScene3D.tsx", buttons: 2, lib: "akari.ts" },
  { dir: "slant", client: "SlantClient.tsx", scene: "SlantScene3D.tsx", buttons: 1, lib: "slant.ts" },
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

test("3D batch7-grid nurikabe: 海=沈んだ濃色 / 島=白い盛り上がり / 数字は上面テクスチャで大きく", () => {
  const scene = read("app", "games", "nurikabe", "NurikabeScene3D.tsx");
  assert.match(scene, /createClueTile/, "数字マスを造形する");
  assert.match(scene, /canvasTexture/, "数字は上面テクスチャで描く");
  assert.match(scene, /0x334155/, "海は現行 2D と同じ濃色");
  assert.match(scene, /createBadFrame/, "違反マスは赤枠で示す");
});

test("3D batch7-grid nurikabe: タップが onCell、下スワイプが onCheck へ接続される", () => {
  const scene = read("app", "games", "nurikabe", "NurikabeScene3D.tsx");
  assert.match(scene, /propsRef\.current\.onCell\(/, "タップが onCell を呼ぶ");
  assert.match(scene, /flick\.dir === "down"/, "下方向のフリックをチェックに使う");
  assert.match(scene, /propsRef\.current\.onCheck\(\)/, "スワイプが onCheck を呼ぶ");
  assert.doesNotMatch(scene, /cycleNurikabeMark\(|checkNurikabe\(/, "循環・チェック判定を 3D 側で再実装しない");
  const client = read("app", "games", "nurikabe", "NurikabeClient.tsx");
  assert.match(client, /onCell=\{onCell\}/, "既存の onCell へ接続する");
  assert.match(client, /onCheck=\{onCheck\}/, "既存の onCheck へ接続する");
});

test("3D batch7-grid shikaku: ドラッグ3点（開始/プレビュー/確定）で矩形を描く", () => {
  const scene = read("app", "games", "shikaku", "ShikakuScene3D.tsx");
  assert.match(scene, /onDragStart:/, "ドラッグ開始で開始セルを記録する");
  assert.match(scene, /onDragMove:/, "ドラッグ移動でプレビューを更新する");
  assert.match(scene, /onDragEnd:/, "ドラッグ終了で確定する");
  assert.match(scene, /showPreview/, "プレビュー矩形を表示する");
  assert.match(scene, /opacity: 0\.38/, "プレビューは半透明で表示する");
  assert.match(scene, /propsRef\.current\.onDragRect\(/, "確定は親ハンドラへ渡す");
  assert.doesNotMatch(scene, /applyShikakuRect\(|removeShikakuRectAt\(/, "長方形の適用・削除を 3D 側で再実装しない");
});

test("3D batch7-grid shikaku: タップは現行 onCell（2タップ方式）へ接続され、確定済み矩形は色面＋境界で表す", () => {
  const scene = read("app", "games", "shikaku", "ShikakuScene3D.tsx");
  assert.match(scene, /propsRef\.current\.onCell\(/, "タップが onCell を呼ぶ");
  assert.match(scene, /createCluePlate/, "数字は上面プレートで大きく描く");
  assert.match(scene, /createEdgeBar/, "長方形の境界をバーで表す");
  assert.match(scene, /RECT_HEX/, "長方形は現行 2D と同じ色順で区別する");
  const client = read("app", "games", "shikaku", "ShikakuClient.tsx");
  assert.match(client, /onCell=\{onCell\}/, "既存の onCell へ接続する");
  assert.match(client, /onDragRect=\{handleDragRect\}/, "ドラッグ確定ハンドラへ接続する");
  assert.match(client, /const handleDragRect[\s\S]*?applyShikakuRect\(s, \{ r1, c1, r2, c2 \}\)/, "ドラッグ確定は onCell の2タップ目と同じ applyShikakuRect 経路で適用する");
});

test("3D batch7-grid akari: 電球=発光球＋台座 / 照らされたマス=明るい面色 / 数字壁は上面テクスチャ", () => {
  const scene = read("app", "games", "akari", "AkariScene3D.tsx");
  assert.match(scene, /createBulb/, "電球を造形する");
  assert.match(scene, /createPeg/, "電球の台座は three-kit の円柱で作る");
  assert.match(scene, /emissive/, "電球と照らされた面は発光で表す");
  assert.match(scene, /createNumberedWall/, "数字つき壁を造形する");
  assert.match(scene, /canvasTexture/, "壁の数字は上面テクスチャで描く");
  assert.match(scene, /0x26221f/, "壁は現行 2D と同じ黒");
});

test("3D batch7-grid akari: 照光は親の evaluateAkari 結果を使い、タップは handleCell へ接続される", () => {
  const scene = read("app", "games", "akari", "AkariScene3D.tsx");
  assert.match(scene, /propsRef\.current\.onCell\(/, "タップが onCell を呼ぶ");
  assert.doesNotMatch(scene, /akariLitCells\(|evaluateAkari\(|toggleBulb\(/, "光伝播・設置判定を 3D 側で再計算しない");
  const client = read("app", "games", "akari", "AkariClient.tsx");
  assert.match(client, /lit=\{evaluation\.lit\}/, "照光マスクは親の評価結果を渡す");
  assert.match(client, /conflictBulbs=\{evaluation\.conflictBulbs\}/, "衝突情報は親の評価結果を渡す");
  assert.match(client, /onCell=\{handleCell\}/, "既存の handleCell へ接続する");
});

test("3D batch7-grid slant: 斜線は45度回転の薄い直方体、数字は格子点の円盤＋テクスチャで表す", () => {
  const scene = read("app", "games", "slant", "SlantScene3D.tsx");
  assert.match(scene, /createSlash/, "斜線を造形する");
  assert.match(scene, /rotation\.y = mark === 1 \? Math\.PI \/ 4 : -Math\.PI \/ 4/, "斜線は向きに応じて45度回転させる");
  assert.match(scene, /pointPos/, "格子点の位置へ数字を置く");
  assert.match(scene, /createClueDisc/, "格子点の数字は円盤で表す");
  assert.match(scene, /canvasTexture/, "数字は円盤上面テクスチャで描く");
  assert.match(scene, /0x427f87/, "斜線色は現行 2D の --accent と同じ");
});

test("3D batch7-grid slant: タップが既存 handleCell へ接続され、循環判定を再実装しない", () => {
  const scene = read("app", "games", "slant", "SlantScene3D.tsx");
  assert.match(scene, /propsRef\.current\.onCell\(/, "タップが onCell を呼ぶ");
  assert.doesNotMatch(scene, /cycleSlantCell\(|slantViolations\(/, "循環・違反判定を 3D 側で再実装しない");
  const client = read("app", "games", "slant", "SlantClient.tsx");
  assert.match(client, /onCell=\{handleCell\}/, "既存の handleCell へ接続する");
  assert.match(client, /badPoints=\{\[\.\.\.badPoints\]\}/, "違反格子点は親の検証結果を渡す");
});
