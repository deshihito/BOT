import { NextRequest, NextResponse } from "next/server";
import { onePrompterRedirectUrl } from "@/lib/subdomain";

export function middleware(request: NextRequest) {
  const { nextUrl } = request;
  // One Prompter 専用サブドメイン: ルートは /one-prompter へ飛ばす。
  // rewrite だと Tunnel 配下で外部プロキシ扱いになり 500 になるため redirect
  // （経緯は lib/subdomain.ts の冒頭コメント参照）。
  const prompterUrl = onePrompterRedirectUrl({
    pathname: nextUrl.pathname,
    // Cloudflare Tunnel 経由では元のホストが X-Forwarded-Host に入る（api/coder/run と同じ見方）
    forwardedHost: request.headers.get("x-forwarded-host"),
    hostname: nextUrl.hostname,
    search: nextUrl.search,
  });
  if (prompterUrl) {
    return NextResponse.redirect(prompterUrl);
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
