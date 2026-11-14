// viewslopper のサーバー側処理（URL取得とLLM診断の呼び出し）。
// LLM 呼び出し自体は One Prompter の Logfare クライアント（one-prompter-server の
// logfareChat）をそのまま使う: キー管理・429フェイルオーバー・モデル（ds1017固定）は
// サービス間で共通の流儀に寄せる。ここが持つのは「URLを安全に取りに行く」部分だけ。

import { lookup } from "node:dns/promises";
import {
  APPEARANCE_PROMPT,
  buildAssessMessages,
  composeAppearance,
  composeAssessed,
  emptyUxSignals,
  extractPage,
  isPrivateIpLiteral,
  needsRenderFallback,
  parseAssessJson,
  validateViewUrl,
  buildDiagnosisMessages,
  buildRuleDiagnosis,
  parseDiagnosisJson,
  type AppearanceResult,
  type DiagnosisItem,
  type PageData,
  type ViewScore,
} from "./viewslopper";
import { logfareApiKeys, logfareChat } from "./one-prompter-server";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = "viewslopper/0.1 (+https://viewslopper.agobot.app)";

export class ViewFetchError extends Error {}

/** 名前解決の結果にプライベート宛先が混ざっていないか確認する（SSRF対策）。 */
async function assertPublicHost(hostname: string): Promise<void> {
  if (isPrivateIpLiteral(hostname)) throw new ViewFetchError("そのURLは診断できません。");
  let records: { address: string }[];
  try {
    records = await lookup(hostname, { all: true });
  } catch {
    throw new ViewFetchError("URL先に接続できませんでした。");
  }
  if (records.length === 0 || records.some((r) => isPrivateIpLiteral(r.address))) {
    throw new ViewFetchError("そのURLは診断できません。");
  }
}

/**
 * URL のページを取得して PageData にする。リダイレクトは最大3回まで、
 * 飛び先も含めて毎回検証（validateViewUrl＋名前解決チェック）を通す。
 * サイズ上限・タイムアウト・対応Content-Type（HTML/プレーンテキスト）もここで守る。
 */
export async function fetchPage(rawUrl: string): Promise<PageData> {
  let current = validateViewUrl(rawUrl);
  if (!current) throw new ViewFetchError("URLを確認してください。");
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = new URL(current);
    await assertPublicHost(url.hostname);
    const response = await fetch(current, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,text/plain" },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).catch(() => {
      throw new ViewFetchError("URL先に接続できませんでした。");
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || hop === MAX_REDIRECTS) throw new ViewFetchError("リダイレクトが多すぎます。");
      const next = validateViewUrl(new URL(location, current).toString());
      if (!next) throw new ViewFetchError("そのURLは診断できません。");
      current = next;
      continue;
    }
    if (!response.ok) throw new ViewFetchError(`ページを取得できませんでした（${response.status}）。`);
    const contentType = response.headers.get("content-type") ?? "";
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > MAX_RESPONSE_BYTES) throw new ViewFetchError("ページが大きすぎます。");
    const bodyText = buf.toString("utf8");
    if (contentType.includes("text/plain")) {
      return { url: current, title: "", description: "", headings: [], text: bodyText.slice(0, 20000), ux: emptyUxSignals() };
    }
    if (!contentType.includes("html")) throw new ViewFetchError("HTMLページだけが診断対象です。");
    const page = extractPage(bodyText, current);
    // SPA の殻しか取れていない場合は、描画経由で本文を取り直す。
    // 直接取得の UX シグナル（元の HTML 構造から数えたもの）はそのまま使う。
    if (needsRenderFallback(bodyText, page.text.length)) {
      const rendered = await fetchRendered(current).catch(() => null);
      if (rendered && rendered.text.length > page.text.length) {
        return { ...page, title: page.title || rendered.title, headings: rendered.headings, text: rendered.text, rendered: true };
      }
    }
    return page;
  }
  throw new ViewFetchError("ページを取得できませんでした。");
}

const RENDER_TIMEOUT_MS = 20_000;

/**
 * JavaScript 描画後のテキストを外部リーダー（r.jina.ai）経由で取る。
 * 自前でヘッドレスブラウザを持たないための割り切りで、失敗したら null
 * （呼び出し側は直接取得の結果で続行する）。返すのは本文テキストと
 * Markdown 見出しから拾ったタイトル・見出しだけ。
 */
