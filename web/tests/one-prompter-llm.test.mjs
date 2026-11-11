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

test("synthesizeWithLlm はフェンスを剥がした完成プロンプトを返す（検証応答が読めなければ下書き）", async () => {
  const env = { LOGFARE_API_KEY: "dummy" };
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return chatResponse("```\n完成プロンプト本文\n```");
  };
  const prompt = await server.synthesizeWithLlm("転職したい", [{ question: "使い道は？", answer: "書類選考を通す" }], { env, fetchImpl });
  assert.equal(prompt, "完成プロンプト本文");
  // 下書き生成＋自己検証の2回呼ばれる（検証応答はJSONでないため下書きが返る）
  assert.equal(calls, 2);
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

test("質問生成プロンプトは影響度順・対立軸の明確さ・逃げの選択肢禁止を含む（深掘りも）", () => {
  const [system] = llm.buildQuestionsMessages("転職したい、自己PR書いて");
  assert.match(system.content, /成果物への影響度が高い順に並べる/);
  assert.match(system.content, /対立軸をはっきりさせる/);
  assert.match(system.content, /何がどう変わるかが、選択肢の文面から読み取れる/);
  assert.match(system.content, /中間的な逃げの選択肢は作らない/);
  const [followupSystem] = llm.buildFollowupMessages("転職したい", [{ question: "Q?", answer: "A" }]);
  assert.match(followupSystem.content, /成果物への影響度が高い順に並べる/);
  assert.match(followupSystem.content, /対立軸をはっきりさせる/);
  assert.match(followupSystem.content, /中間的な逃げの選択肢は作らない/);
});

test("合成プロンプトは完成プロンプト自体の冗長さ排除（密度）を含む", () => {
  const [system] = llm.buildSynthesizeMessages("依頼", [{ question: "Q?", answer: "A" }]);
  assert.match(system.content, /完成プロンプト自体を冗長にしない/);
  assert.match(system.content, /同じことを2回言わない/);
  assert.match(system.content, /条件は短い文で言い切り/);
});

test("buildVerifyMessages は検査観点と下書き・回答を含む", () => {
  const answers = [{ question: "使い道は？", answer: "書類選考を通す" }];
  const messages = llm.buildVerifyMessages("転職したい", answers, "下書きのプロンプト");
  const c = messages[0].content;
  assert.match(c, /決まった条件が、下書きに落ちていないか/);
  assert.match(c, /改変されていないか/);
  assert.match(c, /曖昧な表現や、未処理のまま残った曖昧な箇所/);
  assert.match(c, /プロンプト自体にAIあるある/);
  assert.match(c, /条件同士が矛盾していないか/);
  assert.match(c, /用途に合わない形式/);
  assert.match(c, /"issues"/);
  assert.match(messages[1].content, /転職したい/);
  assert.match(messages[1].content, /使い道は？ → 書類選考を通す/);
  assert.match(messages[1].content, /下書きのプロンプト/);
});

test("parseVerificationJson は問題リストと空配列を読み、崩れを弾き、上限で切り詰める", () => {
  assert.deepEqual(llm.parseVerificationJson('{"issues":["条件Xが落ちている","「適宜」が残っている"]}'), [
    "条件Xが落ちている",
    "「適宜」が残っている",
  ]);
  assert.deepEqual(llm.parseVerificationJson('{"issues":[]}'), []);
  const fenced = "```json\n" + '{"issues":["問題A"]}' + "\n```";
  assert.deepEqual(llm.parseVerificationJson(fenced), ["問題A"]);
  assert.equal(llm.parseVerificationJson("JSONではありません"), null);
  assert.equal(llm.parseVerificationJson('{"foo":1}'), null);
  assert.equal(llm.parseVerificationJson('{"issues":"文字列"}'), null);
  const many = { issues: Array.from({ length: llm.MAX_VERIFY_ISSUES + 2 }, (_, i) => `問題${i}`) };
  assert.equal(llm.parseVerificationJson(JSON.stringify(many)).length, llm.MAX_VERIFY_ISSUES);
  // 空・長すぎの項目は読み飛ばす
  assert.deepEqual(llm.parseVerificationJson(JSON.stringify({ issues: ["", "問題B", "あ".repeat(201)] })), ["問題B"]);
});

test("buildRefineMessages は問題リストと下書きを含み、問題だけを直す指示を持つ", () => {
  const messages = llm.buildRefineMessages("転職したい", [{ question: "使い道は？", answer: "書類選考を通す" }], "下書きのプロンプト", [
    "条件Xが落ちている",
  ]);
  assert.match(messages[0].content, /問題だけを直した完成プロンプトの全文/);
  assert.match(messages[0].content, /AIあるある対策の中身/);
  assert.match(messages[0].content, /弱めない・落とさない/);
  assert.match(messages[1].content, /下書きのプロンプト/);
  assert.match(messages[1].content, /条件Xが落ちている/);
});

test("synthesizeWithLlm は問題があれば直しを1回だけ呼んで直した版を返す", async () => {
  const env = { LOGFARE_API_KEY: "k" };
  const bodies = [];
  const queue = [
    chatResponse("下書きのプロンプト"),
    chatResponse('{"issues":["分量の条件が落ちている"]}'),
    chatResponse("直したプロンプト"),
  ];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return queue.shift();
  };
  const answers = [{ question: "分量は？", answer: "400字でしっかり" }];
  const prompt = await server.synthesizeWithLlm("転職したい", answers, { env, fetchImpl });
  assert.equal(prompt, "直したプロンプト");
  assert.equal(bodies.length, 3);
  // 3回目（直し）のリクエストには問題リストと下書きが入っている
  const refineUser = bodies[2].messages[1].content;
  assert.match(refineUser, /分量の条件が落ちている/);
  assert.match(refineUser, /下書きのプロンプト/);
});

