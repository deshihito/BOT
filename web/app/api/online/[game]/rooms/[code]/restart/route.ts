import { NextResponse } from "next/server";
import { getOnlineGame } from "@/lib/online/registry";
import { OnlineRoomError, parseRoomCode, parseTokenRevisionBody, restartOnlineGame } from "@/lib/online/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 再戦をロビー状態で準備する（ホストのみ・対戦終了後のみ）。 */
export async function POST(request: Request, { params }: { params: Promise<{ game: string; code: string }> }) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  try {
    const { game, code: rawCode } = await params;
    if (!getOnlineGame(game)) throw new OnlineRoomError(404, "ゲームが見つかりません。");
    const code = parseRoomCode(rawCode);
    const { playerToken, expectedRevision } = parseTokenRevisionBody(body);
    const result = await restartOnlineGame(game, code, playerToken, expectedRevision);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof OnlineRoomError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "再戦を準備できませんでした" }, { status: 500 });
  }
}
