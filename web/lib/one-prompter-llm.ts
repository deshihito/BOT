// One Prompter の LLM 連携用 純粋ロジック（検証・メッセージ構築）。
// ネットワークや環境変数には触れない。サーバー側（one-prompter-server.ts）と
// テストの両方から使う。ルールベース版（one-prompter.ts）の代替ではなく、
// 実LLMが使えない場面ではそちらへフォールバックする設計。

/** 雑な一文の上限（コスト・悪用ガード）。クライアント側でも同じ値で制限する。 */
export const MAX_ROUGH_LENGTH = 500;

export const MIN_QUESTIONS = 3;
export const MAX_LLM_QUESTIONS = 5;

export type LlmQuestion = {
  question: string;
  options: [string, string];
};

export type LlmAnswer = {
  question: string;
  answer: string;
};

export type ChatMessage = { role: "system" | "user"; content: string };

const QUESTION_MAX_CHARS = 120;
const OPTION_MAX_CHARS = 60;
const ANSWER_MAX_CHARS = 60;
export const MAX_PROMPT_CHARS = 6000;

export function validateRough(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const rough = value.trim();
  if (!rough || rough.length > MAX_ROUGH_LENGTH) return null;
  return rough;
}

export function validateAnswers(value: unknown): LlmAnswer[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LLM_QUESTIONS) return null;
  const answers: LlmAnswer[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const q = (item as { question?: unknown }).question;
    const a = (item as { answer?: unknown }).answer;
    if (typeof q !== "string" || typeof a !== "string") return null;
    const question = q.trim();
    const answer = a.trim();
    if (!question || question.length > QUESTION_MAX_CHARS) return null;
    if (!answer || answer.length > ANSWER_MAX_CHARS) return null;
    answers.push({ question, answer });
  }
  return answers;
}

const QUESTIONS_SYSTEM_PROMPT = [
  "あなたはプロンプト設計の専門家です。ユーザーが雑に書いた一文の依頼を受け取り、その依頼に対する成果物が最も変わる「分岐」を、二択質問として設計します。",
  "AIの出力が無難でつまらなくなるのは、目的・読み手・成果物の形・トーン・分量・切り口などが未指定で、AIが無難な平均値で埋めるからです。あなたの仕事は、その空欄のうち答えによって成果物が大きく変わるものだけを、生成の前に質問で埋めることです。",
  "",
  "ルール:",
  "- 質問は3〜5個。答えても成果物がほぼ変わらないことは聞かない。",
  "- 各質問には選択肢をちょうど2つ。抽象的なラベル（「丁寧」「カジュアル」等）ではなく、この依頼に即した具体的な中身で切る（例: 転職の自己PRなら「書類選考を通す／面接で話す準備」）。",
  "- 質問文は短く、ユーザーが一目で選べる形にする。説明や前置きは付けない。",
  "- 分岐の観点は目的・読み手・成果物の形・トーン・分量・切り口から、この依頼に効く順に選ぶ。",
  "",
  "出力は次の形式のJSONだけを出すこと。前置き・解説・コードフェンスは一切付けない。",
  '{"questions":[{"question":"質問文","options":["選択肢A","選択肢B"]}]}',
].join("\n");

export function buildQuestionsMessages(rough: string): ChatMessage[] {
  return [
    { role: "system", content: QUESTIONS_SYSTEM_PROMPT },
    { role: "user", content: `ユーザーの依頼は次の一文です。\n\n${rough}` },
  ];
}

/** リトライ用: 形式を守れなかった旨を添えて同じ依頼を組み直す。 */
export function buildQuestionsRetryMessages(rough: string): ChatMessage[] {
  const messages = buildQuestionsMessages(rough);
  messages.push({
    role: "user",
    content:
      "直前の出力は指定のJSON形式として読み取れませんでした。説明文やコードフェンスを一切付けず、指定形式のJSONだけを再出力してください。",
  });
  return messages;
}

