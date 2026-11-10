import { NextResponse } from "next/server";
import { BalkuRoomError, joinBalkuRoom, parseJoinRoomBody } from "@/lib/balku-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 6文字コードでルームに参加する。開始後・満席は 400。 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  try {
    const input = parseJoinRoomBody(body);
    const result = await joinBalkuRoom(input);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof BalkuRoomError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "参加できませんでした" }, { status: 500 });
  }
}
