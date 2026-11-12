import { NextResponse } from "next/server";
import {
  OAUTH_NEXT_COOKIE,
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  createSession,
  isDiscordConfigured,
  publicOrigin,
  readCookie,
  resolveOAuthNext,
  sessionCookieOptions,
  stateCookieOptions,
} from "@/lib/auth";
import { createWebSession } from "@/lib/dashboard";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = readCookie(request, OAUTH_STATE_COOKIE);
  const error = url.searchParams.get("error");
  // 認可開始時に保存した戻り先（同一サイト内のパスだけが入り得る）。未保存は従来どおり /dashboard。
  const next = resolveOAuthNext(readCookie(request, OAUTH_NEXT_COOKIE));
  // ダッシュボード経由の失敗は従来どおり /login のエラー表示へ、それ以外（One Prompter 等）は
  // 戻り先へそのまま返す（別サービス画面から AGO のログイン画面へ飛ばさない）。
  const fail = (codeName: string) => {
    const target = next === "/dashboard" ? `/login?error=${codeName}` : next;
    const response = NextResponse.redirect(new URL(target, publicOrigin(request)));
    response.cookies.set(OAUTH_NEXT_COOKIE, "", stateCookieOptions(request, 0));
    return response;
  };

  if (error || !code || !state || !expectedState || state !== expectedState) {
    return fail("discord_denied");
  }

  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  const redirectUri = process.env.DISCORD_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri || !isDiscordConfigured()) {
    return fail("discord_not_configured");
  }

  try {
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
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

    const userResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!userResponse.ok) throw new Error("user lookup failed");

    const user = await userResponse.json() as { id?: string; username?: string; global_name?: string; avatar?: string | null };
    if (!user.id) throw new Error("missing Discord user id");

    // avatar は identify スコープの範囲で取れる（追加の許可は不要）
    const sessionUser = {
      id: user.id,
      username: user.global_name || user.username || "Discord",
      avatar: typeof user.avatar === "string" && user.avatar ? user.avatar : null,
      provider: "discord" as const,
    };
    // ダッシュボード用にサーバー側セッションレコードを作る（失敗しても通常ログインは成立させる）
    const sid = await createWebSession(sessionUser, token.access_token);

    const response = NextResponse.redirect(new URL(next, publicOrigin(request)));
    response.cookies.set(
      SESSION_COOKIE,
      createSession(sessionUser, sid ?? undefined),
      sessionCookieOptions(request),
    );
    response.cookies.set(OAUTH_STATE_COOKIE, "", stateCookieOptions(request, 0));
    response.cookies.set(OAUTH_NEXT_COOKIE, "", stateCookieOptions(request, 0));
    return response;
  } catch {
    return fail("discord_callback_failed");
  }
}
