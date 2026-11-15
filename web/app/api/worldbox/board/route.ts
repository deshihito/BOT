import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin } from "@/lib/auth";
import { appendBoardPost, sanitizeBoardText } from "@/lib/worldbox/board";
import { isBoardEnabled, loadBoardPosts, storeBoardPosts } from "@/lib/worldbox/board-online";

export const runtime = "nodejs";

// AGO WORLD BOX ロビーのグローバル掲示板。
// GET: { posts, loggedIn }（誰でも読める。posts は新しい順・最大30件）
// POST { text }: 投稿（ログイン中のみ。本文は最大120文字）
// 保存先は bot_kv（名前空間 worldbox_board、キー "messages"）。
// 表示名はセッションの username を正とする。
// Bot API 未設定なら 503（クライアントは掲示板なしで遊び続ける）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === publicOrigin(request);
}

export async function GET(request: Request) {
  if (!isBoardEnabled()) {
    return NextResponse.json({ error: "board_unavailable" }, { status: 503, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  const posts = await loadBoardPosts();
  return NextResponse.json({ posts, loggedIn: session !== null }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const session = getRequestSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }
  if (!isBoardEnabled()) {
    return NextResponse.json({ error: "board_unavailable" }, { status: 503, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  const text = sanitizeBoardText((body as { text?: unknown } | null)?.text);
  if (text === null) {
    return NextResponse.json({ error: "invalid_text" }, { status: 400, headers: NO_STORE });
  }
  const name = session.username?.trim() || "プレイヤー";
  const posts = appendBoardPost(await loadBoardPosts(), { name, text, at: Date.now() });
  const stored = await storeBoardPosts(posts);
  if (!stored) {
    return NextResponse.json({ error: "board_failed" }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true, posts }, { headers: NO_STORE });
}
