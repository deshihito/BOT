"use client";

import { useState } from "react";

type Dimension = { key: string; label: string; score: number; weight: number; hits: number };
type Diagnosis = { dimension: string; label: string; evidence: string; why: string; fix: string };
type Result = {
  url: string;
  title: string;
  textChars: number;
  score: number;
  grade: string;
  dimensions: Dimension[];
  diagnosis: Diagnosis[];
  diagnosisSource: "llm" | "rules";
};

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
        </section>
      )}
    </div>
  );
}
