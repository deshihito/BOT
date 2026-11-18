import { NextResponse } from "next/server";
import { LllError, parseBattleStartBody, startAbyssBattle, startBattle, startPvpBattle } from "@/lib/lll/lll-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 対戦開始（ラダー / 深淵の試練 / 模擬PvP）。 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  try {
    const parsed = parseBattleStartBody(body);
    if (parsed.mode === "abyss") {
      return NextResponse.json(await startAbyssBattle(parsed.token, parsed.floor!, parsed.tacticDeckId));
    }
    if (parsed.mode === "pvp") {
      return NextResponse.json(await startPvpBattle(parsed.token, parsed.rivalId!, parsed.tacticDeckId));
    }
    const result = await startBattle(parsed.token, parsed.tierIndex, parsed.tacticDeckId);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof LllError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "対戦を開始できませんでした" }, { status: 500 });
  }
}
