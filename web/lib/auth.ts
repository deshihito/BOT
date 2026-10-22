import crypto from "node:crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "ago_session";
export const OAUTH_STATE_COOKIE = "ago_discord_oauth_state";

const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

type SessionPayload = {
  id: string;
  username: string;
  expiresAt: number;
};

export type DiscordUser = Pick<SessionPayload, "id" | "username">;

function sessionSecret() {
  return process.env.DISCORD_SESSION_SECRET || process.env.DISCORD_CLIENT_SECRET || "";
}

function sign(value: string) {
  const secret = sessionSecret();
  if (!secret) return "";
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function safelyEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function isDiscordConfigured() {
  return Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET && process.env.DISCORD_REDIRECT_URI);
}

export function createSession(user: DiscordUser) {
  const payload: SessionPayload = {
    id: user.id,
    username: user.username.slice(0, 80),
    expiresAt: Date.now() + SESSION_MAX_AGE * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(encoded);
  if (!signature) throw new Error("session secret is not configured");
  return `${encoded}.${signature}`;
}

export function readSession(value?: string): DiscordUser | null {
  if (!value) return null;
  const [encoded, signature, ...rest] = value.split(".");
  if (!encoded || !signature || rest.length > 0 || !safelyEqual(signature, sign(encoded))) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<SessionPayload>;
    if (typeof payload.id !== "string" || !/^\d+$/.test(payload.id)) return null;
    if (typeof payload.username !== "string" || !payload.username.trim()) return null;
    if (typeof payload.expiresAt !== "number" || payload.expiresAt <= Date.now()) return null;
    return { id: payload.id, username: payload.username };
  } catch {
    return null;
  }
}

export function readCookie(request: Request, name: string) {
  const value = request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1];
  return value ? decodeURIComponent(value) : undefined;
}

export function getRequestUser(request: Request) {
  return readSession(readCookie(request, SESSION_COOKIE));
}

export async function getCurrentUser() {
  const cookieStore = await cookies();
  return readSession(cookieStore.get(SESSION_COOKIE)?.value);
}

function isSecureRequest(request: Request) {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwardedProto === "https" || new URL(request.url).protocol === "https:";
}

export function sessionCookieOptions(request: Request, maxAge = SESSION_MAX_AGE) {
  const secure = isSecureRequest(request);
  return { httpOnly: true, secure, sameSite: secure ? "none" as const : "lax" as const, path: "/", maxAge };
}

export function stateCookieOptions(request: Request, maxAge = 600) {
  return { httpOnly: true, secure: isSecureRequest(request), sameSite: "lax" as const, path: "/", maxAge };
}
