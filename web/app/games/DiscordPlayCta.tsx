"use client";
// /games ハブの Discord 導線。Activity 内で開かれているときは
// その状態と本人確認の結果を示し、通常ブラウザでは Activity として
// 遊べることと、ボット追加への導線を出す。絵文字は使わずテキストで示す。
import { InviteButton } from "../InviteCta";
import { useGamesNav } from "./GamesShell";

export default function DiscordPlayCta() {
  const { embedded, identity } = useGamesNav();

  if (embedded) {
    return (
      <section className="games-discord-cta" aria-label="Discordアクティビティ">
        <h2>Discordアクティビティでプレイ中</h2>
        <p className="muted">
          {identity
            ? `Discordアカウント「${identity.name}」の名前とアバターが、オンライン対戦の既定値として使われます。ルーム画面の「Discordで招待」から、そのまま友達を呼べます。`
            : "オンライン対戦のルーム画面から、招待リンクを送るだけで友達を呼べます。"}
        </p>
      </section>
    );
  }

  return (
    <section className="games-discord-cta" aria-label="Discordで遊ぶ">
      <h2>Discordで遊ぶ</h2>
      <p className="muted">
        AGOBOT を追加したサーバーのボイスチャンネルでアクティビティを起動すると、このゲーム集が Discord の中でそのまま遊べます。
        オンライン対戦では Discord の名前とアバターが自動で使われ、ルームの招待リンクを送るだけで友達が参加できます。
      </p>
      <InviteButton />
    </section>
  );
}
