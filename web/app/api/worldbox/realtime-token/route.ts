import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin } from "@/lib/auth";
import { issueRealtimeToken } from "@/lib/worldbox/realtime-token";

export const runtime = "nodejs";

// AGO WORLD BOX リアルタイム中継（WebSocket）用の短期トークン発行。
// POST: ログイン中のみ。{ token } を返す（有効期限つき・署名はセッションと同じ鍵）。
// 中継ラッパー（realtime-server.js）が接続時にこのトークンを検証する。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  const token = issueRealtimeToken(session, Date.now());
  if (!token) {
    return NextResponse.json({ error: "realtime_unavailable" }, { status: 503, headers: NO_STORE });
  }
  return NextResponse.json({ token }, { headers: NO_STORE });
}
