// 第2波オンライン2本（lib/online/games/{babanuki,territory}.ts）のルール検証。
// online-board.test.mjs と同じ loadBundle 方式（TS transpile＋import 除去＋連結）で読む。
// 2モジュールとも `export const gameModule` を持つため、連結時に名前を付け替える。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const gamesDir = path.join(import.meta.dirname, "..", "lib", "online", "games");

function transpileFile(file) {
  const src = fs.readFileSync(path.join(gamesDir, file), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
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

async function loadGames() {
  const parts = [
    ["babanuki.ts", "babModule"],
    ["territory.ts", "terModule"],
  ].map(([file, name]) =>
    stripModuleSyntax(transpileFile(file)).replace(/\bgameModule\b/g, name),
  );
  const code =
    parts.join("\n") +
    `\nexport { babModule, terModule, babRemovePairs, babRankOf, BABANUKI_JOKER, TERRITORY_PIECES, TERRITORY_SIZE, territoryTransforms, transformTerritoryPiece, placementCells, isLegalTerritoryPlacement, enumerateTerritoryPlacements, territoryScores };\n`;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const {
  babModule: babanuki,
  terModule: territory,
  babRemovePairs,
  BABANUKI_JOKER,
  TERRITORY_PIECES,
  territoryTransforms,
  placementCells,
  isLegalTerritoryPlacement,
  enumerateTerritoryPlacements,
  territoryScores,
} = await loadGames();

// 決定的 rng（LCG）。
function makeRng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const players2 = () => [
  { seat: 0, name: "先手" },
  { seat: 1, name: "後手" },
];
const playersN = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, name: `P${i + 1}` }));

function babState(hands, turn = 0) {
  return {
    players: playersN(hands.length),
    hands,
    turn,
    finishOrder: [],
    loser: null,
    finished: false,
    leftSeats: [],
    lastDraw: null,
    log: [],
  };
}

/* ---------------- ババ抜き ---------------- */

test("ババ抜き: 配布後は全手札がペア無しで、ジョーカーは必ず残り、総枚数は奇数", () => {
  const rng = makeRng(7);
  const state = babanuki.createState(playersN(4), rng, {});
  let total = 0;
  let jokers = 0;
  for (const hand of state.hands) {
    total += hand.length;
    const ranks = hand.filter((c) => c !== BABANUKI_JOKER).map((c) => (c % 13) + 1);
    assert.equal(new Set(ranks).size, ranks.length, "手札に同ランクが2枚あってはいけない");
    jokers += hand.filter((c) => c === BABANUKI_JOKER).length;
    if (hand.length === 0) assert.ok(state.finishOrder.includes(state.hands.indexOf(hand)));
  }
  assert.equal(jokers, 1);
  assert.equal(total % 2, 1, "53枚からペア（偶数枚）だけ捨てるので残りは奇数");
  assert.equal(state.finished, false);
});

test("ババ抜き: ペア除去は偶数枚を捨て奇数枚を1枚残し、ジョーカーは残る", () => {
  // rank5 の id: 4,17,30,43 / rank1 の id: 0,13
  assert.deepEqual(babRemovePairs([4, 17, 30]), [4]);
  assert.deepEqual(babRemovePairs([4, 17]), []);
  assert.deepEqual(babRemovePairs([4, 17, 30, 43, BABANUKI_JOKER]), [BABANUKI_JOKER]);
  assert.deepEqual(babRemovePairs([0, 13, 4]), [4], "ランク1が2枚ならペアで消える");
  assert.deepEqual(babRemovePairs([0, 13, 26, 4]), [0, 4], "ランク1が3枚なら1枚残る");
});

test("ババ抜き: 引いてペアができると捨て、引かれた側→引いた側の順で上がり、最後の1人が負け", () => {
  // seat0: [4]=rank5, seat1: [17]=rank5, seat2: [0, 52]
  const state = babState([[4], [17], [0, BABANUKI_JOKER]], 0);
  const next = babanuki.applyAction(state, 0, { type: "draw", index: 0 }, makeRng());
  assert.deepEqual(next.finishOrder, [1, 0], "先に0枚になった引かれた側が先に上がる");
  assert.equal(next.finished, true);
  assert.equal(next.loser, 2);
  assert.deepEqual(next.hands[2], [0, BABANUKI_JOKER]);
  assert.deepEqual(next.hands[0], []);
});

test("ババ抜き: ペアにならない引きでは手札が増え、手番が次へ移る", () => {
  // seat0: [0]=rank1, seat1: [14]=rank2,[27]=rank2, seat2: [52]
  const state = babState([[0], [14, 27], [BABANUKI_JOKER]], 0);
  const next = babanuki.applyAction(state, 0, { type: "draw", index: 0 }, makeRng());
  assert.deepEqual(next.hands[0], [0, 14]);
  assert.deepEqual(next.hands[1], [27]);
  assert.equal(next.turn, 1);
  assert.deepEqual(next.lastDraw, { seat: 0, from: 1, paired: false });
  assert.equal(next.finished, false);
});

