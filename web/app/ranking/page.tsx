import Link from "next/link";
import { isBotApiConfigured, kvGet } from "@/lib/bot-api";
import {
  parseRankingSnapshot,
  PUBLIC_RANKING_KEY,
  PUBLIC_RANKING_NAMESPACE,
  type PublicRankingSnapshot,
} from "@/lib/site";
import { InviteCtaBlock } from "../InviteCta";

export const metadata = { title: "リーダーボード | AGOBOT", alternates: { canonical: "/ranking" } };
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{ axis?: string }>;
};

async function loadSnapshot(): Promise<PublicRankingSnapshot | null> {
  if (!isBotApiConfigured()) return null;
  try {
    return parseRankingSnapshot(await kvGet(PUBLIC_RANKING_NAMESPACE, PUBLIC_RANKING_KEY));
  } catch {
    return null;
  }
}

function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default async function RankingPage({ searchParams }: PageProps) {
  const { axis } = await searchParams;
  const active = axis === "coin" ? "coin" : "exp";
  const snapshot = await loadSnapshot();

  return (
    <section className="ranking-page">
      <h1>リーダーボード</h1>
      <p className="muted">全サーバー横断のランキングです。1時間ごとに更新されます。</p>
      <div className="ranking-tabs" role="tablist" aria-label="ランキングの種類">
        <Link href="/ranking" className={active === "exp" ? "ranking-tab active" : "ranking-tab"} role="tab" aria-selected={active === "exp"}>
          EXP総合
        </Link>
        <Link href="/ranking?axis=coin" className={active === "coin" ? "ranking-tab active" : "ranking-tab"} role="tab" aria-selected={active === "coin"}>
          コイン保有
        </Link>
      </div>
      {snapshot === null ? (
        <div className="simple-panel">
          <p>ランキングはまだ準備中です。集計が終わり次第、ここに表示されます。</p>
          <p><Link href="/">トップへ戻る</Link></p>
        </div>
      ) : (
        <>
          <table className="ranking-table">
            <thead>
              <tr>
                <th scope="col">順位</th>
                <th scope="col">ユーザー</th>
                {active === "exp" ? <th scope="col">レベル</th> : null}
                <th scope="col">{active === "exp" ? "EXP" : "コイン"}</th>
              </tr>
            </thead>
            <tbody>
              {(active === "exp" ? snapshot.exp : snapshot.coin).map((entry, index) => (
                <tr key={index}>
                  <td>{index + 1}</td>
                  <td>{entry.name || "（名前を取得できませんでした）"}</td>
                  {active === "exp" ? <td>{entry.level ?? "—"}</td> : null}
                  <td>{entry.value.toLocaleString("ja-JP")}{active === "coin" ? " AGO" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(active === "exp" ? snapshot.exp : snapshot.coin).length === 0 ? (
            <p className="muted">まだランキングに載っている人がいません。</p>
          ) : null}
          <p className="muted">最終更新：{formatUpdatedAt(snapshot.updated_at)}</p>
        </>
      )}
      <InviteCtaBlock />
    </section>
  );
}
