import { notFound, redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth";
import { sectionSpec } from "@/lib/dashboard-core";
import { getDashboardContext, loadBumpRtaSettings, loadGuildSettings, loadGuildStructure } from "@/lib/dashboard";
import SettingsForm from "../SettingsForm";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ guildId: string; section: string }>;
};

export default async function GuildModulePage({ params }: PageProps) {
  const { guildId, section } = await params;
  const spec = sectionSpec(section);
  if (!spec) notFound();
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!session.sid) redirect("/dashboard");
  if (!/^\d{17,20}$/.test(guildId)) redirect("/dashboard");
  const context = await getDashboardContext(session);
  if (!context) redirect("/dashboard");
  const guild = context.guilds.find((item) => item.id === guildId);
  if (!guild) redirect("/dashboard");

  let structure: Awaited<ReturnType<typeof loadGuildStructure>> = null;
  try {
    structure = await loadGuildStructure(guildId);
  } catch {
    structure = null;
  }
  const structureNote = structure?.updated_at
    ? `チャンネル・ロールの一覧は ${new Date(structure.updated_at).toLocaleString("ja-JP")} 時点の情報です（1時間ごとに更新されます）。`
    : null;

  if (spec.external === "bump_rta") {
    let initial: Record<string, unknown> = { notifications_enabled: true, role_id: null };
    try {
      const bump = await loadBumpRtaSettings(guildId);
      initial = { notifications_enabled: bump.notifications_enabled, role_id: bump.role_id };
    } catch {
      initial = { notifications_enabled: true, role_id: null };
    }
    return (
      <div>
        {structureNote ? <p className="muted">{structureNote}</p> : null}
        <SettingsForm guildId={guildId} spec={spec} initial={initial} structure={structure} />
      </div>
    );
  }

  const settings = await loadGuildSettings(guildId);
  const sectionValue = settings[spec.section];
  const initial =
    typeof sectionValue === "object" && sectionValue !== null && !Array.isArray(sectionValue)
      ? (sectionValue as Record<string, unknown>)
      : {};
  return (
    <div>
      {structureNote ? <p className="muted">{structureNote}</p> : null}
      <SettingsForm guildId={guildId} spec={spec} initial={initial} structure={structure} />
    </div>
  );
}
