import { NextResponse } from "next/server";
import { LllError, parseTeamBody, setTeam } from "@/lib/lll-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** チーム（3枚）保存。 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  try {
    const { token, teamIds } = parseTeamBody(body);
    const profile = await setTeam(token, teamIds);
    return NextResponse.json({ profile });
  } catch (error) {
    if (error instanceof LllError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "チームを保存できませんでした" }, { status: 500 });
  }
}
