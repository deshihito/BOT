// A20フェーズ新規3本のロジック検証（lib のみ、UI 非依存）。
// - lib/kenken.ts: 生成妥当性（ラテン方陣・ケージ目標）・決定性・検証・完成
// - lib/binairo.ts: 解の妥当性・決定性・タップ循環・ルール検証・完成
// - lib/online/games/flashanzan.ts: tick 進行・秘匿・採点・退出
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
  const body = stripModuleSyntax(js) + `\n;return { ${exportsList.join(", ")} };`;
  return new Function(body)();
}

const kk = await loadLib("kenken.ts");
const bn = await loadLib("binairo.ts");
const fa = await loadOnline("flashanzan.ts", ["gameModule", "FA_TOTAL_ROUNDS", "FA_ROUND_SPECS"]);

function makeRng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- ケンケン ----

test("ケンケン: 解はラテン方陣で、全ケージの目標値が解と一致する", () => {
  for (const size of [4, 5]) {
    for (const seed of [1, 42, 777]) {
      const g = kk.createKenkenGame(size, seed);
      assert.equal(g.solution.length, size * size);
      const expected = Array.from({ length: size }, (_, i) => i + 1).join(",");
      for (let r = 0; r < size; r++) {
        const row = g.solution.slice(r * size, r * size + size).sort((a, b) => a - b).join(",");
        assert.equal(row, expected, `size=${size} seed=${seed} row=${r}`);
      }
      for (let c = 0; c < size; c++) {
        const col = Array.from({ length: size }, (_, r) => g.solution[r * size + c])
          .sort((a, b) => a - b)
          .join(",");
        assert.equal(col, expected, `size=${size} seed=${seed} col=${c}`);
      }
      // ケージは全マスをちょうど1回ずつ覆う。
      const covered = new Array(size * size).fill(0);
      for (const cage of g.cages) {
        for (const idx of cage.cells) {
          covered[idx]++;
          assert.equal(g.cageOf[idx], cage.id);
        }
        const vals = cage.cells.map((i) => g.solution[i]);
        assert.equal(kk.evaluateCage(vals, cage.op), cage.target, `cage=${cage.id}`);
        if (cage.cells.length === 1) {
          assert.equal(cage.op, "");
          assert.equal(cage.target, vals[0]);
        }
        if (cage.op === "-" || cage.op === "÷") assert.equal(cage.cells.length, 2);
      }
      assert.deepEqual(covered, new Array(size * size).fill(1));
    }
  }
});

test("ケンケン: 同じシードでは同じ問題になり、解を入れると勝ち・元状態は不変", () => {
  const a = kk.createKenkenGame(4, 42);
  const b = kk.createKenkenGame(4, 42);
  assert.deepEqual(a.solution, b.solution);
  assert.deepEqual(a.cages, b.cages);

  let s = a;
  for (let i = 0; i < a.solution.length; i++) {
    s = kk.setKenkenValue(s, i, a.solution[i]);
  }
  assert.equal(s.status, "won");
  assert.equal(kk.checkKenken(s).complete, true);
  // 元の状態は変わっていない（非破壊）。
  assert.ok(a.values.every((v) => v === 0));
  assert.equal(a.status, "playing");
});

test("ケンケン: 行の重複とケージ不一致を検出し、不正な入力は無視する", () => {
  const g = kk.createKenkenGame(4, 7);
  let s = kk.setKenkenValue(g, 0, 1);
  s = kk.setKenkenValue(s, 1, 1);
  const vs = kk.kenkenViolations(s);
  assert.ok(vs.some((v) => v.type === "rowDup"));

  // どれか1つのケージをわざと間違えて埋めると cage 違反が出る。
  let found = false;
  for (const cage of g.cages) {
    if (cage.cells.length < 2) continue;
    for (let k = 0; k < cage.cells.length && !found; k++) {
      let t = g;
      for (let j = 0; j < cage.cells.length; j++) {
        const idx = cage.cells[j];
        const v = j === k ? (g.solution[idx] % g.size) + 1 : g.solution[idx];
        t = kk.setKenkenValue(t, idx, v);
      }
      if (kk.kenkenViolations(t).some((v) => v.type === "cage")) found = true;
    }
    if (found) break;
  }
  assert.ok(found, "ケージ違反を検出できるはず");

  assert.equal(kk.setKenkenValue(g, 0, 5), g); // 4x4 に 5 は不可
  assert.equal(kk.setKenkenValue(g, -1, 1), g);
  assert.equal(kk.setKenkenValue(g, 0, 0), g); // 変化なし
});

