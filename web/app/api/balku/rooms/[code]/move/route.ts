import { NextResponse } from "next/server";
import { BalkuRoomError, applyBalkuMove, parseMoveBody, parseRoomCode } from "@/lib/balku-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ゲーム中の行動を適用する。revision 不一致は 409（クライアントは
 * 再取得して同期する）。期限切れで状態が進んでいた場合も 409。
 * エンジンのルールエラーは 400 で日本語メッセージを返す。
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
    const { playerToken, expectedRevision, action } = parseMoveBody(body);
    const result = await applyBalkuMove(code, playerToken, expectedRevision, action);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof BalkuRoomError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "操作を処理できませんでした" }, { status: 500 });
  }
}
