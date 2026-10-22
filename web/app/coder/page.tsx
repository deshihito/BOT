"use client";

import { FormEvent, useMemo, useState } from "react";

const models = [
  { id: "logfare/auto", name: "Logfare Auto", note: "用途に合わせて自動選択" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", note: "高速・軽量" },
  { id: "qwen3.8-27b", name: "Qwen 3.8 27B", note: "長い文脈と実装" },
];

const initialEvents = [
  { tone: "done", label: "Session ready", detail: "AGOBOT / workspace" },
  { tone: "done", label: "Context loaded", detail: "web · 14 files" },
  { tone: "idle", label: "Waiting for your instruction", detail: "Plan mode" },
];

export default function CoderPage() {
  const [mode, setMode] = useState<"plan" | "build">("plan");
  const [model, setModel] = useState(models[0].id);
  const [prompt, setPrompt] = useState("");
  const [events, setEvents] = useState(initialEvents);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selectedModel = useMemo(() => models.find((item) => item.id === model) ?? models[0], [model]);

  async function runAgent(event: FormEvent) {
    event.preventDefault();
    const instruction = prompt.trim();
    if (!instruction || busy) return;
    setBusy(true);
    setError("");
    setAnswer("");
    setEvents((current) => [
      ...current.filter((item) => item.label !== "Waiting for your instruction"),
      { tone: "running", label: mode === "plan" ? "Planning task" : "Building changes", detail: instruction.slice(0, 64) },
    ]);
    try {
      const response = await fetch("/api/coder/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, mode, prompt: instruction }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Logfareの実行に失敗しました。");
      setAnswer(data.answer || "回答本文がありませんでした。");
      setEvents((current) => [
        ...current.filter((item) => item.tone !== "running"),
        { tone: "done", label: "Agent finished", detail: `${selectedModel.name} · ${mode === "plan" ? "plan" : "build"}` },
      ]);
      setPrompt("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "実行に失敗しました。");
      setEvents((current) => [
        ...current.filter((item) => item.tone !== "running"),
        { tone: "error", label: "Agent stopped", detail: "設定とLogfare接続を確認してください" },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="coder-shell">
      <header className="coder-header">
        <div className="coder-title-wrap">
          <a href="/dashboard" className="coder-back">←</a>
          <div><p className="eyebrow">AGO CODER / BETA</p><h1>作業セッション</h1></div>
          <span className="coder-session-status"><span className="status-dot status-dot-live" /> ready</span>
        </div>
        <div className="coder-header-actions"><button className="coder-quiet-button" type="button">⌘ K <span>コマンド</span></button><a href="/login" className="coder-login-link">Discordでログイン</a></div>
      </header>

      <div className="coder-workspace">
        <aside className="coder-sidebar">
          <div className="coder-side-section"><div className="coder-section-label">SESSION</div><div className="coder-session-card"><span className="status-dot status-dot-live" /><div><strong>新しい作業</strong><small>たった今 · main</small></div><span className="coder-more">···</span></div><button className="coder-new-session" type="button">＋ 新しいセッション</button></div>
          <div className="coder-side-section"><div className="coder-section-label">CONTEXT</div><div className="coder-tree"><div>⌄ <strong>AGOBOT</strong></div><div className="tree-indent">⌄ <span>web</span></div><div className="tree-indent tree-active">◈ <span>dashboard</span></div><div className="tree-indent tree-muted">◌ app</div><div className="tree-indent tree-muted">◌ core</div><div className="tree-indent tree-muted">◌ cogs</div></div></div>
          <div className="coder-side-section coder-side-bottom"><div className="coder-section-label">SHORTCUTS</div><p className="coder-shortcut"><kbd>@</kbd> ファイルを参照</p><p className="coder-shortcut"><kbd>!</kbd> コマンドを実行</p><p className="coder-shortcut"><kbd>Tab</kbd> エージェント切替</p></div>
        </aside>

        <section className="coder-main">
          <div className="coder-main-head"><div><span className="coder-kicker">WORKSPACE / WEB</span><h2>何を作りますか？</h2><p>計画を立てるか、実装を進めるかを選んでください。</p></div><div className="coder-mode-switch" role="tablist" aria-label="エージェントモード"><button type="button" className={mode === "plan" ? "active" : ""} onClick={() => setMode("plan")}>Plan <small>分析・提案</small></button><button type="button" className={mode === "build" ? "active" : ""} onClick={() => setMode("build")}>Build <small>実装・変更</small></button></div></div>
          <div className="coder-answer-area">{answer ? <div className="coder-answer"><div className="coder-answer-meta"><span className="status-dot status-dot-live" /> AGOBOT / {selectedModel.name}</div><p>{answer}</p></div> : <div className="coder-empty"><div className="coder-prompt-mark">✦</div><p>{mode === "plan" ? "コードベースを読んで、実装方針を整理します。" : "変更を作り、結果を確認しながら進めます。"}</p><small>例: 「ダッシュボードにGitHubリポジトリ一覧を追加して」</small></div>}</div>
          <form className="coder-composer" onSubmit={runAgent}><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={mode === "plan" ? "調査したいことや作りたいものを入力…" : "実装したいことを入力…"} rows={4} disabled={busy} /><div className="coder-composer-footer"><span><kbd>Enter</kbd> 実行　<kbd>Shift</kbd>+<kbd>Enter</kbd> 改行</span><button type="submit" disabled={busy || !prompt.trim()}>{busy ? "実行中…" : mode === "plan" ? "計画する ↗" : "実装する ↗"}</button></div></form>{error && <p className="coder-error">{error}</p>}
        </section>

        <aside className="coder-inspector"><div className="coder-inspector-block"><div className="coder-section-label">MODEL</div><select value={model} onChange={(event) => setModel(event.target.value)}>{models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><p className="coder-inspector-note">{selectedModel.note} · Logfare経由</p></div><div className="coder-inspector-block"><div className="coder-section-label">PERMISSIONS</div><div className="permission-row"><span>read</span><b className="permission-allow">allow</b></div><div className="permission-row"><span>web search</span><b className="permission-allow">allow</b></div><div className="permission-row"><span>edit</span><b className={mode === "build" ? "permission-ask" : "permission-deny"}>{mode === "build" ? "ask" : "deny"}</b></div><div className="permission-row"><span>shell</span><b className="permission-ask">ask</b></div></div><div className="coder-inspector-block"><div className="coder-section-label">ACTIVITY</div><div className="coder-events">{events.map((item, index) => <div className="coder-event" key={`${item.label}-${index}`}><span className={`status-dot status-dot-${item.tone}`} /><div><strong>{item.label}</strong><small>{item.detail}</small></div></div>)}</div></div><div className="coder-inspector-block github-setup-card"><div className="coder-section-label">GITHUB</div><strong>リポジトリを接続</strong><p>GitHubコネクタを設定すると、ここからリポジトリとPRを扱えます。</p><a href="/login#github" className="coder-inline-link">セットアップ手順を見る →</a></div></aside>
      </div>
    </div>
  );
}
