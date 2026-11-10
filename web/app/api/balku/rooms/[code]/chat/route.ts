import { NextResponse } from "next/server";
import { BalkuRoomError, parseChatBody, parseRoomCode, postBalkuChat } from "@/lib/balku-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ルーム内チャットへの投稿。セッション認可は move と同じ
 * （playerToken を検証し、着席メンバー以外は 403）。投稿は revision を
 * 上げ、SSE で全メンバーへ配信される。200文字超は切り捨てず 400。
 */
export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  try {
    const code = parseRoomCode((await params).code);
    const { playerToken, text } = parseChatBody(body);
    const result = await postBalkuChat(code, playerToken, text);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof BalkuRoomError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "メッセージを送信できませんでした" }, { status: 500 });
  }
}
