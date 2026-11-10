import Link from "next/link";
import type { ReactNode } from "react";

// One Prompter 単独の外枠。
// このページでは AGO BOT サイト共通のヘッダー/フッターを出さない
// （ルート側の SiteChrome がパスで判定して省く）ため、サービス名だけの
// 最小限のヘッダーとフッターをここで持つ。AGO BOT のロゴ・名称・
// サイト内リンクは置かない。
// 法務リンク（利用規約/プライバシーポリシー）だけは例外として残す:
// このページは入力文を外部の LLM API へ送るため、ポリシーへの到達手段を
// 画面内に残す必要がある。リンク先の文書自体は当面サイト側に置かれている。
export default function OnePrompterLayout({ children }: { children: ReactNode }) {
  return (
    <div className="op-shell">
      <header className="op-header">
        <p className="op-brand">One Prompter</p>
      </header>
      {children}
      <footer className="op-footer">
        <p className="op-footer-brand">One Prompter</p>
        <nav className="op-legal" aria-label="ポリシー">
          <Link href="/terms">利用規約</Link>
          <Link href="/privacy">プライバシーポリシー</Link>
        </nav>
      </footer>
    </div>
  );
}
