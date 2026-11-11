"use client";
// /games 配下のページ内クローム（パンくず・判断材料ヘッダー）。
// Discord アクティビティの埋め込みモードでは共通クロームを一切出さない
// 既存仕様に合わせ、埋め込み時は useGamesNav の embedded を見て描画しない。
import Link from "next/link";
import type { WebGame } from "@/lib/games-catalog";
import FactsStrip from "../FactsStrip";
import { useGamesNav } from "./GamesShell";

export function GamesBreadcrumb({ current }: { current?: string }) {
  const { embedded, prefix } = useGamesNav();
  if (embedded) return null;
  return (
    <nav className="breadcrumbs" aria-label="パンくず">
      <Link href="/">トップ</Link>
      <span> / </span>
      {current ? (
        <>
          <Link href={`${prefix}/games`}>ゲーム</Link>
          <span> / </span>
          <span>{current}</span>
        </>
      ) : (
        <span>ゲーム</span>
      )}
    </nav>
  );
}

export function GameDetailHeader({ game }: { game: WebGame }) {
  const { embedded } = useGamesNav();
  if (embedded) return null;
  return (
    <>
      <GamesBreadcrumb current={game.title} />
      <FactsStrip
        facts={[
          { label: "状態", value: game.status === "playable" ? "今すぐ遊べます" : "準備中" },
          { label: "人数", value: game.players },
          { label: "対応環境", value: game.activity ? "ブラウザ／Discordアクティビティ" : "ブラウザ" },
          { label: "料金", value: "無料" },
        ]}
        label={`${game.title} の判断材料`}
      />
    </>
  );
}