test("ババ抜き: 手番違いと不正な位置は日本語エラーで弾く", () => {
  const state = babState([[0], [14, 27], [BABANUKI_JOKER]], 0);
  assert.throws(() => babanuki.applyAction(state, 1, { type: "draw", index: 0 }, makeRng()), /手番ではありません/);
  assert.throws(() => babanuki.applyAction(state, 0, { type: "draw", index: 2 }, makeRng()), /位置が不正/);
  assert.equal(babanuki.parseAction({ type: "draw", index: 1.5 }), null);
  assert.equal(babanuki.parseAction({ type: "pass" }), null);
  assert.deepEqual(babanuki.parseAction({ type: "draw", index: 0 }), { type: "draw", index: 0 });
});

test("ババ抜き: viewFor は他人の手札を枚数だけに隠し、自分の手札は見える", () => {
  const state = babState([[0, 14], [27], [BABANUKI_JOKER]], 1);
  const view = babanuki.viewFor(state, 0);
  assert.deepEqual(view.yourHand, [0, 14]);
  const other1 = view.others.find((o) => o.seat === 1);
  assert.equal(other1.count, 1);
  assert.deepEqual(Object.keys(other1).sort(), ["count", "left", "name", "rank", "seat"]);
  const other2 = view.others.find((o) => o.seat === 2);
  assert.equal(other2.count, 1, "ジョーカー保持者の枚数だけが見え、中身は見えない");
  assert.deepEqual(Object.keys(other2).sort(), ["count", "left", "name", "rank", "seat"]);
});

test("ババ抜き: CPU同士の対戦は必ず終わり、敗者はジョーカー1枚だけを持つ", () => {
  for (const n of [2, 3, 4]) {
    const rng = makeRng(100 + n);
    let state = babanuki.createState(playersN(n), rng, {});
    let steps = 0;
    while (!state.finished && steps < 2000) {
      const action = babanuki.cpuAction(state, state.turn, rng);
      assert.ok(action, `手番 ${state.turn} の CPU 手がある`);
      state = babanuki.applyAction(state, state.turn, action, rng);
      steps++;
    }
    assert.equal(state.finished, true, `${n}人対戦が終了する`);
    assert.notEqual(state.loser, null);
    assert.deepEqual(state.hands[state.loser], [BABANUKI_JOKER]);
    assert.equal(state.finishOrder.length, n - 1);
  }
});

test("ババ抜き: 退出者は脱落して対戦は続き、現役が1人になったらジョーカー保持者が負け", () => {
  const state = babState([[0], [14], [BABANUKI_JOKER]], 0);
  const after1 = babanuki.onPlayerLeft(state, 1);
  assert.deepEqual(after1.leftSeats, [1]);
  assert.deepEqual(after1.hands[1], []);
  assert.equal(after1.finished, false);
  assert.equal(after1.turn, 0);
  assert.equal(babanuki.viewFor(after1, 0).drawFrom, 2, "引く相手は退出者を飛ばす");
  const after2 = babanuki.onPlayerLeft(after1, 0);
  assert.equal(after2.finished, true);
  assert.equal(after2.loser, 2);
});

/* ---------------- テリトリオ ---------------- */

test("テリトリオ: 初期状態は空盤でピースは両者12種ずつ", () => {
  const state = territory.createState(players2(), makeRng(), {});
  assert.equal(state.board.length, 100);
  assert.ok(state.board.every((v) => v === 0));
  assert.equal(state.used[0].length, TERRITORY_PIECES.length);
  assert.equal(state.used[1].length, TERRITORY_PIECES.length);
  assert.deepEqual(territoryScores(state.board), [0, 0]);
  assert.equal(state.turn, 0);
});

test("テリトリオ: 最初のピースは自分の角を含まなければならない", () => {
  const state = territory.createState(players2(), makeRng(), {});
  assert.throws(
    () => territory.applyAction(state, 0, { type: "place", piece: 1, cells: [10, 11] }, makeRng()),
    /角のマス/,
  );
  const s1 = territory.applyAction(state, 0, { type: "place", piece: 1, cells: [0, 1] }, makeRng());
  assert.equal(s1.board[0], 1);
  assert.equal(s1.board[1], 1);
  assert.equal(s1.turn, 1);
  // seat1 の角は右下 (9,9)=99
  assert.throws(
    () => territory.applyAction(s1, 1, { type: "place", piece: 1, cells: [90, 91] }, makeRng()),
    /角のマス/,
  );
  const s2 = territory.applyAction(s1, 1, { type: "place", piece: 1, cells: [98, 99] }, makeRng());
  assert.equal(s2.board[99], 2);
  assert.equal(s2.turn, 0);
});

