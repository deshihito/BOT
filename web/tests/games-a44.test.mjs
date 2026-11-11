// A44フェーズの検証（内容充実: バンク増量のみ、ロジック変更なし）。
// - lib/online/games/quizbattle.ts: 問題バンク 70問→84問（形式・重複なし・正解の妥当性）
// - lib/anagram.ts: 単語バンク 100語→120語（形式・重複なし・シャッフル保証）
// - lib/online/games/shiritori.ts: 辞書 1200語→1400語→A49で1600語（形式・重複なし・行き止まりなし）
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

const qb = await loadOnline("quizbattle.ts", ["QUIZ_BATTLE_QUESTIONS"]);
const an = await loadLib("anagram.ts");
const shi = await loadOnline("shiritori.ts", [
  "SHIRITORI_WORDS",
  "isValidWordForm",
  "isBankWord",
  "shiritoriTail",
]);

// ---------------------------------------------------------------- クイズバトル増量

test("クイズバトル: バンクは98問で、カテゴリ配分が既存分野を踏襲している", () => {
  const qs = qb.QUIZ_BATTLE_QUESTIONS;
  assert.equal(qs.length, 98);
  const counts = {};
  for (const q of qs) counts[q.category] = (counts[q.category] ?? 0) + 1;
  assert.deepEqual(counts, { "雑学": 22, "科学": 22, "歴史": 19, "スポーツ": 19, "アニメ・ゲーム": 16 });
});

test("クイズバトル: 全問の形式がそろい、問題文・選択肢に重複がない", () => {
  const qs = qb.QUIZ_BATTLE_QUESTIONS;
  const seen = new Set();
  for (const q of qs) {
    assert.ok(typeof q.category === "string" && q.category.length > 0);
    assert.ok(typeof q.question === "string" && q.question.length > 0);
    assert.ok(!seen.has(q.question), `問題文の重複: ${q.question}`);
    seen.add(q.question);
    assert.equal(q.choices.length, 4, `選択肢数: ${q.question}`);
    assert.equal(new Set(q.choices).size, 4, `選択肢の重複: ${q.question}`);
    for (const c of q.choices) assert.ok(typeof c === "string" && c.length > 0);
    assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4, `正解位置: ${q.question}`);
    // バンク作法: 正解は先頭に置き、出題時（buildDeck）にシャッフルする
    assert.equal(q.answer, 0, `バンク作法: ${q.question}`);
  }
});

test("クイズバトル: 増量14問の正解が正しい", () => {
  const byQuestion = new Map(qb.QUIZ_BATTLE_QUESTIONS.map((q) => [q.question, q.choices[q.answer]]));
  const expected = new Map([
    ["日本の国鳥は？", "キジ"],
    ["「一富士二鷹三茄子」は何の夢のこと？", "初夢"],
    ["日本で一番長い川は？", "信濃川"],
    ["地球から月までの距離はおよそ何km？", "約38万km"],
    ["太陽系で一番大きい惑星は？", "木星"],
    ["単3形の乾電池の電圧はおよそ何ボルト？", "1.5ボルト"],
    ["ペリーが黒船で来航したのは何年？", "1853年"],
    ["『解体新書』を翻訳した人物は？", "杉田玄白"],
    ["フランス革命が始まった年は？", "1789年"],
    ["野球で、塁に出た走者が次の塁を狙って走ることを何という？", "盗塁"],
    ["オリンピックの金メダルの主な材料は？", "銀"],
    ["サッカーで、重大な反則をした選手に出される退場のカードは？", "レッドカード"],
    ["『ドラゴンボール』で孫悟空が育った山の名前は？", "パオズ山"],
    ["『テトリス』で一度に4列消すことを何という？", "テトリス"],
  ]);
  assert.equal(expected.size, 14);
  for (const [question, correct] of expected) {
    assert.equal(byQuestion.get(question), correct, question);
  }
});

// ---------------------------------------------------------------- アナグラム増量

test("アナグラム: バンクは120語で、重複なし・全てカタカナ・シャッフル可能な形", () => {
  const words = an.ANAGRAM_WORDS;
  assert.equal(words.length, 120);
  assert.equal(new Set(words).size, 120);
  for (const word of words) {
    assert.match(word, /^[ァ-ヶー]+$/, `${word} はカタカナのみ`);
    assert.ok([...word].length >= 2, `${word} は2文字以上`);
    // 並べ替えても変わらない単語（全文字同一など）は含めない
    assert.ok(new Set([...word]).size >= 2, `${word} は複数種の文字を含む`);
  }
  // 文字数の分布は既存どおり3〜4文字が中心
  const mid = words.filter((w) => { const n = [...w].length; return n === 3 || n === 4; }).length;
  assert.ok(mid >= words.length / 2, `3〜4文字が過半数: ${mid}/${words.length}`);
});

