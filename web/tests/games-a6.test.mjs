// A6フェーズの新規4本のロジック検証。
// - lib/spotdiff.ts: 差分の生成・判定・ミスタップ・勝利
// - lib/flagquiz.ts: 出題決定性・両モード・採点と連続ボーナス・復習記録
// - lib/highlow.ts: 判定（正解/外れ/同数引き分け）・山札消化・ベスト連続
// - lib/online/games/drawguess.ts: 秘匿ビュー・正規化一致・得点・ストローク上限・tick・退出
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

async function loadDrawGuess() {
  const src = fs.readFileSync(path.join(libDir, "online", "games", "drawguess.ts"), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const code =
    stripModuleSyntax(js) +
    "\nexport { gameModule, normalizeGuess, dgGuesserPoints, DG_WORDS, DG_MAX_STROKES, DG_MAX_POINTS_PER_STROKE, DG_COLORS, DG_WIDTHS };\n";
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const sd = await loadLib("spotdiff.ts");
const fq = await loadLib("flagquiz.ts");
const hl = await loadLib("highlow.ts");
const dg = await loadDrawGuess();

// 決定的 rng（LCG）。オンライン基盤の Rng は () => number。
function makeRng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const players3 = () => [
  { seat: 0, name: "あきら" },
  { seat: 1, name: "ぶんた" },
  { seat: 2, name: "ちえ" },
];

// ---------------------------------------------------------------- spotdiff

test("間違い探し: 差分は指定個数だけあり、base と altered はその位置でのみ違う", () => {
  const state = sd.createSpotDiffGame("normal", 42);
  assert.equal(state.base.length, 48);
  assert.equal(state.altered.length, 48);
  assert.equal(state.diffIndexes.length, 5);
  assert.equal(new Set(state.diffIndexes).size, 5);
  for (let i = 0; i < 48; i++) {
    if (state.diffIndexes.includes(i)) assert.notEqual(state.base[i], state.altered[i], `index ${i}`);
    else assert.equal(state.base[i], state.altered[i], `index ${i}`);
  }
  assert.equal(sd.createSpotDiffGame("easy", 42).diffIndexes.length, 3);
  assert.equal(sd.createSpotDiffGame("hard", 42).diffIndexes.length, 7);
});

test("間違い探し: 同じシードでは同じ盤になる", () => {
  const a = sd.createSpotDiffGame("hard", 7);
  const b = sd.createSpotDiffGame("hard", 7);
  assert.deepEqual(a.base, b.base);
  assert.deepEqual(a.altered, b.altered);
  assert.deepEqual(a.diffIndexes, b.diffIndexes);
});

test("間違い探し: 正解タップで found が増え、全部見つけると won、ミスタップも数える", () => {
  let state = sd.createSpotDiffGame("easy", 3);
  const wrong = state.base.findIndex((_, i) => !state.diffIndexes.includes(i));
  state = sd.tapSpotDiff(state, wrong);
  assert.equal(state.mistakes, 1);
  assert.equal(state.found.length, 0);
  for (const idx of state.diffIndexes) state = sd.tapSpotDiff(state, idx);
  assert.equal(state.found.length, state.diffIndexes.length);
  assert.equal(state.status, "won");
  // 見つけたマスの再タップや勝利後のタップは状態を変えない
  const same = sd.tapSpotDiff(state, wrong);
  assert.equal(same, state);
});

test("間違い探し: 範囲外タップは無視される", () => {
  const state = sd.createSpotDiffGame("easy", 5);
  assert.equal(sd.tapSpotDiff(state, -1), state);
  assert.equal(sd.tapSpotDiff(state, 48), state);
  assert.equal(sd.tapSpotDiff(state, 1.5), state);
});

// ---------------------------------------------------------------- flagquiz

test("フラッグクイズ: ペアは40組以上で旗と国名が重複しない", () => {
  assert.ok(fq.FLAG_PAIRS.length >= 40);
  assert.equal(new Set(fq.FLAG_PAIRS.map((p) => p.flag)).size, fq.FLAG_PAIRS.length);
  assert.equal(new Set(fq.FLAG_PAIRS.map((p) => p.name)).size, fq.FLAG_PAIRS.length);
});

test("フラッグクイズ: 出題は10問・4択・正解は選択肢にちょうど1つだけ含まれる", () => {
  const state = fq.createFlagQuizGame(42);
  assert.equal(state.questions.length, 10);
  assert.equal(new Set(state.questions.map((q) => q.target)).size, 10);
  for (const q of state.questions) {
    assert.equal(q.choices.length, 4);
    assert.equal(new Set(q.choices).size, 4);
    assert.equal(q.choices[q.answerPos], q.target);
    assert.ok(q.mode === "flagToName" || q.mode === "nameToFlag");
  }
});

test("フラッグクイズ: 同じシードでは同じ出題になる／複数シードで両モードが出る", () => {
  const a = fq.createFlagQuizGame(9);
  const b = fq.createFlagQuizGame(9);
  assert.deepEqual(a.questions, b.questions);
  const modes = new Set();
  for (let seed = 1; seed <= 12; seed++) {
    for (const q of fq.createFlagQuizGame(seed).questions) modes.add(q.mode);
  }
  assert.ok(modes.has("flagToName"));
  assert.ok(modes.has("nameToFlag"));
});

test("フラッグクイズ: 全問正解で満点＋連続ボーナスになり、記録が復習用に残る", () => {
  let state = fq.createFlagQuizGame(42);
  while (state.phase !== "finished") {
    const q = state.questions[state.index];
    state = fq.answerFlagQuestion(state, q.answerPos);
    assert.equal(state.phase, "revealed");
    state = fq.nextFlagQuestion(state);
  }
  assert.equal(state.records.length, 10);
  assert.ok(state.records.every((r) => r.correct));
  assert.equal(fq.flagQuizCorrectCount(state), 10);
  assert.equal(state.bestStreak, 10);
  // 100*10 + 連続ボーナス 20*(0+1+...+9)=900 ただし上限100/問 → 20+40+60+80+100*5=700
  assert.equal(state.score, 1000 + (20 + 40 + 60 + 80 + 100 * 5));
});

test("フラッグクイズ: 不正解は0点で連続が切れ、間違えた選択が記録される", () => {
  let state = fq.createFlagQuizGame(42);
  const q = state.questions[0];
  const wrongPos = (q.answerPos + 1) % 4;
  state = fq.answerFlagQuestion(state, wrongPos);
  assert.equal(state.score, 0);
  assert.equal(state.streak, 0);
  assert.equal(state.records[0].correct, false);
  assert.equal(state.records[0].picked, q.choices[wrongPos]);
  // revealed 中の二重回答は無効
  const again = fq.answerFlagQuestion(state, q.answerPos);
  assert.equal(again, state);
});

// ---------------------------------------------------------------- highlow

test("ハイ＆ロー: 山札は52枚すべて異なるカードで、最初のカードがある", () => {
  const state = hl.createHighLowGame(42);
  assert.equal(state.pile.length, 52);
  assert.equal(new Set(state.pile).size, 52);
  assert.ok(state.pile.every((c) => c >= 0 && c < 52));
  assert.equal(hl.highLowRemaining(state), 51);
  const b = hl.createHighLowGame(42);
  assert.deepEqual(state.pile, b.pile);
});

test("ハイ＆ロー: カードのランクと名前が正しい", () => {
  assert.equal(hl.highLowRank(0), 1); // ♠A
  assert.equal(hl.highLowCardName(0), "♠A");
  assert.equal(hl.highLowCardName(12), "♠K");
  assert.equal(hl.highLowCardName(13 + 10), "♥J");
  assert.equal(hl.isHighLowRed(13), true); // ♥
  assert.equal(hl.isHighLowRed(0), false); // ♠
  assert.equal(hl.compareHighLow(0, 1), 1); // A -> 2 は高い
  assert.equal(hl.compareHighLow(5, 2), -1);
  assert.equal(hl.compareHighLow(5, 18), 0); // 6 と 6（別スート）
});

/** pile を差し替えた状態を作る（テスト用）。 */
function hlWithPile(pile) {
  const base = hl.createHighLowGame(1);
  return { ...base, pile };
}

test("ハイ＆ロー: 当たると連続が伸び、外すと終了する", () => {
  // 現在 5(ランク6)、次 9(ランク10) → high が正解
  let state = hlWithPile([5, 9, 0, 1]);
  state = hl.guessHighLow(state, "high");
  assert.equal(state.last.result, "correct");
  assert.equal(state.streak, 1);
  assert.equal(state.status, "playing");
  assert.equal(hl.highLowCurrent(state), 9);
  // 現在 9(ランク10)、次 0(ランクA=1) → low が正解だが high と答えて外す
  state = hl.guessHighLow(state, "high");
  assert.equal(state.last.result, "wrong");
  assert.equal(state.status, "finished");
  assert.equal(state.finishReason, "wrong");
  assert.equal(state.bestStreak, 1);
});

test("ハイ＆ロー: 同数は引き分けで連続を保ったまま続行できる", () => {
  // 現在 5(ランク6)、次 18(ランク6) → どちらを答えても引き分け
  let state = hlWithPile([5, 18, 3, 4]);
  state = hl.guessHighLow(state, "high");
  assert.equal(state.last.result, "draw");
  assert.equal(state.streak, 0);
  assert.equal(state.status, "playing");
  assert.equal(hl.highLowCurrent(state), 18);
});

test("ハイ＆ロー: 山札が尽きるとクリアで終了する", () => {
  // 現在 0(A)、次 1(2) の2枚だけ → high 正解で消化しきる
  let state = hlWithPile([0, 1]);
  state = hl.guessHighLow(state, "high");
  assert.equal(state.last.result, "correct");
  assert.equal(state.status, "finished");
  assert.equal(state.finishReason, "cleared");
  assert.equal(state.streak, 1);
});

// ---------------------------------------------------------------- drawguess

test("お絵かき当て: 正規化は空白除去とカタカナ→ひらがな変換を行う", () => {
  assert.equal(dg.normalizeGuess(" アイスクリーム "), "あいすくりーむ");
  assert.equal(dg.normalizeGuess("りん　ご"), "りんご");
  assert.equal(dg.normalizeGuess("ギター"), "ぎたー");
  assert.equal(dg.dgGuesserPoints(0), 100);
  assert.equal(dg.dgGuesserPoints(1), 80);
  assert.equal(dg.dgGuesserPoints(10), 30);
});

test("お絵かき当て: 作成直後は choosing で、描き手にだけ3択が見える", () => {
  const mod = dg.gameModule;
  const state = mod.createState(players3(), makeRng(42), {});
  assert.equal(mod.phaseOf(state), "choosing");
  assert.equal(state.rounds.length, 3);
  const drawerView = mod.viewFor(state, 0);
  assert.equal(drawerView.you.isDrawer, true);
  assert.equal(drawerView.wordOptions.length, 3);
  const guesserView = mod.viewFor(state, 1);
  assert.equal(guesserView.wordOptions, null);
  assert.equal(guesserView.word, null);
  const json = JSON.stringify(guesserView);
  for (const option of drawerView.wordOptions) {
    // お題が「値そのもの」として漏れていないこと（1文字のお題がプレイヤー名等の部分文字列に一致する誤検出を避ける）
    assert.ok(!json.includes(`"${option}"`), `お題候補「${option}」が回答側に漏れている`);
  }
});

/** 描き手がお題を選び drawing に進めた状態を返す。 */
function dgDrawing(mod, seed = 42) {
  let state = mod.createState(players3(), makeRng(seed), {});
  const drawerView = mod.viewFor(state, 0);
  state = mod.applyAction(state, 0, { type: "choose", index: 0 }, makeRng(seed));
  return { state, word: drawerView.wordOptions[0] };
}

test("お絵かき当て: drawing 中、お題は描き手にだけ見え、回答側は文字数だけ分かる", () => {
  const mod = dg.gameModule;
  const { state, word } = dgDrawing(mod);
  assert.equal(mod.phaseOf(state), "drawing");
  assert.equal(mod.viewFor(state, 0).word, word);
  const guesserView = mod.viewFor(state, 1);
  assert.equal(guesserView.word, null);
  assert.equal(guesserView.wordLength, [...dg.normalizeGuess(word)].length);
  assert.ok(!JSON.stringify(guesserView).includes(`"${word}"`), "お題が回答側ビューに漏れている");
});

test("お絵かき当て: 正規化一致で正解になり、得点とフィードの秘匿が効く", () => {
  const mod = dg.gameModule;
  const { state: s0, word } = dgDrawing(mod);
  // 外した回答はフィードに本文つきで残る
  let state = mod.applyAction(s0, 1, { type: "guess", text: "ぜんぜん違う" }, makeRng());
  assert.equal(state.feed.length, 1);
  assert.deepEqual(state.feed[0], { seat: 1, text: "ぜんぜん違う", correct: false });
  // カタカナ表記＋空白入りでも正解になる（お題がひらがなでもカタカナでも正規化される）
  const katakana = [...dg.normalizeGuess(word)]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x3041 && code <= 0x3096 ? String.fromCharCode(code + 0x60) : ch;
    })
    .join("");
  state = mod.applyAction(state, 1, { type: "guess", text: ` ${katakana} ` }, makeRng());
  assert.deepEqual(state.correctSeats, [1]);
  assert.equal(state.scores[1], 100); // 1番目の正解
  assert.equal(state.scores[0], 25); // 描き手は正解者1人につき25点
  // 正解の本文はフィードに残らない
  assert.deepEqual(state.feed[1], { seat: 1, text: null, correct: true });
  // 正解済みの再回答はエラー
  assert.throws(() => mod.applyAction(state, 1, { type: "guess", text: word }, makeRng()), /すでに正解/);
  // 描き手は回答できない
  assert.throws(() => mod.applyAction(state, 0, { type: "guess", text: word }, makeRng()), /描き手は回答できません/);
});

