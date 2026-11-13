// 第2バッチ ジェスチャ移行（2026-11-14 ユーザー裁定）の回帰テスト。
// - 対象8ゲームのクライアントに実行ボタンが残っていないこと（静的検査）
// dicequest / yahtzee / sugoroku / montecarlo の「もう一度」はゲーム外 chrome
// （リセット操作）として例外リスト入り済みのため、上限件数だけを固定する。
// - reaction / stopwatch は計測の遅延を避けるため lib/gesture ではなく
//   onPointerDown 直結のタップ面（計測開始・停止が pointerdown で発火すること）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const webDir = path.join(import.meta.dirname, "..");

const CLIENTS = {
  dicequest: "DiceQuestClient.tsx",
  yahtzee: "YahtzeeClient.tsx",
  sugoroku: "SugorokuClient.tsx",
  baccarat: "BaccaratClient.tsx",
  drawpoker: "DrawPokerClient.tsx",
  reaction: "ReactionClient.tsx",
  stopwatch: "StopwatchClient.tsx",
  montecarlo: "MonteCarloClient.tsx",
};
// 例外リスト（ゲーム外 chrome のリセットボタン）以外は 0 件であること。
const BUTTON_BUDGET = { dicequest: 1, yahtzee: 1, sugoroku: 1, baccarat: 0, drawpoker: 0, reaction: 0, stopwatch: 0, montecarlo: 1 };

function read(game) {
  return fs.readFileSync(path.join(webDir, "app", "games", game, CLIENTS[game]), "utf8");
}

for (const [game, file] of Object.entries(CLIENTS)) {
  test(`gesture batch2: ${game} の実行ボタン廃止（<button> <= ${BUTTON_BUDGET[game]}）`, () => {
    const src = read(game);
    const count = (src.match(/<button/g) ?? []).length;
    assert.ok(count <= BUTTON_BUDGET[game], `${game}: <button> が ${count} 件残っている`);
  });
}

test("gesture batch2: 残りボタンは chrome のリセット操作「もう一度」だけ", () => {
  for (const game of ["dicequest", "yahtzee", "sugoroku", "montecarlo"]) {
    const src = read(game);
    const buttons = src.match(/<button[\s\S]*?<\/button>/g) ?? [];
    assert.equal(buttons.length, 1, `${game}: 残りボタンが ${buttons.length} 件`);
    assert.ok(buttons[0].includes("もう一度"), `${game}: 残りボタンがリセット操作ではない`);
    assert.ok(buttons[0].includes("onClick={restart}"), `${game}: 残りボタンが restart に繋がっていない`);
  }
});

test("gesture batch2: ジェスチャ系6ゲームは共通ヘルパー lib/gesture を使う", () => {
  for (const game of ["dicequest", "yahtzee", "sugoroku", "baccarat", "drawpoker", "montecarlo"]) {
    const src = read(game);
    assert.ok(src.includes('from "@/lib/gesture"'), `${game}: lib/gesture を import していない`);
    assert.ok(src.includes("useGesture"), `${game}: useGesture を使っていない`);
  }
});

test("gesture batch2: baccarat はテーブルタップで配る・次ラウンド・再支給", () => {
  const src = read("baccarat");
  assert.ok(src.includes("tableGesture"), "テーブル面に useGesture が繋がっていない");
  assert.ok(src.includes("placeBaccaratBet(s, betKind, amount)"), "配るアクションへの接続が壊れている");
  assert.ok(src.includes("nextBaccaratRound(s)"), "次のラウンドへの接続が壊れている");
  assert.ok(src.includes("refillBaccarat(s)"), "再支給への接続が壊れている");
  assert.ok(src.includes("tappableProps"), "賭け先・賭け金の選択が対象物タップになっていない");
});

