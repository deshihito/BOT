import crypto from "node:crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "ago_session";
export const OAUTH_STATE_COOKIE = "ago_discord_oauth_state";

const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

type SessionPayload = {
  id: string;
  username: string;
  expiresAt: number;
  // サーバー側セッションレコード（lib/dashboard.ts）のキー。ダッシュボード用ログインでのみ付く。
  sid?: string;
};

export type DiscordUser = Pick<SessionPayload, "id" | "username">;

export type SessionInfo = DiscordUser & { sid?: string };

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

export function createSession(user: DiscordUser, sid?: string) {
  const payload: SessionPayload = {
    id: user.id,
    username: user.username.slice(0, 80),
    expiresAt: Date.now() + SESSION_MAX_AGE * 1000,
    ...(sid ? { sid } : {}),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(encoded);
  if (!signature) throw new Error("session secret is not configured");
  return `${encoded}.${signature}`;
}

export function readSession(value?: string): DiscordUser | null {
  const info = readSessionInfo(value);
  return info ? { id: info.id, username: info.username } : null;
}

export function readSessionInfo(value?: string): SessionInfo | null {
  if (!value) return null;
  const [encoded, signature, ...rest] = value.split(".");
  if (!encoded || !signature || rest.length > 0 || !safelyEqual(signature, sign(encoded))) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<SessionPayload>;
    if (typeof payload.id !== "string" || !/^\d+$/.test(payload.id)) return null;
    if (typeof payload.username !== "string" || !payload.username.trim()) return null;
    if (typeof payload.expiresAt !== "number" || payload.expiresAt <= Date.now()) return null;
    const sid = typeof payload.sid === "string" && /^[0-9a-f]{64}$/.test(payload.sid) ? payload.sid : undefined;
    return { id: payload.id, username: payload.username, ...(sid ? { sid } : {}) };
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

export async function getCurrentSession() {
  const cookieStore = await cookies();
  return readSessionInfo(cookieStore.get(SESSION_COOKIE)?.value);
}

export function getRequestSession(request: Request) {
  return readSessionInfo(readCookie(request, SESSION_COOKIE));
}

/**
 * リダイレクト先URLの基点になる公開オリジン。
 * Cloudflare Tunnel 等のプロキシ配下では request.url のホストが内部向け
 * （localhost:3000）になり、そのまま使うと利用者を localhost へ飛ばしてしまう。
 * Discord に登録した redirect_uri（=公開URL）から取得するのが確実。
 */
export function publicOrigin(request: Request): string {
  const redirectUri = process.env.DISCORD_REDIRECT_URI;
  if (redirectUri) {
    try {
      return new URL(redirectUri).origin;
    } catch {
      // 設定がURLとして不正なら request.url にフォールバックする
    }
  }
  return new URL(request.url).origin;
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
