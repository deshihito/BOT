import { NextResponse } from "next/server";
import { allowComputeRequest, computeClientKey, isComputeConfigured, leaseComputeTask } from "@/lib/compute-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 計算タスクを1つ貸し出す（リース発行）。
 * レスポンスに正解値は含まれない。貸し出せるタスクが無ければ done: true。
 */
export async function POST(request: Request) {
  if (!isComputeConfigured()) {
    return NextResponse.json({ error: "現在利用できません" }, { status: 503 });
  }
  if (!allowComputeRequest("task", computeClientKey(request))) {
    return NextResponse.json({ error: "リクエストが多すぎます。少し待ってから再試行してください" }, { status: 429 });
  }
  try {
    const leased = await leaseComputeTask();
    if (!leased) {
      return NextResponse.json({ done: true });
    }
    return NextResponse.json({
      taskId: leased.lease.taskId,
      fen: leased.lease.fen,
      depth: leased.lease.depth,
      leaseToken: leased.lease.leaseToken,
      expiresAt: leased.lease.expiresAt,
      progress: leased.progress,
    });
  } catch {
    return NextResponse.json({ error: "タスクを配布できませんでした" }, { status: 503 });
  }
}