test("お絵かき当て: 全員正解で即 reveal になり、お題が全員に開示される", () => {
  const mod = dg.gameModule;
  const { state: s0, word } = dgDrawing(mod);
  let state = mod.applyAction(s0, 1, { type: "guess", text: word }, makeRng());
  assert.equal(mod.phaseOf(state), "drawing");
  state = mod.applyAction(state, 2, { type: "guess", text: word }, makeRng());
  assert.equal(state.scores[2], 80); // 2番目の正解
  assert.equal(mod.phaseOf(state), "reveal");
  assert.equal(mod.viewFor(state, 1).word, word);
  assert.equal(mod.viewFor(state, 2).word, word);
});

test("お絵かき当て: ストロークの検証と上限（300本・1本200点）", () => {
  const mod = dg.gameModule;
  const { state: s0 } = dgDrawing(mod);
  const stroke = { type: "stroke", color: dg.DG_COLORS[0], width: dg.DG_WIDTHS[0], points: [[10, 10], [20, 20]] };
  // 回答側は描けない
  assert.throws(() => mod.applyAction(s0, 1, stroke, makeRng()), /描き手だけ/);
  // 使えない色・太さはエラー
  assert.throws(() => mod.applyAction(s0, 0, { ...stroke, color: "#123456" }, makeRng()), /色/);
  assert.throws(() => mod.applyAction(s0, 0, { ...stroke, width: 99 }, makeRng()), /太さ/);
  // 座標は 0〜1000 に丸められる
  let state = mod.applyAction(s0, 0, { ...stroke, points: [[-5, 1200]] }, makeRng());
  assert.deepEqual(state.strokes[0].points, [[0, 1000]]);
  // 300本まで描け、301本目はエラー
  for (let i = state.strokes.length; i < dg.DG_MAX_STROKES; i++) {
    state = mod.applyAction(state, 0, stroke, makeRng());
  }
  assert.equal(state.strokes.length, dg.DG_MAX_STROKES);
  assert.throws(() => mod.applyAction(state, 0, stroke, makeRng()), /上限/);
  // 消去で空に戻る
  state = mod.applyAction(state, 0, { type: "clear" }, makeRng());
  assert.equal(state.strokes.length, 0);
  // parseAction: 200点超のストロークや形式不正は null
  const tooLong = { type: "stroke", color: dg.DG_COLORS[0], width: dg.DG_WIDTHS[0], points: Array.from({ length: dg.DG_MAX_POINTS_PER_STROKE + 1 }, () => [1, 1]) };
  assert.equal(mod.parseAction(tooLong), null);
  assert.equal(mod.parseAction({ type: "guess", text: "  " }), null);
  assert.equal(mod.parseAction({ type: "choose", index: 3 }), null);
  assert.deepEqual(mod.parseAction({ type: "clear" }), { type: "clear" });
});

