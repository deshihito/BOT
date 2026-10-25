import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { readActivityToken } from "@/lib/activity-auth";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const ALLOWED_STATUS = new Set(["idle", "unsupported", "loading", "playing", "paused"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function finiteNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safeSnapshot(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (typeof source.status !== "string" || !ALLOWED_STATUS.has(source.status)) return null;
  const snapshot: Record<string, string | number> = {
    status: source.status,
    serverTime: finiteNumber(source.serverTime, Date.now() / 1000),
  };
  if (typeof source.title === "string") snapshot.title = source.title.slice(0, 200);
  if (typeof source.videoId === "string" && VIDEO_ID.test(source.videoId)) snapshot.videoId = source.videoId;
  if (source.status === "playing" || source.status === "paused" || source.status === "loading") {
    if (typeof snapshot.videoId !== "string") return null;
    snapshot.positionSeconds = Math.max(0, finiteNumber(source.positionSeconds));
    snapshot.durationSeconds = Math.max(0, finiteNumber(source.durationSeconds));
    snapshot.playbackRate = Math.min(4, Math.max(0.25, finiteNumber(source.playbackRate, 1)));
  }
  return snapshot;
}

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer ([A-Za-z0-9._-]+)$/);
  const claims = match ? readActivityToken(match[1]) : null;
  if (!claims) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });

  const baseUrl = process.env.BOT_CODER_BASE_URL;
  const secret = process.env.CODER_SERVICE_SHARED_SECRET;
  if (!baseUrl || !secret) {
    return NextResponse.json({ error: "activity_not_configured" }, { status: 503, headers: NO_STORE });
  }

  let endpoint: URL;
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== "https:" && process.env.NODE_ENV === "production") throw new Error("HTTPS required");
    endpoint = new URL("/internal/activity/music-state", base);
  } catch {
    return NextResponse.json({ error: "activity_not_configured" }, { status: 503, headers: NO_STORE });
  }

  const body = JSON.stringify({
    guild_id: claims.guildId,
    channel_id: claims.channelId,
    user_id: claims.userId,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(24).toString("hex");
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const signedPayload = `POST\n/internal/activity/music-state\n${timestamp}\n${nonce}\n${bodyHash}`;
  const signature = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AGO-Coder-Timestamp": timestamp,
        "X-AGO-Coder-Nonce": nonce,
        "X-AGO-Coder-Signature": signature,
      },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) {
      const status = [401, 403, 429, 503, 504].includes(response.status) ? response.status : 502;
      const error = status === 403 ? "not_in_voice_channel" : status === 429 ? "rate_limited" : "music_state_unavailable";
      return NextResponse.json({ error }, { status, headers: NO_STORE });
    }
    const snapshot = safeSnapshot(await response.json());
    if (!snapshot) return NextResponse.json({ error: "invalid_music_state" }, { status: 502, headers: NO_STORE });
    return NextResponse.json(snapshot, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "music_state_unavailable" }, { status: 502, headers: NO_STORE });
  }
}
