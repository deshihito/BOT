"use client";

import { useState } from "react";
import ResultView, { type ViewResult } from "./ResultView";
import { saveHistory, toHistoryEntry } from "@/lib/viewslopper-history";

export default function ViewslopperClient() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ViewResult | null>(null);
  const [savedNote, setSavedNote] = useState("");

  async function run() {
    const target = url.trim();
    if (!target || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    setSavedNote("");
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
      const typed = data as ViewResult;
      setResult(typed);
      try {
        saveHistory(window.localStorage, toHistoryEntry(typed, Date.now()));
        setSavedNote("この端末に保存しました（下の「保存した診断」から見返せます）");
      } catch {
        // 保存できなくても診断結果の表示は続ける
      }
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
      {savedNote && (
        <p style={{ color: "#8a8f98", fontSize: 13, marginTop: 14 }}>{savedNote}</p>
      )}
      {result && <ResultView result={result} />}

    </div>
  );
}
