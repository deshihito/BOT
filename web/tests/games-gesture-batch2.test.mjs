// 第2バッチ ジェスチャ移行（2026-11-14 ユーザー裁定）の回帰テスト。
// - 対象ゲームのクライアントに実行ボタンが残っていないこと（静的検査）
// dicequest / yahtzee の「もう一度」はゲーム外 chrome
// （リセット操作）として例外リスト入り済みのため、上限件数だけを固定する。
// - reaction は計測の遅延を避けるため lib/gesture ではなく
//   onPointerDown 直結のタップ面（計測開始・停止が pointerdown で発火すること）。
// （対象は当初8ゲーム。2026-11-15 のカタログ削減で sugoroku / montecarlo /
// baccarat / drawpoker / stopwatch を削除したため残り3ゲームが対象。）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const webDir = path.join(import.meta.dirname, "..");

const CLIENTS = {
  dicequest: "DiceQuestClient.tsx",
  yahtzee: "YahtzeeClient.tsx",
  reaction: "ReactionClient.tsx",
};
// 例外リスト（ゲーム外 chrome のリセットボタン）以外は 0 件であること。
const BUTTON_BUDGET = { dicequest: 1, yahtzee: 1, reaction: 0 };

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
  for (const game of ["dicequest", "yahtzee"]) {
    const src = read(game);
    const buttons = src.match(/<button[\s\S]*?<\/button>/g) ?? [];
    assert.equal(buttons.length, 1, `${game}: 残りボタンが ${buttons.length} 件`);
    assert.ok(buttons[0].includes("もう一度"), `${game}: 残りボタンがリセット操作ではない`);
    assert.ok(buttons[0].includes("onClick={restart}"), `${game}: 残りボタンが restart に繋がっていない`);
  }
});

test("gesture batch2: ジェスチャ系2ゲームは共通ヘルパー lib/gesture を使う", () => {
  for (const game of ["dicequest", "yahtzee"]) {
    const src = read(game);
    assert.ok(src.includes('from "@/lib/gesture"'), `${game}: lib/gesture を import していない`);
    assert.ok(src.includes("useGesture"), `${game}: useGesture を使っていない`);
  }
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
  const dicequest = read("dicequest");
  // 空の置き場とダイス表示中の置き場の2面とも none であること。
  assert.equal((dicequest.match(/touchAction: "none"/g) ?? []).length, 2, "dicequest のダイス置き場2面に touchAction none がない");
});

