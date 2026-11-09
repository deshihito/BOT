import { NextResponse } from "next/server";
import { parseBatchResultBody, parseResultBody } from "@/lib/compute-core";
import { allowComputeRequest, computeClientKey, isComputeConfigured, submitComputeResult, submitComputeResults } from "@/lib/compute-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 計算結果を受け付ける。サーバー側で正解値と照合し、
 * 一致したものだけを集計に加える（タスクIDで冪等）。
 */
export async function POST(request: Request) {
  if (!isComputeConfigured()) {
    return NextResponse.json({ error: "現在利用できません" }, { status: 503 });
  }
  if (!allowComputeRequest("result", computeClientKey(request))) {
    return NextResponse.json({ error: "リクエストが多すぎます。少し待ってから再試行してください" }, { status: 429 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  // バッチ提出: { results: [...] } はまとめて照合する（読み書き1回）。
  // 項目ごとの成否は results の status で返す。不正な項目が1つでもあれば全体を 400 にする。
  const batch = parseBatchResultBody(body);
  if (batch) {
    try {
      const { outcomes, progress } = await submitComputeResults(batch);
      return NextResponse.json({
        results: outcomes.map((o) => ({ taskId: o.taskId, status: o.outcome })),
        progress,
      });
    } catch {
      return NextResponse.json({ error: "結果を受け付けられませんでした" }, { status: 503 });
    }
  }
  const parsed = parseResultBody(body);
  if (!parsed) {
    return NextResponse.json({ error: "リクエストの形式が正しくありません" }, { status: 400 });
  }
  try {
    const result = await submitComputeResult(parsed.taskId, parsed.nodes, parsed.token);
    if (result.outcome === "unknown_task") {
      return NextResponse.json({ error: "不明なタスクです" }, { status: 400 });
    }
    if (result.outcome === "mismatch") {
      return NextResponse.json({ status: "mismatch", progress: result.progress }, { status: 422 });
    }
    return NextResponse.json({ status: result.outcome, progress: result.progress });
  } catch {
    return NextResponse.json({ error: "結果を受け付けられませんでした" }, { status: 503 });
  }
}
