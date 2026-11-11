// A24フェーズ新規3本のロジック検証（lib のみ、UI 非依存）。
// - lib/alphametic.ts: 生成の一意性・決定性・割り当て検証・解による勝利
// - lib/river.ts: 最短手数（BFS）・最短手順での勝利・失敗判定・積み下ろし規則
// - lib/online/games/simonbattle.ts: 再生→入力→追加の進行・脱落・秘匿・退出
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

const al = await loadLib("alphametic.ts");
const rv = await loadLib("river.ts");
const sb = await loadOnline("simonbattle.ts", [
  "gameModule",
  "SB_PAD_COUNT",
  "SB_SHOW_INTERVAL_MS",
  "SB_ADD_LIMIT_MS",
]);

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

// ---- 覆面算 ----

test("覆面算: 同じシードでは同じ問題になり、解はちょうど1つだけ", () => {
  for (const seed of [1, 2, 3, 42, 777, 12345]) {
    const a = al.createAlphameticGame(seed);
    const b = al.createAlphameticGame(seed);
    assert.equal(a.a, b.a);
    assert.equal(a.b, b.b);
    assert.equal(a.c, b.c);
    assert.deepEqual(a.solution, b.solution);
    assert.ok(a.symbols.length >= 4 && a.symbols.length <= 6, `seed ${seed}`);
    assert.equal(al.countAlphameticSolutions(a.a, a.b, a.c, 2), 1, `seed ${seed} の一意性`);
    // 解を当てはめると等式が成り立つ
    assert.equal(
      al.alphameticTermValue(a.a, a.solution) + al.alphameticTermValue(a.b, a.solution),
      al.alphameticTermValue(a.c, a.solution),
      `seed ${seed} の解`,
    );
    // 先頭の記号に 0 は入っていない
    for (const s of a.leading) assert.notEqual(a.solution[s], 0);
    assert.equal(a.status, "playing");
    assert.deepEqual(a.guesses, {});
  }
});

test("覆面算: 解の割り当てを入力すると勝利し、検証が complete/holds になる", () => {
  let s = al.createAlphameticGame(42);
  for (const [symbol, digit] of Object.entries(s.solution)) {
    s = al.setAlphameticGuess(s, symbol, digit);
  }
  const ev = al.evaluateAlphametic(s);
  assert.equal(ev.complete, true);
  assert.equal(ev.holds, true);
  assert.equal(s.status, "won");
  // 勝利後の変更は無効
  assert.equal(al.setAlphameticGuess(s, s.symbols[0], null), s);
});

test("覆面算: 不正な割り当ては同状態を返す（重複・先頭0・範囲外・未知の記号）", () => {
  const g = al.createAlphameticGame(7);
  const [s0, s1] = g.symbols;
  const placed = al.setAlphameticGuess(g, s0, g.solution[s0]);
  assert.notEqual(placed, g);
  // 同じ数字を別の記号には使えない
  assert.equal(al.setAlphameticGuess(placed, s1, g.solution[s0]), placed);
  // 先頭の記号に 0 は置けない
  const leading = g.leading[0];
  assert.equal(al.setAlphameticGuess(g, leading, 0), g);
  // 範囲外・非整数・未知の記号
  assert.equal(al.setAlphameticGuess(g, s0, 10), g);
  assert.equal(al.setAlphameticGuess(g, s0, -1), g);
  assert.equal(al.setAlphameticGuess(g, s0, 1.5), g);
  assert.equal(al.setAlphameticGuess(g, "ヰ", 3), g);
  // 解除できる（未割り当ての解除は同状態）
  assert.equal(al.setAlphameticGuess(g, s0, null), g);
  const cleared = al.setAlphameticGuess(placed, s0, null);
  assert.deepEqual(cleared.guesses, {});
});

