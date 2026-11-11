import { NextResponse } from "next/server";
import { getOnlineGame } from "@/lib/online/registry";
import { OnlineRoomError, applyOnlineMove, parseMoveBody, parseRoomCode } from "@/lib/online/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ゲーム中の行動を適用する。action はゲーム固有の形のため、ここでは
 * 取り出すだけ（検証は基盤／エンジン側）。revision 不一致は 409
 * （クライアントは再取得して同期する）。ルールエラーは 400。
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
    const { playerToken, expectedRevision, action } = parseMoveBody(body);
    const result = await applyOnlineMove(game, code, playerToken, expectedRevision, action);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof OnlineRoomError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "操作を処理できませんでした" }, { status: 500 });
  }
}
