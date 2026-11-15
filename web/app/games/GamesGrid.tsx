"use client";
// ゲーム一覧のカードグリッド。カタログ（lib/games-catalog.ts）から生成する。
// アクティビティのプロキシ配下では内部リンクに接頭辞が要るため、
// リンク生成だけクライアント側で行う。
// 絞り込み（1人用／CPU対戦／オンライン）とタイトル検索、ランダム1本もここで持つ。
// 分類は catalog の players 表示文字列から導出する。
// 格下げタイトル（catalog の demoted）は通常タイトルの後ろに区切って表示する。
// 検索・絞り込みでは通常どおりヒットする。
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { WEB_GAMES, dailyPicksFor, getWebGame, type WebGame } from "@/lib/games-catalog";
import { useGamesNav } from "./GamesShell";

type FilterKey = "all" | "solo" | "cpu" | "online";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "すべて" },
  { key: "solo", label: "1人用" },
  { key: "cpu", label: "CPU対戦" },
  { key: "online", label: "オンライン" },
];

function matchesFilter(game: WebGame, filter: FilterKey): boolean {
  if (filter === "all") return true;
  if (filter === "solo") return game.players.startsWith("1人");
  if (filter === "cpu") return game.players.includes("CPU");
  return game.players.includes("オンライン");
}

/** カード左のタイル色はジャンル（遊び方）から決定的に割り当てる。 */
type GenreKey = "solo" | "cpu" | "online";

const GENRE_TILE_COLOR: Record<GenreKey, string> = {
  solo: "#4e7a51",
  cpu: "#46618e",
  online: "#8a4f7d",
};

function genreOf(game: WebGame): GenreKey {
  if (game.players.includes("オンライン")) return "online";
  if (game.players.includes("CPU")) return "cpu";
  return "solo";
}

function GameCard({ game, prefix }: { game: WebGame; prefix: string }) {
  const inner = (
    <>
      <div
        className="game-card-tile"
        style={{ background: GENRE_TILE_COLOR[genreOf(game)] }}
        aria-hidden="true"
      >
        {[...game.title][0] ?? ""}
      </div>
      <div className="game-card-body">
        <h2>{game.title}</h2>
        <p>{game.description}</p>
        <div className="game-card-meta">
          <span>{game.players}</span>
          {game.activity && <span className="game-badge">Discordアクティビティ対応</span>}
          {game.status === "coming-soon" && <span className="game-badge game-badge-muted">準備中</span>}
        </div>
      </div>
      {game.status === "playable" && (
        <span className="card-arrow" aria-hidden="true">
          →
        </span>
      )}
    </>
  );
  if (game.status !== "playable") {
    return <div className="game-card game-card-disabled">{inner}</div>;
  }
  return (
    <Link className="game-card" href={`${prefix}/games/${game.slug}`}>
      {inner}
    </Link>
  );
}

/** ワードルの成績キー（WordleClient と同じ端末内記録）。 */
const WORDLE_STATS_KEY = "ago-wordle-stats";

type DailyState = {
  /** JST の日付ラベル（例: 2026年11月12日（木））。 */
  label: string;
  wordle: WebGame | null;
  picks: WebGame[];
  /** ワードルの現在連勝数。記録が無い・連勝中でない場合は 0（表示しない）。 */
  wordleStreak: number;
};

