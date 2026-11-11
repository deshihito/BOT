import { NextResponse } from "next/server";
import { getOnlineGame } from "@/lib/online/registry";
import { OnlineRoomError, listPublicOnlineRooms } from "@/lib/online/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ロビー状態の公開ルーム一覧。 */
export async function GET(_request: Request, { params }: { params: Promise<{ game: string }> }) {
  try {
    const { game } = await params;
    if (!getOnlineGame(game)) throw new OnlineRoomError(404, "ゲームが見つかりません。");
    const rooms = await listPublicOnlineRooms(game);
    return NextResponse.json({ rooms });
  } catch (error) {
    if (error instanceof OnlineRoomError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "ルーム一覧を取得できませんでした" }, { status: 500 });
  }
}
