import { NextResponse } from "next/server";
import { LllError, battleAction, battleTactic, parseBattleActionBody } from "@/lib/lll-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 行動または戦術カードのプレイを適用する。進めた状態と最新のプロフィールを返す。 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  try {
    const parsed = parseBattleActionBody(body);
    const result =
      parsed.kind === "tactic"
        ? await battleTactic(parsed.token, parsed.battleId, parsed.cardId)
        : await battleAction(parsed.token, parsed.battleId, parsed.action);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof LllError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "操作を処理できませんでした" }, { status: 500 });
  }
}
