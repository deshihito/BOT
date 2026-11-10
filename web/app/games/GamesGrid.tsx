"use client";
// ゲーム一覧のカードグリッド。カタログ（lib/games-catalog.ts）から生成する。
// アクティビティのプロキシ配下では内部リンクに接頭辞が要るため、
// リンク生成だけクライアント側で行う。
import Link from "next/link";
import { WEB_GAMES, type WebGame } from "@/lib/games-catalog";
import { useGamesNav } from "./GamesShell";

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
  return (
    <div className="games-grid">
      {WEB_GAMES.map((game) => (
        <GameCard key={game.slug} game={game} prefix={prefix} />
      ))}
    </div>
  );
}
