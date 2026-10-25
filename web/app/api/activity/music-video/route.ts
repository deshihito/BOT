import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { readActivityToken } from "@/lib/activity-auth";

export const runtime = "nodejs";
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const ASSET = /^(?:index\.m3u8|seg-\d{6}\.ts)$/;

// HLS セグメント行のみを対象にする（コメント・空行・絶対 URL・既に書き換え済みは除外）
function rewriteManifest(manifest: string, prefix: string): string {
  return manifest
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      // 絶対 URL はそのまま（プロキシ対象外）
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return line;
      // 想定するセグメント名のみ書き換え（クエリ・パス付きは弾く）
      if (!ASSET.test(trimmed) || trimmed === "index.m3u8") return line;
      return `${prefix}${trimmed}`;
    })
    .join("\n");
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const claims = readActivityToken(url.searchParams.get("token") || undefined);
  const videoId = url.searchParams.get("videoId") || "";
  const asset = url.searchParams.get("asset") || "index.m3u8";
  if (!claims || !VIDEO_ID.test(videoId)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!ASSET.test(asset)) {
    return NextResponse.json({ error: "invalid_asset" }, { status: 400 });
  }

  const baseUrl = process.env.BOT_CODER_BASE_URL;
  const secret = process.env.CODER_SERVICE_SHARED_SECRET;
  if (!baseUrl || !secret) {
    return NextResponse.json({ error: "activity_not_configured" }, { status: 503 });
  }

  let endpoint: URL;
  try {
    endpoint = new URL("/internal/activity/music-video", baseUrl);
    if (endpoint.protocol !== "https:" && process.env.NODE_ENV === "production") {
      throw new Error("HTTPS required");
    }
  } catch {
    return NextResponse.json({ error: "activity_not_configured" }, { status: 503 });
  }

  const body = JSON.stringify({
    guild_id: claims.guildId,
    channel_id: claims.channelId,
    user_id: claims.userId,
    video_id: videoId,
    asset,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(24).toString("hex");
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  // 署名対象パスは endpoint.pathname を使う（baseUrl にパスが含まれても一致させる）
  const signedPayload = `POST\n${endpoint.pathname}\n${timestamp}\n${nonce}\n${bodyHash}`;
  const signature = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

  const forwardHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "X-AGO-Coder-Timestamp": timestamp,
    "X-AGO-Coder-Nonce": nonce,
    "X-AGO-Coder-Signature": signature,
  };
  // Range リクエストを透過する（セグメント取得で重要）
  const range = request.headers.get("range");
  if (range && asset !== "index.m3u8") forwardHeaders["Range"] = range;

  try {
    // タイムアウト設定を追加 (15秒)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    let upstream: Response;
    try {
      upstream = await fetch(endpoint, {
        method: "POST",
        headers: forwardHeaders,
        body,
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      console.error("[ActivityVideo] upstream failure", {
        status: upstream.status,
        asset,
        detail: detail.slice(0, 500),
      });
      // クライアントにも上流ステータスと detail を返す（デバッグ容易化）
      return NextResponse.json(
        {
          error: upstream.status === 409 ? "video_not_current" : "video_unavailable",
          stage: "upstream",
          upstreamStatus: upstream.status,
          detail: detail.slice(0, 500),
        },
        { status: upstream.status === 409 ? 409 : 502 },
      );
    }

    const headers = new Headers();
    let bodyStream = upstream.body;
    const contentType = upstream.headers.get("content-type") || "";

    if (asset === "index.m3u8") {
      const manifest = await upstream.text();
      const tokenParam = encodeURIComponent(url.searchParams.get("token") || "");
      const prefix = `/api/activity/music-video?token=${tokenParam}&videoId=${encodeURIComponent(videoId)}&asset=`;
      const rewritten = rewriteManifest(manifest, prefix);
      bodyStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(rewritten));
          controller.close();
        },
      });
      headers.set("Content-Type", "application/vnd.apple.mpegurl");
    } else {
      headers.set("Content-Type", contentType || "video/mp2t");
      // セグメントは Range / 長さ / キャッシュ系ヘッダを透過
      for (const name of [
        "content-length",
        "content-range",
        "accept-ranges",
        "etag",
        "last-modified",
      ]) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
      }
    }

    headers.set("Cache-Control", "no-store, max-age=0");
    return new Response(bodyStream, { status: upstream.status, headers });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    const detail = isAbort
      ? "upstream timeout (Next.js)"
      : error instanceof Error
        ? error.message
        : "unknown error";
    console.error("[ActivityVideo] proxy exception", { asset, detail });
    return NextResponse.json(
      { error: "video_unavailable", stage: "fetch", detail },
      { status: 502 },
    );
  }
}