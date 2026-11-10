import Link from "next/link";
import { isBotApiConfigured, kvGet } from "@/lib/bot-api";
import {
  parseRankingSnapshot,
  PUBLIC_RANKING_KEY,
  PUBLIC_RANKING_NAMESPACE,
  RTA_SERVICES,
  RTA_SERVICE_LABELS,
  type PublicRankingSnapshot,
  type RankingEntry,
  type RtaEntry,
} from "@/lib/site";
import { InviteCtaBlock } from "../InviteCta";

export const metadata = {
  title: "リーダーボード",
  description: "AGOBOTのランキング。経験値・コイン保有と、bump系RTA（DISBOARD bump・Dis速 up・鯖ちゃんねる・TakasumiBOT・Dicoall・Discord Cafe・SharkBot・DiscordServers.io・DISCOM）の全サーバー記録を、総合・サービス別で表示します。",
  alternates: { canonical: "/ranking" },
};
export const dynamic = "force-dynamic";

type Axis = "exp" | "coin" | "rta";
type Order = "asc" | "desc";
type Speed = "fast" | "slow";

const AXES: { key: Axis; label: string; natural: Order; valueLabel: string }[] = [
  { key: "exp", label: "EXP総合", natural: "desc", valueLabel: "EXP" },
  { key: "coin", label: "コイン保有", natural: "desc", valueLabel: "コイン" },
  { key: "rta", label: "bump系RTA", natural: "asc", valueLabel: "タイム" },
];

type PageProps = {
  searchParams: Promise<{ axis?: string; order?: string; service?: string; speed?: string }>;
};

async function loadSnapshot(): Promise<PublicRankingSnapshot | null> {
  if (!isBotApiConfigured()) return null;
  try {
    return parseRankingSnapshot(await kvGet(PUBLIC_RANKING_NAMESPACE, PUBLIC_RANKING_KEY));
  } catch {
    return null;
  }
}

