// A40フェーズの検証（内容充実: バンク増量のみ、ロジック変更なし）。
// - lib/online/games/quizbattle.ts: 問題バンク 70問→84問（形式・重複なし・正解の妥当性）
// - lib/anagram.ts: 単語バンク 100語→120語（形式・重複なし・シャッフル保証）
// - lib/online/games/shiritori.ts: 辞書 1200語→1400語→A49で1600語（形式・重複なし・既存作法）
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
    ["日本の元号で、令和の1つ前は？", "平成"],
    ["1円玉の材料は？", "アルミニウム"],
    ["ことわざ「猿も木から」どうする？", "落ちる"],
    ["植物が光合成で吸収する気体は？", "二酸化炭素"],
    ["人間の体の中で一番大きな臓器は？", "皮膚"],
    ["磁石の同じ極同士（N極とN極）を近づけるとどうなる？", "反発する"],
    ["鎌倉幕府を開いた人物は？", "源頼朝"],
    ["日本で最初の女性天皇は？", "推古天皇"],
    ["ライト兄弟が初飛行に成功した乗り物は？", "飛行機"],
    ["バドミントンで打ち合う、羽のついた球の名前は？", "シャトル"],
    ["100m走の世界記録保持者ウサイン・ボルトの出身国は？", "ジャマイカ"],
    ["剣道で使う竹製の刀を何という？", "竹刀"],
    ["『ポケットモンスター』でピカチュウのタイプは？", "でんき"],
    ["トランプ1組は、ジョーカーを除くと何枚？", "52枚"],
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
});

test("アナグラム: 増量20語がバンクにあり、シャッフルが元の並びにならない", () => {
  const added = [
    "ナシ", "ウマ", "ネコ", "イヌ", "ラッコ", "カモメ", "ヒツジ", "トナカイ",
    "ダイコン", "ニンジン", "マカロニ", "ドーナツ", "カステラ", "シロクマ", "アルパカ", "クレヨン",
    "エンピツ", "ジャガイモ", "ハムスター", "ランドセル",
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

test("しりとり: 辞書は1610語で、重複がなく全て有効な形式", () => {
  const words = shi.SHIRITORI_WORDS;
  assert.equal(words.length, 1610);
  assert.equal(new Set(words).size, words.length, "重複がある");
  for (const w of words) {
    assert.ok(shi.isValidWordForm(w), `形式が不正: ${w}`);
    assert.ok(shi.isBankWord(w), `バンク判定が通らない: ${w}`);
  }
});

test("しりとり: 増量分の代表語が分野ごとにバンクに入っている", () => {
  const added = [
    // 動物
    "アザラシ", "アルマジロ", "ハイエナ", "フェレット", "マングース",
    // 食べ物
    "アンパン", "カキゴオリ", "サシミ", "ハルマキ", "ヤキソバ", "ポテチ",
    // 場所
    "カフェ", "コンビニ", "スイゾクカン", "ユウエンチ", "ガソリンスタンド",
    // 楽器
    "オーボエ", "チェロ", "チューバ", "ティンパニ", "ハープ",
  ];
  for (const w of added) {
    assert.ok(shi.isBankWord(w), `${w} がバンクに無い`);
  }
});

test("しりとり: 増量後も「ン」終わりの脱落語を含む既存作法が保たれ、接続に使える", () => {
  // 既存方針どおり「ン」で終わる語（出すと脱落）も収録されている
  const nWords = shi.SHIRITORI_WORDS.filter((w) => w.endsWith("ン"));
  assert.ok(nWords.length >= 100, `ン終わりの語が減っている: ${nWords.length}`);
  for (const w of ["アンパン", "インターホン", "チャンピオン"]) {
    assert.ok(shi.isBankWord(w), `${w} がバンクに無い`);
    assert.equal(shi.shiritoriTail(w), "ン");
  }
  // 増量語でも末尾処理（ー除去・接続）が機能する
  assert.equal(shi.shiritoriTail("スペースシャトル"), "ル");
  assert.equal(shi.shiritoriTail("ケーブルカー"), "カ");
  assert.equal(shi.shiritoriTail("アゲハ"), "ハ");
});
