// A15フェーズ新規4本のロジック検証。
// - lib/rushhour.ts: 生成の決定性・可解性（solution の再生）・スライド検証
// - lib/online/games/cheat.ts: 配布・秘匿ビュー・宣言とチャレンジ決着・
//   上がり候補の確定・退出
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

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const seats = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i + 1}` }));

const rush = await loadLib("rushhour.ts");
const cheat = await loadOnline("cheat.ts", ["gameModule", "cheatRankOf", "cheatSortHand"]);

// ---------------------------------------------------------------- ラッシュアワー

function assertRushLayout(st) {
  const grid = rush.rushOccupancy(st.cars);
  let filled = 0;
  for (const v of grid) if (v !== -1) filled++;
  const expected = st.cars.reduce((sum, c) => sum + c.len, 0);
  assert.equal(filled, expected); // 重なりがあれば filled が減る
  const targets = st.cars.filter((c) => c.target);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].row, rush.RUSH_EXIT_ROW);
  assert.equal(targets[0].dir, "h");
  assert.equal(targets[0].len, 2);
  for (const car of st.cars) {
    assert.ok(car.row >= 0 && car.col >= 0);
    const lastRow = car.dir === "v" ? car.row + car.len - 1 : car.row;
    const lastCol = car.dir === "h" ? car.col + car.len - 1 : car.col;
    assert.ok(lastRow < 6 && lastCol < 6);
  }
}

test("ラッシュアワー: 生成は決定的で、配置が妥当で未解決", () => {
  const a = rush.createRushHour(42);
  const b = rush.createRushHour(42);
  assert.deepEqual(a.cars, b.cars);
  assert.deepEqual(a.solution, b.solution);
  assertRushLayout(a);
  assert.equal(a.status, "playing");
  assert.equal(rush.rushIsSolved(a.cars), false);
});

test("ラッシュアワー: solution を再生すると必ず解ける（複数シード）", () => {
  for (const seed of [1, 7, 42, 123, 2024, 555]) {
    let st = rush.createRushHour(seed);
    assertRushLayout(st);
    assert.ok(st.solution.length > 0);
    for (const step of st.solution) {
      const next = rush.rushSlide(st, step.carId, step.delta);
      assert.notEqual(next, st, `seed=${seed} で solution の手が不正`);
      st = next;
    }
    assert.equal(st.status, "won", `seed=${seed} で解けなかった`);
  }
});

test("ラッシュアワー: スライドの検証（範囲外・0・進路妨害は不変）", () => {
  const st = rush.createRushHour(3);
  const car = st.cars[0];
  assert.equal(rush.rushSlide(st, car.id, 0), st);
  assert.equal(rush.rushSlide(st, car.id, 6), st);
  assert.equal(rush.rushSlide(st, car.id, -6), st);
  assert.equal(rush.rushSlide(st, 999, 1), st);
  // オプションは範囲と一致する
  for (const c of st.cars) {
    const { min, max } = rush.rushSlideRange(st, c.id);
    const options = rush.rushSlideOptions(st, c.id);
    const expected = [];
    for (let d = min; d <= max; d++) if (d !== 0) expected.push(d);
    assert.deepEqual(options, expected);
  }
  // 実際に動かすと位置と手数が変わる
  const movable = st.cars.find((c) => rush.rushSlideOptions(st, c.id).length > 0);
  assert.ok(movable);
  const delta = rush.rushSlideOptions(st, movable.id)[0];
  const next = rush.rushSlide(st, movable.id, delta);
  assert.equal(next.moves, 1);
  const moved = next.cars.find((c) => c.id === movable.id);
  if (movable.dir === "h") assert.equal(moved.col, movable.col + delta);
  else assert.equal(moved.row, movable.row + delta);
});

// ---------------------------------------------------------------- ブラフ

const cm = cheat.gameModule;
const rng = makeRng(99);

function cheatState(hands, turn = 0, expectedRank = 1) {
  const base = cm.createState(seats(hands.length), makeRng(7), {});
  base.hands = hands.map((h) => [...h]);
  base.turn = turn;
  base.expectedRank = expectedRank;
  return base;
}

test("ブラフ: 配布は全52枚をできるだけ均等に分ける", () => {
  const st = cm.createState(seats(3), makeRng(5), {});
  const sizes = st.hands.map((h) => h.length).sort((a, b) => a - b);
  assert.deepEqual(sizes, [17, 17, 18]);
  const all = st.hands.flat();
  assert.equal(new Set(all).size, 52);
  assert.equal(st.turn, 0);
  assert.equal(st.expectedRank, 1);
  assert.throws(() => cm.createState(seats(2), makeRng(5), {}));
  assert.throws(() => cm.createState(seats(7), makeRng(5), {}));
});

test("ブラフ: ビューは自分の手札だけを見せ、他人の手札は枚数だけ", () => {
  const st = cm.createState(seats(4), makeRng(6), {});
  const view = cm.viewFor(st, 1);
  assert.deepEqual(view.yourHand, st.hands[1]);
  assert.equal(view.others.length, 3);
  for (const o of view.others) {
    assert.equal(typeof o.count, "number");
    assert.ok(!("hand" in o) && !("cards" in o));
  }
  assert.equal(view.pileCount, 0);
  assert.equal(view.lastPlay, null);
});

test("ブラフ: 宣言でランクが進み、嘘へのチャレンジで出した人が山を取る", () => {
  // seat0: A(0) と 6(5)。6 を「A」と宣言して出す（嘘）。
  let st = cheatState([[0, 5], [13], [26]]);
  st = cm.applyAction(st, 0, { type: "play", cards: [5] }, rng);
  assert.equal(st.expectedRank, 2);
  assert.equal(st.turn, 1);
  assert.equal(st.pile.length, 1);
  const view = cm.viewFor(st, 1);
  assert.deepEqual(view.lastPlay, { seat: 0, rank: 1, count: 1 });

  st = cm.applyAction(st, 1, { type: "challenge" }, rng);
  assert.equal(st.pile.length, 0);
  assert.ok(st.hands[0].includes(5)); // 嘘なので出した人が山を引き取る
  assert.equal(st.hands[0].length, 2);
  assert.equal(st.expectedRank, 1); // ランクは A に戻る
  assert.equal(st.turn, 1); // チャレンジで勝った人から再開
  assert.equal(st.lastReveal.honest, false);
  assert.equal(st.lastReveal.taker, 0);
});

test("ブラフ: 本当の宣言へのチャレンジではチャレンジャーが山を取る", () => {
  let st = cheatState([[0, 20], [13], [26]]);
  st = cm.applyAction(st, 0, { type: "play", cards: [0] }, rng); // A を正直に出す
  st = cm.applyAction(st, 1, { type: "challenge" }, rng);
  assert.equal(st.lastReveal.honest, true);
  assert.ok(st.hands[1].includes(0));
  assert.equal(st.hands[0].length, 1);
  assert.equal(st.turn, 0); // 勝ったのは出した人
});

test("ブラフ: 出し切ると上がり候補になり、次の人のプレイで確定する", () => {
  let st = cheatState([[0], [13, 14], [26, 27]]);
  st = cm.applyAction(st, 0, { type: "play", cards: [0] }, rng);
  assert.equal(st.candidate, 0);
  assert.equal(st.hands[0].length, 0);
  assert.equal(st.turn, 1);
  // seat1 がチャレンジせずに出す → seat0 の上がり確定
  st = cm.applyAction(st, 1, { type: "play", cards: [13] }, rng);
  assert.deepEqual(st.finishOrder, [0]);
  assert.equal(st.candidate, null);
  // 残り2人で続行し、seat1 も出し切って候補 → seat2 のプレイで確定し seat2 が最下位
  st = cm.applyAction(st, 2, { type: "play", cards: [26] }, rng);
  st = cm.applyAction(st, 1, { type: "play", cards: [14] }, rng);
  assert.equal(st.candidate, 1);
  st = cm.applyAction(st, 2, { type: "play", cards: [27] }, rng);
  assert.equal(st.finished, true);
  assert.deepEqual(st.finishOrder, [0, 1]);
  assert.equal(st.lastPlace, 2);
  assert.equal(cm.viewFor(st, 2).yourRank, 3);
  assert.equal(cm.viewFor(st, 0).yourRank, 1);
});

test("ブラフ: 上がり候補へのチャレンジが本当なら即確定、嘘なら候補消滅", () => {
  let st = cheatState([[0], [13, 14], [26]]);
  st = cm.applyAction(st, 0, { type: "play", cards: [0] }, rng);
  st = cm.applyAction(st, 1, { type: "challenge" }, rng); // 本当 → seat1 が山を取る
  assert.deepEqual(st.finishOrder, [0]);
  assert.equal(st.candidate, null);
  assert.ok(st.hands[1].includes(0));
  assert.equal(st.turn, 1); // 勝者（上がった人）の次の意思決定者から再開

  let st2 = cheatState([[5], [13, 14], [26]]);
  st2 = cm.applyAction(st2, 0, { type: "play", cards: [5] }, rng); // 6 を A と偽る
  assert.equal(st2.candidate, 0);
  st2 = cm.applyAction(st2, 1, { type: "challenge" }, rng); // 嘘 → seat0 が山を取る
  assert.equal(st2.candidate, null);
  assert.deepEqual(st2.finishOrder, []);
  assert.ok(st2.hands[0].includes(5));
});

test("ブラフ: 不正なアクションは throw する", () => {
  const st = cheatState([[0, 5], [13], [26]]);
  assert.throws(() => cm.applyAction(st, 1, { type: "play", cards: [13] }, rng)); // 手番でない
  assert.throws(() => cm.applyAction(st, 0, { type: "play", cards: [51] }, rng)); // 手札にない
  assert.throws(() => cm.applyAction(st, 0, { type: "play", cards: [] }, rng)); // 0枚
  assert.throws(() => cm.applyAction(st, 0, { type: "play", cards: [0, 0] }, rng)); // 重複
  assert.throws(() => cm.applyAction(st, 0, { type: "challenge" }, rng)); // 宣言がない
});

test("ブラフ: parseAction の形式検証", () => {
  assert.deepEqual(cm.parseAction({ type: "challenge" }), { type: "challenge" });
  assert.deepEqual(cm.parseAction({ type: "play", cards: [0, 51] }), {
    type: "play",
    cards: [0, 51],
  });
  assert.equal(cm.parseAction({ type: "play", cards: [] }), null);
  assert.equal(cm.parseAction({ type: "play", cards: [0, 0] }), null);
  assert.equal(cm.parseAction({ type: "play", cards: [52] }), null);
  assert.equal(cm.parseAction({ type: "play", cards: [0, 1, 2, 3] }), null);
  assert.equal(cm.parseAction({ type: "nope" }), null);
  assert.equal(cm.parseAction(null), null);
});

test("ブラフ: 退出は脱落扱いで、残り1人になると最下位で終了する", () => {
  let st = cheatState([[0, 5], [13], [26]]);
  st = cm.onPlayerLeft(st, 2);
  assert.ok(st.leftSeats.includes(2));
  assert.equal(st.hands[2].length, 0);
  assert.equal(st.finished, false);

  const st2base = cheatState([[0], [13], [26]]);
  st2base.finishOrder = [0];
  const st2 = cm.onPlayerLeft(st2base, 2);
  assert.equal(st2.finished, true);
  assert.equal(st2.lastPlace, 1);
});
