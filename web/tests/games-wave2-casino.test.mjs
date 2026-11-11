// 第2波（カジノ/タイミング/記憶系）4本のロジック検証（lib のみ、UI 非依存）。
// - lib/blackjack.ts: 配布・配当 3:2・ディーラー17スタンド・バースト・ダブル・プッシュ
// - lib/stacker.ts: 前進/反転・切り落とし・重なり無しで終了
// - lib/colormatch.ts: 問題生成の整合・スコア/コンボ
// - lib/numbermemory.ts: 数字生成・判定・桁進行
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const libDir = path.join(import.meta.dirname, "..", "lib");

async function loadLib(name) {
  const src = fs.readFileSync(path.join(libDir, name), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

const bj = await loadLib("blackjack.ts");
const st = await loadLib("stacker.ts");
const cm = await loadLib("colormatch.ts");
const nm = await loadLib("numbermemory.ts");

const C = (rank, suit = "spade") => ({ suit, rank });

/** 山札の先頭を指定カードに差し替えたゲーム状態を作る（配布順: 自分, D, 自分, D, 以降は引く順）。 */
function riggedGame(topCards, chips = 1000) {
  const base = bj.createBlackjackGame(7, chips);
  const rest = base.deck.filter(
    (c) => !topCards.some((t) => t.rank === c.rank && t.suit === c.suit),
  );
  return { ...base, deck: [...topCards, ...rest] };
}

// ---- blackjack ----

test("ブラックジャック: デッキは52枚すべて異なる", () => {
  const deck = bj.createDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map((c) => `${c.suit}-${c.rank}`)).size, 52);
});

test("ブラックジャック: A は合計が21を超えない範囲で11になる", () => {
  assert.deepEqual(bj.handValue([C(1), C(9)]), { total: 20, soft: true });
  assert.deepEqual(bj.handValue([C(1), C(9), C(5)]), { total: 15, soft: false });
  assert.deepEqual(bj.handValue([C(1), C(1, "heart")]), { total: 12, soft: true });
  assert.equal(bj.handValue([C(11), C(12, "heart")]).total, 20);
});

test("ブラックジャック: 同じシードでは同じ山札になる", () => {
  const a = bj.createBlackjackGame(42);
  const b = bj.createBlackjackGame(42);
  assert.deepEqual(a.deck, b.deck);
});

test("ブラックジャック: ベットすると2枚ずつ配られ、ベット分が差し引かれる", () => {
  let s = bj.createBlackjackGame(3, 1000);
  s = bj.startRound(s, 100);
  // ナチュラルで即決着するシードを避けるため、決着していなければ player フェーズ
  if (s.phase === "player") {
    assert.equal(s.playerHand.length, 2);
    assert.equal(s.dealerHand.length, 2);
    assert.equal(s.chips, 900);
    assert.equal(s.bet, 100);
  } else {
    assert.equal(s.phase, "settled");
  }
});

test("ブラックジャック: 範囲外ベットは無効", () => {
  const s = bj.createBlackjackGame(3, 100);
  assert.equal(bj.startRound(s, 0), s);
  assert.equal(bj.startRound(s, 5), s); // 最低ベット未満
  assert.equal(bj.startRound(s, 500), s); // 所持超過
});

test("ブラックジャック: 自分のブラックジャックは 3:2 で払われる", () => {
  const s0 = riggedGame([C(1), C(9, "heart"), C(13), C(7, "heart")]);
  const s = bj.startRound(s0, 100);
  assert.equal(s.phase, "settled");
  assert.equal(s.result.outcome, "blackjack");
  assert.equal(s.result.delta, 150);
  assert.equal(s.chips, 1150);
});

test("ブラックジャック: 両方ブラックジャックはプッシュ", () => {
  const s0 = riggedGame([C(1), C(1, "heart"), C(13), C(12, "heart")]);
  const s = bj.startRound(s0, 100);
  assert.equal(s.result.outcome, "push");
  assert.equal(s.chips, 1000);
});

test("ブラックジャック: ディーラーのブラックジャックは負け", () => {
  const s0 = riggedGame([C(9), C(1, "heart"), C(7), C(13, "heart")]);
  const s = bj.startRound(s0, 100);
  assert.equal(s.result.outcome, "dealer_blackjack");
  assert.equal(s.chips, 900);
});

test("ブラックジャック: ヒットでバーストすると負け", () => {
  const s0 = riggedGame([C(10), C(9, "heart"), C(6), C(7, "heart"), C(10, "diamond")]);
  let s = bj.startRound(s0, 100);
  assert.equal(s.phase, "player");
  assert.equal(bj.handValue(s.playerHand).total, 16);
  s = bj.hit(s);
  assert.equal(s.phase, "settled");
  assert.equal(s.result.outcome, "bust");
  assert.equal(s.chips, 900);
});

