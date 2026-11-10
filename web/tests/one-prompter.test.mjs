// lib/one-prompter.ts の純粋ロジック（カテゴリ判定・二択質問生成・プロンプト合成）を確かめる
import { test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const src = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "one-prompter.ts"), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}).outputText;
const m = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

test("カテゴリ判定は代表的な入力を正しく振り分ける", () => {
assert.equal(m.categorizeInput("転職したい、自己PR書いて"), "job");
assert.equal(m.categorizeInput("うちのカフェのインスタ投稿考えて"), "sns");
assert.equal(m.categorizeInput("Pythonで動く関数を実装して"), "code");
assert.equal(m.categorizeInput("取引先への謝罪メールを書きたい"), "business");
assert.equal(m.categorizeInput("量子コンピュータの仕組みを説明して"), "study");
assert.equal(m.categorizeInput("なんかいい感じのやつ作って"), "generic");
});

test("質問は最大5問・スロット重複なし・各2択", () => {
for (const input of ["転職の自己PR", "ブログ記事を書きたい", "画像を作りたい", "雑な依頼文"]) {
const { questions} = m.generateQuestions(input);
assert.ok(questions.length >= 3 && questions.length <= 5, input);
assert.equal(new Set(questions.map((q) => q.slot)).size, questions.length);
for (const q of questions) {
assert.equal(q.options.length, 2);
assert.notEqual(q.options[0].label, q.options[1].label);
assert.ok(q.options.every((o) => o.instruction.length > 0));
}
}
});

test("カテゴリ質問が汎用質問より先に来る", () => {
const { category, questions} = m.generateQuestions("転職したい、自己PR書いて");
assert.equal(category, "job");
assert.equal(questions[0].slot, "purpose");
assert.match(questions[0].question, /使い道/);
});

test("完成プロンプトは元の文・選んだ条件・禁止事項を含む", () => {
const { category, questions} = m.generateQuestions("転職したい、自己PR書いて");
const answers = questions.map((q) => ({
slot: q.slot, question: q.question, label: q.options[0].label, instruction: q.options[0].instruction,
}));
const prompt = m.buildPrompt("転職したい、自己PR書いて", category, answers);
assert.ok(prompt.includes("転職したい、自己PR書いて"));
for (const a of answers) assert.ok(prompt.includes(a.instruction));
assert.ok(prompt.includes(""));
assert.ok(prompt.includes("定型の締め文句"));
});

test("完成プロンプトの禁止事項はAIあるあるを網羅し、差し替え項目と矛盾時の優先順位を含む", () => {
const { category, questions} = m.generateQuestions("転職したい、自己PR書いて");
const answers = questions.map((q) => ({
slot: q.slot, question: q.question, label: q.options[0].label, instruction: q.options[0].instruction,
}));
const prompt = m.buildPrompt("転職したい、自己PR書いて", category, answers);
assert.ok(prompt.includes("定型の締め文句"));
assert.ok(prompt.includes("まず〜、次に〜、最後に〜"));
assert.ok(prompt.includes("接続詞を連発しない"));
assert.ok(prompt.includes("両論併記で結論を逃げない"));
assert.ok(prompt.includes("バズワード"));
assert.ok(prompt.includes("焼き直した要約をしない"));
assert.ok(prompt.includes("差し替え項目"));
assert.ok(prompt.includes("プレースホルダ"));
assert.ok(prompt.includes("条件同士が矛盾する場合は、より具体的な条件を優先してください。"));
assert.ok(!prompt.includes("場合は、を優先"));
});

test("fallback の完成プロンプトに定型の冒頭文・締め文は無い（中身の要件は残る）", () => {
const { category, questions} = m.generateQuestions("転職したい、自己PR書いて");
const answers = questions.map((q) => ({
slot: q.slot, question: q.question, label: q.options[0].label, instruction: q.options[0].instruction,
}));
const prompt = m.buildPrompt("転職したい、自己PR書いて", category, answers);
assert.ok(!prompt.includes("実務に精通した専門家です"));
assert.ok(!prompt.includes("指定された条件をすべて満たす成果物を出力してください"));
assert.ok(!prompt.includes("出力は成果物のみとし、確認や質問で止めないでください"));
assert.ok(prompt.startsWith("転職したい、自己PR書いて"));
for (const a of answers) assert.ok(prompt.includes(a.instruction));
assert.ok(prompt.includes("差し替え項目"));
});

test("generateQuestions は count に追随する（既定5・プールが尽きればある分だけ）", () => {
const input = "転職したい、自己PR書いて";
assert.ok(m.generateQuestions(input).questions.length <= 5);
assert.equal(m.generateQuestions(input, 3).questions.length, 3);
const eight = m.generateQuestions(input, 8).questions;
assert.ok(eight.length > 5 && eight.length <= 8);
assert.equal(new Set(eight.map((q) => q.slot)).size, eight.length);
});

test("fallback の完成プロンプトは検討中・保留・自由入力の指定を反映する", () => {
const prompt = m.buildPrompt("転職したい、自己PR書いて", "job", [
{ slot: "tone", question: "トーンは？", label: "検討中", instruction: "（トーンは？）は検討中。最も妥当な既定を1つ置き、その前提を明示すること" },
{ slot: "length", question: "分量は？", label: "保留", instruction: "（分量は？）は保留。決め打ちせず、差し替え可能な形で残すこと" },
{ slot: "angle", question: "切り口は？", label: "実務の失敗談から入る", instruction: "ユーザーの指定: 実務の失敗談から入る" },
]);
assert.ok(prompt.includes("は検討中。最も妥当な既定を1つ置き、その前提を明示すること"));
assert.ok(prompt.includes("は保留。決め打ちせず、差し替え可能な形で残すこと"));
assert.ok(prompt.includes("ユーザーの指定: 実務の失敗談から入る"));
});
