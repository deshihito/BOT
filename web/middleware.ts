import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  const { nextUrl } = request;
  if (
    nextUrl.pathname === "/" &&
    nextUrl.searchParams.has("frame_id") &&
    nextUrl.searchParams.has("instance_id")
  ) {
    const activityUrl = nextUrl.clone();
    activityUrl.pathname = "/activity/music";
    return NextResponse.redirect(activityUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/"],
};
