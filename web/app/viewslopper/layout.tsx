import type { ReactNode } from "react";

// viewslopper 単独の外枠。
// このページでは AGO BOT サイト共通のヘッダー/フッターを出さない
// （ルート側の SiteChrome がパスで判定して省く）ため、最小限のヘッダーと
// フッターをここで持つ。AGO BOT のロゴ・名称・サイト内リンクは置かない。
// サービス名の常時表示はヘッダーの1箇所だけ。ログイン導線は MVP では持たない
// （ゲストで全機能が使える）。
// 見た目は globals.css の .vs-shell スコープで持つ: 共通CSSの要素セレクタ
// （header/footer の白背景、main の中央カラム＋min-height）が漏れて効くため、
// インラインスタイルではなくクラス側で打ち消す必要がある。
export default function ViewslopperLayout({ children }: { children: ReactNode }) {
  return (
    <div className="vs-shell">
      <header className="vs-header" style={{ padding: "16px 20px" }}>
        <span style={{ fontWeight: 700, letterSpacing: "0.02em" }}>viewslopper</span>
      </header>
      {children}
      <footer className="vs-footer" aria-hidden="true" style={{ height: 48 }} />
    </div>
  );
}
