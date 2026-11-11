// A34フェーズの検証。
// - lib/chesspuzzle.ts: 収録問題の機械検証（指定手数ちょうど・初手一意）・合法手・進行と応手・1手戻す
// - lib/balancestack.ts: 安定判定（重心と支持範囲）・崩壊・決定性・クランプ
// - lib/online/games/drawguess.ts: お題バンク増量分（130語・形式・重複なし）
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
  const code = stripModuleSyntax(js) + "\nexport { DG_WORDS };\n";
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const cp = await loadLib("chesspuzzle.ts");
const bs = await loadLib("balancestack.ts");
const dg = await loadDrawGuess();

// ---------------------------------------------------------------- chesspuzzle

test("詰めチェス: 収録問題が6題以上あり、全題が機械検証を通る（指定手数ちょうど・初手一意）", () => {
  assert.ok(cp.CHESS_PROBLEMS.length >= 6, `問題数 ${cp.CHESS_PROBLEMS.length}`);
  const ids = new Set(cp.CHESS_PROBLEMS.map((p) => p.id));
  assert.equal(ids.size, cp.CHESS_PROBLEMS.length);
  for (const problem of cp.CHESS_PROBLEMS) {
    const v = cp.verifyProblem(problem);
    assert.ok(v.ok, `${problem.id} (${problem.title}): ${v.reason}`);
    assert.equal(v.firstMoveCount, 1);
    assert.ok(problem.mateIn === 1 || problem.mateIn === 2, `${problem.id} は1手/2手詰め中心`);
  }
});

test("詰めチェス: 初期局面は黒に王手がかかっておらず、白の王手候補が存在する", () => {
  for (const problem of cp.CHESS_PROBLEMS) {
    const pos = cp.parseFen(problem.fen);
    assert.equal(cp.isInCheck(pos.board, "b"), false, problem.id);
    const state = cp.createChessPuzzleGame(problem.id);
    assert.equal(state.status, "playing");
    assert.ok(cp.playableMoves(state).length >= 1, problem.id);
  }
});

test("詰めチェス: 王手でない手は進まず、状態が変わらない", () => {
  const state = cp.createChessPuzzleGame(cp.CHESS_PROBLEMS[0].id);
  const legal = cp.legalMoves(state.position, "w");
  const playable = cp.playableMoves(state);
  const nonChecking = legal.filter(
    (m) => !playable.some((p) => p.from === m.from && p.to === m.to && (p.promotion ?? "Q") === (m.promotion ?? "Q")),
  );
  assert.ok(nonChecking.length >= 1, "王手でない合法手が存在する局面であること");
  const after = cp.playPuzzleMove(state, nonChecking[0]);
  assert.deepEqual(after, state);
});

test("詰めチェス: ヒント手順どおりに指せば全題クリアでき、棋譜が手数と一致する", () => {
  for (const problem of cp.CHESS_PROBLEMS) {
    let state = cp.createChessPuzzleGame(problem.id);
    let guard = 0;
    while (state.status === "playing" && guard++ < 10) {
      const hint = cp.hintMove(state);
      assert.ok(hint, `${problem.id}: ヒントが存在する`);
      state = cp.playPuzzleMove(state, hint);
    }
    assert.equal(state.status, "solved", problem.id);
    // 棋譜は白と黒の交互。最後は白の詰み手で終わる。
    assert.equal(state.plies.length, problem.mateIn * 2 - 1, `${problem.id} の棋譜長`);
    assert.ok(state.plies[state.plies.length - 1].endsWith("#"), `${problem.id} の最終手に #`);
    // 1手戻すと playing に戻る。
    const back = cp.undoPuzzleMove(state);
    assert.equal(back.status, "playing", problem.id);
  }
});

test("詰めチェス: 合法手生成の基本（キングは隣接できない・取れる駒は取れる）", () => {
  // 白K e1 / 黒K e3: 白キングは e2/d2/f2（黒キングの利き）へ動けない。
  const pos = cp.parseFen("8/8/8/8/8/4k3/8/4K3 w - - 0 1");
  const kingMoves = cp.legalMoves(pos, "w").filter((m) => pos.board[m.from]?.type === "K");
  const dests = kingMoves.map((m) => cp.squareName(m.to)).sort();
  assert.deepEqual(dests, ["d1", "f1"]);
  // ポーンの前進と斜め取り。
  const pos2 = cp.parseFen("8/8/8/3p4/4P3/8/8/4K2k w - - 0 1");
  const pawnMoves = cp
    .legalMoves(pos2, "w")
    .filter((m) => cp.squareName(m.from) === "e4")
    .map((m) => cp.squareName(m.to))
    .sort();
  assert.deepEqual(pawnMoves, ["d5", "e5"]);
});

