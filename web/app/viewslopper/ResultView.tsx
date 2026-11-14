"use client";

import { useState } from "react";

// 診断結果の表示専用コンポーネント。診断画面と保存画面（履歴）で共有する。

type Dimension = { key: string; label: string; score: number; weight: number; hits: number };
type Diagnosis = { dimension: string; label: string; evidence: string; why: string; fix: string };
type UxFinding = { axis: string; severity: "high" | "mid" | "low"; evidence: string; why: string; fix: string };
type UxSignals = {
  navLinkCount: number; totalLinks: number; h1Count: number; images: number;
  imagesMissingAlt: number; inputs: number; inputsMissingLabel: number; hasViewport: boolean;
};

export type ViewResult = {
  url: string;
  title: string;
  textChars: number;
  score: number;
  grade: string;
  dimensions: Dimension[];
  diagnosis: Diagnosis[];
  diagnosisSource: "llm" | "rules";
  scoreSource?: "llm" | "rules";
  rendered?: boolean;
  ux: { friction: number; grade: string; findings: UxFinding[]; signals: UxSignals };
  appearance?: { score: number; grade: string; findings: UxFinding[]; screenshotUrl: string } | null;
};

const SEVERITY_LABEL: Record<UxFinding["severity"], string> = { high: "重大", mid: "中", low: "軽微" };
const SEVERITY_COLOR: Record<UxFinding["severity"], string> = { high: "#e5484d", mid: "#e5b83b", low: "#8a8f98" };

export function scoreColor(score: number): string {
  if (score < 20) return "#46a758";
  if (score < 40) return "#8ece5a";
  if (score < 60) return "#e5b83b";
  if (score < 80) return "#e57c3b";
  return "#e5484d";
}

