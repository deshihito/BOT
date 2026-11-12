// A42フェーズ: 内容充実第2弾の機械検証（lib のみ、UI 非依存）。
// - lib/flagquiz.ts: バンク 195組（重複なし・国コードは ISO alpha-2・追加20組の ISO 照合・出題成立）
// - lib/chesspuzzle.ts: 全15題（1手詰め7・2手詰め8）が verifyProblem を通り、
//   増量3題（cp11/cp12/cp13）がヒント手順でクリアできる
// - lib/river.ts: 全12題が BFS で解け、増量2題（doublechain/herd）の最短手数は7回
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

const fq = await loadLib("flagquiz.ts");
const cp = await loadLib("chesspuzzle.ts");
const rv = await loadLib("river.ts");

// ------------------------------------------------------------ flagquiz

test("フラッグ増量(A42): バンクは195組で重複がなく、全ての国コードが ISO alpha-2 小文字", () => {
  assert.equal(fq.FLAG_PAIRS.length, 195);
  assert.equal(new Set(fq.FLAG_PAIRS.map((p) => p.code)).size, 195);
  assert.equal(new Set(fq.FLAG_PAIRS.map((p) => p.name)).size, 195);
  for (const p of fq.FLAG_PAIRS) {
    assert.ok(/^[a-z]{2}$/.test(p.code), `${p.name} の国コード ${p.code}`);
    assert.ok(p.name.length > 0);
  }
});

test("フラッグ増量(A42): 追加20組の国名と国コード（ISO）が一致している", () => {
  const byName = new Map(fq.FLAG_PAIRS.map((p) => [p.name, p.code]));
  const added = [
    ["エルサルバドル", "SV"],
    ["ベリーズ", "BZ"],
    ["バハマ", "BS"],
    ["バルバドス", "BB"],
    ["トリニダード・トバゴ", "TT"],
    ["ナウル", "NR"],
    ["ツバル", "TV"],
    ["マーシャル諸島", "MH"],
    ["ミクロネシア", "FM"],
    ["セーシェル", "SC"],
    ["カーボベルデ", "CV"],
    ["ジブチ", "DJ"],
    ["南スーダン", "SS"],
    ["チャド", "TD"],
    ["ニジェール", "NE"],
    ["コートジボワール", "CI"],
    ["ルワンダ", "RW"],
    ["レソト", "LS"],
    ["香港", "HK"],
    ["プエルトリコ", "PR"],
  ];
  assert.equal(added.length, 20);
  for (const [name, iso] of added) {
    assert.equal(byName.get(name), iso.toLowerCase(), `${name} の国コードが ISO ${iso} と一致すること`);
  }
  // 増量後も出題が成立する（選択肢は全てバンク内・同一ゲーム内で出題が重複しない）
  for (const seed of [3, 19, 77]) {
    const game = fq.createFlagQuizGame(seed);
    assert.equal(game.questions.length, fq.FLAG_QUIZ_QUESTION_COUNT);
    const targets = new Set(game.questions.map((q) => q.target));
    assert.equal(targets.size, game.questions.length);
    for (const q of game.questions) {
      assert.equal(q.choices.length, 4);
      assert.ok(q.choices.every((i) => i >= 0 && i < fq.FLAG_PAIRS.length));
      assert.equal(q.choices[q.answerPos], q.target);
    }
  }
});

// ------------------------------------------------------------ chesspuzzle

test("詰めチェス増量(A42): 全15題（1手詰め7・2手詰め8）があり、ID と局面が重複しない", () => {
  assert.equal(cp.CHESS_PROBLEMS.length, 15);
  const ids = new Set(cp.CHESS_PROBLEMS.map((p) => p.id));
  assert.equal(ids.size, 15);
  const fens = new Set(cp.CHESS_PROBLEMS.map((p) => p.fen));
  assert.equal(fens.size, 15);
  const counts = { 1: 0, 2: 0 };
  for (const p of cp.CHESS_PROBLEMS) counts[p.mateIn] += 1;
  assert.deepEqual(counts, { 1: 7, 2: 8 });
});

test("詰めチェス増量(A42): 全問題が verifyProblem を通る（王手なし初期局面・指定手数ちょうど・初手一意）", () => {
  for (const p of cp.CHESS_PROBLEMS) {
    const v = cp.verifyProblem(p);
    assert.ok(v.ok, `${p.id} (${p.title}): ${v.reason}`);
    assert.equal(v.firstMoveCount, 1, `${p.id}: 初手は1つだけのはず`);
    const pos = cp.parseFen(p.fen);
    assert.equal(cp.isInCheck(pos.board, "b"), false, `${p.id}: 初期局面で黒に王手がかかっていない`);
  }
});

