// 3D化 第7バッチ 盤オブジェクト系（sokoban / rushhour / peg / mastermind）の
// 回帰テスト（静的検査）。既存バッチの流儀に倣い、以下を担保する:
// - シーンは dynamic import (ssr:false) で遅延読み込みされ、three はシーン側だけ
// - シーンは three-kit の createStage / attachPickPointer / SceneBox を使う
// - WebGL 失敗時は onFail / webglFailed で既存 2D へフォールバックする
// - <button> 数が現行（sokoban 1 / rushhour 3 / peg 3 / mastermind 1）以下
// - 入力が既存ハンドラ（sokoban: move / rushhour: slideCar / peg: onCell /
//   mastermind: onSlotTap・onSubmit）へ接続される
// - 合法判定・勝敗判定を 3D 側で再実装していないこと
// - mastermind の答え（secret）をシーンへ渡していないこと
// - ロジック（lib/sokoban.ts 等）へ three が混入していないこと
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
  { dir: "sokoban", client: "SokobanClient.tsx", scene: "SokobanScene3D.tsx", buttons: 1 },
  { dir: "rushhour", client: "RushHourClient.tsx", scene: "RushHourScene3D.tsx", buttons: 3 },
  { dir: "peg", client: "PegClient.tsx", scene: "PegScene3D.tsx", buttons: 3 },
  { dir: "mastermind", client: "MastermindClient.tsx", scene: "MastermindScene3D.tsx", buttons: 1 },
];

