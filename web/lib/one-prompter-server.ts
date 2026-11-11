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
  buildRefineMessages,
  buildReviseMessages,
  buildSynthesizeMessages,
  buildVerifyMessages,
  cleanSynthesizedPrompt,
  parseFollowupQuestionsJson,
  parseQuestionsJson,
  parseVerificationJson,
  resolveModelKey,
  resolvePromptLang,
  resolveQuestionCount,
  type ChatMessage,
  type LlmAnswer,
  type LlmQuestion,
  type PrompterModelKey,
} from "./one-prompter-llm";

export const DEFAULT_MODEL = "deepseek-v4.1-flash-1017";
const DEFAULT_BASE_URL = "https://logfare.ai/v1";
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * 合成後の自己検証と直しの各呼び出しの上限時間。
 * 下書き生成（既定30秒）と合わせて route の maxDuration=60秒に収まるよう、
 * 追加の2呼び出しは短めに切る（通常応答は数秒で返る前提の上限値）。
 */
const VERIFY_TIMEOUT_MS = 15_000;

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

/** reasoning_effort に渡せる値。モデルによってはパラメータ自体を送らない。 */
export type ModelReasoning = "none" | "low";

/**
 * モデルキー → 実モデル ID と reasoning の対応表（サーバー側だけが持つ。
 * ID をクライアントへは出さない）。reasoning の出し分けは実測に基づく既知仕様で、
 * 間違えると API エラーになる:
 * - deepseek / qwen は reasoning "none" 可
 * - glm 系は reasoning が必須で下限が "low"（"none" は不可）
 * - gemma / kimi は reasoning パラメータを送らない
 * ID は env で差し替え可能。既定モデル（deepseek1017）の ID は、従来の
 * ONE_PROMPTER_MODEL が「既定モデルの ID 上書き」としてそのまま効く。
 * 注意: kimi31pro の ID "kimi-k3.1-pro" は未検証の推定値。実在が確認できるまでは
 * env ONE_PROMPTER_MODEL_KIMI での差し替えを前提に置く。
 */
const MODEL_CATALOG: Record<PrompterModelKey, { id: string; reasoning?: ModelReasoning; envName: string }> = {
  glm53: { id: "glm-5.3", reasoning: "low", envName: "ONE_PROMPTER_MODEL_GLM53" },
  "glm53-flash": { id: "glm-5.3-flash", reasoning: "low", envName: "ONE_PROMPTER_MODEL_GLM53_FLASH" },
  deepseek1017: { id: DEFAULT_MODEL, reasoning: "none", envName: "ONE_PROMPTER_MODEL" },
  gemma26b: { id: "gemma-4-26b", envName: "ONE_PROMPTER_MODEL_GEMMA26B" },
  qwen27b: { id: "qwen-3.8-27b", reasoning: "none", envName: "ONE_PROMPTER_MODEL_QWEN27B" },
  kimi31pro: { id: "kimi-k3.1-pro", envName: "ONE_PROMPTER_MODEL_KIMI" },
};

