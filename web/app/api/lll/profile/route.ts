import { NextResponse } from "next/server";
import { LllError, getProfile, parseToken } from "@/lib/lll-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** プロフィール取得。 */
export async function GET(request: Request) {
  try {
    const token = parseToken(new URL(request.url).searchParams.get("token"));
    const profile = await getProfile(token);
    if (!profile) return NextResponse.json({ error: "プロフィールが見つかりません。" }, { status: 404 });
    return NextResponse.json({ profile });
  } catch (error) {
    if (error instanceof LllError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "プロフィールを取得できませんでした" }, { status: 500 });
  }
}
