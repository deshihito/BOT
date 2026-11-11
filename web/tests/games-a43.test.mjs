// A43フェーズ: 内容充実3件（バンク/問題増量のみ）の検証。
// - lib/tsume.ts: 詰将棋 10題→12題（1手詰め6・3手詰め6）。増量分も含め全問題が
//   ソルバー検証を通る（初期局面で玉に王手なし・指定手数ちょうどで詰み・初手が1つだけ）
// - lib/kanacross.ts: カナクロス 10問→12問。増量分も含め全問 isValidPuzzle が妥当
// - lib/online/games/drawguess.ts: お題バンク 130語→150語（重複なし・
//   正規化（カタカナ→ひらがな化）後も衝突なし）
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

async function loadOnline(name, exportsList) {
  const src = fs.readFileSync(path.join(libDir, "online", "games", name), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const code = stripModuleSyntax(js) + `\nexport { ${exportsList.join(", ")} };\n`;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const tsume = await loadLib("tsume.ts");
const kana = await loadLib("kanacross.ts");
const dg = await loadOnline("drawguess.ts", ["DG_WORDS", "normalizeGuess"]);

// ------------------------------------------------------------ tsume 増量第3弾

test("詰将棋: 全14題（1手詰め7・3手詰め7）があり、ID と局面が重複しない", () => {
  assert.equal(tsume.TSUME_PROBLEMS.length, 14);
  const ids = new Set(tsume.TSUME_PROBLEMS.map((p) => p.id));
  assert.equal(ids.size, 14);
  const counts = { 1: 0, 3: 0 };
  for (const p of tsume.TSUME_PROBLEMS) counts[p.moves] += 1;
  assert.deepEqual(counts, { 1: 7, 3: 7 });
  const positions = new Set(
    tsume.TSUME_PROBLEMS.map((p) =>
      JSON.stringify({
        board: [...p.board].sort((a, b) => (a.at + a.piece + a.side).localeCompare(b.at + b.piece + b.side)),
        handA: p.handA ?? {},
        handD: p.handD ?? {},
      }),
    ),
  );
  assert.equal(positions.size, 14);
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
  for (const id of ["hi-narabi", "ryu-hi-yose"]) {
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

test("詰将棋: 増量2題の初手は想定どおり（51飛打 / 71飛打）", () => {
  const expected = { "hi-narabi": "51飛打", "ryu-hi-yose": "71飛打" };
  for (const [id, label] of Object.entries(expected)) {
    const p = tsume.TSUME_PROBLEM_MAP[id];
    const pos = tsume.problemPosition(p);
    const sol = tsume.solveTsume(pos, p.moves);
    assert.equal(tsume.moveLabel(pos, sol.winningFirstMoves[0]), label, id);
  }
});

// ------------------------------------------------------------ kanacross 増量第3弾

test("カナクロス: 問題は14問に増え、全問が isValidPuzzle で妥当", () => {
  assert.equal(kana.KANACROSS_PUZZLES.length, 14);
  const ids = kana.KANACROSS_PUZZLES.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ["karee", "umigame"]) {
    assert.ok(ids.includes(id), id);
  }
  for (const p of kana.KANACROSS_PUZZLES) {
    assert.equal(kana.isValidPuzzle(p), true, p.id);
    assert.equal(p.solution.length, p.rows * p.cols, p.id);
    for (const w of p.words) {
      assert.ok(w.answer.length > 0 && w.hint.length > 0, `${p.id}/${w.id}`);
    }
  }
});

test("カナクロス: 増量2問も全マス入力で完成する", () => {
  for (const index of [10, 11]) {
    const puzzle = kana.KANACROSS_PUZZLES[index];
    let s = kana.createKanacrossGame(index);
    puzzle.solution.forEach((ch, i) => {
      if (ch !== null) s = kana.setEntry(s, i, ch);
    });
    assert.equal(s.status, "completed", puzzle.id);
    assert.equal(kana.isComplete(s), true, puzzle.id);
  }
});

// ------------------------------------------------------------ drawguess 増量第2弾

const DG_ADDED_A43 = [
  "カメラ", "きんぎょ", "ハト", "カラス", "パン", "コーヒー",
  "かんらんしゃ", "ヘリコプター", "ロケット", "つくえ", "ドア", "しんごう",
  "ポスト", "スマホ", "ろうそく", "タオル", "めだまやき", "にじ",
  "マイク", "カブトムシ",
];

test("お絵かき当て: バンクは150語・重複なし・全てかな表記の具体名詞形式", () => {
  assert.equal(dg.DG_WORDS.length, 150);
  assert.equal(new Set(dg.DG_WORDS).size, dg.DG_WORDS.length);
  for (const word of dg.DG_WORDS) {
    assert.ok(/^[ぁ-んァ-ヶー]+$/.test(word), `かな表記でない語: ${word}`);
    assert.ok(word.length >= 1 && word.length <= 8, `長さが範囲外: ${word}`);
  }
});

test("お絵かき当て: 正規化（カタカナ→ひらがな化）の後も全語が衝突しない", () => {
  const normalized = dg.DG_WORDS.map((w) => dg.normalizeGuess(w));
  assert.equal(new Set(normalized).size, normalized.length);
});

test("お絵かき当て: 増量分の20語が含まれている", () => {
  assert.equal(DG_ADDED_A43.length, 20);
  for (const added of DG_ADDED_A43) {
    assert.ok(dg.DG_WORDS.includes(added), `増量語 ${added} がない`);
  }
});
