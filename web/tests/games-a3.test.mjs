// A3 フェーズ4本のロジック検証（lib のみ、UI 非依存）。
// - lib/slot.ts: 配当判定・チップ計算・確率表
// - lib/bingo.ts: カード生成・ライン判定・進行と勝敗
// - lib/amida.ts: 到達先計算（置換性）・経路トレース
// - lib/kanacross.ts: 盤データ整合性・完成判定・単語チェック
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const libDir = path.join(import.meta.dirname, "..", "lib");

async function loadLib(name) {
  const src = fs.readFileSync(path.join(libDir, name), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}

const slot = await loadLib("slot.ts");
const bingo = await loadLib("bingo.ts");
const amida = await loadLib("amida.ts");
const kana = await loadLib("kanacross.ts");

// ---------- スロット ----------

test("スロット: 確率表の合計は1で、還元率は胴元有利の範囲", () => {
  const sum = slot.SLOT_SYMBOLS.reduce((acc, s) => acc + slot.symbolProbability(s.id), 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.equal(slot.SLOT_TOTAL_WEIGHT, 100);
  const rtp = slot.expectedReturnRate();
  assert.ok(rtp > 0.6 && rtp < 0.98, `RTP=${rtp}`);
});

test("スロット: 3つ揃いの配当は配当表どおり", () => {
  for (const s of slot.SLOT_SYMBOLS) {
    const r = slot.evaluateReels([s.id, s.id, s.id], 100);
    assert.equal(r.kind, "three");
    assert.equal(r.payout, 100 * s.three);
    assert.equal(r.delta, 100 * s.three - 100);
  }
});

test("スロット: 先頭2つのチェリーは2倍、位置が違うと無配当", () => {
  const pair = slot.evaluateReels(["cherry", "cherry", "lemon"], 50);
  assert.equal(pair.kind, "cherryPair");
  assert.equal(pair.payout, 100);
  const miss = slot.evaluateReels(["lemon", "cherry", "cherry"], 50);
  assert.equal(miss.kind, "none");
  assert.equal(miss.payout, 0);
  assert.equal(miss.delta, -50);
});

test("スロット: スピンは決定的で、チップ計算が配当と一致する", () => {
  const a = slot.spin(slot.createSlotGame(42, 1000), 100);
  const b = slot.spin(slot.createSlotGame(42, 1000), 100);
  assert.deepEqual(a.reels, b.reels);
  assert.equal(a.spins, 1);
  const expected = slot.evaluateReels(a.reels, 100);
  assert.equal(a.chips, 1000 - 100 + expected.payout);
  assert.deepEqual(a.result, expected);
});

test("スロット: 不正なベットは無効、破産時は再支給できる", () => {
  const s = slot.createSlotGame(1, 100);
  assert.equal(slot.spin(s, 5), s); // 最低ベット未満
  assert.equal(slot.spin(s, 500), s); // チップ不足
  const broke = slot.createSlotGame(1, 0);
  assert.equal(slot.refillChips(broke).chips, slot.SLOT_INITIAL_CHIPS);
  assert.equal(slot.refillChips(s), s); // 残っているときは再支給しない
});

// ---------- ビンゴ ----------

test("ビンゴ: 生成される全カードが正しく、抽選プールは1〜75の置換", () => {
  const g = bingo.createBingoGame(7);
  assert.ok(bingo.isValidCard(g.playerCard));
  assert.equal(g.cpuCards.length, bingo.BINGO_CPU_COUNT);
  for (const c of g.cpuCards) assert.ok(bingo.isValidCard(c));
  assert.deepEqual(
    [...g.pool].sort((x, y) => x - y),
    Array.from({ length: 75 }, (_, i) => i + 1),
  );
  const g2 = bingo.createBingoGame(7);
  assert.deepEqual(g.playerCard, g2.playerCard);
});

test("ビンゴ: 列の範囲と文字が正しい", () => {
  assert.deepEqual(bingo.columnRange(0), { min: 1, max: 15 });
  assert.deepEqual(bingo.columnRange(4), { min: 61, max: 75 });
  assert.equal(bingo.columnLetter(1), "B");
  assert.equal(bingo.columnLetter(31), "N");
  assert.equal(bingo.columnLetter(75), "O");
});

test("ビンゴ: ライン完成とリーチの判定", () => {
  const g = bingo.createBingoGame(3);
  const card = g.playerCard;
  const row0 = [0, 1, 2, 3, 4].map((i) => card.cells[i]).filter((v) => v !== 0);
  // 横1行目を全部引いた状態 → row0 が完成
  const full = bingo.completedLines(card, row0);
  assert.ok(full.includes("row0"));
  assert.equal(bingo.cardStatus(card, row0).bingo, true);
  // 1つ欠け → リーチ
  const almost = row0.slice(1);
  assert.ok(bingo.reachLines(card, almost).includes("row0"));
  const st = bingo.cardStatus(card, almost);
  assert.equal(st.bingo, false);
  assert.equal(st.reach, true);
  assert.equal(st.minRemaining, 1);
});

test("ビンゴ: 最後まで進めると必ず決着し、勝者のカードはビンゴしている", () => {
  let g = bingo.createBingoGame(99);
  let guard = 0;
  while (g.phase === "playing" && guard < 80) {
    g = bingo.drawNext(g);
    guard++;
  }
  assert.equal(g.phase, "finished");
  assert.ok(g.winner !== null);
  assert.equal(new Set(g.drawn).size, g.drawn.length);
  const winnerCard = g.winner.type === "player" ? g.playerCard : g.cpuCards[g.winner.index];
  assert.equal(bingo.cardStatus(winnerCard, g.drawn).bingo, true);
  // 終了後の drawNext は無効
  assert.equal(bingo.drawNext(g), g);
});

// ---------- あみだくじ ----------

test("あみだ: 到達先は必ず置換になり、経路は正しい長さで隣接移動のみ", () => {
  for (const count of [2, 3, 5, 8]) {
    for (const seed of [1, 42, 777]) {
      const s = amida.createAmida(count, seed);
      assert.ok(amida.isValidAmida(s));
      const results = amida.computeResults(s);
      assert.deepEqual(
        [...results].sort((a, b) => a - b),
        Array.from({ length: count }, (_, i) => i),
      );
      for (let start = 0; start < count; start++) {
        const { path, end } = amida.tracePath(s, start);
        assert.equal(end, results[start]);
        assert.equal(path.length, s.levels + 1);
        assert.equal(path[0], start);
        for (let k = 1; k < path.length; k++) {
          assert.ok(Math.abs(path[k] - path[k - 1]) <= 1);
        }
      }
    }
  }
});

test("あみだ: 同じシードでは同じくじになり、手作り盤の経路も正しい", () => {
  assert.deepEqual(amida.createAmida(4, 5).bars, amida.createAmida(4, 5).bars);
  const manual = {
    count: 3,
    levels: 2,
    bars: [
      [true, false],
      [false, true],
    ],
    seed: 0,
  };
  assert.deepEqual(amida.computeResults(manual), [2, 0, 1]);
  assert.deepEqual(amida.tracePath(manual, 0).path, [0, 1, 2]);
  // 範囲外の start は無効
  assert.equal(amida.tracePath(manual, 9).end, -1);
});

test("あみだ: 人数は2〜8に丸められる", () => {
  assert.equal(amida.createAmida(1, 1).count, 2);
  assert.equal(amida.createAmida(99, 1).count, 8);
});

// ---------- カナクロス ----------

test("カナクロス: 内蔵問題は全て整合している", () => {
  assert.ok(kana.KANACROSS_PUZZLES.length >= 3);
  for (const p of kana.KANACROSS_PUZZLES) {
    assert.ok(kana.isValidPuzzle(p), p.id);
  }
});

function fillAll(state, puzzle) {
  let s = state;
  puzzle.solution.forEach((ch, i) => {
    if (ch !== null) s = kana.setEntry(s, i, ch);
  });
  return s;
}

test("カナクロス: 全マス正解で完成し、完成後は入力できない", () => {
  const puzzle = kana.KANACROSS_PUZZLES[0];
  let s = kana.createKanacrossGame(0);
  s = fillAll(s, puzzle);
  assert.equal(kana.isComplete(s), true);
  assert.equal(s.status, "completed");
  const after = kana.setEntry(s, 4, "ロ");
  assert.equal(after, s);
});

test("カナクロス: 黒マスとカタカナ以外の入力は無視される", () => {
  const s = kana.createKanacrossGame(0);
  assert.equal(kana.setEntry(s, 0, "ア"), s); // index 0 は黒マス
  assert.equal(kana.setEntry(s, 4, "あ"), s); // ひらがなは不可
  assert.equal(kana.setEntry(s, 4, "AB"), s); // 2文字は不可
});

test("カナクロス: 単語の正誤判定とチェックのミス集計", () => {
  const puzzle = kana.KANACROSS_PUZZLES[0];
  let s = kana.createKanacrossGame(0);
  const word = puzzle.words.find((w) => w.id === "a1"); // ラーメン (row1)
  const cells = kana.wordCells(puzzle, word);
  assert.deepEqual(cells, [4, 5, 6, 7]);
  // 途中まで → partial
  s = kana.setEntry(s, cells[0], "ラ");
  assert.equal(kana.wordStatus(s, "a1"), "partial");
  // 間違えて全部埋める → wrong、チェックでミス+1
  s = kana.setEntry(s, cells[1], "ロ");
  s = kana.setEntry(s, cells[2], "メ");
  s = kana.setEntry(s, cells[3], "ン");
  assert.equal(kana.wordStatus(s, "a1"), "wrong");
  const checked = kana.checkWord(s, "a1");
  assert.equal(checked.status, "wrong");
  assert.equal(checked.state.mistakes, 1);
  // 直すと correct
  s = kana.setEntry(checked.state, cells[1], "ー");
  assert.equal(kana.wordStatus(s, "a1"), "correct");
  // 交差するマスは両方の単語に属する
  assert.deepEqual(kana.cellWordIds(puzzle, 4).sort(), ["a1", "d1"]);
});

test("カナクロス: 進捗カウントが正しい", () => {
  let s = kana.createKanacrossGame(1);
  const before = kana.progress(s);
  assert.equal(before.filled, 0);
  assert.ok(before.total > 0);
  s = kana.setEntry(s, 0, "ネ");
  assert.equal(kana.progress(s).filled, 1);
});
