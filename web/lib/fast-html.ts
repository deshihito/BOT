// fastHTML（一時HTML埋め込み）の配信ヘルパー（サーバー専用）。
// Bot 自前 API（/v1/fast/<token>）から生バイトを取得し、そのまま返す。
// HTML の中身は検査・変換・レンダリングを一切しない。隔離は
// fastHtmlContentHeaders の sandbox（allow-same-origin を付けない）で行う。

export const FAST_HTML_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

// ユーザー HTML を配信するときの必須ヘッダ。
// sandbox に allow-same-origin / allow-top-navigation を含めないことで、
// agobot.app と同一オリジンでも opaque origin として扱われ、
// ダッシュボードの Cookie / セッションへは触れられない。
export function fastHtmlContentHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy":
      "sandbox allow-scripts allow-modals allow-popups allow-forms allow-downloads",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
  };
}

// 失効ページ（ユーザーの HTML ではない、こちらで用意した固定ページ）。
export function fastHtmlGoneHtml(status: number): string {
  const title = status === 410 ? "このページは期限切れです" : "ページが見つかりません";
  const body =
    status === 410
      ? "fastHTML の有効期限（60分）が切れたか、アップロードした人が削除しました。"
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
  | { status: 404 | 410 | 503 };

// Bot 自前 API から fastHTML の生バイトを取得する（サーバー側のみ）。
// fetchImpl はテスト差し替え用。
export async function fetchFastHtml(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FastHtmlFetchResult> {
  if (!FAST_HTML_TOKEN.test(token)) return { status: 404 };
  const baseUrl = process.env.BOT_API_BASE_URL?.replace(/\/$/, "");
  const apiKey = process.env.BOT_API_KEY;
  if (!baseUrl || !apiKey) return { status: 503 };
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/v1/fast/${token}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/octet-stream" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { status: 503 };
  }
  if (res.status === 200) {
    return { status: 200, body: await res.arrayBuffer() };
  }
  if (res.status === 410) return { status: 410 };
  if (res.status === 404) return { status: 404 };
  return { status: 503 };
}