/** モデルキー（不正値は既定に丸める）を、実際に送る ID と reasoning に解決する。 */
export function resolveModelSpec(
  value: unknown,
  env: Env = process.env,
): { key: PrompterModelKey; id: string; reasoning?: ModelReasoning } {
  const key = resolveModelKey(value);
  const entry = MODEL_CATALOG[key];
  const id = env[entry.envName]?.trim() || entry.id;
  return entry.reasoning === undefined ? { key, id } : { key, id, reasoning: entry.reasoning };
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
    /** モデルキー（resolveModelKey で丸める）。未指定は既定モデル。 */
    model?: unknown;
  },
): Promise<string> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const keys = logfareApiKeys(env);
  if (keys.length === 0) throw new Error("LOGFARE_API_KEY が設定されていません。");
  const spec = resolveModelSpec(options.model, env);
  const payload: Record<string, unknown> = {
    model: spec.id,
    messages,
    max_tokens: options.maxTokens,
  };
  // reasoning はモデルごとの仕様に従う（送らないモデルではキー自体を付けない）
  if (spec.reasoning !== undefined) payload.reasoning_effort = spec.reasoning;
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
  deps: { env?: Env; fetchImpl?: FetchImpl; count?: unknown; model?: unknown } = {},
): Promise<LlmQuestion[] | null> {
  const count = resolveQuestionCount(deps.count);
  const chatDeps = { env: deps.env, fetchImpl: deps.fetchImpl, model: deps.model };
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
  deps: { env?: Env; fetchImpl?: FetchImpl; model?: unknown } = {},
): Promise<LlmQuestion[] | null> {
  const asked = answers.map((a) => a.question);
  const first = await logfareChat(buildFollowupMessages(rough, answers), { maxTokens: 700, ...deps });
  const parsed = parseFollowupQuestionsJson(first, asked);
  if (parsed) return parsed;
  const second = await logfareChat(buildFollowupRetryMessages(rough, answers), { maxTokens: 700, ...deps });
  return parseFollowupQuestionsJson(second, asked);
}

/**
 * 完成プロンプトを LLM で合成する。整形できなければ null。
 * 合成は「下書き生成 → 自己検証 → 問題があれば1回だけ直し」の順に行い、
 * 検証して直してから出す。検証・直しの呼び出しが失敗したり応答の形式が
 * 崩れたりした場合は下書きをそのまま返す（この段の失敗では落とさない）。
 * 下書き生成自体の失敗（例外・整形不可）は従来どおり呼び出し側に委ねる。
 */
export async function synthesizeWithLlm(
  rough: string,
  answers: LlmAnswer[],
  deps: { env?: Env; fetchImpl?: FetchImpl; lang?: unknown; model?: unknown } = {},
): Promise<string | null> {
  // 出力言語モード（不正値は hybrid に丸める）。検証・直しも同じモードで通す。
  const lang = resolvePromptLang(deps.lang);
  const chatDeps = { env: deps.env, fetchImpl: deps.fetchImpl, model: deps.model };
  const raw = await logfareChat(buildSynthesizeMessages(rough, answers, lang), { maxTokens: 1800, ...chatDeps });
  const draft = cleanSynthesizedPrompt(raw);
  if (!draft) return null;

  const verifyDeps = { env: deps.env, fetchImpl: deps.fetchImpl, timeoutMs: VERIFY_TIMEOUT_MS, model: deps.model };
  let issues: string[] | null;
  try {
    const verifyRaw = await logfareChat(buildVerifyMessages(rough, answers, draft, lang), { maxTokens: 800, ...verifyDeps });
    issues = parseVerificationJson(verifyRaw);
  } catch {
    // 検証の呼び出しに失敗したら、下書きをそのまま出す
    return draft;
  }
  if (!issues || issues.length === 0) return draft;

  try {
    const refinedRaw = await logfareChat(buildRefineMessages(rough, answers, draft, issues, lang), {
      maxTokens: 2400,
      ...verifyDeps,
    });
    return cleanSynthesizedPrompt(refinedRaw) ?? draft;
  } catch {
    // 直しの呼び出しに失敗したら、下書きをそのまま出す
    return draft;
  }
}

/**
 * 完成プロンプトを修正指示どおりに LLM で書き直す。整形できなければ null。
 * lang 指定時はその出力言語モードで、未指定なら現在のプロンプトの言語に合わせて書き直す。
 */
export async function reviseWithLlm(
  prompt: string,
  instruction: string,
  deps: { env?: Env; fetchImpl?: FetchImpl; lang?: unknown; model?: unknown } = {},
): Promise<string | null> {
  const messages =
    deps.lang === undefined
      ? buildReviseMessages(prompt, instruction)
      : buildReviseMessages(prompt, instruction, resolvePromptLang(deps.lang));
  const raw = await logfareChat(messages, { maxTokens: 2400, env: deps.env, fetchImpl: deps.fetchImpl, model: deps.model });
  return cleanSynthesizedPrompt(raw);
}
