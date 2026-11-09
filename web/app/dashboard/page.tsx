import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth";
import { guildIconUrl, userAvatarUrl } from "@/lib/dashboard-core";
import { getDashboardContext, loadGuildRegistry, type GuildRegistryEntry } from "@/lib/dashboard";

export const metadata = { title: "ダッシュボード | AGOBOT", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");

  const header = (
    <div className="dashboard-header">
      <h1>ダッシュボード</h1>
      <span className="user-chip">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="user-avatar" src={userAvatarUrl(session.id, session.avatar)} alt="" width={28} height={28} />
        {session.username}
      </span>
      <form action="/api/auth/logout" method="post"><button type="submit">ログアウト</button></form>
    </div>
  );

  if (!session.sid) {
    return (
      <section className="dashboard-page">
        {header}
        <div className="simple-panel">
          <h2>サーバー設定には再ログインが必要です</h2>
          <p>サーバー一覧の表示に必要な許可が、今回のログインには含まれていません。</p>
          <p><a className="discord-login-button" href="/api/auth/discord/authorize">Discordでログインし直す</a></p>
        </div>
        <nav className="dashboard-list" aria-label="機能">
          <Link href="/coder" className="dashboard-card">AGO Coder</Link>
          <Link href="/commands" className="dashboard-card">コマンド</Link>
        </nav>
      </section>
    );
  }

  const context = await getDashboardContext(session);
  if (!context) {
    return (
      <section className="dashboard-page">
        {header}
        <div className="simple-panel">
          <h2>サーバー一覧を取得できませんでした</h2>
          <p>Discordとの通信に失敗したか、ログインの有効期限が切れています。ログインし直してください。</p>
          <p><a className="discord-login-button" href="/api/auth/discord/authorize">Discordでログインし直す</a></p>
        </div>
      </section>
    );
  }

  let registry: Awaited<ReturnType<typeof loadGuildRegistry>> | null = null;
  try {
    registry = await loadGuildRegistry();
  } catch {
    registry = null;
  }
  // 登録簿は導入済みかどうかの表示にだけ使う。読み取りに失敗しても
  // 管理できるサーバーの一覧自体は落とさない（全件「未導入」として出す）。
  const registryMap: Map<string, GuildRegistryEntry> = registry ?? new Map();

  return (
    <section className="dashboard-page">
      {header}
      <div className="page-heading compact-heading">
        <h2>サーバー設定</h2>
        <p className="muted">あなたが管理できるサーバーのうち、AGOBOTが導入されているサーバーの設定を変更できます。保存した設定は1分ほどでBotに反映されます。</p>
      </div>
      {registry === null ? (
        <p className="login-error" role="alert">サーバーの導入状況を取得できませんでした。導入状態は未確認として表示しています。時間をおいて開き直してください。</p>
      ) : null}
      {context.guilds.length === 0 ? (
        <p className="muted">
          管理できるサーバーがありません。
          {context.totalGuilds > 0
            ? `Discordで参加中のサーバー ${context.totalGuilds} 件のうち、管理権限（管理者／サーバーの管理）を確認できるサーバーがありませんでした。権限のあるアカウントでログインしているか確認してください。`
            : "Discordの応答では参加中のサーバーが0件でした。別のアカウントでログインしていないか確認してください。"}
        </p>
      ) : (
        <nav className="dashboard-list guild-grid" aria-label="サーバー">
          {context.guilds.map((guild) => {
            const entry = registryMap.get(guild.id);
            const installed = entry !== undefined;
            const icon = guildIconUrl(guild.id, guild.icon ?? entry?.icon);
            const card = (
              <>
                {icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="guild-icon" src={icon} alt="" width={40} height={40} />
                ) : (
                  <span className="guild-icon guild-icon-fallback" aria-hidden="true">{guild.name.slice(0, 1)}</span>
                )}
                <span className="guild-card-main">
                  <span>{guild.name}</span>
                  {entry ? <span className="guild-card-meta">{entry.member_count.toLocaleString("ja-JP")} 人</span> : null}
                </span>
                <span className="badge">{installed ? "設定できます" : "未導入"}</span>
              </>
            );
            return installed ? (
              <Link key={guild.id} href={`/dashboard/${guild.id}`} className="dashboard-card guild-card">
                {card}
              </Link>
            ) : (
              <div key={guild.id} className="dashboard-card guild-card guild-card-disabled" aria-disabled="true">
                {card}
              </div>
            );
          })}
        </nav>
      )}
      <div className="page-heading compact-heading dashboard-subheading">
        <h2>その他の機能</h2>
      </div>
      <nav className="dashboard-list" aria-label="機能">
        <Link href="/dashboard/ads" className="dashboard-card">サーバー広告の申請</Link>
        <Link href="/coder" className="dashboard-card">AGO Coder</Link>
        <Link href="/commands" className="dashboard-card">コマンド</Link>
      </nav>
    </section>
  );
}
