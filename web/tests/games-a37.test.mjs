// A37フェーズ: 新規1本＋内容充実2件の検証（lib のみ、UI 非依存）。
// - lib/kwordle.ts: 判定（重複文字の出現回数ベース処理）・バンク形式・勝敗遷移
// - lib/tsume.ts: 増量後の全12題がソルバー検証を通る（初期局面で玉に王手なし・
//   指定手数ちょうどで詰み・初手が1つだけ）
// - lib/kanacross.ts: 増量後の全12問が isValidPuzzle を通り、完成入力で completed になる
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

const kw = await loadLib("kwordle.ts");
const tsume = await loadLib("tsume.ts");
const kana = await loadLib("kanacross.ts");

// ------------------------------------------------------------ kwordle

test("カタカナワードル: 答えバンクは30語以上・重複なし・全てカタカナ5文字", () => {
  assert.ok(kw.KWORDLE_ANSWERS.length >= 30, `現在 ${kw.KWORDLE_ANSWERS.length} 語`);
  assert.equal(new Set(kw.KWORDLE_ANSWERS).size, kw.KWORDLE_ANSWERS.length);
  for (const word of kw.KWORDLE_ANSWERS) {
    assert.equal([...word].length, kw.KWORDLE_LENGTH, word);
    assert.ok([...word].every((ch) => kw.isKanaChar(ch)), word);
    assert.equal(kw.validateKwordleGuess(word), null, word);
  }
});

test("カタカナワードル: 完全一致は全て correct", () => {
  assert.deepEqual(kw.evaluateKwordleGuess("カレンダー", "カレンダー"), [
    "correct", "correct", "correct", "correct", "correct",
  ]);
});

test("カタカナワードル: 重複文字は出現回数ベースで判定する（余分な重複は absent）", () => {
  // 答え「カレンダー」に「カ」は1つだけ。先頭で correct になった残りの「カ」は absent。
  assert.deepEqual(kw.evaluateKwordleGuess("カレンダー", "カカレンン"), [
    "correct", "absent", "present", "present", "absent",
  ]);
  // 答え「カレーパン」の「ー」は1つ。推測の2つ目の「ー」は absent。
  assert.deepEqual(kw.evaluateKwordleGuess("カレーパン", "カレーカン"), [
    "correct", "correct", "correct", "absent", "correct",
  ]);
  // 答えに無い文字は全て absent。
  assert.deepEqual(kw.evaluateKwordleGuess("カレンダー", "トマトズシ"), [
    "absent", "absent", "absent", "absent", "absent",
  ]);
});

test("カタカナワードル: 検証はカタカナ5文字のみ許可する", () => {
  assert.equal(kw.validateKwordleGuess("トマト"), "カタカナ5文字を入力してください");
  assert.equal(kw.validateKwordleGuess("トマトズシマ"), "カタカナ5文字を入力してください");
  assert.equal(kw.validateKwordleGuess("TOMATO"), "カタカナ5文字を入力してください");
  assert.equal(kw.validateKwordleGuess("とまとずし"), "カタカナのみ入力できます");
  assert.equal(kw.validateKwordleGuess("カレンダ語"), "カタカナのみ入力できます");
  assert.equal(kw.validateKwordleGuess("チャーハン"), null);
});

test("カタカナワードル: 当てれば won、外し続けると6回で lost になり答えが確定する", () => {
  let s = kw.createKwordleGameWithAnswer("カレンダー");
  const r1 = kw.submitKwordleGuess(s, "トマトズシ");
  assert.equal(r1.error, null);
  s = r1.state;
  assert.equal(s.status, "playing");
  assert.equal(s.guesses.length, 1);
  const r2 = kw.submitKwordleGuess(s, "カレンダー");
  assert.equal(r2.state.status, "won");
  assert.equal(r2.state.guesses.length, 2);
  // 終了後の推測はエラーで状態不変。
  const r3 = kw.submitKwordleGuess(r2.state, "トマトズシ");
  assert.equal(r3.state, r2.state);
  assert.ok(r3.error);

  let t = kw.createKwordleGameWithAnswer("カレンダー");
  for (let i = 0; i < kw.KWORDLE_MAX_GUESSES; i++) {
    t = kw.submitKwordleGuess(t, "トマトズシ").state;
  }
  assert.equal(t.status, "lost");
  assert.equal(t.guesses.length, 6);
});

