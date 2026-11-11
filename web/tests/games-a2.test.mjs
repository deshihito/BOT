// A2 フェーズ新規4本のロジック検証（lib のみ、UI 非依存）。
// - lib/nonogram.ts: ヒント計算・完成判定・ミス照合・変形
// - lib/peg.ts: 合法手・行き詰まり・評価
// - lib/hanoi.ts: 最少手数・解答生成・合法判定
// - lib/online/games/speed.ts: ±1判定・つなぎ札リセット・秘匿ビュー
// online モジュールは games-falling-online2.test.mjs と同じ transpile＋連結方式で読む。
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

async function loadSpeed() {
  const src = fs.readFileSync(path.join(libDir, "online", "games", "speed.ts"), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const body = stripModuleSyntax(js).replace(/\bgameModule\b/g, "speedModule");
  const code =
    body + `\nexport { speedModule, speedRankOf, speedCanPlayOn, speedLegalPlays };\n`;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const nono = await loadLib("nonogram.ts");
const peg = await loadLib("peg.ts");
const hanoi = await loadLib("hanoi.ts");
const { speedModule: speed, speedRankOf, speedCanPlayOn, speedLegalPlays } = await loadSpeed();

const players = () => [
  { seat: 0, name: "先手" },
  { seat: 1, name: "後手" },
];
function makeRng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
/** ランク（1=A…13=K）とスート（0〜3）からカード id を作る。 */
const cid = (rank, suit = 0) => suit * 13 + (rank - 1);

/* ---------------- ノノグラム ---------------- */

test("ノノグラム: 内蔵パターンは全て正方形で記号が正しい", () => {
  assert.ok(nono.NONOGRAM_PATTERNS.length >= 6);
  const sizes = new Set(nono.NONOGRAM_PATTERNS.map((p) => p.size));
  assert.ok(sizes.has(10) && sizes.has(15));
  for (const p of nono.NONOGRAM_PATTERNS) {
    assert.equal(p.rows.length, p.size, p.id);
    let filled = 0;
    for (const row of p.rows) {
      assert.equal(row.length, p.size, p.id);
      assert.match(row, /^[#.]+$/, p.id);
      filled += [...row].filter((ch) => ch === "#").length;
    }
    const ratio = filled / (p.size * p.size);
    assert.ok(ratio > 0.1 && ratio < 0.95, `${p.id} の塗り率 ${ratio}`);
  }
});

test("ノノグラム: ヒント計算は連続数を数え、空行は [0]", () => {
  assert.deepEqual(
    nono.lineHints([true, true, false, true, false, false, true, true, true]),
    [2, 1, 3],
  );
  assert.deepEqual(nono.lineHints([false, false, false]), [0]);
  assert.deepEqual(nono.lineHints([true, true, true, true]), [4]);
  assert.deepEqual(nono.lineHints([true, false, true]), [1, 1]);
});

test("ノノグラム: 生成された問題の行列ヒントは正解と一致する", () => {
  for (const size of [10, 15]) {
    const game = nono.createNonogramGame(7, size);
    assert.equal(game.marks.length, size * size);
    assert.equal(game.rowHints.length, size);
    assert.equal(game.colHints.length, size);
    for (let r = 0; r < size; r++) {
      assert.deepEqual(game.rowHints[r], nono.lineHints(game.solution.slice(r * size, r * size + size)));
    }
    for (let c = 0; c < size; c++) {
      const line = [];
      for (let r = 0; r < size; r++) line.push(game.solution[r * size + c]);
      assert.deepEqual(game.colHints[c], nono.lineHints(line));
    }
  }
});

test("ノノグラム: 同じシードでは同じ問題になる", () => {
  const a = nono.createNonogramGame(42, 10);
  const b = nono.createNonogramGame(42, 10);
  assert.equal(a.patternId, b.patternId);
  assert.equal(a.transform, b.transform);
  assert.deepEqual(a.solution, b.solution);
});

test("ノノグラム: 変形（左右反転・90度回転）は位置を正しく移す", () => {
  const solution = nono.patternToSolution(["##.", "...", "..."]);
  const flipped = nono.transformSolution(solution, 3, "flipH");
  assert.deepEqual(flipped, nono.patternToSolution([".##", "...", "..."]));
  const rotated = nono.transformSolution(solution, 3, "rot90");
  assert.deepEqual(rotated, nono.patternToSolution(["..#", "..#", "..."]));
  const inverted = nono.transformSolution(solution, 3, "invert");
  assert.equal(inverted.filter(Boolean).length, 7);
});

test("ノノグラム: 正解を全部塗ると完成、完成後の操作は無効", () => {
  let game = nono.createNonogramGame(3, 10);
  game.solution.forEach((cell, i) => {
    if (cell) game = nono.setNonoMark(game, i, 1);
  });
  assert.equal(game.status, "won");
  assert.equal(nono.isNonogramComplete(game.solution, game.marks), true);
  const after = nono.setNonoMark(game, 0, 2);
  assert.equal(after, game);
});

test("ノノグラム: 間違い塗りはミスとして数えられ、消すとエラーから下りる", () => {
  let game = nono.createNonogramGame(3, 10);
  const wrong = game.solution.findIndex((cell) => !cell);
  assert.ok(wrong >= 0);
  game = nono.setNonoMark(game, wrong, 1);
  assert.equal(game.mistakes, 1);
  assert.deepEqual(game.errors, [wrong]);
  assert.equal(game.status, "playing");
  // 同じマスへの再設定は数え直さない
  const again = nono.setNonoMark(game, wrong, 1);
  assert.equal(again, game);
  game = nono.setNonoMark(game, wrong, 0);
  assert.deepEqual(game.errors, []);
  assert.equal(game.mistakes, 1);
});

test("ノノグラム: ×印は完成判定にもミスにも影響しない", () => {
  let game = nono.createNonogramGame(11, 10);
  const wrong = game.solution.findIndex((cell) => !cell);
  game = nono.setNonoMark(game, wrong, 2);
  assert.equal(game.mistakes, 0);
  assert.deepEqual(game.errors, []);
  game.solution.forEach((cell, i) => {
    if (cell) game = nono.setNonoMark(game, i, 1);
  });
  assert.equal(game.status, "won");
});

/* ---------------- ペグソリティア ---------------- */

test("ペグ: 初期配置はペグ32個・中央だけ空き・合法手は4つ", () => {
  const state = peg.createPegGame();
  assert.equal(state.cells.length, 49);
  assert.equal(state.cells.filter((c) => c !== 0).length, 33);
  assert.equal(peg.pegCount(state), 32);
  assert.equal(state.cells[3 * 7 + 3], 2);
  assert.equal(peg.pegLegalMoves(state).length, 4);
  assert.ok(peg.pegLegalMoves(state).every((m) => m.to === 3 * 7 + 3));
});

test("ペグ: 合法手を打つとペグが1つ減り、飛び越えたペグが消える", () => {
  const state = peg.createPegGame();
  const move = peg.pegLegalMoves(state)[0];
  const next = peg.applyPegMove(state, move);
  assert.notEqual(next, state);
  assert.equal(next.moves, 1);
  assert.equal(peg.pegCount(next), 31);
  assert.equal(next.cells[move.from], 2);
  assert.equal(next.cells[move.over], 2);
  assert.equal(next.cells[move.to], 1);
});

test("ペグ: 不合法な手は状態を変えない", () => {
  const state = peg.createPegGame();
  const bogus = { from: 0, over: 1, to: 2 }; // 盤外マス
  assert.equal(peg.applyPegMove(state, bogus), state);
  const noJump = { from: 3 * 7 + 2, over: 3 * 7 + 3, to: 3 * 7 + 4 }; // 飛び先が埋まっている
  assert.equal(peg.isPegMoveLegal(state, noJump), false);
  assert.equal(peg.applyPegMove(state, noJump), state);
});

test("ペグ: 貪欲に打ち続けると行き詰まり、残り数と手数が一致する", () => {
  let state = peg.createPegGame();
  let guard = 0;
  while (state.status === "playing" && guard++ < 40) {
    const moves = peg.pegLegalMoves(state);
    assert.ok(moves.length > 0);
    state = peg.applyPegMove(state, moves[0]);
  }
  assert.notEqual(state.status, "playing");
  assert.equal(peg.isPegStuck(state), true);
  assert.equal(peg.pegCount(state), 32 - state.moves);
});

test("ペグ: 孤立したペグだけの盤は行き詰まり、評価は残り数で変わる", () => {
  const base = peg.createPegGame();
  const cells = base.cells.map((c) => (c === 0 ? 0 : 2));
  cells[0 * 7 + 3] = 1;
  cells[3 * 7 + 2] = 1;
  const stuck = { cells, moves: 0, status: "playing" };
  assert.equal(peg.pegCount(stuck), 2);
  assert.equal(peg.pegLegalMoves(stuck).length, 0);
  assert.equal(peg.isPegStuck(stuck), true);
  assert.match(peg.pegRating(1), /パーフェクト/);
  assert.match(peg.pegRating(2), /素晴らしい/);
  assert.notEqual(peg.pegRating(1), peg.pegRating(6));
});

/* ---------------- ハノイの塔 ---------------- */

test("ハノイ: 最少手数は 2^n - 1", () => {
  assert.equal(hanoi.hanoiMinMoves(3), 7);
  assert.equal(hanoi.hanoiMinMoves(4), 15);
  assert.equal(hanoi.hanoiMinMoves(5), 31);
  assert.equal(hanoi.hanoiMinMoves(8), 255);
});

test("ハノイ: 初期配置は左の柱に大きい順（下→上）", () => {
  const state = hanoi.createHanoiGame(4);
  assert.deepEqual(state.pegs, [[4, 3, 2, 1], [], []]);
  assert.equal(state.status, "playing");
  assert.equal(hanoi.hanoiTop(state, 0), 1);
  assert.equal(hanoi.hanoiTop(state, 1), null);
});

test("ハノイ: 空き柱から・同じ柱へ・大きい円盤を小さい円盤の上へは動かせない", () => {
  const state = hanoi.createHanoiGame(3);
  assert.equal(hanoi.moveDisk(state, 1, 2), state);
  assert.equal(hanoi.moveDisk(state, 0, 0), state);
  const step1 = hanoi.moveDisk(state, 0, 1);
  assert.notEqual(step1, state);
  assert.equal(step1.moves, 1);
  // 柱0の一番上は2、柱1の一番上は1 → 2を1の上には置けない
  assert.equal(hanoi.canMoveDisk(step1, 0, 1), false);
  assert.equal(hanoi.moveDisk(step1, 0, 1), step1);
});

test("ハノイ: 解答手順は最少手数で、通りに動かすと解ける", () => {
  for (const n of [3, 4, 5]) {
    const solution = hanoi.hanoiSolution(n);
    assert.equal(solution.length, hanoi.hanoiMinMoves(n));
    let state = hanoi.createHanoiGame(n);
    for (const move of solution) {
      assert.equal(hanoi.canMoveDisk(state, move.from, move.to), true);
      state = hanoi.moveDisk(state, move.from, move.to);
    }
    assert.equal(state.status, "solved");
    assert.equal(state.moves, solution.length);
    assert.equal(hanoi.isHanoiSolved(state), true);
    assert.deepEqual(state.pegs[2], Array.from({ length: n }, (_, i) => n - i));
  }
});

/* ---------------- スピード（オンライン） ---------------- */

test("スピード: 配布は場札4・山札21・中央1で、全52枚が重複なく行き渡る", () => {
  const state = speed.createState(players(), makeRng(42), {});
  assert.equal(state.hands[0].length, 4);
  assert.equal(state.hands[1].length, 4);
  assert.equal(state.stocks[0].length, 21);
  assert.equal(state.stocks[1].length, 21);
  assert.equal(state.centers[0].length, 1);
  assert.equal(state.centers[1].length, 1);
  const all = [...state.hands.flat(), ...state.stocks.flat(), ...state.centers.flat()];
  assert.equal(all.length, 52);
  assert.equal(new Set(all).size, 52);
  assert.equal(speed.isFinished(state), false);
  assert.equal(speed.phaseOf(state), "playing");
});

test("スピード: ±1判定は循環する（A↔K・A↔2）", () => {
  assert.equal(speedRankOf(cid(1)), 1);
  assert.equal(speedRankOf(cid(13)), 13);
  assert.equal(speedCanPlayOn(cid(5), cid(4)), true);
  assert.equal(speedCanPlayOn(cid(5), cid(6)), true);
  assert.equal(speedCanPlayOn(cid(5), cid(7)), false);
  assert.equal(speedCanPlayOn(cid(5), cid(5)), false);
  assert.equal(speedCanPlayOn(cid(1), cid(13)), true);
  assert.equal(speedCanPlayOn(cid(13), cid(1)), true);
  assert.equal(speedCanPlayOn(cid(1), cid(2)), true);
  assert.equal(speedCanPlayOn(cid(2), cid(13)), false);
});

function speedCustom(overrides = {}) {
  return {
    players: players(),
    hands: [[cid(5)], [cid(9)]],
    stocks: [[cid(2)], [cid(3)]],
    centers: [[cid(7)], [cid(12)]],
    connectReady: [false, false],
    connectCount: 0,
    finished: false,
    winner: null,
    leftSeats: [],
    lastPlay: null,
    ...overrides,
  };
}

test("スピード: 合法手はサーバー側で検証され、不正な札は出せない", () => {
  const state = speedCustom({
    hands: [[cid(5)], [cid(9)]],
    stocks: [[], []],
    centers: [[cid(4)], [cid(10)]],
  });
  assert.deepEqual(speedLegalPlays(state, 0), [{ handIndex: 0, center: 0 }]);
  assert.throws(
    () => speed.applyAction(state, 0, { type: "play", handIndex: 0, center: 1 }, makeRng()),
    /±1/,
  );
  assert.throws(
    () => speed.applyAction(state, 0, { type: "play", handIndex: 3, center: 0 }, makeRng()),
    /場札/,
  );
});

test("スピード: 出すと中央に乗り、山札から補充され、無くなれば勝ち", () => {
  const state = speedCustom({
    hands: [[cid(5), cid(11)], [cid(9)]],
    stocks: [[cid(6), cid(7), cid(8)], [cid(3)]],
    centers: [[cid(4)], [cid(10)]],
  });
  const after = speed.applyAction(state, 0, { type: "play", handIndex: 0, center: 0 }, makeRng());
  assert.equal(after.centers[0][after.centers[0].length - 1], cid(5));
  assert.equal(after.hands[0].length, 4); // 補充で4枚に戻る
  assert.equal(after.stocks[0].length, 0);
  assert.equal(after.finished, false);
  assert.deepEqual(after.lastPlay, { seat: 0, card: cid(5), center: 0 });

  const lastOne = speedCustom({
    hands: [[cid(5)], [cid(9)]],
    stocks: [[], [cid(3)]],
    centers: [[cid(4)], [cid(10)]],
  });
  const won = speed.applyAction(lastOne, 0, { type: "play", handIndex: 0, center: 0 }, makeRng());
  assert.equal(won.finished, true);
  assert.equal(won.winner, 0);
  assert.equal(speed.phaseOf(won), "finished");
});

test("スピード: つなぎ札は出せる札があると使えず、両者の合意で中央がリセットされる", () => {
  const playable = speedCustom({
    hands: [[cid(5)], [cid(9)]],
    stocks: [[cid(2)], [cid(3)]],
    centers: [[cid(4)], [cid(12)]],
  });
  assert.throws(
    () => speed.applyAction(playable, 0, { type: "connect" }, makeRng()),
    /つなぎ札は出せません/,
  );

  const stuck = speedCustom();
  assert.equal(speedLegalPlays(stuck, 0).length, 0);
  assert.equal(speedLegalPlays(stuck, 1).length, 0);
  const ready = speed.applyAction(stuck, 0, { type: "connect" }, makeRng());
  assert.deepEqual(ready.connectReady, [true, false]);
  assert.equal(ready.centers[0][ready.centers[0].length - 1], cid(7)); // まだ変わらない
  const reset = speed.applyAction(ready, 1, { type: "connect" }, makeRng());
  assert.deepEqual(reset.connectReady, [false, false]);
  assert.equal(reset.connectCount, 1);
  // 各自の山札の上が、対応する中央の山に乗る
  assert.equal(reset.centers[0][reset.centers[0].length - 1], cid(2));
  assert.equal(reset.centers[1][reset.centers[1].length - 1], cid(3));
  assert.equal(reset.stocks[0].length, 0);
  assert.equal(reset.stocks[1].length, 0);
});

test("スピード: ビューでは相手の山札の中身が見えない（枚数だけ）", () => {
  const state = speed.createState(players(), makeRng(9), {});
  const view = speed.viewFor(state, 0);
  assert.equal(view.you.stockCount, 21);
  assert.equal(view.opponent.stockCount, 21);
  assert.equal(view.opponent.hand.length, 4); // 場札は公開
  assert.deepEqual(Object.keys(view.opponent).sort(), [
    "hand",
    "left",
    "name",
    "seat",
    "stockCount",
    "total",
  ]);
  assert.equal("stocks" in view, false);
  const opponentStockIds = new Set(state.stocks[1]);
  for (const card of view.opponent.hand) {
    assert.equal(opponentStockIds.has(card), false);
  }
  // 中央の一番上は公開情報として見える
  assert.equal(view.centers[0].top, state.centers[0][state.centers[0].length - 1]);
  assert.equal(view.centers[0].count, 1);
});

test("スピード: 退出したプレイヤーの相手が不戦勝になる／アクション形式の検証", () => {
  const state = speed.createState(players(), makeRng(5), {});
  const left = speed.onPlayerLeft(state, 1);
  assert.equal(left.finished, true);
  assert.equal(left.winner, 0);
  assert.equal(speed.parseAction({ type: "play", handIndex: 2, center: 1 })?.type, "play");
  assert.deepEqual(speed.parseAction({ type: "connect" }), { type: "connect" });
  assert.equal(speed.parseAction({ type: "play", handIndex: -1, center: 0 }), null);
  assert.equal(speed.parseAction({ type: "play", handIndex: 0, center: 2 }), null);
  assert.equal(speed.parseAction({ type: "draw" }), null);
  assert.equal(speed.parseAction(null), null);
});
