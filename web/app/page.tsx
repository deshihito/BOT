import Link from "next/link";
import { COMMAND_GUIDES } from "@/lib/command-guides";
import { isBotApiConfigured, kvList } from "@/lib/bot-api";
import { GUILD_REGISTRY_NAMESPACE } from "@/lib/dashboard";
import { InviteButton } from "./InviteCta";

export const dynamic = "force-dynamic";

type LiveStats = { guilds: number; members: number };

async function loadLiveStats(): Promise<LiveStats | null> {
  if (!isBotApiConfigured()) return null;
  try {
    const registry = await kvList(GUILD_REGISTRY_NAMESPACE);
    let members = 0;
    for (const value of registry.values()) {
      if (typeof value === "object" && value !== null) {
        const count = (value as Record<string, unknown>).member_count;
        if (typeof count === "number" && Number.isFinite(count)) members += count;
      }
    }
    if (registry.size === 0) return null;
    return { guilds: registry.size, members };
  } catch {
    return null;
  }
}

export default async function Home() {
  const stats = await loadLiveStats();
  return (
    <>
      <section className="home-hero">
        <img src="/img/nomal.png" alt="AGOBOT" />
        <div>
          <h1>使いたいこと、全部このボットでいい。</h1>
          <p className="home-hero-actions">
            <InviteButton className="primary-link invite-hero" />
            <Link className="primary-link" href="/commands">コマンド一覧</Link>
          </p>
          {stats ? (
            <p className="home-live-stats">
              導入サーバー数 {stats.guilds.toLocaleString("ja-JP")} 件
              {stats.members > 0 ? <> ／ 利用者数 {stats.members.toLocaleString("ja-JP")} 人</> : null}
            </p>
          ) : null}
        </div>
      </section>
      <nav className="home-command-grid" aria-label="コマンド">
        {COMMAND_GUIDES.map((guide) => (
          <Link key={guide.slug} href={`/commands/${guide.slug}`} className="home-command-link">
            <code>{guide.command}</code>
            <span>{guide.title}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
