// 3D化 第8バッチ 落下系（falling / columns）の回帰テスト（静的検査）。
// 既存バッチの流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createStage / attachPickPointer / SceneBox を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D へフォールバックする
// - <button> 数が現行（falling 1 / columns 1）以下
// - 3D は getState で毎フレーム親状態を読み、補間追従するだけ
// - 入力が既存ハンドラ（falling: handleSwipe・handleTap / columns: handleSwipe・
//   handleTap、どちらも 2D 盤面ジェスチャと共有）へ接続される
// - 落下・消去・回転・マッチ判定を 3D 側で再実装していないこと
// - ロジック（lib/falling.ts, lib/columns.ts）へ three が混入していないこと
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
  { dir: "falling", client: "FallingClient.tsx", scene: "FallingScene3D.tsx", buttons: 1 },
];

for (const g of BATCH) {
  test(`3D batch8-falling ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, new RegExp(`dynamic\\(\\(\\) => import\\("\\./${g.scene.replace(".tsx", "")}"\\), \\{ ssr: false \\}\\)`), "dynamic import");
    assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /from "three"/);
    assert.match(scene, /three-kit/, "共通基盤を使う");
    assert.match(scene, /createStage/, "ステージは共通基盤から作る");
    assert.match(scene, /attachPickPointer/, "入力は共通基盤のレイキャストで受ける");
    assert.match(scene, /SceneBox/, "外枠は共通基盤を使う");
    assert.match(client, /webglFailed/, "WebGL 失敗時のフォールバックがある");
    assert.match(client, /fallback=\{board2d\}/, "フォールバックとして既存 2D をシーンへ渡す");
  });

  test(`3D batch8-falling ${g.dir}: <button> 数が現行（${g.buttons}）以下`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });

  test(`3D batch8-falling ${g.dir}: シーンに絵文字UIがない（色と造形で表現）`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${g.dir} scene emoji`);
  });

  test(`3D batch8-falling ${g.dir}: クライアントは three-kit を直接触らない`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.doesNotMatch(client, /three-kit/, `${g.dir} client は基盤を直接触らない`);
  });

  test(`3D batch8-falling ${g.dir}: 3D は getState で毎フレーム親状態を読み、補間追従するだけ`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /getState/, "親状態を読む受け口を持つ");
    assert.match(scene, /propsRef\.current\.getState\(\)/, "毎フレーム親状態を読む");
    assert.match(scene, /Math\.exp\(-dt/, "補間は指数追従");
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, /getState=\{getViewState\}/, "親は getState をシーンへ渡す");
    assert.match(client, /stateRef/, "親は最新状態を ref で保持する");
  });

  test(`3D batch8-falling ${g.dir}: スワイプとタップが 2D 盤面ジェスチャと共有の既存ハンドラへ接続される`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /onFlick: \(flick\)/, "フリックを受け口に持つ");
    assert.match(scene, /onDragEnd: \(flick\)/, "ドラッグ終了時のフリックも受け口に持つ");
    assert.match(scene, /propsRef\.current\.onSwipe\(flick\.dir\)/, "方向は FlickInfo.dir をそのまま親へ渡す");
    assert.match(scene, /propsRef\.current\.onTap\(\)/, "タップは親のタップハンドラへ渡す");
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, /onSwipe=\{handleSwipe\}/, "既存のスワイプハンドラへ接続する");
    assert.match(client, /onTap=\{handleTap\}/, "既存のタップハンドラへ接続する");
    assert.match(client, /onSwipe: handleSwipe|onSwipe: \(dir\) => \{\s*handleSwipe\(dir\);/, "2D 盤面ジェスチャも同じスワイプハンドラを使う（直接渡し・委譲ラッパのどちらでも可）");
    assert.match(client, /onTap: handleTap/, "2D 盤面ジェスチャも同じタップハンドラを使う");
  });
}

test("3D batch8-falling falling: ブロックは FALLING_PIECE_COLORS の立方体、ゴーストは半透明で表す", () => {
  const scene = read("app", "games", "falling", "FallingScene3D.tsx");
  assert.match(scene, /FALLING_PIECE_COLORS/, "ブロックの色は現行 2D と同じ定数を使う");
  assert.match(scene, /BoxGeometry\(0\.92, 0\.92, 0\.8\)/, "ブロックは立方体で作る");
  assert.match(scene, /transparent: true, opacity: 0\.26/, "ゴーストは半透明で表す");
  assert.match(scene, /boardBlocks/, "固定ブロックは差分同期で管理する");
  assert.match(scene, /activeDisplay/, "落下中ピースは補間用の表示位置を持つ");
  assert.match(scene, /s\.placed !== rt\.lastPlaced/, "固定の瞬間は補間せず合わせ直す");
});

test("3D batch8-falling falling: ゴーストと落下中セルは親が lib の関数で計算し、3D 側で落下判定を再実装しない", () => {
  const scene = read("app", "games", "falling", "FallingScene3D.tsx");
  assert.doesNotMatch(
    scene,
    /(moveDown|softDrop|hardDrop|holdPiece|rotatePiece|moveLeft|moveRight|clearLines|canPlace|ghostY|lockActive)\s*\(/,
    "落下・固定・消去・回転・衝突判定を 3D 側で再実装しない",
  );
  const client = read("app", "games", "falling", "FallingClient.tsx");
  assert.match(client, /ghostY\(s\)/, "ゴースト位置は lib の ghostY で計算する");
  assert.match(client, /getActiveCells\(s\)/, "落下中セルは lib の getActiveCells で計算する");
  assert.match(client, /getPieceCells\(s\.active\.type, s\.active\.rotation\)/, "ゴーストセルは lib の getPieceCells で計算する");
});



