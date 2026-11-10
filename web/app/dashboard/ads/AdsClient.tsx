"use client";

import { useCallback, useEffect, useState } from "react";
import { guildIconUrl } from "@/lib/dashboard-core";
import {
  AD_TEXT_MAX,
  REJECT_REASONS,
  normalizeInviteUrl,
  validateAdText,
  type AdApplication,
  type AdStatus,
} from "@/lib/ads-core";

type EligibleGuild = {
  id: string;
  name: string;
  icon: string | null;
  member_count: number;
  can_create: boolean;
};

const STATUS_LABEL: Record<AdStatus, string> = {
  pending: "審査中",
  approved: "掲載中",
  rejected: "却下",
  expired: "掲載終了",
  revoked: "停止",
};

export default function AdsClient() {
  const [guilds, setGuilds] = useState<EligibleGuild[]>([]);
  const [applications, setApplications] = useState<AdApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [guildId, setGuildId] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard/ads", { cache: "no-store" });
      const data = (await res.json()) as { guilds?: EligibleGuild[]; applications?: AdApplication[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "申請情報を取得できませんでした");
      setGuilds(data.guilds ?? []);
      setApplications(data.applications ?? []);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "申請情報を取得できませんでした");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const selectedGuild = guilds.find((guild) => guild.id === guildId) ?? null;
  const textCheck = validateAdText(text);
  const urlCheck = normalizeInviteUrl(url);
  const formValid = Boolean(selectedGuild) && textCheck.ok && urlCheck.ok && (editingId !== null || (selectedGuild?.can_create ?? false));

  const resetForm = () => {
    setText("");
    setUrl("");
    setEditingId(null);
    setFormError(null);
  };

  const submit = async () => {
    if (!formValid || submitting) return;
    setSubmitting(true);
    setFormError(null);
    setSaved(null);
    try {
      const res = editingId
        ? await fetch(`/api/dashboard/ads/${editingId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, url }),
          })
        : await fetch("/api/dashboard/ads", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ guildId, text, url }),
          });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "申請できませんでした");
      setSaved(editingId ? "申請内容を更新しました" : "申請しました。審査結果はこのページで確認できます");
      resetForm();
      await reload();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "申請できませんでした");
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (app: AdApplication) => {
    setEditingId(app.id);
    setGuildId(app.guild_id);
    setText(app.text);
    setUrl(app.url);
    setFormError(null);
    setSaved(null);
  };

  if (loading) return <p className="muted">読み込み中…</p>;

  return (
    <>
      {loadError ? <p className="login-error" role="alert">{loadError}</p> : null}

      {guilds.length === 0 ? (
        <div className="simple-panel">
          <h2>申請できるサーバーがありません</h2>
          <p>管理者（またはサーバーの管理権限）があり、AGOBOTが導入されているサーバーだけが申請できます。</p>
        </div>
      ) : (
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="settings-field">
            <label htmlFor="ads-guild">サーバー</label>
            <select
              id="ads-guild"
              value={guildId}
              disabled={editingId !== null}
              onChange={(event) => {
                setGuildId(event.target.value);
                setFormError(null);
              }}
            >
              <option value="">選択してください</option>
              {guilds.map((guild) => (
                <option key={guild.id} value={guild.id} disabled={!guild.can_create && editingId === null}>
                  {guild.name}
                  {guild.can_create ? "" : "（審査中の申請があります）"}
                </option>
              ))}
            </select>
            {selectedGuild ? (
              <p className="settings-note guild-title">
                {guildIconUrl(selectedGuild.id, selectedGuild.icon) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="guild-icon" src={guildIconUrl(selectedGuild.id, selectedGuild.icon)!} alt="" width={36} height={36} />
                ) : (
                  <span className="guild-icon guild-icon-fallback" aria-hidden="true">{selectedGuild.name.slice(0, 1)}</span>
                )}
                <span>{selectedGuild.member_count.toLocaleString("ja-JP")} 人</span>
              </p>
            ) : null}
          </div>

          <div className="settings-field">
            <label htmlFor="ads-text">紹介文（{AD_TEXT_MAX}字まで・1行）</label>
            <input
              id="ads-text"
              type="text"
              value={text}
              maxLength={120}
              onChange={(event) => setText(event.target.value)}
              placeholder="みんなでゲームする鯖です"
            />
            <p className="settings-note">{[...text].length} / {AD_TEXT_MAX} 字</p>
          </div>

          <div className="settings-field">
            <label htmlFor="ads-url">招待リンク</label>
            <input
              id="ads-url"
              type="text"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://discord.gg/xxxxxx"
            />
          </div>

          <div className="settings-field">
            <label>表示プレビュー（記録表示の「連携」欄）</label>
            <div className="simple-panel">
              <p className="summary-label">連携</p>
              <p>
                {textCheck.ok && urlCheck.ok ? (
                  <a href={urlCheck.value} target="_blank" rel="noreferrer">{textCheck.value}</a>
                ) : (
                  <span className="muted">紹介文と招待リンクを入力すると、実際の表示がここに出ます</span>
                )}
              </p>
            </div>
          </div>

          {formError ? <p className="login-error" role="alert">{formError}</p> : null}
          {saved ? <p className="settings-saved" role="status">{saved}</p> : null}

          <div className="settings-actions">
            <button type="submit" disabled={!formValid || submitting}>
              {submitting ? "送信中…" : editingId ? "申請内容を更新する" : "この内容で申請する"}
            </button>
            {editingId ? (
              <button type="button" onClick={resetForm} disabled={submitting}>編集をやめる</button>
            ) : null}
          </div>
        </form>
      )}

      <div className="page-heading compact-heading dashboard-subheading">
        <h2>自分の申請</h2>
      </div>
      {applications.length === 0 ? (
        <p className="muted">まだ申請はありません。</p>
      ) : (
        <ul className="module-status-list">
          {applications.map((app) => (
            <li key={app.id}>
              <span>
                <span className={`badge${app.status === "approved" ? " badge-on" : ""}`}>{STATUS_LABEL[app.status]}</span>
                <strong>{app.guild_name}</strong> — {app.text}
                {app.status === "rejected" ? (
                  <span className="settings-note">
                    理由: {REJECT_REASONS.find((item) => item.value === app.reject_reason)?.label ?? "—"}
                    {app.reject_note ? `（${app.reject_note}）` : ""}
                  </span>
                ) : null}
              </span>
              {app.status === "pending" ? (
                <button type="button" onClick={() => startEdit(app)}>編集</button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
