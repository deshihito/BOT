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
import ReversiClient from "../reversi/ReversiClient";
import Connect4Client from "../connect4/Connect4Client";
import GomokuClient from "../gomoku/GomokuClient";
import BattleshipClient from "../battleship/BattleshipClient";
import DaifugoClient from "../daifugo/DaifugoClient";
import WerewolfClient from "../werewolf/WerewolfClient";

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
  if (game.slug === "reversi" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <ReversiClient />
      </>
    );
  }
  if (game.slug === "connect4" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <Connect4Client />
      </>
    );
  }
  if (game.slug === "gomoku" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <GomokuClient />
      </>
    );
  }
  if (game.slug === "battleship" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <BattleshipClient />
      </>
    );
  }
  if (game.slug === "daifugo" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <DaifugoClient />
      </>
    );
  }
  if (game.slug === "werewolf" && game.status === "playable") {
    return (
      <>
        <GameDetailHeader game={game} />
        <WerewolfClient />
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
