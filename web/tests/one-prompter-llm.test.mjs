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
  const fetchImpl = async () => chatResponse("```\n完成プロンプト本文\n```");
  const prompt = await server.synthesizeWithLlm("転職したい", [{ question: "使い道は？", answer: "書類選考を通す" }], { env, fetchImpl });
  assert.equal(prompt, "完成プロンプト本文");
});

test("validateAnswers は1+2ラウンド合計で最大11件まで許容し、12件を弾く", () => {
  const make = (n) => Array.from({ length: n }, (_, i) => ({ question: `Q${i}?`, answer: "A" }));
  assert.equal(llm.MAX_TOTAL_ANSWERS, 11);
  assert.equal(llm.MAX_TOTAL_ANSWERS, llm.MAX_LLM_QUESTIONS + llm.MAX_FOLLOWUP_QUESTIONS);
  assert.equal(llm.validateAnswers(make(11)).length, 11);
  assert.equal(llm.validateAnswers(make(12)), null);
});

test("質問生成プロンプトは曖昧な箇所の洗い出しとAIあるある分岐を含む", () => {
  const [system] = llm.buildQuestionsMessages("転職したい、自己PR書いて");
  assert.match(system.content, /曖昧な表現・未指定のパラメータ/);
  assert.match(system.content, /元の文の「甘い」箇所を狙う/);
  assert.match(system.content, /AIあるあるを消すための指定に直結する分岐/);
});

test("合成プロンプトはAIあるある禁止・積極指示・詰め固定・差し替え項目を必須化する", () => {
  const [system] = llm.buildSynthesizeMessages("転職したい", [{ question: "使い道は？", answer: "書類選考を通す" }]);
  const c = system.content;
  // AIあるある禁止の網羅
  assert.match(c, /まとめると/);
  assert.match(c, /まず〜、次に〜、最後に〜/);
  assert.match(c, /接続詞を連発しない/);
  assert.match(c, /両論併記で結論を逃げない/);
  assert.match(c, /バズワード/);
  assert.match(c, /焼き直した要約をしない/);
  // 禁止だけでなく代替の書き方（積極指示）
  assert.match(c, /立場・判断を1つに決めて書き切る/);
  assert.match(c, /自然なばらつき/);
  assert.match(c, /優先順位を付ける/);
  // 詰めの甘さの解消（具体化・固定・線引き）
  assert.match(c, /粒度まで落とす/);
  assert.match(c, /完成条件/);
  assert.match(c, /「適宜」「いい感じに」/);
  assert.match(c, /裁量で決めてよい範囲/);
  // 差し替え項目リストの必須化
  assert.match(c, /差し替え項目/);
  assert.match(c, /プレースホルダ/);
});

test("合成プロンプトは固定文・定型構成を強制せず、用途に合わせて組み立てる指示を含む", () => {
  const [system] = llm.buildSynthesizeMessages("依頼", [{ question: "Q?", answer: "A" }]);
  const c = system.content;
  // 形の固定を外す指示
  assert.match(c, /依頼の種類と用途に合った形式で書く/);
  assert.match(c, /毎回同じ見出し・同じ書き出し・同じ締めにしない/);
  assert.match(c, /どう並べ、どういう言葉で書くかは固定しない/);
  // 固定見出し・定型の構成指定が残っていない
  assert.ok(!c.includes("## 依頼文"));
  assert.ok(!c.includes("## 条件"));
  assert.ok(!c.includes("## 禁止事項"));
  assert.ok(!c.includes("この順序で書くこと"));
  // 定型の役割文は使わず、必要な場合だけ依頼専用の役割を書く
  assert.match(c, /定型の役割文（「実務に精通した専門家です」等）は使わない/);
  assert.match(c, /役割が成果物を左右しない依頼では、役割を無理に付けない/);
  // AIあるある対策は固定文ブロックではなく、選択適用＋用途別の翻訳で扱う
  assert.match(c, /すべてを固定文のブロックとして丸ごと写さない/);
  assert.match(c, /成果物の種類に関係するものだけを選び/);
  assert.match(c, /文章以外の成果物には持ち込まない/);
  assert.match(c, /TODO や省略記法で済ませず/);
  assert.match(c, /雰囲気語の羅列で済ませず/);
  assert.match(c, /一般論の列挙で済ませず/);
});

test("深掘りメッセージは1ラウンド目のQ&Aを含み、残りの曖昧さだけを狙う", () => {
  const answers = [
    { question: "使い道は？", answer: "書類選考を通す" },
    { question: "分量は？", answer: "400字でしっかり" },
  ];
  const messages = llm.buildFollowupMessages("転職したい、自己PR書いて", answers);
  assert.match(messages[0].content, /まだ決まっていない・曖昧なまま残っている箇所/);
  assert.match(messages[0].content, /最大3個/);
  assert.match(messages[1].content, /転職したい、自己PR書いて/);
  assert.match(messages[1].content, /使い道は？ → 書類選考を通す/);
  assert.match(messages[1].content, /分量は？ → 400字でしっかり/);
});

