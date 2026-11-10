import type { Metadata } from "next";
import Link from "next/link";
import { COMMAND_GUIDES, TOTAL_FUNCTIONS } from "@/lib/command-guides";

export const metadata: Metadata = {
  title: "機能紹介",
  description:
    `AGOBOTの機能は全部で${TOTAL_FUNCTIONS}件。5つのコマンドに整理された全機能を、ジャンルごとに紹介します。`,
  alternates: { canonical: "/features" },
};

export default function FeaturesPage() {
  return (
    <section className="home-features">
      <div className="page-heading"><h1>機能紹介</h1></div>
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
  );
}
