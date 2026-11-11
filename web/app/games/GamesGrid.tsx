"use client";
// ゲーム一覧のカードグリッド。カタログ（lib/games-catalog.ts）から生成する。
// アクティビティのプロキシ配下では内部リンクに接頭辞が要るため、
// リンク生成だけクライアント側で行う。
// 絞り込み（1人用／CPU対戦／オンライン）とタイトル検索、ランダム1本もここで持つ。
// 分類は catalog の players 表示文字列から導出する（カタログ側に新フィールドは足さない）。
import Link from "next/link";
import { useMemo, useState } from "react";
import { WEB_GAMES, type WebGame } from "@/lib/games-catalog";
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

function GameCard({ game, prefix }: { game: WebGame; prefix: string }) {
  const inner = (
    <>
      <div className="game-card-glyph" style={{ background: game.accent }} aria-hidden="true">
        {game.glyph}
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

export default function GamesGrid() {
  const { prefix } = useGamesNav();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<WebGame | null>(null);

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

  const pickRandom = () => {
    const pool = WEB_GAMES.filter((g) => g.status === "playable");
    if (pool.length === 0) return;
    setPicked(pool[Math.floor(Math.random() * pool.length)]);
  };

  return (
    <>
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
          🎲 ランダムで1本
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
        <div className="games-grid">
          {visible.map((game) => (
            <GameCard key={game.slug} game={game} prefix={prefix} />
          ))}
        </div>
      )}
    </>
  );
}
