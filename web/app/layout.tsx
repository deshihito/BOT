import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "AGOBOT サポート",
  description: "AGOBOTのコマンド案内",
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
            </div>
          </nav>
        </header>
        <main>{children}</main>
        <footer>
          <nav className="footer-links" aria-label="ポリシー">
            <Link href="/terms">利用規約</Link>
            <Link href="/privacy">プライバシーポリシー</Link>
          </nav>
        </footer>
      </body>
    </html>
  );
}
