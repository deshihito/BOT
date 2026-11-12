import { NextResponse } from "next/server";
import {
  validateAnswers,
  validatePromptInput,
  validateReviseInstruction,
  validateRough,
} from "@/lib/one-prompter-llm";
import {
  generateFollowupQuestionsWithLlm,
  generateQuestionsWithLlm,
  logfareApiKeys,
  reviseWithLlm,
  synthesizeWithLlm,
} from "@/lib/one-prompter-server";

export const runtime = "nodejs";
export const maxDuration = 60;

// One Prompter の LLM 化エンドポイント。
// action=questions: 「やりたいこと」から二択質問を生成する。任意フィールド count（3/5/8）で
//   1ラウンド目の質問数を指定できる（不正値は既定の5に丸める）。
//   任意フィールド answers（1ラウンド目の回答）を伴う場合は深掘り（2ラウンド目）:
//   まだ曖昧な箇所だけを狙う追加質問を最大3問返す。深掘り不要なら { questions: [] }。
// action=synthesize: 「やりたいこと」＋回答（1+2ラウンド合計で最大11件）から完成プロンプトを合成する
// action=revise: 現在の完成プロンプトを修正指示（200字以内）どおりに書き直す
// 任意フィールド lang（"ja" | "en" | "hybrid"）は synthesize / revise の出力言語モード。
// 不正値は hybrid に丸める。questions では使わない（質問は常に日本語）。
// 生成モデルは ds1017 固定（サーバー側 onePrompterModel、env で差し替え可）。
// 任意フィールド think（boolean）は「より考える」= 思考強度のオン。
// 全 LLM 呼び出しに伝播し、reasoning を "high" に上げる。
// true 以外（不正値・未指定）はオフに丸める。
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

  let body: {
    action?: unknown;
    rough?: unknown;
    answers?: unknown;
    count?: unknown;
    prompt?: unknown;
    instruction?: unknown;
    lang?: unknown;
    think?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "入力を確認できません。" }, { status: 400 });
  }

  // revise は rough を使わないので、先に捌く
  if (body.action === "revise") {
    const prompt = validatePromptInput(body.prompt);
    const instruction = validateReviseInstruction(body.instruction);
    if (!prompt || !instruction) {
      return NextResponse.json({ error: "入力を確認してください。" }, { status: 400 });
    }
    if (logfareApiKeys().length === 0) return fallback();
    try {
      const revised = await reviseWithLlm(prompt, instruction, { lang: body.lang, think: body.think });
      if (!revised) return fallback();
      return NextResponse.json({ prompt: revised });
    } catch (error) {
      console.error("one-prompter: Logfare call failed", error instanceof Error ? error.message : "unknown error");
      return fallback();
    }
  }

  const rough = validateRough(body.rough);
  if (!rough) {
    return NextResponse.json({ error: "入力を確認してください。" }, { status: 400 });
  }

  // キーが無い環境では最初からフォールバック（Web 用 env は Bot の .env と別）
  if (logfareApiKeys().length === 0) return fallback();

  try {
    if (body.action === "questions") {
      if (body.answers !== undefined) {
        // 深掘り（2ラウンド目）: 1ラウンド目の回答を文脈に、残りの曖昧な箇所だけを聞く。
        // 空配列は「深掘りなし」の正常系なので fallback と区別して返す。
        const priorAnswers = validateAnswers(body.answers);
        if (!priorAnswers) {
          return NextResponse.json({ error: "入力を確認してください。" }, { status: 400 });
        }
        const followups = await generateFollowupQuestionsWithLlm(rough, priorAnswers, { think: body.think });
        if (!followups) return fallback();
        return NextResponse.json({ questions: followups });
      }
      const questions = await generateQuestionsWithLlm(rough, { count: body.count, think: body.think });
      if (!questions) return fallback();
      return NextResponse.json({ questions });
    }
    if (body.action === "synthesize") {
      const answers = validateAnswers(body.answers);
      if (!answers) {
        return NextResponse.json({ error: "入力を確認してください。" }, { status: 400 });
      }
      const prompt = await synthesizeWithLlm(rough, answers, { lang: body.lang, think: body.think });
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
