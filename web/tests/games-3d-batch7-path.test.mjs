// 3D化 第7バッチ 経路・配置系（hashi / numberlink / skyscrapers / queens）の
// 回帰テスト（静的検査）。既存バッチの流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createStage / attachPickPointer / SceneBox を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D へフォールバックする
// - <button> 数が現行（hashi 4 / numberlink 3 / skyscrapers 1 / queens 3）以下
// - 入力が既存ハンドラへ接続され、判定を 3D 側で再実装していないこと
// - ロジック（lib/hashi.ts 等）へ three が混入していないこと
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
  { dir: "hashi", client: "HashiClient.tsx", scene: "HashiScene3D.tsx", buttons: 4, lib: "hashi.ts" },
  { dir: "numberlink", client: "NumberLinkClient.tsx", scene: "NumberLinkScene3D.tsx", buttons: 3, lib: "numberlink.ts" },
  { dir: "skyscrapers", client: "SkyscrapersClient.tsx", scene: "SkyscrapersScene3D.tsx", buttons: 1, lib: "skyscrapers.ts" },
  { dir: "queens", client: "QueensClient.tsx", scene: "QueensScene3D.tsx", buttons: 3, lib: "queens.ts" },
];

for (const g of BATCH) {
  test(`3D batch7-path ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
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
    assert.match(scene, /fitCamera/, "盤全体が収まるカメラ調整がある");
    assert.match(scene, /pickId/, "当たり判定メッシュに pickId を付ける");
    assert.match(client, /webglFailed/, "WebGL 失敗時のフォールバックがある");
    assert.match(client, /fallback=\{board2d\}/, "フォールバックとして既存 2D をシーンへ渡す");
    assert.match(client, /const board2d = \(/, "既存 2D 盤面が board2d として切り出されている");
  });

  test(`3D batch7-path ${g.dir}: <button> 数が現行（${g.buttons}）以下`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });

  test(`3D batch7-path ${g.dir}: シーンに絵文字UIがない（色と造形とテクスチャ数字で表現）`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${g.dir} scene emoji`);
  });

  test(`3D batch7-path ${g.dir}: ロジック層（lib/${g.lib}）に three が混入していない`, () => {
    assert.doesNotMatch(read("lib", g.lib), /from "three"/, `lib/${g.lib}`);
  });
}

