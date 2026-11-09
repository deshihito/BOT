import { NextRequest, NextResponse } from "next/server";

// One Prompter 専用サブドメイン: ルートは /one-prompter をそのまま表示する
const ONE_PROMPTER_HOST = "oneprompter.agobot.app";

export function middleware(request: NextRequest) {
  const { nextUrl } = request;
  // Cloudflare Tunnel 経由では元のホストが X-Forwarded-Host に入る（api/coder/run と同じ見方）
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || nextUrl.hostname;
  if (nextUrl.pathname === "/" && host === ONE_PROMPTER_HOST) {
    const prompterUrl = nextUrl.clone();
    prompterUrl.pathname = "/one-prompter";
    return NextResponse.rewrite(prompterUrl);
  }
  if (
    nextUrl.pathname === "/" &&
    nextUrl.searchParams.has("frame_id") &&
    nextUrl.searchParams.has("instance_id")
  ) {
    const activityUrl = nextUrl.clone();
    activityUrl.pathname = "/activity/music";
    return NextResponse.redirect(activityUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/"],
};
