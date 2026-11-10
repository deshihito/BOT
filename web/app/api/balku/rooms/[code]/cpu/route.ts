import { NextResponse } from "next/server";
import { BalkuRoomError, parseCpuBody, parseRoomCode, setBalkuCpu } from "@/lib/balku-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * CPU の追加/削除。セッション認可は move と同じ（playerToken を検証）。
 * ホストのみ・待機中のみ。body: { playerToken, action: "add" | "remove", seat? }
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
    const { playerToken, action, seat } = parseCpuBody(body);
    const result = await setBalkuCpu(code, playerToken, action, seat);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof BalkuRoomError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "CPUを操作できませんでした" }, { status: 500 });
  }
}
