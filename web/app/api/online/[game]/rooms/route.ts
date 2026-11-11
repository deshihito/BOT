import { NextResponse } from "next/server";
import { getOnlineGame } from "@/lib/online/registry";
import { OnlineRoomError, createOnlineRoom, parseCreateRoomBody } from "@/lib/online/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function assertGame(gameId: string): void {
  if (!getOnlineGame(gameId)) throw new OnlineRoomError(404, "ゲームが見つかりません。");
}

function errorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof OnlineRoomError) return NextResponse.json({ error: error.message }, { status: error.status });
  return NextResponse.json({ error: fallback }, { status: 500 });
}

/** ルーム作成。作成者がホスト（seat 0）になる。 */
export async function POST(request: Request, { params }: { params: Promise<{ game: string }> }) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  try {
    const { game } = await params;
    assertGame(game);
    const input = parseCreateRoomBody(body);
    const result = await createOnlineRoom(game, input);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, "ルームを作成できませんでした");
  }
}
