// A47フェーズ: 内容充実第3弾の機械検証（lib のみ、UI 非依存）。
// - lib/chesspuzzle.ts: 全15題（1手詰め7・2手詰め8）が verifyProblem を通り、
//   増量2題（cp14/cp15）がヒント手順でクリアできる
// - lib/river.ts: 全12題が BFS で解け、増量2題（pasture/foxhole）の最短手数は7回で、
//   最短手順で実際に勝利でき、危険な残し方で失敗する
// - lib/kwordle.ts: 答えバンクは90語・全て実在の5文字カタカナ語形式で重複なし、
//   増量30語のいずれも答えとして勝てる
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

const cp = await loadLib("chesspuzzle.ts");
const rv = await loadLib("river.ts");
const kw = await loadLib("kwordle.ts");

// ------------------------------------------------------------ chesspuzzle

test("詰めチェス増量(A47): 全15題（1手詰め7・2手詰め8）があり、ID と局面が重複しない", () => {
  assert.equal(cp.CHESS_PROBLEMS.length, 15);
  const ids = new Set(cp.CHESS_PROBLEMS.map((p) => p.id));
  assert.equal(ids.size, 15);
  const fens = new Set(cp.CHESS_PROBLEMS.map((p) => p.fen));
  assert.equal(fens.size, 15);
  const counts = { 1: 0, 2: 0 };
  for (const p of cp.CHESS_PROBLEMS) counts[p.mateIn] += 1;
  assert.deepEqual(counts, { 1: 7, 2: 8 });
});

test("詰めチェス増量(A47): 全問題が verifyProblem を通る（王手なし初期局面・指定手数ちょうど・初手一意）", () => {
  for (const p of cp.CHESS_PROBLEMS) {
    const v = cp.verifyProblem(p);
    assert.ok(v.ok, `${p.id} (${p.title}): ${v.reason}`);
    assert.equal(v.firstMoveCount, 1, `${p.id}: 初手は1つだけのはず`);
    const pos = cp.parseFen(p.fen);
    assert.equal(cp.isInCheck(pos.board, "b"), false, `${p.id}: 初期局面で黒に王手がかかっていない`);
  }
});

