import type { Metadata } from "next";
import { playableGames } from "@/lib/games-catalog";
import FactsStrip from "../FactsStrip";
import DiscordPlayCta from "./DiscordPlayCta";
import { GamesBreadcrumb } from "./GamesChrome";
import GamesGrid from "./GamesGrid";

export const metadata: Metadata = {
  title: "ゲーム",
  description:
    "ブラウザでそのまま遊べるAGOBOTのWEBゲーム。チェスなどのCPU対戦を、Discordのアクティビティからも遊べます。",
  alternates: { canonical: "/games" },
};

export default function GamesPage() {
  const playable = playableGames();
  return (
    <>
      <GamesBreadcrumb />
      <div className="page-heading">
        <p className="eyebrow">WEB GAMES</p>
        <h1>ゲーム</h1>
        <p className="muted">
          ブラウザでそのまま遊べるゲーム集です。
          Discord のボイスチャンネルでアクティビティとして起動しても、そのまま遊べます。
        </p>
      </div>
      <FactsStrip
        facts={[
          { label: "遊べるゲーム", value: `${playable.length}本` },
          { label: "対応環境", value: "ブラウザ／Discordアクティビティ" },
          { label: "対戦相手", value: "CPU・オンライン" },
          { label: "料金", value: "無料" },
        ]}
        label="ゲームの判断材料"
      />
      <DiscordPlayCta />
      <GamesGrid />
      <p className="quiet-note">
        チェスの対局データは端末の中だけで処理され、サーバーへ送信されることはありません。
        BALKU と LLL は、対戦と進行の保存のためにサーバーと通信します。
      </p>
    </>
  );
}