// ---- バイナリー ----

function assertValidSolution(solution, size) {
  for (let r = 0; r < size; r++) {
    const row = solution.slice(r * size, r * size + size);
    assert.equal(row.reduce((a, b) => a + b, 0), 3, `row ${r} の 1 の数`);
    for (let c = 0; c + 2 < size; c++) {
      assert.ok(!(row[c] === row[c + 1] && row[c + 1] === row[c + 2]), `row ${r} の3連続`);
    }
  }
  for (let c = 0; c < size; c++) {
    const col = Array.from({ length: size }, (_, r) => solution[r * size + c]);
    assert.equal(col.reduce((a, b) => a + b, 0), 3, `col ${c} の 1 の数`);
    for (let r = 0; r + 2 < size; r++) {
      assert.ok(!(col[r] === col[r + 1] && col[r + 1] === col[r + 2]), `col ${c} の3連続`);
    }
  }
  const rowKeys = new Set(Array.from({ length: size }, (_, r) => solution.slice(r * size, r * size + size).join("")));
  assert.equal(rowKeys.size, size, "行同士が重複しない");
  const colKeys = new Set(
    Array.from({ length: size }, (_, c) => Array.from({ length: size }, (_, r) => solution[r * size + c]).join("")),
  );
  assert.equal(colKeys.size, size, "列同士が重複しない");
}

test("バイナリー: 解が全ルールを満たし、与えマスは解と一致する", () => {
  for (const seed of [3, 42, 1234]) {
    const g = bn.createBinairoGame(seed);
    assertValidSolution(g.solution, 6);
    let givens = 0;
    for (let i = 0; i < 36; i++) {
      if (g.givens[i]) {
        givens++;
        assert.equal(g.board[i], g.solution[i]);
      } else {
        assert.equal(g.board[i], -1);
      }
    }
    assert.equal(givens, 36 - 22);
  }
});

test("バイナリー: 同じシードでは同じ問題になり、タップで循環し与えマスは変わらない", () => {
  const a = bn.createBinairoGame(42);
  const b = bn.createBinairoGame(42);
  assert.deepEqual(a.solution, b.solution);
  assert.deepEqual(a.givens, b.givens);

  const free = a.givens.findIndex((g) => !g);
  let s = bn.cycleBinairoCell(a, free);
  assert.equal(s.board[free], 0);
  s = bn.cycleBinairoCell(s, free);
  assert.equal(s.board[free], 1);
  s = bn.cycleBinairoCell(s, free);
  assert.equal(s.board[free], -1);
  assert.equal(a.board[free], -1); // 元状態は不変

  const given = a.givens.findIndex((g) => g);
  assert.equal(bn.cycleBinairoCell(a, given), a);
});

test("バイナリー: 解を入れると完成し、3連続・重複行を検出する", () => {
  const g = bn.createBinairoGame(9);
  const solved = { ...g, board: [...g.solution] };
  assert.equal(bn.checkBinairo(solved).complete, true);

  const tripleBoard = new Array(36).fill(-1);
  tripleBoard[0] = 1;
  tripleBoard[1] = 1;
  tripleBoard[2] = 1;
  const triple = bn.binairoViolations({ ...g, board: tripleBoard });
  assert.ok(triple.some((v) => v.type === "triple"));

  const dupBoard = new Array(36).fill(-1);
  const pattern = [0, 1, 0, 1, 0, 1];
  for (let c = 0; c < 6; c++) {
    dupBoard[c] = pattern[c];
    dupBoard[6 + c] = pattern[c];
  }
  const dup = bn.binairoViolations({ ...g, board: dupBoard });
  assert.ok(dup.some((v) => v.type === "dupRow"));
});

// ---- フラッシュ暗算 ----

