// A30フェーズの新規2本＋増量のロジック検証。
// - lib/tsume.ts: 合法手（二歩・行き場のない駒・打ち歩詰め）・王手/詰み判定・
//   収録問題は全てソルバーで「指定手数・初手一意」を検証
// - lib/bowling.ts: 正式スコア計算（既知ケース）・ピン倒れモデルの決定性・全ゲーム進行
// - lib/online/games/wordwolf.ts: お題ペア 60組・形式・単語の重複なし
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
const bowling = await loadLib("bowling.ts");
const wordwolf = await loadOnline("wordwolf.ts", ["gameModule", "WORDWOLF_PAIRS"]);

function barePosition(boardEntries, handA = {}, handD = {}) {
  const board = Array.from({ length: 81 }, () => null);
  for (const [at, piece, side] of boardEntries) {
    board[tsume.indexOfSquare(at)] = { piece, side };
  }
  return { board, handA, handD };
}

// ------------------------------------------------------------ tsume: problems

test("詰将棋: 収録問題は全て指定手数で詰み、初手が1つだけに定まる", () => {
  assert.ok(tsume.TSUME_PROBLEMS.length >= 4);
  const counts = { 1: 0, 3: 0 };
  for (const p of tsume.TSUME_PROBLEMS) {
    counts[p.moves] += 1;
    const pos = tsume.problemPosition(p);
    assert.equal(tsume.inCheck(pos, "D"), false, `${p.id}: 初期局面で玉が王手状態ではいけない`);
    const sol = tsume.solveTsume(pos, p.moves);
    assert.equal(sol.mate, true, `${p.id}: 詰むはず`);
    assert.equal(sol.moves, p.moves, `${p.id}: ${p.moves}手詰めのはず`);
    assert.equal(sol.winningFirstMoves.length, 1, `${p.id}: 初手は一意のはず`);
  }
  assert.ok(counts[1] >= 1 && counts[3] >= 1, "1手詰めと3手詰めの両方があること");
});

test("詰将棋: 頭金の正解手を指すと詰みになる（王手・詰み判定）", () => {
  const p = tsume.TSUME_PROBLEMS.find((x) => x.moves === 1);
  const pos = tsume.problemPosition(p);
  const sol = tsume.solveTsume(pos, 1);
  const next = tsume.applyMove(pos, sol.winningFirstMoves[0]);
  assert.equal(tsume.inCheck(next, "D"), true);
  assert.equal(tsume.isMated(next), true);
  assert.equal(tsume.generateMoves(next, "D").length, 0);
});

// ------------------------------------------------------------ tsume: rules

test("詰将棋: 二歩の筋には歩を打てない", () => {
  const pos = barePosition(
    [["11", "K", "D"], ["55", "P", "A"]],
    { P: 1 },
  );
  const drops = tsume.generateMoves(pos, "A").filter((m) => m.drop === "P");
  assert.ok(drops.length > 0);
  // 5筋（x=4）のマスへの歩打ちは全て禁止
  assert.ok(drops.every((m) => m.to % 9 !== 4));
});

test("詰将棋: 行き場のない駒は打てない（歩・香は1段目、桂は1・2段目）", () => {
  const pos = barePosition([["99", "K", "D"]], { P: 1, L: 1, N: 1 });
  const moves = tsume.generateMoves(pos, "A");
  const dropsOf = (b) => moves.filter((m) => m.drop === b).map((m) => Math.floor(m.to / 9));
  assert.ok(dropsOf("P").every((y) => y >= 1));
  assert.ok(dropsOf("L").every((y) => y >= 1));
  assert.ok(dropsOf("N").every((y) => y >= 2));
  assert.ok(dropsOf("P").length > 0 && dropsOf("N").length > 0);
});

