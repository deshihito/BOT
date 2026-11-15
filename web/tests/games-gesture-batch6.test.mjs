// 第6バッチ ジェスチャ移行（2026-11-14 ユーザー裁定）の回帰テスト。
// - 対象8ゲームのクライアントに実行ボタンが残っていないこと（静的検査）
// hanoi / drawguess / breakout / bowling / tents / spider / shikaku / river の
// 残りボタンはゲーム外 chrome（リセット操作）として例外リスト入り済みの
// ため、上限件数だけを固定する。drawguess は 0 件。
// - drawguess は OnlineShell 経由のオンライン対戦だが、第3〜第5バッチの
//   battleship / territory / countdown と同じく自コンポーネントのみを変更し
//   OnlineShell には触れていない（構造が残っていることを固定する）。
// - breakout / bowling は window キーリスナーとタップ対象物の二重発火防止
//   ガードを固定する（reaction / falling / wordle の教訓）。
// - tents / shikaku / river は盤面・ボートの Enter と子の Enter の二重発火
//   防止ガードを固定する（anagram / mastermind の教訓）。
// - spider は山札配りの無効条件（旧ボタンの disabled と同等）を固定する
//   （backgammon のバー復帰不能の教訓）。
// - 盤面内に子の onClick があるゲーム（tents / spider / shikaku / river）は
//   useGesture の suppressClickAfterSwipe によるスワイプ直後の click 抑止が働く
//   ことを、共通ヘルパーの利用で固定する（ヘルパー自体の動作は batch3 の
//   テストで検証済み。breakout の canvas には子の onClick がないため対象外）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const webDir = path.join(import.meta.dirname, "..");

const CLIENTS = {
  hanoi: "HanoiClient.tsx",
  drawguess: "DrawGuessClient.tsx",
  breakout: "BreakoutClient.tsx",
  bowling: "BowlingClient.tsx",
  river: "RiverClient.tsx",
};
// 例外リスト（ゲーム外 chrome のリセットボタン）以外は 0 件であること。
const BUTTON_BUDGET = { hanoi: 1, drawguess: 0, breakout: 1, bowling: 1, river: 1 };

function read(game) {
  return fs.readFileSync(path.join(webDir, "app", "games", game, CLIENTS[game]), "utf8");
}

for (const [game, file] of Object.entries(CLIENTS)) {
  test(`gesture batch6: ${game} の実行ボタン廃止（<button> <= ${BUTTON_BUDGET[game]}）`, () => {
    const src = read(game);
    const count = (src.match(/<button/g) ?? []).length;
    assert.ok(count <= BUTTON_BUDGET[game], `${game}: <button> が ${count} 件残っている`);
  });
}

test("gesture batch6: 残りボタンは chrome のリセット操作だけ", () => {
  for (const game of ["hanoi", "breakout", "bowling", "river"]) {
    const src = read(game);
    const buttons = src.match(/<button[\s\S]*?<\/button>/g) ?? [];
    assert.equal(buttons.length, 1, `${game}: 残りボタンが ${buttons.length} 件`);
    assert.ok(buttons[0].includes("もう一度"), `${game}: 残りボタンがリセット操作ではない`);
  }
  const draw = read("drawguess");
  assert.equal((draw.match(/<button/g) ?? []).length, 0, "drawguess: ボタンが残っている");
});

test("gesture batch6: 8ゲームとも共通ヘルパー lib/gesture を使う", () => {
  for (const game of Object.keys(CLIENTS)) {
    const src = read(game);
    assert.ok(src.includes('from "@/lib/gesture"'), `${game}: lib/gesture を import していない`);
    assert.ok(src.includes("tappableProps") || src.includes("useGesture"), `${game}: lib/gesture を使っていない`);
  }
});

test("gesture batch6: スワイプ系2ゲームは盤面・対象物に useGesture を使う", () => {
  for (const game of ["breakout", "river"]) {
    const src = read(game);
    assert.ok(src.includes("useGesture"), `${game}: useGesture を使っていない`);
  }
  // hanoi / drawguess / bowling はタップ対象物化のみ（盤面スワイプを持たない）。
  // bowling のジェスチャ面は 3D シーン側（ドラッグで狙い、フリックで投球）が担う。
  const bowlingScene = fs.readFileSync(
    path.join(webDir, "app", "games", "bowling", "BowlingScene3D.tsx"),
    "utf8",
  );
  assert.ok(bowlingScene.includes("onDown"), "bowling: シーンのドラッグ起点がない");
  assert.ok(bowlingScene.includes("startRoll"), "bowling: フリック投球への接続がない");
});

