import { NextResponse } from "next/server";
import { exchangeDiscordActivityCode } from "@/lib/activity-auth";
import { buildDiscordIdentity } from "@/lib/discord-activity";

export const runtime = "nodejs";

// ゲーム用 Activity 認証。ギルド/チャンネルに紐づくトークンは発行せず、
// DM やグループ DM の起動でも使えるよう、コード交換と本人確認
// （identify）だけを行う。
// 返す identity はオンライン対戦の表示名/アバターの既定値に使う。
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export async function POST(request: Request) {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
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
  const { code, codeVerifier } = body as Record<string, unknown>;
  if (
    typeof code !== "string" || code.length < 1 || code.length > 4096 ||
    typeof codeVerifier !== "string" || !PKCE_VERIFIER.test(codeVerifier)
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  try {
    const { accessToken, user } = await exchangeDiscordActivityCode({ clientId, clientSecret, code, codeVerifier });
    const identity = buildDiscordIdentity(user);
    if (!identity) {
      return NextResponse.json({ error: "authorization_failed" }, { status: 401, headers: NO_STORE });
    }
    return NextResponse.json({ accessToken, user: identity }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "authorization_unavailable" }, { status: 502, headers: NO_STORE });
  }
}
