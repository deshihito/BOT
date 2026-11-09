// One Prompter の LLM 連携（lib/one-prompter-llm.ts の検証ロジックと
// lib/one-prompter-server.ts の Logfare クライアント）をネットワークなしで確かめる。
// サーバー側モジュールは "./one-prompter-llm" を import するので、
// transpile 後に specifier を llm 側の data URL へ差し替えて読み込む。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

function transpile(relPath) {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", relPath), "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function dataUrl(js) {
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}

const llm = await import(dataUrl(transpile("lib/one-prompter-llm.ts")));
const serverJs = transpile("lib/one-prompter-server.ts").replaceAll('"./one-prompter-llm"', JSON.stringify(dataUrl(transpile("lib/one-prompter-llm.ts"))));
const server = await import(dataUrl(serverJs));

const VALID_QUESTIONS = {
  questions: [
    { question: "使い道は？", options: ["書類選考を通す", "面接で話す準備"] },
    { question: "押すのはどっち？", options: ["実績・数字", "人柄・姿勢"] },
    { question: "分量は？", options: ["200字で締める", "400字でしっかり"] },
  ],
};

function jsonResponse(status, data) {
  return { status, ok: status >= 200 && status < 300, json: async () => data };
}

function chatResponse(content) {
  return jsonResponse(200, { choices: [{ message: { content } }] });
}

test("validateRough は空・長すぎを弾き、前後空白を除く", () => {
  assert.equal(llm.validateRough("  転職したい  "), "転職したい");
  assert.equal(llm.validateRough(""), null);
  assert.equal(llm.validateRough("   "), null);
  assert.equal(llm.validateRough("あ".repeat(llm.MAX_ROUGH_LENGTH + 1)), null);
  assert.equal(llm.validateRough(123), null);
});

test("validateAnswers は件数と各項目の形を検証する", () => {
  assert.deepEqual(llm.validateAnswers([{ question: "Q?", answer: "A" }]), [{ question: "Q?", answer: "A" }]);
  assert.equal(llm.validateAnswers([]), null);
  assert.equal(llm.validateAnswers([{ question: "Q?", answer: "" }]), null);
  assert.equal(llm.validateAnswers([{ question: "Q?" }]), null);
  assert.equal(llm.validateAnswers("x"), null);
});

test("parseQuestionsJson は正しいJSONを受け付ける（フェンス・前置き混じりも）", () => {
  assert.equal(llm.parseQuestionsJson(JSON.stringify(VALID_QUESTIONS)).length, 3);
  const fenced = "```json\n" + JSON.stringify(VALID_QUESTIONS) + "\n```";
  assert.equal(llm.parseQuestionsJson(fenced).length, 3);
  const noisy = "はい、こちらです。\n" + JSON.stringify(VALID_QUESTIONS) + "\n以上です。";
  assert.equal(llm.parseQuestionsJson(noisy).length, 3);
});

test("parseQuestionsJson は件数・重複・空欄の崩れを弾く", () => {
  const two = { questions: VALID_QUESTIONS.questions.slice(0, 2) };
  assert.equal(llm.parseQuestionsJson(JSON.stringify(two)), null);
  const six = { questions: [...VALID_QUESTIONS.questions, ...VALID_QUESTIONS.questions] };
  assert.equal(llm.parseQuestionsJson(JSON.stringify(six)), null);
  const dup = { questions: VALID_QUESTIONS.questions.map((q, i) => (i === 0 ? { question: q.question, options: ["同じ", "同じ"] } : q)) };
  assert.equal(llm.parseQuestionsJson(JSON.stringify(dup)), null);
  const empty = { questions: VALID_QUESTIONS.questions.map((q, i) => (i === 0 ? { question: q.question, options: ["", "B"] } : q)) };
  assert.equal(llm.parseQuestionsJson(JSON.stringify(empty)), null);
  assert.equal(llm.parseQuestionsJson("JSONではありません"), null);
});

test("cleanSynthesizedPrompt はフェンスを剥がし、空・長すぎを弾く", () => {
  assert.equal(llm.cleanSynthesizedPrompt("```\n完成プロンプト本文\n```"), "完成プロンプト本文");
  assert.equal(llm.cleanSynthesizedPrompt("  本文  "), "本文");
  assert.equal(llm.cleanSynthesizedPrompt("   "), null);
  assert.equal(llm.cleanSynthesizedPrompt("あ".repeat(llm.MAX_PROMPT_CHARS + 1)), null);
});

test("logfareApiKeys は Bot 側と同じ順序で集め、重複と空欄を除く", () => {
  const env = {
    LOGFARE_API_KEY: " main ",
    LOGFARE_API_KEY_2: "sub",
    LOGFARE_API_KEY_3: "main",
    LOGFARE_API_KEYS: "extra1, sub ,,extra2",
  };
  assert.deepEqual(server.logfareApiKeys(env), ["main", "sub", "extra1", "extra2"]);
  assert.deepEqual(server.logfareApiKeys({}), []);
});

test("logfareChat は 429 のときだけ次のキーへ切り替える", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return jsonResponse(429, {});
    return chatResponse("回答です");
  };
  const env = { LOGFARE_API_KEY: "dummy-1", LOGFARE_API_KEY_2: "dummy-2" };
  const out = await server.logfareChat([{ role: "user", content: "hi" }], { maxTokens: 100, env, fetchImpl });
  assert.equal(out, "回答です");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith("/chat/completions"));
  assert.equal(calls[1].init.headers.Authorization, "Bearer dummy-2");
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.model, "deepseek-v4.1-flash-1017");
  assert.equal(payload.reasoning_effort, "none");
});

