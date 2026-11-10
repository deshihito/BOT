import type { ReactNode } from "react";

// One Prompter 単独の外枠。
// このページでは AGO BOT サイト共通のヘッダー/フッターを出さない
// （ルート側の SiteChrome がパスで判定して省く）ため、サービス名だけの
// 最小限のヘッダーとフッターをここで持つ。AGO BOT のロゴ・名称・
// サイト内リンクは置かない。フッターもサービス名のみで、リンク類は置かない。
// ブランドマークはロゴA「プロンプト記号」（黒い角丸スクエアに白抜きの
// ターミナルプロンプト「>_」）。ヘッダーとフッターの名義の左に置き、
// ファビコン（page.tsx の OP_ICON）も同一形状に揃えている。
function OpLogoMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect x="6" y="6" width="52" height="52" rx="14" fill="#17191c" />
      <path
        d="M21 23 L31 32 L21 41"
        stroke="#ffffff"
        strokeWidth="5.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="35" y="38.5" width="11" height="5" rx="2.5" fill="#ffffff" />
    </svg>
  );
}

export default function OnePrompterLayout({ children }: { children: ReactNode }) {
  return (
    <div className="op-shell">
      <header className="op-header">
        <p className="op-brand">
          <OpLogoMark size={28} />
          One Prompter
        </p>
      </header>
      {children}
      <footer className="op-footer">
        <p className="op-footer-brand">
          <OpLogoMark size={18} />
          One Prompter
        </p>
      </footer>
    </div>
  );
}
