// A50フェーズの内容充実（バンク増量第3弾）の検証。
// - lib/online/games/wordwolf.ts: お題ペア 70組→80組（全単語重複なしの作法を維持）
// - lib/online/games/majority.ts: バンク 90問→100問（4択形式・重複なし）
// - lib/online/games/minority.ts: バンク 65問→75問（2択形式・重複なし）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const webDir = path.join(import.meta.dirname, "..");
const libDir = path.join(webDir, "lib");

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

const ww = await loadOnline("wordwolf.ts", ["WORDWOLF_PAIRS"]);
const mj = await loadOnline("majority.ts", ["MAJORITY_QUESTIONS"]);
const mn = await loadOnline("minority.ts", ["MINORITY_QUESTIONS"]);

// ---------------------------------------------------------------- ワードウルフ 増量

test("ワードウルフ: お題ペアは80組・全ての単語が重複しない", () => {
  const pairs = ww.WORDWOLF_PAIRS;
  assert.equal(pairs.length, 80);
  const words = new Set();
  const pairKeys = new Set();
  for (const p of pairs) {
    assert.equal(typeof p.majority, "string");
    assert.equal(typeof p.minority, "string");
    assert.ok(p.majority.length > 0 && p.minority.length > 0);
    assert.notEqual(p.majority, p.minority);
    assert.ok(!words.has(p.majority), `重複: ${p.majority}`);
    assert.ok(!words.has(p.minority), `重複: ${p.minority}`);
    words.add(p.majority);
    words.add(p.minority);
    pairKeys.add(`${p.majority}\n${p.minority}`);
  }
  assert.equal(words.size, 160);
  assert.equal(pairKeys.size, pairs.length);
});

test("ワードウルフ: 増量分(A50)の10組が近接ペアとして収録されている", () => {
  const pairs = ww.WORDWOLF_PAIRS;
  const added = [
    ["神社", "お寺"],
    ["ドーナツ", "ベーグル"],
    ["ネックレス", "ブレスレット"],
    ["クッキー", "クラッカー"],
    ["扇子", "うちわ"],
    ["地下鉄", "モノレール"],
    ["黒板", "ホワイトボード"],
    ["そろばん", "電卓"],
    ["朝日", "夕日"],
    ["クジラ", "イルカ"],
  ];
  for (const [majority, minority] of added) {
    assert.ok(
      pairs.some((p) => p.majority === majority && p.minority === minority),
      `増量ペア ${majority}/${minority} がない`,
    );
  }
});

// ---------------------------------------------------------------- 多数決 増量

test("多数決: バンクは100問・全て4択・必須フィールドと重複なし", () => {
  assert.equal(mj.MAJORITY_QUESTIONS.length, 100);
  const topics = mj.MAJORITY_QUESTIONS.map((q) => q.topic);
  assert.equal(new Set(topics).size, topics.length);
  for (const q of mj.MAJORITY_QUESTIONS) {
    assert.ok(typeof q.topic === "string" && q.topic.length > 0);
    assert.equal(q.choices.length, 4);
    assert.equal(new Set(q.choices).size, 4);
    for (const c of q.choices) assert.ok(typeof c === "string" && c.length > 0);
  }
});

test("多数決: 増量分(A50)の代表トピックが含まれている", () => {
  const topics = mj.MAJORITY_QUESTIONS.map((q) => q.topic);
  for (const added of ["父の日といえば？", "キャンプといえば？", "映画館といえば？", "冬の鍋といえば？", "秋の味覚といえば？", "海水浴といえば？"]) {
    assert.ok(topics.includes(added), `増量トピック ${added} がない`);
  }
});

// ---------------------------------------------------------------- 少数決 増量

test("少数決: バンクは75問・全て2択・必須フィールドと重複なし", () => {
  assert.equal(mn.MINORITY_QUESTIONS.length, 75);
  const topics = mn.MINORITY_QUESTIONS.map((q) => q.topic);
  assert.equal(new Set(topics).size, topics.length);
  for (const q of mn.MINORITY_QUESTIONS) {
    assert.ok(typeof q.topic === "string" && q.topic.length > 0);
    assert.equal(q.choices.length, 2);
    assert.notEqual(q.choices[0], q.choices[1]);
    for (const c of q.choices) assert.ok(typeof c === "string" && c.length > 0);
  }
});

test("少数決: 増量分(A50)の代表トピックが含まれている", () => {
  const topics = mn.MINORITY_QUESTIONS.map((q) => q.topic);
  for (const added of ["目玉焼きはどっち？", "納豆はどっち？", "プリンはどっち？", "寝る場所はどっち？", "コンビニおにぎりはどっち？"]) {
    assert.ok(topics.includes(added), `増量トピック ${added} がない`);
  }
});
