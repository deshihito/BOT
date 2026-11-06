import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth";
import { SETTING_SECTIONS } from "@/lib/dashboard-core";
import { getDashboardContext, loadGuildRegistry, loadGuildSettings } from "@/lib/dashboard";
import SettingsForm from "./SettingsForm";

export const metadata = { title: "サーバー設定 | AGOBOT" };
export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ guildId: string }>;
};

export default async function GuildSettingsPage({ params }: PageProps) {
  const { guildId } = await params;
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.sid) redirect("/dashboard");
  if (!/^\d{17,20}$/.test(guildId)) redirect("/dashboard");

  const context = await getDashboardContext(session);
  if (!context) redirect("/dashboard");

  const guild = context.guilds.find((item) => item.id === guildId);
  if (!guild) {
    return (
      <section className="dashboard-page">
        <div className="simple-panel">
          <h1>このサーバーの設定は表示できません</h1>
          <p>サーバーの管理権限（管理者 または サーバーの管理）が必要です。</p>
          <p><Link href="/dashboard">ダッシュボードへ戻る</Link></p>
        </div>
      </section>
    );
  }

  let installed = false;
  try {
    installed = (await loadGuildRegistry()).has(guildId);
  } catch {
    installed = false;
  }
  if (!installed) {
    return (
      <section className="dashboard-page">
        <div className="simple-panel">
          <h1>{guild.name}</h1>
          <p>このサーバーにはAGOBOTがまだ導入されていません。導入後に設定できるようになります。</p>
          <p><Link href="/dashboard">ダッシュボードへ戻る</Link></p>
        </div>
      </section>
    );
  }

  const settings = await loadGuildSettings(guildId);

  return (
    <section className="dashboard-page">
      <p className="breadcrumbs"><Link href="/dashboard">ダッシュボード</Link> / サーバー設定</p>
      <div className="dashboard-header">
        <h1>{guild.name}</h1>
        <form action="/api/auth/logout" method="post"><button type="submit">ログアウト</button></form>
      </div>
      {SETTING_SECTIONS.map((spec) => {
        const sectionValue = settings[spec.section];
        const initial =
          typeof sectionValue === "object" && sectionValue !== null && !Array.isArray(sectionValue)
            ? (sectionValue as Record<string, unknown>)
            : {};
        return <SettingsForm key={spec.section} guildId={guildId} spec={spec} initial={initial} />;
      })}
      <p className="back-link"><Link href="/dashboard">← ダッシュボードへ戻る</Link></p>
    </section>
  );
}
