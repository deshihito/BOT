import { NextResponse } from "next/server";
import { BalkuRoomError, getBalkuRoom, parsePlayerToken, parseRoomCode } from "@/lib/balku-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ルームのスナップショット取得（秘匿済み）。取得時に期限切れ処理
 * （手番の自動パス・オークション決済）が適用され、変わっていたら
 * 保存されて revision が上がる。SSE が使えない環境のポーリング用。
 */
export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const code = parseRoomCode((await params).code);
    const token = parsePlayerToken(new URL(request.url).searchParams.get("token"));
    const view = await getBalkuRoom(code, token);
    return NextResponse.json(view);
  } catch (error) {
    if (error instanceof BalkuRoomError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "ルームを取得できませんでした" }, { status: 500 });
  }
}
