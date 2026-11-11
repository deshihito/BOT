import Link from "next/link";
import { notFound } from "next/navigation";
import { COMMAND_GUIDES, getCommandGuide } from "@/lib/command-guides";
import Breadcrumbs from "../../Breadcrumbs";
import FactsStrip from "../../FactsStrip";

export function generateStaticParams() {
  return COMMAND_GUIDES.map((guide) => ({ command: guide.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ command: string }> }) {
  const guide = getCommandGuide((await params).command);
  if (!guide) return {};
  return {
    title: `${guide.command} ${guide.title}`,
    description: guide.description,
    alternates: { canonical: `/commands/${guide.slug}` },
  };
}

export default async function CommandPage({ params }: { params: Promise<{ command: string }> }) {
  const { command } = await params;
  const guide = getCommandGuide(command);
  if (!guide) notFound();

  const functionCount = guide.genres.reduce((sum, genre) => sum + genre.functions.length, 0);
  return (
    <>
      <Breadcrumbs
        items={[
          { href: "/commands", label: "コマンド" },
          { label: `${guide.command} ${guide.title}` },
        ]}
      />
      <div className="page-heading compact-heading">
        <code className="command-code">{guide.command}</code>
        <h1>{guide.title}</h1>
        <p className="muted">{guide.description}</p>
        {guide.guildOnly && <p className="quiet-note">このコマンドはサーバー内で使えます。</p>}
      </div>
      <FactsStrip
        facts={[
          { label: "ジャンル", value: `${guide.genres.length}件` },
          { label: "機能", value: `${functionCount}件` },
          { label: "呼び出し方", value: guide.command },
          { label: "使える場所", value: guide.guildOnly ? "サーバー内のみ" : "Discord内" },
        ]}
        label={`${guide.command} の判断材料`}
      />
      <div className="genre-list" aria-label={`${guide.title}のジャンル`}>
        {guide.genres.map((genre) => (
          <Link key={genre.slug} href={`/commands/${guide.slug}/${genre.slug}`} className="genre-card">
            <div>
              <h2>{genre.title}</h2>
              <p>{genre.description}</p>
              <span className="detail-count">{genre.functions.length}件の機能を見る</span>
            </div>
            <span className="card-arrow" aria-hidden="true">→</span>
          </Link>
        ))}
      </div>
    </>
  );
}
