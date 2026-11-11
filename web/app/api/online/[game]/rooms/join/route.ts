import { NextResponse } from "next/server";
import { getOnlineGame } from "@/lib/online/registry";
import { OnlineRoomError, joinOnlineRoom, parseJoinRoomBody } from "@/lib/online/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function assertGame(gameId: string): void {
  if (!getOnlineGame(gameId)) throw new OnlineRoomError(404, "ゲームが見つかりません。");
}

function errorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof OnlineRoomError) return NextResponse.json({ error: error.message }, { status: error.status });
  return NextResponse.json({ error: fallback }, { status: 500 });
}

/** 6文字コードでルームに参加する。開始後・満席は 400。 */
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
    const input = parseJoinRoomBody(body);
    const result = await joinOnlineRoom(game, input);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, "参加できませんでした");
  }
}
