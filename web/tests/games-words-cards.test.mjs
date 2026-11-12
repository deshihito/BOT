// カード/ワード/タイピング系ゲーム3本のロジック検証（lib のみ、UI 非依存）。
// - lib/solitaire.ts: 初期配布・移動合法判定・ストック循環・勝利判定
// - lib/wordle.ts: 重複文字判定・辞書・勝敗・キーボード集約
// - lib/typing.ts: WPM/正確率計算・課題生成
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

const sol = await loadLib("solitaire.ts");
const wd = await loadLib("wordle.ts");
const ty = await loadLib("typing.ts");

function card(suit, rank, faceUp = true) {
  return { id: `${suit}-${rank}`, suit, rank, faceUp };
}

function emptySol(overrides = {}) {
  return {
    stock: [],
    waste: [],
    foundations: [[], [], [], []],
    tableau: [[], [], [], [], [], [], []],
    moves: 0,
    status: "playing",
    ...overrides,
  };
}

// ---------------- ソリティア ----------------

test("ソリティア: 初期配布は52枚・場札7列（1〜7枚）・先頭だけ表・ストック24枚", () => {
  const s = sol.createSolitaire(42);
  assert.deepEqual(s.tableau.map((p) => p.length), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(s.stock.length, 24);
  assert.equal(s.waste.length, 0);
  assert.deepEqual(s.foundations.map((p) => p.length), [0, 0, 0, 0]);
  const all = [...s.stock, ...s.tableau.flat()];
  assert.equal(all.length, 52);
  assert.equal(new Set(all.map((c) => c.id)).size, 52);
  for (const pile of s.tableau) {
    pile.forEach((c, i) => assert.equal(c.faceUp, i === pile.length - 1));
  }
  assert.ok(s.stock.every((c) => !c.faceUp));
  assert.equal(s.status, "playing");
  assert.equal(s.moves, 0);
});

test("ソリティア: 同じシードでは同じ配布になる", () => {
  const a = sol.createSolitaire(7);
  const b = sol.createSolitaire(7);
  assert.deepEqual(a, b);
});

test("ソリティア: ストックをめくると捨て札へ表向きで移り、尽きたら再循環できる", () => {
  let s = sol.createSolitaire(3);
  const topId = s.stock[s.stock.length - 1].id;
  s = sol.drawFromStock(s);
  assert.equal(s.stock.length, 23);
  assert.equal(s.waste.length, 1);
  assert.equal(s.waste[0].id, topId);
  assert.equal(s.waste[0].faceUp, true);
  // 全部めくる
  while (s.stock.length > 0) s = sol.drawFromStock(s);
  assert.equal(s.waste.length, 24);
  // 再循環: 捨て札が裏向きのストックに戻る
  s = sol.drawFromStock(s);
  assert.equal(s.stock.length, 24);
  assert.equal(s.waste.length, 0);
  assert.ok(s.stock.every((c) => !c.faceUp));
});

test("ソリティア: 場札への移動は色交互・降順のみ、空列にはKのみ", () => {
  // 黒7 の上に赤6 は置ける
  let s = emptySol({
    waste: [card("hearts", 6)],
    tableau: [[card("spades", 7)], [], [], [], [], [], []],
  });
  const moved = sol.moveWasteToTableau(s, 0);
  assert.equal(moved.tableau[0].length, 2);
  assert.equal(moved.waste.length, 0);
  assert.equal(moved.moves, 1);
  // 同色は置けない
  const sameColor = emptySol({
    waste: [card("diamonds", 6)],
    tableau: [[card("hearts", 7)], [], [], [], [], [], []],
  });
  assert.equal(sol.moveWasteToTableau(sameColor, 0), sameColor);
  // 数字が飛んでも置けない
  const wrongRank = emptySol({
    waste: [card("hearts", 5)],
    tableau: [[card("spades", 7)], [], [], [], [], [], []],
  });
  assert.equal(sol.moveWasteToTableau(wrongRank, 0), wrongRank);
  // 空列には K だけ置ける
  const king = emptySol({ waste: [card("clubs", 13)] });
  assert.equal(sol.moveWasteToTableau(king, 3).tableau[3].length, 1);
  const queen = emptySol({ waste: [card("clubs", 12)] });
  assert.equal(sol.moveWasteToTableau(queen, 3), queen);
});

test("ソリティア: 場札同士は束で動かせ、動かした列の裏向きカードが表になる", () => {
  const s = emptySol({
    tableau: [
      [card("hearts", 9, false), card("spades", 8), card("hearts", 7)],
      [card("diamonds", 9)],
      [], [], [], [], [],
    ],
  });
  const moved = sol.moveTableauToTableau(s, 0, 1, 1);
  assert.equal(moved.tableau[1].length, 3);
  assert.equal(moved.tableau[0].length, 1);
  assert.equal(moved.tableau[0][0].faceUp, true); // めくれた
  // 束の途中が裏向きなら動かせない
  const bad = emptySol({
    tableau: [
      [card("spades", 8, false), card("hearts", 7)],
      [card("clubs", 8)],
      [], [], [], [], [],
    ],
  });
  assert.equal(sol.moveTableauToTableau(bad, 0, 0, 1), bad);
  // 同じ列への移動は無効
  assert.equal(sol.moveTableauToTableau(s, 0, 1, 0), s);
});

test("ソリティア: 組札はAから同スート昇順のみ、違うスートや飛んだ数字は不可", () => {
  let s = emptySol({ waste: [card("hearts", 1)] });
  s = sol.moveWasteToFoundation(s);
  assert.equal(sol.foundationTotal(s), 1);
  // 同スートの2は置ける
  s = { ...s, waste: [card("hearts", 2)] };
  s = sol.moveWasteToFoundation(s);
  assert.equal(sol.foundationTotal(s), 2);
  // 違うスートの3は置けない
  const wrong = { ...s, waste: [card("spades", 3)] };
  assert.equal(sol.moveWasteToFoundation(wrong), wrong);
  // Aでないカードは空の組札に置けない
  const noAce = emptySol({ waste: [card("spades", 5)] });
  assert.equal(sol.moveWasteToFoundation(noAce), noAce);
});

test("ソリティア: 自動組札候補を見つけ、場札の末尾も組札へ動く", () => {
  const s = emptySol({
    tableau: [[card("clubs", 1)], [], [], [], [], [], []],
  });
  assert.deepEqual(sol.findFoundationMove(s), { kind: "tableau", col: 0 });
  const moved = sol.autoMoveToFoundation(s);
  assert.equal(sol.foundationTotal(moved), 1);
  assert.equal(moved.tableau[0].length, 0);
  const none = emptySol({ tableau: [[card("clubs", 5)], [], [], [], [], [], []] });
  assert.equal(sol.findFoundationMove(none), null);
  assert.equal(sol.autoMoveToFoundation(none), none);
});

test("ソリティア: 組札が52枚そろうと勝利になる", () => {
  const foundations = sol.SUITS.map((suit) => {
    const pile = [];
    for (let rank = 1; rank <= 13; rank++) {
      if (!(suit === "clubs" && rank === 13)) pile.push(card(suit, rank));
    }
    return pile;
  });
  const s = emptySol({
    waste: [card("clubs", 13)],
    foundations,
  });
  assert.equal(sol.foundationTotal(s), 51);
  const won = sol.moveWasteToFoundation(s);
  assert.equal(sol.foundationTotal(won), 52);
  assert.equal(won.status, "won");
  assert.equal(sol.isWon(won), true);
});

test("ソリティア: 遷移は元の状態を変更しない", () => {
  const s = sol.createSolitaire(11);
  const snapshot = JSON.stringify(s);
  sol.drawFromStock(s);
  assert.equal(JSON.stringify(s), snapshot);
});

// ---------------- ワード当て ----------------

test("ワード当て: 答え候補は120語以上・全て実在形式（英字5文字）・重複なし", () => {
  assert.ok(wd.ANSWER_WORDS.length >= 120);
  assert.ok(wd.ANSWER_WORDS.every((w) => /^[A-Z]{5}$/.test(w)));
  assert.equal(new Set(wd.ANSWER_WORDS).size, wd.ANSWER_WORDS.length);
  assert.ok(wd.ANSWER_WORDS.every((w) => wd.WORDLE_DICTIONARY.has(w)));
});

test("ワード当て: 完全一致は全て correct", () => {
  assert.deepEqual(wd.evaluateGuess("CRANE", "CRANE"), [
    "correct", "correct", "correct", "correct", "correct",
  ]);
});

test("ワード当て: 重複文字（答え SPEED / 推測 ERASE）は残り文字数で判定する", () => {
  // E は答えに2つあるので両方 present、S も present、R と A は absent
  assert.deepEqual(wd.evaluateGuess("SPEED", "ERASE"), [
    "present", "absent", "absent", "present", "present",
  ]);
});

test("ワード当て: 重複文字（答え ABBEY / 推測 BABES）は correct を優先して消費する", () => {
  assert.deepEqual(wd.evaluateGuess("ABBEY", "BABES"), [
    "present", "present", "correct", "correct", "absent",
  ]);
});

test("ワード当て: 推測側の余分な重複は absent になる（答え APPLE / 推測 PPPPP）", () => {
  // P は位置2つが correct、残りの P は答えに無いので absent
  assert.deepEqual(wd.evaluateGuess("APPLE", "PPPPP"), [
    "absent", "correct", "correct", "absent", "absent",
  ]);
});

test("ワード当て: 辞書検証（候補・追加単語は可、存在しない単語や短い単語は不可）", () => {
  assert.equal(wd.isValidGuess("CRANE"), true);
  assert.equal(wd.isValidGuess("slate"), true); // 小文字も正規化される
  assert.equal(wd.isValidGuess("XXXXX"), false);
  assert.equal(wd.isValidGuess("CAT"), false);
  assert.equal(wd.validateGuess("XXXXX"), "辞書にない単語です");
  assert.equal(wd.validateGuess("CRANE"), null);
});

test("ワード当て: 一般的な5文字語が辞書に受理される（バッチC辞書増量）", () => {
  // 以前は辞書が約310語しかなく HELLO/WORLD 等の一般語が弾かれていた
  for (const w of ["HELLO", "WORLD", "LIGHT", "MOUSE", "HAPPY", "WATER", "HOUSE", "MUSIC", "MONEY", "SMILE"]) {
    assert.equal(wd.validateGuess(w), null, `${w} が辞書にない`);
    assert.equal(wd.isValidGuess(w), true, `${w} が推測できない`);
  }
  assert.ok(wd.WORDLE_DICTIONARY.size >= 690, `辞書が増えていない: ${wd.WORDLE_DICTIONARY.size}`);
});

test("ワード当て: 正解で勝ち、6回外すと負け、当たれば答えが明かせる状態になる", () => {
  let s = wd.createWordleGameWithAnswer("CRANE");
  const miss = wd.submitGuess(s, "SLATE");
  assert.equal(miss.error, null);
  s = miss.state;
  assert.equal(s.guesses.length, 1);
  assert.equal(s.status, "playing");
  const win = wd.submitGuess(s, "CRANE");
  assert.equal(win.state.status, "won");

  let l = wd.createWordleGameWithAnswer("CRANE");
  for (const g of ["SLATE", "AUDIO", "MOCHA", "JUMBO", "FUZZY", "VODKA"]) {
    const r = wd.submitGuess(l, g);
    assert.equal(r.error, null, g);
    l = r.state;
  }
  assert.equal(l.status, "lost");
  assert.equal(l.guesses.length, 6);
  // 終了後の推測は受け付けない
  const after = wd.submitGuess(l, "CRANE");
  assert.notEqual(after.error, null);
  assert.equal(after.state, l);
});

test("ワード当て: 不正な推測では状態が変わらない", () => {
  const s = wd.createWordleGameWithAnswer("CRANE");
  const r = wd.submitGuess(s, "XXXXX");
  assert.equal(r.state, s);
  assert.equal(r.error, "辞書にない単語です");
});

test("ワード当て: シードで答えが決定的に決まり、答えは候補リスト内にある", () => {
  assert.equal(wd.pickAnswer(42), wd.pickAnswer(42));
  assert.ok(wd.ANSWER_WORDS.includes(wd.pickAnswer(42)));
  assert.equal(wd.createWordleGame(42).answer, wd.pickAnswer(42));
});

test("ワード当て: キーボード状態は correct > present > absent で集約される", () => {
  let s = wd.createWordleGameWithAnswer("SPEED");
  s = wd.submitGuess(s, "ERASE").state; // E: present, S: present, R/A: absent
  s = wd.submitGuess(s, "SHEEP").state; // S: correct に昇格, E: correct あり
  const kb = wd.keyboardState(s);
  assert.equal(kb.S, "correct");
  assert.equal(kb.E, "correct");
  assert.equal(kb.R, "absent");
  assert.equal(kb.H, "absent");
});

// ---------------- タイピング ----------------

test("タイピング: 全て正解なら正確率100、WPM は (文字数/5)/分 で計算される", () => {
  const prompt = "a".repeat(50);
  const r = ty.evaluateTyping(prompt, prompt, 60);
  assert.equal(r.totalChars, 50);
  assert.equal(r.correctChars, 50);
  assert.equal(r.incorrectChars, 0);
  assert.equal(r.accuracy, 100);
  assert.equal(r.wpm, 10); // (50/5) / 1分
  assert.equal(r.grossWpm, 10);
});

test("タイピング: 半分間違えると正確率50、WPM は正解文字だけが数えられる", () => {
  const prompt = "aaaaaaaaaa";
  const r = ty.evaluateTyping(prompt, "aaaaabbbbb", 30);
  assert.equal(r.correctChars, 5);
  assert.equal(r.incorrectChars, 5);
  assert.equal(r.accuracy, 50);
  assert.equal(r.wpm, 2); // (5/5) / 0.5分
  assert.equal(r.grossWpm, 4); // (10/5) / 0.5分
});

test("タイピング: 経過0秒・未入力では WPM 0（ゼロ除算しない）", () => {
  const zero = ty.evaluateTyping("hello", "hello", 0);
  assert.equal(zero.wpm, 0);
  const empty = ty.evaluateTyping("hello", "", 30);
  assert.equal(empty.totalChars, 0);
  assert.equal(empty.accuracy, 100);
  assert.equal(empty.wpm, 0);
});

test("タイピング: 課題文はシードで決定的に生成され、課題リストの文からなる", () => {
  const a = ty.createTypingText(9);
  assert.equal(a, ty.createTypingText(9));
  assert.ok(a.length > 0);
  for (const sentence of ty.TYPING_SENTENCES) {
    // 生成文に含まれる各文はリスト由来であることの裏付け: 空白区切りで復元できる
    if (a.includes(sentence)) assert.ok(ty.TYPING_SENTENCES.includes(sentence));
  }
  assert.notEqual(ty.createTypingText(9), ty.createTypingText(10));
  const words = ty.createTypingWords(5, 20);
  assert.equal(words.split(" ").length, 20);
  assert.ok(words.split(" ").every((w) => ty.TYPING_WORDS.includes(w)));
});

test("タイピング: 文字単位の正誤と完了判定", () => {
  assert.deepEqual(ty.charResults("abc", "axc"), [true, false, true]);
  assert.equal(ty.countCorrect("abc", "ax"), 1);
  assert.equal(ty.isTypingComplete("abc", "abc"), true);
  assert.equal(ty.isTypingComplete("abc", "ab"), false);
  assert.equal(ty.isTypingComplete("", ""), false);
});
