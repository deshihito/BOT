import Link from "next/link";
import { notFound } from "next/navigation";
import { COMMAND_GUIDES, getCommandGuide, getGenreGuide } from "@/lib/command-guides";

export function generateStaticParams() {
  return COMMAND_GUIDES.flatMap((command) =>
    command.genres.map((genre) => ({ command: command.slug, genre: genre.slug })),
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ command: string; genre: string }>;
}) {
  const { command, genre } = await params;
  const commandGuide = getCommandGuide(command);
  const genreGuide = getGenreGuide(command, genre);
  if (!commandGuide || !genreGuide) return {};
  return {
    title: `${genreGuide.title} | ${commandGuide.command}`,
    description: genreGuide.description,
    alternates: { canonical: `/commands/${commandGuide.slug}/${genreGuide.slug}` },
  };
}

export default async function GenrePage({
  params,
}: {
  params: Promise<{ command: string; genre: string }>;
}) {
  const { command, genre } = await params;
  const commandGuide = getCommandGuide(command);
  const genreGuide = getGenreGuide(command, genre);
  if (!commandGuide || !genreGuide) notFound();

  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href="/commands">コマンド一覧</Link><span> / </span>
        <Link href={`/commands/${commandGuide.slug}`}>{commandGuide.command}</Link><span> / </span>
        <span>{genreGuide.title}</span>
      </nav>
      <div className="page-heading compact-heading">
        <code className="command-code">{commandGuide.command}</code>
        <h1>{genreGuide.title}</h1>
        <p className="muted">{genreGuide.description}</p>
      </div>
      <section className="function-list" aria-label={`${genreGuide.title}の機能説明`}>
        {genreGuide.functions.map((feature) => (
          <article key={feature.title} className="function-card">
            <h2>{feature.title}</h2>
            <p>{feature.description}</p>
            {feature.note && <p className="function-note">{feature.note}</p>}
          </article>
        ))}
      </section>
      <Link className="back-link" href={`/commands/${commandGuide.slug}`}>← {commandGuide.command} のジャンル一覧へ戻る</Link>
    </>
  );
}
