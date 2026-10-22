import { NextResponse } from "next/server";

export const runtime = "nodejs";

const baseUrl = (process.env.LOGFARE_BASE_URL || "https://logfare.ai/v1").replace(/\/$/, "");

export async function POST(request: Request) {
  const session = request.headers.get("cookie")?.match(/(?:^|;\s*)ago_discord_user=([^;]+)/)?.[1];
  if (!session) {
    return NextResponse.json({ error: "AGO Coderを使うには先にDiscordでログインしてください。" }, { status: 401 });
  }
  const apiKey = process.env.LOGFARE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Logfare APIキーがWebサーバーに設定されていません。管理者に LOGFARE_API_KEY の設定を依頼してください。" }, { status: 503 });
  }

  let body: { model?: string; mode?: string; prompt?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエスト形式が不正です。" }, { status: 400 });
  }

  const prompt = String(body.prompt || "").trim();
  const model = String(body.model || process.env.LOGFARE_DEFAULT_MODEL || "logfare/auto").trim();
  const mode = body.mode === "build" ? "build" : "plan";
  if (!prompt || prompt.length > 4000) {
    return NextResponse.json({ error: "指示は1〜4000文字で入力してください。" }, { status: 400 });
  }

  const system = mode === "build"
    ? "あなたはAGO CoderのBuildエージェントです。日本語で、実装方針・変更対象・確認方法を具体的に説明してください。現段階では実際のファイル編集やシェル実行はできないため、実行可能な手順と差分案を返してください。秘密情報を要求せず、破壊的操作は明示的に確認してください。"
    : "あなたはAGO CoderのPlanエージェントです。日本語でコードベースを調査する前提の実装計画を作ってください。前提、変更対象、リスク、検証方法を簡潔に整理してください。実際のファイル編集やシェル実行はしません。";

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
        max_tokens: 1400,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const text = await response.text();
    if (!response.ok) return NextResponse.json({ error: `Logfare API error ${response.status}: ${text.slice(0, 240)}` }, { status: 502 });
    const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
    const answer = String(data.choices?.[0]?.message?.content || "").trim();
    if (!answer) return NextResponse.json({ error: "Logfareから回答本文が返りませんでした。" }, { status: 502 });
    return NextResponse.json({ answer, model, mode });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Logfareへの接続に失敗しました。";
    return NextResponse.json({ error: message.slice(0, 300) }, { status: 502 });
  }
}
