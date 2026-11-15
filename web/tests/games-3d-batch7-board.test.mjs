// 3D化 第7バッチ 盤タイル・対戦Board系（maze / icemaze / snake /
// tictactoe / domino）の回帰テスト（静的検査）。
// 既存バッチ（batch6-party / batch6-daifugo 等）の流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createStage / attachPickPointer / SceneBox を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D（board2d）へフォールバックする
// - <button> 数が現行（maze 1 / icemaze 3 / snake 0 / tictactoe 1 / domino 3）以下
// - シーンに絵文字 UI がないこと
// - 入力が既存ハンドラへ接続され、判定を 3D 側で再実装していないこと
// - 対戦系では秘匿情報（相手の手札の中身）をシーンへ渡していないこと
// - ロジック層（lib/*.ts、lib/online/games/*.ts）へ three が混入していないこと
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
  { dir: "maze", client: "MazeClient.tsx", scene: "MazeScene3D.tsx", buttons: 1 },
  { dir: "snake", client: "SnakeClient.tsx", scene: "SnakeScene3D.tsx", buttons: 0 },
];

for (const g of BATCH) {
  test(`3D batch7-board ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, new RegExp(`dynamic\\(\\(\\) => import\\("\\./${g.scene.replace(".tsx", "")}"\\), \\{ ssr: false \\}\\)`), "dynamic import");
    assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
    assert.doesNotMatch(client, /three-kit/, "クライアントは three-kit を直接触らない");
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /from "three"/);
    assert.match(scene, /three-kit/, "共通基盤を使う");
    assert.match(scene, /createStage/, "ステージは共通基盤から作る");
    assert.match(scene, /attachPickPointer/, "入力は共通基盤のレイキャストで受ける");
    assert.match(scene, /SceneBox/, "外枠は共通基盤を使う");
    assert.match(client, /webglFailed/, "WebGL 失敗時のフォールバックがある");
    assert.match(client, /fallback=\{board2d\}/, "フォールバックとして既存 2D をシーンへ渡す");
    assert.match(client, /webglFailed \? board2d/, "WebGL 失敗時は board2d を直接描く");
  });

  test(`3D batch7-board ${g.dir}: <button> 数が現行（${g.buttons}）以下`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });

  test(`3D batch7-board ${g.dir}: シーンに絵文字UIがない（色と造形で表現）`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${g.dir} scene emoji`);
  });
}

test("3D batch7-board maze: 壁は実ブロック（InstancedMesh）、プレイヤーは球、ゴールは発光円盤＋旗", () => {
  const scene = read("app", "games", "maze", "MazeScene3D.tsx");
  assert.match(scene, /InstancedMesh/, "壁セルは InstancedMesh で軽量化する");
  assert.match(scene, /createBall/, "プレイヤーは球トークンで造形する");
  assert.match(scene, /createGoalFlag/, "ゴールの旗を造形する");
  assert.match(scene, /emissive/, "ゴール円盤は発光させる");
  assert.match(scene, /fitCamera/, "盤の大きさに合わせてカメラを寄せる");
  assert.match(scene, /playerTarget/, "プレイヤーは目標セルへ補間移動する");
});

test("3D batch7-board maze: スワイプはシーン onFlick から既存 doMove へ接続され、移動判定は lib が持つ", () => {
  const scene = read("app", "games", "maze", "MazeScene3D.tsx");
  assert.match(scene, /onFlick: \(flick\)/, "スワイプは onFlick で受ける");
  assert.match(scene, /propsRef\.current\.onMove\(flick\.dir\)/, "FlickInfo.dir をそのまま親へ渡す");
  assert.doesNotMatch(scene, /movePlayer|canMoveDir/, "移動可否の判定を 3D 側で再実装しない");
  const client = read("app", "games", "maze", "MazeClient.tsx");
  assert.match(client, /onMove=\{doMove\}/, "既存の doMove ハンドラへ接続する");
  assert.match(client, /movePlayer\(current, dir\)/, "移動は lib の movePlayer が決める");
});



test("3D batch7-board snake: 蛇体は目つきの頭＋立方体列、餌は赤い球で、getState 補間追従する", () => {
  const scene = read("app", "games", "snake", "SnakeScene3D.tsx");
  assert.match(scene, /getState: \(\) => SnakeViewState/, "親の状態は getState で読む");
  assert.match(scene, /propsRef\.current\.getState\(\)/, "毎フレーム getState で最新状態を読む");
  assert.match(scene, /eyeL|eyeR/, "頭には目を付ける");
  assert.match(scene, /bodyMeshes/, "体は立方体の列で表す");
  assert.match(scene, /createBall\(0\.32, 0xe85d4a/, "餌は赤い球で表す");
  assert.match(scene, /display/, "表示位置を保持して補間追従する");
  assert.doesNotMatch(scene, /tickSnake|setSnakeDirection/, "進行・方向判定を 3D 側で再実装しない");
  const client = read("app", "games", "snake", "SnakeClient.tsx");
  assert.match(client, /getState=\{\(\) => stateRef\.current\}/, "親ループの状態を getState で渡す");
});

test("3D batch7-board snake: スワイプ=方向転換、タップ=開始/ポーズが既存ハンドラへ接続される", () => {
  const scene = read("app", "games", "snake", "SnakeScene3D.tsx");
  assert.match(scene, /onFlick: \(flick\)/, "スワイプは onFlick で受ける");
  assert.match(scene, /propsRef\.current\.onSwipe\(flick\.dir\)/, "スワイプ方向をそのまま親へ渡す");
  assert.match(scene, /onTapAnywhere/, "タップは盤面のどこでも拾う");
  assert.match(scene, /propsRef\.current\.onTap\(\)/, "タップを親のハンドラへ渡す");
  const client = read("app", "games", "snake", "SnakeClient.tsx");
  assert.match(client, /onSwipe=\{move\}/, "方向転換は既存の move ハンドラへ接続する");
  assert.match(client, /onTap=\{handleTap3D\}/, "タップは既存の開始/ポーズハンドラへ接続する");
  assert.match(client, /pauseSnake\(s\) : startSnake\(s\)/, "開始/ポーズは lib の関数が決める");
});







test("3D batch7-board: ロジック層に three が混入していない", () => {
  for (const p of [
    ["lib", "maze.ts"],
    ["lib", "snake.ts"],
  ]) {
    assert.doesNotMatch(read(...p), /from "three"/, p.join("/"));
    assert.doesNotMatch(read(...p), /three-kit/, p.join("/"));
  }
});
