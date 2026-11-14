// 第4バッチ ジェスチャ移行（2026-11-14 ユーザー裁定）の回帰テスト。
// - 対象8ゲームのクライアントに実行ボタンが残っていないこと（静的検査）
// kanacross / chesspuzzle / anagram / 2048 / skyscrapers / mushoku / mastermind の
// 「もう一度」はゲーム外 chrome（リセット操作）として例外リスト入り済みの
// ため、上限件数だけを固定する。territory は 0 件。
// - kanacross は window キーリスナーと div のキー対応が重なるため、
//   Enter の二重発火防止ガードを固定する（reaction / falling / wordle の教訓）。
// - 盤面内に子の onClick があるゲーム（kanacross / chesspuzzle / anagram /
//   territory / mushoku / mastermind）は useGesture の suppressClickAfterSwipe
//   によるスワイプ直後の click 抑止が働くことを、共通ヘルパーの利用で固定する。
// - skyscrapers はスワイプ面を持たないパッド型ゲームのため touchAction の
//   対象外。2048 は旧来の TouchEvent 直書きを useGesture に寄せた。
// - 第4バッチレビューで 3 件追加: anagram / mastermind の Enter 二重発火防止、
//   anagram のダブルタップ=ヒント誤発火防止、territory の送信中ガード。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const webDir = path.join(import.meta.dirname, "..");

const CLIENTS = {
  kanacross: "KanacrossClient.tsx",
  chesspuzzle: "ChessPuzzleClient.tsx",
  anagram: "AnagramClient.tsx",
  2048: "SliderClient.tsx",
  territory: "TerritoryClient.tsx",
  mastermind: "MastermindClient.tsx",
};
// 例外リスト（ゲーム外 chrome のリセットボタン）以外は 0 件であること。
const BUTTON_BUDGET = { kanacross: 1, chesspuzzle: 1, anagram: 1, 2048: 1, territory: 0, mastermind: 1 };

function read(game) {
  return fs.readFileSync(path.join(webDir, "app", "games", game, CLIENTS[game]), "utf8");
}

for (const [game, file] of Object.entries(CLIENTS)) {
  test(`gesture batch4: ${game} の実行ボタン廃止（<button> <= ${BUTTON_BUDGET[game]}）`, () => {
    const src = read(game);
    const count = (src.match(/<button/g) ?? []).length;
    assert.ok(count <= BUTTON_BUDGET[game], `${game}: <button> が ${count} 件残っている`);
  });
}

test("gesture batch4: 残りボタンは chrome のリセット操作「もう一度」だけ", () => {
  for (const game of ["kanacross", "chesspuzzle", "anagram", "2048", "mastermind"]) {
    const src = read(game);
    const buttons = src.match(/<button[\s\S]*?<\/button>/g) ?? [];
    assert.equal(buttons.length, 1, `${game}: 残りボタンが ${buttons.length} 件`);
    assert.ok(buttons[0].includes("もう一度"), `${game}: 残りボタンがリセット操作ではない`);
    assert.ok(
      buttons[0].includes("restart") || buttons[0].includes("changePuzzle") || buttons[0].includes("startProblem"),
      `${game}: 残りボタンが再開に繋がっていない`,
    );
  }
});

test("gesture batch4: 8ゲームとも共通ヘルパー lib/gesture を使う", () => {
  for (const game of Object.keys(CLIENTS)) {
    const src = read(game);
    assert.ok(src.includes('from "@/lib/gesture"'), `${game}: lib/gesture を import していない`);
    assert.ok(src.includes("tappableProps") || src.includes("useGesture"), `${game}: lib/gesture を使っていない`);
  }
});

test("gesture batch4: スワイプ系6ゲームは盤面・対象物に useGesture を使う", () => {
  for (const game of ["kanacross", "chesspuzzle", "anagram", "2048", "territory", "mastermind"]) {
    const src = read(game);
    assert.ok(src.includes("useGesture"), `${game}: useGesture を使っていない`);
  }
});


test("gesture batch4: kanacross は盤面下スワイプで単語チェック、入力対象はタップ対象物化", () => {
  const src = read("kanacross");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes('dir === "down"'), "チェックが下スワイプになっていない");
  assert.ok(src.includes("onCheck()"), "チェックへの接続が壊れている");
  assert.ok(src.includes("tappableProps(() => selectWord(w))"), "ヒント行がタップ対象になっていない");
  assert.ok(src.includes("tappableProps(() => changePuzzle(i))"), "問題選択がタップ対象になっていない");
  assert.ok(src.includes("tappableProps(() => inputChar(ch))"), "カナパレットがタップ対象になっていない");
  assert.ok(src.includes("tappableProps(backspace)"), "消すがタップ対象になっていない");
  assert.ok(src.includes('role="gridcell"'), "盤マスが gridcell のタップ対象になっていない");
  assert.ok(src.includes('touchAction: "none"'), "盤面に touchAction none がない");
});

