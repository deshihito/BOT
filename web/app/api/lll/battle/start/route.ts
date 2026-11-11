import { NextResponse } from "next/server";
import { LllError, parseBattleStartBody, startBattle } from "@/lib/lll-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ラダー対戦開始。初期状態を返す。 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  try {
    const { token, tierIndex, tacticDeckId } = parseBattleStartBody(body);
    const result = await startBattle(token, tierIndex, tacticDeckId);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof LllError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "対戦を開始できませんでした" }, { status: 500 });
  }
}
