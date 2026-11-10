import type { ReactNode } from "react";

// One Prompter 単独の外枠。
// このページでは AGO BOT サイト共通のヘッダー/フッターを出さない
// （ルート側の SiteChrome がパスで判定して省く）ため、サービス名だけの
// 最小限のヘッダーとフッターをここで持つ。AGO BOT のロゴ・名称・
// サイト内リンクは置かない。フッターもサービス名のみで、リンク類は置かない。
export default function OnePrompterLayout({ children }: { children: ReactNode }) {
  return (
    <div className="op-shell">
      <header className="op-header">
        <p className="op-brand">One Prompter</p>
      </header>
      {children}
      <footer className="op-footer">
        <p className="op-footer-brand">One Prompter</p>
      </footer>
    </div>
  );
}
