// A4フェーズの新規4本のロジック検証。
// - lib/quiz.ts: 出題決定性・選択肢シャッフルの正解追跡・採点と連続ボーナス
// - lib/numbercode.ts: EAT/BITE 判定・勝敗・回数制限
// - lib/online/games/quizbattle.ts: 得点計算・秘匿ビュー・tick 締切・退出処理
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const webDir = path.join(import.meta.dirname, "..");
const libDir = path.join(webDir, "lib");

async function loadLib(name) {
  const src = fs.readFileSync(path.join(libDir, name), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

function stripModuleSyntax(code) {
  return code
    .split("\n")
    .filter((line) => !/^import\s/.test(line))
    .map((line) =>
      line
        .replace(/^export\s+(?=(const|let|var|function|class)\s)/, "")
        .replace(/^export\s+(?=async\s+function)/, "")
        .replace(/^export\s*\{[^}]*\};?\s*$/, ""),
    )
    .join("\n");
}

async function loadQuizBattle() {
  const src = fs.readFileSync(path.join(libDir, "online", "games", "quizbattle.ts"), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const code = stripModuleSyntax(js) + "\nexport { gameModule, qbScoreFor, QUIZ_BATTLE_QUESTIONS, QB_TOTAL_QUESTIONS, QB_TIME_LIMIT_MS };\n";
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const quiz = await loadLib("quiz.ts");
const nc = await loadLib("numbercode.ts");
const qb = await loadQuizBattle();

// 決定的 rng（LCG）。オンライン基盤の Rng は () => number。
function makeRng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const players2 = () => [
  { seat: 0, name: "先手" },
  { seat: 1, name: "後手" },
];

// ---------------------------------------------------------------- quiz

test("クイズ: 問題バンクは40問以上・全カテゴリ・4択で正解位置が妥当", () => {
  assert.ok(quiz.QUIZ_QUESTIONS.length >= 40);
  const cats = new Set(quiz.QUIZ_QUESTIONS.map((q) => q.category));
  for (const c of ["雑学", "科学", "歴史", "スポーツ", "アニメ・ゲーム"]) assert.ok(cats.has(c), c);
  for (const q of quiz.QUIZ_QUESTIONS) {
    assert.equal(q.choices.length, 4);
    assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4);
    assert.equal(new Set(q.choices).size, 4);
  }
});

test("クイズ: 同じシードでは出題と選択肢の並びが同じになる", () => {
  const a = quiz.createQuizGame(42);
  const b = quiz.createQuizGame(42);
  assert.deepEqual(a.deck, b.deck);
  assert.deepEqual(a.order, b.order);
  assert.equal(a.deck.length, 10);
  assert.equal(new Set(a.order).size, 10);
});

test("クイズ: 選択肢シャッフル後も正解の文字列が追跡できている", () => {
  const s = quiz.createQuizGame(7);
  s.deck.forEach((q, i) => {
    const bank = quiz.QUIZ_QUESTIONS[s.order[i]];
    assert.equal(q.question, bank.question);
    assert.equal(q.choices[q.answer], bank.choices[bank.answer]);
    assert.deepEqual([...q.choices].sort(), [...bank.choices].sort());
  });
});

test("クイズ: 正解で100点＋連続ボーナス、不正解で連続リセット", () => {
  let s = quiz.createQuizGame(3);
  const q0 = quiz.currentQuizQuestion(s);
  s = quiz.answerQuestion(s, q0.answer);
  assert.equal(s.last.gained, 100);
  assert.equal(s.streak, 1);
  s = quiz.nextQuestion(s);
  const q1 = quiz.currentQuizQuestion(s);
  s = quiz.answerQuestion(s, q1.answer);
  assert.equal(s.last.gained, 120);
  assert.equal(s.score, 220);
  s = quiz.nextQuestion(s);
  const q2 = quiz.currentQuizQuestion(s);
  const wrong = (q2.answer + 1) % 4;
  s = quiz.answerQuestion(s, wrong);
  assert.equal(s.last.correct, false);
  assert.equal(s.last.gained, 0);
  assert.equal(s.streak, 0);
  assert.equal(s.score, 220);
});

test("クイズ: 全問正解で finished になり評価とカテゴリ別集計が付く", () => {
  let s = quiz.createQuizGame(11);
  while (s.phase !== "finished") {
    const q = quiz.currentQuizQuestion(s);
    s = quiz.answerQuestion(s, q.answer);
    s = quiz.nextQuestion(s);
  }
  assert.equal(quiz.quizCorrectCount(s), 10);
  assert.equal(s.score, 1700); // 100+120+140+160+180+200*5
  assert.equal(quiz.quizGrade(s).label, "全問正解！");
  const stats = quiz.quizCategoryStats(s);
  assert.equal(stats.reduce((a, x) => a + x.total, 0), 10);
  assert.equal(stats.reduce((a, x) => a + x.correct, 0), 10);
});

test("クイズ: 不正な回答とフェーズ外の操作は同状態を返す", () => {
  const s = quiz.createQuizGame(5);
  assert.equal(quiz.answerQuestion(s, 4), s);
  assert.equal(quiz.answerQuestion(s, -1), s);
  assert.equal(quiz.nextQuestion(s), s);
  const revealed = quiz.answerQuestion(s, 0);
  assert.equal(quiz.answerQuestion(revealed, 1), revealed);
});

// ---------------------------------------------------------------- numbercode

test("ナンバーコード: コードは重複なし3桁で、シード決定的", () => {
  const a = nc.createNumberCodeGame(42);
  const b = nc.createNumberCodeGame(42);
  assert.deepEqual(a.code, b.code);
  assert.equal(a.code.length, 3);
  assert.equal(new Set(a.code).size, 3);
  assert.ok(a.code.every((d) => Number.isInteger(d) && d >= 0 && d <= 9));
});

test("ナンバーコード: EAT/BITE の判定", () => {
  assert.deepEqual(nc.judgeCode([1, 2, 3], [1, 2, 3]), { eat: 3, bite: 0 });
  assert.deepEqual(nc.judgeCode([1, 2, 3], [1, 3, 2]), { eat: 1, bite: 2 });
  assert.deepEqual(nc.judgeCode([1, 2, 3], [3, 2, 1]), { eat: 1, bite: 2 });
  assert.deepEqual(nc.judgeCode([1, 2, 3], [4, 5, 6]), { eat: 0, bite: 0 });
  assert.deepEqual(nc.judgeCode([0, 5, 9], [0, 9, 5]), { eat: 1, bite: 2 });
});

test("ナンバーコード: 正解で勝ち、不正な推測は受理されない", () => {
  let s = nc.createNumberCodeGame(9);
  assert.equal(nc.submitNcGuess(s, [1, 1, 2]), s);
  assert.equal(nc.submitNcGuess(s, [1, 2]), s);
  assert.equal(nc.submitNcGuess(s, [1, 2, 10]), s);
  s = nc.submitNcGuess(s, s.code);
  assert.equal(s.status, "won");
  assert.equal(s.guesses[s.guesses.length - 1].eat, 3);
  assert.equal(nc.submitNcGuess(s, [0, 1, 2]), s);
});

test("ナンバーコード: 10回外すと負けになり残り回数が0になる", () => {
  let s = nc.createNumberCodeGame(9);
  // コードと1桁も重ならない推測は存在しない場合があるため、重ならない桁集合から作る。
  const rest = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => !s.code.includes(d));
  const wrong = rest.slice(0, 3);
  for (let i = 0; i < 10; i++) s = nc.submitNcGuess(s, wrong);
  assert.equal(s.status, "lost");
  assert.equal(nc.ncRemainingTries(s), 0);
  assert.equal(nc.submitNcGuess(s, wrong), s);
});

// ---------------------------------------------------------------- quizbattle

test("クイズバトル: 得点は100＋残り秒×2（切り捨て・下限あり）", () => {
  assert.equal(qb.qbScoreFor(15000), 130);
  assert.equal(qb.qbScoreFor(14999), 128);
  assert.equal(qb.qbScoreFor(1000), 102);
  assert.equal(qb.qbScoreFor(0), 100);
  assert.equal(qb.qbScoreFor(-500), 100);
});

test("クイズバトル: 作成は2〜4人・8問・シード決定的", () => {
  const m = qb.gameModule;
  const a = m.createState(players2(), makeRng(42), {});
  const b = m.createState(players2(), makeRng(42), {});
  assert.equal(a.questions.length, qb.QB_TOTAL_QUESTIONS);
  assert.deepEqual(
    a.questions.map((q) => q.question),
    b.questions.map((q) => q.question),
  );
  assert.equal(a.phase, "question");
  assert.throws(() => m.createState([{ seat: 0, name: "x" }], makeRng(), {}));
  assert.throws(() =>
    m.createState([0, 1, 2, 3, 4].map((seat) => ({ seat, name: `p${seat}` })), makeRng(), {}),
  );
});

test("クイズバトル: 回答は締切まで秘匿され、締切後に開示される", () => {
  const m = qb.gameModule;
  let s = m.createState(players2(), makeRng(42), {});
  const correct = s.questions[0].answer;
  const wrong = (correct + 1) % 4;
  s = m.applyAction(s, 0, { type: "answer", choice: correct }, makeRng());
  // まだ締め切られていない: 相手のビューに回答内容が出ない。
  assert.equal(s.phase, "question");
  const viewB = m.viewFor(s, 1);
  const entryA = viewB.players.find((p) => p.seat === 0);
  assert.equal(entryA.answered, true);
  assert.ok(!("choice" in entryA), "締切前に choice が漏れている");
  assert.equal(viewB.you.yourChoice, null);
  assert.equal(viewB.correctChoice, null);
  assert.ok(!("answer" in viewB.question));
  // 自分のビューでは自分の回答が見える。
  assert.equal(m.viewFor(s, 0).you.yourChoice, correct);
  // 重複回答は不可。
  assert.throws(() => m.applyAction(s, 0, { type: "answer", choice: wrong }, makeRng()));
  // 全員回答で即締切・採点。
  s = m.applyAction(s, 1, { type: "answer", choice: wrong }, makeRng());
  assert.equal(s.phase, "reveal");
  assert.equal(s.history.length, 1);
  const gained = s.scores[0];
  assert.ok(gained >= 128 && gained <= 130, `早押し得点 ${gained}`);
  assert.equal(s.scores[1], 0);
  const viewAfter = m.viewFor(s, 1);
  assert.equal(viewAfter.correctChoice, correct);
  assert.equal(viewAfter.players.find((p) => p.seat === 0).choice, correct);
  assert.equal(viewAfter.players.find((p) => p.seat === 1).gained, 0);
});

test("クイズバトル: tick で制限時間締切と次問への進行が起きる", () => {
  const m = qb.gameModule;
  let s = m.createState(players2(), makeRng(42), {});
  const before = s;
  assert.equal(m.tick(s, Date.now()), before); // 変化なしは同一参照
  s = m.tick(s, Date.now() + 20000);
  assert.equal(s.phase, "reveal");
  assert.equal(s.history.length, 1);
  assert.ok(s.history[0].results.every((r) => r.choice === null && r.gained === 0));
  assert.equal(s.scores[0], 0);
  const revealEnd = s.revealEndsAt;
  s = m.tick(s, revealEnd + 1);
  assert.equal(s.phase, "question");
  assert.equal(s.index, 1);
});

test("クイズバトル: tick を繰り返すと8問で終了し順位が付く", () => {
  const m = qb.gameModule;
  let s = m.createState(players2(), makeRng(42), {});
  let now = Date.now();
  for (let i = 0; i < 60 && !m.isFinished(s); i++) {
    now += 20000;
    s = m.tick(s, now);
  }
  assert.equal(s.phase, "finished");
  assert.equal(s.history.length, 8);
  const view = m.viewFor(s, 0);
  assert.ok(Array.isArray(view.standings));
  assert.equal(view.standings.length, 2);
  assert.ok(view.standings.every((x) => x.rank >= 1));
});

test("クイズバトル: 退出者は脱落し、残り全員が回答済みなら締め切る", () => {
  const m = qb.gameModule;
  const players3 = [0, 1, 2].map((seat) => ({ seat, name: `p${seat}` }));
  let s = m.createState(players3, makeRng(7), {});
  const correct = s.questions[0].answer;
  s = m.applyAction(s, 0, { type: "answer", choice: correct }, makeRng());
  s = m.applyAction(s, 1, { type: "answer", choice: correct }, makeRng());
  assert.equal(s.phase, "question"); // 3人目は未回答
  s = m.onPlayerLeft(s, 2);
  assert.ok(s.leftSeats.includes(2));
  assert.equal(s.phase, "reveal"); // 残り全員が回答済みなので締切
  assert.throws(() => m.applyAction(s, 2, { type: "answer", choice: 0 }, makeRng()));
});

test("クイズバトル: parseAction は形式不正を null にする", () => {
  const m = qb.gameModule;
  assert.deepEqual(m.parseAction({ type: "answer", choice: 2 }), { type: "answer", choice: 2 });
  assert.equal(m.parseAction({ type: "answer", choice: 4 }), null);
  assert.equal(m.parseAction({ type: "answer", choice: 1.5 }), null);
  assert.equal(m.parseAction({ type: "vote", choice: 1 }), null);
  assert.equal(m.parseAction(null), null);
  assert.equal(m.parseAction("answer"), null);
});