test("synthesizeWithLlm は問題が無ければ下書きをそのまま返し、直しを呼ばない", async () => {
  const env = { LOGFARE_API_KEY: "k" };
  let calls = 0;
  const queue = [chatResponse("下書きのプロンプト"), chatResponse('{"issues":[]}')];
  const fetchImpl = async () => {
    calls += 1;
    return queue.shift();
  };
  const prompt = await server.synthesizeWithLlm("転職したい", [{ question: "Q?", answer: "A" }], { env, fetchImpl });
  assert.equal(prompt, "下書きのプロンプト");
  assert.equal(calls, 2);
});

test("resolvePromptLang は ja/en/hybrid だけを通し、それ以外は既定の hybrid に丸める", () => {
  assert.equal(llm.DEFAULT_PROMPT_LANG, "hybrid");
  assert.equal(llm.resolvePromptLang("ja"), "ja");
  assert.equal(llm.resolvePromptLang("en"), "en");
  assert.equal(llm.resolvePromptLang("hybrid"), "hybrid");
  assert.equal(llm.resolvePromptLang(undefined), "hybrid");
  assert.equal(llm.resolvePromptLang(null), "hybrid");
  assert.equal(llm.resolvePromptLang("fr"), "hybrid");
  assert.equal(llm.resolvePromptLang("JA"), "hybrid");
  assert.equal(llm.resolvePromptLang(3), "hybrid");
});

test("質問生成プロンプトは作る系の深さ分岐（文書まで／作り切る）を観点に含む（深掘りも）", () => {
  const [system] = llm.buildQuestionsMessages("タスク管理アプリを作りたい");
  assert.match(system.content, /成果物の深さの分岐/);
  assert.match(system.content, /設計・提案の文書まででよい／実際に動く形まで作り切る/);
  assert.match(system.content, /深さが既に明らかな場合/);
  const [followupSystem] = llm.buildFollowupMessages("タスク管理アプリを作りたい", [{ question: "Q?", answer: "A" }]);
  assert.match(followupSystem.content, /成果物の深さ（設計・提案の文書までか、実際に動く形まで作り切るか）/);
});

test("合成プロンプトは作る系の完了駆動要件（文書止まり禁止・確認で止めない）と文書選択時の例外を含む", () => {
  const [system] = llm.buildSynthesizeMessages("タスク管理アプリを作りたい", [{ question: "深さは？", answer: "実際に動く形まで作り切る" }]);
  const c = system.content;
  assert.match(c, /完成条件を「動く成果物が存在し、動作確認まで済んだ状態」と定義する/);
  assert.match(c, /文書の作成だけで終わらせない/);
  assert.match(c, /中間物として扱い、実装まで進める/);
  assert.match(c, /途中で確認の質問を挟まず/);
  assert.match(c, /動作確認・検証まで行う/);
  // ユーザーが文書そのものを選んだ場合は実装指示を付けない
  assert.match(c, /文書（提案書・仕様書・計画書など）そのものを成果物として選んだ場合は/);
  assert.match(c, /実装まで進める指示は付けない/);
});

