import { NextResponse } from "next/server";
import { getRequestSession, publicOrigin, sessionOwnerKey } from "@/lib/auth";
import { appendBoardPost, sanitizeBoardText } from "@/lib/worldbox/board";
import { isBoardEnabled, loadBoardPosts, storeBoardPosts } from "@/lib/worldbox/board-online";
import { loadMyLobbyStation } from "@/lib/worldbox/station-online";

export const runtime = "nodejs";

// AGO WORLD BOX ロビーのグローバル掲示板。
// GET: { posts, loggedIn }（誰でも読める。posts は新しい順・最大30件）
// POST { text }: 投稿（ログイン中のみ。本文は最大120文字）
//   場所制約: ロビーの掲示板の前にいること（サーバー側でプレゼンス検証）。
// 保存先は bot_kv（名前空間 worldbox_board、キー "messages"）。
// 表示名はセッションの username を正とする。
// Bot API 未設定なら 503（クライアントは掲示板なしで遊び続ける）。

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
/** 連投制限の最小間隔（チャットの CHAT_MIN_INTERVAL_MS と同じ 1.5 秒）。 */
const BOARD_MIN_INTERVAL_MS = 1_500;
/** 連投制限の最終投稿時刻。プロセス内メモリで十分。 */
const lastPostAt = new Map<string, number>();

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
  const ownerKey = sessionOwnerKey(session);
  const now = Date.now();
  if (now - (lastPostAt.get(ownerKey) ?? 0) < BOARD_MIN_INTERVAL_MS) {
    return NextResponse.json({ error: "too_fast" }, { status: 429, headers: NO_STORE });
  }
  // 場所制約: 投稿は掲示板の前でのみ（本文の検証を通った後に位置を確かめる）
  if ((await loadMyLobbyStation(ownerKey)) !== "board") {
    return NextResponse.json({ error: "not_at_board" }, { status: 409, headers: NO_STORE });
  }
  const name = session.username?.trim() || "プレイヤー";
  const posts = appendBoardPost(await loadBoardPosts(), { name, text, at: now });
  const stored = await storeBoardPosts(posts);
  if (!stored) {
    return NextResponse.json({ error: "board_failed" }, { status: 500, headers: NO_STORE });
  }
  lastPostAt.set(ownerKey, now);
  return NextResponse.json({ ok: true, posts }, { headers: NO_STORE });
}
