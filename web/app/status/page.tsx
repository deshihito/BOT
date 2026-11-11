import Link from "next/link";
import { isBotApiConfigured, kvGet } from "@/lib/bot-api";
import {
  BOT_STATUS_HISTORY_KEY,
  BOT_STATUS_KEY,
  BOT_STATUS_NAMESPACE,
  isBotStatusFresh,
  parseBotStatusHistory,
  parseBotStatusSnapshot,
  SUPPORT_SERVER_URL,
  type BotStatusHistory,
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

async function loadHistory(): Promise<BotStatusHistory | null> {
  if (!isBotApiConfigured()) return null;
  try {
    return parseBotStatusHistory(await kvGet(BOT_STATUS_NAMESPACE, BOT_STATUS_HISTORY_KEY));
  } catch {
    return null;
  }
}

/** JST の日付（YYYY-MM-DD）を、今日から遡って count 日分（古い順）返す。 */
function lastJstDates(now: Date, count: number): string[] {
  const jst = new Date(now.getTime() + 9 * 3600_000);
  const dates: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const day = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() - i));
    dates.push(day.toISOString().slice(0, 10));
  }
  return dates;
}

/** JST の時間キー（YYYY-MM-DDTHH）を、現在の時間から遡って count 件（古い順）返す。 */
function lastJstHourKeys(now: Date, count: number): string[] {
  const jst = new Date(now.getTime() + 9 * 3600_000);
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const hour = new Date(Date.UTC(
      jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), jst.getUTCHours() - i));
    keys.push(hour.toISOString().slice(0, 13));
  }
  return keys;
}

