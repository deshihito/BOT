"use client";

import { FormEvent, useState } from "react";

export default function CoderClient() {
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || busy) return;

    setBusy(true);
    setError("");
    setAnswer("");
    try {
      const response = await fetch("/api/coder/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: value }),
      });
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      const data = await response.json() as { answer?: string; error?: string };
      if (!response.ok || !data.answer) throw new Error(data.error || "回答を取得できません。");
      setAnswer(data.answer);
      setPrompt("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "回答を取得できません。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="coder-page">
      <div className="coder-heading"><h1>AGO Coder</h1><a href="/dashboard">戻る</a></div>
      <form className="coder-form" onSubmit={submit}>
        <textarea aria-label="入力" value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={busy} />
        <button type="submit" disabled={busy || !prompt.trim()}>{busy ? "送信中" : "送信"}</button>
      </form>
      {error ? <p className="coder-error" role="alert">{error}</p> : null}
      {answer ? <article className="coder-answer">{answer}</article> : null}
    </section>
  );
}
