import type { Metadata } from "next";
import GamesGrid from "./GamesGrid";

export const metadata: Metadata = {
  title: "ゲーム",
  description:
    "ブラウザでそのまま遊べるAGOBOTのWEBゲーム。チェスなどのCPU対戦を、Discordのアクティビティからも遊べます。",
  alternates: { canonical: "/games" },
};

export default function GamesPage() {
  return (
    <>
      <div className="page-heading">
        <p className="eyebrow">WEB GAMES</p>
        <h1>ゲーム</h1>
        <p className="muted">
          ブラウザでそのまま遊べるゲーム集です。
          Discord のボイスチャンネルでアクティビティとして起動しても、そのまま遊べます。
        </p>
      </div>
      <GamesGrid />
      <p className="quiet-note">
        チェスの対局データは端末の中だけで処理され、サーバーへ送信されることはありません。
        BALKU と LLL は、対戦と進行の保存のためにサーバーと通信します。
      </p>
    </>
  );
}
