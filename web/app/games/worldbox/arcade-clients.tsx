"use client";
// AGO WORLD BOX のアーケード筐体で遊ぶゲーム本体の登録（L4b）。
// 各ゲームのクライアントは props 無しの自己完結部品（OnlineShell の枠組み）で、
// ゲームページ（app/games/[id]）が使っているものと同一。ここでは筐体パネルが
// 開いたときにだけ必要なゲームのチャンクを読み込むため、next/dynamic で
// 遅延読み込みする（WORLD BOX 本体のバンドルには載せない）。
import dynamic from "next/dynamic";
import type { ComponentType } from "react";

const Loading = () => (
  <p style={{ margin: 0, padding: 24, fontSize: 14, opacity: 0.75 }}>読み込み中…</p>
);

function lazy(load: () => Promise<{ default: ComponentType }>): ComponentType {
  return dynamic(load, { ssr: false, loading: Loading });
}

/** ゲーム ID（ONLINE_GAMES / ARCADE_GAMES のキー）→ ゲーム本体の部品。 */
export const ARCADE_CLIENTS: Record<string, ComponentType> = {
  reversi: lazy(() => import("../reversi/ReversiClient")),
  connect4: lazy(() => import("../connect4/Connect4Client")),
  battleship: lazy(() => import("../battleship/BattleshipClient")),
  territory: lazy(() => import("../territory/TerritoryClient")),
  werewolf: lazy(() => import("../werewolf/WerewolfClient")),
  wordwolf: lazy(() => import("../wordwolf/WordwolfClient")),
  majority: lazy(() => import("../majority/MajorityClient")),
  drawguess: lazy(() => import("../drawguess/DrawGuessClient")),
  daifugo: lazy(() => import("../daifugo/DaifugoClient")),
  babanuki: lazy(() => import("../babanuki/BabanukiClient")),
  quizbattle: lazy(() => import("../quizbattle/QuizBattleClient")),
  bombpass: lazy(() => import("../bombpass/BombPassClient")),
  shiritori: lazy(() => import("../shiritori/ShiritoriClient")),
  nanja: lazy(() => import("../nanja/NanjaClient")),
  liarsdice: lazy(() => import("../liarsdice/LiarsDiceClient")),
  cheat: lazy(() => import("../cheat/CheatClient")),
  hagetaka: lazy(() => import("../hagetaka/HagetakaClient")),
  burst: lazy(() => import("../burst/BurstClient")),
  texas: lazy(() => import("../texas/TexasClient")),
  countdown: lazy(() => import("../countdown/CountdownClient")),
  musicalchairs: lazy(() => import("../musicalchairs/MusicalChairsClient")),
  wordbasket: lazy(() => import("../wordbasket/WordBasketClient")),
  speed: lazy(() => import("../speed/SpeedClient")),
  typerace: lazy(() => import("../typerace/TypeRaceClient")),
  calcrace: lazy(() => import("../calcrace/CalcRaceClient")),
  stopbattle: lazy(() => import("../stopbattle/StopBattleClient")),
};

/** 筐体のゲーム本体。未登録なら null（パネル側で準備中表示にする）。 */
export function arcadeClientFor(gameId: string): ComponentType | null {
  return ARCADE_CLIENTS[gameId] ?? null;
}
