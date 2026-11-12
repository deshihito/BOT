import crypto from "node:crypto";
import { NextResponse } from "next/server";
import {
  GOOGLE_STATE_COOKIE,
  OAUTH_NEXT_COOKIE,
  canonicalAuthorizeRedirect,
  isGoogleConfigured,
  publicOrigin,
  resolveOAuthNext,
  stateCookieOptions,
} from "@/lib/auth";

export const runtime = "nodejs";

export function GET(request: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !redirectUri || !isGoogleConfigured()) {
    return NextResponse.redirect(new URL("/login?error=google_not_configured", publicOrigin(request)));
  }

  // 別ホスト（専用サブドメイン等）から始まった場合は正規ホストへ寄せる（Discord と同じ理由）。
  const canonical = canonicalAuthorizeRedirect(request, "/api/auth/google/authorize", redirectUri);
  if (canonical) return NextResponse.redirect(canonical);

  // ログイン後に戻る先（同一サイト内のパスだけ許可）。未指定は One Prompter へ。
  const next = resolveOAuthNext(new URL(request.url).searchParams.get("next"), "/one-prompter");

  const state = crypto.randomBytes(24).toString("hex");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  // 取得するのは識別子・名前・アイコン程度の最小スコープに絞る
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("state", state);

  const response = NextResponse.redirect(url);
  response.cookies.set(GOOGLE_STATE_COOKIE, state, stateCookieOptions(request));
  response.cookies.set(OAUTH_NEXT_COOKIE, next, stateCookieOptions(request));
  return response;
}
