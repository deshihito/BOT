import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { readActivityToken } from "@/lib/activity-auth";

export const runtime = "nodejs";
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const claims = readActivityToken(url.searchParams.get("token") || undefined);
  const videoId = url.searchParams.get("videoId") || "";
  const asset = url.searchParams.get("asset") || "index.m3u8";
  if (!claims || !VIDEO_ID.test(videoId)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!/^(?:index\.m3u8|seg-\d{6}\.ts)$/.test(asset)) return NextResponse.json({ error: "invalid_asset" }, { status: 400 });

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

  const body = JSON.stringify({ guild_id: claims.guildId, channel_id: claims.channelId, user_id: claims.userId, video_id: videoId, asset });
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
      const detail = await upstream.text().catch(() => "");
      console.error("[ActivityVideo] upstream failure", { status: upstream.status, asset, detail: detail.slice(0, 500) });
      return NextResponse.json({ error: upstream.status === 409 ? "video_not_current" : "video_unavailable", upstreamStatus: upstream.status, detail: detail.slice(0, 500) }, { status: upstream.status === 409 ? 409 : 502 });
    }
    const headers = new Headers();
    let bodyStream = upstream.body;
    const contentType = upstream.headers.get("content-type") || "";
    if (asset === "index.m3u8") {
      const manifest = await upstream.text();
      const prefix = `/api/activity/music-video?token=${encodeURIComponent(url.searchParams.get("token") || "")}&videoId=${encodeURIComponent(videoId)}&asset=`;
      const rewritten = manifest.split("\n").map((line) => {
        const trimmed = line.trim();
        return trimmed && !trimmed.startsWith("#") ? `${prefix}${encodeURIComponent(trimmed)}` : line;
      }).join("\n");
      bodyStream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(rewritten)); controller.close(); } });
    }
    headers.set("Content-Type", contentType || (asset === "index.m3u8" ? "application/vnd.apple.mpegurl" : "video/mp2t"));
    for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      if (asset === "index.m3u8" && name === "content-length") continue;
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("Cache-Control", "no-store, max-age=0");
    return new Response(bodyStream, { status: upstream.status, headers });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown error";
    console.error("[ActivityVideo] proxy exception", { asset, detail });
    return NextResponse.json({ error: "video_unavailable", detail }, { status: 502 });
  }
}