const PLAYERS2 = [
  { seat: 0, name: "A" },
  { seat: 1, name: "B" },
];

/** showing フェーズを tick で進めて answer フェーズにする。 */
function driveToAnswer(mod, state) {
  let s = state;
  let guard = 0;
  while (mod.phaseOf(s) === "showing" && guard++ < 100) {
    s = mod.tick(s, s.showEndsAt);
  }
  assert.equal(mod.phaseOf(s), "answer");
  return s;
}

test("フラッシュ暗算: 出題は決定的で、合計が正解と一致する", () => {
  const mod = fa.gameModule;
  const a = mod.createState(PLAYERS2, makeRng(42), {});
  const b = mod.createState(PLAYERS2, makeRng(42), {});
  assert.deepEqual(a.rounds, b.rounds);
  assert.equal(a.rounds.length, fa.FA_TOTAL_ROUNDS);
  a.rounds.forEach((round, i) => {
    assert.equal(round.numbers.length, fa.FA_ROUND_SPECS[i].count);
    assert.equal(round.answer, round.numbers.reduce((x, y) => x + y, 0));
    const max = fa.FA_ROUND_SPECS[i].digits === 1 ? 9 : 99;
    for (const n of round.numbers) assert.ok(n >= 1 && n <= max);
  });
  assert.equal(mod.phaseOf(a), "showing");
  assert.equal(a.currentIndex, 0);
});

test("フラッシュ暗算: tick で数字が1つずつ進み、表示中は現在の数字だけが見える", () => {
  const mod = fa.gameModule;
  let s = mod.createState(PLAYERS2, makeRng(5), {});
  const view = mod.viewFor(s, 0);
  assert.equal(view.currentNumber, s.rounds[0].numbers[0]);
  assert.equal(view.correctAnswer, null);
  assert.ok(!("numbers" in view));

  // 締切前は進まない（同一参照）。
  assert.equal(mod.tick(s, s.showEndsAt - 1), s);
  s = mod.tick(s, s.showEndsAt);
  assert.equal(s.currentIndex, 1);
  assert.equal(mod.viewFor(s, 1).currentNumber, s.rounds[0].numbers[1]);

  s = driveToAnswer(mod, s);
  assert.equal(mod.viewFor(s, 0).currentNumber, null);
});

test("フラッシュ暗算: 回答は締切まで秘匿され、完全一致はボーナス付きで得点する", () => {
  const mod = fa.gameModule;
  let s = driveToAnswer(mod, mod.createState(PLAYERS2, makeRng(11), {}));
  const answer = s.rounds[0].answer;

  s = mod.applyAction(s, 0, mod.parseAction({ type: "answer", value: answer }), makeRng(1));
  // B から見て A の回答内容は見えない（提出済みフラグだけ）。
  const viewB = mod.viewFor(s, 1);
  const playerA = viewB.players.find((p) => p.seat === 0);
  assert.equal(playerA.answered, true);
  assert.ok(!("value" in playerA));
  assert.equal(viewB.correctAnswer, null);
  // 自分の回答は自分だけ見える。
  assert.equal(mod.viewFor(s, 0).you.yourValue, answer);

  s = mod.applyAction(s, 1, mod.parseAction({ type: "answer", value: answer + 10 }), makeRng(1));
  // 全員提出で即締切 → reveal。
  assert.equal(mod.phaseOf(s), "reveal");
  const revealA = mod.viewFor(s, 0);
  assert.equal(revealA.correctAnswer, answer);
  const entryA = revealA.players.find((p) => p.seat === 0);
  const entryB = revealA.players.find((p) => p.seat === 1);
  assert.equal(entryA.winner, true);
  assert.equal(entryA.gained, 150); // 100 + 完全一致ボーナス 50
  assert.equal(entryA.diff, 0);
  assert.equal(entryB.gained, 0);
  assert.equal(entryB.diff, 10);
  assert.equal(revealA.players.find((p) => p.seat === 0).score, 150);
});