test("詰めチェス増量(A47): 増量2題が含まれ、ヒント手順でクリアでき初手が想定どおり", () => {
  const expectedFirst = { cp14: "Bb7#", cp15: "Bc5+" };
  for (const id of ["cp14", "cp15"]) {
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

const RIVER_EXPECTED_A47 = {
  classic: 7, fox: 7, bigboat: 3, pets: 3, catfish: 7, flower: 3, bear: 7, farmpets: 5,
  doublechain: 7, herd: 7, pasture: 7, foxhole: 7,
};

test("川渡り増量(A47): 全12題があり、ID が重複しない", () => {
  assert.equal(rv.RIVER_PROBLEMS.length, 12);
  const ids = new Set(rv.RIVER_PROBLEMS.map((p) => p.id));
  assert.equal(ids.size, 12);
});

test("川渡り増量(A47): 全問題が BFS で解け、最短手数が既知の値と一致する", () => {
  for (const p of rv.RIVER_PROBLEMS) {
    const min = rv.riverMinCrossings(p);
    assert.ok(min > 0, `${p.id}: 解けるはず`);
    assert.equal(min, RIVER_EXPECTED_A47[p.id], `${p.id}: 最短 ${RIVER_EXPECTED_A47[p.id]} 回のはず`);
  }
});

test("川渡り増量(A47): 増量2題の危険ペアが実在の荷物だけを指している", () => {
  for (const id of ["pasture", "foxhole"]) {
    const p = rv.getRiverProblem(id);
    assert.equal(p.id, id);
    const itemIds = new Set(p.items.map((i) => i.id));
    assert.equal(itemIds.size, p.items.length, `${id}: 荷物 ID が重複しない`);
    for (const item of p.items) {
      assert.ok(item.name.length > 0 && item.emoji.length > 0, `${id}: 荷物に名前と絵文字がある`);
    }
    for (const [x, y] of p.dangerPairs) {
      assert.ok(itemIds.has(x) && itemIds.has(y), `${id}: 危険ペア ${x}/${y} が実在する`);
      assert.notEqual(x, y, `${id}: 危険ペアは相異なる2つ`);
    }
    assert.ok(p.capacity >= 1 && p.capacity < p.items.length, `${id}: 定員が妥当`);
  }
});

test("川渡り増量(A47): 増量2題は最短手順で実際に勝利できる", () => {
  // pasture: ヒツジ+ヤギ → ヒツジ戻し → オオカミ+キャベツ → ヤギ戻し → ヒツジ+ニンジン → ヒツジ戻し → ヤギ+ヒツジ
  let s1 = rv.createRiverGame("pasture");
  const seq1 = [
    ["sheep", "goat"], ["sheep"], ["wolf", "cabbage"], ["goat"],
    ["sheep", "carrot"], ["sheep"], ["goat", "sheep"],
  ];
  seq1.forEach((carryIds, i) => {
    for (const id of carryIds) s1 = rv.toggleRiverItem(s1, id);
    s1 = rv.crossRiver(s1);
    if (i < seq1.length - 1) assert.equal(s1.status, "playing", `pasture: 手順 ${i + 1} で失敗しない`);
  });
  assert.equal(s1.status, "won", "pasture: 勝利するはず");
  assert.equal(s1.crossings, 7);
  assert.equal(s1.crossings, rv.riverMinCrossings(rv.getRiverProblem("pasture")));
  // foxhole: ウサギ+ニワトリ → ウサギ戻し → キツネ+ニンジン → キツネ戻し → キツネ+トウモロコシ → ニワトリ戻し → ウサギ+ニワトリ
  let s2 = rv.createRiverGame("foxhole");
  const seq2 = [
    ["rabbit", "chicken"], ["rabbit"], ["fox", "carrot"], ["fox"],
    ["fox", "corn"], ["chicken"], ["rabbit", "chicken"],
  ];
  seq2.forEach((carryIds, i) => {
    for (const id of carryIds) s2 = rv.toggleRiverItem(s2, id);
    s2 = rv.crossRiver(s2);
    if (i < seq2.length - 1) assert.equal(s2.status, "playing", `foxhole: 手順 ${i + 1} で失敗しない (${s2.failMessage ?? ""})`);
  });
  assert.equal(s2.status, "won", "foxhole: 勝利するはず");
  assert.equal(s2.crossings, 7);
  assert.equal(s2.crossings, rv.riverMinCrossings(rv.getRiverProblem("foxhole")));
});

test("川渡り増量(A47): 増量2題は危険な残し方で失敗する", () => {
  // pasture: キャベツだけ先に運ぶと左岸にオオカミとヒツジが残って失敗する
  let s1 = rv.createRiverGame("pasture");
  s1 = rv.toggleRiverItem(s1, "cabbage");
  s1 = rv.crossRiver(s1);
  assert.equal(s1.status, "failed");
  assert.ok(s1.failMessage?.includes("ヒツジ"), s1.failMessage ?? "");
  // foxhole: ニンジンだけ先に運ぶと左岸にキツネとウサギが残って失敗する
  let s2 = rv.createRiverGame("foxhole");
  s2 = rv.toggleRiverItem(s2, "carrot");
  s2 = rv.crossRiver(s2);
  assert.equal(s2.status, "failed");
  assert.ok(s2.failMessage?.includes("ウサギ"), s2.failMessage ?? "");
});

// ------------------------------------------------------------ kwordle

const KWORDLE_ADDED_A47 = [
  "ケチャップ", "マヨネーズ", "キャラメル", "パンケーキ", "ティラミス",
  "モンブラン", "ウインナー", "サツマイモ", "ジャガイモ", "ワラビモチ",
  "カキゴオリ", "スムージー", "シャンパン", "ウイスキー", "ニホンシュ",
  "オヤコドン", "オポッサム", "チンアナゴ", "フラミンゴ", "ハクチョウ",
  "アホウドリ", "キリギリス", "スズメバチ", "ダンゴムシ", "アライグマ",
  "ユキウサギ", "ボクシング", "レスリング", "ボブスレー", "フリスビー",
];

test("カタカナワードル増量(A47): 答えバンクは90語で重複がなく、全て5文字カタカナ", () => {
  assert.equal(kw.KWORDLE_ANSWERS.length, 90);
  assert.equal(new Set(kw.KWORDLE_ANSWERS).size, 90);
  for (const word of kw.KWORDLE_ANSWERS) {
    assert.equal([...word].length, kw.KWORDLE_LENGTH, word);
    assert.ok(kw.isValidKwordleGuess(word), `${word}: 推測として妥当な形式`);
    for (const ch of [...word]) assert.ok(kw.isKanaChar(ch), `${word}: カタカナのみ`);
  }
});

test("カタカナワードル増量(A47): 増量30語が全て含まれ、答えとして勝てる", () => {
  assert.equal(KWORDLE_ADDED_A47.length, 30);
  for (const word of KWORDLE_ADDED_A47) {
    assert.ok(kw.KWORDLE_ANSWERS.includes(word), `${word}: バンクに含まれる`);
    const state = kw.createKwordleGameWithAnswer(word);
    const res = kw.submitKwordleGuess(state, word);
    assert.equal(res.error, null, `${word}: 推測が受理される`);
    assert.equal(res.state.status, "won", `${word}: 答えを当てて勝てる`);
    assert.deepEqual(
      res.state.marks[0],
      ["correct", "correct", "correct", "correct", "correct"],
      `${word}: 全て correct`,
    );
  }
});

test("カタカナワードル増量(A47): 増量後もシードからバンク内の答えが選ばれる", () => {
  for (const seed of [0, 1, 42, 12345, -7]) {
    assert.ok(kw.KWORDLE_ANSWERS.includes(kw.pickKwordleAnswer(seed)), `seed ${seed}`);
  }
});
