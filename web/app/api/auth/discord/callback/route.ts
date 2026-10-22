import { NextResponse } from "next/server";
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  createSession,
  isDiscordConfigured,
  readCookie,
  sessionCookieOptions,
  stateCookieOptions,
} from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = readCookie(request, OAUTH_STATE_COOKIE);
  const error = url.searchParams.get("error");

  if (error || !code || !state || !expectedState || state !== expectedState) {
    return NextResponse.redirect(new URL("/login?error=discord_denied", request.url));
  }

  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  const redirectUri = process.env.DISCORD_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri || !isDiscordConfigured()) {
    return NextResponse.redirect(new URL("/login?error=discord_not_configured", request.url));
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

    const user = await userResponse.json() as { id?: string; username?: string; global_name?: string };
    if (!user.id) throw new Error("missing Discord user id");

    const response = NextResponse.redirect(new URL("/dashboard", request.url));
    response.cookies.set(
      SESSION_COOKIE,
      createSession({ id: user.id, username: user.global_name || user.username || "Discord" }),
      sessionCookieOptions(request),
    );
    response.cookies.set(OAUTH_STATE_COOKIE, "", stateCookieOptions(request, 0));
    return response;
  } catch {
    return NextResponse.redirect(new URL("/login?error=discord_callback_failed", request.url));
  }
}