test("フラッシュ暗算: 同じ距離では早い提出が勝ち、無回答は得点しない", () => {
  const mod = fa.gameModule;
  let s = driveToAnswer(mod, mod.createState(PLAYERS2, makeRng(13), {}));
  const answer = s.rounds[0].answer;
  s = mod.applyAction(s, 1, { type: "answer", value: answer + 5 }, makeRng(1)); // B が先に提出
  s = mod.applyAction(s, 0, { type: "answer", value: answer - 5 }, makeRng(1));
  assert.equal(mod.phaseOf(s), "reveal");
  const view = mod.viewFor(s, 0);
  assert.equal(view.players.find((p) => p.seat === 1).winner, true);
  assert.equal(view.players.find((p) => p.seat === 1).gained, 100);
  assert.equal(view.players.find((p) => p.seat === 0).gained, 0);

  // 誰も答えなければ全員0点で reveal へ。
  let t = driveToAnswer(mod, mod.createState(PLAYERS2, makeRng(17), {}));
  t = mod.tick(t, t.answerEndsAt);
  assert.equal(mod.phaseOf(t), "reveal");
  const viewT = mod.viewFor(t, 0);
  assert.ok(viewT.players.every((p) => p.gained === 0 && p.winner === false));
});

test("フラッシュ暗算: 5ラウンド進めると終了し順位が付く／退出は脱落扱い", () => {
  const mod = fa.gameModule;
  let s = mod.createState(PLAYERS2, makeRng(23), {});
  for (let round = 0; round < fa.FA_TOTAL_ROUNDS; round++) {
    s = driveToAnswer(mod, s);
    const answer = s.rounds[round].answer;
    s = mod.applyAction(s, 0, { type: "answer", value: answer }, makeRng(1));
    s = mod.applyAction(s, 1, { type: "answer", value: answer + 3 }, makeRng(1));
    assert.equal(mod.phaseOf(s), "reveal");
    s = mod.tick(s, s.revealEndsAt);
  }
  assert.equal(mod.isFinished(s), true);
  const view = mod.viewFor(s, 0);
  assert.equal(view.standings.find((x) => x.seat === 0).rank, 1);
  assert.equal(view.standings.find((x) => x.seat === 0).score, 150 * fa.FA_TOTAL_ROUNDS);
  assert.equal(view.standings.find((x) => x.seat === 1).rank, 2);

  // 退出: 3人で B が抜けると B の提出は取り消され、残りだけで締切できる。
  const players3 = [...PLAYERS2, { seat: 2, name: "C" }];
  let t = driveToAnswer(mod, mod.createState(players3, makeRng(29), {}));
  t = mod.applyAction(t, 1, { type: "answer", value: 1 }, makeRng(1));
  t = mod.onPlayerLeft(t, 1);
  assert.ok(t.leftSeats.includes(1));
  assert.ok(!t.answers.some((a) => a.seat === 1));
  assert.equal(mod.viewFor(t, 0).players.find((p) => p.seat === 1).left, true);
  const ans = t.rounds[t.round].answer;
  t = mod.applyAction(t, 0, { type: "answer", value: ans }, makeRng(1));
  t = mod.applyAction(t, 2, { type: "answer", value: ans }, makeRng(1));
  assert.equal(mod.phaseOf(t), "reveal");
});

test("フラッシュ暗算: parseAction の形式検証と不正な回答の拒否", () => {
  const mod = fa.gameModule;
  assert.deepEqual(mod.parseAction({ type: "answer", value: 123 }), { type: "answer", value: 123 });
  assert.equal(mod.parseAction({ type: "answer", value: -1 }), null);
  assert.equal(mod.parseAction({ type: "answer", value: 1.5 }), null);
  assert.equal(mod.parseAction({ type: "answer", value: "123" }), null);
  assert.equal(mod.parseAction({ type: "other", value: 1 }), null);
  assert.equal(mod.parseAction(null), null);

  const s = mod.createState(PLAYERS2, makeRng(31), {});
  // showing 中は回答できない。
  assert.throws(() => mod.applyAction(s, 0, { type: "answer", value: 10 }, makeRng(1)));
  assert.throws(() => mod.createState([{ seat: 0, name: "A" }], makeRng(1), {}));
  assert.throws(() =>
    mod.createState(
      Array.from({ length: 7 }, (_, i) => ({ seat: i, name: `P${i}` })),
      makeRng(1),
      {},
    ),
  );
});
