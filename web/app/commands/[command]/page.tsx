import Link from "next/link";
import { notFound } from "next/navigation";
import { COMMAND_GUIDES, getCommandGuide } from "@/lib/command-guides";

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

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href="/commands">コマンド一覧</Link><span> / </span><span>{guide.command}</span>
      </nav>
      <div className="page-heading compact-heading">
        <code className="command-code">{guide.command}</code>
        <h1>{guide.title}</h1>
        <p className="muted">{guide.description}</p>
        {guide.guildOnly && <p className="quiet-note">このコマンドはサーバー内で使えます。</p>}
      </div>
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