test("ブラックジャック: ディーラーはソフト17でスタンドする", () => {
  // 自分 18 vs ディーラー A+6（ソフト17）。次カードは5で、引けば12→さらに引く展開になるため、
  // 「引かない」ことを手札枚数で直接確認する。
  const s0 = riggedGame([C(10), C(1, "heart"), C(8), C(6, "heart"), C(5, "diamond"), C(10, "club")]);
  let s = bj.startRound(s0, 100);
  assert.equal(bj.handValue(s.dealerHand).total, 17);
  s = bj.stand(s);
  assert.equal(s.dealerHand.length, 2);
  assert.equal(s.result.outcome, "win"); // 18 > 17
  assert.equal(s.chips, 1100);
});

test("ブラックジャック: ディーラーは16以下で引き、バーストすることもある", () => {
  const s0 = riggedGame([C(10), C(9, "heart"), C(8), C(6, "heart"), C(10, "diamond")]);
  let s = bj.startRound(s0, 100);
  s = bj.stand(s);
  assert.equal(s.dealerHand.length, 3);
  assert.equal(s.result.outcome, "win"); // ディーラー 25 バースト
});

test("ブラックジャック: 同点はプッシュで賭け金が戻る", () => {
  const s0 = riggedGame([C(10), C(10, "heart"), C(8), C(8, "heart")]);
  let s = bj.startRound(s0, 100);
  s = bj.stand(s);
  assert.equal(s.result.outcome, "push");
  assert.equal(s.chips, 1000);
});

test("ブラックジャック: ダブルダウンは賭け金を倍にして1枚だけ引く", () => {
  const s0 = riggedGame([C(5), C(10, "heart"), C(6), C(7, "heart"), C(10, "diamond")]);
  let s = bj.startRound(s0, 100);
  assert.equal(bj.canDouble(s), true);
  s = bj.doubleDown(s);
  assert.equal(s.bet, 200);
  assert.equal(s.playerHand.length, 3);
  assert.equal(bj.handValue(s.playerHand).total, 21);
  assert.equal(s.result.outcome, "win"); // ディーラー17に勝利
  assert.equal(s.chips, 1200); // 1000 - 100 - 100 + 400
});

test("ブラックジャック: チップ不足ではダブルできない", () => {
  const s0 = riggedGame([C(5), C(10, "heart"), C(6), C(7, "heart"), C(2, "diamond")], 150);
  const s = bj.startRound(s0, 100);
  assert.equal(s.chips, 50);
  assert.equal(bj.canDouble(s), false);
  assert.equal(bj.doubleDown(s), s);
});

test("ブラックジャック: 破産後の次ラウンドでチップが再支給される", () => {
  let s = riggedGame([C(9), C(1, "heart"), C(7), C(13, "heart")], 100);
  s = bj.startRound(s, 100);
  assert.equal(s.chips, 0);
  s = bj.nextRound(s);
  assert.equal(s.chips, bj.BJ_INITIAL_CHIPS);
  assert.equal(s.phase, "betting");
});

// ---- stacker ----

test("スタッカー: 初期状態は幅3のブロックが左端にある", () => {
  const s = st.createStackerGame();
  assert.equal(s.boardWidth, 7);
  assert.equal(s.currentWidth, 3);
  assert.equal(s.currentStart, 0);
  assert.equal(s.rows.length, 0);
  assert.equal(s.status, "playing");
});

test("スタッカー: 前進と端での反転", () => {
  let s = st.createStackerGame(7, 3);
  s = st.advanceStacker(s);
  assert.equal(s.currentStart, 1);
  // 右端（max start = 4）まで進めて反転する
  for (let i = 0; i < 3; i++) s = st.advanceStacker(s);
  assert.equal(s.currentStart, 4);
  s = st.advanceStacker(s);
  assert.equal(s.currentStart, 3);
  assert.equal(s.dir, -1);
});

test("スタッカー: 1段目はどこに落としても幅そのまま積まれる", () => {
  let s = st.createStackerGame();
  s = st.advanceStacker(st.advanceStacker(s)); // start=2
  s = st.dropStacker(s);
  assert.equal(s.score, 1);
  assert.deepEqual(s.rows[0], { start: 2, width: 3 });
  assert.equal(s.currentWidth, 3);
});

test("スタッカー: はみ出しは切り落とされる", () => {
  let s = st.createStackerGame();
  s = st.dropStacker(s); // 1段目 start=0 width=3
  for (let i = 0; i < 2; i++) s = st.advanceStacker(s); // start=2
  s = st.dropStacker(s);
  assert.deepEqual(s.rows[1], { start: 2, width: 1 }); // 重なりは [2,3)
  assert.equal(s.currentWidth, 1);
  assert.equal(s.score, 2);
});

test("スタッカー: ちょうど重なるとパーフェクトになる", () => {
  let s = st.createStackerGame();
  s = st.dropStacker(s);
  s = st.dropStacker(s); // start=0 のまま同位置
  assert.equal(s.lastPerfect, true);
  assert.equal(s.perfects, 1);
  assert.equal(s.rows[1].width, 3);
});

