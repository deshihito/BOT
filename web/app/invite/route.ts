import { NextResponse } from "next/server";
import { isBotApiConfigured, kvGet, kvSet } from "@/lib/bot-api";
import { BOT_INVITE_URL, INVITE_CLICKS_NAMESPACE, normalizeInviteSource } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 流入元別の招待中継（F5a）: src を記録してから正の招待リンクへ 302 で送る。
 * 記録するのは日時と src だけ（IP 等の個人情報は取らない）。
 * 記録に失敗しても遷移は止めない。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const src = normalizeInviteSource(url.searchParams.get("src"));

  if (isBotApiConfigured()) {
    try {
      const current = await kvGet(INVITE_CLICKS_NAMESPACE, src);
      const record =
        typeof current === "object" && current !== null
          ? (current as Record<string, unknown>)
          : {};
      const count = typeof record.count === "number" && Number.isFinite(record.count) ? record.count : 0;
      await kvSet(INVITE_CLICKS_NAMESPACE, src, {
        src,
        count: count + 1,
        last_clicked_at: new Date().toISOString(),
      });
    } catch {
      // 計測はベストエフォート（招待導線を止めない）
    }
  }

  return NextResponse.redirect(BOT_INVITE_URL, 302);
}