test("カタカナワードル: 不正な推測では状態が変わらない／シードで答えが決定的", () => {
  const s = kw.createKwordleGameWithAnswer("カレンダー");
  const bad = kw.submitKwordleGuess(s, "とまと");
  assert.equal(bad.state, s);
  assert.ok(bad.error);
  assert.equal(kw.pickKwordleAnswer(42), kw.pickKwordleAnswer(42));
  assert.ok(kw.KWORDLE_ANSWERS.includes(kw.pickKwordleAnswer(42)));
  assert.equal(kw.createKwordleGame(7).answer, kw.pickKwordleAnswer(7));
});

test("カタカナワードル: キーボード集約は最良の判定を残す", () => {
  let s = kw.createKwordleGameWithAnswer("カレンダー");
  s = kw.submitKwordleGuess(s, "カカレンン").state;
  const kb = kw.kwordleKeyboardState(s);
  assert.equal(kb["カ"], "correct");
  assert.equal(kb["レ"], "present");
  assert.equal(kb["ン"], "present");
  assert.equal(kb["ト"], undefined);
});

// ------------------------------------------------------------ tsume 増量第2弾

test("詰将棋: 全14題（1手詰め7・3手詰め7）があり、ID が重複しない", () => {
  assert.equal(tsume.TSUME_PROBLEMS.length, 14);
  const ids = new Set(tsume.TSUME_PROBLEMS.map((p) => p.id));
  assert.equal(ids.size, 14);
  const counts = { 1: 0, 3: 0 };
  for (const p of tsume.TSUME_PROBLEMS) counts[p.moves] += 1;
  assert.deepEqual(counts, { 1: 7, 3: 7 });
});

test("詰将棋: 増量分を含む全問題が機械検証を通る（王手なし初期局面・指定手数ちょうど・初手一意）", () => {
  for (const p of tsume.TSUME_PROBLEMS) {
    const pos = tsume.problemPosition(p);
    assert.equal(tsume.inCheck(pos, "D"), false, `${p.id}: 初期局面で玉が王手状態ではいけない`);
    const sol = tsume.solveTsume(pos, p.moves);
    assert.equal(sol.mate, true, `${p.id}: 詰むはず`);
    assert.equal(sol.moves, p.moves, `${p.id}: ${p.moves}手詰めのはず`);
    assert.equal(sol.winningFirstMoves.length, 1, `${p.id}: 初手は1つだけのはず`);
  }
});

test("詰将棋: 増量2題が含まれ、正解手順で実際にクリアできる", () => {
  for (const id of ["sumi-gin", "kaku-gin-3"]) {
    assert.ok(tsume.TSUME_PROBLEM_MAP[id], `${id} が収録されている`);
    let state = tsume.createTsumeGame(id);
    let guard = 0;
    while (state.status === "playing" && guard++ < 10) {
      const sol = tsume.solveTsume(state.pos, state.problem.moves - state.movesUsed);
      assert.ok(sol.mate && sol.winningFirstMoves.length >= 1, `${id}: 手順が続く`);
      state = tsume.playAttackerMove(state, sol.winningFirstMoves[0]);
    }
    assert.equal(state.status, "cleared", `${id}: クリアできるはず`);
    assert.equal(state.movesUsed, state.problem.moves, `${id}: 指定手数でクリア`);
  }
});

// ------------------------------------------------------------ kanacross 増量第2弾

test("カナクロス: 問題は14問に増え、全問が isValidPuzzle で妥当", () => {
  assert.equal(kana.KANACROSS_PUZZLES.length, 14);
  const ids = kana.KANACROSS_PUZZLES.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ["okazu", "amerika"]) {
    assert.ok(ids.includes(id), id);
  }
  for (const p of kana.KANACROSS_PUZZLES) {
    assert.equal(kana.isValidPuzzle(p), true, p.id);
  }
});

test("カナクロス: 増量2問も全マス入力で完成する", () => {
  for (const index of [8, 9]) {
    const puzzle = kana.KANACROSS_PUZZLES[index];
    let s = kana.createKanacrossGame(index);
    puzzle.solution.forEach((ch, i) => {
      if (ch !== null) s = kana.setEntry(s, i, ch);
    });
    assert.equal(s.status, "completed", puzzle.id);
    assert.equal(kana.isComplete(s), true, puzzle.id);
  }
});
