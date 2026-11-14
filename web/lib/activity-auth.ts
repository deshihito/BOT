function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,30}$/.test(value);
}

export type DiscordOAuthUser = {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
};

/**
 * Activity の OAuth コード交換（PKCE）＋ /users/@me 取得。
 * ゲーム側（games-auth ルート）が使う。音楽 Activity 画面の廃止
 * （2026-11-14）に伴い、Activity トークンの発行・検証は撤去した。
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