test("アナグラム: 増量20語がバンクにあり、シャッフルが元の並びにならない", () => {
  const added = [
    "クジラ", "タコ", "イカ", "エビ", "ハチ", "トンボ", "チョウ", "ケーキ", "アイス", "ヨーグルト",
    "ハンバーガー", "サンドイッチ", "バドミントン", "ゴルフ", "ドラム", "ハーモニカ", "デンシャ", "ロケット", "フェリー", "ボウリング",
  ];
  assert.equal(added.length, 20);
  for (const word of added) {
    assert.ok(an.ANAGRAM_WORDS.includes(word), `${word} がバンクにある`);
    for (let seed = 0; seed < 40; seed++) {
      const { text } = an.shuffleWord(word, seed * 31 + 7);
      assert.notEqual(text, word, `${word} のシャッフルが元と同一 (seed=${seed})`);
      assert.deepEqual([...text].sort(), [...word].sort());
    }
  }
  // 増量後も出題は10問で決定的
  const a = an.createAnagramGame(99);
  assert.equal(a.words.length, 10);
  assert.equal(new Set(a.words).size, 10);
});

// ---------------------------------------------------------------- しりとり増量

test("しりとり: 辞書は1600語で、重複がなく全て有効な形式", () => {
  const words = shi.SHIRITORI_WORDS;
  assert.equal(words.length, 1600);
  assert.equal(new Set(words).size, words.length, "重複がある");
  for (const w of words) {
    assert.ok(shi.isValidWordForm(w), `形式が不正: ${w}`);
    assert.ok(shi.isBankWord(w), `バンク判定が通らない: ${w}`);
  }
});

test("しりとり: 増量分の代表語が分野ごとにバンクに入っている", () => {
  const added = [
    // 動物・鳥・魚・虫
    "シマリス", "レッサーパンダ", "イルカ", "タンチョウ", "アンコウ", "メバル", "キアゲハ", "オオクワガタ",
    // 食べ物・料理・飲み物
    "ペペロンチーノ", "ワッフル", "アクアパッツァ", "カオマンガイ", "ハヤシライス", "レモンティー", "ウメシュ",
    // 野菜・果物・植物
    "ケール", "フェンネル", "アメリカンチェリー", "ヒヤシンス", "テッポウユリ",
    // 道具・場所・乗り物・職業
    "ガムテープ", "ステープラー", "セントウ", "ロープウェイ", "カンゴシ", "ソムリエ",
    // スポーツ・行事・自然・体・色
    "テコンドー", "ボッチャ", "ガクエンサイ", "リュウヒョウ", "スイセイ", "クチビル", "ダイヤモンド",
  ];
  for (const w of added) {
    assert.ok(shi.isBankWord(w), `${w} がバンクに無い`);
  }
});

test("しりとり: 「ン」終わりの脱落語の比率が既存作法（約10%）に保たれている", () => {
  const words = shi.SHIRITORI_WORDS;
  const nWords = words.filter((w) => w.endsWith("ン"));
  assert.equal(nWords.length, 159);
  const ratio = nWords.length / words.length;
  assert.ok(ratio >= 0.09 && ratio <= 0.11, `比率が範囲外: ${ratio}`);
  // A44 の増量分にも脱落語が含まれている
  for (const w of ["オランウータン", "トムヤムクン", "マカロン", "サインペン"]) {
    assert.ok(shi.isBankWord(w), `${w} がバンクに無い`);
    assert.equal(shi.shiritoriTail(w), "ン");
  }
});

test("しりとり: 増量後も行き止まり（接続先のない語）が増えていない", () => {
  const words = shi.SHIRITORI_WORDS;
  const starts = new Set(words.map((w) => w.charAt(0)));
  const deadEnds = words.filter((w) => !w.endsWith("ン") && !starts.has(shi.shiritoriTail(w)));
  assert.equal(deadEnds.length, 0, `行き止まり: ${deadEnds.slice(0, 5).join(",")}`);
  // 増量語の末尾処理（ー除去・小文字の読み替え）も機能する
  assert.equal(shi.shiritoriTail("ペペロンチーノ"), "ノ");
  assert.equal(shi.shiritoriTail("ロープウェイ"), "イ");
  assert.equal(shi.shiritoriTail("トゥクトゥク"), "ク");
});
