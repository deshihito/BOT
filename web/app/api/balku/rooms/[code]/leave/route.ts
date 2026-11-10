import { NextResponse } from "next/server";
import { BalkuRoomError, leaveBalkuRoom, parseRoomCode, parseTokenRevisionBody } from "@/lib/balku-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ルームから退出する。 */
export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  try {
    const code = parseRoomCode((await params).code);
    const { playerToken, expectedRevision } = parseTokenRevisionBody(body);
    const result = await leaveBalkuRoom(code, playerToken, expectedRevision);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof BalkuRoomError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "退出できませんでした" }, { status: 500 });
  }
}
