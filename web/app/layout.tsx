import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { InviteButton } from "./InviteCta";
import { SITE_URL, SUPPORT_SERVER_URL } from "@/lib/site";

// Google AdSense の審査・所有権確認コード（自動広告もこのスクリプトで配信される）
const ADSENSE_SCRIPT_SRC =
  "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8881841779482492";

const SITE_TITLE = "AGOBOT | 使いたいこと、全部このボットでいい。";
const SITE_DESCRIPTION =
  "AGOBOTは、ゲーム47種・音楽とVC・コイン経済・サーバー運営・AIまで、246の機能を6つのスラッシュコマンドに集約した多機能Discordボットです。";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_TITLE, template: "%s | AGOBOT" },
  description: SITE_DESCRIPTION,
  keywords: [
    "Discord", "Discordボット", "多機能ボット", "AGOBOT",
    "ゲームボット", "人狼", "音楽ボット", "VC", "AI",
  ],
  openGraph: {
    type: "website",
    locale: "ja_JP",
    url: SITE_URL,
    siteName: "AGOBOT",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [{ url: "/img/ogp.png", width: 1200, height: 630, alt: "AGOBOT" }],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ["/img/ogp.png"],
  },
  icons: { icon: "/img/nomal.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      {/* React 19 が async script を <head> へ hoist するため、静的HTMLの head 内に実在する */}
      <script async src={ADSENSE_SCRIPT_SRC} crossOrigin="anonymous" />
      <body>
        <header>
          <nav aria-label="メインメニュー">
            <Link href="/" className="brand"><img src="/img/nomal.png" alt="" />AGOBOT</Link>
            <div className="main-nav-links">
              <Link href="/commands">コマンド</Link>
              <Link href="/dashboard">ダッシュボード</Link>
              <Link href="/ranking">ランキング</Link>
              <InviteButton />
            </div>
          </nav>
        </header>
        <main>{children}</main>
        <footer>
          <nav className="footer-links" aria-label="ポリシー">
            <a href={SUPPORT_SERVER_URL} target="_blank" rel="noreferrer">サポートサーバー</a>
            <Link href="/compute">計算に参加</Link>
            <Link href="/status">ステータス</Link>
            <Link href="/credits">クレジット</Link>
            <Link href="/terms">利用規約</Link>
            <Link href="/privacy">プライバシーポリシー</Link>
          </nav>
        </footer>
      </body>
    </html>
  );
}
