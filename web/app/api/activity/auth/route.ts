import { NextResponse } from "next/server";
import { activitySigningConfigured, createActivityToken } from "@/lib/activity-auth";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const SNOWFLAKE = /^\d{1,30}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export async function POST(request: Request) {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret || !activitySigningConfigured()) {
    return NextResponse.json({ error: "activity_not_configured" }, { status: 503, headers: NO_STORE });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  const { code, codeVerifier, guildId, channelId } = body as Record<string, unknown>;
  if (
    typeof code !== "string" || code.length < 1 || code.length > 4096 ||
    typeof codeVerifier !== "string" || !PKCE_VERIFIER.test(codeVerifier) ||
    typeof guildId !== "string" || !SNOWFLAKE.test(guildId) ||
    typeof channelId !== "string" || !SNOWFLAKE.test(channelId)
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  try {
    const form = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
    });
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!tokenResponse.ok) {
      return NextResponse.json({ error: "authorization_failed" }, { status: 401, headers: NO_STORE });
    }
    const tokenData = await tokenResponse.json() as { access_token?: unknown };
    if (typeof tokenData.access_token !== "string" || !tokenData.access_token) {
      return NextResponse.json({ error: "authorization_failed" }, { status: 401, headers: NO_STORE });
    }

    const userResponse = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!userResponse.ok) {
      return NextResponse.json({ error: "authorization_failed" }, { status: 401, headers: NO_STORE });
    }
    const user = await userResponse.json() as { id?: unknown };
    if (typeof user.id !== "string" || !SNOWFLAKE.test(user.id)) {
      return NextResponse.json({ error: "authorization_failed" }, { status: 401, headers: NO_STORE });
    }

    const activitySession = createActivityToken(user.id, guildId, channelId);
    return NextResponse.json({
      accessToken: tokenData.access_token,
      activityToken: activitySession.token,
      expiresAt: activitySession.expiresAt,
    }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "authorization_unavailable" }, { status: 502, headers: NO_STORE });
  }
}
