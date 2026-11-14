import { NextRequest, NextResponse } from "next/server";
import { subdomainRedirectUrl } from "@/lib/subdomain";
import { activityLandingPath } from "@/lib/discord-activity";

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
  // Activity 起動の着地はゲーム（/games）。activity=music が明示された
  // 起動だけ従来どおり音楽ページへ送る（振り分け規則は lib/discord-activity）。
  const landing = activityLandingPath({
    frameId: nextUrl.searchParams.get("frame_id"),
    instanceId: nextUrl.searchParams.get("instance_id"),
    activity: nextUrl.searchParams.get("activity"),
  });
  if (nextUrl.pathname === "/" && landing) {
    const activityUrl = nextUrl.clone();
    activityUrl.pathname = landing;
    return NextResponse.redirect(activityUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/"],
};
