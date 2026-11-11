import type { Metadata } from "next";
import { COMMAND_GUIDES, TOTAL_FUNCTIONS } from "@/lib/command-guides";
import FactsStrip from "../FactsStrip";
import FeaturesExplorer from "./FeaturesExplorer";

export const metadata: Metadata = {
  title: "機能紹介",
  description:
    `AGOBOTの機能は全部で${TOTAL_FUNCTIONS}件。コマンドごとに整理された全機能を、ジャンルごとに紹介します。`,
  alternates: { canonical: "/features" },
};

export default function FeaturesPage() {
  return (
    <section className="home-features">
      <div className="page-heading"><h1>機能紹介</h1></div>
      <FactsStrip
        facts={[
          { label: "機能数", value: `全${TOTAL_FUNCTIONS}件` },
          { label: "コマンド", value: `${COMMAND_GUIDES.length}つ＋/quick` },
          { label: "料金", value: "無料" },
          { label: "対象", value: "Discordサーバー" },
        ]}
        label="機能紹介の判断材料"
      />
      <p className="home-features-lead">
        AGOBOT の機能は、下のコマンドに整理されています。<code>/quick</code>
        からは全機能を検索して直接実行できます。機能の追加や変更は、このページにも自動で反映されます。
        気になるジャンルはチップで絞り込めます。
      </p>
      <FeaturesExplorer />
    </section>
  );
}
