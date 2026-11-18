import { NextResponse } from "next/server";
import { LllError, appraise, parseAppraiseBody, ticketSummon } from "@/lib/lll/lll-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 画像スカウト（鑑定）またはチケット召喚。 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  try {
    const parsed = parseAppraiseBody(body);
    if (parsed.ticketSummon) {
      const result = await ticketSummon(parsed.token);
      return NextResponse.json(result);
    }
    const result = await appraise(parsed.token, parsed.features!, parsed.imageDataUrl!);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof LllError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "鑑定できませんでした" }, { status: 500 });
  }
}
