import { NextResponse } from "next/server";
import { getOnlineGame } from "@/lib/online/registry";
import { OnlineRoomError, parseCpuBody, parseRoomCode, setOnlineCpu } from "@/lib/online/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * CPU の追加/削除。セッション認可は move と同じ（playerToken を検証）。
 * ホストのみ・待機中のみ。body: { playerToken, action: "add" | "remove", seat? }
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
    const { playerToken, action, seat } = parseCpuBody(body);
    const result = await setOnlineCpu(game, code, playerToken, action, seat);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof OnlineRoomError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "CPUを操作できませんでした" }, { status: 500 });
  }
}
