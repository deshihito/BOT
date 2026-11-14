// 背景透過の一時リンク用トークン検証（サーバー専用）。
// 形式は fastHTML と同じ v1.<base64url(payload JSON)>.<base64url(HMAC-SHA256)> で、
// Bot が BOT_API_KEY で署名し、ここでは同じ鍵で検証する。署名対象は
// "v1.<base64url(payload)>"。ペイロード: u=ユーザーID, p=用途, g=ギルドID,
// c=チャンネルID, j=ジョブID, exp=失効時刻（unix 秒）。

import { createHmac, timingSafeEqual } from "node:crypto";

import type { BgCutPurpose } from "./bgcut-core";

// Discord の ID は 2^53 を超えるため、JSON.parse の数値では精度が落ちる。
// dashboard-core の番兵文字列と同じ考え方で、ID フィールド（u/g/c）だけを
// パース前に文字列へ寄せ、ID は数字文字列として運ぶ。
export type BgCutTokenPayload = {
  userId: string;
  purpose: BgCutPurpose;
  guildId: string;
  channelId: string;
  jobId: string;
  expiresAt: number;
};

export function parseBgcutPayloadJson(text: string): unknown {
  return JSON.parse(text.replace(/"(u|g|c)":(\d+)/g, '"$1":"$2"'));
}

export type BgCutTokenStatus =
  | { status: "ok"; payload: BgCutTokenPayload }
  | { status: "unconfigured" }
  | { status: "invalid" }
  | { status: "expired"; payload: BgCutTokenPayload };

function parsePayload(raw: unknown): BgCutTokenPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { u, p, g, c, j, exp } = raw as Record<string, unknown>;
  if (p !== "emoji" && p !== "sticker") return null;
  for (const v of [u, g, c]) {
    if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
  }
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp < 0) return null;
  if (typeof j !== "string" || j.length < 8 || j.length > 64) return null;
  return {
    userId: u as string,
    purpose: p,
    guildId: g as string,
    channelId: c as string,
    jobId: j,
    expiresAt: exp,
  };
}

export function verifyBgcutToken(
  token: string,
  apiKey: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): BgCutTokenStatus {
  if (!apiKey) return { status: "unconfigured" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return { status: "invalid" };
  const expected = createHmac("sha256", apiKey)
    .update(`v1.${parts[1]}`, "utf8")
    .digest();
  let given: Buffer;
  let payload: BgCutTokenPayload | null;
  try {
    given = Buffer.from(parts[2], "base64url");
    payload = parsePayload(
      parseBgcutPayloadJson(Buffer.from(parts[1], "base64url").toString("utf8")),
    );
  } catch {
    return { status: "invalid" };
  }
  if (!payload) return { status: "invalid" };
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { status: "invalid" };
  }
  if (payload.expiresAt <= nowSeconds) return { status: "expired", payload };
  return { status: "ok", payload };
}
