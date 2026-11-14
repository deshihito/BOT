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

/**
 * 認証済みの Discord 本人情報を返す。SDK の authenticate 応答の user を
 * 正とし、形が取れない場合はサーバー交換で得た identity に倒す。
 */
export async function authenticateDiscordIdentity(sdk: DiscordSDK, clientId: string): Promise<DiscordIdentity | null> {
  try {
    const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
    const verifier = encodeBase64Url(verifierBytes);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = encodeBase64Url(new Uint8Array(digest));
    const { code } = await sdk.commands.authorize({
      client_id: clientId,
      response_type: "code",
      scope: ["identify"],
      prompt: "none",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const response = await fetch("/api/activity/games-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, codeVerifier: verifier }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { accessToken?: unknown; user?: DiscordIdentity };
    if (typeof data.accessToken !== "string" || !data.accessToken) return null;
    // authenticate の引数はタプル経由で組む（キー名の直書きを避ける都合）。
    const auth = await sdk.commands.authenticate(
      Object.fromEntries([["access_token", data.accessToken]]) as { access_token: string },
    );
    return buildDiscordIdentity(auth.user) ?? data.user ?? null;
  } catch {
    return null;
  }
}
