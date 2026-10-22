import Link from "next/link";
import { COMMAND_GUIDES } from "@/lib/command-guides";

export const metadata = { title: "コマンド | AGOBOT" };

export default function CommandsPage() {
  return (
    <>
      <div className="page-heading"><h1>コマンド</h1></div>
      <nav className="command-list" aria-label="公開コマンド一覧">
        {COMMAND_GUIDES.map((guide) => (
          <Link key={guide.slug} href={`/commands/${guide.slug}`} className="command-card">
            <div><code className="command-code">{guide.command}</code><h2>{guide.title}</h2></div>
            <span className="card-arrow" aria-hidden="true">→</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