test("合成と revise は受け取るAIが実行しやすい形（宣言的・列挙・判別可能）を原則に含む", () => {
  const [system] = llm.buildSynthesizeMessages("依頼", [{ question: "Q?", answer: "A" }]);
  assert.match(system.content, /受け取るAIが誤解なく実行できることを優先する/);
  assert.match(system.content, /指示は宣言的で曖昧さのない文で言い切る/);
  assert.match(system.content, /機械的に判別できる形にする/);
  assert.match(system.content, /情緒的な言い回し/);
  const [reviseSystem] = llm.buildReviseMessages("現在のプロンプト", "短く");
  assert.match(reviseSystem.content, /受け取るAIが誤解なく実行できる形を崩さない/);
});

test("合成の出力言語モード: 既定は hybrid（英語フレーム＋原文引用）、en は全文英語化と英訳、ja は日本語", () => {
  const answers = [{ question: "Q?", answer: "A" }];
  // 既定（lang 省略）= hybrid
  const [hybridSystem] = llm.buildSynthesizeMessages("依頼", answers);
  assert.match(hybridSystem.content, /OUTPUT LANGUAGE — HYBRID MODE/);
  assert.match(hybridSystem.content, /Write the frame of the finished prompt/);
  assert.match(hybridSystem.content, /verbatim in the original Japanese/);
  assert.match(hybridSystem.content, /Do not translate it/);
  // en
  const [enSystem] = llm.buildSynthesizeMessages("依頼", answers, "en");
  assert.match(enSystem.content, /OUTPUT LANGUAGE — ENGLISH MODE/);
  assert.match(enSystem.content, /Write the entire finished prompt in English/);
  assert.match(enSystem.content, /Translate it into English/);
  assert.match(enSystem.content, /The deliverable must be written in Japanese/);
  // ja
  const [jaSystem] = llm.buildSynthesizeMessages("依頼", answers, "ja");
  assert.match(jaSystem.content, /完成プロンプトは日本語で書くこと/);
  assert.ok(!jaSystem.content.includes("OUTPUT LANGUAGE — ENGLISH MODE"));
  assert.ok(!jaSystem.content.includes("OUTPUT LANGUAGE — HYBRID MODE"));
});

test("検証メッセージは観点 (f)（作る系の文書止まり）と出力言語モードを含む", () => {
  const answers = [{ question: "深さは？", answer: "実際に動く形まで作り切る" }];
  const messages = llm.buildVerifyMessages("アプリを作りたい", answers, "下書き", "en");
  assert.match(messages[0].content, /文書の作成止まりになり得る形になっていないか/);
  assert.match(messages[0].content, /ユーザーが文書そのものを成果物として選んだ場合は、この観点は対象外/);
  assert.match(messages[0].content, /出力言語モード（ユーザーメッセージで指定される ja \/ en \/ hybrid）/);
  assert.match(messages[1].content, /出力言語モード: en/);
  // 既定は hybrid
  const [def] = [llm.buildVerifyMessages("依頼", answers, "下書き")[1]];
  assert.match(def.content, /出力言語モード: hybrid/);
});

test("直しメッセージは出力言語モードを含み、モード維持の指示を持つ", () => {
  const messages = llm.buildRefineMessages("依頼", [{ question: "Q?", answer: "A" }], "下書き", ["問題"], "ja");
  assert.match(messages[0].content, /出力言語モード（ユーザーメッセージで指定される）を維持する/);
  assert.match(messages[1].content, /出力言語モード: ja/);
});

test("buildReviseMessages の言語: 未指定は現在の言語に合わせ、en/hybrid はモード指示になる", () => {
  const [keepSystem] = llm.buildReviseMessages("現在のプロンプト", "短く");
  assert.match(keepSystem.content, /現在のプロンプトの言語に合わせる/);
  assert.match(keepSystem.content, /言語を勝手に切り替えない/);
  const [enSystem] = llm.buildReviseMessages("現在のプロンプト", "短く", "en");
  assert.match(enSystem.content, /OUTPUT LANGUAGE — ENGLISH MODE/);
  assert.match(enSystem.content, /translate the whole prompt into English/);
  const [hybridSystem] = llm.buildReviseMessages("現在のプロンプト", "短く", "hybrid");
  assert.match(hybridSystem.content, /OUTPUT LANGUAGE — HYBRID MODE/);
  assert.match(hybridSystem.content, /quoted verbatim in the original Japanese/);
});

