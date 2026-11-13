// BALKU ジェスチャ一本化の回帰（2026-11-13 ユーザー裁定）。
// 「タップ/スワイプでできるようにするならボタンは全廃すべき」に従い、
// 対戦中のゲームアクション用ボタンが残っていないことと、全 GameAction が
// ジェスチャ経路から到達できることを、クライアント実装の静的検査で固定する。
// エンジン側の各アクションの正しさ自体は balku.test.mjs が検証している。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const client = fs.readFileSync(path.join(import.meta.dirname, "..", "app", "games", "balku", "BalkuClient.tsx"), "utf8");
const css = fs.readFileSync(path.join(import.meta.dirname, "..", "app", "globals.css"), "utf8");

// 対戦画面は最後の return（対戦画面コメント以降）
const gameScreen = client.slice(client.indexOf("対戦画面 ---"));

test("対戦画面にゲームアクション用ボタン（balku-btn）が残っていない", () => {
  // 退出だけは対戦外の chrome として許可し、それを除いて検査する。
  // 手札ファンのカード自体（balku-card / balku-matgroup）はタップする
  // 「物」なので button 要素のままでよい（ファンより前には置かない）。
  const stripped = gameScreen.replace(/<button[^>]*balku-leave[\s\S]*?<\/button>/, "");
  assert.ok(!stripped.includes("balku-btn"), "対戦画面に balku-btn が残っている");
  const beforeFan = stripped.slice(0, stripped.indexOf("balku-fan"));
  assert.ok(!beforeFan.includes("<button"), "ファンより前に button 要素が残っている");
});

test("廃止した操作部品がクライアントに残っていない", () => {
  // ※ aria-label 上の「公開で提出」等は支援技術向けの名前付けであり、可視ボタンではないので対象外
  for (const gone of ["sellMode", "売却モード", "パスする", "renderBulkButtons", "balku-target-chip", "confirmKey", "まとめて売却", "balku-stepper", "選択をやめる"]) {
    assert.ok(!client.includes(gone), `${gone} が残っている`);
  }
});

test("全 GameAction がジェスチャ経路から到達できる", () => {
  // submit: 組んだ束を提出パッド（公開/伏せ）へ放つ
  assert.ok(client.includes('source: "bundle"'));
  assert.ok(client.includes('"submit-open"') && client.includes('"submit-down"'));
  assert.ok(client.includes("submitSelected(zone === \"submit-open\")"));
  // buyMaterial: 市場の素材を自分の領域へ
  assert.ok(client.includes('source: "market-material"'));
  assert.ok(client.includes('type: "buyMaterial"'));
  // sellCards: 売却ポケットへ
  assert.ok(client.includes('type: "sellCards"'));
  assert.ok(client.includes('data-drop="sell"'));
  // bid: コインオブジェクトを出品物へ
  assert.ok(client.includes('source: "bid-coin"'));
  assert.ok(client.includes('type: "bid"'));
  // bulkCall: 相手の束を引き寄せる
  assert.ok(client.includes('source: "opponent-bundle"'));
  assert.ok(client.includes('type: "bulkCall"'));
  // forceBulk: 権利オブジェクトを相手の束へ
  assert.ok(client.includes('source: "force-charge"'));
  assert.ok(client.includes('type: "forceBulk"'));
  assert.ok(client.includes("data-bulk-target"));
  // endTurn: 手番トークンを席へ放つ
  assert.ok(client.includes('source: "turn-token"'));
  assert.ok(client.includes('type: "endTurn"'));
});

test("フリック解決とファンの横スワイプが配線されている", () => {
  assert.ok(client.includes("flickZone"));
  assert.ok(client.includes('track.mode = "fan"'));
  assert.ok(client.includes("scrollLeft"));
  assert.ok(css.includes(".balku-fan { touch-action:pan-y; }"));
  assert.ok(css.includes(".balku-draggable { touch-action:none;"));
});

test("感触: フリップ開示・タイマーバー・素材SVG・コインポップがある", () => {
  assert.ok(client.includes("balku-bundle-flip"));
  assert.ok(client.includes("setRevealCard"));
  assert.ok(client.includes("function TimerBar"));
  assert.ok(client.includes("function MatIcon"));
  assert.ok(client.includes("balku-coin-pop"));
  assert.ok(client.includes("function CountUp"));
  assert.ok(css.includes("@keyframes balku-flip"));
  assert.ok(css.includes("@keyframes balku-confetti-fall"));
});

test("対戦画面とカタログに絵文字が残っていない", () => {
  assert.ok(!client.includes("🎉"));
  const catalog = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "games-catalog.ts"), "utf8");
  assert.ok(!catalog.includes("🏗"));
});
