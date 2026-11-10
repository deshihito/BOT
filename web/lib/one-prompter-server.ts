// One Prompter のサーバー側 LLM クライアント（Logfare / OpenAI 互換）。
// Bot 側 core/general/ai/logfare.py と同じ流儀:
// - キーは環境変数 LOGFARE_API_KEY / _2 / _3 / LOGFARE_API_KEYS（カンマ区切り）から読む
// - 切り替えは HTTP 429 のときだけ次のキーへ。それ以外のエラーは即座に失敗させる
// - キーの値はログにもレスポンスにも絶対に出さない（ログはキー番号のみ）
// API キーが未設定なら呼び出し側がルールベース版にフォールバックする。

import {
  buildFollowupMessages,
  buildFollowupRetryMessages,
  buildQuestionsMessages,
  buildQuestionsRetryMessages,
  buildReviseMessages,
  buildSynthesizeMessages,
  cleanSynthesizedPrompt,
  parseFollowupQuestionsJson,
  parseQuestionsJson,
  resolveQuestionCount,
  type ChatMessage,
  type LlmAnswer,
  type LlmQuestion,
} from "./one-prompter-llm";

export const DEFAULT_MODEL = "deepseek-v4.1-flash-1017";
const DEFAULT_BASE_URL = "https://logfare.ai/v1";
const REQUEST_TIMEOUT_MS = 30_000;

type Env = Record<string, string | undefined>;
type FetchImpl = typeof fetch;

/** Bot 側 api_keys() と同じ順序・重複除去でキーを集める。 */
export function logfareApiKeys(env: Env = process.env): string[] {
  const candidates: (string | undefined)[] = [env.LOGFARE_API_KEY, env.LOGFARE_API_KEY_2, env.LOGFARE_API_KEY_3];
  candidates.push(...(env.LOGFARE_API_KEYS ?? "").split(","));
  const keys: string[] = [];
  for (const candidate of candidates) {
    const key = candidate?.trim();
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function onePrompterModel(env: Env = process.env): string {
  return env.ONE_PROMPTER_MODEL?.trim() || DEFAULT_MODEL;
}

function logfareBaseUrl(env: Env): string {
  return (env.LOGFARE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export class LogfareHttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`Logfare API error ${status}`);
    this.status = status;
  }
}

function extractContent(data: unknown): string {
  const choices = (data as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const content = (choices[0] as { message?: { content?: unknown } })?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("\n")
      .trim();
  }
  return "";
}

/**
 * Chat Completions を1回実行して本文を返す。
 * 429 のときだけ次のキーを試す。それ以外の HTTP エラーは即座に投げる。
 */
export async function logfareChat(
  messages: ChatMessage[],
  options: {
    maxTokens: number;
    env?: Env;
    fetchImpl?: FetchImpl;
    timeoutMs?: number;
  },
): Promise<string> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const keys = logfareApiKeys(env);
  if (keys.length === 0) throw new Error("LOGFARE_API_KEY が設定されていません。");
  const payload = {
    model: onePrompterModel(env),
    messages,
    max_tokens: options.maxTokens,
    reasoning_effort: "none",
  };
  let lastError: unknown = null;
  for (let i = 0; i < keys.length; i++) {
    let response: Response;
    try {
      response = await fetchImpl(`${logfareBaseUrl(env)}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keys[i]}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // ネットワークエラー・タイムアウトはキーを替えても直らないので即失敗
      throw error;
    }
    if (response.status === 429) {
      console.warn(`one-prompter: Logfare key #${i + 1} returned 429, failing over to next key`);
      lastError = new LogfareHttpError(429);
      continue;
    }
    if (!response.ok) throw new LogfareHttpError(response.status);
    const content = extractContent(await response.json());
    if (!content) throw new Error("Logfare API の応答に回答本文がありませんでした。");
    return content;
  }
  throw lastError ?? new Error("Logfare API を利用できませんでした。");
}

/** 二択質問を LLM で生成する。形式が崩れたら1回だけ組み直し、それでも駄目なら null。 */
export async function generateQuestionsWithLlm(
  rough: string,
  deps: { env?: Env; fetchImpl?: FetchImpl; count?: unknown } = {},
): Promise<LlmQuestion[] | null> {
  const count = resolveQuestionCount(deps.count);
  const chatDeps = { env: deps.env, fetchImpl: deps.fetchImpl };
  const first = await logfareChat(buildQuestionsMessages(rough, count), { maxTokens: 1400, ...chatDeps });
  const parsed = parseQuestionsJson(first, count);
  if (parsed) return parsed;
  const second = await logfareChat(buildQuestionsRetryMessages(rough, count), { maxTokens: 1400, ...chatDeps });
  return parseQuestionsJson(second, count);
}

/**
 * 深掘り（2ラウンド目）の二択質問を LLM で生成する。
 * 戻り値が空配列なら「残っている曖昧な箇所なし＝深掘りなし」の正常系。
 * 形式が崩れたら1回だけ組み直し、それでも読めなければ null（呼び出し側は合成へ進む）。
 */
export async function generateFollowupQuestionsWithLlm(
  rough: string,
  answers: LlmAnswer[],
  deps: { env?: Env; fetchImpl?: FetchImpl } = {},
): Promise<LlmQuestion[] | null> {
  const asked = answers.map((a) => a.question);
  const first = await logfareChat(buildFollowupMessages(rough, answers), { maxTokens: 700, ...deps });
  const parsed = parseFollowupQuestionsJson(first, asked);
  if (parsed) return parsed;
  const second = await logfareChat(buildFollowupRetryMessages(rough, answers), { maxTokens: 700, ...deps });
  return parseFollowupQuestionsJson(second, asked);
}

/** 完成プロンプトを LLM で合成する。整形できなければ null。 */
export async function synthesizeWithLlm(
  rough: string,
  answers: LlmAnswer[],
  deps: { env?: Env; fetchImpl?: FetchImpl } = {},
): Promise<string | null> {
  const raw = await logfareChat(buildSynthesizeMessages(rough, answers), { maxTokens: 1800, ...deps });
  return cleanSynthesizedPrompt(raw);
}

/** 完成プロンプトを修正指示どおりに LLM で書き直す。整形できなければ null。 */
export async function reviseWithLlm(
  prompt: string,
  instruction: string,
  deps: { env?: Env; fetchImpl?: FetchImpl } = {},
): Promise<string | null> {
  const raw = await logfareChat(buildReviseMessages(prompt, instruction), { maxTokens: 2400, ...deps });
  return cleanSynthesizedPrompt(raw);
}
