import Link from "next/link";
import { SECTION_CATEGORIES, SETTING_SECTIONS, guildIconUrl, userAvatarUrl } from "@/lib/dashboard-core";
import { getDashboardContext, loadGuildRegistry, type GuildRegistryEntry } from "@/lib/dashboard";
import { getCurrentSession } from "@/lib/auth";
import SidebarNav from "./SidebarNav";

export const dynamic = "force-dynamic";

type LayoutProps = {
  children: React.ReactNode;
  params: Promise<{ guildId: string }>;
};

export default async function GuildDashboardLayout({ children, params }: LayoutProps) {
  const { guildId } = await params;
  const session = await getCurrentSession();
  if (!session || !session.sid || !/^\d{17,20}$/.test(guildId)) {
    return (
      <section className="dashboard-page">
        <div className="simple-panel">
          <h1>ログインが必要です</h1>
          <p><Link href="/login">ログインへ</Link></p>
        </div>
      </section>
    );
  }
  const context = await getDashboardContext(session);
  const guild = context?.guilds.find((item) => item.id === guildId);
  if (!context || !guild) {
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
  let registryEntry: GuildRegistryEntry | undefined;
  try {
    registryEntry = (await loadGuildRegistry()).get(guildId);
  } catch {
    registryEntry = undefined;
  }
  if (!registryEntry) {
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

  const guildIcon = guildIconUrl(guildId, registryEntry.icon ?? guild.icon);
  const groups = SECTION_CATEGORIES.map((category) => ({
    label: category.label,
    items: category.sections
      .map((name) => SETTING_SECTIONS.find((spec) => spec.section === name))
      .filter((spec): spec is NonNullable<typeof spec> => spec !== undefined)
      .map((spec) => ({ section: spec.section, label: spec.label })),
  }));

  return (
    <section className="dashboard-page">
      <p className="breadcrumbs"><Link href="/dashboard">ダッシュボード</Link> / {guild.name}</p>
      <div className="dashboard-header">
        <h1 className="guild-title">
          {guildIcon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="guild-icon" src={guildIcon} alt="" width={36} height={36} />
          ) : (
            <span className="guild-icon guild-icon-fallback" aria-hidden="true">{guild.name.slice(0, 1)}</span>
          )}
          <span className="guild-name">{guild.name}</span>
        </h1>
        <span className="user-chip">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="user-avatar" src={userAvatarUrl(session.id, session.avatar)} alt="" width={28} height={28} />
          {session.username}
        </span>
        <form action="/api/auth/logout" method="post"><button type="submit">ログアウト</button></form>
      </div>
      <div className="dash-shell">
        <SidebarNav guildId={guildId} groups={groups} />
        <div className="dash-main">{children}</div>
      </div>
    </section>
  );
}
