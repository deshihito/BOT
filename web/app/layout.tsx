import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { SiteNav } from "./SiteNav";
import SiteChrome from "./SiteChrome";
import { FOOTER_GROUPS, SITE_URL } from "@/lib/site";
import { GAME_COUNT, TOTAL_FUNCTIONS } from "@/lib/command-guides";

// Google AdSense の審査・所有権確認コード（自動広告もこのスクリプトで配信される）
const ADSENSE_SCRIPT_SRC =
  "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-8881841779482492";

const SITE_TITLE = "AGOBOT | 使いたいこと、全部このボットでいい。";
const SITE_DESCRIPTION =
  `AGOBOTは、ゲーム${GAME_COUNT}種・音楽とVC・コイン経済・サーバー運営・AIまで、${TOTAL_FUNCTIONS}の機能を6つのスラッシュコマンドに集約した多機能Discordボットです。`;

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
        {/* One Prompter は別サービスのデモのため共通クロームを出さない（SiteChrome がパスで判定） */}
        <SiteChrome>
          <header>
            <nav aria-label="メインメニュー">
              <Link href="/" className="brand"><img src="/img/nomal.png" alt="" />AGOBOT</Link>
              <SiteNav />
            </nav>
          </header>
        </SiteChrome>
        <main>{children}</main>
        <SiteChrome>
          <footer>
          <div className="footer-inner">
            {FOOTER_GROUPS.map((group) => (
              <nav key={group.label} className="footer-group" aria-label={group.label}>
                <p className="footer-group-title">{group.label}</p>
                {group.links.map((link) =>
                  link.external ? (
                    <a key={link.href} href={link.href} target="_blank" rel="noreferrer">{link.label}</a>
                  ) : (
                    <Link key={link.href} href={link.href}>{link.label}</Link>
                  ),
                )}
              </nav>
            ))}
          </div>
          </footer>
        </SiteChrome>
      </body>
    </html>
  );
}