export default function ResultView({ result, savedAt }: { result: ViewResult; savedAt?: number }) {
  const [cardUrl, setCardUrl] = useState("");
  const [cardName, setCardName] = useState("");

  async function makeCard() {
    const { drawScoreCard, buildCardFileName } = await import("@/lib/viewslopper-card");
    const canvas = document.createElement("canvas");
    drawScoreCard(canvas, {
      url: result.url,
      title: result.title,
      score: result.score,
      grade: result.grade,
      dimensions: result.dimensions.map((d) => ({ label: d.label, score: d.score })),
      uxFriction: result.ux?.friction ?? null,
      uxGrade: result.ux?.grade ?? "",
      appearanceScore: result.appearance?.score ?? null,
      appearanceGrade: result.appearance?.grade ?? "",
      scoreSource: result.scoreSource,
      rendered: result.rendered,
      date: savedAt ? new Date(savedAt) : new Date(),
    });
    setCardName(buildCardFileName(result.url, result.score));
    setCardUrl(canvas.toDataURL("image/png"));
  }

  return (
    <section aria-label="診断結果" style={{ marginTop: 28 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
                <span style={{ fontSize: 56, fontWeight: 800, color: scoreColor(result.score), lineHeight: 1 }}>
                  {result.score}
                </span>
                <span style={{ fontSize: 18, fontWeight: 700 }}>{result.grade}</span>
                <span style={{ color: "#8a8f98", fontSize: 13 }}>Slop Score</span>
              </div>
              <p style={{ color: "#b6bac2", margin: "10px 0 0", lineHeight: 1.6 }}>
                {result.title || result.url}
              </p>
              <div style={{ marginTop: 20, display: "grid", gap: 10 }}>
                {result.dimensions.map((d) => (
                  <div key={d.key} style={{ display: "grid", gridTemplateColumns: "130px 1fr 36px", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 13, color: "#d6d9de" }}>{d.label}</span>
                    <span style={{ height: 10, borderRadius: 5, background: "#23252a", overflow: "hidden" }}>
                      <span style={{ display: "block", height: "100%", width: `${d.score}%`, background: scoreColor(d.score) }} />
                    </span>
                    <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{d.score}</span>
                  </div>
                ))}
              </div>
              <h2 style={{ fontSize: 18, margin: "28px 0 12px" }}>診断</h2>
              <div style={{ display: "grid", gap: 12 }}>
                {result.diagnosis.map((item, i) => (
                  <article key={i} style={{ border: "1px solid #23252a", borderRadius: 12, padding: "14px 16px", background: "#121316" }}>
                    <p style={{ margin: 0, fontWeight: 700 }}>{item.label}</p>
                    {item.evidence && (
                      <blockquote style={{ margin: "8px 0", padding: "8px 12px", borderLeft: "3px solid #e5484d", background: "#17191c", color: "#d6d9de", lineHeight: 1.6 }}>
                        {item.evidence}
                      </blockquote>
                    )}
                    <p style={{ margin: "6px 0", lineHeight: 1.7 }}>{item.why}</p>
                    <p style={{ margin: 0, color: "#b6bac2", lineHeight: 1.7 }}>直し方: {item.fix}</p>
                  </article>
                ))}
              </div>
              <p style={{ color: "#6d7278", fontSize: 12, marginTop: 14 }}>
                {result.scoreSource === "llm" ? "AI採点" : "ルール採点"}
                {result.rendered ? " ・ 描画経由" : ""}
              </p>

              <h2 style={{ fontSize: 18, margin: "32px 0 12px" }}>UX・配置</h2>
              <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
                <span style={{ fontSize: 40, fontWeight: 800, color: scoreColor(result.ux.friction), lineHeight: 1 }}>
                  {result.ux.friction}
                </span>
                <span style={{ fontSize: 16, fontWeight: 700 }}>{result.ux.grade}</span>
              </div>
              {result.ux.findings.length === 0 ? (
                <p style={{ color: "#b6bac2", marginTop: 12 }}>目立った摩擦はありません。</p>
              ) : (
                <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
                  {result.ux.findings.map((f, i) => (
                    <article key={i} style={{ border: "1px solid #23252a", borderRadius: 12, padding: "14px 16px", background: "#121316" }}>
                      <p style={{ margin: 0, fontWeight: 700 }}>
                        <span style={{ color: SEVERITY_COLOR[f.severity], fontSize: 12, border: `1px solid ${SEVERITY_COLOR[f.severity]}`, borderRadius: 999, padding: "2px 8px", marginRight: 8 }}>
                          {SEVERITY_LABEL[f.severity]}
                        </span>
                        {f.axis}
                      </p>
                      <p style={{ margin: "8px 0 0", color: "#d6d9de" }}>{f.evidence}</p>
                      <p style={{ margin: "6px 0", lineHeight: 1.7 }}>{f.why}</p>
                      <p style={{ margin: 0, color: "#b6bac2", lineHeight: 1.7 }}>直し方: {f.fix}</p>
                    </article>
                  ))}
                </div>
              )}
              <h2 style={{ fontSize: 18, margin: "32px 0 12px" }}>外観</h2>
              {result.appearance ? (
                <>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 40, fontWeight: 800, color: scoreColor(result.appearance.score), lineHeight: 1 }}>
                      {result.appearance.score}
                    </span>
                    <span style={{ fontSize: 16, fontWeight: 700 }}>{result.appearance.grade}</span>
                    <span style={{ color: "#8a8f98", fontSize: 13 }}>外観スコア</span>
                  </div>
                  {/* 採点に使った描画画像そのもの。署名付きURLで数時間で失効する */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={result.appearance.screenshotUrl}
                    alt="採点に使ったページのスクリーンショット"
                    style={{ width: "100%", borderRadius: 12, border: "1px solid #23252a", marginTop: 14 }}
                  />
                  {result.appearance.findings.length === 0 ? (
                    <p style={{ color: "#b6bac2", marginTop: 12 }}>目立った問題はありません。</p>
                  ) : (
                    <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
                      {result.appearance.findings.map((f, i) => (
                        <article key={i} style={{ border: "1px solid #23252a", borderRadius: 12, padding: "14px 16px", background: "#121316" }}>
                          <p style={{ margin: 0, fontWeight: 700 }}>
                            <span style={{ color: SEVERITY_COLOR[f.severity], fontSize: 12, border: `1px solid ${SEVERITY_COLOR[f.severity]}`, borderRadius: 999, padding: "2px 8px", marginRight: 8 }}>
                              {SEVERITY_LABEL[f.severity]}
                            </span>
                            {f.axis}
                          </p>
                          <p style={{ margin: "8px 0 0", color: "#d6d9de" }}>{f.evidence}</p>
                          <p style={{ margin: "6px 0", lineHeight: 1.7 }}>{f.why}</p>
                          <p style={{ margin: 0, color: "#b6bac2", lineHeight: 1.7 }}>直し方: {f.fix}</p>
                        </article>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <p style={{ color: "#b6bac2" }}>外観は採点できませんでした。</p>
              )}

          <div style={{ marginTop: 32, borderTop: "1px solid #23252a", paddingTop: 20 }}>
            <button
              type="button"
              onClick={() => void makeCard()}
              style={{ padding: "12px 20px", borderRadius: 10, border: "none", fontWeight: 700, fontSize: 15, background: "#f2f3f5", color: "#17191c", cursor: "pointer" }}
            >
              16:9カード画像を作る
            </button>
            {cardUrl && (
              <div style={{ marginTop: 16 }}>
                {/* 生成したカードのプレビュー。iPhone では長押しでも保存できる */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={cardUrl} alt="診断結果の16:9カード画像" style={{ width: "100%", borderRadius: 12, border: "1px solid #23252a" }} />
                <p style={{ marginTop: 10, fontSize: 13 }}>
                  <a href={cardUrl} download={cardName} style={{ color: "#d6d9de" }}>
                    画像を保存する
                  </a>
                  <span style={{ color: "#6d7278" }}>（長押しでも保存できます）</span>
                </p>
              </div>
            )}
          </div>
            </section>
  );
}
