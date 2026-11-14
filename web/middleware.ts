import { NextRequest, NextResponse } from "next/server";
import { subdomainRedirectUrl } from "@/lib/subdomain";
import { activityLandingUrl } from "@/lib/discord-activity";

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
  // Activity 起動の着地はゲーム（/games）に一本化（振り分け規則は
  // lib/discord-activity）。リダイレクト先は公開オリジンで組み立てる:
  // リクエスト URL の複製だと Tunnel 配下で内部アドレス
  // （localhost:3000）を指してしまい、外部から到達できない。
  const landingUrl = activityLandingUrl({
    frameId: nextUrl.searchParams.get("frame_id"),
    instanceId: nextUrl.searchParams.get("instance_id"),
    search: nextUrl.search,
  });
  if (nextUrl.pathname === "/" && landingUrl) {
    return NextResponse.redirect(landingUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/"],
};
