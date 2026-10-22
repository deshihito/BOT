import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { OAUTH_STATE_COOKIE, isDiscordConfigured, stateCookieOptions } from "@/lib/auth";

export const runtime = "nodejs";

export function GET(request: Request) {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const redirectUri = process.env.DISCORD_REDIRECT_URI;
  if (!clientId || !redirectUri || !isDiscordConfigured()) {
    return NextResponse.redirect(new URL("/login?error=discord_not_configured", request.url));
  }

  const state = crypto.randomBytes(24).toString("hex");
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify");
  url.searchParams.set("state", state);

  const response = NextResponse.redirect(url);
  response.cookies.set(OAUTH_STATE_COOKIE, state, stateCookieOptions(request));
  return response;
}
