import { NextResponse } from "next/server";
import { LllError, getBattle, parseBattleId, parseToken } from "@/lib/lll-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 対戦状態の取得（ポーリング用）。 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const battleId = parseBattleId((await params).id);
    const token = parseToken(new URL(request.url).searchParams.get("token"));
    const battle = await getBattle(token, battleId);
    return NextResponse.json({ battle });
  } catch (error) {
    if (error instanceof LllError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "対戦を取得できませんでした" }, { status: 500 });
  }
}
