// 3D化 第5バッチ puttgolf（パットゴルフ）の回帰テスト（静的検査）。
// 既存バッチの流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createStage / attachPickPointer を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D へフォールバックする
// - <button> 数が現行（puttgolf 1）以下
// - 入力が既存ハンドラ（doShoot / onCourseTap / スライダー値）へ接続される
// - 打球の物理・判定は lib/puttgolf.ts のまま（軌跡再生はクライアント側）
// - ロジック（lib/puttgolf.ts）へ three が混入していないこと
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

test("3D batch5 puttgolf: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ", () => {
  const client = read("app", "games", "puttgolf", "PuttGolfClient.tsx");
  assert.match(client, /dynamic\(\(\) => import\("\.\/PuttGolfScene3D"\), \{ ssr: false \}\)/, "dynamic import");
  assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
  const scene = read("app", "games", "puttgolf", "PuttGolfScene3D.tsx");
  assert.match(scene, /from "three"/);
  assert.match(scene, /three-kit/, "共通基盤を使う");
  assert.match(scene, /createStage/, "ステージは共通基盤から作る");
  assert.match(scene, /attachPickPointer/, "入力は共通基盤のレイキャストで受ける");
  assert.match(client, /onFail|webglFailed/, "WebGL 失敗時のフォールバックがある");
  assert.match(client, /fallback=\{board2d\}/, "フォールバックとして既存 2D をシーンへ渡す");
  assert.match(client, /webglFailed \? board2d/, "webglFailed 時は既存 2D を描く");
});

test("3D batch5 puttgolf: <button> 数が現行（1）以下", () => {
  assert.ok(countButtons("puttgolf") <= 1, `puttgolf buttons=${countButtons("puttgolf")}`);
});

test("3D batch5 puttgolf: コース造形は lib のホール定義（壁・傾斜・カップ・ティー）から作る", () => {
  const scene = read("app", "games", "puttgolf", "PuttGolfScene3D.tsx");
  assert.match(scene, /PG_WIDTH/, "フィールド幅は lib の定数を使う");
  assert.match(scene, /PG_HEIGHT/, "フィールド高さは lib の定数を使う");
  assert.match(scene, /hole\.walls/, "壁は hole.walls から作る");
  assert.match(scene, /hole\.slopes/, "傾斜は hole.slopes から作る");
  assert.match(scene, /s\.dx|s\.dy/, "傾斜の向きは PgSlope の dx/dy を使う");
  assert.match(scene, /hole\.cup/, "カップ位置は hole.cup を使う");
  assert.match(scene, /hole\.tee/, "ティー位置は hole.tee を使う");
  assert.match(scene, /PG_CUP_RADIUS/, "カップ半径は lib の定数を使う");
  assert.match(scene, /createBall/, "ボールは createBall で作る");
  assert.match(scene, /PG_BALL_RADIUS/, "ボール半径は lib の定数を使う");
  assert.match(scene, /ShapeGeometry/, "旗は形状ジオメトリで造形する");
  assert.match(scene, /buildCourse/, "ホール切替でコースを組み直す");
});

test("3D batch5 puttgolf: 打球は親の軌跡再生へ補間追従し、3D側で判定しない", () => {
  const scene = read("app", "games", "puttgolf", "PuttGolfScene3D.tsx");
  assert.match(scene, /ball: PgPoint/, "表示ボールは PgPoint の prop で受ける");
  const client = read("app", "games", "puttgolf", "PuttGolfClient.tsx");
  assert.match(client, /ball=\{ballPos\}/, "クライアントは表示位置 ballPos をシーンへ渡す");
  assert.match(client, /result\.points/, "軌跡再生は従来どおりクライアント側（result.points）");
  assert.match(client, /shoot\(state, angleRef\.current, powerRef\.current\)/, "打撃判定は lib の shoot のまま");
  assert.match(scene, /dt \* 30/, "ボールは指数補間で表示位置へ追従する");
  assert.doesNotMatch(scene, /simulateShot/, "3D 側で物理シミュレーションを再実装しない");
});

test("3D batch5 puttgolf: ドラッグが既存の角度・強さへ接続され、タップ／フリックが既存ハンドラへ接続される", () => {
  const scene = read("app", "games", "puttgolf", "PuttGolfScene3D.tsx");
  assert.match(scene, /powerForDistance/, "ドラッグの強さ換算は lib の powerForDistance を使う");
  assert.match(scene, /onAim\(angleDeg, pw\)/, "ドラッグが onAim（角度・強さ）へ接続される");
  assert.match(scene, /onTapCourse\(\)/, "タップがコースタップへ接続される");
  assert.match(scene, /onShoot\(\)/, "フリック／速いドラッグ終了が打つへ接続される");
  assert.match(scene, /LineDashedMaterial/, "狙いガイドは破線で表示する（2D と同じ規約）");
  assert.match(scene, /30 \+ p\.power \* 2\.2|30 \+ .*power.*2\.2/, "ガイド長は 2D と同じ 30 + power * 2.2");
  const client = read("app", "games", "puttgolf", "PuttGolfClient.tsx");
  assert.match(client, /onAim=\{\(a, p\) => applyAim\(a, p\)\}/, "onAim はスライダーと同じ applyAim へ接続する");
  assert.match(client, /onShoot=\{\(\) => doShoot\(\)\}/, "onShoot は既存の doShoot へ接続する");
  assert.match(client, /onTapCourse=\{onCourseTap\}/, "onTapCourse は既存の onCourseTap へ接続する");
  assert.match(client, /onCourseTap/, "コースタップの振り分け（打つ／次ホール）は従来どおり");
  assert.match(client, /angleRef/, "角度は ref でも保持し、ドラッグ直後の打撃に最新値を使う");
  assert.match(client, /powerRef/, "強さは ref でも保持する");
});

test("3D batch5 puttgolf: ロジック層（lib/puttgolf.ts）に three が混入していない", () => {
  assert.doesNotMatch(read("lib", "puttgolf.ts"), /from "three"/, "lib/puttgolf.ts");
});

test("3D batch5 puttgolf: シーンに絵文字UIがない（色と造形で表現）", () => {
  const scene = read("app", "games", "puttgolf", "PuttGolfScene3D.tsx");
  assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, "scene emoji");
});