test("詰めチェス: 2手詰めは黒の応手が自動で1つ入り、手数が進む", () => {
  const problem = cp.CHESS_PROBLEMS.find((p) => p.mateIn === 2);
  assert.ok(problem);
  let state = cp.createChessPuzzleGame(problem.id);
  const hint = cp.hintMove(state);
  state = cp.playPuzzleMove(state, hint);
  assert.equal(state.status, "playing");
  assert.equal(state.plies.length, 2, "白の手と黒の応手で2手分");
  assert.ok(state.lastReply, "黒の応手が記録される");
  assert.equal(state.history.length, 1);
  const back = cp.undoPuzzleMove(state);
  assert.equal(back.plies.length, 0);
  assert.deepEqual(back.position, cp.parseFen(problem.fen));
});

// ---------------------------------------------------------------- balancestack

test("バランスタワー: 同じシードでは同じブロック列になる（決定性）", () => {
  const a = bs.createBalanceGame(42);
  const b = bs.createBalanceGame(42);
  assert.deepEqual(a.current, b.current);
  const a2 = bs.placeBlock(a, 50);
  const b2 = bs.placeBlock(b, 50);
  assert.deepEqual(a2.current, b2.current);
  assert.deepEqual(a2.blocks, b2.blocks);
});

test("バランスタワー: 真ん中に積めば安定し、スコアが増える", () => {
  let state = bs.createBalanceGame(7);
  state = bs.placeBlock(state, 50);
  assert.equal(state.status, "playing");
  assert.equal(state.score, 1);
  assert.equal(state.blocks.length, 1);
  assert.ok(state.lastMargin !== null && state.lastMargin >= 0);
});

test("バランスタワー: 土台から外れる位置では崩れる", () => {
  const state = bs.createBalanceGame(7);
  // 土台は [35,65]。中心10に置けば接触区間が空になり崩壊する。
  const after = bs.placeBlock(state, 10);
  assert.equal(after.status, "collapsed");
  assert.equal(after.collapsedLevel, 0);
  assert.equal(after.score, 0);
  // 崩壊後はそれ以上積めない。
  assert.deepEqual(bs.placeBlock(after, 50), after);
});

test("バランスタワー: 重心が支持範囲を外れる積み方では上の段で崩れる", () => {
  // 1段目は重く右寄せ（全体の重心はまだ土台との接触区間内）、
  // 2段目は軽いが大きく右へはみ出し、その段の接触区間から重心が外れる。
  const blocks = [
    { center: 55, width: 32, weight: 3 },
    { center: 79, width: 32, weight: 1 },
  ];
  const result = bs.checkStability(blocks);
  assert.equal(result.stable, false);
  // 全体の重心 (3*55+79)/4 = 61 は土台との接触 [39,65] 内だが、
  // 2段目の接触区間 [63,71] に対して重心79は外れる。
  assert.equal(result.failLevel, 1);
  // 全て中央なら安定。
  const ok = bs.checkStability([
    { center: 50, width: 32, weight: 1 },
    { center: 52, width: 20, weight: 3 },
    { center: 49, width: 24, weight: 2 },
  ]);
  assert.equal(ok.stable, true);
  assert.ok(ok.minMargin > 0);
});

test("バランスタワー: 位置は盤面内にクランプされる", () => {
  assert.equal(bs.clampCenter(-50, 20), 10);
  assert.equal(bs.clampCenter(150, 20), 90);
  const state = bs.createBalanceGame(3);
  const after = bs.placeBlock(state, -100);
  const placed = after.blocks[after.blocks.length - 1];
  assert.equal(placed.center, state.current.width / 2);
});

test("バランスタワー: プレビューは状態を変えず、崩れる位置を事前に示す", () => {
  const state = bs.createBalanceGame(11);
  const before = JSON.stringify(state);
  const bad = bs.previewStability(state, 5);
  assert.equal(bad.stable, false);
  const good = bs.previewStability(state, 50);
  assert.equal(good.stable, true);
  assert.equal(JSON.stringify(state), before);
});

test("バランスタワー: 中央積みを続けると複数段積める（自動プレイ）", () => {
  let state = bs.createBalanceGame(99);
  let guard = 0;
  while (state.status === "playing" && guard++ < 30) {
    // 全体の重心に合わせて置くと長く積める。
    const com = bs.overallCenterOfMass(state.blocks);
    state = bs.placeBlock(state, state.blocks.length === 0 ? 50 : com);
  }
  assert.ok(state.score >= 5, `中央寄せで ${state.score} 個積めた`);
});

// ---------------------------------------------------------------- drawguess 増量

test("お絵かき当て: バンクが150語で、重複がなく、全てかな表記の具体名詞形式", () => {
  assert.equal(dg.DG_WORDS.length, 150);
  assert.equal(new Set(dg.DG_WORDS).size, dg.DG_WORDS.length);
  for (const word of dg.DG_WORDS) {
    assert.ok(/^[ぁ-んァ-ヶー]+$/.test(word), `かな表記でない語: ${word}`);
    assert.ok(word.length >= 1 && word.length <= 8, `長さが範囲外: ${word}`);
  }
  // 増量分の代表語が含まれている。
  for (const added of ["とら", "らくだ", "ラーメン", "たこやき", "チョコレート", "テレビ", "かぎ"]) {
    assert.ok(dg.DG_WORDS.includes(added), `増量語 ${added} がない`);
  }
});