test("gesture batch6: ジェスチャ面は touchAction none（hanoi の柱はタップのみのため manipulation）", () => {
  for (const game of ["breakout", "river"]) {
    const src = read(game);
    assert.ok(src.includes('touchAction: "none"'), `${game}: ジェスチャ面に touchAction none がない`);
  }
  // drawguess のキャンバスは描き手のときだけ none（それ以外は auto でスクロール可）。
  const draw = read("drawguess");
  assert.ok(draw.includes('touchAction: canDraw ? "none" : "auto"'), "drawguess: 描画面に touchAction none がない");
  const scene = fs.readFileSync(
    path.join(webDir, "app", "games", "bowling", "BowlingScene3D.tsx"),
    "utf8",
  );
  assert.ok(scene.includes('touchAction = "none"'), "bowling: シーンに touchAction none がない");
});

test("gesture batch6: hanoi は柱・枚数・自動解答がタップ対象物化", () => {
  const src = read("hanoi");
  assert.ok(src.includes("tappableProps(() => onPeg(peg))"), "柱がタップ対象になっていない");
  assert.ok(src.includes("tappableProps(() => restart(n))"), "枚数選択がタップ対象になっていない");
  assert.ok(src.includes("tappableProps(startAuto)"), "自動解答を見るがタップ対象になっていない");
  assert.ok(src.includes("tappableProps(() => setAuto(false))"), "自動解答を止めるがタップ対象になっていない");
  assert.ok(src.includes("aria-pressed={isSelected}"), "柱の選択表示がない");
  // 自動解答中は onPeg が早期 return するため、柱は操作不可の見た目にする
  //（HEAD の `auto || solved` が正しく、solved のみへの整理は後退だった）。
  assert.ok(src.includes('cursor: auto || solved ? "default" : "pointer"'), "自動解答中の柱のカーソルが操作可のまま");
});

test("gesture batch6: drawguess は選択・色・太さ・全消し・回答がタップ対象物化し OnlineShell は残る", () => {
  const src = read("drawguess");
  assert.ok(src.includes('void api.move({ type: "choose", index: i })'), "お題選択への接続が壊れている");
  assert.ok(src.includes("tappableProps(() => setColor(c))"), "色がタップ対象になっていない");
  assert.ok(src.includes("tappableProps(() => setWidth(w))"), "太さがタップ対象になっていない");
  assert.ok(src.includes('void api.move({ type: "clear" })'), "全部消すへの接続が壊れている");
  assert.ok(src.includes("tappableProps(submitGuess)"), "回答がタップ対象になっていない");
  // 入力欄の Enter でも回答できる（フォームの onSubmit が残っている）。
  assert.ok(src.includes("onSubmit={(e) => {"), "回答フォームの Enter 送信が壊れている");
  // OnlineShell 経由のオンライン対戦であること（自コンポーネントのみ変更）。
  assert.ok(src.includes('<OnlineShell gameId="drawguess"'), "OnlineShell の構造が壊れている");
  assert.ok(src.includes("OnlineRoomApi"), "OnlineShell との型の接続が壊れている");
});

