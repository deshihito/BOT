import { NextRequest, NextResponse } from "next/server";
import { subdomainRedirectUrl } from "@/lib/subdomain";

export function middleware(request: NextRequest) {
  const { nextUrl } = request;
  // 専用サブドメイン: ルートは割り当て先の公開パスへ飛ばす。
  // rewrite だと Tunnel 配下で外部プロキシ扱いになり 500 になるため redirect
  // （経緯と割り当て表は lib/subdomain.ts 参照）。
  const subdomainUrl = subdomainRedirectUrl({
    pathname: nextUrl.pathname,
    // Cloudflare Tunnel 経由では元のホストが X-Forwarded-Host に入る（api/coder/run と同じ見方）
    forwardedHost: request.headers.get("x-forwarded-host"),
    hostname: nextUrl.hostname,
    search: nextUrl.search,
  });
  if (subdomainUrl) {
    return NextResponse.redirect(subdomainUrl);
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
