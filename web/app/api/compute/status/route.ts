import { NextResponse } from "next/server";
import { getComputeProgress, isComputeConfigured } from "@/lib/compute-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 分散コンピューティング全体の進捗（公開・読み取りのみ）。 */
export async function GET() {
  if (!isComputeConfigured()) {
    return NextResponse.json({ error: "現在利用できません" }, { status: 503 });
  }
  try {
    const progress = await getComputeProgress();
    return NextResponse.json({ progress });
  } catch {
    return NextResponse.json({ error: "進捗を取得できませんでした" }, { status: 503 });
  }
}