test("テリトリオ: 辺接触は禁止、角接触は必須、重なりと形違いは不可", () => {
  let s = territory.createState(players2(), makeRng(), {});
  s = territory.applyAction(s, 0, { type: "place", piece: 1, cells: [0, 1] }, makeRng());
  s = territory.applyAction(s, 1, { type: "place", piece: 1, cells: [98, 99] }, makeRng());
  // (0,2)=2 は自分の (0,1) と辺で接する
  assert.throws(
    () => territory.applyAction(s, 0, { type: "place", piece: 0, cells: [2] }, makeRng()),
    /辺で接する/,
  );
  // (1,2)=12 は (0,1) と角で接し、辺では接しない → 置ける
  const s2 = territory.applyAction(s, 0, { type: "place", piece: 0, cells: [12] }, makeRng());
  assert.equal(s2.board[12], 1);
  // seat1: 角でも接しない場所は不可
  assert.throws(
    () => territory.applyAction(s2, 1, { type: "place", piece: 0, cells: [50] }, makeRng()),
    /角で接する/,
  );
  // seat1: 埋まっているマスは不可
  assert.throws(
    () => territory.applyAction(s2, 1, { type: "place", piece: 0, cells: [99] }, makeRng()),
    /埋まっている/,
  );
  // seat1: トリオミノ I（piece 2）に L 字の cells は形違い
  assert.throws(
    () => territory.applyAction(s2, 1, { type: "place", piece: 2, cells: [87, 97, 98] }, makeRng()),
    /形と一致しない/,
  );
});

test("テリトリオ: 合法手列挙は初手が必ず自分の角を含み、isLegal と一致する", () => {
  const state = territory.createState(players2(), makeRng(), {});
  const moves0 = enumerateTerritoryPlacements(state.board, 0, state.used[0]);
  assert.ok(moves0.length > 0);
  assert.ok(moves0.every((m) => m.cells.includes(0)));
  const moves1 = enumerateTerritoryPlacements(state.board, 1, state.used[1]);
  assert.ok(moves1.every((m) => m.cells.includes(99)));
  assert.ok(isLegalTerritoryPlacement(state.board, 0, [0, 1]));
  assert.equal(isLegalTerritoryPlacement(state.board, 0, [10, 11]), false);
});

test("テリトリオ: 置けるうちはパスできず、両者連続パスでマス数により終了する", () => {
  const fresh = territory.createState(players2(), makeRng(), {});
  assert.throws(() => territory.applyAction(fresh, 0, { type: "pass" }, makeRng()), /パスできません/);

  const full = {
    players: players2(),
    board: Array.from({ length: 100 }, (_, i) => (i === 0 ? 1 : 2)),
    used: [new Array(12).fill(false), new Array(12).fill(false)],
    turn: 0,
    passStreak: 0,
    finished: false,
    winner: null,
    lastMove: null,
    lastPassSeat: null,
  };
  const p1 = territory.applyAction(full, 0, { type: "pass" }, makeRng());
  assert.equal(p1.finished, false);
  assert.equal(p1.turn, 1);
  assert.equal(p1.passStreak, 1);
  const p2 = territory.applyAction(p1, 1, { type: "pass" }, makeRng());
  assert.equal(p2.finished, true);
  assert.equal(p2.winner, 1);
  assert.deepEqual(territoryScores(p2.board), [1, 99]);
});

test("テリトリオ: CPU の初手は最大サイズのピースを自分の角に置く", () => {
  const state = territory.createState(players2(), makeRng(), {});
  const action = territory.cpuAction(state, 0, makeRng(3));
  assert.equal(action.type, "place");
  assert.equal(action.cells.length, 5);
  assert.ok(action.cells.includes(0));
  assert.ok(isLegalTerritoryPlacement(state.board, 0, action.cells));
});

test("テリトリオ: 向きの数と配置セルの基本（対称ピースは重複しない）", () => {
  assert.equal(territoryTransforms(5).length, 1, "スクエアは1通り");
  assert.equal(territoryTransforms(6).length, 4, "テトロミノ T は4通り");
  assert.equal(territoryTransforms(0).length, 1, "ミニは1通り");
  assert.deepEqual(placementCells(1, 0, false, 0, 0), [0, 1]);
  assert.equal(placementCells(4, 0, false, 0, 8), null, "盤外にはみ出す配置は null");
  assert.deepEqual(placementCells(4, 1, false, 0, 9), [9, 19, 29, 39], "回転した I は縦になる");
});

test("テリトリオ: 退出で相手の勝ちになり、parseAction は不正形式を null にする", () => {
  const state = territory.createState(players2(), makeRng(), {});
  const left = territory.onPlayerLeft(state, 0);
  assert.equal(left.finished, true);
  assert.equal(left.winner, 1);
  assert.deepEqual(territory.parseAction({ type: "pass" }), { type: "pass" });
  assert.deepEqual(territory.parseAction({ type: "place", piece: 1, cells: [0, 1] }), {
    type: "place",
    piece: 1,
    cells: [0, 1],
  });
  assert.equal(territory.parseAction({ type: "place", piece: "x", cells: [0] }), null);
  assert.equal(territory.parseAction({ type: "unknown" }), null);
  assert.equal(territory.parseAction(null), null);
});