test("詰将棋: 打ち歩詰めは合法手から除かれる（歩打ちで詰む形）", () => {
  // 玉11、攻め方: 金32・銀31・角56。12への歩打ちは角に守られ、
  // 逃げ場も金と銀に塞がれて詰みになるため、打ち歩詰めとして禁止される。
  const pos = barePosition(
    [["11", "K", "D"], ["32", "G", "A"], ["31", "S", "A"], ["56", "B", "A"]],
    { P: 1 },
  );
  const pawnDropTo12 = tsume.generateMoves(pos, "A").some(
    (m) => m.drop === "P" && m.to === tsume.indexOfSquare("12"),
  );
  assert.equal(pawnDropTo12, false);
  // 参考: ルールを無視して歩を打つと実際に詰みになることを確認する
  const forced = tsume.applyMove(pos, {
    side: "A", from: -1, to: tsume.indexOfSquare("12"), piece: "P", drop: "P", promote: false,
  });
  assert.equal(tsume.isMated(forced), true);
  // 王手でない歩打ち（別のマス）は通常どおり指せる
  assert.ok(tsume.generateMoves(pos, "A").some((m) => m.drop === "P"));
});

test("詰将棋: 銀の動きは前と斜めの5方向だけ", () => {
  const pos = barePosition([["11", "K", "D"], ["55", "S", "A"]]);
  const from = tsume.indexOfSquare("55");
  const dests = tsume.generateMoves(pos, "A")
    .filter((m) => m.from === from)
    .map((m) => m.to)
    .sort((a, b) => a - b);
  const expected = ["54", "44", "64", "46", "66"]
    .map((s) => tsume.indexOfSquare(s))
    .sort((a, b) => a - b);
  assert.deepEqual(dests, expected);
});

test("詰将棋: ゲーム進行（ソルバーの手順どおり指すと全問題クリアできる）", () => {
  for (const p of tsume.TSUME_PROBLEMS) {
    let state = tsume.createTsumeGame(p.id);
    let guard = 0;
    while (state.status === "playing" && guard < 10) {
      guard++;
      const sol = tsume.solveTsume(state.pos, p.moves - state.movesUsed);
      assert.equal(sol.mate, true, `${p.id}: 途中で詰み筋が消えてはいけない`);
      state = tsume.playAttackerMove(state, sol.winningFirstMoves[0]);
    }
    assert.equal(state.status, "cleared", `${p.id}: クリアできるはず`);
    assert.ok(state.movesUsed <= p.moves);
  }
});

test("詰将棋: 王手でない手は進められず、1手戻すで初期局面に戻る", () => {
  const p = tsume.TSUME_PROBLEMS.find((x) => x.moves === 1);
  let state = tsume.createTsumeGame(p.id);
  const nonCheck = tsume.attackerMoves(state).find(
    (m) => !tsume.inCheck(tsume.applyMove(state.pos, m), "D"),
  );
  assert.ok(nonCheck, "王手でない手が存在する前提");
  const after = tsume.playAttackerMove(state, nonCheck);
  assert.equal(after.movesUsed, 0);
  assert.deepEqual(after.pos, state.pos);
  assert.match(after.message, /王手/);

  const three = tsume.TSUME_PROBLEMS.find((x) => x.moves === 3);
  let s3 = tsume.createTsumeGame(three.id);
  const sol = tsume.solveTsume(s3.pos, 3);
  s3 = tsume.playAttackerMove(s3, sol.winningFirstMoves[0]);
  assert.equal(s3.movesUsed, 1);
  const back = tsume.undoAttackerMove(s3);
  assert.equal(back.movesUsed, 0);
  assert.deepEqual(back.pos, tsume.problemPosition(three));
});

// ------------------------------------------------------------ bowling: scoring

test("ボウリング: パーフェクトゲームは300点", () => {
  assert.equal(bowling.scoreRolls(Array.from({ length: 12 }, () => 10)), 300);
});

test("ボウリング: 全フレームスペア（5・5）は150点", () => {
  const rolls = [];
  for (let i = 0; i < 10; i++) rolls.push(5, 5);
  rolls.push(5);
  assert.equal(bowling.scoreRolls(rolls), 150);
});

test("ボウリング: 全てガターは0点、全て9・0は90点", () => {
  assert.equal(bowling.scoreRolls(Array.from({ length: 20 }, () => 0)), 0);
  const rolls = [];
  for (let i = 0; i < 10; i++) rolls.push(9, 0);
  assert.equal(bowling.scoreRolls(rolls), 90);
});

