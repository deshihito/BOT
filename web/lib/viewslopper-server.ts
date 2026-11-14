// viewslopper のサーバー側処理（URL取得とLLM診断の呼び出し）。
// LLM 呼び出し自体は One Prompter の Logfare クライアント（one-prompter-server の
// logfareChat）をそのまま使う: キー管理・429フェイルオーバー・モデル（ds1017固定）は
// サービス間で共通の流儀に寄せる。ここが持つのは「URLを安全に取りに行く」部分だけ。

import { lookup } from "node:dns/promises";
import {
  buildAssessMessages,
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
