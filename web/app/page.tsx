import type { Metadata } from "next";
import Link from "next/link";
import { COMMAND_GUIDES, GAME_COUNT, TOTAL_FUNCTIONS } from "@/lib/command-guides";
import { isBotApiConfigured, kvGet, kvList } from "@/lib/bot-api";
import { GUILD_REGISTRY_NAMESPACE } from "@/lib/dashboard";
import {
  BOT_STATUS_KEY,
  BOT_STATUS_NAMESPACE,
  isBotStatusFresh,
  parseBotStatusSnapshot,
  type BotStatusSnapshot,
} from "@/lib/site";
import FactsStrip, { type Fact } from "./FactsStrip";
import { InviteButton } from "./InviteCta";
import HomeIntro from "./HomeIntro";

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

async function loadBotStatus(): Promise<BotStatusSnapshot | null> {
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
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
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
  const [stats, botStatus] = await Promise.all([loadLiveStats(), loadBotStatus()]);
  const facts: Fact[] = [
    { label: "機能数", value: `${TOTAL_FUNCTIONS}件` },
    { label: "ゲーム", value: `${GAME_COUNT}種` },
    { label: "料金", value: "無料" },
    { label: "対応環境", value: "Discord" },
  ];
  if (stats) {
    facts.push({ label: "導入サーバー数", value: `${stats.guilds.toLocaleString("ja-JP")}件` });
    if (stats.members > 0) {
      facts.push({ label: "利用者数", value: `${stats.members.toLocaleString("ja-JP")}人` });
    }
  }
  const statusFresh = botStatus !== null && isBotStatusFresh(botStatus);
  return (
    <>
      <HomeIntro />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(HOME_JSON_LD) }}
      />
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
      <section className="home-hero">
        <div className="home-brand">
          <img src="/img/nomal.png" alt="AGOBOT" />
          <span className="home-brand-name">AGOBOT</span>
        </div>
        <h1>使いたいこと、全部このボットでいい。</h1>
        <p className="home-hero-actions">
          <InviteButton className="primary-link invite-hero" />
          <Link href="/commands">コマンド一覧を見る</Link>
        </p>
      </section>
      <section className="home-entry" aria-label="機能紹介への入口">
        <h2>まず、できることを見る</h2>
        <p>
          ゲーム・音楽とVC・コイン経済・サーバー運営・AIまで、全{TOTAL_FUNCTIONS}件の機能を
          ジャンルごとに紹介しています。
        </p>
        <p>
          <Link href="/features">機能紹介（全{TOTAL_FUNCTIONS}件）→</Link>
        </p>
      </section>
      <div style={{ marginTop: 34 }}>
        <FactsStrip facts={facts} label="AGOBOTの判断材料" />
      </div>
      <section className="home-entries" aria-label="コマンドと遊び場への入口">
        <h2>コマンドから探す</h2>
        <nav className="home-command-grid" aria-label="コマンド">
          {COMMAND_GUIDES.map((guide) => (
            <Link key={guide.slug} href={`/commands/${guide.slug}`} className="home-command-link">
              <code>{guide.command}</code>
              <span>{guide.title}</span>
            </Link>
          ))}
        </nav>
        <h2 style={{ marginTop: 26 }}>遊ぶ・見る</h2>
        <nav className="home-command-grid" aria-label="遊ぶ・見る">
          <Link href="/games" className="home-command-link">
            <span>ゲーム</span>
            <span>ブラウザでそのまま遊べる</span>
          </Link>
          <Link href="/ranking" className="home-command-link">
            <span>ランキング</span>
            <span>全サーバー横断の記録</span>
          </Link>
        </nav>
      </section>
      <section className="home-repeater" aria-label="よく使うページと更新情報">
        <div>
          <h2>よく使うページ</h2>
          <nav className="quick-links" aria-label="クイックリンク">
            <Link href="/dashboard">ダッシュボード</Link>
            <Link href="/status">ステータス</Link>
            <Link href="/ranking">ランキング</Link>
            <Link href="/games">ゲーム</Link>
          </nav>
        </div>
        <div>
          <h2>更新情報</h2>
          <ul className="home-updates">
            {botStatus ? (
              <li>
                Bot の稼働状況：{statusFresh ? "稼働中" : "最新の状態を確認中"}
                <span className="muted">（最終確認 {formatDateTime(botStatus.updated_at)}）</span>{" "}
                <Link href="/status">ステータスを見る</Link>
              </li>
            ) : (
              <li>
                Bot の稼働状況は <Link href="/status">ステータス</Link> で確認できます。
              </li>
            )}
            <li>
              ランキングは1時間ごとに更新されます。<Link href="/ranking">ランキングを見る</Link>
            </li>
          </ul>
        </div>
      </section>
      <section className="home-about" aria-label="AGOBOTについて">
        <h2>AGOBOTについて</h2>
        <p>
          AGOBOTは、Discordサーバーに1つ追加するだけで、日々の遊びからサーバー運営までを
          まとめてまかなえる多機能Botです。目的ごとに別々のBotを何個も入れる代わりに、
          AGOBOTひとつで済むことを目指して開発しています。機能は全部で{TOTAL_FUNCTIONS}件あり、
          6つのスラッシュコマンドの中に整理されているので、覚えるコマンドは最小限で済み、
          使いたい機能はその場で探してすぐに実行できます。
        </p>
        <p>
          できることはジャンルを横断します。遊びの面では、対戦やパーティー向けのゲームをはじめ、
          ランキングや記録でメンバー同士が競える仕組みがあります。音の面では、
          ボイスチャンネルに人が集まる場面を支える機能があります。サーバーの中だけで回る
          コイン経済もあり、遊びの結果が次の遊びにつながる循環を作っています。運営の面では、
          サーバーの管理やサポートに使う設定・記録・通知を、ブラウザのダッシュボードと
          あわせて扱えます。そのほか、AIを使った支援や、日常のちょっとした作業を肩代わりする
          ツール類まで、Discordの中だけで完結するように揃えています。
        </p>
        <p>
          料金は無料です。対応環境はDiscordで、パソコンでもスマートフォンでも、
          普段使っているDiscordアプリからそのまま利用できます。専用アプリの追加インストールは
          要りません。
        </p>
        <h2>導入のしかた</h2>
        <ol>
          <li>
            このページの「Discordに追加」ボタンから、AGOBOTを追加したいサーバーを選びます。
          </li>
          <li>
            表示される権限を確認して許可します。招待には、Botの動作に必要な権限が
            含まれています。
          </li>
          <li>
            サーバーで <code>/quick</code> を開くと、全機能を検索してそのまま実行できます。
            サーバーごとの設定を変えたいときは、ダッシュボードから行えます。
          </li>
        </ol>
        <p>
          導入や使い方で困ったときは、<Link href="/faq">よくある質問</Link>もあわせて
          ご覧ください。
        </p>
      </section>
    </>
  );
}
