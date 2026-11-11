import { NextResponse } from "next/server";
import { getOnlineGame } from "@/lib/online/registry";
import { OnlineRoomError, getOnlineRoom, parsePlayerToken, parseRoomCode } from "@/lib/online/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ルームのスナップショット取得（閲覧者別に秘匿済み）。取得時に進行処理
 * （期限切れ・CPU）が適用され、変わっていたら revision が上がる。
 * SSE が使えない環境のポーリング用。
 */
export async function GET(request: Request, { params }: { params: Promise<{ game: string; code: string }> }) {
  try {
    const { game, code: rawCode } = await params;
    if (!getOnlineGame(game)) throw new OnlineRoomError(404, "ゲームが見つかりません。");
    const code = parseRoomCode(rawCode);
    const token = parsePlayerToken(new URL(request.url).searchParams.get("token"));
    const view = await getOnlineRoom(game, code, token);
    return NextResponse.json(view);
  } catch (error) {
    if (error instanceof OnlineRoomError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "ルームを取得できませんでした" }, { status: 500 });
  }
}