test("gesture batch2: drawpoker は置き場タップで配る・下スワイプで交換確定", () => {
  const src = read("drawpoker");
  assert.ok(src.includes("rowGesture"), "カード置き場に useGesture が繋がっていない");
  assert.ok(src.includes("startRound(state, bet)"), "配るアクションへの接続が壊れている");
  assert.ok(src.includes("drawCards(s, discards)"), "交換確定への接続が壊れている");
  assert.ok(src.includes("refillDpChips(s)"), "再支給への接続が壊れている");
  assert.ok(src.includes('dir === "down"'), "交換確定が下スワイプになっていない");
  assert.ok(src.includes("toggleDiscard(i)"), "札の交換選択への接続が壊れている");
});

test("gesture batch2: montecarlo は札タップで選択・盤面下スワイプで詰める", () => {
  const src = read("montecarlo");
  assert.ok(src.includes("boardGesture"), "盤面に useGesture が繋がっていない");
  assert.ok(src.includes("montecarloRemovePair(s, selected, index)"), "ペア除去への接続が壊れている");
  assert.ok(src.includes("montecarloConsolidate(s)"), "詰めるへの接続が壊れている");
  assert.ok(src.includes('dir === "down"'), "詰めるが下スワイプになっていない");
  assert.ok(src.includes('role="gridcell"'), "札が gridcell のタップ対象になっていない");
});

test("gesture batch2: sugoroku の盤面はキーボードでもサイコロを振れる", () => {
  const src = read("sugoroku");
  assert.ok(src.includes('role="button"'), "盤面がタップ対象の role になっていない");
  assert.ok(src.includes("rollDice(s)"), "サイコロを振るアクションへの接続が壊れている");
});

test("gesture batch2: reaction は pointerdown 直結のタップ面で計測する", () => {
  const src = read("reaction");
  assert.ok(!src.includes("<button"), "reaction に button が残っている");
  assert.ok(src.includes('role="button"'), "計測エリアがタップ面になっていない");
  assert.ok(src.includes("onPointerDown"), "計測が pointerdown 直結になっていない");
  assert.ok(src.includes("handleTap()"), "タップが計測ハンドラに繋がっていない");
  assert.ok(src.includes("recordTap(cur, ms)"), "計測結果の記録への接続が壊れている");
});

test("gesture batch2 (review): reaction の Space は window リスナー1経路のみ（二重発火防止）", () => {
  const src = read("reaction");
  // 計測エリアの onKeyDown が Space も受けると、window の Space リスナーと
  // 合わせて handleTap が1回のキーで2回走る（開始直後のフライング／最終回で結果画面を飛ばす）。
  // エリア側は Enter のみ、Space は window リスナー（e.code !== "Space"）が受ける。
  assert.equal((src.match(/e\.key === " "/g) ?? []).length, 0, "計測エリアの onKeyDown が Space を受けている");
  assert.ok(src.includes('e.code !== "Space"'), "Space を受ける window リスナーがない");
});

test("gesture batch2 (review): ジェスチャ面は touchAction none でフリックがスクロールに奪われない", () => {
  const sugoroku = read("sugoroku");
  assert.ok(sugoroku.includes('touchAction: "none"'), "sugoroku の盤面に touchAction none がない");
  const dicequest = read("dicequest");
  // 空の置き場とダイス表示中の置き場の2面とも none であること。
  assert.equal((dicequest.match(/touchAction: "none"/g) ?? []).length, 2, "dicequest のダイス置き場2面に touchAction none がない");
});

test("gesture batch2: stopwatch は pointerdown 直結の時計タップ面で開始・停止する", () => {
  const src = read("stopwatch");
  assert.ok(!src.includes("<button"), "stopwatch に button が残っている");
  assert.ok(src.includes('role="button"'), "時計がタップ面になっていない");
  assert.ok(src.includes("onPointerDown"), "開始・停止が pointerdown 直結になっていない");
  assert.ok(src.includes('if (phase === "running") stop(); else start();'), "タップが開始・停止に繋がっていない");
});
