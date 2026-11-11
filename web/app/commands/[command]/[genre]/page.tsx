import Link from "next/link";
import { notFound } from "next/navigation";
import { COMMAND_GUIDES, getCommandGuide, getGenreGuide } from "@/lib/command-guides";
import Breadcrumbs from "../../../Breadcrumbs";
import FactsStrip from "../../../FactsStrip";

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
      <Breadcrumbs
        items={[
          { href: "/commands", label: "コマンド" },
          { href: `/commands/${commandGuide.slug}`, label: commandGuide.command },
          { label: genreGuide.title },
        ]}
      />
      <div className="page-heading compact-heading">
        <code className="command-code">{commandGuide.command}</code>
        <h1>{genreGuide.title}</h1>
        <p className="muted">{genreGuide.description}</p>
      </div>
      <FactsStrip
        facts={[
          { label: "機能", value: `${genreGuide.functions.length}件` },
          { label: "呼び出し方", value: `${commandGuide.command} から選択` },
          { label: "使える場所", value: commandGuide.guildOnly ? "サーバー内のみ" : "Discord内" },
        ]}
        label={`${genreGuide.title} の判断材料`}
      />
      <section className="function-list" aria-label={`${genreGuide.title}の機能説明`}>
        {genreGuide.functions.map((feature) => (
          <article key={feature.id} className="function-card">
            <h2>{feature.title}</h2>
            {feature.description && <p>{feature.description}</p>}
            {feature.note && <p className="function-note">{feature.note}</p>}
          </article>
        ))}
      </section>
      <Link className="back-link" href={`/commands/${commandGuide.slug}`}>← {commandGuide.command} のジャンル一覧へ戻る</Link>
    </>
  );
}
