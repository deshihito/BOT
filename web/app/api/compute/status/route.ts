import { NextResponse } from "next/server";
import { getComputeStatus, isComputeConfigured } from "@/lib/compute-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 分散コンピューティング全体の進捗（公開・読み取りのみ）。
 * 現在のスイートの進捗に加え、過去スイートの実績（history）を返す。
 */
export async function GET() {
  if (!isComputeConfigured()) {
    return NextResponse.json({ error: "現在利用できません" }, { status: 503 });
  }
  try {
    const { progress, history } = await getComputeStatus();
    return NextResponse.json({ progress, history });
  } catch {
    return NextResponse.json({ error: "進捗を取得できませんでした" }, { status: 503 });
  }
}
