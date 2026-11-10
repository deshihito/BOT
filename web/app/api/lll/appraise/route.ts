import { NextResponse } from "next/server";
import { LllError, appraise, parseAppraiseBody } from "@/lib/lll-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 画像スカウト（鑑定）。新規カード生成、または同一画像なら欠片変換。 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  try {
    const { token, features, imageDataUrl } = parseAppraiseBody(body);
    const result = await appraise(token, features, imageDataUrl);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof LllError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "鑑定できませんでした" }, { status: 500 });
  }
}
