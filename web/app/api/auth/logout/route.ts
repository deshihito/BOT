import { NextResponse } from "next/server";
import { SESSION_COOKIE, getRequestSession, publicOrigin, resolveOAuthNext, sessionCookieOptions } from "@/lib/auth";
import { deleteWebSession } from "@/lib/dashboard";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const session = getRequestSession(request);
  if (session?.sid) {
    await deleteWebSession(session.sid);
  }
  // ログアウト後の戻り先（同一サイト内のパスだけ許可）。未指定は従来どおりトップ。
  const next = resolveOAuthNext(new URL(request.url).searchParams.get("next"), "/");
  const response = NextResponse.redirect(new URL(next, publicOrigin(request)), { status: 303 });
  response.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(request, 0));
  return response;
}
