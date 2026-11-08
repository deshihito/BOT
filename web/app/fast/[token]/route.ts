import { fastHtmlContentHeaders, fastHtmlGoneHtml, fetchFastHtml } from "@/lib/fast-html";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// fastHTML: Bot 経由でアップロードされた HTML を一時 URL でそのまま配信する。
// 中身には一切手を入れない（変換・サニタイズ・サーバー側レンダリングなし）。
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const result = await fetchFastHtml(token);
  if (result.status === 200) {
    return new Response(result.body, { status: 200, headers: fastHtmlContentHeaders() });
  }
  const status = result.status === 410 ? 410 : result.status === 404 ? 404 : 503;
  return new Response(fastHtmlGoneHtml(status), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
