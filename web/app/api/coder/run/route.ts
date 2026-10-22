import { NextResponse } from "next/server";
import { getRequestUser } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 60;

function publicOrigin(request: Request) {
  const url = new URL(request.url);
  const protocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.slice(0, -1);
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host") || url.host;
  return `${protocol}://${host}`;
}

function coderEndpoint() {
  const baseUrl = process.env.BOT_CODER_BASE_URL;
  if (!baseUrl) return null;
  try {
    const url = new URL("/internal/coder/run", baseUrl);
    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const user = getRequestUser(request);
  if (!user) {
    return NextResponse.json({ error: "ログインしてください。" }, { status: 401 });
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== publicOrigin(request)) {
    return NextResponse.json({ error: "リクエストを確認できません。" }, { status: 403 });
  }

  let body: { prompt?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "入力を確認できません。" }, { status: 400 });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > 4000) {
    return NextResponse.json({ error: "入力を確認してください。" }, { status: 400 });
  }

  const endpoint = coderEndpoint();
  const serviceSecret = process.env.CODER_SERVICE_SHARED_SECRET;
  if (!endpoint || !serviceSecret) {
    return NextResponse.json({ error: "利用できません。" }, { status: 503 });
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt, user }),
      signal: AbortSignal.timeout(58_000),
    });
    if (!response.ok) return NextResponse.json({ error: "回答を取得できません。" }, { status: 502 });

    const data = await response.json() as { answer?: unknown };
    const answer = typeof data.answer === "string" ? data.answer.trim() : "";
    if (!answer) return NextResponse.json({ error: "回答を取得できません。" }, { status: 502 });
    return NextResponse.json({ answer });
  } catch {
    return NextResponse.json({ error: "回答を取得できません。" }, { status: 502 });
  }
}
