import { NextResponse } from "next/server";
import { scorePage, scoreUx, validateViewUrl } from "@/lib/viewslopper";
import { ViewFetchError, diagnose, fetchPage } from "@/lib/viewslopper-server";

export const runtime = "nodejs";
export const maxDuration = 60;

// viewslopper の診断エンドポイント。
// POST { url } → サーバー側でページを取得し、決定的な計算で Slop Score を出し、
// 診断文だけを LLM（ds1017）に書かせる。LLM が使えない場合はルールベース診断で返す。
// スコアは LLM の成否で変わらない。

function publicOrigin(request: Request) {
  const url = new URL(request.url);
  const protocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.slice(0, -1);
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || request.headers.get("host") || url.host;
  return `${protocol}://${host}`;
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== publicOrigin(request)) {
    return NextResponse.json({ error: "リクエストを確認できません。" }, { status: 403 });
  }
  let body: { url?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "入力を確認できません。" }, { status: 400 });
  }
  const url = validateViewUrl(body.url);
  if (!url) {
    return NextResponse.json({ error: "URLを確認してください（http/https の公開ページのみ）。" }, { status: 400 });
  }
  try {
    const page = await fetchPage(url);
    const score = scorePage(page);
    const ux = scoreUx(page.ux);
    const diagnosis = await diagnose(page, score);
    return NextResponse.json({
      url: page.url,
      title: page.title,
      description: page.description,
      headings: page.headings,
      textChars: page.text.length,
      score: score.total,
      grade: score.grade,
      dimensions: score.dimensions,
      diagnosis: diagnosis.items,
      diagnosisSource: diagnosis.llm ? "llm" : "rules",
      ux: { friction: ux.friction, grade: ux.grade, findings: ux.findings, signals: page.ux },
    });
  } catch (error) {
    if (error instanceof ViewFetchError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    console.error("viewslopper: diagnose failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "診断に失敗しました。" }, { status: 500 });
  }
}