test("parseFollowupQuestionsJson は0問を正常系として返し、重複と崩れを除外する", () => {
  const asked = ["使い道は？", "分量は？"];
  assert.deepEqual(llm.parseFollowupQuestionsJson('{"questions":[]}', asked), []);
  const mixed = {
    questions: [
      { question: "使い道は？", options: ["A", "B"] },
      { question: "使い道は", options: ["A", "B"] },
      { question: "締切はいつ？", options: ["今週中", "今月中"] },
      { question: "壊れた質問", options: ["", "B"] },
      { question: "締切はいつ？", options: ["A", "B"] },
    ],
  };
  const parsed = llm.parseFollowupQuestionsJson(JSON.stringify(mixed), asked);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].question, "締切はいつ？");
  assert.equal(llm.parseFollowupQuestionsJson("JSONではありません", asked), null);
});

test("parseFollowupQuestionsJson は最大3問に切り詰める", () => {
  const many = { questions: [0, 1, 2, 3, 4].map((i) => ({ question: `追加質問${i}？`, options: ["A", "B"] })) };
  assert.equal(llm.parseFollowupQuestionsJson(JSON.stringify(many), []).length, 3);
});

test("generateFollowupQuestionsWithLlm は深掘りを返し、0問と失敗を区別する", async () => {
  const env = { LOGFARE_API_KEY: "k" };
  const prior = [{ question: "使い道は？", answer: "書類選考を通す" }];
  const followup = { questions: [{ question: "締切はいつ？", options: ["今週中", "今月中"] }] };
  const fetchImpl = async () => chatResponse(JSON.stringify(followup));
  const questions = await server.generateFollowupQuestionsWithLlm("転職したい", prior, { env, fetchImpl });
  assert.equal(questions.length, 1);
  assert.equal(questions[0].question, "締切はいつ？");

  const emptyFetch = async () => chatResponse('{"questions":[]}');
  assert.deepEqual(await server.generateFollowupQuestionsWithLlm("転職したい", prior, { env, fetchImpl: emptyFetch }), []);

  const badQueue = [chatResponse("壊れた出力"), chatResponse("やっぱり壊れた出力")];
  const badFetch = async () => badQueue.shift();
  assert.equal(await server.generateFollowupQuestionsWithLlm("転職したい", prior, { env, fetchImpl: badFetch }), null);
});

test("従来の questions 生成（answers なし）の検証は従来どおり厳しい", () => {
  const two = { questions: VALID_QUESTIONS.questions.slice(0, 2) };
  assert.equal(llm.parseQuestionsJson(JSON.stringify(two)), null);
  assert.equal(llm.parseQuestionsJson(JSON.stringify(VALID_QUESTIONS)).length, 3);
});

test("resolveQuestionCount は3/5/8だけを通し、それ以外は既定の5に丸める", () => {
  assert.equal(llm.resolveQuestionCount(3), 3);
  assert.equal(llm.resolveQuestionCount(5), 5);
  assert.equal(llm.resolveQuestionCount(8), 8);
  assert.equal(llm.resolveQuestionCount(undefined), 5);
  assert.equal(llm.resolveQuestionCount(4), 5);
  assert.equal(llm.resolveQuestionCount("8"), 5);
  assert.equal(llm.resolveQuestionCount(null), 5);
});

test("parseQuestionsJson は count に追随する（count=8で8問を許容、未指定は従来互換）", () => {
  const eight = { questions: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ question: `質問${i}？`, options: ["A", "B"] })) };
  assert.equal(llm.parseQuestionsJson(JSON.stringify(eight), 8).length, 8);
  assert.equal(llm.parseQuestionsJson(JSON.stringify(eight)), null);
  assert.equal(llm.parseQuestionsJson(JSON.stringify(eight), 5), null);
  const four = { questions: eight.questions.slice(0, 4) };
  assert.equal(llm.parseQuestionsJson(JSON.stringify(four), 3), null);
  assert.equal(llm.parseQuestionsJson(JSON.stringify(VALID_QUESTIONS), 3).length, 3);
});

test("質問生成プロンプトは count を目標数として含む", () => {
  assert.match(llm.buildQuestionsMessages("依頼", 8)[0].content, /3〜8個/);
  assert.match(llm.buildQuestionsMessages("依頼", 3)[0].content, /質問は3個/);
  assert.match(llm.buildQuestionsMessages("依頼")[0].content, /3〜5個/);
});

