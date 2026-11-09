import { NextResponse } from "next/server";
import { parseLeaseBatchCount } from "@/lib/compute-core";
import { allowComputeRequest, computeClientKey, isComputeConfigured, leaseComputeTask, leaseComputeTaskBatch } from "@/lib/compute-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 計算タスクを貸し出す（リース発行）。
 * レスポンスに正解値は含まれない。貸し出せるタスクが無ければ done: true。
 * ボディに { count: n } (2〜16) があれば、複数タスクをまとめて貸し出す
 * （サーバー側の状態の読み書きが1回で済み、往復の待ち時間が減る）。
 */
export async function POST(request: Request) {
  if (!isComputeConfigured()) {
    return NextResponse.json({ error: "現在利用できません" }, { status: 503 });
  }
  if (!allowComputeRequest("task", computeClientKey(request))) {
    return NextResponse.json({ error: "リクエストが多すぎます。少し待ってから再試行してください" }, { status: 429 });
  }
  let batchCount: number | null = null;
  try {
    const text = await request.text();
    if (text) batchCount = parseLeaseBatchCount(JSON.parse(text));
  } catch {
    batchCount = null;
  }
  try {
    if (batchCount) {
      const batch = await leaseComputeTaskBatch(batchCount);
      if (!batch) {
        return NextResponse.json({ done: true });
      }
      return NextResponse.json({ tasks: batch.leases, progress: batch.progress });
    }
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
