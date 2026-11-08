// fastHTML（一時HTML埋め込み）の配信ヘルパー（サーバー専用）。
// サーバー側は HTML 実体を一切保存しない。Bot が Discord CDN の添付 URL を
// BOT_API_KEY で HMAC 署名したトークン（60分）に包み、このモジュールは
// 署名を検証して CDN からそのまま中継するだけ。HTML の中身は
// 検査・変換・レンダリングを一切しない。隔離は
// fastHtmlContentHeaders の sandbox で行う。

import { createHmac, timingSafeEqual } from "node:crypto";

// fastHTML 専用ホスト。このホストではユーザー HTML 以外を配信しないため、
// allow-same-origin を付けても agobot.app 本体のセッションには触れられない。
export const FAST_HTML_DEDICATED_HOST = "fast.agobot.app";

const FAST_HTML_SANDBOX_BASE =
  "sandbox allow-scripts allow-modals allow-popups allow-forms allow-downloads";

// ユーザー HTML を配信するときの必須ヘッダ。
// agobot.app 本体ホストでは allow-same-origin / allow-top-navigation を含めず、
// opaque origin として扱うことで、ダッシュボードの Cookie / セッションへ
// 触れられないようにする。専用ホスト（fast.agobot.app）でのみ
// allow-same-origin を追加し、localStorage 等をそのオリジン専用に
// 使えるようにする（保存先は専用ホストのオリジンに閉じ、本体とは混ざらない）。
export function fastHtmlContentHeaders(host?: string | null): Record<string, string> {
  const normalized = (host ?? "").split(":")[0].trim().toLowerCase();
  const csp =
    normalized === FAST_HTML_DEDICATED_HOST
      ? `${FAST_HTML_SANDBOX_BASE} allow-same-origin`
      : FAST_HTML_SANDBOX_BASE;
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
  };
}

// 失効ページ（ユーザーの HTML ではない、こちらで用意した固定ページ）。
export function fastHtmlGoneHtml(status: number): string {
  const title =
    status === 410
      ? "このページは期限切れです"
      : status === 413
        ? "ファイルが大きすぎます"
        : "ページが見つかりません";
  const body =
    status === 410
      ? "fastHTML の有効期限（60分）が切れたか、アップロードした人が削除しました。"
      : status === 413
        ? "fastHTML で扱える上限（5MB）を超えているため、表示できません。"
        : "fastHTML のリンクが正しくないか、既に削除されています。";
  return [
    "<!doctype html>",
    '<html lang="ja"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>${title} | AGOBOT</title></head>`,
    `<body style="font-family:sans-serif;background:#fff;color:#111;display:grid;place-items:center;min-height:100vh;margin:0">`,
    `<main style="text-align:center;padding:24px"><h1 style="font-size:20px">${title}</h1>`,
    `<p style="color:#555">${body}</p></main></body></html>`,
  ].join("");
}

export type FastHtmlFetchResult =
  | { status: 200; body: ArrayBuffer }
  | { status: 404 | 410 | 413 | 503 };

const FAST_HTML_MAX_BYTES = 5 * 1024 * 1024;
const FAST_HTML_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

// トークン v1.<base64url(payload JSON)>.<base64url(HMAC-SHA256)> を検証し、
// CDN URL と有効期限を取り出す。署名は "v1.<base64url(payload)>" に対して
// BOT_API_KEY で計算され、定数時間で比較する。不正なら null。
function verifyFastHtmlToken(
  token: string,
  apiKey: string,
): { url: string; exp: number } | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const expected = createHmac("sha256", apiKey)
    .update(`v1.${parts[1]}`, "utf8")
    .digest();
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const { u, exp } = payload as { u?: unknown; exp?: unknown };
  if (typeof u !== "string" || typeof exp !== "number" || !Number.isFinite(exp)) {
    return null;
  }
  return { url: u, exp };
}

// 中継先は Discord CDN の添付パスだけに限る（署名が正しくても、
// Bot が包んだもの以外へは飛ばさないための多層防御）。
function isAllowedFastHtmlCdnUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    FAST_HTML_CDN_HOSTS.has(url.hostname) &&
    url.pathname.startsWith("/attachments/")
  );
}

// 5MB を超えたら中断して null（413）。Content-Length が申告されていれば
// 読む前に弾き、無ければ読みながら数える。
async function readBodyCapped(res: Response): Promise<ArrayBuffer | null> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > FAST_HTML_MAX_BYTES) return null;
  if (!res.body) {
    const buf = await res.arrayBuffer();
    return buf.byteLength > FAST_HTML_MAX_BYTES ? null : buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > FAST_HTML_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer as ArrayBuffer;
}

// 署名付きトークンを検証し、Discord CDN から HTML を中継する（サーバー側のみ）。
// fetchImpl はテスト差し替え用。
export async function fetchFastHtml(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FastHtmlFetchResult> {
  const apiKey = process.env.BOT_API_KEY;
  if (!apiKey) return { status: 503 };
  const verified = verifyFastHtmlToken(token, apiKey);
  if (!verified) return { status: 404 };
  if (verified.exp <= Math.floor(Date.now() / 1000)) return { status: 410 };
  if (!isAllowedFastHtmlCdnUrl(verified.url)) return { status: 404 };
  let res: Response;
  try {
    res = await fetchImpl(verified.url, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { status: 503 };
  }
  // 元の投稿が削除されるなどして CDN 実体が無ければ失効として扱う。
  if (res.status === 404 || res.status === 403) return { status: 410 };
  if (!res.ok) return { status: 410 };
  const body = await readBodyCapped(res);
  if (body === null) return { status: 413 };
  return { status: 200, body };
}