test("generateQuestionsWithLlm は count を生成と検証の両方に使う", async () => {
  const env = { LOGFARE_API_KEY: "k" };
  const eight = { questions: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ question: `質問${i}？`, options: ["A", "B"] })) };
  let seenBody = "";
  const fetchImpl = async (url, init) => {
    seenBody = init.body;
    return chatResponse(JSON.stringify(eight));
  };
  const questions = await server.generateQuestionsWithLlm("依頼", { env, fetchImpl, count: 8 });
  assert.equal(questions.length, 8);
  assert.match(JSON.parse(seenBody).messages[0].content, /3〜8個/);
});

test("validateAnswers は回答200字まで許容し、201字を弾く", () => {
  assert.equal(llm.validateAnswers([{ question: "Q?", answer: "あ".repeat(200) }]).length, 1);
  assert.equal(llm.validateAnswers([{ question: "Q?", answer: "あ".repeat(201) }]), null);
});

test("補助回答の回答文（どちらも／検討中／保留）が組み立てられ、検証を通る", () => {
  assert.equal(llm.bothAnswerText("A", "B"), "どちらも（「A」と「B」の両方）");
  assert.equal(llm.pendingAnswerText("A", "B"), "検討中（「A」と「B」で迷っている）");
  assert.equal(llm.DEFERRED_ANSWER_TEXT, "保留（今は決めない）");
  const long = "あ".repeat(60);
  for (const answer of [llm.bothAnswerText(long, long), llm.pendingAnswerText(long, long), llm.DEFERRED_ANSWER_TEXT]) {
    assert.equal(llm.validateAnswers([{ question: "Q?", answer }]).length, 1);
  }
});

test("合成プロンプトは検討中＝既定＋前提明示、保留＝決め打ち禁止を明記する", () => {
  const [system] = llm.buildSynthesizeMessages("依頼", [{ question: "Q?", answer: "A" }]);
  assert.match(system.content, /検討中（…）/);
  assert.match(system.content, /最も妥当な既定を1つ置かせ/);
  assert.match(system.content, /保留（今は決めない）/);
  assert.match(system.content, /勝手に決めさせない/);
  assert.match(system.content, /両立させる指示として反映する/);
});

test("合成メッセージは自由入力の回答文をそのまま含み、明示指定として扱う指示がある", () => {
  const messages = llm.buildSynthesizeMessages("依頼", [{ question: "分量は？", answer: "300字で、見出しなし" }]);
  assert.match(messages[1].content, /分量は？ → 300字で、見出しなし/);
  assert.match(messages[0].content, /自由入力した明示指定/);
});

test("深掘りプロンプトは検討中・保留を蒸し返さない指示を含む", () => {
  const [system] = llm.buildFollowupMessages("依頼", [{ question: "Q?", answer: llm.DEFERRED_ANSWER_TEXT }]);
  assert.match(system.content, /「検討中」「保留」と答えた項目は/);
  assert.match(system.content, /蒸し返さない/);
});

test("revise の検証は instruction 201字と prompt 欠落・過長を弾く", () => {
  assert.equal(llm.validateReviseInstruction("短くして"), "短くして");
  assert.equal(llm.validateReviseInstruction("あ".repeat(200)).length, 200);
  assert.equal(llm.validateReviseInstruction("あ".repeat(201)), null);
  assert.equal(llm.validateReviseInstruction(""), null);
  assert.equal(llm.validatePromptInput("完成プロンプト"), "完成プロンプト");
  assert.equal(llm.validatePromptInput(""), null);
  assert.equal(llm.validatePromptInput(undefined), null);
  assert.equal(llm.validatePromptInput("あ".repeat(llm.MAX_PROMPT_CHARS + 1)), null);
});

test("buildReviseMessages は対策の中身を弱めない指示と現在の内容・修正指示を含む", () => {
  const messages = llm.buildReviseMessages("現在のプロンプト本文", "もっと短く");
  assert.match(messages[0].content, /中身（意図）を弱めない・落とさない/);
  assert.match(messages[0].content, /対策側を優先/);
  assert.match(messages[1].content, /現在のプロンプト本文/);
  assert.match(messages[1].content, /もっと短く/);
});

test("buildReviseMessages は書き直しを定型構成に戻さない指示を含む", () => {
  const messages = llm.buildReviseMessages("現在のプロンプト本文", "もっと短く");
  assert.match(messages[0].content, /定型の見出し構成や定型の冒頭文に寄せない/);
  assert.match(messages[0].content, /依頼の用途に合った形を保つ/);
});

test("reviseWithLlm はフェンスを剥がした書き直し結果を返す", async () => {
  const env = { LOGFARE_API_KEY: "k" };
  const fetchImpl = async () => chatResponse("```\n書き直したプロンプト\n```");
  const revised = await server.reviseWithLlm("元のプロンプト", "短く", { env, fetchImpl });
  assert.equal(revised, "書き直したプロンプト");
});
