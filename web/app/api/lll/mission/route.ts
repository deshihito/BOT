import { NextResponse } from "next/server";
import { LllError, claimMission, parseMissionBody } from "@/lib/lll/lll-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** デイリーミッション / 実績報酬の受け取り。 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  try {
    const { token, kind, id } = parseMissionBody(body);
    const result = await claimMission(token, kind, id);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof LllError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "報酬を受け取れませんでした" }, { status: 500 });
  }
}