test("gesture batch4: kanacross の Enter は1経路のみ（二重発火防止）", () => {
  const src = read("kanacross");
  // マス・パレット・ヒント行・問題選択にフォーカスがあるときの Enter は
  // tappableProps が受け、window リスナー側は data-kanacross-ui ガードで無視する。
  // 両方が受けると選択と同時にチェックが走る（reaction の Space 二重発火と同じ構図）。
  assert.ok(src.includes('e.key === "Enter"'), "Enter でのチェックがない");
  assert.ok(src.includes('closest?.("[data-kanacross-ui]")'), "window リスナーに Enter のガードがない");
  // Enter を受ける要素はすべて目印を持つこと。内訳: ヒント行・問題選択・
  // もう一度・盤マス・パレット・消す = 6。
  const count = (src.match(/data-kanacross-ui=""/g) ?? []).length;
  assert.equal(count, 6, `data-kanacross-ui="" が ${count} 件（期待 6 件）`);
  const buttons = src.match(/<button[\s\S]*?<\/button>/g) ?? [];
  assert.equal(buttons.length, 1, "もう一度ボタンが1件ではない");
  assert.ok(buttons[0].includes("data-kanacross-ui"), "もう一度ボタンに data-kanacross-ui がない");
});

test("gesture batch4: chesspuzzle は盤面スワイプで1手戻す・ヒント、駒はタップ対象", () => {
  const src = read("chesspuzzle");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes('dir === "left"'), "1手戻すが左スワイプになっていない");
  assert.ok(src.includes('dir === "up"'), "ヒントが上スワイプになっていない");
  assert.ok(src.includes("undoMove()"), "1手戻すへの接続が壊れている");
  assert.ok(src.includes("showHint()"), "ヒントへの接続が壊れている");
  assert.ok(src.includes("onSquare(index)"), "盤マスのタップへの接続が壊れている");
  assert.ok(src.includes("tappableProps(() => startProblem(p.id))"), "問題選択がタップ対象になっていない");
  assert.ok(src.includes("tappableProps(() => doMove(opt))"), "昇格選択がタップ対象になっていない");
  // H / U キーでも同じ操作ができる（タップ対象物は Enter / Space のみのため二重発火なし）。
  assert.ok(src.includes('e.key === "h"'), "H キーでのヒントがない");
  assert.ok(src.includes('e.key === "u"'), "U キーでの1手戻すがない");
  assert.ok(src.includes('touchAction: "none"'), "盤面に touchAction none がない");
});

test("gesture batch4: anagram は回答欄スワイプで答える・並べ直す・ヒント、タイルはタップ対象", () => {
  const src = read("anagram");
  assert.ok(src.includes("answerGesture"), "回答欄に useGesture が繋がっていない");
  assert.ok(src.includes('dir === "up"'), "答えるが上スワイプになっていない");
  assert.ok(src.includes('dir === "left"'), "並べ直すが左スワイプになっていない");
  assert.ok(src.includes("trySubmit()"), "答えるへの接続が壊れている");
  assert.ok(src.includes("tryClear()"), "並べ直すへの接続が壊れている");
  assert.ok(src.includes("onDoubleTap"), "ヒントがダブルタップになっていない");
  assert.ok(src.includes("tryHint()"), "ヒントへの接続が壊れている");
  assert.ok(src.includes("tappableProps(() => { sfxTap(); setState((s) => pickTile(s, tile.id)); })"), "文字タイルがタップ対象になっていない");
  assert.ok(src.includes("tappableProps(() => { sfxTap(); setState((s) => nextQuestion(s)); })"), "次の問題へがタップ対象になっていない");
  // 回答欄フォーカス時のキーボード（window リスナーなしのため二重発火の余地なし）。
  assert.ok(src.includes('e.key === "Backspace"'), "Backspace での並べ直しがない");
  assert.ok(src.includes('e.key === "h"'), "H キーでのヒントがない");
  assert.ok(src.includes('touchAction: "none"'), "回答欄に touchAction none がない");
});

test("gesture batch4: 2048 は盤面スワイプで移動・ダブルタップで1手もどす、方向ボタン廃止", () => {
  const src = read("2048");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes("onSwipe: (dir) => doMove(dir)"), "スワイプが移動に繋がっていない");
  assert.ok(src.includes("onDoubleTap: () => undo()"), "1手もどすがダブルタップになっていない");
  assert.ok(src.includes('e.key === "u"'), "U キーでの1手もどすがない");
  assert.ok(src.includes("tappableProps(() => applyState(continueSlide(stateRef.current)))"), "このまま続けるがタップ対象になっていない");
  assert.ok(src.includes('touchAction: "none"'), "盤面に touchAction none がない");
  assert.ok(!src.includes("onTouchStart"), "旧来の TouchEvent 直書きが残っている");
  assert.ok(!src.includes("onTouchEnd"), "旧来の TouchEvent 直書きが残っている");
  assert.ok(!src.includes("touchRef"), "旧来の touchRef が残っている");
  assert.ok(!src.includes("左へ"), "方向ボタンが残っている");
});

