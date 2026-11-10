import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { WEB_GAMES, getWebGame } from "@/lib/games-catalog";
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
    return <ChessClient />;
  }
  if (game.slug === "balku" && game.status === "playable") {
    return <BalkuClient />;
  }
  if (game.slug === "lll" && game.status === "playable") {
    return <LllClient />;
  }
  if (game.slug === "minesweeper" && game.status === "playable") {
    return <MinesweeperClient />;
  }
  if (game.slug === "2048" && game.status === "playable") {
    return <SliderClient />;
  }
  if (game.slug === "memory" && game.status === "playable") {
    return <MemoryClient />;
  }
  return (
    <>
      <nav className="breadcrumbs" aria-label="パンくず">
        <Link href="/games">ゲーム</Link>
        <span> / </span>
        <span>{game.title}</span>
      </nav>
      <div className="page-heading">
        <h1>{game.title}</h1>
        <p className="muted">{game.description}</p>
        <p className="quiet-note">このゲームは準備中です。</p>
      </div>
    </>
  );
}
