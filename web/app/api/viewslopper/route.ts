import { NextResponse } from "next/server";
import { scorePage, scoreUx, validateViewUrl } from "@/lib/viewslopper";
import { ViewFetchError, assess, assessAppearance, diagnose, fetchPage } from "@/lib/viewslopper-server";

export const runtime = "nodejs";
export const maxDuration = 60;

// viewslopper の診断エンドポイント。
// POST { url } → サーバー側でページを取得（SPA の殻しか取れない場合は描画経由で
// 取り直す）し、採点の判断は LLM（ds1017）に寄せ、合計の集計だけコードで行う。
// LLM が使えない場合は従来の決定的採点＋ルールベース診断にフォールバックする。
// どちらの経路かは scoreSource で返す。

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
    const heuristic = scorePage(page);
    const heuristicUx = scoreUx(page.ux);
    // 本文採点と外観採点は独立に走らせる（外観はスクショ＋vision で時間がかかる）。
    const [assessed, appearanceOutcome] = await Promise.all([
      assess(page, heuristic),
      assessAppearance(page),
    ]);
    const appearance = appearanceOutcome
      ? { ...appearanceOutcome.result, screenshotUrl: appearanceOutcome.screenshotUrl }
      : null;
    if (assessed) {
      return NextResponse.json({
        url: page.url,
        title: page.title,
        description: page.description,
        headings: page.headings,
        textChars: page.text.length,
        rendered: page.rendered === true,
        score: assessed.total,
        grade: assessed.grade,
        dimensions: assessed.dimensions,
        diagnosis: assessed.diagnosis,
        diagnosisSource: "llm",
        scoreSource: "llm",
        ux: { friction: assessed.uxFriction, grade: assessed.uxGrade, findings: assessed.uxFindings, signals: page.ux },
        appearance,
      });
    }
    const diagnosis = await diagnose(page, heuristic);
    return NextResponse.json({
      url: page.url,
      title: page.title,
      description: page.description,
      headings: page.headings,
      textChars: page.text.length,
      rendered: page.rendered === true,
      score: heuristic.total,
      grade: heuristic.grade,
      dimensions: heuristic.dimensions,
      diagnosis: diagnosis.items,
      diagnosisSource: diagnosis.llm ? "llm" : "rules",
      scoreSource: "rules",
      ux: { friction: heuristicUx.friction, grade: heuristicUx.grade, findings: heuristicUx.findings, signals: page.ux },
      appearance,
    });
  } catch (error) {
    if (error instanceof ViewFetchError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    console.error("viewslopper: diagnose failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "診断に失敗しました。" }, { status: 500 });
  }
}