test("gesture batch6: breakout は盤面タップで発射・次レベルへ、下スワイプでポーズ", () => {
  const src = read("breakout");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes('dir === "down"'), "ポーズが下スワイプになっていない");
  assert.ok(src.includes('setPhase("paused")'), "ポーズへの接続が壊れている");
  assert.ok(src.includes("launch()"), "発射への接続が壊れている");
  assert.ok(src.includes("startLevel(levelRef.current + 1, true, true)"), "次のレベルへへの接続が壊れている");
  assert.ok(!src.includes("発射 / スタート"), "発射ボタンが残っている");
  assert.ok(!src.includes(">ポーズ</button>"), "ポーズボタンが残っている");
  assert.ok(!src.includes("activeBtn"), "廃止したボタンのスタイルが残っている");
  // クリア時・終了時のスペース / Enter（旧ボタンのキーボード到達と同等）。
  assert.ok(src.includes('phaseRef.current === "cleared"'), "クリア時のキー操作がない");
  assert.ok(src.includes('phaseRef.current === "gameover"'), "終了時のキー操作がない");
  // 「もう一度」ボタンにフォーカスがあるときはネイティブ click に任せ、
  // window 側の発射・次レベルと二重に走らせない（falling / wordle の教訓）。
  assert.ok(src.includes('data-breakout-ui=""'), "もう一度ボタンに二重発火防止の目印がない");
  assert.ok(src.includes('closest?.("[data-breakout-ui]")'), "window リスナーに二重発火防止のガードがない");
});

test("gesture batch6: bowling はボタン投球を廃止しキーボードで狙い・投げる", () => {
  const src = read("bowling");
  assert.ok(!src.includes("ボタンで投げる"), "ボタン投球の操作群が残っている");
  assert.ok(!src.includes('aria-label="左へ移動"'), "左へ移動ボタンが残っている");
  assert.ok(!src.includes('aria-label="右へ移動"'), "右へ移動ボタンが残っている");
  assert.ok(!src.includes("ボタンでも投げられます"), "ボタン投球の説明が残っている");
  // 矢印キーで狙い、スペース / Enter で投げる（旧ボタンのキーボード到達と同等）。
  assert.ok(src.includes('e.key === "ArrowLeft"'), "左へ狙うキーがない");
  assert.ok(src.includes('e.key === "ArrowRight"'), "右へ狙うキーがない");
  assert.ok(src.includes("sceneApiRef.current?.adjustAim(-0.18)"), "左への狙い調整がない");
  assert.ok(src.includes("sceneApiRef.current?.adjustAim(0.18)"), "右への狙い調整がない");
  assert.ok(src.includes("sceneApiRef.current?.throwStraight()"), "投げるへの接続が壊れている");
  // 音トグルはタップ対象物化、「もう一度」ボタンとともに window 側の
  // 投球と二重発火しないよう目印付き（falling / wordle の教訓）。
  assert.ok(src.includes("tappableProps(toggleMute)"), "音トグルがタップ対象になっていない");
  assert.equal((src.match(/data-bowling-ui=""/g) ?? []).length, 2, "data-bowling-ui の目印が 2 箇所ではない");
  assert.ok(src.includes('closest?.("[data-bowling-ui]")'), "window リスナーに二重発火防止のガードがない");
  // ガードは投球（スペース / Enter）分岐の中だけに置く。矢印キーには div 側の
  // ハンドラがないため、音トグル等にフォーカスがあっても狙いは矢印キーで動く。
  assert.ok(
    src.indexOf('closest?.("[data-bowling-ui]")') > src.indexOf('e.key === "ArrowLeft"'),
    "二重発火防止ガードが矢印キーまで塞いでいる",
  );
});




test("gesture batch6: river はボートの対岸スワイプで渡る、荷物はタップ対象物化", () => {
  const src = read("river");
  assert.ok(src.includes("boatGesture"), "ボートに useGesture が繋がっていない");
  assert.ok(src.includes('dir === "right"'), "右への渡河がスワイプになっていない");
  assert.ok(src.includes('dir === "left"'), "左への渡河がスワイプになっていない");
  assert.ok(src.includes("cross()"), "渡河への接続が壊れている");
  assert.ok(src.includes("tappableProps(() => selectProblem(p.id))"), "問題選択がタップ対象になっていない");
  assert.ok(src.includes("toggleRiverItem(state, id)"), "荷物の乗せ降ろしへの接続が壊れている");
  assert.ok(src.includes("aria-disabled={!interactive}"), "荷物チップの無効化がない");
  assert.ok(!src.includes("わたる →"), "わたるボタンが残っている");
  assert.ok(!src.includes("← もどる"), "もどるボタンが残っている");
});


test("gesture batch6: 8ゲームとも ⏱ が残っていない", () => {
  for (const game of Object.keys(CLIENTS)) {
    const src = read(game);
    assert.ok(!src.includes("⏱"), `${game}: ⏱ が残っている`);
  }
});
