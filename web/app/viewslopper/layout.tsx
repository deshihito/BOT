import type { ReactNode } from "react";

// viewslopper 単独の外枠。
// このページでは AGO BOT サイト共通のヘッダー/フッターを出さない
// （ルート側の SiteChrome がパスで判定して省く）ため、最小限のヘッダーと
// フッターをここで持つ。AGO BOT のロゴ・名称・サイト内リンクは置かない。
// サービス名の常時表示はヘッダーの1箇所だけ。ログイン導線は MVP では持たない
// （ゲストで全機能が使える）。
export default function ViewslopperLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: "#0e0f11", color: "#f2f3f5", fontFamily: "system-ui, -apple-system, 'Hiragino Kaku Gothic ProN', sans-serif" }}>
      <header style={{ padding: "16px 20px", borderBottom: "1px solid #23252a" }}>
        <span style={{ fontWeight: 700, letterSpacing: "0.02em" }}>viewslopper</span>
      </header>
      {children}
      <footer aria-hidden="true" style={{ height: 48 }} />
    </div>
  );
}
