import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { readActivityToken } from "@/lib/activity-auth";

export const runtime = "nodejs";
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const claims = readActivityToken(url.searchParams.get("token") || undefined);
  const videoId = url.searchParams.get("videoId") || "";
  if (!claims || !VIDEO_ID.test(videoId)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const baseUrl = process.env.BOT_CODER_BASE_URL;
  const secret = process.env.CODER_SERVICE_SHARED_SECRET;
  if (!baseUrl || !secret) return NextResponse.json({ error: "activity_not_configured" }, { status: 503 });

  let endpoint: URL;
  try {
    endpoint = new URL("/internal/activity/music-video", baseUrl);
    if (endpoint.protocol !== "https:" && process.env.NODE_ENV === "production") throw new Error("HTTPS required");
  } catch {
    return NextResponse.json({ error: "activity_not_configured" }, { status: 503 });
  }

  const body = JSON.stringify({ guild_id: claims.guildId, channel_id: claims.channelId, user_id: claims.userId, video_id: videoId });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(24).toString("hex");
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const signedPayload = `POST\n/internal/activity/music-video\n${timestamp}\n${nonce}\n${bodyHash}`;
  const signature = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AGO-Coder-Timestamp": timestamp,
        "X-AGO-Coder-Nonce": nonce,
        "X-AGO-Coder-Signature": signature,
      },
      body,
      cache: "no-store",
    });
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: upstream.status === 409 ? "video_not_current" : "video_unavailable" }, { status: upstream.status === 409 ? 409 : 502 });
    }
    const headers = new Headers();
    headers.set("Content-Type", upstream.headers.get("content-type") || "video/mp4");
    for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("Cache-Control", "no-store, max-age=0");
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return NextResponse.json({ error: "video_unavailable" }, { status: 502 });
  }
}
