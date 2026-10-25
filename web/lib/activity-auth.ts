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
