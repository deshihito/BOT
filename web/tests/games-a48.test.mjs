// A48フェーズ: 内容充実3件（バンク/問題増量のみ）の検証。
// - lib/tsume.ts: 詰将棋 12題→14題（1手詰め7・3手詰め7）。増量分も含め全問題が
//   ソルバー検証を通る（初期局面で玉に王手なし・指定手数ちょうどで詰み・初手が1つだけ）
// - lib/kanacross.ts: カナクロス 12問→14問。増量分も含め全問 isValidPuzzle が妥当
// - lib/online/games/quizbattle.ts: 問題バンク 84問→98問（形式・重複なし・正解の妥当性）
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
const qb = await loadOnline("quizbattle.ts", ["QUIZ_BATTLE_QUESTIONS"]);

// ------------------------------------------------------------ tsume 増量第4弾

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
  for (const id of ["atama-kin-4", "ryu-gin-3"]) {
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

test("詰将棋: 増量2題の初手は想定どおり（72金打 / 83銀打）", () => {
  const expected = { "atama-kin-4": "72金打", "ryu-gin-3": "83銀打" };
  for (const [id, label] of Object.entries(expected)) {
    const p = tsume.TSUME_PROBLEM_MAP[id];
    const pos = tsume.problemPosition(p);
    const sol = tsume.solveTsume(pos, p.moves);
    assert.equal(tsume.moveLabel(pos, sol.winningFirstMoves[0]), label, id);
  }
});

// ------------------------------------------------------------ kanacross 増量第4弾

test("カナクロス: 問題は14問に増え、全問が isValidPuzzle で妥当", () => {
  assert.equal(kana.KANACROSS_PUZZLES.length, 14);
  const ids = kana.KANACROSS_PUZZLES.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ["ajia", "kabocha"]) {
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
  for (const index of [12, 13]) {
    const puzzle = kana.KANACROSS_PUZZLES[index];
    let s = kana.createKanacrossGame(index);
    puzzle.solution.forEach((ch, i) => {
      if (ch !== null) s = kana.setEntry(s, i, ch);
    });
    assert.equal(s.status, "completed", puzzle.id);
    assert.equal(kana.isComplete(s), true, puzzle.id);
  }
});

// ------------------------------------------------------------ quizbattle 増量第3弾

test("クイズバトル: バンクは98問で、カテゴリ配分が既存分野を踏襲している", () => {
  const qs = qb.QUIZ_BATTLE_QUESTIONS;
  assert.equal(qs.length, 98);
  const counts = {};
  for (const q of qs) counts[q.category] = (counts[q.category] ?? 0) + 1;
  assert.deepEqual(counts, { "雑学": 22, "科学": 22, "歴史": 19, "スポーツ": 19, "アニメ・ゲーム": 16 });
});

test("クイズバトル: 全問の形式がそろい、問題文・選択肢に重複がない", () => {
  const qs = qb.QUIZ_BATTLE_QUESTIONS;
  const seen = new Set();
  for (const q of qs) {
    assert.ok(typeof q.category === "string" && q.category.length > 0);
    assert.ok(typeof q.question === "string" && q.question.length > 0);
    assert.ok(!seen.has(q.question), `問題文の重複: ${q.question}`);
    seen.add(q.question);
    assert.equal(q.choices.length, 4, `選択肢数: ${q.question}`);
    assert.equal(new Set(q.choices).size, 4, `選択肢の重複: ${q.question}`);
    for (const c of q.choices) assert.ok(typeof c === "string" && c.length > 0);
    // バンク作法: 正解は先頭に置き、出題時（buildDeck）にシャッフルする
    assert.equal(q.answer, 0, `バンク作法: ${q.question}`);
  }
});

test("クイズバトル: 増量14問の正解が正しい", () => {
  const byQuestion = new Map(qb.QUIZ_BATTLE_QUESTIONS.map((q) => [q.question, q.choices[q.answer]]));
  const expected = new Map([
    ["手紙を送るときに切手を貼るのは、封筒のどの位置？", "右上"],
    ["祝日と日曜日が重なったときに、翌日が休みになる制度は？", "振替休日"],
    ["日本の郵便ポストの色は一般的に何色？", "赤"],
    ["人間の成人の骨はおよそ何本？", "約206本"],
    ["地球が自転で1回転するのにかかる時間はおよそ何時間？", "約24時間"],
    ["雷で、光が見えてから音が聞こえるまで時間差があるのは、音より光の方がどうだから？", "速い"],
    ["江戸時代に参勤交代を制度化した将軍は？", "徳川家光"],
    ["「維新の三傑」の一人、西郷隆盛の出身の藩は？", "薩摩藩"],
    ["第二次世界大戦が終わった年は？", "1945年"],
    ["野球で、1試合は通常何回まで？", "9回"],
    ["柔道で、相手を投げる技の総称は？", "投げ技"],
    ["ボウリングで、1投目で10本全てのピンを倒すことを何という？", "ストライク"],
    ["『名探偵コナン』の主人公・江戸川コナンの本当の姿は？", "工藤新一"],
    ["将棋の駒で、成ると「龍王」になる駒は？", "飛車"],
  ]);
  assert.equal(expected.size, 14);
  for (const [q, a] of expected) {
    assert.equal(byQuestion.get(q), a, q);
  }
});