function SeriesChart({ points, color, label }: {
  points: { label: string; value: number }[];
  color: string;
  label: string;
}) {
  const width = 560;
  const height = 140;
  const pad = 8;
  const values = points.map((point) => point.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const stepX = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const coords = points.map((point, index) => [
    pad + index * stepX,
    height - pad - ((point.value - min) / range) * (height - pad * 2),
  ] as const);
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${pad},${height - pad} ${line} ${(pad + (points.length - 1) * stepX).toFixed(1)},${height - pad}`;
  const [lastX, lastY] = coords[coords.length - 1];
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="status-chart" role="img" aria-label={label}>
      <polygon points={area} fill={color} opacity={0.14} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={2} />
      <circle cx={lastX} cy={lastY} r={3.5} fill={color} />
    </svg>
  );
}

function HoursChart({ points }: { points: { label: string; value: number }[] }) {
  const width = 560;
  const height = 140;
  const gap = 2;
  const max = Math.max(1, ...points.map((point) => point.value));
  const barWidth = (width - gap * (points.length - 1)) / points.length;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="status-chart" role="img" aria-label="直近24時間の1時間ごとの実行数">
      {points.map((point, index) => {
        const barHeight = Math.max(1, (point.value / max) * (height - 16));
        return (
          <rect
            key={point.label}
            x={index * (barWidth + gap)}
            y={height - barHeight}
            width={barWidth}
            height={barHeight}
            rx={2}
            fill="#2f9e44"
          >
            <title>{`${point.label}: ${point.value}回`}</title>
          </rect>
        );
      })}
    </svg>
  );
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

const SAMPLES_PER_DAY = 288;

export default async function StatusPage() {
  const [snapshot, history] = await Promise.all([loadSnapshot(), loadHistory()]);
  const now = new Date();
  const fresh = snapshot !== null && isBotStatusFresh(snapshot, now);
  const uptimeDates = lastJstDates(now, 30);
  const dayByDate = new Map((history?.days ?? []).map((day) => [day.date, day]));
  const uptimeRatios = uptimeDates.map((date) => {
    const day = dayByDate.get(date);
    return day ? Math.min(1, day.samples / SAMPLES_PER_DAY) : null;
  });
  const recordedRatios = uptimeRatios.filter((ratio): ratio is number => ratio !== null);
  const uptimePct = recordedRatios.length > 0
    ? (recordedRatios.reduce((sum, ratio) => sum + ratio, 0) / recordedRatios.length) * 100
    : null;
  const seriesDays = history?.days ?? [];
  const hourKeys = lastJstHourKeys(now, 24);
  const countByHour = new Map((history?.cmdHours ?? []).map((entry) => [entry.hour, entry.count]));
  const hourPoints = hourKeys.map((key) => ({
    label: `${key.slice(5, 10)} ${key.slice(11, 13)}時`,
    value: countByHour.get(key) ?? 0,
  }));
  const hourTotal = hourPoints.reduce((sum, point) => sum + point.value, 0);

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
          {history === null ? (
            <p className="quiet-note">
              稼働率と推移グラフの履歴は収集中です。Bot の書き出しが続くと、ここに表示されます。
            </p>
          ) : (
            <>
              <section className="status-section" aria-label="稼働率">
                <div className="uptime-head">
                  <h2>AGOBOT</h2>
                  <span className={fresh ? "uptime-state" : "uptime-state stale"}>
                    {fresh ? "正常稼働中" : "情報が古い"}
                  </span>
                </div>
                <div className="uptime-bars">
                  {uptimeDates.map((date, index) => {
                    const ratio = uptimeRatios[index];
                    const cls = ratio === null ? "uptime-bar none"
                      : ratio >= 0.99 ? "uptime-bar ok"
                      : ratio >= 0.5 ? "uptime-bar warn" : "uptime-bar low";
                    const title = ratio === null
                      ? `${date}: 記録なし`
                      : `${date}: 稼働率 ${(ratio * 100).toFixed(1)}%`;
                    return <div key={date} className={cls} title={title} />;
                  })}
                </div>
                <div className="uptime-caption">
                  <span>30日前</span>
                  <span>{uptimePct === null ? "—" : `${uptimePct.toFixed(1)} % uptime`}</span>
                  <span>今日</span>
                </div>
              </section>
              <div className="chart-grid">
                <section className="chart-card" aria-label="ユーザー数の推移">
                  <h2>ユーザー数</h2>
                  <p className="chart-value">
                    {seriesDays.length > 0
                      ? seriesDays[seriesDays.length - 1].users.toLocaleString("ja-JP")
                      : "—"}
                  </p>
                  {seriesDays.length >= 2 ? (
                    <>
                      <SeriesChart
                        color="#2f9e44"
                        label="ユーザー数の推移グラフ"
                        points={seriesDays.map((day) => ({ label: day.date, value: day.users }))}
                      />
                      <div className="chart-range">
                        <span>{seriesDays[0].date.slice(5).replace("-", "/")}</span>
                        <span>{seriesDays[seriesDays.length - 1].date.slice(5).replace("-", "/")}</span>
                      </div>
                    </>
                  ) : (
                    <p className="muted">データを収集中です。</p>
                  )}
                </section>
                <section className="chart-card" aria-label="サーバー数の推移">
                  <h2>サーバー数</h2>
                  <p className="chart-value">
                    {seriesDays.length > 0
                      ? seriesDays[seriesDays.length - 1].guilds.toLocaleString("ja-JP")
                      : "—"}
                  </p>
                  {seriesDays.length >= 2 ? (
                    <>
                      <SeriesChart
                        color="#1971c2"
                        label="サーバー数の推移グラフ"
                        points={seriesDays.map((day) => ({ label: day.date, value: day.guilds }))}
                      />
                      <div className="chart-range">
                        <span>{seriesDays[0].date.slice(5).replace("-", "/")}</span>
                        <span>{seriesDays[seriesDays.length - 1].date.slice(5).replace("-", "/")}</span>
                      </div>
                    </>
                  ) : (
                    <p className="muted">データを収集中です。</p>
                  )}
                </section>
              </div>
              <section className="status-section" aria-label="1時間ごとの実行数">
                <div className="uptime-head">
                  <h2>1時間ごとの実行数（直近24時間）</h2>
                  <span className="muted">合計 {hourTotal.toLocaleString("ja-JP")} 回</span>
                </div>
                <HoursChart points={hourPoints} />
                <div className="chart-range">
                  <span>{hourPoints[0].label}</span>
                  <span>コマンドとアクションの合計</span>
                  <span>{hourPoints[hourPoints.length - 1].label}</span>
                </div>
              </section>
            </>
          )}
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