test("logfareChat は 429 以外のエラーを即座に投げ、モデル上書きも効く", async () => {
  let count = 0;
  const fetchImpl = async () => {
    count += 1;
    return jsonResponse(401, {});
  };
  const env = { LOGFARE_API_KEY: "dummy-1", LOGFARE_API_KEY_2: "dummy-2", ONE_PROMPTER_MODEL: "other-model" };
  await assert.rejects(() => server.logfareChat([{ role: "user", content: "hi" }], { maxTokens: 100, env, fetchImpl }));
  assert.equal(count, 1);
  assert.equal(server.onePrompterModel(env), "other-model");
  assert.equal(server.onePrompterModel({}), "deepseek-v4.1-flash-1017");
});

test("logfareChat はキー未設定で投げる（ルート側のフォールバック判定に使う）", async () => {
  await assert.rejects(() =>
    server.logfareChat([{ role: "user", content: "hi" }], { maxTokens: 100, env: {}, fetchImpl: async () => chatResponse("x") }),
  );
});

test("generateQuestionsWithLlm は形式崩れを1回だけ組み直し、駄目なら null", async () => {
  const env = { LOGFARE_API_KEY: "dummy" };
  const queue = [chatResponse("すみません、形式を守れませんでした"), chatResponse(JSON.stringify(VALID_QUESTIONS))];
  const fetchImpl = async () => queue.shift();
  const questions = await server.generateQuestionsWithLlm("転職したい、自己PR書いて", { env, fetchImpl });
  assert.equal(questions.length, 3);
  assert.deepEqual(questions[0].options, ["書類選考を通す", "面接で話す準備"]);

  const badQueue = [chatResponse("壊れた出力"), chatResponse("やっぱり壊れた出力")];
  const badFetch = async () => badQueue.shift();
  assert.equal(await server.generateQuestionsWithLlm("転職したい", { env, fetchImpl: badFetch }), null);
});

test("synthesizeWithLlm はフェンスを剥がした完成プロンプトを返す", async () => {
  const env = { LOGFARE_API_KEY: "dummy" };
  const fetchImpl = async () => chatResponse("```\n## 依頼文\n転職したい\n```");
  const prompt = await server.synthesizeWithLlm("転職したい", [{ question: "使い道は？", answer: "書類選考を通す" }], { env, fetchImpl });
  assert.equal(prompt, "## 依頼文\n転職したい");
});
