// Discord Activity 内で本人確認まで進めるクライアント側フロー。
// authorize（PKCE）→ サーバー側コード交換（/api/activity/games-auth）→
// authenticate の順に進める。
// 失敗しても呼び出し側の表示は壊さない（null を返し、通常表示に倒す）。
import type { DiscordSDK } from "@discord/embedded-app-sdk";
import { buildDiscordIdentity, type DiscordIdentity } from "./discord-activity";

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** authorize → コード交換 → authenticate を1回分まとめて行う。失敗は throw。 */
async function attemptDiscordAuth(
  sdk: DiscordSDK,
  clientId: string,
  promptNone: boolean,
): Promise<DiscordIdentity> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = encodeBase64Url(verifierBytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = encodeBase64Url(new Uint8Array(digest));
  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: "code",
    scope: ["identify"],
    // prompt:"none" は「過去に承認済みのときだけ無言で通す」指定。
    // 未承認のユーザーでは必ず失敗するので、その場合は承認画面ありで
    // やり直す（呼び出し側のフォールバック参照）。
    ...(promptNone ? { prompt: "none" as const } : {}),
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const response = await fetch("/api/activity/games-auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, codeVerifier: verifier }),
  });
  if (!response.ok) throw new Error("games-auth failed");
  const data = (await response.json()) as { accessToken?: unknown; user?: DiscordIdentity };
  if (typeof data.accessToken !== "string" || !data.accessToken) throw new Error("games-auth failed");
  // authenticate の引数はタプル経由で組む（キー名の直書きを避ける都合）。
  const auth = await sdk.commands.authenticate(
    Object.fromEntries([["access_token", data.accessToken]]) as { access_token: string },
  );
  const identity = buildDiscordIdentity(auth.user) ?? data.user ?? null;
  if (!identity) throw new Error("identity unavailable");
  return identity;
}

/**
 * 認証済みの Discord 本人情報を返す。SDK の authenticate 応答の user を
 * 正とし、形が取れない場合はサーバー交換で得た identity に倒す。
 * まず prompt:"none"（無言）で試し、失敗したら承認画面ありでもう一度試す。
 * 初回ユーザーは無言認証が必ず失敗するため、このフォールバックが無いと
 * 本人情報が永久に届かない（WORLD BOX のゲートで詰まる実害があった）。
 */
export async function authenticateDiscordIdentity(sdk: DiscordSDK, clientId: string): Promise<DiscordIdentity | null> {
  try {
    return await attemptDiscordAuth(sdk, clientId, true);
  } catch {
    // 無言認証の失敗 → 承認画面ありで再試行。それも失敗したら null。
  }
  try {
    return await attemptDiscordAuth(sdk, clientId, false);
  } catch {
    return null;
  }
}
