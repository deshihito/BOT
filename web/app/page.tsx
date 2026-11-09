import type { Metadata } from "next";
import Link from "next/link";
import { COMMAND_GUIDES, GAME_COUNT, TOTAL_FUNCTIONS } from "@/lib/command-guides";
import { isBotApiConfigured, kvList } from "@/lib/bot-api";
import { GUILD_REGISTRY_NAMESPACE } from "@/lib/dashboard";
import { InviteButton } from "./InviteCta";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

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

const HOME_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "AGOBOT",
  applicationCategory: "CommunicationApplication",
  operatingSystem: "Discord",
  inLanguage: "ja",
  description:
    `ゲーム${GAME_COUNT}種・音楽とVC・コイン経済・サーバー運営・AIまで、${TOTAL_FUNCTIONS}の機能を6つのスラッシュコマンドに集約した多機能Discordボット。`,
  offers: { "@type": "Offer", price: "0", priceCurrency: "JPY" },
};

export default async function Home() {
  const stats = await loadLiveStats();
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(HOME_JSON_LD) }}
      />
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
      <section className="home-features">
        <h2>機能紹介</h2>
        <p className="home-features-lead">
          AGOBOT の機能は全部で{TOTAL_FUNCTIONS}
          件。下の5つのコマンドに整理されていて、<code>/quick</code>
          からは全機能を検索して直接実行できます。機能の追加や変更は、このページにも自動で反映されます。
        </p>
        {COMMAND_GUIDES.map((guide) => {
          const functionCount = guide.genres.reduce((sum, genre) => sum + genre.functions.length, 0);
          return (
            <article key={guide.slug} className="home-feature">
              <h3>
                <code>{guide.command}</code>
                <span>{guide.title}</span>
                <span className="home-feature-count">{functionCount}機能</span>
                {guide.guildOnly ? <span className="home-feature-count">サーバー内のみ</span> : null}
              </h3>
              <p>{guide.intro}</p>
              <ul className="home-genres">
                {guide.genres.map((genre) => (
                  <li key={genre.slug}>
                    <strong>{genre.title}</strong>
                    {genre.description ? <>：{genre.description}</> : null}
                    <br />
                    <span className="home-genre-functions">
                      {genre.functions.map((fn) => fn.title).join("、")}
                    </span>
                  </li>
                ))}
              </ul>
              <p>
                <Link href={`/commands/${guide.slug}`}>{guide.command} の詳しい使い方 →</Link>
              </p>
            </article>
          );
        })}
      </section>
      <section className="home-video">
        <h2>紹介動画</h2>
        <video
          autoPlay
          muted
          loop
          playsInline
          controls
          preload="metadata"
          poster="/video/intro-poster.jpg"
          src="/video/intro.mp4"
        />
      </section>
    </>
  );
}
