import Link from "next/link";
import { COMMAND_GUIDES, TOTAL_FUNCTIONS } from "@/lib/command-guides";
import Breadcrumbs from "../Breadcrumbs";
import FactsStrip from "../FactsStrip";

export const metadata = {
  title: "コマンド",
  description: "AGOBOTのスラッシュコマンドと全機能の一覧。各コマンドの使い方ガイドへのリンク集です。",
  alternates: { canonical: "/commands" },
};

export default function CommandsPage() {
  return (
    <>
      <Breadcrumbs items={[{ label: "コマンド" }]} />
      <div className="page-heading"><h1>コマンド</h1></div>
      <FactsStrip
        facts={[
          { label: "コマンド数", value: `${COMMAND_GUIDES.length}つ` },
          { label: "全機能数", value: `${TOTAL_FUNCTIONS}件` },
          { label: "使い方", value: "カードからガイドへ" },
          { label: "検索実行", value: "/quick" },
        ]}
        label="コマンドの判断材料"
      />
      <p className="muted" style={{ marginBottom: 20 }}>
        各コマンドの詳しい使い方は、カード先のガイドで確認できます。Discord の中では
        <code>/quick</code> から全機能を検索して、そのまま実行することもできます。
      </p>
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
