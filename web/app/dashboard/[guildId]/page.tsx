import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth";
import { SECTION_CATEGORIES, SETTING_SECTIONS, moduleEnabled } from "@/lib/dashboard-core";
import { getDashboardContext, loadBumpRtaSettings, loadGuildRegistry, loadGuildSettings, loadGuildStructure } from "@/lib/dashboard";

export const metadata = { title: "サーバー概要 | AGOBOT", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ guildId: string }>;
};

const SHORTCUTS = ["assist_automod", "assist_welcome", "assist_leveling", "assist_reactionroles", "ticket", "bump_rta"];

export default async function GuildOverviewPage({ params }: PageProps) {
  const { guildId } = await params;
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.sid) redirect("/dashboard");
  if (!/^\d{17,20}$/.test(guildId)) redirect("/dashboard");
  const context = await getDashboardContext(session);
  if (!context) redirect("/dashboard");
  const guild = context.guilds.find((item) => item.id === guildId);
  if (!guild) redirect("/dashboard");

  const settings = await loadGuildSettings(guildId);
  let bumpRaw: Record<string, unknown> = { notifications_enabled: true, role_id: null };
  try {
    const bump = await loadBumpRtaSettings(guildId);
    bumpRaw = { notifications_enabled: bump.notifications_enabled, role_id: bump.role_id };
  } catch {
    bumpRaw = { notifications_enabled: true, role_id: null };
  }
  let memberCount: number | null = null;
  try {
    memberCount = (await loadGuildRegistry()).get(guildId)?.member_count ?? null;
  } catch {
    memberCount = null;
  }
  let structureUpdated: string | null = null;
  try {
    const structure = await loadGuildStructure(guildId);
    structureUpdated = structure?.updated_at ?? null;
  } catch {
    structureUpdated = null;
  }

  const rawFor = (spec: (typeof SETTING_SECTIONS)[number]): unknown =>
    spec.external === "bump_rta" ? bumpRaw : settings[spec.section];
  const enabledCount = SETTING_SECTIONS.filter((spec) => moduleEnabled(spec, rawFor(spec))).length;

  return (
    <div className="overview">
      <div className="summary-grid">
        <div className="summary-card">
          <p className="summary-label">メンバー数</p>
          <p className="summary-value">{memberCount !== null ? memberCount.toLocaleString("ja-JP") : "—"}</p>
        </div>
        <div className="summary-card">
          <p className="summary-label">有効なモジュール</p>
          <p className="summary-value">{enabledCount} / {SETTING_SECTIONS.length}</p>
        </div>
        <div className="summary-card">
          <p className="summary-label">チャンネル・ロール一覧</p>
          <p className="summary-value summary-value-small">
            {structureUpdated ? `${new Date(structureUpdated).toLocaleString("ja-JP")} 時点` : "未取得（ID入力で設定できます）"}
          </p>
        </div>
      </div>
      <p className="muted">設定の保存は約60秒でBotに反映されます。左のメニューからモジュールごとに設定できます。</p>

      <h2 className="overview-heading">よく使う設定</h2>
      <div className="shortcut-grid">
        {SHORTCUTS.map((name) => {
          const spec = SETTING_SECTIONS.find((item) => item.section === name);
          if (!spec) return null;
          const on = moduleEnabled(spec, rawFor(spec));
          return (
            <Link key={name} href={`/dashboard/${guildId}/${name}`} className="shortcut-card">
              <span>{spec.label}</span>
              <span className={on ? "badge badge-on" : "badge"}>{on ? "有効" : "無効"}</span>
            </Link>
          );
        })}
      </div>

      {SECTION_CATEGORIES.map((category) => (
        <div key={category.id}>
          <h2 className="overview-heading">{category.label}</h2>
          <ul className="module-status-list">
            {category.sections.map((name) => {
              const spec = SETTING_SECTIONS.find((item) => item.section === name);
              if (!spec) return null;
              const on = moduleEnabled(spec, rawFor(spec));
              return (
                <li key={name}>
                  <Link href={`/dashboard/${guildId}/${name}`}>{spec.label}</Link>
                  <span className={on ? "badge badge-on" : "badge"}>{on ? "有効" : "無効"}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
