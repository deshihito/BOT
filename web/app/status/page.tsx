import Link from "next/link";
import { isBotApiConfigured, kvGet } from "@/lib/bot-api";
import {
  BOT_STATUS_KEY,
  BOT_STATUS_NAMESPACE,
  isBotStatusFresh,
  parseBotStatusSnapshot,
  SUPPORT_SERVER_URL,
  type BotStatusSnapshot,
} from "@/lib/site";
import { InviteCtaBlock } from "../InviteCta";

export const metadata = {
  title: "サービスステータス",
  description: "AGOBOTの稼働状況（導入サーバー数・メンバー数・応答速度・稼働時間）を表示します。",
  alternates: { canonical: "/status" },
};
export const dynamic = "force-dynamic";

async function loadSnapshot(): Promise<BotStatusSnapshot | null> {
  if (!isBotApiConfigured()) return null;
  try {
    return parseBotStatusSnapshot(await kvGet(BOT_STATUS_NAMESPACE, BOT_STATUS_KEY));
  } catch {
    return null;
  }
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatUptime(startedAt: string | null, now: Date): string {
  if (startedAt === null) return "—";
  const startMs = Date.parse(startedAt);
  if (Number.isNaN(startMs)) return "—";
  const totalMinutes = Math.max(0, Math.floor((now.getTime() - startMs) / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}日 ${hours}時間`;
  if (hours > 0) return `${hours}時間 ${minutes}分`;
  return `${minutes}分`;
}

export default async function StatusPage() {
  const snapshot = await loadSnapshot();
  const now = new Date();
  const fresh = snapshot !== null && isBotStatusFresh(snapshot, now);

  return (
    <section className="status-page">
      <h1>サービスステータス</h1>
      <p className="muted">AGOBOT の稼働状況です。Bot が5分ごとに書き出す情報を表示しています。</p>
      {snapshot === null ? (
        <div className="simple-panel">
          <p>ステータス情報を取得できませんでした。時間をおいて再度ご確認ください。</p>
          <p><Link href="/">トップへ戻る</Link></p>
        </div>
      ) : (
        <>
          <div className={fresh ? "status-banner ok" : "status-banner warn"} role="status">
            <span className="status-dot" aria-hidden="true" />
            <div>
              <p className="status-banner-title">
                {fresh ? "正常に稼働しています" : "ステータス情報が古くなっています"}
              </p>
              <p className="status-banner-note">
                {fresh
                  ? "現在、すべての機能が利用できます。"
                  : "Bot が停止・再起動中か、情報の書き出しが遅れている可能性があります。"}
              </p>
            </div>
          </div>
          <table className="status-table">
            <tbody>
              <tr>
                <th scope="row">導入サーバー数</th>
                <td>{snapshot.guild_count.toLocaleString("ja-JP")}</td>
              </tr>
              <tr>
                <th scope="row">メンバー数（概算）</th>
                <td>{snapshot.member_count.toLocaleString("ja-JP")}</td>
              </tr>
              <tr>
                <th scope="row">応答速度</th>
                <td>{snapshot.latency_ms === null ? "—" : `${snapshot.latency_ms.toLocaleString("ja-JP")} ms`}</td>
              </tr>
              <tr>
                <th scope="row">稼働時間</th>
                <td>{formatUptime(snapshot.started_at, now)}</td>
              </tr>
              <tr>
                <th scope="row">起動日時</th>
                <td>{snapshot.started_at === null ? "—" : formatDateTime(snapshot.started_at)}</td>
              </tr>
              <tr>
                <th scope="row">最終更新</th>
                <td>{formatDateTime(snapshot.updated_at)}</td>
              </tr>
            </tbody>
          </table>
          <p className="quiet-note">
            障害や不具合の報告は
            <a href={SUPPORT_SERVER_URL} target="_blank" rel="noreferrer">サポートサーバー</a>
            へお願いします。
          </p>
        </>
      )}
      <InviteCtaBlock />
    </section>
  );
}