async function fetchRendered(url: string): Promise<{ title: string; headings: string[]; text: string } | null> {
  const response = await fetch(`https://r.jina.ai/${url}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/plain" },
    signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length > MAX_RESPONSE_BYTES) return null;
  let text = buf.toString("utf8");
  const marker = text.indexOf("Markdown Content:");
  if (marker !== -1) text = text.slice(marker + "Markdown Content:".length);
  text = text.trim();
  if (!text) return null;
  const titleLine = text.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
  const headings = [...text.matchAll(/^#{1,2}\s+(.+)$/gm)].map((m) => m[1].trim().slice(0, 120)).slice(0, 30);
  return { title: titleLine, headings, text: text.slice(0, 20000) };
}

/**
 * LLM 主採点。判断（次元・UX軸のスコアと根拠）は LLM が行い、合計の集計は
 * composeAssessed が決定的に行う。キーが無い・応答が不正・失敗した場合は
 * null を返し、呼び出し側が従来の決定的採点＋診断にフォールバックする。
 */
export async function assess(page: PageData, heuristic: ViewScore): Promise<ReturnType<typeof composeAssessed> | null> {
  if (logfareApiKeys().length === 0) return null;
  try {
    const raw = await logfareChat(buildAssessMessages(page, heuristic, page.ux), { maxTokens: 2200 });
    const parsed = parseAssessJson(raw);
    if (!parsed) return null;
    return composeAssessed(parsed, heuristic);
  } catch (error) {
    console.error("viewslopper: assess failed", error instanceof Error ? error.message : "unknown error");
    return null;
  }
}

/**
 * 描画後のスクリーンショットを r.jina.ai から取る。本文の描画取得と同じ提供元で、
 * 見出しテキストではなく画像そのものを返す経路。失敗したら null。
 * screenshotUrl は署名付きで数時間で失効する（結果画面での即時表示用）。
 */
async function fetchScreenshot(url: string): Promise<{ dataUrl: string; screenshotUrl: string } | null> {
  const response = await fetch(`https://r.jina.ai/${url}`, {
    headers: { "User-Agent": USER_AGENT, "x-respond-with": "screenshot" },
    signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length === 0 || buf.length > 6_000_000) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) return null;
  return {
    dataUrl: `data:${contentType.split(";")[0]};base64,${buf.toString("base64")}`,
    screenshotUrl: response.url,
  };
}

// 外観採点の vision モデル優先順。LLL の鑑定と同じく、Logfare の公開カタログで
// 画像入力（chat_vision:true）が実測確認できたモデルだけを並べる。
// 既定の ds1017 はテキスト専用なのでここでは使わない。
const APPEARANCE_MODEL_CHAIN: string[] = ["gemma-4-26b", "gemma-4-31b-it", "qwen-3.8-27b"];

function logfareBaseUrl(): string {
  return (process.env.LOGFARE_BASE_URL?.trim() || "https://logfare.ai/v1").replace(/\/+$/, "");
}

async function visionChat(dataUrl: string, prompt: string): Promise<string | null> {
  const keys = logfareApiKeys();
  if (keys.length === 0) return null;
  const override = process.env.VIEWSLOPPER_VISION_MODEL?.trim();
  const models = [...new Set([...(override ? [override] : []), ...APPEARANCE_MODEL_CHAIN])];
  for (const model of models) {
    const payload = {
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: 900,
    };
    for (const key of keys) {
      let response: Response;
      try {
        response = await fetch(`${logfareBaseUrl()}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(45_000),
        });
      } catch {
        break; // 通信失敗はモデルを変えても同じなので次のモデルへ
      }
      if (response.status === 429) continue; // キー切替は 429 のときだけ（LLL と同じ）
      if (!response.ok) break;
      const data = (await response.json().catch(() => null)) as {
        choices?: { message?: { content?: unknown } }[];
      } | null;
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content === "string" && content.trim()) return content;
      break;
    }
  }
  return null;
}

export type AppearanceOutcome = { result: AppearanceResult; screenshotUrl: string } | null;

/**
 * 外観採点: スクリーンショット取得 → vision モデルが4軸を採点 → コードが集計。
 * 取得や採点ができなければ null（画面では外観セクションを出さない）。
 */
export async function assessAppearance(page: PageData): Promise<AppearanceOutcome> {
  if (logfareApiKeys().length === 0) return null;
  try {
    const shot = await fetchScreenshot(page.url);
    if (!shot) return null;
    const raw = await visionChat(shot.dataUrl, APPEARANCE_PROMPT);
    if (!raw) return null;
    const result = composeAppearance(raw);
    if (!result) return null;
    return { result, screenshotUrl: shot.screenshotUrl };
  } catch (error) {
    console.error("viewslopper: appearance failed", error instanceof Error ? error.message : "unknown error");
    return null;
  }
}

/**
 * LLM（ds1017）で診断文を作る。キーがない・失敗・形式崩れのときは
 * ルールベース診断に落とす（スコアはどちらでも同じ決定的計算のもの）。
 * LLM 主採点（assess）が成功した場合はこちらは使わない。
 */
export async function diagnose(page: PageData, score: ViewScore): Promise<{ items: DiagnosisItem[]; llm: boolean }> {
  if (logfareApiKeys().length === 0) return { items: buildRuleDiagnosis(score), llm: false };
  try {
    const raw = await logfareChat(buildDiagnosisMessages(page, score), { maxTokens: 1200 });
    const items = parseDiagnosisJson(raw);
    if (items) return { items, llm: true };
  } catch (error) {
    console.error("viewslopper: Logfare call failed", error instanceof Error ? error.message : "unknown error");
  }
  return { items: buildRuleDiagnosis(score), llm: false };
}
