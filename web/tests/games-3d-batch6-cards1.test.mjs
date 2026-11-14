// 3D化 第6バッチ（カード系1: highlow / pyramid / montecarlo）の回帰テスト（静的検査）。
// batch3-cards のスタイルに倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createCard / createStage / attachPickPointer / SceneBox を使う
// - カードは差分同期（スロットキー＋カードキーの Map = entries）で管理し、
//   スロットを移るカードは lastPosByCard で最終位置を引き継ぐ
// - <button> 数が現行（highlow 0 / pyramid 1 / montecarlo 1）から増えていないこと
// - ロジック（lib/*.ts）へ three が混入していないこと
// - 入力は既存ハンドラへ接続されること（highlow: 上フリック=high/下フリック=low、
//   pyramid: タップ=onTarget ラッパ＋ストック、montecarlo: タップ=onCell/下フリック=詰める）
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
  { dir: "highlow", client: "HighLowClient.tsx", scene: "HighLowScene3D.tsx", buttons: 0 },
  { dir: "pyramid", client: "PyramidClient.tsx", scene: "PyramidScene3D.tsx", buttons: 1 },
  { dir: "montecarlo", client: "MonteCarloClient.tsx", scene: "MonteCarloScene3D.tsx", buttons: 1 },
];

for (const g of BATCH) {
  test(`3D batch6-cards1 ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.match(client, new RegExp(`dynamic\\(\\(\\) => import\\("\\./${g.scene.replace(".tsx", "")}"\\), \\{ ssr: false \\}\\)`), "dynamic import");
    assert.doesNotMatch(client, /from "three"/, "クライアントに three を直接 import しない");
    const scene = read("app", "games", g.dir, g.scene);
    assert.match(scene, /from "three"/);
    assert.match(scene, /three-kit/, "共通基盤を使う");
    assert.match(client, /webglFailed/, "WebGL 失敗時のフォールバックがある");
    assert.match(client, /board2d/, "フォールバック用の既存 2D 表示を保持する");
    assert.match(client, /onFail=\{\(\) => setWebglFailed\(true\)\}/, "onFail で 2D 表示へ切り替える");
  });

  test(`3D batch6-cards1 ${g.dir}: シーンはカード系の型（createCard/createStage/attachPickPointer/SceneBox）を使う`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    for (const name of ["createCard", "createStage", "attachPickPointer", "SceneBox"]) {
      assert.match(scene, new RegExp(name), name);
    }
    assert.match(scene, /entries/, "スロット単位でカードを差分管理する");
    assert.match(scene, /cardKey/, "カードキーで差分判定する");
    assert.match(scene, /lastPosByCard/, "スロットを移るカードの最終位置を引き継ぐ");
    assert.match(scene, /propsRef/, "props は propsRef パターンで最新を参照する");
  });

  test(`3D batch6-cards1 ${g.dir}: <button> 数が現行（${g.buttons}）から増えていない`, () => {
    assert.equal(countButtons(g.dir), g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });
}

test("3D batch6-cards1 highlow: 現在カード（表）＋次のカード（裏）＋山札を差分同期する", () => {
  const scene = read("app", "games", "highlow", "HighLowScene3D.tsx");
  assert.match(scene, /FACE_DOWN/, "次のカードは裏向きで置く");
  assert.match(scene, /FACE_UP/, "現在のカードは表向きで置く");
  assert.match(scene, /fromRotX/, "次カードが現在位置へ移る際にフリップ（裏→表）する");
  assert.match(scene, /deckCount/, "山札の束を持つ");
  const client = read("app", "games", "highlow", "HighLowClient.tsx");
  assert.match(client, /nextCard=\{state\.pile\[1\] \?\? null\}/, "次のカードをシーンへ渡す");
  assert.match(client, /current=\{current\}/, "現在のカードをシーンへ渡す");
});

test("3D batch6-cards1 highlow: 上フリック=high / 下フリック=low が既存 onGuess へ接続される", () => {
  const scene = read("app", "games", "highlow", "HighLowScene3D.tsx");
  assert.match(scene, /onFlick/, "フリックを拾う（方向判定は attachPickPointer の swipeDirection）");
  assert.match(scene, /onDragEnd/, "掴んだまま離したケースも同じハンドラへつなぐ");
  assert.match(scene, /dir === "up"\) propsRef\.current\.onGuess\("high"\)/, "上 = high");
  assert.match(scene, /dir === "down"\) propsRef\.current\.onGuess\("low"\)/, "下 = low");
  const client = read("app", "games", "highlow", "HighLowClient.tsx");
  assert.match(client, /onGuess=\{onGuess\}/, "既存の onGuess ハンドラへ接続する");
  assert.match(client, /guessHighLow\(state, dir\)/, "判定は lib の guessHighLow を使う");
  assert.match(client, /useGesture/, "2D フォールバックは既存の useGesture スワイプを保持する");
});

test("3D batch6-cards1 pyramid: 段差配置・露出/減光・選択の金縁がある", () => {
  const scene = read("app", "games", "pyramid", "PyramidScene3D.tsx");
  assert.match(scene, /pyramidSlotPos\(slot\)/, "配置は lib の pyramidSlotPos を使う");
  assert.match(scene, /0xf2b33d/, "選択中の金縁フレームがある");
  assert.match(scene, /dim: !isExp/, "覆われているカードは減光する");
  assert.match(scene, /pickId: isExp \? `pyramid-\$\{slot\}` : undefined/, "露出カードだけタップ対象にする");
  assert.match(scene, /setCardDim/, "減光は opacity で表す");
  const client = read("app", "games", "pyramid", "PyramidClient.tsx");
  assert.match(client, /exposed=\{exposedSlots\(state\)\}/, "露出判定は lib の exposedSlots を使う");
  assert.match(client, /selected=\{selected\}/, "選択状態をシーンへ渡す");
});

test("3D batch6-cards1 pyramid: タップが既存ハンドラ（onTarget ラッパ/ストック）へ接続される", () => {
  const client = read("app", "games", "pyramid", "PyramidClient.tsx");
  assert.match(client, /onPyramidTap=\{handlePyramidTap\}/, "ピラミッドのタップが接続される");
  assert.match(client, /!exposed\.has\(slot\)\) return/, "覆われているカードはクライアント側でも弾く（2D の cellDisabled と同等）");
  assert.match(client, /onTarget\(\{ kind: "pyramid", slot \}, card\)/, "選択/ペア確定は既存の onTarget が持つ");
  assert.match(client, /onWasteTap=\{handleWasteTap\}/, "捨て山のタップが接続される");
  assert.match(client, /onTarget\(\{ kind: "waste" \}, wasteTop\)/, "捨て山も既存の onTarget へ接続する");
  assert.match(client, /onStockTap=\{flipStock\}/, "ストックのタップ = 既存のめくり処理");
  assert.match(client, /setState\(\(s\) => flipPyramidStock\(s\)\)/, "めくりは lib の flipPyramidStock を使う");
  const scene = read("app", "games", "pyramid", "PyramidScene3D.tsx");
  assert.match(scene, /pickId === "stock"/, "ストックに pickId を付ける");
  assert.match(scene, /pickId === "waste"/, "捨て山に pickId を付ける");
});

test("3D batch6-cards1 montecarlo: 5x5 グリッド・選択の金縁・ペアの緑縁がある", () => {
  const scene = read("app", "games", "montecarlo", "MonteCarloScene3D.tsx");
  assert.match(scene, /MC_COLS/, "グリッド配置は lib の MC_COLS を使う");
  assert.match(scene, /0xf2b33d/, "選択中の金縁フレームがある");
  assert.match(scene, /pairCells/, "ペア候補のマスを受け取る");
  assert.match(scene, /0x22c55e/, "ペア候補は緑縁で示す（2D の緑枠と同等）");
  const client = read("app", "games", "montecarlo", "MonteCarloClient.tsx");
  assert.match(client, /pairCells=\{\[\.\.\.pairSet\]\}/, "ペア判定は lib の montecarloPairs 由来の pairSet を渡す");
  assert.match(client, /selected=\{selected\}/, "選択状態をシーンへ渡す");
});

test("3D batch6-cards1 montecarlo: タップ=既存 onCell / 下フリック=既存の詰める へ接続される", () => {
  const client = read("app", "games", "montecarlo", "MonteCarloClient.tsx");
  assert.match(client, /onCellTap=\{onCell\}/, "マスのタップ = 既存の onCell ハンドラ");
  assert.match(client, /montecarloRemovePair/, "ペア除去は lib の montecarloRemovePair を使う");
  assert.match(client, /onConsolidate=\{consolidate\}/, "詰める = 既存の consolidate ハンドラ");
  assert.match(client, /setState\(\(s\) => montecarloConsolidate\(s\)\)/, "詰めるは lib の montecarloConsolidate を使う");
  assert.match(client, /useGesture/, "2D フォールバックは既存の useGesture（下スワイプで詰める）を保持する");
  const scene = read("app", "games", "montecarlo", "MonteCarloScene3D.tsx");
  assert.match(scene, /onFlick/, "フリックを拾う（方向判定は attachPickPointer の swipeDirection）");
  assert.match(scene, /onDragEnd/, "掴んだまま離したケースも同じハンドラへつなぐ");
  assert.match(scene, /dir === "down"\) propsRef\.current\.onConsolidate\(\)/, "下フリック = 詰める");
  assert.match(scene, /pickId.*cell-/, "各マスのカードに pickId を付ける");
});

test("3D batch6-cards1: ロジック層（lib/highlow.ts, lib/pyramid.ts, lib/montecarlo.ts）に three が混入していない", () => {
  for (const f of ["highlow.ts", "pyramid.ts", "montecarlo.ts"]) {
    assert.doesNotMatch(read("lib", f), /from "three"/, `lib/${f}`);
    assert.doesNotMatch(read("lib", f), /three-kit/, `lib/${f}`);
  }
});
