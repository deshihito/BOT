// A39フェーズの内容充実（バンク増量）の検証。
// - lib/online/games/majority.ts: バンク 60問→75問（4択形式・重複なし）
// - lib/online/games/minority.ts: バンク 45問→55問（2択形式・重複なし）
// - lib/online/games/drawguess.ts: お題バンク 110語→130語（かな表記・重複なし）
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

const mj = await loadOnline("majority.ts", ["MAJORITY_QUESTIONS"]);
const mn = await loadOnline("minority.ts", ["MINORITY_QUESTIONS"]);
const dg = await loadOnline("drawguess.ts", ["DG_WORDS"]);

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

test("多数決: 増量分の代表トピックが含まれている", () => {
  const topics = mj.MAJORITY_QUESTIONS.map((q) => q.topic);
  for (const added of ["文房具といえば？", "動物園といえば？", "水族館といえば？", "梅雨といえば？", "春といえば？", "秋といえば？", "飛行機といえば？"]) {
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

test("少数決: 増量分の代表トピックが含まれている", () => {
  const topics = mn.MINORITY_QUESTIONS.map((q) => q.topic);
  for (const added of ["カレーに合わせるのはどっち？", "うどんはどっち？", "お風呂の温度はどっち？", "スマホの文字入力はどっち？", "ごはんのお供はどっち？"]) {
    assert.ok(topics.includes(added), `増量トピック ${added} がない`);
  }
});

// ---------------------------------------------------------------- お絵かき当て 増量

test("お絵かき当て: バンクは150語・重複なし・全てかな表記の具体名詞形式", () => {
  assert.equal(dg.DG_WORDS.length, 150);
  assert.equal(new Set(dg.DG_WORDS).size, dg.DG_WORDS.length);
  for (const word of dg.DG_WORDS) {
    assert.ok(/^[ぁ-んァ-ヶー]+$/.test(word), `かな表記でない語: ${word}`);
    assert.ok(word.length >= 1 && word.length <= 8, `長さが範囲外: ${word}`);
  }
});

test("お絵かき当て: 増量分の代表語が含まれている", () => {
  for (const added of ["さくら", "ひまわり", "チューリップ", "サングラス", "ベッド", "かがみ", "テント", "けんだま", "あひる", "かぼちゃ", "たまねぎ"]) {
    assert.ok(dg.DG_WORDS.includes(added), `増量語 ${added} がない`);
  }
});
