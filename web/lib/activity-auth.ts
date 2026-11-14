import crypto from "node:crypto";

const ACTIVITY_TOKEN_TTL_MS = 30 * 60 * 1000;

type ActivityClaims = {
  userId: string;
  guildId: string;
  channelId: string;
  issuedAt: number;
  expiresAt: number;
};

function signingSecret() {
  return process.env.DISCORD_SESSION_SECRET || process.env.DISCORD_CLIENT_SECRET || "";
}

function sign(value: string) {
  const secret = signingSecret();
  return secret ? crypto.createHmac("sha256", secret).update(value).digest("base64url") : "";
}

function safelyEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,30}$/.test(value);
}

export function activitySigningConfigured() {
  return Boolean(signingSecret());
}

export function createActivityToken(userId: string, guildId: string, channelId: string) {
  if (!activitySigningConfigured()) throw new Error("Activity signing is not configured");
  if (![userId, guildId, channelId].every(isSnowflake)) throw new Error("Invalid Activity identity");
  const issuedAt = Date.now();
  const payload: ActivityClaims = {
    userId,
    guildId,
    channelId,
    issuedAt,
    expiresAt: issuedAt + ACTIVITY_TOKEN_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { token: `${encoded}.${sign(encoded)}`, expiresAt: payload.expiresAt };
}

export type DiscordOAuthUser = {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
};

/**
 * Activity の OAuth コード交換（PKCE）＋ /users/@me 取得。
 * ゲーム側（games-auth ルート）が使う。音楽側ルートは Activity トークンの
 * 発行まで含むため従来実装のままで、こちらは「本人確認まで」に閉じる。
 * 失敗は Error を投げる（呼び出し側で HTTP 応答に変換する）。
 */
export async function exchangeDiscordActivityCode(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
}): Promise<{ accessToken: string; user: DiscordOAuthUser }> {
  const form = new URLSearchParams([
    ["client_id", args.clientId],
    ["client_secret", args.clientSecret],
    ["grant_type", "authorization_code"],
    ["code", args.code],
    ["code_verifier", args.codeVerifier],
  ]);
  const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!tokenResponse.ok) throw new Error("authorization_failed");
  const tokenData = (await tokenResponse.json()) as { access_token?: unknown };
  if (typeof tokenData.access_token !== "string" || !tokenData.access_token) {
    throw new Error("authorization_failed");
  }

  const userResponse = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!userResponse.ok) throw new Error("authorization_failed");
  const user = (await userResponse.json()) as Partial<DiscordOAuthUser>;
  if (!isSnowflake(user.id) || typeof user.username !== "string") {
    throw new Error("authorization_failed");
  }
  return {
    accessToken: tokenData.access_token,
    user: {
      id: user.id,
      username: user.username,
      global_name: typeof user.global_name === "string" ? user.global_name : null,
      avatar: typeof user.avatar === "string" ? user.avatar : null,
    },
  };
}

export function readActivityToken(value?: string): ActivityClaims | null {
  if (!signingSecret()) return null;
  if (!value || value.length > 2048) return null;
  const [encoded, signature, ...rest] = value.split(".");
  if (!encoded || !signature || rest.length > 0 || !safelyEqual(signature, sign(encoded))) return null;

  try {
    const claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<ActivityClaims>;
    const now = Date.now();
    if (!isSnowflake(claims.userId) || !isSnowflake(claims.guildId) || !isSnowflake(claims.channelId)) return null;
    if (typeof claims.issuedAt !== "number" || typeof claims.expiresAt !== "number") return null;
    if (claims.issuedAt > now + 30_000 || claims.expiresAt <= now) return null;
    if (claims.expiresAt - claims.issuedAt > ACTIVITY_TOKEN_TTL_MS + 1_000) return null;
    return claims as ActivityClaims;
  } catch {
    return null;
  }
}