test("gesture batch4: territory は盤面スワイプで回転・反転・パス、再タップで置く", () => {
  const src = read("territory");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes('dir === "right"'), "回転が右スワイプになっていない");
  assert.ok(src.includes('dir === "left"'), "反転が左スワイプになっていない");
  assert.ok(src.includes('dir === "down"'), "パスが下スワイプになっていない");
  assert.ok(src.includes("rotatePiece()"), "回転への接続が壊れている");
  assert.ok(src.includes("flipPiece()"), "反転への接続が壊れている");
  assert.ok(src.includes("pass()"), "パスへの接続が壊れている");
  assert.ok(src.includes("onCell(index)"), "盤マスのタップへの接続が壊れている");
  assert.ok(src.includes("tappableProps(() => selectPiece(piece))"), "ピース選択がタップ対象になっていない");
  assert.ok(!src.includes("og-button"), "回転・反転・ここに置く・パスの操作ボタンが残っている");
  // R / F / P キーでも同じ操作ができる。OnlineShell の入力欄では無視する。
  assert.ok(src.includes('e.key === "r"'), "R キーでの回転がない");
  assert.ok(src.includes('e.key === "f"'), "F キーでの反転がない");
  assert.ok(src.includes('e.key === "p"'), "P キーでのパスがない");
  assert.ok(src.includes("isContentEditable"), "入力欄でのキー無視ガードがない");
  assert.ok(src.includes('touchAction: "none"'), "盤面に touchAction none がない");
});



test("gesture batch4: mastermind は予想欄スワイプで判定・クリア、色はタップ対象物化", () => {
  const src = read("mastermind");
  assert.ok(src.includes("guessGesture"), "予想欄に useGesture が繋がっていない");
  assert.ok(src.includes('dir === "up"'), "判定するが上スワイプになっていない");
  assert.ok(src.includes('dir === "left"'), "クリアが左スワイプになっていない");
  assert.ok(src.includes("onSubmit()"), "判定への接続が壊れている");
  assert.ok(src.includes("clearGuess()"), "クリアへの接続が壊れている");
  assert.ok(src.includes("tappableProps(() => pickColor(c.id))"), "色パレットがタップ対象になっていない");
  assert.ok(src.includes("tappableProps(() => restart(d.key))"), "難易度選択がタップ対象になっていない");
  // 予想欄フォーカス時のキーボード（window リスナーなしのため二重発火の余地なし）。
  assert.ok(src.includes('e.key === "Backspace"'), "Backspace でのクリアがない");
  assert.ok(src.includes('touchAction: "none"'), "予想欄に touchAction none がない");
});

test("gesture batch4: 対象8ゲームに絵文字の時計記号が残っていない", () => {
  for (const game of Object.keys(CLIENTS)) {
    const src = read(game);
    assert.ok(!src.includes("⏱"), `${game}: 絵文字の時計記号が残っている`);
  }
});

test("gesture batch4: anagram / mastermind の Enter は1経路のみ（子マスとの二重発火防止）", () => {
  // 予想欄・回答欄の onKeyDown は子のマス（tappableProps）の Enter / Space と
  // 重なる。ガードがないと全選択済みのマスで Enter を押したときに外す／
  // スロット選択と判定が両方走る（第4バッチレビュー指摘1・2）。
  for (const game of ["anagram", "mastermind"]) {
    const src = read(game);
    assert.ok(src.includes("e.target !== e.currentTarget"), `${game}: 親の Enter 判定に子マス除外のガードがない`);
  }
});

test("gesture batch4: anagram のダブルタップ=ヒントは直前の外す操作と重ならない", () => {
  // ダブルタップ判定は子のマスのタップも拾うため、同じマスのダブルタップや
  // 2マスの連続タップで -20 点のヒントが誤発火する（第4バッチレビュー指摘3）。
  const src = read("anagram");
  assert.ok(src.includes("lastUnpickAtRef"), "外す操作の時刻記録がない");
  assert.ok(src.includes("Date.now() - lastUnpickAtRef.current < 400"), "ダブルタップのヒント誤発火ガードがない");
});

test("gesture batch4: territory の置く・パスは送信中（api.busy）に送らない", () => {
  // 旧「ここに置く」/「パス」ボタンは api.busy で無効化されていた。
  // 再タップでの置くに置き換えた際にガードが落ちていた（第4バッチレビュー指摘4）。
  const src = read("territory");
  assert.ok(src.includes("api.busy"), "送信中のガードがない");
});
