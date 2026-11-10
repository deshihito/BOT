import { NextResponse } from "next/server";
import { BalkuRoomError, createBalkuRoom, parseCreateRoomBody } from "@/lib/balku-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ルーム作成。作成者がホスト（seat 0）になる。 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  try {
    const input = parseCreateRoomBody(body);
    const result = await createBalkuRoom(input);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof BalkuRoomError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "ルームを作成できませんでした" }, { status: 500 });
  }
}
