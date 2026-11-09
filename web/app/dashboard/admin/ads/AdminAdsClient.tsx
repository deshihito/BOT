"use client";

import { useCallback, useEffect, useState } from "react";
import {
  REJECT_REASONS,
  type AdApplication,
  type RejectReason,
  type ScreeningCriteria,
} from "@/lib/ads-core";

type GuildInfo = {
  name: string;
  icon_url: string | null;
  member_count: number | null;
  installed: boolean;
};

type AdminApplication = AdApplication & { guild: GuildInfo };

type AdminData = {
  pending: AdminApplication[];
  approved: AdminApplication[];
  approved_count: number;
  approved_limit: number;
};

const CRITERIA_LABEL: Record<ScreeningCriteria, string> = {
  spam: "スパム",
  shop: "ショップ",
  nsfw: "NSFW",
  mismatch: "不一致",
};

function ScreeningBadges({ app }: { app: AdminApplication }) {
  const screening = app.screening;
  if (!screening || screening.status === "unavailable") {
    return <span className="badge">スクリーニング未実施</span>;
  }
  return (
    <>
      {(Object.keys(CRITERIA_LABEL) as ScreeningCriteria[]).map((key) => {
        const verdict = screening.verdicts[key];
        if (verdict === "unknown") return null;
        return (
          <span key={key} className={`badge${verdict === "suspect" ? "" : " badge-on"}`}>
            {CRITERIA_LABEL[key]}: {verdict === "suspect" ? "疑いあり" : "問題なし"}
          </span>
        );
      })}
      {screening.flagged ? <span className="badge">要確認</span> : null}
    </>
  );
}

function GuildLine({ app }: { app: AdminApplication }) {
  return (
    <p className="settings-note guild-title">
      {app.guild.icon_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="guild-icon" src={app.guild.icon_url} alt="" width={36} height={36} />
      ) : (
        <span className="guild-icon guild-icon-fallback" aria-hidden="true">{app.guild.name.slice(0, 1)}</span>
      )}
      <span>
        {app.guild.name}
        {app.guild.member_count !== null ? ` ・ ${app.guild.member_count.toLocaleString("ja-JP")} 人` : ""}
        {app.guild.installed ? "" : " ・ Bot未導入（退出済み）"}
      </span>
    </p>
  );
}

export default function AdminAdsClient() {
  const [data, setData] = useState<AdminData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState<Record<string, RejectReason>>({});
  const [rejectNote, setRejectNote] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard/admin/ads", { cache: "no-store" });
      const body = (await res.json()) as AdminData & { error?: string };
      if (!res.ok) throw new Error(body.error ?? "申請情報を取得できませんでした");
      setData(body);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "申請情報を取得できませんでした");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (app: AdminApplication, action: "approve" | "reject" | "revoke") => {
    if (busyId) return;
    setBusyId(app.id);
    setActionError(null);
    try {
      const res = await fetch(`/api/dashboard/admin/ads/${app.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "reject"
            ? { action, reason: rejectReason[app.id] ?? "spam", note: rejectNote[app.id] ?? "" }
            : { action },
        ),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "操作できませんでした");
      await reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "操作できませんでした");
    } finally {
      setBusyId(null);
    }
  };

  if (loadError) return <p className="login-error" role="alert">{loadError}</p>;
  if (!data) return <p className="muted">読み込み中…</p>;

  const capReached = data.approved_count >= data.approved_limit;

  return (
    <>
      <div className="page-heading compact-heading">
        <h2>審査待ち</h2>
        <p className="muted">
          掲載中 {data.approved_count} / {data.approved_limit} 件
          {capReached ? "（上限に達しているため、新規承認はできません）" : ""}
        </p>
      </div>
      {actionError ? <p className="login-error" role="alert">{actionError}</p> : null}

      {data.pending.length === 0 ? (
        <p className="muted">審査待ちの申請はありません。</p>
      ) : (
        data.pending.map((app) => (
          <div key={app.id} className="settings-form">
            <GuildLine app={app} />
            <p>
              <strong>{app.text}</strong>
              {" — "}
              <a href={app.url} target="_blank" rel="noreferrer">{app.url}</a>
            </p>
            <p><ScreeningBadges app={app} /></p>
            <div className="settings-actions">
              <button type="button" disabled={busyId !== null || capReached || !app.guild.installed} onClick={() => void act(app, "approve")}>
                承認する（30日掲載）
              </button>
            </div>
            <div className="settings-field">
              <label htmlFor={`reason-${app.id}`}>却下理由</label>
              <select
                id={`reason-${app.id}`}
                value={rejectReason[app.id] ?? "spam"}
                onChange={(event) => setRejectReason((prev) => ({ ...prev, [app.id]: event.target.value as RejectReason }))}
              >
                {REJECT_REASONS.map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
              <input
                type="text"
                value={rejectNote[app.id] ?? ""}
                onChange={(event) => setRejectNote((prev) => ({ ...prev, [app.id]: event.target.value }))}
                placeholder="補足（任意。「その他」の場合は必須）"
              />
            </div>
            <div className="settings-actions">
              <button type="button" disabled={busyId !== null} onClick={() => void act(app, "reject")}>
                却下する
              </button>
            </div>
          </div>
        ))
      )}

      <div className="page-heading compact-heading dashboard-subheading">
        <h2>掲載中</h2>
      </div>
      {data.approved.length === 0 ? (
        <p className="muted">掲載中の広告はありません。</p>
      ) : (
        <ul className="module-status-list">
          {data.approved.map((app) => (
            <li key={app.id}>
              <span>
                <strong>{app.guild_name}</strong> — {app.text}
                {app.expires_at ? (
                  <span className="settings-note">（{new Date(app.expires_at).toLocaleDateString("ja-JP")}まで）</span>
                ) : null}
              </span>
              <button type="button" disabled={busyId !== null} onClick={() => void act(app, "revoke")}>
                即時停止
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
