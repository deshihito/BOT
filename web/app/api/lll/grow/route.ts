import { NextResponse } from "next/server";
import { LllError, exchangeLumen, growCard, parseGrowBody } from "@/lib/lll-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 強化。{token, cardId} でレベルアップ、{token, action:"exchange"} でルーメン両替。 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  try {
    const input = parseGrowBody(body);
    if (input.action === "exchange") {
      const result = await exchangeLumen(input.token);
      return NextResponse.json(result);
    }
    const result = await growCard(input.token, input.cardId);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof LllError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "強化できませんでした" }, { status: 500 });
  }
}
