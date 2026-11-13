// 第1バッチ ジェスチャ移行（2026-11-13 ユーザー裁定）の回帰テスト。
// - 共通ヘルパー lib/gesture.ts のスワイプ判定（純粋関数）
// - 対象8ゲームのクライアントに実行ボタンが残っていないこと（静的検査）
// diceroll の「もう一度/最初から」と chinchiro の「もう一度」はゲーム外 chrome
// （リセット操作）として例外リスト入り済みのため、上限件数だけを固定する。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const webDir = path.join(import.meta.dirname, "..");

function loadGesture() {
  const src = fs.readFileSync(path.join(webDir, "lib", "gesture.ts"), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const body = js
    .split("\n")
    .filter((line) => !/^import\s/.test(line))
    .map((line) =>
      line
        .replace(/^export\s+(?=(const|let|var|function|class)\s)/, "")
        .replace(/^export\s+(?=async\s+function)/, "")
        .replace(/^export\s*\{[^}]*\};?\s*$/, ""),
    )
    .join("\n");
  const code = body + "\nexport { swipeDirection };\n";
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const { swipeDirection } = await loadGesture();

test("gesture: スワイプ方向の判定（優勢軸・閾値）", () => {
  assert.equal(swipeDirection(40, 5), "right");
  assert.equal(swipeDirection(-40, 5), "left");
  assert.equal(swipeDirection(5, 40), "down");
  assert.equal(swipeDirection(5, -40), "up");
  assert.equal(swipeDirection(10, 10), null); // 閾値未満はタップ
  assert.equal(swipeDirection(0, 0), null);
  assert.equal(swipeDirection(15, 0, 10), "right"); // 閾値指定
  assert.equal(swipeDirection(30, 29), "right"); // 優勢軸が勝つ
  assert.equal(swipeDirection(29, 30), "down");
});

const CLIENTS = {
  snake: "SnakeClient.tsx",
  blackjack: "BlackjackClient.tsx",
  slot: "SlotClient.tsx",
  highlow: "HighLowClient.tsx",
  diceroll: "DiceRollClient.tsx",
  chinchiro: "ChinchiroClient.tsx",
  roulette: "RouletteClient.tsx",
  janken: "JankenClient.tsx",
};
// 例外リスト（ゲーム外 chrome のリセットボタン）以外は 0 件であること。
const BUTTON_BUDGET = { snake: 0, blackjack: 0, slot: 0, highlow: 0, diceroll: 2, chinchiro: 1, roulette: 0, janken: 0 };

for (const [game, file] of Object.entries(CLIENTS)) {
  test(`gesture batch1: ${game} の実行ボタン廃止（<button> <= ${BUTTON_BUDGET[game]}）`, () => {
    const src = fs.readFileSync(path.join(webDir, "app", "games", game, file), "utf8");
    const count = (src.match(/<button/g) ?? []).length;
    assert.ok(count <= BUTTON_BUDGET[game], `${game}: <button> が ${count} 件残っている`);
  });
}

test("gesture batch1: スワイプ系7ゲームは共通ヘルパー lib/gesture を使う", () => {
  for (const game of ["snake", "blackjack", "slot", "highlow", "diceroll", "chinchiro", "roulette"]) {
    const src = fs.readFileSync(path.join(webDir, "app", "games", game, CLIENTS[game]), "utf8");
    assert.ok(src.includes('from "@/lib/gesture"'), `${game}: lib/gesture を import していない`);
    assert.ok(src.includes("useGesture"), `${game}: useGesture を使っていない`);
  }
});

test("gesture batch1: janken の手は button でなく手カード（div role=button）のタップ", () => {
  const src = fs.readFileSync(path.join(webDir, "app", "games", "janken", CLIENTS.janken), "utf8");
  assert.ok(!src.includes("<button"), "janken に button が残っている");
  assert.ok(src.includes('role="button"'), "手カードが対象物タップになっていない");
  assert.ok(src.includes('api.move({ type: "throw", hand })'), "提出アクションへの接続が壊れている");
});
