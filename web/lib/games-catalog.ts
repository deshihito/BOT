// WEB ゲームジャンル（/games）のカタログ。純粋データ＋参照だけのモジュール。
//
// ゲームを1本足すときは、ここに1エントリ追加し、対局コンポーネントを
// app/games/<slug>/ に置いて app/games/[id]/page.tsx の振り分けに足す。
// 一覧ハブ（/games）と sitemap はこのカタログから自動で生成される。

export type WebGameStatus = "playable" | "coming-soon";

export type WebGame = {
  /** URL スラッグ（/games/<slug>）。 */
  slug: string;
  /** 表示名。 */
  title: string;
  /** 一覧と詳細に出す短い説明。 */
  description: string;
  /** カードのサムネイル代わりに大きく出すグリフ。 */
  glyph: string;
  /** カードのアクセント色（CSS カラー）。 */
  accent: string;
  /** 遊べる状態か、準備中か。 */
  status: WebGameStatus;
  /** Discord アクティビティ（埋め込み）内でもプレイできるか。 */
  activity: boolean;
  /** プレイ人数の目安表示。 */
  players: string;
};

export const WEB_GAMES: WebGame[] = [
  {
    slug: "chess",
    title: "チェス",
    description:
      "ブラウザでそのまま遊べる CPU 対戦チェス。着手生成は perft で検証済みのエンジンを使い、重い探索計算はあなたの端末（ブラウザ）の中で実行します。難易度は3段階、サーバーに棋譜は送られません。",
    glyph: "♞",
    accent: "#427f87",
    status: "playable",
    activity: true,
    players: "1人（CPU対戦）",
  },
  {
    slug: "balku",
    title: "BALKU",
    description:
      "素材を集めて企画を完成させる建築ブラフのカードゲーム。ルームコードで集まってオンライン対戦。伏せて提出された企画が怪しければ「BALKU」とコールして暴けます。",
    glyph: "🏗",
    accent: "#2f7f9f",
    status: "playable",
    activity: true,
    players: "1〜4人（オンライン/CPU対戦）",
  },
  {
    slug: "lll",
    title: "LLL",
    description:
      "画像をスカウトして世界に1枚のカードを作り、3枚チームで戦うカードゲーム。「想像を、切り札に。」あなたの画像が、属性・ステータス・技を持つ切り札になります。",
    glyph: "✦",
    accent: "#7c5cff",
    status: "playable",
    activity: true,
    players: "1人（CPU対戦）",
  },
];

export function getWebGame(slug: string): WebGame | undefined {
  return WEB_GAMES.find((game) => game.slug === slug);
}

export function playableGames(): WebGame[] {
  return WEB_GAMES.filter((game) => game.status === "playable");
}