test("ボウリング: 既知のサンプルゲームは133点（公式例）", () => {
  const rolls = [1, 4, 4, 5, 6, 4, 5, 5, 10, 0, 1, 7, 3, 6, 4, 10, 2, 8, 6];
  assert.equal(bowling.scoreRolls(rolls), 133);
  const frames = bowling.frameScores(rolls);
  assert.equal(frames[9], 133);
});

test("ボウリング: フレーム途中では未確定フレームが null になる", () => {
  const frames = bowling.frameScores([10]);
  assert.equal(frames[0], null);
  assert.equal(bowling.frameScores([3, 4])[0], 7);
  assert.equal(bowling.frameScores([5, 5])[0], null); // スペアは次の1投待ち
  assert.equal(bowling.frameScores([5, 5, 3])[0], 13);
});

// ------------------------------------------------------------ bowling: pin model

test("ボウリング: 倒れ方モデルは決定的で、好投では多く倒れる", () => {
  const full = Array.from({ length: 10 }, () => true);
  const a = bowling.computeKnocked(full, 0.2, 80, 42);
  const b = bowling.computeKnocked(full, 0.2, 80, 42);
  assert.deepEqual(a.knocked, b.knocked);
  assert.ok(a.knocked.filter(Boolean).length >= 6);
});

test("ボウリング: レーンを外れた狙いでは1本も倒れない", () => {
  const full = Array.from({ length: 10 }, () => true);
  assert.equal(bowling.computeKnocked(full, bowling.AIM_MAX, 80, 1).knocked.filter(Boolean).length, 0);
  assert.equal(bowling.computeKnocked(full, bowling.AIM_MIN, 80, 1).knocked.filter(Boolean).length, 0);
});

test("ボウリング: ストライクを取るとフレームが進みラックが戻る種がある", () => {
  let found = null;
  for (let seed = 0; seed < 500 && !found; seed++) {
    const g = bowling.createBowlingGame(seed);
    const r = bowling.throwBall(g, 0.2, 80);
    if (r.knocked === 10) found = r.state;
  }
  assert.ok(found, "500種の中にストライクが出るはず");
  assert.equal(found.frame, 1);
  assert.equal(found.ballInFrame, 0);
  assert.ok(found.standing.every(Boolean));
});

test("ボウリング: 自動プレイで最後まで進行し、投球数とスコアが整合する", () => {
  for (let seed = 0; seed < 30; seed++) {
    let g = bowling.createBowlingGame(seed * 7 + 1);
    let guard = 0;
    while (!g.finished && guard < 30) {
      guard++;
      g = bowling.throwBall(g, 0.2, 80).state;
    }
    assert.equal(g.finished, true, `seed ${seed}: 終了するはず`);
    // 最小は 9ストライク+10フレーム目オープン の11投、最大は全フレーム2投+3投目の21投
    assert.ok(g.rolls.length >= 11 && g.rolls.length <= 21, `seed ${seed}: 投球数 ${g.rolls.length}`);
    const frames = bowling.frameScores(g.rolls);
    assert.notEqual(frames[9], null);
    assert.equal(bowling.scoreRolls(g.rolls), frames[9]);
  }
});

// ------------------------------------------------------------ wordwolf bank

test("ワードウルフ: お題ペアは80組で、全ての単語が重複しない", () => {
  const pairs = wordwolf.WORDWOLF_PAIRS;
  assert.equal(pairs.length, 80);
  const words = new Set();
  for (const p of pairs) {
    assert.equal(typeof p.majority, "string");
    assert.equal(typeof p.minority, "string");
    assert.ok(p.majority.length > 0 && p.minority.length > 0);
    assert.notEqual(p.majority, p.minority);
    assert.ok(!words.has(p.majority), `重複: ${p.majority}`);
    assert.ok(!words.has(p.minority), `重複: ${p.minority}`);
    words.add(p.majority);
    words.add(p.minority);
  }
  assert.equal(words.size, 160);
});