test("覆面算: 間違った割り当てでは等式が成り立たず勝利しない", () => {
  const g = al.createAlphameticGame(99);
  // 解と異なる割り当てを作る（先頭0と重複を避けながら、解から2記号の数字を入れ替える）
  const entries = Object.entries(g.solution);
  const swapped = { ...g.solution };
  const [[symA, digA], [symB, digB]] = entries;
  swapped[symA] = digB;
  swapped[symB] = digA;
  // 入れ替えで先頭に 0 が来る場合はこのテスト対象外（生成の都合で稀にある）
  if (g.leading.includes(symA) && digB === 0) return;
  if (g.leading.includes(symB) && digA === 0) return;
  let s = g;
  for (const [symbol, digit] of Object.entries(swapped)) {
    s = al.setAlphameticGuess(s, symbol, digit);
  }
  const ev = al.evaluateAlphametic(s);
  assert.equal(ev.complete, true);
  assert.equal(ev.holds, false);
  assert.equal(s.status, "playing");
});

// ---- 川渡り ----

test("川渡り: 問題は12題あり、全て解けて最短手数が既知の値と一致する", () => {
  assert.equal(rv.RIVER_PROBLEMS.length, 12);
  const expected = { classic: 7, fox: 7, bigboat: 3, pets: 3, catfish: 7, flower: 3, bear: 7, farmpets: 5, doublechain: 7, herd: 7, pasture: 7, foxhole: 7 };
  for (const p of rv.RIVER_PROBLEMS) {
    assert.equal(rv.riverMinCrossings(p), expected[p.id], p.id);
  }
});

test("川渡り: クラシック題は最短手順で7回渡って勝利する", () => {
  let s = rv.createRiverGame("classic");
  const carry = (id) => {
    s = rv.toggleRiverItem(s, id);
    s = rv.crossRiver(s);
  };
  const back = (id) => {
    if (id) s = rv.toggleRiverItem(s, id);
    s = rv.crossRiver(s);
  };
  carry("goat");
  back(null);
  carry("wolf");
  back("goat");
  carry("cabbage");
  back(null);
  carry("goat");
  assert.equal(s.status, "won");
  assert.equal(s.crossings, 7);
  assert.equal(s.crossings, rv.riverMinCrossings(rv.getRiverProblem("classic")));
  // 勝利後の操作は無効
  assert.equal(rv.crossRiver(s), s);
  assert.equal(rv.toggleRiverItem(s, "goat"), s);
});

test("川渡り: 危険なペアを残して渡ると失敗し理由が付く", () => {
  let s = rv.createRiverGame("classic");
  // 最初にオオカミを運ぶと、左岸にヤギとキャベツが残って失敗する
  s = rv.toggleRiverItem(s, "wolf");
  s = rv.crossRiver(s);
  assert.equal(s.status, "failed");
  assert.ok(s.failMessage?.includes("ヤギ"));
  assert.ok(s.failMessage?.includes("キャベツ"));
  assert.equal(s.crossings, 1);
  // 失敗後の操作は無効
  assert.equal(rv.crossRiver(s), s);
});

test("川渡り: 積み下ろしの規則（定員・向こう岸・降ろすと岸に戻る）", () => {
  let s = rv.createRiverGame("classic");
  // 定員1: 2つ目は乗せられない
  s = rv.toggleRiverItem(s, "goat");
  assert.equal(s.locations.goat, "boat");
  assert.equal(rv.toggleRiverItem(s, "wolf"), s);
  // ボートの荷物をタップすると農夫のいる岸に降りる
  s = rv.toggleRiverItem(s, "goat");
  assert.equal(s.locations.goat, "left");
  // ヤギだけ右岸に運んだあと、農夫だけ左岸へ戻ると、右岸のヤギは触れない
  s = rv.toggleRiverItem(s, "goat");
  s = rv.crossRiver(s);
  assert.equal(s.locations.goat, "right"); // 渡ると荷物は自動で岸に降りる
  s = rv.crossRiver(s); // 農夫だけ左岸へ戻る
  assert.equal(s.farmerSide, "left");
  assert.equal(s.locations.goat, "right");
  assert.equal(rv.toggleRiverItem(s, "goat"), s); // 向こう岸の荷物は触れない
  // 未知の荷物は無効
  assert.equal(rv.toggleRiverItem(s, "dragon"), s);
});