test("3D batch7-path hashi: 島は数字つき円柱、橋は 2D の二重線に合わせた並行2本で表す", () => {
  const scene = read("app", "games", "hashi", "HashiScene3D.tsx");
  assert.match(scene, /createIsland/, "島を造形する");
  assert.match(scene, /CylinderGeometry/, "島は円柱で表す");
  assert.match(scene, /canvasTexture/, "島の数字は上面テクスチャで大きく描く");
  assert.match(scene, /hashiCandidateEdges/, "橋の候補と当たり判定は lib の候補辺を正とする");
  assert.match(scene, /hashiBridgeCount/, "橋の本数は lib の状態から読む");
  assert.match(scene, /count === 2 \? \[-0\.13, 0\.13\] : \[0\]/, "2本の橋は並行2本のバーで表す");
  assert.doesNotMatch(scene, /cycleHashiBridge\(|hashiTapEdge\(|isHashiComplete\(/, "橋の循環・交差・完成判定を 3D 側で再実装しない");
});

test("3D batch7-path hashi: 橋マスのタップが既存 onBridgeCellTap ハンドラへ接続される", () => {
  const scene = read("app", "games", "hashi", "HashiScene3D.tsx");
  assert.match(scene, /pickId = `cell-\$\{index\}`/, "橋セルに pickId を付ける");
  assert.match(scene, /propsRef\.current\.onBridgeCell\(Number\(id\.slice\(5\)\)\)/, "タップが onBridgeCell を呼ぶ");
  const client = read("app", "games", "hashi", "HashiClient.tsx");
  assert.match(client, /onBridgeCell=\{onBridgeCellTap\}/, "既存の onBridgeCellTap へ接続する");
  assert.match(client, /hashiTapEdge\(state, index/, "交差セルの辺選択は既存の hashiTapEdge が担う");
  assert.match(client, /cycleHashiBridge\(state, a, b\)/, "橋の循環は既存の cycleHashiBridge が担う");
});

test("3D batch7-path numberlink: 端点は数字つき円盤、経路は端点色の盛り上がったタイルで表す", () => {
  const scene = read("app", "games", "numberlink", "NumberLinkScene3D.tsx");
  assert.match(scene, /createEndpoint/, "端点を造形する");
  assert.match(scene, /CylinderGeometry/, "端点は円盤で表す");
  assert.match(scene, /canvasTexture/, "端点の数字は上面テクスチャで大きく描く");
  assert.match(scene, /ownerOf/, "経路の所有ペアは lib の ownerOf を正とする");
  assert.match(scene, /isPairConnected/, "接続済み表示は lib の判定を正とする");
  assert.match(scene, /PAIR_COLORS/, "ペア色は現行 2D と同じ並びを使う");
  assert.doesNotMatch(scene, /applyStroke\(|clearPath\(|checkNumberlink\(/, "ストローク適用・完成判定を 3D 側で再実装しない");
});

test("3D batch7-path numberlink: ドラッグが beginStroke / extendStroke / endStroke へ橋渡しされる", () => {
  const scene = read("app", "games", "numberlink", "NumberLinkScene3D.tsx");
  assert.match(scene, /onDragStart/, "ドラッグ開始を橋渡しする");
  assert.match(scene, /propsRef\.current\.onStrokeStart\(cell\)/, "開始セルを onStrokeStart へ渡す");
  assert.match(scene, /onDragMove/, "ドラッグ移動を橋渡しする");
  assert.match(scene, /cellFromPoint\(point, propsRef\.current\.size\)/, "planePoint をセルへ変換する");
  assert.match(scene, /propsRef\.current\.onStrokeMove\(cell\)/, "移動セルを onStrokeMove へ逐次渡す");
  assert.match(scene, /onDragEnd/, "ドラッグ終了を橋渡しする");
  assert.match(scene, /propsRef\.current\.onStrokeEnd\(\)/, "終了を onStrokeEnd へ渡す");
  assert.match(scene, /planeY: 0\.15/, "ドラッグ平面の高さを指定する");
  const client = read("app", "games", "numberlink", "NumberLinkClient.tsx");
  assert.match(client, /onStrokeStart=\{beginStroke\}/, "既存の beginStroke へ接続する");
  assert.match(client, /onStrokeMove=\{extendStroke\}/, "既存の extendStroke へ接続する");
  assert.match(client, /onStrokeEnd=\{endStroke\}/, "既存の endStroke へ接続する");
  assert.match(client, /applyStroke\(s, pair, cells\)/, "ストローク適用は既存の applyStroke が担う");
});

test("3D batch7-path skyscrapers: ビルの高さ比と外周ヒントプレートで表す", () => {
  const scene = read("app", "games", "skyscrapers", "SkyscrapersScene3D.tsx");
  assert.match(scene, /createBuilding/, "ビルを造形する");
  assert.match(scene, /value \* 0\.3/, "ブロックの高さはビルの高さに比例させる");
  assert.match(scene, /canvasTexture/, "高さとヒントの数字はテクスチャで大きく描く");
  assert.match(scene, /createCluePlate/, "外周ヒントは小プレートで表す");
  assert.match(scene, /clues\.top\[i\]/, "上ヒントを盤外周に置く");
  assert.match(scene, /clues\.bottom\[i\]/, "下ヒントを盤外周に置く");
  assert.match(scene, /clues\.left\[i\]/, "左ヒントを盤外周に置く");
  assert.match(scene, /clues\.right\[i\]/, "右ヒントを盤外周に置く");
  assert.match(scene, /selRing/, "選択中マスはリングで示す");
  assert.doesNotMatch(scene, /setSkyValue\(|skyViolations\(|checkSky\(/, "入力・検証・完成判定を 3D 側で再実装しない");
});

test("3D batch7-path skyscrapers: マスタップが選択ハンドラへ、高さ入力は親の数字パッドが担う", () => {
  const scene = read("app", "games", "skyscrapers", "SkyscrapersScene3D.tsx");
  assert.match(scene, /pickId = `cell-\$\{i\}`/, "マスに pickId を付ける");
  assert.match(scene, /propsRef\.current\.onSelect\(Number\(id\.slice\(5\)\)\)/, "タップが onSelect を呼ぶ");
  const client = read("app", "games", "skyscrapers", "SkyscrapersClient.tsx");
  assert.match(client, /onSelect=\{selectCell\}/, "切り出した selectCell へ接続する");
  assert.match(client, /const selectCell = \(index: number\)/, "選択ハンドラが 2D と共有される");
  assert.match(client, /aria-label="数字パッド"/, "高さ入力の数字パッドは親 DOM に残る");
  assert.match(client, /setSkyValue\(state, selected, v\)/, "高さ入力は既存の setSkyValue が担う");
});

test("3D batch7-path queens: クイーンは冠の造形、利き筋と競合は面色で表す", () => {
  const scene = read("app", "games", "queens", "QueensScene3D.tsx");
  assert.match(scene, /createQueenPiece/, "クイーンを造形する");
  assert.match(scene, /CylinderGeometry/, "冠は円柱で作る");
  assert.match(scene, /SphereGeometry/, "冠の珠は球で作る");
  assert.match(scene, /tileColor/, "マス色は現行 2D の配色関数で決める");
  assert.match(scene, /underAttack/, "利き筋マスを色で示す");
  assert.doesNotMatch(scene, /toggleQueen\(|conflictingQueens\(|attackedSquares\(/, "配置・利き判定を 3D 側で再実装しない");
});

test("3D batch7-path queens: タップが既存 handleCell ハンドラへ接続される", () => {
  const scene = read("app", "games", "queens", "QueensScene3D.tsx");
  assert.match(scene, /pickId = `cell-\$\{i\}`/, "マスに pickId を付ける");
  assert.match(scene, /propsRef\.current\.onCell\(Number\(id\.slice\(5\)\)\)/, "タップが onCell を呼ぶ");
  const client = read("app", "games", "queens", "QueensClient.tsx");
  assert.match(client, /onCell=\{handleCell\}/, "既存の handleCell へ接続する");
  assert.match(client, /toggleQueen\(state, i\)/, "置く/外すは既存の toggleQueen が担う");
  assert.match(client, /conflicts=\{\[\.\.\.conflicts\]\}/, "競合マスは親の算出を渡す");
  assert.match(client, /attacked=\{\[\.\.\.attacked\]\}/, "利き筋マスは親の算出を渡す");
});
