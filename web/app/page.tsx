import Link from "next/link";
import { COMMAND_GUIDES } from "@/lib/command-guides";

export default function Home() {
  return (
    <>
      <section className="home-hero">
        <img src="/img/nomal.png" alt="AGOBOT" />
        <div>
          <h1>使いたいこと、全部このボットでいい。</h1>
          <Link className="primary-link" href="/commands">コマンド</Link>
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