// ---- サイモン対戦 ----

function seats(n) {
  return Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i}` }));
}

/** showing を tick で進めて input フェーズに入る。 */
function advanceToInput(m, s) {
  let guard = 0;
  while (s.phase === "showing" && guard < 100) {
    const next = m.tick(s, (s.showEndsAt ?? 0) + 1);
    assert.notEqual(next, s, "締切後の tick は状態を進めること");
    s = next;
    guard++;
  }
  assert.equal(s.phase, "input");
  return s;
}

test("サイモン対戦: 人数は2〜6人、開始は showing で並びは1色", () => {
  const m = sb.gameModule;
  assert.throws(() => m.createState(seats(1), makeRng(1), {}));
  assert.throws(() => m.createState(seats(7), makeRng(1), {}));
  const s = m.createState(seats(3), makeRng(5), {});
  assert.equal(s.phase, "showing");
  assert.equal(s.sequence.length, 1);
  assert.ok(s.sequence[0] >= 0 && s.sequence[0] < sb.SB_PAD_COUNT);
  assert.equal(s.turnSeat, 0);
  // 締切前の tick は同一参照
  assert.equal(m.tick(s, (s.showEndsAt ?? 0) - 1), s);
  assert.equal(m.phaseOf(s), "showing");
  assert.equal(m.isFinished(s), false);
});

test("サイモン対戦: 再生→入力→追加で並びが育ち、手番が次へ移る", () => {
  const m = sb.gameModule;
  let s = m.createState(seats(3), makeRng(9), {});
  s = advanceToInput(m, s);
  const turn = s.turnSeat;
  // 並びを正しく再現する
  for (const color of [...s.sequence]) {
    s = m.applyAction(s, turn, { type: "press", color }, makeRng(1));
  }
  assert.equal(s.phase, "add");
  // 末尾に1色追加すると並びが伸びて、手番が次へ移り showing に戻る
  const before = s.sequence.length;
  s = m.applyAction(s, turn, { type: "press", color: 2 }, makeRng(1));
  assert.equal(s.sequence.length, before + 1);
  assert.equal(s.sequence[s.sequence.length - 1], 2);
  assert.notEqual(s.turnSeat, turn);
  assert.equal(s.phase, "showing");
  assert.equal(s.lastEvent.kind, "clear");
  assert.equal(s.lastEvent.addedColor, 2);
  // 次の人の番も同じ流れで進む（この手番の人が正しく押せる）
  const nextTurn = s.turnSeat;
  s = advanceToInput(m, s);
  for (const color of [...s.sequence]) {
    s = m.applyAction(s, nextTurn, { type: "press", color }, makeRng(1));
  }
  assert.equal(s.phase, "add");
});

test("サイモン対戦: 手番でない人の入力や再生中の入力はエラー", () => {
  const m = sb.gameModule;
  let s = m.createState(seats(2), makeRng(3), {});
  // showing 中は誰も押せない
  assert.throws(() => m.applyAction(s, s.turnSeat, { type: "press", color: 0 }, makeRng(1)));
  s = advanceToInput(m, s);
  const other = s.turnSeat === 0 ? 1 : 0;
  assert.throws(() => m.applyAction(s, other, { type: "press", color: 0 }, makeRng(1)));
  // 色の範囲外もエラー
  assert.throws(() => m.applyAction(s, s.turnSeat, { type: "press", color: 4 }, makeRng(1)));
  assert.throws(() => m.applyAction(s, s.turnSeat, { type: "press", color: -1 }, makeRng(1)));
});

test("サイモン対戦: 間違えると脱落し、2人対戦では相手の勝ちで終わる", () => {
  const m = sb.gameModule;
  let s = m.createState(seats(2), makeRng(4), {});
  s = advanceToInput(m, s);
  const turn = s.turnSeat;
  const wrong = (s.sequence[0] + 1) % sb.SB_PAD_COUNT;
  s = m.applyAction(s, turn, { type: "press", color: wrong }, makeRng(1));
  assert.ok(s.outSeats.includes(turn));
  assert.equal(s.phase, "finished");
  assert.equal(s.winnerSeat, turn === 0 ? 1 : 0);
  assert.equal(s.lastEvent.kind, "out");
  assert.equal(s.lastEvent.reason, "wrong");
  assert.ok(m.isFinished(s));
});

test("サイモン対戦: 入力の時間切れでも脱落する（tick で締切）", () => {
  const m = sb.gameModule;
  let s = m.createState(seats(3), makeRng(6), {});
  s = advanceToInput(m, s);
  const turn = s.turnSeat;
  // 締切前の tick は同一参照
  assert.equal(m.tick(s, (s.inputEndsAt ?? 0) - 1), s);
  s = m.tick(s, (s.inputEndsAt ?? 0) + 1);
  assert.ok(s.outSeats.includes(turn));
  assert.equal(s.lastEvent.reason, "timeout");
  // まだ2人残っているので対戦は続き、次の人の showing になる
  assert.equal(s.phase, "showing");
  assert.notEqual(s.turnSeat, turn);
});

test("サイモン対戦: 入力中は並びがビューに含まれない（秘匿）", () => {
  const m = sb.gameModule;
  let s = m.createState(seats(3), makeRng(8), {});
  // showing 中は flash（現在の1色）だけが見え、並び全体は見えない
  const showView = m.viewFor(s, 0);
  assert.equal(typeof showView.flash, "number");
  assert.equal(showView.sequence, null);
  s = advanceToInput(m, s);
  for (const seat of [0, 1, 2]) {
    const view = m.viewFor(s, seat);
    assert.equal(view.sequence, null, "input 中は並び全体を渡さない");
    assert.equal(view.flash, null, "input 中は手番の人にも再表示しない");
    const json = JSON.stringify(view);
    assert.ok(!json.includes(JSON.stringify(s.sequence)), "並びが JSON に漏れていないこと");
  }
  // 進捗（何個押し終えたか）は公開情報
  const view = m.viewFor(s, s.turnSeat);
  assert.equal(view.inputProgress, 0);
  assert.equal(view.sequenceLength, s.sequence.length);
});

test("サイモン対戦: 退出は脱落扱いで、手番の人が抜けると手番が進む", () => {
  const m = sb.gameModule;
  let s = m.createState(seats(3), makeRng(12), {});
  // 手番でない人が抜けても対戦は続く
  const nonTurn = s.turnSeat === 0 ? 1 : 0;
  s = m.onPlayerLeft(s, nonTurn);
  assert.ok(s.outSeats.includes(nonTurn));
  assert.ok(s.leftSeats.includes(nonTurn));
  assert.equal(s.phase, "showing");
  // 手番の人が抜けると残り1人になり、その人の勝ちで終わる
  s = m.onPlayerLeft(s, s.turnSeat);
  assert.equal(s.phase, "finished");
  const winner = s.players.map((p) => p.seat).find((seat) => !s.outSeats.includes(seat));
  assert.equal(s.winnerSeat, winner);
});

test("サイモン対戦: parseAction の検証", () => {
  const m = sb.gameModule;
  assert.deepEqual(m.parseAction({ type: "press", color: 0 }), { type: "press", color: 0 });
  assert.deepEqual(m.parseAction({ type: "press", color: 3 }), { type: "press", color: 3 });
  assert.equal(m.parseAction({ type: "press", color: 4 }), null);
  assert.equal(m.parseAction({ type: "press", color: -1 }), null);
  assert.equal(m.parseAction({ type: "press", color: 1.5 }), null);
  assert.equal(m.parseAction({ type: "press" }), null);
  assert.equal(m.parseAction({ type: "answer", color: 1 }), null);
  assert.equal(m.parseAction(null), null);
  assert.equal(m.parseAction("press"), null);
});
