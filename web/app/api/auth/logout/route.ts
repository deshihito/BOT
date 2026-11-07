import { NextResponse } from "next/server";
import { SESSION_COOKIE, getRequestSession, publicOrigin, sessionCookieOptions } from "@/lib/auth";
import { deleteWebSession } from "@/lib/dashboard";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const session = getRequestSession(request);
  if (session?.sid) {
    await deleteWebSession(session.sid);
  }
  const response = NextResponse.redirect(new URL("/", publicOrigin(request)), { status: 303 });
  response.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(request, 0));
  return response;
}
