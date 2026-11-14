// A45フェーズの内容充実（バンク増量第2弾）の検証。
// - lib/online/games/wordwolf.ts: お題ペア 60組→70組（全単語重複なしの作法を維持）
// - lib/online/games/majority.ts: バンク 75問→90問（4択形式・重複なし）
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

test("ワードウルフ: 増量分(A45)の10組が近接ペアとして収録されている", () => {
  const pairs = ww.WORDWOLF_PAIRS;
  const added = [
    ["みかん", "ぶどう"],
    ["パン", "トースト"],
    ["テレビ", "ラジオ"],
    ["ノート", "手帳"],
    ["帽子", "マフラー"],
    ["腕時計", "指輪"],
    ["バラ", "チューリップ"],
    ["ペンギン", "あざらし"],
    ["ヨーグルト", "チーズ"],
    ["ベッド", "ソファー"],
  ];
  for (const [majority, minority] of added) {
    assert.ok(
      pairs.some((p) => p.majority === majority && p.minority === minority),
      `${majority} / ${minority} が収録されていること`,
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

test("多数決: 増量分(A45)の代表トピックが含まれている", () => {
  const topics = mj.MAJORITY_QUESTIONS.map((q) => q.topic);
  for (const added of ["ハロウィンといえば？", "バレンタインといえば？", "七夕といえば？", "母の日といえば？", "都会といえば？", "引っ越しといえば？", "卒業といえば？"]) {
    assert.ok(topics.includes(added), `増量トピック ${added} がない`);
  }
});
