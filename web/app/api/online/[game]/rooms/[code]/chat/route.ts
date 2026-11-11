import { NextResponse } from "next/server";
import { getOnlineGame } from "@/lib/online/registry";
import { OnlineRoomError, parseChatBody, parseRoomCode, postOnlineChat } from "@/lib/online/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ルーム内チャットへの投稿。セッション認可は move と同じ
 * （playerToken を検証し、着席メンバー以外は 403）。投稿は revision を
 * 上げ、SSE で全メンバーへ配信される。
 */
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
    const { playerToken, text } = parseChatBody(body);
    const result = await postOnlineChat(game, code, playerToken, text);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof OnlineRoomError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "メッセージを送信できませんでした" }, { status: 500 });
  }
}