test("スタッカー: 重なりが無ければゲームオーバー", () => {
  let s = st.createStackerGame();
  s = st.dropStacker(s); // 1段目 [0,3)
  for (let i = 0; i < 4; i++) s = st.advanceStacker(s); // start=4 → [4,7)
  s = st.dropStacker(s);
  assert.equal(s.status, "gameover");
  assert.equal(s.score, 1);
  // 終了後は操作できない
  assert.equal(st.dropStacker(s), s);
  assert.equal(st.advanceStacker(s), s);
});

test("スタッカー: 段数が増えると間隔が短くなり下限がある", () => {
  assert.ok(st.stackerIntervalMs(10) < st.stackerIntervalMs(0));
  assert.equal(st.stackerIntervalMs(1000), 70);
});

// ---- colormatch ----

test("色文字マッチ: 問題の match フラグは語とインクの一致と整合する", () => {
  let s = cm.createColorMatchGame(11);
  for (let i = 0; i < 40; i++) {
    const q = s.question;
    assert.equal(q.match, q.wordIndex === q.inkIndex);
    assert.ok(q.wordIndex >= 0 && q.wordIndex < cm.CM_COLORS.length);
    assert.ok(q.inkIndex >= 0 && q.inkIndex < cm.CM_COLORS.length);
    s = cm.answerColorMatch(s, q.match); // 常に正解を答えて進める
  }
  assert.equal(s.answered, 40);
  assert.equal(s.correct, 40);
});

test("色文字マッチ: 同じシードでは同じ問題列になる", () => {
  let a = cm.createColorMatchGame(99);
  let b = cm.createColorMatchGame(99);
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(a.question, b.question);
    a = cm.answerColorMatch(a, true);
    b = cm.answerColorMatch(b, true);
  }
});

test("色文字マッチ: 一致と不一致の両方が出る", () => {
  let s = cm.createColorMatchGame(5);
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    seen.add(s.question.match);
    s = cm.answerColorMatch(s, true);
  }
  assert.deepEqual([...seen].sort(), [false, true]);
});

test("色文字マッチ: 正解でスコアとコンボが伸び、不正解でコンボが切れる", () => {
  let s = cm.createColorMatchGame(21);
  s = cm.answerColorMatch(s, s.question.match);
  assert.equal(s.score, cm.scoreForCombo(0));
  assert.equal(s.combo, 1);
  s = cm.answerColorMatch(s, s.question.match);
  assert.equal(s.score, cm.scoreForCombo(0) + cm.scoreForCombo(1));
  assert.equal(s.combo, 2);
  assert.equal(s.maxCombo, 2);
  const before = s.score;
  s = cm.answerColorMatch(s, !s.question.match);
  assert.equal(s.combo, 0);
  assert.equal(s.score, before);
  assert.equal(s.lastCorrect, false);
  assert.equal(s.correct, 2);
  assert.equal(s.answered, 3);
});

// ---- numbermemory ----

test("数字記憶: 生成される数字は桁数どおりで先頭が0にならない", () => {
  let s = nm.createNumberMemoryGame(13);
  assert.equal(s.digits, 3);
  assert.equal(s.number.length, 3);
  assert.notEqual(s.number[0], "0");
  // 正解を続けて桁が増えても性質が保たれる
  for (let i = 0; i < 5; i++) {
    const r = nm.submitNumberAnswer(s, s.number);
    assert.equal(r.correct, true);
    s = r.state;
    assert.equal(s.number.length, s.digits);
    assert.notEqual(s.number[0], "0");
    assert.ok(/^[0-9]+$/.test(s.number));
  }
  assert.equal(s.digits, 8);
  assert.equal(s.bestDigits, 7);
  assert.equal(s.cleared, 5);
});

test("数字記憶: 同じシードでは同じ数字列になる", () => {
  let a = nm.createNumberMemoryGame(77);
  let b = nm.createNumberMemoryGame(77);
  for (let i = 0; i < 4; i++) {
    assert.equal(a.number, b.number);
    a = nm.submitNumberAnswer(a, a.number).state;
    b = nm.submitNumberAnswer(b, b.number).state;
  }
});

test("数字記憶: 不正解で終了し、それ以降の回答は受け付けない", () => {
  const s = nm.createNumberMemoryGame(31);
  const wrong = s.number === "999" ? "111" : "999";
  const r = nm.submitNumberAnswer(s, wrong);
  assert.equal(r.correct, false);
  assert.equal(r.state.status, "failed");
  const again = nm.submitNumberAnswer(r.state, r.state.number);
  assert.equal(again.correct, false);
  assert.equal(again.state, r.state);
});

test("数字記憶: 空文字や数字以外は不正解扱い", () => {
  const s = nm.createNumberMemoryGame(3);
  assert.equal(nm.isValidNumberInput(""), false);
  assert.equal(nm.isValidNumberInput("12a"), false);
  assert.equal(nm.isValidNumberInput(null), false);
  assert.equal(nm.isValidNumberInput("123"), true);
  assert.equal(nm.submitNumberAnswer(s, "").correct, false);
});

test("数字記憶: 表示時間は桁数とともに長くなる", () => {
  assert.ok(nm.showDurationMs(10) > nm.showDurationMs(3));
});
