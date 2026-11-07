import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth";
import { getDashboardContext, loadGuildRegistry } from "@/lib/dashboard";

export const metadata = { title: "ダッシュボード | AGOBOT", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");

  const header = (
    <div className="dashboard-header">
      <h1>ダッシュボード</h1>
      <span>{session.username}</span>
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

  return (
    <section className="dashboard-page">
      {header}
      <div className="page-heading compact-heading">
        <h2>サーバー設定</h2>
        <p className="muted">あなたが管理できるサーバーのうち、AGOBOTが導入されているサーバーの設定を変更できます。保存した設定は1分ほどでBotに反映されます。</p>
      </div>
      {registry === null ? (
        <p className="login-error" role="alert">サーバーの導入状況を取得できませんでした。時間をおいて開き直してください。</p>
      ) : context.guilds.length === 0 ? (
        <p className="muted">管理できるサーバーがありません。</p>
      ) : (
        <nav className="dashboard-list" aria-label="サーバー">
          {context.guilds.map((guild) => {
            const installed = registry.has(guild.id);
            return installed ? (
              <Link key={guild.id} href={`/dashboard/${guild.id}`} className="dashboard-card guild-card">
                <span>{guild.name}</span>
                <span className="badge">設定できます</span>
              </Link>
            ) : (
              <div key={guild.id} className="dashboard-card guild-card guild-card-disabled" aria-disabled="true">
                <span>{guild.name}</span>
                <span className="badge">未導入</span>
              </div>
            );
          })}
        </nav>
      )}
      <div className="page-heading compact-heading dashboard-subheading">
        <h2>その他の機能</h2>
      </div>
      <nav className="dashboard-list" aria-label="機能">
        <Link href="/coder" className="dashboard-card">AGO Coder</Link>
        <Link href="/commands" className="dashboard-card">コマンド</Link>
      </nav>
    </section>
  );
}
