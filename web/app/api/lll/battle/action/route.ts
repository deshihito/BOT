import { NextResponse } from "next/server";
import { LllError, battleAction, parseBattleActionBody } from "@/lib/lll-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 行動を適用する。CPU 行動まで進めた状態と、最新のプロフィールを返す。 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  try {
    const { token, battleId, action } = parseBattleActionBody(body);
    const result = await battleAction(token, battleId, action);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof LllError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "操作を処理できませんでした" }, { status: 500 });
  }
}
