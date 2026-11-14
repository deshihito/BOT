"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import ResultView, { scoreColor, type ViewResult } from "../ResultView";
import {
  clearHistory,
  loadHistory,
  removeHistoryEntry,
  type HistoryEntry,
} from "@/lib/viewslopper-history";

// 保存した診断の一覧画面。保存先はこの端末の localStorage だけ
// （サーバーに送らない）。別端末・別ブラウザでは見えない。
export default function ViewslopperHistoryPage() {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [openAt, setOpenAt] = useState<number | null>(null);

  useEffect(() => {
    setEntries(loadHistory(window.localStorage));
  }, []);

  function remove(savedAt: number) {
    setEntries(removeHistoryEntry(window.localStorage, savedAt));
    if (openAt === savedAt) setOpenAt(null);
  }

  function clearAll() {
    clearHistory(window.localStorage);
    setEntries([]);
    setOpenAt(null);
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "28px 20px 0" }}>
      <Link href="/viewslopper" style={{ color: "#8a8f98", fontSize: 13, textDecoration: "none" }}>
        ← 診断に戻る
      </Link>
      <h1 style={{ fontSize: 24, margin: "14px 0 6px" }}>保存した診断</h1>
      <p style={{ color: "#8a8f98", fontSize: 13, margin: "0 0 20px", lineHeight: 1.7 }}>
        この端末にだけ保存されています（最大50件、同じURLは最新のみ）。サーバーには送っていません。
      </p>
      {entries === null ? (
        <p style={{ color: "#8a8f98" }}>読み込み中…</p>
      ) : entries.length === 0 ? (
        <p style={{ color: "#b6bac2" }}>まだ保存された診断がありません。診断すると自動でここに残ります。</p>
      ) : (
        <>
          <div style={{ display: "grid", gap: 10 }}>
            {entries.map((e) => (
              <article
                key={e.savedAt}
                style={{ border: "1px solid #23252a", borderRadius: 12, padding: "12px 14px", background: "#121316" }}
              >
                <button
                  type="button"
                  onClick={() => setOpenAt(openAt === e.savedAt ? null : e.savedAt)}
                  style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", padding: 0, cursor: "pointer", color: "#f2f3f5" }}
                >
                  <span style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 26, fontWeight: 800, color: scoreColor(e.score), lineHeight: 1 }}>{e.score}</span>
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{e.grade}</span>
                    <span style={{ color: "#8a8f98", fontSize: 12 }}>
                      UX {e.uxFriction ?? "—"} / 外観 {e.appearanceScore ?? "—"}
                    </span>
                    <span style={{ color: "#8a8f98", fontSize: 12, marginLeft: "auto" }}>
                      {new Date(e.savedAt).toLocaleString("ja-JP")}
                    </span>
                  </span>
                  <span style={{ display: "block", marginTop: 6, fontSize: 14, lineHeight: 1.5, wordBreak: "break-all" }}>
                    {e.title || e.url}
                  </span>
                  {e.title && (
                    <span style={{ display: "block", color: "#8a8f98", fontSize: 12, wordBreak: "break-all" }}>{e.url}</span>
                  )}
                </button>
                {openAt === e.savedAt && (
                  <div style={{ marginTop: 6, borderTop: "1px solid #23252a" }}>
                    <ResultView result={e.result as ViewResult} savedAt={e.savedAt} />
                    <button
                      type="button"
                      onClick={() => remove(e.savedAt)}
                      style={{ marginTop: 14, padding: "8px 14px", borderRadius: 8, border: "1px solid #2c2f36", background: "none", color: "#ff9c9f", cursor: "pointer", fontSize: 13 }}
                    >
                      この診断を削除
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
          <button
            type="button"
            onClick={clearAll}
            style={{ marginTop: 20, padding: "8px 14px", borderRadius: 8, border: "1px solid #2c2f36", background: "none", color: "#8a8f98", cursor: "pointer", fontSize: 13 }}
          >
            すべて削除
          </button>
        </>
      )}
    </div>
  );
}