test("詰めチェス増量(A42): 増量3題が含まれ、ヒント手順でクリアでき初手が想定どおり", () => {
  const expectedFirst = { cp11: "Nf7#", cp12: "Qh5#", cp13: "Kc2+" };
  for (const id of ["cp11", "cp12", "cp13"]) {
    let state = cp.createChessPuzzleGame(id);
    const hint = cp.hintMove(state);
    assert.ok(hint, `${id}: ヒントが存在する`);
    assert.equal(
      cp.moveNotation(state.position, hint),
      expectedFirst[id],
      `${id}: 初手は ${expectedFirst[id]} のはず`,
    );
    let guard = 0;
    while (state.status === "playing" && guard++ < 10) {
      const h = cp.hintMove(state);
      assert.ok(h, `${id}: 手順が続く`);
      state = cp.playPuzzleMove(state, h);
    }
    assert.equal(state.status, "solved", `${id}: クリアできるはず`);
    const problem = cp.problemById(id);
    assert.equal(state.plies.length, problem.mateIn * 2 - 1, `${id}: 棋譜長が手数と一致`);
    assert.ok(state.plies[state.plies.length - 1].endsWith("#"), `${id}: 最終手に #`);
  }
});

// ------------------------------------------------------------ river

const RIVER_EXPECTED_A42 = {
  classic: 7, fox: 7, bigboat: 3, pets: 3, catfish: 7, flower: 3, bear: 7, farmpets: 5,
  doublechain: 7, herd: 7, pasture: 7, foxhole: 7,
};

test("川渡り増量(A42): 全12題があり、ID が重複しない", () => {
  assert.equal(rv.RIVER_PROBLEMS.length, 12);
  const ids = new Set(rv.RIVER_PROBLEMS.map((p) => p.id));
  assert.equal(ids.size, 12);
});

test("川渡り増量(A42): 全問題が BFS で解け、最短手数が既知の値と一致する", () => {
  for (const p of rv.RIVER_PROBLEMS) {
    const min = rv.riverMinCrossings(p);
    assert.ok(min > 0, `${p.id}: 解けるはず`);
    assert.equal(min, RIVER_EXPECTED_A42[p.id], `${p.id}: 最短 ${RIVER_EXPECTED_A42[p.id]} 回のはず`);
  }
});

test("川渡り増量(A42): 増量2題の危険ペアが実在の荷物だけを指し、危険な残し方で失敗する", () => {
  for (const id of ["doublechain", "herd"]) {
    const p = rv.getRiverProblem(id);
    assert.equal(p.id, id);
    const itemIds = new Set(p.items.map((i) => i.id));
    assert.equal(itemIds.size, p.items.length, `${id}: 荷物 ID が重複しない`);
    for (const item of p.items) {
      assert.ok(item.name.length > 0 && item.kanji.length === 1 && /^#[0-9a-f]{6}$/.test(item.color), `${id}: 荷物に名前と漢字チップ（1字＋色）がある`);
    }
    for (const [x, y] of p.dangerPairs) {
      assert.ok(itemIds.has(x) && itemIds.has(y), `${id}: 危険ペア ${x}/${y} が実在する`);
      assert.notEqual(x, y, `${id}: 危険ペアは相異なる2つ`);
    }
    assert.ok(p.capacity >= 1 && p.capacity < p.items.length, `${id}: 定員が妥当`);
  }
  // doublechain: ヤギだけ先に運ぶと左岸にキツネとニワトリが残って失敗する
  let s1 = rv.createRiverGame("doublechain");
  s1 = rv.toggleRiverItem(s1, "goat");
  s1 = rv.crossRiver(s1);
  assert.equal(s1.status, "failed");
  assert.ok(s1.failMessage?.includes("キツネ"), s1.failMessage ?? "");
  // herd: イヌだけ先に運ぶと左岸にオオカミとヒツジが残って失敗する
  let s2 = rv.createRiverGame("herd");
  s2 = rv.toggleRiverItem(s2, "dog");
  s2 = rv.crossRiver(s2);
  assert.equal(s2.status, "failed");
  assert.ok(s2.failMessage?.includes("ヒツジ"), s2.failMessage ?? "");
});
