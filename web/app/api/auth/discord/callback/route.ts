import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = request.headers.get("cookie")?.match(/(?:^|;\s*)ago_discord_oauth_state=([^;]+)/)?.[1];
  const error = url.searchParams.get("error");
  if (error || !code || !state || !expectedState || state !== expectedState) return NextResponse.redirect(new URL("/login?error=discord_denied", request.url));

  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  const redirectUri = process.env.DISCORD_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return NextResponse.redirect(new URL("/login?error=discord_not_configured", request.url));

  try {
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    });
    if (!tokenResponse.ok) throw new Error("token exchange failed");
    const token = await tokenResponse.json() as { access_token?: string };
    if (!token.access_token) throw new Error("missing access token");
    const userResponse = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!userResponse.ok) throw new Error("user lookup failed");
    const user = await userResponse.json() as { id?: string; username?: string };
    if (!user.id) throw new Error("missing Discord user id");
    const response = NextResponse.redirect(new URL("/coder?login=success", request.url));
    response.cookies.set("ago_discord_user", JSON.stringify({ id: user.id, username: user.username || "Discord user" }), { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7 });
    response.cookies.set("ago_discord_oauth_state", "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
    return response;
  } catch {
    return NextResponse.redirect(new URL("/login?error=discord_callback_failed", request.url));
  }
}