function formatDateTime(iso: string): string {
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

function formatRecordAt(entry: RtaEntry): string {
  return entry.at ? formatDateTime(entry.at) : "—";
}

type HrefOptions = { service?: string; speed?: Speed; order?: Order | null };

function rankingHref(axis: Axis, options: HrefOptions = {}): string {
  const params = new URLSearchParams();
  if (axis !== "exp") params.set("axis", axis);
  if (axis === "rta") {
    if (options.service && options.service !== "all") params.set("service", options.service);
    if (options.speed && options.speed !== "fast") params.set("speed", options.speed);
  } else if (options.order) {
    params.set("order", options.order);
  }
  const query = params.toString();
  return query ? `/ranking?${query}` : "/ranking";
}

function formatValue(axis: Axis, entry: RankingEntry): string {
  if (axis === "rta") return `${(entry.value / 1000).toFixed(2)}秒`;
  if (axis === "coin") return `${entry.value.toLocaleString("ja-JP")} AGO`;
  return entry.value.toLocaleString("ja-JP");
}

export default async function RankingPage({ searchParams }: PageProps) {
  const params = await searchParams;
  // 旧リンク互換: axis=bump / axis=up は bump系RTA の各サービスとして読む
  let axisParam = params.axis;
  let serviceParam = params.service;
  if (axisParam === "bump" || axisParam === "up") {
    serviceParam = axisParam;
    axisParam = "rta";
  }
  const active = AXES.find((a) => a.key === axisParam) ?? AXES[0];
  const chosenOrder: Order | null =
    params.order === "asc" || params.order === "desc" ? params.order : null;
  const effectiveOrder: Order = chosenOrder ?? active.natural;
  const service = RTA_SERVICES.some((s) => s.key === serviceParam)
    ? (serviceParam as string)
    : "all";
  const speed: Speed = params.speed === "slow" ? "slow" : "fast";

  const snapshot = await loadSnapshot();
  const isRta = active.key === "rta";
  const plainEntries: RankingEntry[] =
    snapshot && !isRta ? [...snapshot[active.key as "exp" | "coin"]] : [];
  if (!isRta && effectiveOrder !== active.natural) plainEntries.reverse();
  const rtaEntries: RtaEntry[] =
    snapshot && isRta ? (snapshot.rta[service]?.[speed] ?? []) : [];

  return (
    <section className="ranking-page">
      <h1>リーダーボード</h1>
      <p className="muted">全サーバー横断のランキングです。1時間ごとに更新されます。</p>
      <div className="ranking-tabs" role="tablist" aria-label="ランキングの種類">
        {AXES.map((a) => (
          <Link
            key={a.key}
            href={rankingHref(a.key, a.key === "rta" ? { service, speed } : { order: chosenOrder })}
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
      ) : isRta ? (
        <>
          <form className="ranking-service-form" method="get" action="/ranking">
            <input type="hidden" name="axis" value="rta" />
            {speed !== "fast" ? <input type="hidden" name="speed" value={speed} /> : null}
            <label>
              サービス：
              <select name="service" defaultValue={service} className="ranking-select">
                {RTA_SERVICES.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="ranking-tab">表示</button>
          </form>
          <div className="ranking-tabs" role="group" aria-label="最速か最遅か">
            <span className="muted">記録：</span>
            <Link
              href={rankingHref("rta", { service, speed: "fast" })}
              className={speed === "fast" ? "ranking-tab active" : "ranking-tab"}
              aria-pressed={speed === "fast"}
            >
              最速
            </Link>
            <Link
              href={rankingHref("rta", { service, speed: "slow" })}
              className={speed === "slow" ? "ranking-tab active" : "ranking-tab"}
              aria-pressed={speed === "slow"}
            >
              最遅
            </Link>
          </div>
          <table className="ranking-table">
            <thead>
              <tr>
                <th scope="col">順位</th>
                <th scope="col">ユーザー</th>
                {service === "all" ? <th scope="col">サービス</th> : null}
                <th scope="col">タイム</th>
                <th scope="col">記録日時</th>
              </tr>
            </thead>
            <tbody>
              {rtaEntries.map((entry, index) => (
                <tr key={index}>
                  <td>{index + 1}</td>
                  <td>{entry.name || "（名前を取得できませんでした）"}</td>
                  {service === "all" ? (
                    <td>{RTA_SERVICE_LABELS[entry.service ?? ""] ?? entry.service ?? "—"}</td>
                  ) : null}
                  <td>{formatValue("rta", entry)}</td>
                  <td>{formatRecordAt(entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rtaEntries.length === 0 ? (
            <p className="muted">まだこのボードに載っている記録がありません。</p>
          ) : null}
          <p className="muted">最終更新：{formatDateTime(snapshot.updated_at)}</p>
        </>
      ) : (
        <>
          <div className="ranking-tabs" role="group" aria-label="並び順">
            <span className="muted">並び順：</span>
            <Link
              href={rankingHref(active.key, { order: "asc" })}
              className={effectiveOrder === "asc" ? "ranking-tab active" : "ranking-tab"}
              aria-pressed={effectiveOrder === "asc"}
            >
              昇順
            </Link>
            <Link
              href={rankingHref(active.key, { order: "desc" })}
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
              {plainEntries.map((entry, index) => (
                <tr key={index}>
                  <td>{index + 1}</td>
                  <td>{entry.name || "（名前を取得できませんでした）"}</td>
                  {active.key === "exp" ? <td>{entry.level ?? "—"}</td> : null}
                  <td>{formatValue(active.key, entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {plainEntries.length === 0 ? (
            <p className="muted">まだランキングに載っている人がいません。</p>
          ) : null}
          <p className="muted">最終更新：{formatDateTime(snapshot.updated_at)}</p>
        </>
      )}
      <InviteCtaBlock />
    </section>
  );
}
