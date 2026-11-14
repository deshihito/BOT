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
  { dir: "icemaze", client: "IceMazeClient.tsx", scene: "IceMazeScene3D.tsx", buttons: 3 },
  { dir: "snake", client: "SnakeClient.tsx", scene: "SnakeScene3D.tsx", buttons: 0 },
  { dir: "tictactoe", client: "TictactoeClient.tsx", scene: "TictactoeScene3D.tsx", buttons: 1 },
  { dir: "domino", client: "DominoClient.tsx", scene: "DominoScene3D.tsx", buttons: 3 },
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

test("3D batch7-board icemaze: 氷は半透明の青タイル、壁はグレーの岩、ゴールは発光円盤", () => {
  const scene = read("app", "games", "icemaze", "IceMazeScene3D.tsx");
  assert.match(scene, /transparent: true, opacity: 0\.82/, "氷タイルは半透明寄りにする");
  assert.match(scene, /0xd6f0ff/, "氷タイルは明るい青");
  assert.match(scene, /0x607080/, "岩／壁はグレーで造形する");
  assert.match(scene, /createBall/, "プレイヤーは球で造形する");
  assert.match(scene, /emissive/, "ゴール円盤は発光させる");
  assert.match(scene, /fitCamera/, "盤の大きさに合わせてカメラを寄せる");
});

test("3D batch7-board icemaze: 滑走は lib の到達セルへアニメーション追従するだけ（再計算しない）", () => {
  const scene = read("app", "games", "icemaze", "IceMazeScene3D.tsx");
  assert.match(scene, /slideAnim/, "滑走区間を補間アニメーションで見せる");
  assert.match(scene, /onFlick: \(flick\)/, "スワイプは onFlick で受ける");
  assert.match(scene, /propsRef\.current\.onSlide\(flick\.dir\)/, "FlickInfo.dir をそのまま親へ渡す");
  assert.doesNotMatch(scene, /slideIce|slideDestination/, "停止位置の計算を 3D 側で再実装しない");
  const client = read("app", "games", "icemaze", "IceMazeClient.tsx");
  assert.match(client, /onSlide=\{slide\}/, "既存の slide ハンドラへ接続する");
  assert.match(client, /slideIce\(state, dir\)/, "滑走は lib の slideIce が決める");
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

test("3D batch7-board tictactoe: ○はトーラス、×は斜めの直方体、勝ち筋は発光ライン", () => {
  const scene = read("app", "games", "tictactoe", "TictactoeScene3D.tsx");
  assert.match(scene, /TorusGeometry/, "○はトーラスで造形する");
  assert.match(scene, /createCrossMark/, "×は2本の直方体を組んで造形する");
  assert.match(scene, /rotation\.y = Math\.PI \/ 4/, "×の棒は斜めに組む");
  assert.match(scene, /winLine/, "勝ち筋は発光ラインで示す");
  assert.match(scene, /winCells/, "ライン位置は view の winCells から導く");
  assert.doesNotMatch(scene, /api\.move/, "シーンはアクション送信をしない");
});

test("3D batch7-board tictactoe: マスタップは既存の着手ハンドラ（api.move 経路）へ接続される", () => {
  const scene = read("app", "games", "tictactoe", "TictactoeScene3D.tsx");
  assert.match(scene, /pickId = `cell-\$\{i\}`/, "マスに pickId を付ける");
  assert.match(scene, /propsRef\.current\.onCell\(Number\(id\.slice\(5\)\)\)/, "タップが onCell を呼ぶ");
  const client = read("app", "games", "tictactoe", "TictactoeClient.tsx");
  assert.match(client, /onCell=\{onCell\}/, "既存の着手ハンドラへ接続する");
  assert.match(client, /api\.move\(\{ type: "place", index \}\)/, "送信アクションは既存の place のまま");
});

test("3D batch7-board domino: 牌は dominoTilePips の目を canvasTexture で大きく描く", () => {
  const scene = read("app", "games", "domino", "DominoScene3D.tsx");
  assert.match(scene, /dominoTilePips/, "目は lib の dominoTilePips を使う");
  assert.match(scene, /canvasTexture/, "目の描画は canvasTexture を使う");
  assert.match(scene, /createDominoTile/, "牌は直方体で造形する");
  assert.match(scene, /drawPips/, "ピップを描く");
});

test("3D batch7-board domino: チェーンは両端へ連なり、長くなったら fitCamera で全体を収める", () => {
  const scene = read("app", "games", "domino", "DominoScene3D.tsx");
  assert.match(scene, /layoutChain/, "チェーン配置を計算する");
  assert.match(scene, /fitCamera/, "配置範囲でカメラを再計算する");
  assert.match(scene, /chainSig/, "チェーンの変化でカメラを更新する");
  assert.match(scene, /handSpacing/, "手札は扇状に、枚数に応じて間隔を圧縮する");
});

test("3D batch7-board domino: 秘匿 — 相手は枚数表現のみ（裏向き・目なし）、中身を渡さない", () => {
  const scene = read("app", "games", "domino", "DominoScene3D.tsx");
  const otherType = scene.match(/interface DominoSceneOther \{[^}]*\}/)?.[0] ?? "";
  assert.match(otherType, /count: number/, "相手は count のみ");
  assert.doesNotMatch(otherType, /hand|tiles/, "相手の型に手札の中身がない");
  assert.match(scene, /createDominoTile\(null, null\)/, "相手と山は裏向き（目なし）で生成する");
  assert.match(scene, /other\.count/, "生成枚数は count だけから決まる");
  assert.doesNotMatch(scene, /other\.hand|othersHand|hands\[/, "他人の手札の中身を参照しない");
  const client = read("app", "games", "domino", "DominoClient.tsx");
  assert.match(client, /others=\{state\.others\.map\(\(o\) => \(\{ seat: o\.seat, count: o\.count \}\)\)\}/, "クライアントは seat と count だけを渡す");
});

test("3D batch7-board domino: 牌タップは既存の配置/選択ハンドラへ、引く・パスは DOM のまま", () => {
  const scene = read("app", "games", "domino", "DominoScene3D.tsx");
  assert.match(scene, /pickId = `tile-\$\{tile\}`/, "手札の牌に pickId を付ける");
  assert.match(scene, /propsRef\.current\.onHandTap\(tile\)/, "牌タップが onHandTap を呼ぶ");
  assert.match(scene, /end-left|end-right/, "両端マーカーで置く側を選べる");
  assert.match(scene, /propsRef\.current\.onEndTap\(/, "両端タップが onEndTap を呼ぶ");
  const client = read("app", "games", "domino", "DominoClient.tsx");
  assert.match(client, /onHandTap=\{handleHandTap\}/, "既存の配置/選択ハンドラへ接続する");
  assert.match(client, /onEndTap=\{handleEndTap\}/, "置く側の選択ハンドラへ接続する");
  assert.match(client, /api\.move\(\{ type: "place", tile, side \}\)/, "配置は従来どおり api.move の place");
  assert.match(client, /api\.move\(\{ type: "draw" \}\)/, "引くは従来どおり api.move の draw");
  assert.match(client, /api\.move\(\{ type: "pass" \}\)/, "パスは従来どおり api.move の pass");
});

test("3D batch7-board: ロジック層に three が混入していない", () => {
  for (const p of [
    ["lib", "maze.ts"],
    ["lib", "icemaze.ts"],
    ["lib", "snake.ts"],
    ["lib", "online", "games", "domino.ts"],
  ]) {
    assert.doesNotMatch(read(...p), /from "three"/, p.join("/"));
    assert.doesNotMatch(read(...p), /three-kit/, p.join("/"));
  }
});
