// オンライン対戦ゲーム: 戦艦ゲーム（battleship）＋大富豪（daifugo）の検証。
// balku.test.mjs と同じ loadBundle 方式（TS transpile＋import 除去＋連結）で読み込む。
// 両モジュールとも `export const gameModule` を持つため、ファイルごとに別バンドルで読み、
// エクスポート名を付け替えて衝突を避ける。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const gamesDir = path.join(import.meta.dirname, "..", "lib", "online", "games");

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

async function loadGame(file, alias) {
  const src = fs.readFileSync(path.join(gamesDir, file), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const code = stripModuleSyntax(js) + `\nexport { gameModule as ${alias} };\n`;
  const mod = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
  return mod[alias];
}

const bs = await loadGame("battleship.ts", "battleship");
const df = await loadGame("daifugo.ts", "daifugo");

/** 決定的 rng（テスト用 LCG）。 */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x80000000;
  };
}
const rng = makeRng(1234);

const players = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i}` }));

/** オブジェクト内の全数値を集める（秘匿検証用）。 */
function collectNumbers(value, out = new Set()) {
  if (typeof value === "number") out.add(value);
  else if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectNumbers(v, out));
  return out;
}

// ============================= battleship =============================

const FLEET0 = [
  [0, 1, 2, 3, 4],
  [10, 11, 12, 13],
  [20, 21, 22],
  [30, 31, 32],
  [40, 41],
];
const FLEET1 = [
  [9, 19, 29, 39, 49],
  [90, 91, 92, 93],
  [55, 65, 75],
  [5, 15, 25],
  [80, 81],
];

function bsCreated() {
  return bs.createState(players(2), rng, {});
}
function bsStarted() {
  let st = bsCreated();
  st = bs.applyAction(st, 0, { type: "placeShips", ships: FLEET0 }, rng);
  st = bs.applyAction(st, 1, { type: "placeShips", ships: FLEET1 }, rng);
  return st;
}

test("battleship: モジュールメタと初期状態", () => {
  assert.equal(bs.id, "battleship");
  assert.equal(bs.minPlayers, 2);
  assert.equal(bs.maxPlayers, 2);
  assert.equal(bs.cpuSupported, false);
  assert.equal(bs.chatEnabled, true);
  const st = bsCreated();
  assert.equal(st.phase, "placing");
  assert.equal(bs.phaseOf(st), "placing");
  assert.equal(bs.isFinished(st), false);
  assert.equal(st.winner, null);
  assert.deepEqual(st.fleets.map((f) => f.ready), [false, false]);
  assert.throws(() => bs.createState(players(3), rng, {}), /2人/);
});

test("battleship: 配置検証（隻数・サイズ・重なり・斜め・はみ出し・不連続）", () => {
  const st = bsCreated();
  const bad = (ships, pattern) =>
    assert.throws(() => bs.applyAction(st, 0, { type: "placeShips", ships }, rng), pattern);
  bad(FLEET0.slice(0, 4), /5隻/); // 隻数不足
  bad(
    [[0, 1, 2, 3, 4], [10, 11, 12, 13], [20, 21, 22], [30, 31, 32], [40, 41, 42]],
    /サイズ/,
  ); // サイズ構成不一致（5,4,3,3,3）
  bad(
    [[0, 1, 2, 3, 4], [4, 14, 24, 34], [20, 21, 22], [30, 31, 32], [40, 41]],
    /重な/,
  ); // 重なり（マス4）
  bad(
    [[0, 1, 2, 3, 4], [10, 11, 12, 13], [20, 31, 42], [55, 56, 57], [40, 41]],
    /一直線/,
  ); // 斜め
  bad(
    [[96, 97, 98, 99, 100], [10, 11, 12, 13], [20, 21, 22], [30, 31, 32], [40, 41]],
    /範囲外/,
  ); // はみ出し
  bad(
    [[0, 1, 2, 3, 4], [10, 11, 12, 13], [20, 22, 24], [30, 31, 32], [40, 41]],
    /連続/,
  ); // 不連続
  bad(
    [[8, 9, 10, 11, 12], [20, 21, 22, 23], [30, 31, 32], [40, 41, 42], [50, 51]],
    /一直線/,
  ); // 行をまたぐ配置は一直線ではない
});

test("battleship: 両者配置で battle へ移行し、先手は seat0", () => {
  let st = bsCreated();
  st = bs.applyAction(st, 0, { type: "placeShips", ships: FLEET0 }, rng);
  assert.equal(st.phase, "placing", "片方だけでは始まらない");
  assert.throws(() => bs.applyAction(st, 0, { type: "placeShips", ships: FLEET0 }, rng), /既に配置済み/);
  assert.throws(() => bs.applyAction(st, 0, { type: "fire", index: 0 }, rng), /攻撃フェーズではありません/);
  st = bs.applyAction(st, 1, { type: "placeShips", ships: FLEET1 }, rng);
  assert.equal(st.phase, "battle");
  assert.equal(st.turn, 0);
  assert.throws(() => bs.applyAction(st, 0, { type: "placeShips", ships: FLEET0 }, rng), /配置フェーズではありません/);
});

test("battleship: 手番外の fire・再射は throw、命中でも手番は交代する", () => {
  let st = bsStarted();
  assert.throws(() => bs.applyAction(st, 1, { type: "fire", index: 0 }, rng), /手番ではありません/);
  st = bs.applyAction(st, 0, { type: "fire", index: 9 }, rng); // FLEET1 の艦首に命中
  assert.deepEqual(st.shots[0], [{ index: 9, result: "hit" }]);
  assert.deepEqual(st.lastShot, { seat: 0, index: 9, result: "hit" });
  assert.equal(st.turn, 1, "命中しても手番は交代する");
  st = bs.applyAction(st, 1, { type: "fire", index: 99 }, rng); // 外れ
  assert.deepEqual(st.shots[1], [{ index: 99, result: "miss" }]);
  assert.equal(st.turn, 0);
  assert.throws(() => bs.applyAction(st, 0, { type: "fire", index: 9 }, rng), /既に攻撃したマス/);
  assert.throws(() => bs.applyAction(st, 0, { type: "fire", index: 100 }, rng), /範囲外/);
});

test("battleship: 撃沈判定とビュー（沈んだ艦だけが相手側に見える）", () => {
  let st = bsStarted();
  st = bs.applyAction(st, 0, { type: "fire", index: 80 }, rng);
  st = bs.applyAction(st, 1, { type: "fire", index: 99 }, rng);
  st = bs.applyAction(st, 0, { type: "fire", index: 81 }, rng); // [80,81] 撃沈
  const ship = st.fleets[1].ships.find((s) => s.cells.includes(80));
  assert.equal(ship.sunk, true);
  assert.equal(st.phase, "battle");
  const view0 = bs.viewFor(st, 0);
  assert.deepEqual(view0.opponent.sunkShips, [[80, 81]]);
  assert.equal(view0.opponent.afloatCount, 4);
  assert.deepEqual(view0.opponent.shots, [
    { index: 80, result: "hit" },
    { index: 81, result: "hit" },
  ]);
  const view1 = bs.viewFor(st, 1);
  assert.deepEqual(view1.you.incoming, view0.opponent.shots);
  assert.equal(view1.you.ships.find((s) => s.cells.includes(80)).sunk, true);
});

test("battleship: ビューに相手の未撃沈艦の位置が含まれない", () => {
  const st = bsStarted();
  const view0 = bs.viewFor(st, 0);
  const nums = collectNumbers(view0);
  for (const cell of [29, 39, 49, 75, 93, 65, 55, 19]) {
    assert.ok(!nums.has(cell), `未撃沈艦のマス ${cell} が漏れている`);
  }
  assert.ok(!JSON.stringify(view0).includes("[9,19,29,39,49]"));
  assert.ok(!JSON.stringify(view0).includes("[55,65,75]"));
  // 自分の艦は全て見える
  assert.deepEqual(view0.you.ships.map((s) => s.cells), FLEET0);
});

test("battleship: 全撃沈で勝ちが確定し、終了後の手は throw", () => {
  let st = bsStarted();
  const targets = FLEET1.flat();
  const p0Cells = new Set(FLEET0.flat());
  const misses = Array.from({ length: 100 }, (_, i) => i).filter((i) => !p0Cells.has(i));
  for (let i = 0; i < targets.length; i++) {
    st = bs.applyAction(st, 0, { type: "fire", index: targets[i] }, rng);
    if (i < targets.length - 1) {
      assert.equal(st.phase, "battle");
      st = bs.applyAction(st, 1, { type: "fire", index: misses[i] }, rng);
    }
  }
  assert.equal(st.phase, "finished");
  assert.equal(st.winner, 0);
  assert.equal(bs.isFinished(st), true);
  assert.ok(st.fleets[1].ships.every((s) => s.sunk));
  assert.throws(() => bs.applyAction(st, 1, { type: "fire", index: 0 }, rng), /終了/);
});

test("battleship: onPlayerLeft で相手の勝ち、applyAction は純関数", () => {
  const st = bsStarted();
  const left = bs.onPlayerLeft(st, 1);
  assert.equal(left.phase, "finished");
  assert.equal(left.winner, 0);
  const placing = bs.onPlayerLeft(bsCreated(), 0);
  assert.equal(placing.winner, 1);

  const before = JSON.stringify(st);
  bs.applyAction(st, 0, { type: "fire", index: 9 }, rng);
  assert.equal(JSON.stringify(st), before, "元の state を破壊しない");
});

test("battleship: parseAction", () => {
  assert.deepEqual(bs.parseAction({ type: "fire", index: 42 }), { type: "fire", index: 42 });
  assert.deepEqual(bs.parseAction({ type: "placeShips", ships: FLEET0 }), {
    type: "placeShips",
    ships: FLEET0,
  });
  assert.equal(bs.parseAction({ type: "fire", index: "42" }), null);
  assert.equal(bs.parseAction({ type: "unknown" }), null);
  assert.equal(bs.parseAction(null), null);
  assert.equal(bs.parseAction("fire"), null);
});

// ============================= daifugo =============================

/** カード id: suit 0=♠,1=♥,2=♦,3=♣ / rank 3〜15（15が「2」）。 */
const C = (suit, rank) => suit * 13 + (rank - 3);

function dfState(over = {}) {
  return {
    players: players(2),
    hands: [[], []],
    field: null,
    revolution: false,
    turn: 0,
    passStreak: 0,
    leadPassStreak: 0,
    finishOrder: [],
    finished: false,
    log: [],
    leftSeats: [],
    started: true,
    ...over,
  };
}

test("daifugo: モジュールメタと配札（総数・♦3の先手・回し配り）", () => {
  assert.equal(df.id, "daifugo");
  assert.equal(df.minPlayers, 2);
  assert.equal(df.maxPlayers, 4);
  assert.equal(df.cpuSupported, true);
  assert.equal(df.chatEnabled, true);
  assert.throws(() => df.createState(players(1), makeRng(1), {}), /2〜4人/);
  assert.throws(() => df.createState(players(5), makeRng(1), {}), /2〜4人/);

  const st3 = df.createState(players(3), makeRng(42), {});
  assert.deepEqual(st3.hands.map((h) => h.length), [18, 18, 17]);
  const all = st3.hands.flat();
  assert.equal(all.length, 53);
  assert.deepEqual([...all].sort((a, b) => a - b), Array.from({ length: 53 }, (_, i) => i));
  assert.ok(st3.hands[st3.turn].includes(26), "♦3 を持つ人が先手");
  assert.equal(st3.started, true);
  assert.equal(st3.finished, false);
  assert.equal(df.phaseOf(st3), "playing");

  const st2 = df.createState(players(2), makeRng(7), {});
  assert.deepEqual(st2.hands.map((h) => h.length), [27, 26]);
  const st4 = df.createState(players(4), makeRng(7), {});
  assert.deepEqual(st4.hands.map((h) => h.length), [14, 13, 13, 13]);
});

test("daifugo: 場より弱い手・枚数違い・手札にない札・手番違いは throw", () => {
  const weak = dfState({
    hands: [[C(0, 3)], [C(0, 4), C(0, 5)]],
    field: { cards: [C(0, 15)], seat: 1 },
    turn: 0,
  });
  assert.throws(() => df.applyAction(weak, 0, { type: "play", cards: [C(0, 3)] }, rng), /場より強い/);

  const count = dfState({
    hands: [[C(0, 5), C(0, 6)], [C(0, 4)]],
    field: { cards: [C(0, 4), C(1, 4)], seat: 1 },
    turn: 0,
  });
  assert.throws(() => df.applyAction(count, 0, { type: "play", cards: [C(0, 5)] }, rng), /枚数/);
  assert.throws(() => df.applyAction(count, 0, { type: "play", cards: [C(0, 7)] }, rng), /手札にない/);
  assert.throws(() => df.applyAction(count, 1, { type: "play", cards: [C(0, 4)] }, rng), /手番ではありません/);

  const mixed = dfState({ hands: [[C(0, 5), C(0, 6)], [C(0, 4)]], turn: 0 });
  assert.throws(() => df.applyAction(mixed, 0, { type: "play", cards: [C(0, 5), C(0, 6)] }, rng), /同じランク/);
});

test("daifugo: ジョーカー単体は最強、組み合わせでは任意ランクの実効ランクになる", () => {
  const single = dfState({
    hands: [[52, C(0, 3), C(0, 4)], [C(0, 5)]],
    field: { cards: [C(0, 15)], seat: 1 },
    turn: 0,
  });
  const after = df.applyAction(single, 0, { type: "play", cards: [52] }, rng);
  assert.deepEqual(after.field, { cards: [52], seat: 0 });
  assert.equal(after.turn, 1);

  const combo = dfState({
    hands: [[C(0, 9), 52, C(0, 3)], [C(0, 5)]],
    field: { cards: [C(0, 8), C(1, 8)], seat: 1 },
    turn: 0,
  });
  const after2 = df.applyAction(combo, 0, { type: "play", cards: [C(0, 9), 52] }, rng);
  assert.deepEqual(after2.field.cards, [C(0, 9), 52]);
});

test("daifugo: 革命の発動（5枚）と強さ逆転", () => {
  const five3s = [C(0, 3), C(1, 3), C(2, 3), C(3, 3), 52];
  const st = dfState({ hands: [[...five3s, C(0, 4)], [C(0, 5), C(0, 6)]], turn: 0 });
  const after = df.applyAction(st, 0, { type: "play", cards: five3s }, rng);
  assert.equal(after.revolution, true);
  assert.deepEqual(after.hands[0], [C(0, 4)]);
  assert.equal(after.turn, 1);

  // 革命中は 3 が 5 より強い
  const rev = dfState({
    hands: [[C(0, 3), C(0, 6)], [C(0, 7)]],
    field: { cards: [C(0, 5)], seat: 1 },
    revolution: true,
    turn: 0,
  });
  const afterRev = df.applyAction(rev, 0, { type: "play", cards: [C(0, 3)] }, rng);
  assert.deepEqual(afterRev.field, { cards: [C(0, 3)], seat: 0 });
  // 革命中は「2」（15）が最弱なので 3 の場には出せない
  const revWeak = dfState({
    hands: [[C(0, 15), C(0, 4)], [C(0, 7)]],
    field: { cards: [C(0, 3)], seat: 1 },
    revolution: true,
    turn: 0,
  });
  assert.throws(() => df.applyAction(revWeak, 0, { type: "play", cards: [C(0, 15)] }, rng), /場より強い/);
});

test("daifugo: 8切りで場が流れ、出した本人が次のリードになる", () => {
  const st = dfState({
    hands: [[C(0, 8), C(0, 3)], [C(0, 5)]],
    field: { cards: [C(0, 4)], seat: 1 },
    turn: 0,
  });
  const after = df.applyAction(st, 0, { type: "play", cards: [C(0, 8)] }, rng);
  assert.equal(after.field, null);
  assert.equal(after.turn, 0);
  assert.deepEqual(after.hands[0], [C(0, 3)]);

  // ジョーカーを組み合わせに使っても、実札の8がなければ8切りにならない
  const jk = dfState({
    hands: [[C(0, 7), 52, C(0, 3)], [C(0, 5)]],
    field: { cards: [C(0, 4), C(1, 4)], seat: 1 },
    turn: 0,
  });
  const afterJk = df.applyAction(jk, 0, { type: "play", cards: [C(0, 7), 52] }, rng);
  assert.deepEqual(afterJk.field, { cards: [C(0, 7), 52], seat: 0 });
  assert.equal(afterJk.turn, 1);
});

test("daifugo: パスの連続で場が流れ、場の持ち主がリードする（3人）", () => {
  let st = dfState({
    players: players(3),
    hands: [[C(0, 3), C(0, 9)], [C(0, 4), C(0, 10)], [C(0, 5), C(0, 11)]],
    field: { cards: [C(0, 13)], seat: 0 },
    turn: 1,
  });
  st = df.applyAction(st, 1, { type: "pass" }, rng);
  assert.ok(st.field, "1人目のパスでは流れない");
  assert.equal(st.turn, 2);
  st = df.applyAction(st, 2, { type: "pass" }, rng);
  assert.equal(st.field, null);
  assert.equal(st.turn, 0);
  assert.deepEqual(st.log.map((l) => l.kind), ["pass", "pass"]);
});

test("daifugo: リードではパス不可。ただし反則あがりしかない場合は例外として許可", () => {
  const normal = dfState({ hands: [[C(0, 3), C(0, 4)], [C(0, 5)]], turn: 0 });
  assert.throws(() => df.applyAction(normal, 0, { type: "pass" }, rng), /リードではパスできません/);

  const onlyEight = dfState({ hands: [[C(0, 8)], [C(0, 5), C(0, 6)]], turn: 0 });
  const after = df.applyAction(onlyEight, 0, { type: "pass" }, rng);
  assert.equal(after.turn, 1);
  assert.equal(after.field, null);

  const onlyJoker = dfState({ hands: [[52], [C(0, 5), C(0, 6)]], turn: 0 });
  assert.equal(df.applyAction(onlyJoker, 0, { type: "pass" }, rng).turn, 1);
});

test("daifugo: 反則あがり（8・ジョーカー・革命）は throw される", () => {
  const eight = dfState({
    hands: [[C(0, 8)], [C(0, 5)]],
    field: { cards: [C(0, 4)], seat: 1 },
    turn: 0,
  });
  assert.throws(() => df.applyAction(eight, 0, { type: "play", cards: [C(0, 8)] }, rng), /反則あがり/);

  const joker = dfState({
    hands: [[52], [C(0, 5)]],
    field: { cards: [C(0, 4)], seat: 1 },
    turn: 0,
  });
  assert.throws(() => df.applyAction(joker, 0, { type: "play", cards: [52] }, rng), /反則あがり/);

  const rev = dfState({
    hands: [[C(0, 3), C(1, 3), C(2, 3), C(3, 3), 52], [C(0, 5)]],
    turn: 0,
  });
  assert.throws(
    () => df.applyAction(rev, 0, { type: "play", cards: [C(0, 3), C(1, 3), C(2, 3), C(3, 3), 52] }, rng),
    /反則あがり/,
  );
});

test("daifugo: 正規の上がりと順位確定、現役1人で全順位が決まって終了（2人）", () => {
  const st = dfState({
    hands: [[C(0, 3)], [C(1, 6)]],
    field: { cards: [C(0, 5)], seat: 1 },
    revolution: true, // 革命中なら最弱の3でも5の場に出して上がれる
    turn: 0,
  });
  const after = df.applyAction(st, 0, { type: "play", cards: [C(0, 3)] }, rng);
  assert.deepEqual(after.finishOrder, [0, 1]);
  assert.equal(after.finished, true);
  assert.equal(df.isFinished(after), true);
  assert.equal(df.phaseOf(after), "finished");
  assert.throws(() => df.applyAction(after, 1, { type: "pass" }, rng), /終了/);
});

test("daifugo: 3人で順に上がり、全員分の順位で終了する", () => {
  let st = dfState({
    players: players(3),
    hands: [[C(0, 3)], [C(0, 4)], [C(0, 5)]],
    turn: 0,
  });
  st = df.applyAction(st, 0, { type: "play", cards: [C(0, 3)] }, rng);
  assert.deepEqual(st.finishOrder, [0]);
  assert.deepEqual(st.field, { cards: [C(0, 3)], seat: 0 });
  assert.equal(st.turn, 1);
  assert.equal(st.finished, false);
  st = df.applyAction(st, 1, { type: "play", cards: [C(0, 4)] }, rng);
  assert.deepEqual(st.finishOrder, [0, 1, 2]);
  assert.equal(st.finished, true);
});

test("daifugo: 場の持ち主が上がった後も場は継続し、流れ条件は現役人数で判定", () => {
  let st = dfState({
    players: players(3),
    hands: [[C(0, 3)], [C(0, 4), C(0, 9)], [C(0, 5), C(0, 10)]],
    turn: 0,
  });
  st = df.applyAction(st, 0, { type: "play", cards: [C(0, 3)] }, rng);
  assert.deepEqual(st.finishOrder, [0]);
  assert.ok(st.field, "持ち主が上がっても場は残る");
  st = df.applyAction(st, 1, { type: "pass" }, rng);
  assert.ok(st.field, "現役2人中1人のパスでは流れない");
  assert.equal(st.turn, 2);
  st = df.applyAction(st, 2, { type: "pass" }, rng);
  assert.equal(st.field, null, "現役全員のパスで流れる");
  assert.equal(st.turn, 1, "次のリードは持ち主の次の現役プレイヤー");
});

test("daifugo: ビューの秘匿（他人の手札の中身は見えない・枚数のみ）", () => {
  const st = dfState({
    players: players(3),
    hands: [[C(0, 3), C(0, 4)], [C(2, 11), C(2, 12), C(2, 13)], [C(3, 14), C(3, 15), C(1, 9)]],
    turn: 0,
  });
  const view = df.viewFor(st, 0);
  assert.deepEqual(view.yourHand, [C(0, 3), C(0, 4)]);
  assert.deepEqual(view.others.map((o) => o.count), [3, 3]);
  assert.deepEqual(view.others.map((o) => o.finished), [null, null]);
  assert.equal(view.yourRank, null);
  for (const o of view.others) {
    assert.deepEqual(Object.keys(o).sort(), ["count", "finished", "name", "seat"]);
  }
  const withoutMine = { ...view, yourHand: [] };
  const nums = collectNumbers(withoutMine);
  for (const secret of [C(2, 11), C(2, 12), C(2, 13), C(3, 14), C(3, 15), C(1, 9)]) {
    assert.ok(!nums.has(secret), `他人の手札 ${secret} が漏れている`);
  }
});

test("daifugo: CPU は合法手を返し、ジョーカーを温存し、出せなければパスする", () => {
  // リード: 最も弱いランクの組み合わせ（3のペア）を出す
  const lead = dfState({
    hands: [[C(0, 15), C(0, 3), C(1, 3), C(0, 9)], [C(0, 5)]],
    turn: 0,
  });
  const leadAction = df.cpuAction(lead, 0, rng);
  assert.equal(leadAction.type, "play");
  assert.deepEqual([...leadAction.cards].sort((a, b) => a - b), [C(0, 3), C(1, 3)]);
  assert.doesNotThrow(() => df.applyAction(lead, 0, leadAction, rng));

  // 場があるとき: 出せる中で最も弱い組み合わせ
  const follow = dfState({
    hands: [[C(0, 3), C(0, 5), C(0, 15)], [C(0, 6)]],
    field: { cards: [C(0, 4)], seat: 1 },
    turn: 0,
  });
  assert.deepEqual(df.cpuAction(follow, 0, rng), { type: "play", cards: [C(0, 5)] });

  // ジョーカー温存: ジョーカーなしで出せる手があればそちら
  const keep = dfState({
    hands: [[C(0, 14), 52, C(0, 3)], [C(0, 6)]],
    field: { cards: [C(0, 13)], seat: 1 },
    turn: 0,
  });
  assert.deepEqual(df.cpuAction(keep, 0, rng), { type: "play", cards: [C(0, 14)] });

  // 出せる手がない → パス
  const stuck = dfState({
    hands: [[C(0, 3), C(0, 4)], [C(0, 6)]],
    field: { cards: [C(0, 15)], seat: 1 },
    turn: 0,
  });
  assert.deepEqual(df.cpuAction(stuck, 0, rng), { type: "pass" });

  // 反則あがりになる手は選ばずパスする
  const forbidden = dfState({
    hands: [[C(0, 8)], [C(0, 6)]],
    field: { cards: [C(0, 4)], seat: 1 },
    turn: 0,
  });
  assert.deepEqual(df.cpuAction(forbidden, 0, rng), { type: "pass" });

  // 手番でなければ null
  assert.equal(df.cpuAction(follow, 1, rng), null);
});

test("daifugo: 退出処理（手札除去・手番送り・流れ再計算・現役1人で終了）", () => {
  // 手番プレイヤーの退出 → 次の現役へ
  let st = dfState({
    players: players(3),
    hands: [[C(0, 3), C(0, 9)], [C(0, 4), C(0, 10)], [C(0, 5), C(0, 11)]],
    field: { cards: [C(0, 13)], seat: 0 },
    turn: 2,
  });
  st = df.onPlayerLeft(st, 2);
  assert.deepEqual(st.hands[2], []);
  assert.ok(st.leftSeats.includes(2));
  assert.ok(!st.finishOrder.includes(2), "退出者に順位は付けない");
  assert.equal(st.turn, 0);
  assert.equal(st.finished, false);

  // 2人で1人退出 → 終了し、残った人が順位に入る
  const two = dfState({ hands: [[C(0, 3)], [C(0, 4)]], turn: 0 });
  const afterTwo = df.onPlayerLeft(two, 1);
  assert.equal(afterTwo.finished, true);
  assert.deepEqual(afterTwo.finishOrder, [0]);

  // 退出で流れ条件を満たすようになったら場が流れる（4人: パス2件＋手番の退出）
  let four = dfState({
    players: players(4),
    hands: [[C(0, 3)], [C(0, 4)], [C(0, 5)], [C(0, 6)]],
    field: { cards: [C(0, 13)], seat: 0 },
    passStreak: 2,
    turn: 3,
  });
  four = df.onPlayerLeft(four, 3);
  assert.equal(four.field, null);
  assert.equal(four.turn, 0);
  assert.equal(four.finished, false);
});

test("daifugo: parseAction と純関数性", () => {
  assert.deepEqual(df.parseAction({ type: "pass" }), { type: "pass" });
  assert.deepEqual(df.parseAction({ type: "play", cards: [0, 13] }), { type: "play", cards: [0, 13] });
  assert.equal(df.parseAction({ type: "play", cards: ["x"] }), null);
  assert.equal(df.parseAction({}), null);
  assert.equal(df.parseAction(null), null);

  const st = dfState({ hands: [[C(0, 3), C(0, 4)], [C(0, 5)]], turn: 0 });
  const before = JSON.stringify(st);
  df.applyAction(st, 0, { type: "play", cards: [C(0, 3)] }, rng);
  assert.equal(JSON.stringify(st), before, "元の state を破壊しない");
});

test("daifugo: stalemate 裁定（全員が反則あがりしか持たず、リードパスが一周したら終了）", () => {
  // seat0 は ♦8 単体、seat1 はジョーカー単体。どちらも出すと反則あがりに
  // なるため、合法手はリードパスしか存在しない局面。
  let st = dfState({ hands: [[C(2, 8)], [52]], turn: 0 });
  st = df.applyAction(st, 0, { type: "pass" }, rng);
  assert.equal(st.finished, false);
  assert.equal(st.turn, 1);
  st = df.applyAction(st, 1, { type: "pass" }, rng);
  assert.equal(st.finished, true, "リードパスが現役全員分連続したら終了する");
  assert.deepEqual(st.finishOrder, [0, 1], "残りの現役は seat 順に順位確定");
});
