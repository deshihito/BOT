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
          ブラウザでそのまま遊べるゲーム集です。重い計算はサーバーではなく、あなたの端末（ブラウザ）の中で実行します。
          Discord のボイスチャンネルでアクティビティとして起動しても、そのまま遊べます。
        </p>
      </div>
      <GamesGrid />
      <p className="quiet-note">対局データは端末の中だけで処理され、サーバーへ送信されることはありません。</p>
    </>
  );
}
