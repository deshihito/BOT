"use client";

import { useState } from "react";

type Dimension = { key: string; label: string; score: number; weight: number; hits: number };
type Diagnosis = { dimension: string; label: string; evidence: string; why: string; fix: string };
type UxFinding = { axis: string; severity: "high" | "mid" | "low"; evidence: string; why: string; fix: string };
type UxSignals = {
  navLinkCount: number; totalLinks: number; h1Count: number; images: number;
  imagesMissingAlt: number; inputs: number; inputsMissingLabel: number; hasViewport: boolean;
};
type Result = {
  url: string;
  title: string;
  textChars: number;
  score: number;
  grade: string;
  dimensions: Dimension[];
  diagnosis: Diagnosis[];
  diagnosisSource: "llm" | "rules";
  ux: { friction: number; grade: string; findings: UxFinding[]; signals: UxSignals };
};

const SEVERITY_LABEL: Record<UxFinding["severity"], string> = { high: "重大", mid: "中", low: "軽微" };
const SEVERITY_COLOR: Record<UxFinding["severity"], string> = { high: "#e5484d", mid: "#e5b83b", low: "#8a8f98" };

function scoreColor(score: number): string {
  if (score < 20) return "#46a758";
  if (score < 40) return "#8ece5a";
  if (score < 60) return "#e5b83b";
  if (score < 80) return "#e57c3b";
  return "#e5484d";
}

export default function ViewslopperClient() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  async function run() {
    const target = url.trim();
    if (!target || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/viewslopper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: target }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "診断に失敗しました。");
        return;
      }
      setResult(data as Result);
    } catch {
      setError("診断に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="url"
          inputMode="url"
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
          }}
          aria-label="診断するURL"
          style={{
            flex: 1, minWidth: 0, padding: "12px 14px", borderRadius: 10, border: "1px solid #2c2f36",
            background: "#17191c", color: "#f2f3f5", fontSize: 16,
          }}
        />
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy || !url.trim()}
          style={{
            padding: "12px 20px", borderRadius: 10, border: "none", fontWeight: 700, fontSize: 16,
            background: busy || !url.trim() ? "#2c2f36" : "#f2f3f5",
            color: busy || !url.trim() ? "#8a8f98" : "#17191c",
            cursor: busy || !url.trim() ? "default" : "pointer",
          }}
        >
          {busy ? "診断中…" : "測る"}
        </button>
      </div>
      {error && (
        <p role="alert" style={{ color: "#ff9c9f", marginTop: 14 }}>
          {error}
        </p>
      )}
      {result && (
        <section aria-label="診断結果" style={{ marginTop: 28 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
            <span style={{ fontSize: 56, fontWeight: 800, color: scoreColor(result.score), lineHeight: 1 }}>
              {result.score}
            </span>
            <span style={{ fontSize: 18, fontWeight: 700 }}>{result.grade}</span>
            <span style={{ color: "#8a8f98", fontSize: 13 }}>Slop Score（0–100、高いほど slop）</span>
          </div>
          <p style={{ color: "#b6bac2", margin: "10px 0 0", lineHeight: 1.6 }}>
            {result.title || result.url}（本文 {result.textChars.toLocaleString()} 字を採点）
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
            診断文の出所: {result.diagnosisSource === "llm" ? "AI（スコアは計算で固定）" : "ルールベース（AI不使用）"}
          </p>

          <h2 style={{ fontSize: 18, margin: "32px 0 12px" }}>UX・配置</h2>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
            <span style={{ fontSize: 40, fontWeight: 800, color: scoreColor(result.ux.friction), lineHeight: 1 }}>
              {result.ux.friction}
            </span>
            <span style={{ fontSize: 16, fontWeight: 700 }}>{result.ux.grade}</span>
            <span style={{ color: "#8a8f98", fontSize: 13 }}>UX摩擦スコア（0–100、高いほど摩擦が大きい）</span>
          </div>
          <p style={{ color: "#8a8f98", fontSize: 13, margin: "10px 0 0" }}>
            ナビ内リンク {result.ux.signals.navLinkCount} 本 / 全リンク {result.ux.signals.totalLinks} 本 / h1 {result.ux.signals.h1Count} 個
            / 画像 {result.ux.signals.images} 枚（alt無し {result.ux.signals.imagesMissingAlt}）
            / 入力欄 {result.ux.signals.inputs} 件（ラベル無し {result.ux.signals.inputsMissingLabel}）
            / viewport {result.ux.signals.hasViewport ? "あり" : "なし"}
          </p>
          {result.ux.findings.length === 0 ? (
            <p style={{ color: "#b6bac2", marginTop: 12 }}>構造から見える範囲では、目立った摩擦は検出されませんでした。</p>
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
          <p style={{ color: "#6d7278", fontSize: 12, marginTop: 14 }}>
            UX・配置は実レンダリングなしで、HTMLの構造から数えられる事実だけで診断しています。
          </p>
        </section>
      )}
    </div>
  );
}
