import { NextResponse } from "next/server";
import {
  GOOGLE_STATE_COOKIE,
  OAUTH_NEXT_COOKIE,
  SESSION_COOKIE,
  createSession,
  isGoogleConfigured,
  publicOrigin,
  readCookie,
  resolveOAuthNext,
  sessionCookieOptions,
  stateCookieOptions,
} from "@/lib/auth";

export const runtime = "nodejs";

/** 着地先 URL の基点。登録済み redirect_uri（Google 側）のオリジンを正とする。 */
function googleOrigin(request: Request): string {
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (redirectUri) {
    try {
      return new URL(redirectUri).origin;
    } catch {
      // URL として不正なら共通の publicOrigin に倒す
    }
  }
  return publicOrigin(request);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = readCookie(request, GOOGLE_STATE_COOKIE);
  const error = url.searchParams.get("error");
  // 認可開始時に保存した戻り先（同一サイト内のパスだけが入り得る）。未保存は One Prompter へ。
  const next = resolveOAuthNext(readCookie(request, OAUTH_NEXT_COOKIE), "/one-prompter");
  const back = () => {
    const response = NextResponse.redirect(new URL(next, googleOrigin(request)));
    response.cookies.set(GOOGLE_STATE_COOKIE, "", stateCookieOptions(request, 0));
    response.cookies.set(OAUTH_NEXT_COOKIE, "", stateCookieOptions(request, 0));
    return response;
  };

  if (error || !code || !state || !expectedState || state !== expectedState) {
    return back();
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri || !isGoogleConfigured()) {
    return back();
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenResponse.ok) throw new Error("token exchange failed");

    const token = await tokenResponse.json() as { access_token?: string };
    if (!token.access_token) throw new Error("missing access token");

    const userResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!userResponse.ok) throw new Error("user lookup failed");

    const user = await userResponse.json() as {
      sub?: string;
      name?: string;
      email?: string;
      picture?: string | null;
    };
    // sub は数字文字列の識別子。セッション側の ID 検証（数字のみ）と揃わない形は弾く
    if (!user.sub || !/^\d+$/.test(user.sub)) throw new Error("missing Google user id");

    const sessionUser = {
      id: user.sub,
      username: user.name || user.email?.split("@")[0] || "Google",
      // Google の avatar にはプロフィール画像の完全な URL を入れる（Discord のハッシュとは形が違う）
      avatar: typeof user.picture === "string" && user.picture ? user.picture : null,
      provider: "google" as const,
    };
    // Google ログインにはダッシュボード用セッションレコード（Discord トークン前提）は作らない。
    // 署名付き Cookie のセッションだけで識別する（ダッシュボード側は sid 無しとして fail-closed に倒れる）
    const response = NextResponse.redirect(new URL(next, googleOrigin(request)));
    response.cookies.set(SESSION_COOKIE, createSession(sessionUser), sessionCookieOptions(request));
    response.cookies.set(GOOGLE_STATE_COOKIE, "", stateCookieOptions(request, 0));
    response.cookies.set(OAUTH_NEXT_COOKIE, "", stateCookieOptions(request, 0));
    return response;
  } catch {
    return back();
  }
}
