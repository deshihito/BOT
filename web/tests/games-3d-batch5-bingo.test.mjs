// 3D化 第5バッチ bingo / bingobattle（抽選機）の回帰テスト（静的検査）。
// 既存バッチの流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - bingo シーンは three-kit の createStage / attachPickPointer / createBall /
//   canvasTexture を使い、bingobattle は bingo のシーンを再利用する
// - WebGL 失敗時は onFail / webglFailed で既存 2D へフォールバックする
// - <button> 数が現行（bingo 2 / bingobattle 0）以下
// - bingo の入力が既存ハンドラ（handleDraw → drawNext）へ接続される
// - 抽選は drawn の差分検出で排出アニメーションを再生する
// - ロジック（lib/bingo.ts, lib/online/games/bingobattle.ts）へ three が混入していない
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

test("3D batch5 bingo: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ", () => {
  const client = read("app", "games", "bingo", "BingoClient.tsx");
  assert.match(client, /dynamic\(\(\) => import\("\.\/BingoScene3D"\), \{ ssr: false \}\)/, "dynamic import");
  assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
  const scene = read("app", "games", "bingo", "BingoScene3D.tsx");
  assert.match(scene, /from "three"/);
  assert.match(scene, /three-kit/, "共通基盤を使う");
  assert.match(scene, /createStage/, "ステージは共通基盤から作る");
  assert.match(scene, /attachPickPointer/, "入力は共通基盤のレイキャストで受ける");
  assert.match(client, /onFail|webglFailed/, "WebGL 失敗時のフォールバックがある");
  assert.match(client, /fallback=\{board2d\}/, "フォールバックとして既存 2D をシーンへ渡す");
});

test("3D batch5 bingo: 抽選機はガラス球体＋内部ボール＋シュート排出で、番号ボールは createBall＋canvasTexture", () => {
  const scene = read("app", "games", "bingo", "BingoScene3D.tsx");
  assert.match(scene, /SphereGeometry/, "ガラス球体容器がある");
  assert.match(scene, /transparent: true/, "ガラスは半透明材質で表現する");
  assert.match(scene, /createBall/, "ボールは createBall で作る");
  assert.match(scene, /canvasTexture/, "数字テクスチャは canvasTexture で作る");
  assert.match(scene, /bingo-ball-/, "番号ごとのテクスチャキーがある");
  assert.match(scene, /CHUTE_MOUTH/, "排出シュートの出口がある");
  assert.match(scene, /prevDrawn/, "番号列の差分を保持して検出する");
  assert.match(scene, /drawn\.filter\(/, "新しく引かれた球を差分で求める");
  assert.match(scene, /startEject/, "差分で排出アニメーションを開始する");
});

test("3D batch5 bingo: マシンタップが既存 handleDraw（drawNext）へ接続される", () => {
  const scene = read("app", "games", "bingo", "BingoScene3D.tsx");
  assert.match(scene, /onDraw\(\)/, "シーンのタップが onDraw を呼ぶ");
  const client = read("app", "games", "bingo", "BingoClient.tsx");
  assert.match(client, /onDraw=\{handleDraw\}/, "既存の handleDraw へ接続する");
  assert.match(client, /drawNext\(s\)/, "抽選は lib の drawNext のまま");
  assert.match(client, /drawn=\{state\.drawn\}/, "抽選済み番号列を props で渡す");
});

test("3D batch5 bingobattle: シーンは bingo の抽選機を再利用し、drawn を props で受ける", () => {
  const client = read("app", "games", "bingobattle", "BingoBattleClient.tsx");
  assert.match(client, /dynamic\(\(\) => import\("\.\/BingoBattleScene3D"\), \{ ssr: false \}\)/, "dynamic import");
  assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
  assert.match(client, /onFail|webglFailed/, "WebGL 失敗時のフォールバックがある");
  assert.match(client, /fallback=\{board2d\}/, "フォールバックとして既存 2D をシーンへ渡す");
  assert.match(client, /drawn=\{state\.drawn\}/, "抽選済み番号列を props で渡す");
  const scene = read("app", "games", "bingobattle", "BingoBattleScene3D.tsx");
  assert.match(scene, /from "\.\.\/bingo\/BingoScene3D"/, "bingo の抽選機シーンを再利用する");
  assert.doesNotMatch(scene, /from "three"/, "対戦側シーンは再利用ラッパーで three を複製しない");
});

test("3D batch5 bingo: <button> 数が現行（2）以下", () => {
  assert.ok(countButtons("bingo") <= 2, `bingo buttons=${countButtons("bingo")}`);
});

test("3D batch5 bingobattle: <button> 数が現行（0）以下", () => {
  assert.ok(countButtons("bingobattle") <= 0, `bingobattle buttons=${countButtons("bingobattle")}`);
});

test("3D batch5: ロジック層（lib/bingo.ts, lib/online/games/bingobattle.ts）に three が混入していない", () => {
  assert.doesNotMatch(read("lib", "bingo.ts"), /from "three"/, "lib/bingo.ts");
  assert.doesNotMatch(read("lib", "online", "games", "bingobattle.ts"), /from "three"/, "lib/online/games/bingobattle.ts");
});

test("3D batch5: シーンに絵文字UIがない（色は材質で表現）", () => {
  for (const [dir, file] of [["bingo", "BingoScene3D.tsx"], ["bingobattle", "BingoBattleScene3D.tsx"]]) {
    const scene = read("app", "games", dir, file);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${dir} scene emoji`);
  }
});