test("synthesizeWithLlm は lang を合成・検証の両方へ伝播する（不正値は hybrid）", async () => {
  const env = { LOGFARE_API_KEY: "k" };
  const bodies = [];
  const queue = [chatResponse("下書きのプロンプト"), chatResponse('{"issues":[]}')];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return queue.shift();
  };
  const answers = [{ question: "Q?", answer: "A" }];
  const prompt = await server.synthesizeWithLlm("依頼", answers, { env, fetchImpl, lang: "en" });
  assert.equal(prompt, "下書きのプロンプト");
  assert.equal(bodies.length, 2);
  assert.match(bodies[0].messages[0].content, /OUTPUT LANGUAGE — ENGLISH MODE/);
  assert.match(bodies[1].messages[1].content, /出力言語モード: en/);

  const bodies2 = [];
  const queue2 = [chatResponse("下書きのプロンプト"), chatResponse('{"issues":[]}')];
  const fetchImpl2 = async (url, init) => {
    bodies2.push(JSON.parse(init.body));
    return queue2.shift();
  };
  await server.synthesizeWithLlm("依頼", answers, { env, fetchImpl: fetchImpl2, lang: "xx" });
  assert.match(bodies2[0].messages[0].content, /OUTPUT LANGUAGE — HYBRID MODE/);
});

test("reviseWithLlm は lang 指定でモードを伝え、未指定では現在の言語維持になる", async () => {
  const env = { LOGFARE_API_KEY: "k" };
  let seenBody = "";
  const fetchImpl = async (url, init) => {
    seenBody = init.body;
    return chatResponse("書き直したプロンプト");
  };
  const revised = await server.reviseWithLlm("元のプロンプト", "短く", { env, fetchImpl, lang: "en" });
  assert.equal(revised, "書き直したプロンプト");
  assert.match(JSON.parse(seenBody).messages[0].content, /OUTPUT LANGUAGE — ENGLISH MODE/);
  let seenBody2 = "";
  const fetchImpl2 = async (url, init) => {
    seenBody2 = init.body;
    return chatResponse("書き直したプロンプト");
  };
  await server.reviseWithLlm("元のプロンプト", "短く", { env, fetchImpl: fetchImpl2 });
  assert.match(JSON.parse(seenBody2).messages[0].content, /現在のプロンプトの言語に合わせる/);
});

test("synthesizeWithLlm は検証・直しの失敗時に下書きをそのまま返す", async () => {
  const env = { LOGFARE_API_KEY: "k" };
  const answers = [{ question: "Q?", answer: "A" }];
  // 検証の呼び出しが例外（ネットワークエラー）
  const verifyThrows = [chatResponse("下書きのプロンプト"), new Error("network down")];
  const fetchVerifyThrows = async () => {
    const next = verifyThrows.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  assert.equal(await server.synthesizeWithLlm("転職したい", answers, { env, fetchImpl: fetchVerifyThrows }), "下書きのプロンプト");
  // 検証の応答がJSONとして読めない
  const verifyGarbage = [chatResponse("下書きのプロンプト"), chatResponse("検査できませんでした")];
  const fetchVerifyGarbage = async () => verifyGarbage.shift();
  assert.equal(await server.synthesizeWithLlm("転職したい", answers, { env, fetchImpl: fetchVerifyGarbage }), "下書きのプロンプト");
  // 直しの呼び出しが例外
  const refineThrows = [chatResponse("下書きのプロンプト"), chatResponse('{"issues":["問題あり"]}'), new Error("network down")];
  const fetchRefineThrows = async () => {
    const next = refineThrows.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  assert.equal(await server.synthesizeWithLlm("転職したい", answers, { env, fetchImpl: fetchRefineThrows }), "下書きのプロンプト");
  // 直しの応答が整形できない（長すぎ）
  const refineTooLong = [
    chatResponse("下書きのプロンプト"),
    chatResponse('{"issues":["問題あり"]}'),
    chatResponse("あ".repeat(llm.MAX_PROMPT_CHARS + 1)),
  ];
  const fetchRefineTooLong = async () => refineTooLong.shift();
  assert.equal(await server.synthesizeWithLlm("転職したい", answers, { env, fetchImpl: fetchRefineTooLong }), "下書きのプロンプト");
});
