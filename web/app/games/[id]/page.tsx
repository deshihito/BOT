import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { WEB_GAMES, getWebGame } from "@/lib/games-catalog";
import { GameDetailHeader } from "../GamesChrome";
import ChessClient from "../chess/ChessClient";
import BalkuClient from "../balku/BalkuClient";
import LllClient from "../lll/LllClient";
import MinesweeperClient from "../minesweeper/MinesweeperClient";
import SliderClient from "../2048/SliderClient";
import MemoryClient from "../memory/MemoryClient";

export function generateStaticParams() {
  return WEB_GAMES.map((game) => ({ id: game.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const game = getWebGame((await params).id);
  if (!game) return {};
  return {
    title: game.title,
    description: game.description,
    alternates: { canonical: `/games/${game.slug}` },
  };
}

export default async function WebGamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const game = getWebGame(id);
  if (!game) notFound();
  if (game.slug === "chess" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <ChessClient />
      </>
    );
  }
  if (game.slug === "balku" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <BalkuClient />
      </>
    );
  }
  if (game.slug === "lll" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <LllClient />
      </>
    );
  }
  if (game.slug === "minesweeper" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <MinesweeperClient />
      </>
    );
  }
  if (game.slug === "2048" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <SliderClient />
      </>
    );
  }
  if (game.slug === "memory" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <MemoryClient />
      </>
    );
  }
  return (
    <>
      <GameDetailHeader game={game} />
      <div className="page-heading">
        <h1>{game.title}</h1>
        <p className="muted">{game.description}</p>
        <p className="quiet-note">このゲームは準備中です。</p>
      </div>
    </>
  );
}
