// 3D化 第5バッチ アクション系2（dragrace / aim / dodge）の回帰テスト（静的検査）。
// 既存バッチの流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createStage / attachPickPointer を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D へフォールバックする
// - <button> 数が現行（dragrace 4 / aim 2 / dodge 3）以下
// - 入力が既存ハンドラ（onAction / shootAt / applyTargetX）へ接続される
// - ロジック（lib/*.ts）へ three が混入していないこと
// 注: dodge は純粋 lib を持たず、判定・生成は DodgeClient 内ループのまま。
// シーンは getSnapshot の補間表示だけで、判定を再実装しない。
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
  { dir: "dragrace", client: "DragRaceClient.tsx", scene: "DragRaceScene3D.tsx", buttons: 4 },
  { dir: "aim", client: "AimClient.tsx", scene: "AimScene3D.tsx", buttons: 2 },
  { dir: "dodge", client: "DodgeClient.tsx", scene: "DodgeScene3D.tsx", buttons: 3 },
];

for (const g of BATCH) {
  test(`3D batch5-action2 ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, new RegExp(`dynamic\\(\\(\\) => import\\("\\./${g.scene.replace(".tsx", "")}"\\), \\{ ssr: false \\}\\)`), "dynamic import");
    assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /from "three"/);
    assert.match(scene, /three-kit/, "共通基盤を使う");
    assert.match(scene, /createStage/, "ステージは共通基盤から作る");
    assert.match(scene, /attachPickPointer/, "入力は共通基盤のレイキャストで受ける");
    assert.match(client, /onFail|webglFailed/, "WebGL 失敗時のフォールバックがある");
    assert.match(client, /fallback=\{board2d\}/, "フォールバックとして既存 2D をシーンへ渡す");
  });

  test(`3D batch5-action2 ${g.dir}: <button> 数が現行（${g.buttons}）以下`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });
}

test("3D batch5-action2 dragrace: 車2台の造形があり、進行は親状態へ補間追従、タップ/フリックが onAction へ接続される", () => {
  const scene = read("app", "games", "dragrace", "DragRaceScene3D.tsx");
  assert.match(scene, /makeCar/, "車はプリミティブ造形で作る");
  assert.match(scene, /dispPlayer|dispCpu/, "表示進行度を持ち補間する");
  assert.match(scene, /playerProg/, "進行度は親状態（lib の playerProgress 由来）から受ける");
  assert.match(scene, /cpuProg/, "CPU の進行度も親状態から受ける");
  assert.match(scene, /onTap: \(\) => propsRef\.current\.onAction\(\)/, "タップが既存 onAction へ接続される");
  assert.match(scene, /onFlick: \(\) => propsRef\.current\.onAction\(\)/, "フリックも既存 onAction へ接続される");
  assert.doesNotMatch(scene, /advanceRace|shift\(|launch\(/, "3D 側でレース判定を再実装しない");
  const client = read("app", "games", "dragrace", "DragRaceClient.tsx");
  assert.match(client, /onAction=\{onAction\}/, "既存の onAction ハンドラへ接続する");
  assert.match(client, /playerProgress\(state/, "進行度は lib の playerProgress のまま");
  assert.match(client, /cpuProgress\(state/, "CPU 進行度は lib の cpuProgress のまま");
});

test("3D batch5-action2 aim: 立体ターゲットを差分同期し、タップは統一単位へ変換して shootAt へ渡す（判定は lib のまま）", () => {
  const scene = read("app", "games", "aim", "AimScene3D.tsx");
  assert.match(scene, /makeTarget/, "的は立体ターゲット造形で作る");
  assert.match(scene, /CircleGeometry/, "同心リングは円盤で表現する");
  assert.match(scene, /entries/, "的は id 単位で差分同期する");
  assert.match(scene, /dyingAt/, "消滅は縮小アニメーションで表現する");
  assert.match(scene, /onShoot\(toFieldX\(hit\.point\.x\), toFieldY\(hit\.point\.y\)\)/, "レイキャスト点を統一単位へ戻して渡す");
  assert.doesNotMatch(scene, /hitTest/, "3D 側で命中判定を再実装しない");
  const client = read("app", "games", "aim", "AimClient.tsx");
  assert.match(client, /onShoot=\{shootAt\}/, "既存の shootAt ハンドラへ接続する");
  assert.match(client, /hitTest\(t, x, y\)/, "命中判定は lib の hitTest のまま");
  assert.match(client, /activeTargetsAt\(scheduleRef\.current/, "出現スケジュールは lib のまま");
});

test("3D batch5-action2 dodge: 自機/障害物は getSnapshot へ補間追従し、移動は平面レイキャストから applyTargetX へ接続される", () => {
  const scene = read("app", "games", "dodge", "DodgeScene3D.tsx");
  assert.match(scene, /getSnapshot\(\)/, "状態は親ループのスナップショットから読む");
  assert.match(scene, /makePlayer/, "自機は立体造形で作る");
  assert.match(scene, /createBall/, "障害物は球体造形で作る");
  assert.match(scene, /onMove\(toFieldX\(pt\.x\)\)/, "平面点をフィールド座標へ戻して既存ハンドラへ渡す");
  assert.match(scene, /onDragMove/, "ドラッグ移動が接続される");
  assert.doesNotMatch(scene, /Math\.random/, "3D 側で障害物を生成しない");
  const client = read("app", "games", "dodge", "DodgeClient.tsx");
  assert.match(client, /getSnapshot=\{getSnapshot\}/, "スナップショット getter を渡す");
  assert.match(client, /onMove=\{applyTargetX\}/, "既存の applyTargetX へ接続する");
  assert.match(client, /obstaclesRef\.current = next/, "障害物の生成・移動・衝突は従来ループのまま");
  assert.match(client, /playerXRef\.current \+= dx/, "自機の追従計算は従来ループのまま");
});

test("3D batch5-action2: ロジック層（lib/dragrace.ts, lib/aim.ts）に three が混入していない", () => {
  for (const f of ["dragrace.ts", "aim.ts"]) {
    assert.doesNotMatch(read("lib", f), /from "three"/, `lib/${f}`);
  }
  assert.ok(!fs.existsSync(path.join(webDir, "lib", "dodge.ts")), "dodge 専用 lib は作らない（クライアント内ロジックのまま）");
});

test("3D batch5-action2: シーンに絵文字UIがない（色は材質で表現）", () => {
  for (const g of BATCH) {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${g.dir} scene emoji`);
  }
});