test("お絵かき当て: tick で選択タイムアウト→自動開始、制限時間→reveal→次ラウンドへ進む", () => {
  const mod = dg.gameModule;
  let state = mod.createState(players3(), makeRng(42), {});
  const endsAt = state.phaseEndsAt;
  // 締切前は変化なし（同一参照）
  assert.equal(mod.tick(state, endsAt - 1), state);
  // 締切で先頭のお題が自動選択され drawing へ
  state = mod.tick(state, endsAt);
  assert.equal(mod.phaseOf(state), "drawing");
  assert.equal(mod.viewFor(state, 0).word, state.rounds[0].options[0]);
  // drawing の締切で reveal
  state = mod.tick(state, state.phaseEndsAt);
  assert.equal(mod.phaseOf(state), "reveal");
  // reveal の締切で次の描き手の choosing
  state = mod.tick(state, state.phaseEndsAt);
  assert.equal(mod.phaseOf(state), "choosing");
  assert.equal(state.roundIndex, 1);
  assert.equal(mod.viewFor(state, 1).you.isDrawer, true);
});

test("お絵かき当て: 描き手の退出でラウンドが飛び、人数不足で終了する", () => {
  const mod = dg.gameModule;
  const { state: s0 } = dgDrawing(mod);
  // 描き手（seat 0）が退出 → 次のラウンド（seat 1 が描き手）へ
  let state = mod.onPlayerLeft(s0, 0);
  assert.equal(state.roundIndex, 1);
  assert.equal(mod.phaseOf(state), "choosing");
  assert.equal(mod.viewFor(state, 1).you.isDrawer, true);
  // さらに1人抜けると残り1人で終了し、順位が付く
  state = mod.onPlayerLeft(state, 2);
  assert.equal(mod.isFinished(state), true);
  const view = mod.viewFor(state, 1);
  assert.ok(Array.isArray(view.standings));
  assert.equal(view.standings.length, 3);
});

test("お絵かき当て: 全ラウンドを消化すると finished になり順位が返る", () => {
  const mod = dg.gameModule;
  let state = mod.createState(players3(), makeRng(7), {});
  let guard = 0;
  while (!mod.isFinished(state) && guard++ < 50) {
    state = mod.tick(state, (state.phaseEndsAt ?? 0) + 1);
    // choosing は tick が drawing に進めるので、drawing/reveal も tick で進む
  }
  assert.equal(mod.isFinished(state), true);
  const view = mod.viewFor(state, 0);
  assert.equal(view.phase, "finished");
  assert.equal(view.standings.length, 3);
  assert.ok(view.standings.every((s) => s.rank >= 1));
});