for (const g of BATCH) {
  test(`3D batch7-objects ${g.dir}: シーンは dynamic import で遅延読み込みされ、three はシーン側だけ`, () => {
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

  test(`3D batch7-objects ${g.dir}: <button> 数が現行（${g.buttons}）以下`, () => {
    assert.ok(countButtons(g.dir) <= g.buttons, `${g.dir} buttons=${countButtons(g.dir)}`);
  });

  test(`3D batch7-objects ${g.dir}: シーンに絵文字UIがない（色と造形で表現）`, () => {
    const scene = read("app", "games", g.dir, g.scene);
    assert.doesNotMatch(scene, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${g.dir} scene emoji`);
  });

  test(`3D batch7-objects ${g.dir}: クライアントは three-kit を直接触らない`, () => {
    const client = read("app", "games", g.dir, g.client);
    assert.doesNotMatch(client, /three-kit/, `${g.dir} client は基盤を直接触らない`);
  });
}

test("3D batch7-objects sokoban: 壁・箱・ゴール・プレイヤーの造形が現行仕様の色に従う", () => {
  const scene = read("app", "games", "sokoban", "SokobanScene3D.tsx");
  assert.match(scene, /createCrate/, "箱は木箱の造形で作る");
  assert.match(scene, /0xb07d3c/, "箱は現行 2D の木箱色");
  assert.match(scene, /0x7cb342/, "ゴール上の箱は現行 2D と同じ緑に変わる");
  assert.match(scene, /0xd63c30/, "ゴールは床の赤い円盤");
  assert.match(scene, /CylinderGeometry\(0\.3, 0\.3/, "ゴール円盤は円柱で作る");
  assert.match(scene, /createPlayerToken/, "プレイヤーは人型トークンで作る");
  assert.match(scene, /createBall/, "プレイヤーの頭は球で作る");
});

test("3D batch7-objects sokoban: スワイプが FlickInfo.dir のまま親の move へ、箱タップと床ダブルタップも既存経路へ接続される", () => {
  const scene = read("app", "games", "sokoban", "SokobanScene3D.tsx");
  assert.match(scene, /onFlick: \(flick\)/, "スワイプを受け口に持つ");
  assert.match(scene, /onDragEnd: \(flick\)/, "ドラッグ終了時のフリックも受け口に持つ");
  assert.match(scene, /propsRef\.current\.onMove\(flick\.dir\)/, "方向は FlickInfo.dir をそのまま親へ渡す");
  assert.match(scene, /propsRef\.current\.onBoxTap\(index\)/, "箱タップは親の箱押し経路へ渡す");
  assert.match(scene, /propsRef\.current\.onUndo\(\)/, "床ダブルタップは親の1手戻す経路へ渡す");
  assert.doesNotMatch(scene, /(moveSokoban|pushBoxByClick|deadlockedBoxes)\s*\(/, "移動・箱押し・詰み判定を 3D 側で再実装しない");
  const client = read("app", "games", "sokoban", "SokobanClient.tsx");
  assert.match(client, /onMove=\{move\}/, "既存の move へ接続する");
  assert.match(client, /onBoxTap=\{onBoxClick\}/, "既存の onBoxClick へ接続する");
  assert.match(client, /onUndo=\{requestUndo\}/, "既存の1手戻す経路へ接続する");
});

test("3D batch7-objects sokoban: プレイヤーと箱は差分同期＋補間でセル間をスライドする", () => {
  const scene = read("app", "games", "sokoban", "SokobanScene3D.tsx");
  assert.match(scene, /boxesRt/, "箱は差分同期で管理する");
  assert.match(scene, /playerTx/, "プレイヤーは目標位置を持つ");
  assert.match(scene, /Math\.exp\(-dt/, "補間は指数追従（fifteen と同じ）");
});

test("3D batch7-objects rushhour: 車は長さと向きを持つ直方体、出口は開口＋色帯で表す", () => {
  const scene = read("app", "games", "rushhour", "RushHourScene3D.tsx");
  assert.match(scene, /createCarMesh/, "車を造形する");
  assert.match(scene, /TARGET_COLOR = 0xdc2626/, "自車は現行 2D と同じ赤");
  assert.match(scene, /CAR_COLORS/, "他車は現行の色分けを持つ");
  assert.match(scene, /bandFloor|bandPost/, "出口は色帯で表す");
  assert.match(scene, /RUSH_EXIT_ROW/, "出口行は lib の定数を使う");
});

test("3D batch7-objects rushhour: ドラッグは軸方向の視覚追従だけで、確定は離したとき1回だけ親の slideCar へ渡す", () => {
  const scene = read("app", "games", "rushhour", "RushHourScene3D.tsx");
  assert.match(scene, /onDragStart: \(hit\)/, "掴む操作を受け口に持つ");
  assert.match(scene, /onDragMove: \(point\)/, "planePoint のドラッグ移動を受け口に持つ");
  assert.match(scene, /onDragEnd: \(\)/, "確定を受け口に持つ");
  assert.match(scene, /propsRef\.current\.onGrabCar\(carId\)/, "掴んだら選択を親へ寄せる");
  assert.match(scene, /propsRef\.current\.onSlide\(carId, curDelta\)/, "離した時点で delta を1回だけ親へ渡す");
  assert.match(scene, /propsRef\.current\.ranges/, "動ける範囲は親（lib の rushSlideRange）から受け取る");
  assert.match(scene, /propsRef\.current\.onTapCar\(Number\(id\.slice\(4\)\)\)/, "車タップは親の選択トグルへ渡す");
  assert.doesNotMatch(scene, /rushSlide\(|rushSlideOptions|rushOccupancy/, "スライド可否・合法判定を 3D 側で再実装しない");
  const client = read("app", "games", "rushhour", "RushHourClient.tsx");
  assert.match(client, /onTapCar=\{onCarTap\}/, "既存の選択トグルへ接続する");
  assert.match(client, /onSlide=\{slideCar\}/, "既存のスライド実行へ接続する");
  assert.match(client, /rushSlideRange\(state, car\.id\)/, "範囲計算は lib の rushSlideRange のまま");
  assert.match(client, /rushSlide\(s, carId, delta\)/, "状態遷移は lib の rushSlide のまま");
});

test("3D batch7-objects peg: 穴は沈んだ円盤、ペグは createStone、選択中は持ち上げ＋発光", () => {
  const scene = read("app", "games", "peg", "PegScene3D.tsx");
  assert.match(scene, /createStone/, "ペグは three-kit の createStone で作る");
  assert.match(scene, /isPegHole/, "盤の形状（33穴）は lib の判定を使う");
  assert.match(scene, /PEG_SELECTED_COLOR/, "選択中ペグの色を持つ");
  assert.match(scene, /emissiveIntensity/, "選択中・移動先は発光で示す");
  assert.match(scene, /pegsRt/, "ペグは差分同期で管理する（跳躍の除去も差分で表れる）");
});

test("3D batch7-objects peg: タップが現行の選択→移動ハンドラへ接続され、移動先は親が計算する", () => {
  const scene = read("app", "games", "peg", "PegScene3D.tsx");
  assert.match(scene, /propsRef\.current\.onCell\(Number\(id\.slice\(5\)\)\)/, "タップが onCell を呼ぶ");
  assert.doesNotMatch(scene, /(applyPegMove|pegMovesFrom|pegLegalMoves)\s*\(/, "合法手・移動適用を 3D 側で再実装しない");
  const client = read("app", "games", "peg", "PegClient.tsx");
  assert.match(client, /onCell=\{onCell\}/, "既存の onCell へ接続する");
  assert.match(client, /destinations=\{destinations\.map\(\(m\) => m\.to\)\}/, "移動先は親の pegMovesFrom の結果を渡す");
});

test("3D batch7-objects mastermind: 推測ペグは色球、フィードバックは小さな黒/白ペグ、現在の行は持ち上がる", () => {
  const scene = read("app", "games", "mastermind", "MastermindScene3D.tsx");
  assert.match(scene, /createBall/, "推測ペグは three-kit の createBall で作る");
  assert.match(scene, /createColorBall/, "色球を造形する");
  assert.match(scene, /0x1c1c1e/, "ヒットは黒ペグで表す");
  assert.match(scene, /0xf5f5f5/, "ブローは白ペグで表す");
  assert.match(scene, /createGuessRow/, "履歴の行を造形する");
  assert.match(scene, /rowsRt/, "履歴の行は差分同期で管理する");
});

test("3D batch7-objects mastermind: スロットタップとスワイプが現行ハンドラへ接続され、色パレットは DOM のまま", () => {
  const scene = read("app", "games", "mastermind", "MastermindScene3D.tsx");
  assert.match(scene, /propsRef\.current\.onSlotTap\(Number\(id\.slice\(5\)\)\)/, "スロットタップが選択ハンドラを呼ぶ");
  assert.match(scene, /propsRef\.current\.onSubmitGuess\(\)/, "上スワイプが判定ハンドラを呼ぶ");
  assert.match(scene, /propsRef\.current\.onClearGuess\(\)/, "左スワイプがクリアハンドラを呼ぶ");
  assert.doesNotMatch(scene, /(submitGuess|scoreGuess|isValidGuess)\s*\(/, "判定・集計を 3D 側で再実装しない");
  const client = read("app", "games", "mastermind", "MastermindClient.tsx");
  assert.match(client, /onSlotTap=\{onSlotTap\}/, "既存のスロット選択へ接続する");
  assert.match(client, /onSubmitGuess=\{onSubmit\}/, "既存の判定へ接続する");
  assert.match(client, /onClearGuess=\{clearGuess\}/, "既存のクリアへ接続する");
  assert.match(client, /\{paletteDom\}/, "色パレットは DOM のまま併記される");
});

test("3D batch7-objects mastermind: 答え（secret）をシーンへ渡さない・シーンで描かない", () => {
  const scene = read("app", "games", "mastermind", "MastermindScene3D.tsx");
  assert.doesNotMatch(scene, /secret\s*[=:]/, "シーンは secret を受け取らない");
  const client = read("app", "games", "mastermind", "MastermindClient.tsx");
  const sceneJsx = client.slice(client.indexOf("<MastermindScene3D"), client.indexOf("/>", client.indexOf("<MastermindScene3D")));
  assert.doesNotMatch(sceneJsx, /secret/, "クライアントはシーンへ secret を渡さない");
  assert.match(client, /guesses=\{state\.guesses\}/, "シーンへ渡すのは判定済み履歴だけ");
});

test("3D batch7-objects: ロジック層（lib/sokoban.ts, rushhour.ts, peg.ts, mastermind.ts）に three が混入していない", () => {
  for (const f of ["sokoban.ts", "rushhour.ts", "peg.ts", "mastermind.ts"]) {
    assert.doesNotMatch(read("lib", f), /from "three"/, `lib/${f}`);
  }
});
