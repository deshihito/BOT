import { NextResponse } from "next/server";
import { LllError, getOrCreateProfile, parseSessionBody } from "@/lib/lll-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** セッション開始。既存トークンが有効ならそのプロフィール、無ければ新規発行＋スターター付与。 */
export async function POST(request: Request) {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // ボディ無しでも新規セッションとして扱う
  }
  try {
    const { token } = parseSessionBody(body);
    const result = await getOrCreateProfile(token);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof LllError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "セッションを開始できませんでした" }, { status: 500 });
  }
}
