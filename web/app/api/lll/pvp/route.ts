import { NextResponse } from "next/server";
import { LllError, listPvpRivals, parseToken } from "@/lib/lll/lll-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 模擬PvP対戦相手（ゴーストライバル一覧）の取得。 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  try {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new LllError(400, "リクエストの形式が正しくありません。");
    }
    const token = parseToken((body as Record<string, unknown>).token);
    const rivals = await listPvpRivals(token);
    return NextResponse.json({ rivals });
  } catch (error) {
    if (error instanceof LllError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "対戦相手を読み込めませんでした" }, { status: 500 });
  }
}
