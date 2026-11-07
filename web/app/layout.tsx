import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { InviteButton } from "./InviteCta";
import { SITE_URL, SUPPORT_SERVER_URL } from "@/lib/site";

const SITE_TITLE = "AGOBOT | 使いたいこと、全部このボットでいい。";
const SITE_DESCRIPTION =
  "AGOBOTは、ゲーム47種・音楽とVC・コイン経済・サーバー運営・AIまで、195の機能を6つのスラッシュコマンドに集約した多機能Discordボットです。";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  openGraph: {
    type: "website",
    locale: "ja_JP",
    url: SITE_URL,
    siteName: "AGOBOT",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ["/img/nomal.png"],
  },
  twitter: {
    card: "summary",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ["/img/nomal.png"],
  },
  icons: { icon: "/img/nomal.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <header>
          <nav aria-label="メインメニュー">
            <Link href="/" className="brand"><img src="/img/nomal.png" alt="" />AGOBOT</Link>
            <div className="main-nav-links">
              <Link href="/commands">コマンド</Link>
              <Link href="/dashboard">ダッシュボード</Link>
              <InviteButton />
            </div>
          </nav>
        </header>
        <main>{children}</main>
        <footer>
          <nav className="footer-links" aria-label="ポリシー">
            <a href={SUPPORT_SERVER_URL} target="_blank" rel="noreferrer">サポートサーバー</a>
            <Link href="/terms">利用規約</Link>
            <Link href="/privacy">プライバシーポリシー</Link>
          </nav>
        </footer>
      </body>
    </html>
  );
}
