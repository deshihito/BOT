import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import BrowserLocalization from "./BrowserLocalization";

export const metadata: Metadata = {
  title: "AGOBOT サポート",
  description: "AGOBOTのコマンドと使い方を、ジャンルごとに案内します。",
  icons: { icon: "/img/nomal.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <BrowserLocalization />
        <header>
          <nav aria-label="メインメニュー">
            <Link href="/" className="brand"><img src="/img/nomal.png" alt="" />AGOBOT</Link>
            <div className="main-nav-links">
              <Link href="/">ホーム</Link>
              <Link href="/commands">コマンド一覧</Link>
              <Link href="/ranking">リーダーボード</Link>
              <Link href="/dashboard">ダッシュボード</Link>
              <Link href="/coder" className="nav-coder-link">AGO Coder</Link>
            </div>
          </nav>
        </header>
        <main>{children}</main>
        <footer>
          <div>AGOBOT サポート</div>
          <nav className="footer-links" aria-label="ポリシー">
            <Link href="/terms">利用規約</Link>
            <Link href="/privacy">プライバシーポリシー</Link>
          </nav>
        </footer>
      </body>
    </html>
  );
}
