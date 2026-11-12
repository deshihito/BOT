import crypto from "node:crypto";
import { cookies } from "next/headers";
import { effectiveHost } from "./subdomain";

export const SESSION_COOKIE = "ago_session";
export const OAUTH_STATE_COOKIE = "ago_discord_oauth_state";
export const GOOGLE_STATE_COOKIE = "ago_google_oauth_state";
/** OAuth 完了後の戻り先（同一サイト内のパス）を認可開始→コールバックへ運ぶ Cookie。 */
export const OAUTH_NEXT_COOKIE = "ago_oauth_next";

const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

/** ログインに使ったプロバイダ。旧セッション（フィールドなし）は discord として読む。 */
export type AuthProvider = "discord" | "google";

type SessionPayload = {
  id: string;
  username: string;
  expiresAt: number;
  // サーバー側セッションレコード（lib/dashboard.ts）のキー。ダッシュボード用ログインでのみ付く。
  sid?: string;
  // Discord ではアバターハッシュ、Google ではプロフィール画像の完全な URL（無い/未取得なら null。旧セッションには含まれない）
  avatar?: string | null;
  // ログインプロバイダ（旧セッションには含まれない。その場合は discord として扱う）
  provider?: AuthProvider;
};

export type DiscordUser = Pick<SessionPayload, "id" | "username"> & {
  avatar?: string | null;
  provider?: AuthProvider;
};

export type SessionInfo = DiscordUser & { sid?: string; provider: AuthProvider };

/** プロバイダ種別＋プロバイダ側ユーザーID で一意になる内部の所有者キー（キー保存等の所有者識別に使う）。 */
export function sessionOwnerKey(info: { provider: AuthProvider; id: string }): string {
  return `${info.provider}:${info.id}`;
}

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

export function isGoogleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

export function createSession(user: DiscordUser, sid?: string) {
  const payload: SessionPayload = {
    id: user.id,
    username: user.username.slice(0, 80),
    expiresAt: Date.now() + SESSION_MAX_AGE * 1000,
    ...(sid ? { sid } : {}),
    ...(user.avatar !== undefined ? { avatar: user.avatar } : {}),
    ...(user.provider ? { provider: user.provider } : {}),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(encoded);
  if (!signature) throw new Error("session secret is not configured");
  return `${encoded}.${signature}`;
}

export function readSession(value?: string): DiscordUser | null {
  const info = readSessionInfo(value);
  return info ? { id: info.id, username: info.username, avatar: info.avatar ?? null, provider: info.provider } : null;
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
    const avatar = typeof payload.avatar === "string" && payload.avatar ? payload.avatar : null;
    // provider が無い旧セッションは Discord ログインとして扱う（後方互換）
    const provider: AuthProvider = payload.provider === "google" ? "google" : "discord";
    return { id: payload.id, username: payload.username, avatar, provider, ...(sid ? { sid } : {}) };
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

/**
 * OAuth 完了後の戻り先を検証する。同一サイト内のパス（"/" 始まり）だけを許可し、
 * それ以外は fallback に倒す（オープンリダイレクト防止）。"//host" 形式や
 * バックスラッシュ混じりはプロトコル相対 URL として解釈され得るため弾く。
 */
export function resolveOAuthNext(value: string | null | undefined, fallback = "/dashboard"): string {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !/\s/.test(value)
  ) {
    return value;
  }
  return fallback;
}

/**
 * 認可開始は、登録済み redirect_uri と同じホスト（正規ホスト）で始める必要がある。
 * state / next の Cookie はホスト単位でしか残らず、コールバックは redirect_uri の
 * ホストへ着地するため、別ホスト（例: One Prompter 専用サブドメイン）から
 * 始まると state が照合できない。別ホストからのリクエストなら、正規ホスト側の
 * 認可 URL（クエリ引き継ぎ）へ飛ばす絶対 URL を返す。正規ホストなら null。
 */
export function canonicalAuthorizeRedirect(request: Request, pathname: string, redirectUri: string | undefined): string | null {
  if (!redirectUri) return null;
  let canonical: URL;
  try {
    canonical = new URL(redirectUri);
  } catch {
    return null;
  }
  const url = new URL(request.url);
  const host = effectiveHost(request.headers.get("x-forwarded-host"), url.hostname);
  if (host === canonical.host) return null;
  return `${canonical.origin}${pathname}${url.search}`;
}
