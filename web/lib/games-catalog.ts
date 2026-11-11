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
    slug: "minesweeper",
    title: "マインスイーパー",
    description:
      "地雷を避けてマスを全部開く定番パズル。数字は周囲の地雷の数で、最初のマスは必ず安全です。難易度は3段階、旗モードでスマホでも遊べます。",
    glyph: "💣",
    accent: "#b3543f",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "2048",
    title: "2048",
    description:
      "同じ数字をぶつけて大きくしていくスライドパズル。矢印キー・ボタン・スワイプで操作して、2048 のタイルを目指します。",
    glyph: "2048",
    accent: "#c98a2d",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "memory",
    title: "メモリーマッチ",
    description:
      "裏返したカードの絵柄を当てる神経衰弱。8ペア16枚を、手数の少なさを目指してそろえます。",
    glyph: "🃏",
    accent: "#3f7f5f",
    status: "playable",
    activity: true,
    players: "1人",
  },
  {
    slug: "reversi",
    title: "リバーシ",
    description:
      "挟んでひっくり返す定番ボードゲーム。ルームコードや公開ルームでオンライン対戦ができ、CPU相手に1人で遊ぶこともできます。角を取る読み合いが勝負です。",
    glyph: "●",
    accent: "#2f7f5e",
    status: "playable",
    activity: true,
    players: "2人（オンライン/CPU対戦）",
  },
  {
    slug: "connect4",
    title: "四目並べ",
    description:
      "コマを落として縦・横・斜めのどれか4つを先にそろえる対戦パズル。ルームコードや公開ルームでオンライン対戦ができ、CPU相手にも遊べます。",
    glyph: "🔴",
    accent: "#c94f43",
    status: "playable",
    activity: true,
    players: "2人（オンライン/CPU対戦）",
  },
  {
    slug: "gomoku",
    title: "五目並べ",
    description:
      "石を交互に置いて5つ並べた方が勝ちの古典ボードゲーム。ルームコードや公開ルームでオンライン対戦ができ、CPU相手に1人でも遊べます。",
    glyph: "⚫",
    accent: "#8a6d3b",
    status: "playable",
    activity: true,
    players: "2人（オンライン/CPU対戦）",
  },
  {
    slug: "battleship",
    title: "海戦ゲーム",
    description:
      "艦隊を配置して相手の海域を砲撃し合う読み合いの対戦ゲーム。ルームコードや公開ルームで集まってオンライン対戦できます。命中と沈没の駆け引きが鍵です。",
    glyph: "🚢",
    accent: "#2f5f8f",
    status: "playable",
    activity: true,
    players: "2人（オンライン）",
  },
  {
    slug: "daifugo",
    title: "大富豪",
    description:
      "手札を全て出し切る順位を競う定番トランプゲーム。ルームコードや公開ルームで2〜4人がオンライン対戦でき、空き席にはCPUも入れられます。革命や流れる場の読み合いが楽しめます。",
    glyph: "♠",
    accent: "#7a4fa3",
    status: "playable",
    activity: true,
    players: "2〜4人（オンライン/CPU対戦）",
  },
  {
    slug: "werewolf",
    title: "人狼",
    description:
      "村人の中に紛れた人狼を、夜の襲撃と昼の議論・投票で見抜く正体隠匿ゲーム。ルームコードや公開ルームで4〜8人がオンラインで遊べます。役職は各プレイヤーにだけ知らされます。",
    glyph: "🐺",
    accent: "#5b4a8a",
    status: "playable",
    activity: true,
    players: "4〜8人（オンライン）",
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
