import { NextResponse } from "next/server";
import { validateAnswers, validateRough } from "@/lib/one-prompter-llm";
import { generateQuestionsWithLlm, logfareApiKeys, synthesizeWithLlm } from "@/lib/one-prompter-server";

export const runtime = "nodejs";
export const maxDuration = 60;

// One Prompter の LLM 化エンドポイント。
// action=questions: 雑な一文から二択質問を生成する
// action=synthesize: 元の一文＋回答から完成プロンプトを合成する
// API キー未設定・LLM失敗時は { fallback: true } を返し、クライアントが
// ルールベース版（lib/one-prompter.ts）でそのまま続行する。ページは壊れない。

function publicOrigin(request: Request) {
  const url = new URL(request.url);
  const protocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.slice(0, -1);
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host") || url.host;
  return `${protocol}://${host}`;
}

function fallback() {
  return NextResponse.json({ fallback: true });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== publicOrigin(request)) {
    return NextResponse.json({ error: "リクエストを確認できません。" }, { status: 403 });
  }

  let body: { action?: unknown; rough?: unknown; answers?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "入力を確認できません。" }, { status: 400 });
  }

  const rough = validateRough(body.rough);
  if (!rough) {
    return NextResponse.json({ error: "入力を確認してください。" }, { status: 400 });
  }

  // キーが無い環境では最初からフォールバック（Web 用 env は Bot の .env と別）
  if (logfareApiKeys().length === 0) return fallback();

  try {
    if (body.action === "questions") {
      const questions = await generateQuestionsWithLlm(rough);
      if (!questions) return fallback();
      return NextResponse.json({ questions });
    }
    if (body.action === "synthesize") {
      const answers = validateAnswers(body.answers);
      if (!answers) {
        return NextResponse.json({ error: "入力を確認してください。" }, { status: 400 });
      }
      const prompt = await synthesizeWithLlm(rough, answers);
      if (!prompt) return fallback();
      return NextResponse.json({ prompt });
    }
    return NextResponse.json({ error: "入力を確認してください。" }, { status: 400 });
  } catch (error) {
    // プロバイダの応答本文やキーは出さず、失敗したことだけ記録してフォールバックに倒す
    console.error("one-prompter: Logfare call failed", error instanceof Error ? error.message : "unknown error");
    return fallback();
  }
}
