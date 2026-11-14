// 3D化 第5バッチ アクション系3 (breakout / pong) の回帰テスト (静的検査)。
// 既存バッチの流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createStage / attachPickPointer を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D (board2d) へフォールバックする
// - <button> 数が現行 (breakout 1 / pong 1) 以下
// - 入力が既存ハンドラへ接続される (breakout: 発射・次レベル / パドル追従 /
//   下スワイプ = ポーズ。pong: pointerdown 直通の既存タップ判定 / パドル追従)
// - ロジック (lib/breakout.ts) へ three が混入していないこと。
//   pong は lib に専用ファイルがなく、クライアント内ロジックも無変更が前提。
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
  { dir: "breakout", client: "BreakoutClient.tsx", scene: "BreakoutScene3D.tsx", buttons: 1 },
  { dir: "pong", client: "PongClient.tsx", scene: "PongScene3D.tsx", buttons: 1 },
];

for (const g of BATCH) {
  test(`3D batch5-action3 ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
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
    assert.match(scene, /dt \* 48/, "親状態へ指数補間 (dt*48) で追従する (airhockey 型)");
  });

  test(`3D batch5-action3 ${g.dir}: <button> 数が現行 (${g.buttons}) 以下`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });
}

test("3D batch5-action3 breakout: ブロックは lib の定義 (配置・色) を直方体へ写し、差分で消去する", () => {
  const scene = read("app", "games", "breakout", "BreakoutScene3D.tsx");
  assert.match(scene, /BREAKOUT_FIELD_W/, "フィールド幅は lib の定義を使う");
  assert.match(scene, /BREAKOUT_FIELD_H/, "フィールド高さは lib の定義を使う");
  assert.match(scene, /mat\.color\.set\(b\.color\)/, "ブロック色は lib の BreakoutBrick.color を使う");
  assert.match(scene, /createBall/, "ボールは球 (createBall) で作る");
  assert.match(scene, /prevAlive/, "ブロック消去は alive の状態差分で同期する");
  assert.match(scene, /fades/, "破壊済みブロックはフェードで消す");
  assert.doesNotMatch(scene, /damageBrick/, "3D 側でブロックの物理・破壊判定をしない");
  const client = read("app", "games", "breakout", "BreakoutClient.tsx");
  assert.match(client, /bricks: bricksRef\.current/, "ブロック状態は getState でシーンへ渡す");
  assert.match(client, /damageBrick\(bricks, i\)/, "破壊判定は従来どおり lib の damageBrick");
  assert.match(client, /bricksForLevel\(lvl\)/, "配置生成は従来どおり lib の bricksForLevel");
});

test("3D batch5-action3 breakout: パドル平面追従・タップ発射・下スワイプ=ポーズの語彙を維持する", () => {
  const scene = read("app", "games", "breakout", "BreakoutScene3D.tsx");
  assert.match(scene, /onDragMove: \(point\) => sendTarget\(point\)/, "ドラッグの平面点でパドルが追従する");
  assert.match(scene, /onHover/, "ホバーでもパドルが追従する (airhockey 型)");
  assert.match(scene, /propsRef\.current\.onPress\(\)/, "タップ / ドラッグ開始が onPress へ接続される");
  assert.match(scene, /flick\.dir === "down"\) propsRef\.current\.onSwipeDown\(\)/, "下フリック / 下ドラッグ終了が onSwipeDown へ接続される");
  const client = read("app", "games", "breakout", "BreakoutClient.tsx");
  assert.match(client, /onTarget=\{handleTarget3D\}/, "パドル追従は既存クランプと同じ handleTarget3D へ");
  assert.match(client, /onPress=\{handlePress3D\}/, "発射・再開・次レベルは handlePress3D へ");
  assert.match(client, /onSwipeDown=\{handleSwipeDown3D\}/, "ポーズは handleSwipeDown3D へ");
  assert.match(client, /phaseRef\.current === "cleared"\) \{\s*startLevel/, "クリア時の次レベル遷移は従来どおり startLevel");
  // 2D フォールバック側のジェスチャ語彙も従来どおり残っている
  assert.match(client, /boardGesture\.onPointerUp/, "2D の boardGesture が残る");
  assert.match(client, /dir === "down" && phaseRef\.current === "playing"/, "2D の下スワイプ = ポーズ判定が残る");
});

test("3D batch5-action3 pong: テーブル (センターライン・ネット) + パック + 両パドル、ゴール発光がある", () => {
  const scene = read("app", "games", "pong", "PongScene3D.tsx");
  assert.match(scene, /canvasTexture\("pong-surface"/, "センターラインは盤面テクスチャで描く");
  assert.match(scene, /netTop/, "ネット表現がある");
  assert.match(scene, /createBall/, "パックは球 (createBall) で作る");
  assert.match(scene, /prevScores/, "ゴール演出はスコア差分で検出する");
  assert.match(scene, /flashRight/, "得点側のゴールライン発光がある");
  assert.match(scene, /emissive/, "発光は emissive で表現する");
  assert.doesNotMatch(scene, /WIN_SCORE/, "3D 側で勝敗判定をしない");
});

test("3D batch5-action3 pong: タップ判定は pointerdown 直通で既存ハンドラへ渡り、遅延経路を使わない", () => {
  const scene = read("app", "games", "pong", "PongScene3D.tsx");
  // attachPickPointer のタップ (pointerup 判定) は開始を遅らせるため使わない
  assert.doesNotMatch(scene, /onTap/, "シーンは attachPickPointer の onTap を使わない");
  assert.match(scene, /addEventListener\("pointerdown", directDown\)/, "canvas の pointerdown を直接受ける");
  assert.match(scene, /onPointerDown\(e\.clientY\)/, "clientY をそのまま親の既存ハンドラへ渡す");
  assert.match(scene, /planePoint\(TABLE_Y, e\.clientX, e\.clientY\)/, "パドル位置は同じイベントの planePoint から渡す");
  assert.match(scene, /onDragMove: \(point\) => sendTarget\(point\)/, "ドラッグ中もパドルが平面追従する");
  assert.match(scene, /onHover/, "ホバーでもパドルが追従する");
  const client = read("app", "games", "pong", "PongClient.tsx");
  assert.match(client, /onPointerDown=\{onTapLogic\}/, "pointerdown は既存タップ判定 onTapLogic へ接続される");
  assert.match(client, /onTarget=\{handleTarget3D\}/, "パドル追従は handleTarget3D へ接続される");
  assert.match(client, /onCanvasPointerDown/, "2D 側の既存ハンドラが残る");
  // PR #796 で確定した判定仕様 (300ms 以内 + 高さ 48px 以内 + 開始時は記録を消す) が不変
  assert.match(client, /now - last\.t <= 300 && Math\.abs\(clientY - last\.y\) <= 48/, "ダブルタップ = ポーズの位置ガードが不変");
  assert.match(client, /lastPlayTapAtRef\.current = null;\s*setPhase\("playing"\)/, "開始・再開時は記録を消して即ポーズを防ぐ");
});

test("3D batch5-action3: ロジック層に three が混入していない (pong に lib ファイルを作らない)", () => {
  assert.doesNotMatch(read("lib", "breakout.ts"), /from "three"/, "lib/breakout.ts");
  assert.equal(fs.existsSync(path.join(webDir, "lib", "pong.ts")), false, "pong のロジックはクライアント内のまま");
});

test("3D batch5-action3: シーンに絵文字UIがない (色は材質で表現)", () => {
  for (const g of BATCH) {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${g.dir} scene emoji`);
  }
});