const SYNTHESIZE_SYSTEM_PROMPT = [
  "あなたはプロンプト設計の専門家です。ユーザーの元の依頼と、二択質問への回答をもとに、そのまま ChatGPT や Claude 等のAIに貼れば質の高い成果物が得られる「完成プロンプト」を1つ作成します。",
  "",
  "完成プロンプトの構成（この順序で書くこと）:",
  "冒頭に、AIの役割と仕事を1〜2文で端的に指示する文を置く（例:「あなたは、この分野の実務に精通した専門家です。以下の依頼に対して、指定された条件をすべて満たす成果物を出力してください。」のような形。依頼の分野に合わせて調整してよい）。",
  "## 依頼文",
  "ユーザーの元の依頼を、一字一句そのまま引用する。",
  "## 条件",
  "二択への回答を、AIへの具体的な指示文として箇条書きにする。回答の言い換えではなく、成果物がどう変わるべきかまで踏み込む。",
  "## 禁止事項",
  "次の禁止事項を箇条書きで必ず含める:",
  "- 定型の前置き・締め文句（「いかがでしたか」「〜と言えるでしょう」等）を使わない",
  "- 「革新的」「画期的」など根拠のない誇張表現を使わない。具体的な事実で示す",
  "- 情報が足りない部分を無難な一般論で埋めない。前提が必要なら、最も妥当な前提を1つ置いて明示する",
  "- 同じ内容の言い換え繰り返しで分量を稼がない",
  "- 情報不足を理由に確認や質問で止めず、成果物を出力する",
  "",
  "出力は完成プロンプトの本文だけ。前置き・解説・コードフェンスは付けない。元の依頼に無い事実（実績、数字、固有名詞など）を勝手に作らない。",
].join("\n");

export function buildSynthesizeMessages(rough: string, answers: LlmAnswer[]): ChatMessage[] {
  const lines = answers.map((a) => `- ${a.question} → ${a.answer}`).join("\n");
  return [
    { role: "system", content: SYNTHESIZE_SYSTEM_PROMPT },
    {
      role: "user",
      content: `元の依頼:\n${rough}\n\n二択質問への回答:\n${lines}`,
    },
  ];
}

/** LLM応答から質問JSONを取り出して検証する。形式が崩れていたら null。 */
export function parseQuestionsJson(text: string): LlmQuestion[] | null {
  if (typeof text !== "string") return null;
  let body = text.trim();
  // コードフェンスで包まれていたら剥がす
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) body = fence[1].trim();
  // 前後に文が混ざっていたら最初の { から最後の } までを取る
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let data: unknown;
  try {
    data = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const rawQuestions = (data as { questions?: unknown }).questions;
  if (!Array.isArray(rawQuestions)) return null;
  if (rawQuestions.length < MIN_QUESTIONS || rawQuestions.length > MAX_LLM_QUESTIONS) return null;
  const questions: LlmQuestion[] = [];
  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== "object") return null;
    const q = (raw as { question?: unknown }).question;
    const opts = (raw as { options?: unknown }).options;
    if (typeof q !== "string") return null;
    const question = q.trim();
    if (!question || question.length > QUESTION_MAX_CHARS) return null;
    if (!Array.isArray(opts) || opts.length !== 2) return null;
    const options = opts.map((o) => (typeof o === "string" ? o.trim() : ""));
    if (options.some((o) => !o || o.length > OPTION_MAX_CHARS)) return null;
    if (options[0] === options[1]) return null;
    questions.push({ question, options: [options[0], options[1]] });
  }
  return questions;
}

/** 合成結果を整える。フェンスや前後の空白を取り除き、長さの範囲外なら null。 */
export function cleanSynthesizedPrompt(text: string): string | null {
  if (typeof text !== "string") return null;
  let body = text.trim();
  const fence = body.match(/^```(?:markdown|md|text)?\s*([\s\S]*?)\s*```$/);
  if (fence) body = fence[1].trim();
  if (!body || body.length > MAX_PROMPT_CHARS) return null;
  return body;
}
