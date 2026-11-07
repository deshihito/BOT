import { BOT_INVITE_URL } from "@/lib/site";

/** 招待CTA（F1/F3 共通部品）。リンク先は lib/site.ts の定数が唯一の正。 */
export function InviteButton({ className = "invite-button" }: { className?: string }) {
  return (
    <a className={className} href={BOT_INVITE_URL} target="_blank" rel="noreferrer">
      Discordに追加
    </a>
  );
}

/** ページ末尾に置く招待の誘導ブロック（ランキング等のフッターCTA）。 */
export function InviteCtaBlock() {
  return (
    <div className="invite-cta-block">
      <p>使いたいこと、全部このボットでいい。</p>
      <InviteButton />
    </div>
  );
}
