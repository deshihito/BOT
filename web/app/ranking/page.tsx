import Link from "next/link";
import { isBotApiConfigured, kvGet } from "@/lib/bot-api";
import {
  parseRankingSnapshot,
  PUBLIC_RANKING_KEY,
  PUBLIC_RANKING_NAMESPACE,
  type PublicRankingSnapshot,
  type RankingEntry,
} from "@/lib/site";
import { InviteCtaBlock } from "../InviteCta";

export const metadata = { title: "リーダーボード | AGOBOT", alternates: { canonical: "/ranking" } };
export const dynamic = "force-dynamic";

type Axis = "exp" | "coin" | "bump" | "up";
type Order = "asc" | "desc";

/** ランキングの種類。natural はスナップショットが保持している並び順。 */
const AXES: { key: Axis; label: string; natural: Order; valueLabel: string }[] = [
  { key: "exp", label: "EXP総合", natural: "desc", valueLabel: "EXP" },
  { key: "coin", label: "コイン保有", natural: "desc", valueLabel: "コイン" },
  { key: "bump", label: "bump RTA", natural: "asc", valueLabel: "タイム" },
  { key: "up", label: "up RTA", natural: "asc", valueLabel: "タイム" },
];

type PageProps = {
  searchParams: Promise<{ axis?: string; order?: string }>;
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

function rankingHref(axis: Axis, order: Order | null): string {
  const params = new URLSearchParams();
  if (axis !== "exp") params.set("axis", axis);
  if (order) params.set("order", order);
  const query = params.toString();
  return query ? `/ranking?${query}` : "/ranking";
}

function formatValue(axis: Axis, entry: RankingEntry): string {
  if (axis === "bump" || axis === "up") return `${(entry.value / 1000).toFixed(2)}秒`;
  if (axis === "coin") return `${entry.value.toLocaleString("ja-JP")} AGO`;
  return entry.value.toLocaleString("ja-JP");
}

export default async function RankingPage({ searchParams }: PageProps) {
  const { axis, order } = await searchParams;
  const active = AXES.find((a) => a.key === axis) ?? AXES[0];
  const chosenOrder: Order | null = order === "asc" || order === "desc" ? order : null;
  const effectiveOrder: Order = chosenOrder ?? active.natural;
  const snapshot = await loadSnapshot();
  const entries = snapshot ? [...snapshot[active.key]] : [];
  if (effectiveOrder !== active.natural) entries.reverse();

  return (
    <section className="ranking-page">
      <h1>リーダーボード</h1>
      <p className="muted">全サーバー横断のランキングです。1時間ごとに更新されます。</p>
      <div className="ranking-tabs" role="tablist" aria-label="ランキングの種類">
        {AXES.map((a) => (
          <Link
            key={a.key}
            href={rankingHref(a.key, chosenOrder)}
            className={active.key === a.key ? "ranking-tab active" : "ranking-tab"}
            role="tab"
            aria-selected={active.key === a.key}
          >
            {a.label}
          </Link>
        ))}
      </div>
      {snapshot === null ? (
        <div className="simple-panel">
          <p>ランキングはまだ準備中です。集計が終わり次第、ここに表示されます。</p>
          <p><Link href="/">トップへ戻る</Link></p>
        </div>
      ) : (
        <>
          <div className="ranking-tabs" role="group" aria-label="並び順">
            <span className="muted">並び順：</span>
            <Link
              href={rankingHref(active.key, "asc")}
              className={effectiveOrder === "asc" ? "ranking-tab active" : "ranking-tab"}
              aria-pressed={effectiveOrder === "asc"}
            >
              昇順
            </Link>
            <Link
              href={rankingHref(active.key, "desc")}
              className={effectiveOrder === "desc" ? "ranking-tab active" : "ranking-tab"}
              aria-pressed={effectiveOrder === "desc"}
            >
              降順
            </Link>
          </div>
          <table className="ranking-table">
            <thead>
              <tr>
                <th scope="col">順位</th>
                <th scope="col">ユーザー</th>
                {active.key === "exp" ? <th scope="col">レベル</th> : null}
                <th scope="col">{active.valueLabel}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr key={index}>
                  <td>{index + 1}</td>
                  <td>{entry.name || "（名前を取得できませんでした）"}</td>
                  {active.key === "exp" ? <td>{entry.level ?? "—"}</td> : null}
                  <td>{formatValue(active.key, entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {entries.length === 0 ? (
            <p className="muted">まだランキングに載っている人がいません。</p>
          ) : null}
          <p className="muted">最終更新：{formatUpdatedAt(snapshot.updated_at)}</p>
        </>
      )}
      <InviteCtaBlock />
    </section>
  );
}