function loadWordleStreak(): number {
  try {
    const raw = window.localStorage.getItem(WORDLE_STATS_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { currentStreak?: unknown };
    return typeof parsed.currentStreak === "number" && parsed.currentStreak > 0
      ? Math.floor(parsed.currentStreak)
      : 0;
  } catch {
    return 0;
  }
}

function DailyStrip({ daily, prefix }: { daily: DailyState; prefix: string }) {
  const { wordle, picks, label, wordleStreak } = daily;
  return (
    <section aria-label="今日のデイリー" style={{ margin: "0 0 28px" }}>
      <p className="eyebrow">DAILY</p>
      <h2 style={{ margin: "0 0 4px" }}>今日のデイリー</h2>
      <p className="muted" style={{ margin: "0 0 14px" }}>
        {label}のラインアップです。毎日0時（JST）に切り替わります。
      </p>
      {wordle && (
        <Link
          className="game-card"
          href={`${prefix}/games/${wordle.slug}`}
          style={{ margin: "0 0 14px" }}
        >
          <div
            className="game-card-tile"
            style={{ background: GENRE_TILE_COLOR[genreOf(wordle)] }}
            aria-hidden="true"
          >
            {[...wordle.title][0] ?? ""}
          </div>
          <div className="game-card-body">
            <h2>今日のワードル</h2>
            <p>{label}の答えは全員共通です。6回以内に当ててみましょう。</p>
            <div className="game-card-meta">
              <span>デイリー</span>
              {wordleStreak > 0 && (
                <span className="game-badge">ワードル {wordleStreak}連勝中</span>
              )}
            </div>
          </div>
          <span className="card-arrow" aria-hidden="true">
            →
          </span>
        </Link>
      )}
      {picks.length > 0 && (
        <>
          <p className="muted" style={{ margin: "0 0 10px", fontSize: 14 }}>
            日替わりおすすめ
          </p>
          <div className="games-grid">
            {picks.map((game) => (
              <GameCard key={game.slug} game={game} prefix={prefix} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export default function GamesGrid() {
  const { prefix } = useGamesNav();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<WebGame | null>(null);
  // デイリー帯は日付と端末内記録に依存するため、マウント後にだけ確定させる
  // （サーバー描画との日付ずれによる不一致を避ける）。
  const [daily, setDaily] = useState<DailyState | null>(null);

  useEffect(() => {
    const now = new Date();
    setDaily({
      label: new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "short",
      }).format(now),
      wordle: getWebGame("wordle") ?? null,
      picks: dailyPicksFor(now),
      wordleStreak: loadWordleStreak(),
    });
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return WEB_GAMES.filter((game) => {
      if (!matchesFilter(game, filter)) return false;
      if (!q) return true;
      return (
        game.title.toLowerCase().includes(q) ||
        game.description.toLowerCase().includes(q) ||
        game.slug.includes(q)
      );
    });
  }, [filter, query]);

  // 格下げタイトルは通常タイトルの後ろに分離して出す（並び順はカタログ順を保つ）。
  const primary = visible.filter((game) => !game.demoted);
  const demoted = visible.filter((game) => game.demoted);

  const pickRandom = () => {
    const pool = WEB_GAMES.filter((g) => g.status === "playable");
    if (pool.length === 0) return;
    setPicked(pool[Math.floor(Math.random() * pool.length)]);
  };

  return (
    <>
      {daily && <DailyStrip daily={daily} prefix={prefix} />}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
          margin: "0 0 16px",
        }}
      >
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            aria-pressed={filter === f.key}
            style={{
              minHeight: 40,
              padding: "8px 16px",
              borderRadius: 999,
              border: "1px solid var(--line, #d8d8d8)",
              background: filter === f.key ? "var(--ink, #222)" : "transparent",
              color: filter === f.key ? "var(--paper, #fff)" : "inherit",
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            {f.label}
          </button>
        ))}
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="ゲーム名で検索"
          aria-label="ゲーム名で検索"
          style={{
            minHeight: 40,
            padding: "8px 12px",
            borderRadius: 999,
            border: "1px solid var(--line, #d8d8d8)",
            background: "transparent",
            color: "inherit",
            fontSize: 14,
            flex: "1 1 160px",
            maxWidth: 280,
          }}
        />
        <button
          type="button"
          onClick={pickRandom}
          style={{
            minHeight: 40,
            padding: "8px 16px",
            borderRadius: 999,
            border: "1px solid var(--line, #d8d8d8)",
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
            fontSize: 14,
          }}
        >
          ランダムで1本
        </button>
        {picked && (
          <Link href={`${prefix}/games/${picked.slug}`} style={{ fontSize: 14 }}>
            → {picked.title}を遊ぶ
          </Link>
        )}
      </div>
      {visible.length === 0 ? (
        <p className="muted">条件に合うゲームがありません。絞り込みや検索を変えてみてください。</p>
      ) : (
        <>
          {primary.length > 0 && (
            <div className="games-grid">
              {primary.map((game) => (
                <GameCard key={game.slug} game={game} prefix={prefix} />
              ))}
            </div>
          )}
          {demoted.length > 0 && (
            <section aria-label="その他のゲーム" style={{ marginTop: primary.length > 0 ? 36 : 0 }}>
              <h2 style={{ margin: "0 0 14px" }}>その他のゲーム</h2>
              <div className="games-grid">
                {demoted.map((game) => (
                  <GameCard key={game.slug} game={game} prefix={prefix} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}
